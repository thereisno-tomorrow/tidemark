import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTree, pathExists, readJson } from './fs-safe.mjs';
import { expandTokens, resolveRoots } from './paths.mjs';

// Every other check in this system inspects current state and asks whether it is
// internally consistent. None of them can answer "does this still match what it was
// derived from?" — which is why an import defect sat in the exampleguide skill for two
// days, passed `check`, `doctor` and every artifact validator, and was removed by an
// unrelated rewrite that nobody recorded. This check answers the other question, by
// diffing live canonical source against preserved pre-import bytes.
//
// Line endings are normalised before comparison. In the 2026-08-03 audit, 232 of 260
// apparent differences were CRLF-only; reporting them would bury the 28 that mattered.

const IGNORED_BASENAMES = new Set(['.ds_store', 'thumbs.db']);
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.toml', '.yaml', '.yml', '.mjs', '.js', '.ps1', '.sh', '']);

function normalize(content) {
  return content.replace(/\r\n/g, '\n');
}

function canonicalCandidates(mapping, relative, aliases) {
  const parts = relative.split('/');
  if (mapping.shape === 'file') return [mapping.canonical];
  if (mapping.shape === 'command-to-skill') {
    // Seven commands became skills at the cutover. A command file is one markdown
    // document; the skill it became is that document as SKILL.md.
    if (parts.length !== 1 || !parts[0].endsWith('.md')) return [];
    const name = parts[0].slice(0, -'.md'.length);
    return [`${mapping.canonical}/${aliases[name] ?? name}/SKILL.md`];
  }
  const [name, ...rest] = parts;
  if (!rest.length) return [];
  return [`${mapping.canonical}/${aliases[name] ?? name}/${rest.join('/')}`];
}

export async function checkProvenance({ root, stateRoot, roots: providedRoots = null, baselineId = null } = {}) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const policy = await readJson(path.join(roots.AGENT_CONFIG_ROOT, 'automation', 'provenance-baseline.json'));
  if (!policy) return { ok: false, reason: 'no-policy', message: 'automation/provenance-baseline.json is missing; provenance cannot be checked' };

  const baseline = baselineId
    ? policy.baselines.find((item) => item.id === baselineId)
    : policy.baselines[0];
  if (!baseline) return { ok: false, reason: 'no-baseline', message: `No baseline declared${baselineId ? ` with id ${baselineId}` : ''}` };

  const baselineRoot = expandTokens(baseline.root, roots);
  if (!await pathExists(baselineRoot)) {
    // Absence is not "clean". The baseline is the evidence; losing it silently is the
    // failure mode this check exists to prevent.
    return { ok: false, reason: 'baseline-missing', baselineId: baseline.id, baselineRoot, message: `Declared ${baseline.retention} baseline is not on disk: ${baselineRoot}` };
  }

  const aliases = policy.aliases ?? {};
  const differences = [];
  const unmapped = [];
  let compared = 0;
  let lineEndingOnly = 0;

  for (const mapping of policy.mappings) {
    const dataRoot = path.join(baselineRoot, mapping.dataPath);
    if (!await pathExists(dataRoot)) { unmapped.push({ dataPath: mapping.dataPath, origin: mapping.origin, reason: 'absent-in-baseline' }); continue; }

    const entries = mapping.shape === 'file'
      ? [{ path: path.basename(dataRoot), type: 'file' }]
      : (await listTree(dataRoot)).filter((entry) => entry.type === 'file');

    for (const entry of entries) {
      const relative = entry.path.replaceAll('\\', '/');
      if (IGNORED_BASENAMES.has(path.basename(relative).toLowerCase())) continue;
      if (relative.split('/').includes('_archived')) continue;
      if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;

      const candidates = canonicalCandidates(mapping, relative, aliases);
      if (!candidates.length) { unmapped.push({ dataPath: mapping.dataPath, origin: mapping.origin, path: relative, reason: 'no-canonical-mapping' }); continue; }

      const original = path.join(dataRoot, mapping.shape === 'file' ? '' : relative);
      let matched = null;
      for (const candidate of candidates) {
        if (await pathExists(path.join(roots.AGENT_CONFIG_ROOT, candidate))) { matched = candidate; break; }
      }
      if (!matched) {
        // Retired on purpose or lost by accident — this check cannot tell the two
        // apart, so it reports rather than assumes.
        unmapped.push({ dataPath: mapping.dataPath, origin: mapping.origin, path: relative, reason: 'no-live-counterpart', expected: candidates[0] });
        continue;
      }

      const [before, after] = await Promise.all([
        readFile(original, 'utf8'),
        readFile(path.join(roots.AGENT_CONFIG_ROOT, matched), 'utf8'),
      ]);
      compared += 1;
      if (before === after) continue;
      if (normalize(before) === normalize(after)) { lineEndingOnly += 1; continue; }

      const beforeLines = normalize(before).split('\n');
      const afterLines = normalize(after).split('\n');
      const changedLines = afterLines.filter((line) => !beforeLines.includes(line));
      const removedLines = beforeLines.filter((line) => !afterLines.includes(line));
      differences.push({
        origin: `${mapping.origin}/${relative}`,
        canonical: matched,
        addedLines: changedLines.length,
        removedLines: removedLines.length,
        sample: { removed: removedLines.slice(0, 3), added: changedLines.slice(0, 3) },
      });
    }
  }

  return {
    // A difference is not automatically a defect — deliberate rewrites since the import
    // are legitimate. It is a claim that needs an explanation, so ok tracks only whether
    // the baseline itself is intact and readable.
    ok: true,
    baselineId: baseline.id,
    baselineRoot,
    retention: baseline.retention,
    compared,
    identical: compared - lineEndingOnly - differences.length,
    lineEndingOnly,
    differences,
    unmapped,
  };
}

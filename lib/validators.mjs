import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalize, digestObject } from './canonical-json.mjs';
import { RUNTIME_EXCLUSIONS } from './constants.mjs';
import { AgentConfigError } from './errors.mjs';
import { atomicWrite, listTree, pathExists, readJson } from './fs-safe.mjs';
import { runGit } from './git.mjs';
import { resolveRoots } from './paths.mjs';
import { buildManifestLock, loadConfiguration, resolveArtifacts, validateManifestShape } from './manifest.mjs';

const SECRET_PATTERNS = [
  { id: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { id: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'aws-access-key', regex: /\bAKIA[A-Z0-9]{16}\b/ },
  { id: 'generic-secret-assignment', regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?(?!\$\{|env:|<|example|redacted)[A-Za-z0-9_+\/=.-]{16,}/i },
];
const MACHINE_PATHS = [/[A-Z]:\\Users\\(?!<)[^\\\s]+\\/i, /\/Users\/(?!<)[^/\s]+\//, /\/home\/(?!<)[^/\s]+\//];
// The 2026-08-01 import rewrote `/command` to `command skill` by hand, and the
// substitution matched inside paths and URLs, deleting the slash: a exampleguide path
// under ops/ collapsed into one glued token, and a example.invalid essay URL lost the
// slash before its filename. Every case leaves the same signature — a glued word,
// then " skill", then a file extension or another path segment. Ordinary prose ("a
// writing skill.") never carries an extension, so it is not matched. This would have
// failed the import commit.
const GLUED_SKILL_REFERENCES = [
  // A glued compound is long ("savecapture", "opsexampleguide"); "one skill/two" is not.
  /\S* skill\.(?:md|html?|json|txt|ps1|sh|mjs|js|py|toml)\b/,
  /[^\s/]{6,} skill\//,
  /\b(?:skills|commands|ops|vault|save)[a-z]+ skill\b/,
  /\b[a-z]+ skill-learnings\b/,
];
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.toml', '.yaml', '.yml', '.mjs', '.js', '.ps1', '.sh', '.gitignore', '']);

function excluded(relative) {
  const pieces = relative.toLowerCase().split('/');
  return pieces.some((piece) => RUNTIME_EXCLUSIONS.includes(piece)) || relative.startsWith('dist/');
}

// A checkout can contain other checkouts: Claude Code desktop adds a linked worktree
// per session under .claude/worktrees/ and hides it through .git/info/exclude.
// Walking the filesystem scanned every copy, so each allow-listed file was reported
// again under its worktree path and check and doctor failed on a checkout Git called
// clean. A checkout is therefore scanned as Git sees it: tracked files plus untracked
// files it does not ignore, where a nested repository is one directory entry, never
// its files. A plain directory, such as a fixture before `git init`, has no ignore
// rules and is still walked.
async function listSourceFiles(root) {
  if (!await pathExists(path.join(root, '.git'))) {
    return (await listTree(root, { exclude: (relative, entry) => excluded(relative) || entry.name === '.git' }))
      .filter((entry) => entry.type === 'file');
  }
  const listed = runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const files = [];
  // An unmerged path is listed once per stage.
  for (const relative of new Set(listed.split('\0').filter(Boolean))) {
    if (excluded(relative)) continue;
    let entry;
    try { entry = await lstat(path.join(root, relative)); } catch (error) {
      // A tracked file deleted from the worktree has no bytes left to scan.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (entry.isFile()) files.push({ path: relative, size: entry.size });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function scanText(content, relative, { machinePaths = true, gluedSkill = true, allowedRemotePrefixes = [] } = {}) {
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(content)) findings.push({ path: relative, rule: pattern.id });
  }
  // Tests must contain the damaged strings in order to prove the detector catches
  // them, exactly as fixtures must contain machine paths.
  if (gluedSkill) {
    for (const regex of GLUED_SKILL_REFERENCES) {
      const match = content.match(regex);
      if (match) findings.push({ path: relative, rule: 'glued-skill-reference', detail: match[0] });
    }
  }
  if (machinePaths) {
    for (const regex of MACHINE_PATHS) {
      if (!regex.test(content)) continue;
      if (allowedRemotePrefixes.length) {
        const all = content.match(new RegExp(regex.source, `${regex.flags.replace('g', '')}g`)) ?? [];
        // A finding stands only if some match is NOT a declared remote-host path.
        if (all.every((match) => allowedRemotePrefixes.some((prefix) => match.startsWith(prefix)))) continue;
      }
      findings.push({ path: relative, rule: 'absolute-machine-path' });
    }
  }
  return findings;
}

async function loadRemoteHostExemptions(root) {
  const policy = await readJson(path.join(root, 'automation', 'remote-host-paths.json'));
  const map = new Map();
  for (const entry of policy?.exemptions ?? []) {
    if (!entry?.path || !Array.isArray(entry.prefixes)) continue;
    map.set(entry.path, entry.prefixes);
  }
  return map;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*["']?(.*?)["']?\s*$/);
    return item ? [item[1], item[2]] : null;
  }).filter(Boolean));
}

// foreign-owned artifacts are canonical in another repository and only vendored
// here for distribution. This is the gate that makes that mean something: if the
// vendored copy no longer matches upstream, that is drift to be reported, not an
// edit to be kept. Without it, "foreign-owned" is just a comment.
async function validateUpstream(root, artifact, issues, roots) {
  const up = artifact.upstream;
  if (!up) return;
  const expand = (value) => value
    .replaceAll('${PROJECTS_ROOT}', roots?.PROJECTS_ROOT ?? '')
    .replaceAll('${USER_HOME}', roots?.USER_HOME ?? '');
  const upstreamFile = path.join(expand(up.repo), up.path);
  if (!await pathExists(upstreamFile)) {
    // A machine may legitimately not have the owning repository checked out.
    // Absence is not drift; silently passing a *present* divergence would be.
    issues.push(`${artifact.id}: upstream-unavailable: ${upstreamFile} (cannot verify against ${up.repo})`);
    return;
  }
  // A vendored source is either the file itself (single-file inputs such as a
  // contract) or the directory that holds it (a skill tree). Resolve both, so the
  // class is usable for inputs and not only for whole skills.
  const declared = path.join(root, artifact.source[0]);
  const declaredStat = await stat(declared).catch(() => null);
  const vendored = declaredStat?.isDirectory() ? path.join(declared, path.basename(up.path)) : declared;
  if (!await pathExists(vendored)) { issues.push(`${artifact.id}: vendored copy missing: ${vendored}`); return; }
  const normalize = (text) => text.replace(/\r\n/g, '\n');
  const [a, b] = await Promise.all([readFile(upstreamFile, 'utf8'), readFile(vendored, 'utf8')]);
  if (normalize(a) !== normalize(b)) {
    issues.push(`${artifact.id}: upstream-drift: differs from ${up.repo}/${up.path} — edit upstream and re-vendor, do not edit this copy`);
  }
}

// A skill's description is the only signal that decides whether it is invoked at
// all. The import replaced `example-explainer`'s with "Run the former example-explainer
// command as a portable skill" — a sentence about the artifact's history rather
// than about when to use it — and nothing noticed for two days.
const PLACEHOLDER_DESCRIPTIONS = [
  /\bthe former\b/i,
  /\bas a portable skill\b/i,
  /^(?:run|invoke) the .* (?:command|skill)\.?$/i,
  /\b(?:TBD|TODO|placeholder|describe this)\b/i,
];

function descriptionFrom(content) {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return '';
  const folded = block[1].match(/^description:\s*>[-+]?\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m);
  if (folded) return folded[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' ');
  const inline = block[1].match(/^description:\s*(.+)$/m);
  return inline ? inline[1].trim().replace(/^["']|["']$/g, '') : '';
}

async function validateSkill(root, artifact, issues) {
  const skillRoot = path.join(root, artifact.source[0]);
  const skillFile = path.join(skillRoot, 'SKILL.md');
  if (!await pathExists(skillFile)) { issues.push(`${artifact.id}: SKILL.md missing`); return; }
  const content = await readFile(skillFile, 'utf8');
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.name) issues.push(`${artifact.id}: frontmatter name missing`);
  const description = descriptionFrom(content);
  if (!description) issues.push(`${artifact.id}: frontmatter description missing`);
  else for (const regex of PLACEHOLDER_DESCRIPTIONS) {
    if (regex.test(description)) { issues.push(`${artifact.id}: placeholder description — it must say when to use the skill, not what it used to be: "${description.slice(0, 80)}"`); break; }
  }
  const expected = artifact.id.startsWith('skills.') ? artifact.id.slice('skills.'.length) : path.basename(skillRoot);
  if (frontmatter.name && frontmatter.name !== expected) issues.push(`${artifact.id}: frontmatter name ${frontmatter.name} does not equal ${expected}`);
  const referenceRegex = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const match of content.matchAll(referenceRegex)) {
    const referenced = match[1].split('#')[0];
    if (referenced && !['url', 'path', 'link'].includes(referenced.toLowerCase()) && !await pathExists(path.resolve(skillRoot, referenced))) issues.push(`${artifact.id}: broken relative reference ${match[1]}`);
  }
}

async function runDeclaredArtifactValidators(root, artifacts, issues) {
  const controller = artifacts.find((artifact) => artifact.validators?.includes('controller-tests'));
  if (!controller) return;

  const testsRoot = path.join(root, 'tests');
  if (!await pathExists(testsRoot)) {
    issues.push(`${controller.id}: controller-tests suite missing`);
    return;
  }
  const testFiles = (await listTree(testsRoot))
    .filter((entry) => entry.type === 'file' && /\.test\.mjs$/.test(entry.path));
  if (!testFiles.length) {
    issues.push(`${controller.id}: controller-tests suite contains no test files`);
    return;
  }

  // A controller transaction test launches the suite once. Transactions exercised
  // by that suite may validate controller fixtures; they inherit this marker so they
  // do not recursively launch the parent suite.
  if (process.env.AGENT_CONFIG_CONTROLLER_TESTS_RUNNING === '1') return;

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AGENT_CONFIG_CONTROLLER_TESTS_RUNNING: '1' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error) {
    issues.push(`${controller.id}: controller-tests could not run: ${result.error.message}`);
  } else if (result.status !== 0) {
    const detail = output.trim().slice(-8_000);
    issues.push(`${controller.id}: controller-tests failed with exit ${result.status}${detail ? `\n${detail}` : ''}`);
  } else if (/^# skipped [1-9][0-9]*$/m.test(output) || /# SKIP\b/i.test(output)) {
    issues.push(`${controller.id}: controller-tests reported skipped tests`);
  }
}

export async function validateRepository(root, { writeLock = false, artifactIds = null, runDeclaredValidators = false } = {}) {
  const configuration = await loadConfiguration(root);
  const validationRoots = resolveRoots({ root });
  const issues = validateManifestShape(configuration.manifest);
  const artifacts = await resolveArtifacts(root, configuration.manifest);
  const ids = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id)) issues.push(`duplicate resolved artifact ${artifact.id}`);
    ids.add(artifact.id);
    for (const source of artifact.source) if (!await pathExists(path.join(root, source))) issues.push(`${artifact.id}: source missing: ${source}`);
    if (artifact.kind === 'skill') await validateSkill(root, artifact, issues);
    if (artifact.upstream) await validateUpstream(root, artifact, issues, validationRoots);
  }

  if (runDeclaredValidators) {
    const selected = artifactIds
      ? artifacts.filter((artifact) => artifactIds.includes(artifact.id))
      : artifacts;
    await runDeclaredArtifactValidators(root, selected, issues);
  }

  const remoteHostExemptions = await loadRemoteHostExemptions(root);
  const findings = [];
  for (const entry of await listSourceFiles(root)) {
    const extension = path.extname(entry.path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) || entry.size > 2_000_000) continue;
    const content = await readFile(path.join(root, entry.path), 'utf8');
    findings.push(...scanText(content, entry.path, {
      machinePaths: !entry.path.startsWith('tests/fixtures/') && !entry.path.startsWith('platforms/'),
      gluedSkill: !entry.path.startsWith('tests/'),
      allowedRemotePrefixes: remoteHostExemptions.get(entry.path) ?? [],
    }));
    if (extension === '.json') {
      try { JSON.parse(content); } catch (error) { issues.push(`${entry.path}: invalid JSON: ${error.message}`); }
    }
  }
  issues.push(...findings.map((finding) => `${finding.path}: ${finding.rule}`));

  const lock = await buildManifestLock(root, configuration);
  const lockPath = path.join(root, 'manifest.lock.json');
  const existingLock = await readJson(lockPath);
  const lockMatches = digestObject({ ...existingLock, generatedBy: lock.generatedBy }) === digestObject(lock);
  if (writeLock) await atomicWrite(lockPath, canonicalize(lock));
  else if (!lockMatches) issues.push('manifest.lock.json is stale; run validate --write-lock');

  return { ok: issues.length === 0, issues, findings, artifacts, lock };
}

export function scanGitHistory(root) {
  const git = (args, input) => spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], {
    encoding: input ? undefined : 'utf8', input, maxBuffer: 64 * 1024 * 1024,
  });
  const refs = git(['for-each-ref', '--format=%(refname)']);
  if (refs.status !== 0) throw new AgentConfigError('GIT_FAILED', refs.stderr?.toString() || 'Unable to enumerate refs');
  const objects = git(['rev-list', '--objects', '--all']);
  if (objects.status !== 0) throw new AgentConfigError('GIT_FAILED', objects.stderr?.toString() || 'Unable to enumerate history');
  const findings = [];
  let scannedBlobs = 0;
  for (const line of objects.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ...parts] = line.split(' ');
    const relative = parts.join(' ');
    if (!relative || excluded(relative.replaceAll('\\', '/'))) continue;
    const type = git(['cat-file', '-t', oid]);
    if (type.status !== 0 || type.stdout.trim() !== 'blob') continue;
    const size = Number(git(['cat-file', '-s', oid]).stdout.trim());
    if (size > 2_000_000 || !TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    const blob = git(['cat-file', 'blob', oid]);
    if (blob.status !== 0) continue;
    scannedBlobs += 1;
    findings.push(...scanText(blob.stdout.toString('utf8'), relative).map((finding) => ({ ...finding, oid })));
  }
  return { schemaVersion: 1, scannedAt: new Date().toISOString(), refs: refs.stdout.trim().split(/\r?\n/).filter(Boolean), scannedBlobs, findings, passed: findings.length === 0 };
}

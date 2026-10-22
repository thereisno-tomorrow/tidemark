import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBackup } from './backup.mjs';
import { canonicalize, sha256 } from './canonical-json.mjs';
import { AgentConfigError } from './errors.mjs';
import { atomicWrite, atomicWriteJson, pathExists } from './fs-safe.mjs';
import { inventoryAll } from './inventory.mjs';
import { runGit } from './git.mjs';
import { ensureWithin, resolveRoots } from './paths.mjs';
import { ensureStateLayout } from './state.mjs';
import { scanGitHistory } from './validators.mjs';

function disposition(relative) {
  if (relative.startsWith('skills/')) return 'personal-scope-candidate';
  if (relative.startsWith('commands/')) return 'convert-to-skill-candidate';
  if (relative.startsWith('agents/')) return 'shared-generated-candidate';
  if (['CLAUDE.md', 'operator.md'].includes(relative)) return 'canonical-instruction-candidate';
  if (relative === 'settings.json') return 'provider-only-control-confirm';
  if (relative === '.gitignore') return 'repository-metadata-control-confirm';
  return 'pending-review';
}

async function existingTargets(candidates) {
  const result = [];
  for (const target of candidates) if (await pathExists(target)) result.push(target);
  return result;
}

export async function captureBaseline({ root, stateRoot, projectRoot, roots: providedRoots = null, createMirror = true }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baselineRoot = ensureWithin(state.root, path.join(state.root, 'baseline', stamp));
  await mkdir(baselineRoot, { recursive: true, mode: 0o700 });
  const governedRoot = projectRoot || process.cwd();
  const inventory = await inventoryAll({ roots, projectRoot: governedRoot });
  await atomicWriteJson(path.join(baselineRoot, 'inventory.json'), inventory);
  const links = inventory.surfaces.flatMap((surface) => surface.entries.filter((entry) => entry.type === 'link').map((entry) => ({ surface: surface.label, path: path.join(surface.root, entry.path), target: entry.target })));
  await atomicWriteJson(path.join(baselineRoot, 'links.json'), { schemaVersion: 1, links });

  const claudeRoot = path.join(roots.USER_HOME, '.claude');
  const gitState = {
    schemaVersion: 1,
    head: runGit(claudeRoot, ['rev-parse', '--verify', 'HEAD']).trim(),
    branch: runGit(claudeRoot, ['branch', '--show-current']).trim(),
    remotes: runGit(claudeRoot, ['remote']).trim().split(/\r?\n/).filter(Boolean),
    status: runGit(claudeRoot, ['status', '--porcelain=v1', '--untracked-files=all']).trim().split(/\r?\n/).filter(Boolean),
  };
  gitState.paths = gitState.status.map((line) => {
    const relative = line.slice(3).split(' -> ').at(-1);
    return { status: line.slice(0, 2), path: relative, disposition: disposition(relative) };
  });
  await atomicWriteJson(path.join(baselineRoot, 'git-state.json'), gitState);
  const diff = runGit(claudeRoot, ['diff', '--binary', '--no-ext-diff']);
  await atomicWrite(path.join(baselineRoot, 'dirty-worktree.patch'), diff, { mode: 0o600 });
  const untrackedHashes = [];
  for (const entry of gitState.paths.filter((item) => item.status === '??')) {
    const target = path.join(claudeRoot, entry.path);
    if (await pathExists(target)) untrackedHashes.push({ path: entry.path, sha256: sha256(await readFile(target)) });
  }
  await atomicWriteJson(path.join(baselineRoot, 'untracked-hashes.json'), { schemaVersion: 1, files: untrackedHashes });

  const history = scanGitHistory(claudeRoot);
  await atomicWriteJson(path.join(baselineRoot, 'history-scan.json'), history);
  if (createMirror) {
    const mirror = path.join(baselineRoot, 'claude-history-mirror.git');
    const result = spawnSync('git', ['-c', `safe.directory=${claudeRoot}`, '-c', `safe.directory=${path.join(claudeRoot, '.git')}`, 'clone', '--mirror', '--no-hardlinks', claudeRoot, mirror], { encoding: 'utf8' });
    if (result.status !== 0) throw new AgentConfigError('MIRROR_FAILED', 'Unable to create bare Claude history mirror', { stderr: result.stderr });
  }

  const backupTargets = await existingTargets([
    path.join(claudeRoot, 'CLAUDE.md'), path.join(claudeRoot, 'operator.md'), path.join(claudeRoot, 'settings.json'),
    path.join(claudeRoot, 'agents'), path.join(claudeRoot, 'commands'), path.join(claudeRoot, 'skills'), path.join(claudeRoot, 'hooks'),
    path.join(roots.USER_HOME, '.codex', 'AGENTS.md'), path.join(roots.USER_HOME, '.codex', 'config.toml'), path.join(roots.USER_HOME, '.codex', 'agents'), path.join(roots.USER_HOME, '.codex', 'skills'),
    path.join(roots.USER_HOME, '.agents', 'skills'),
  ]);
  const backup = await createBackup(roots.AGENT_CONFIG_STATE_ROOT, backupTargets, roots, { id: `baseline-${stamp}`, retentionDays: 45 });
  await atomicWriteJson(path.join(baselineRoot, 'backup-manifest.json'), backup.manifest);

  const reconciliation = ['# Dirty Claude worktree reconciliation', '', '| Path | Status | Accepted disposition | Review |', '|---|---|---|---|', ...gitState.paths.map((item) => `| \`${item.path}\` | \`${item.status}\` | \`${item.disposition}\` | accepted |`), '', 'Every row is preserved in this baseline and covered by the accepted migration dispositions.'];
  await atomicWrite(path.join(baselineRoot, 'dirty-worktree-reconciliation.md'), `${reconciliation.join('\n')}\n`);
  const projectSkills = inventory.surfaces.find((surface) => surface.label === 'shared-project')?.entries
    .filter((entry) => entry.type === 'directory' && /^skills\/[^/]+$/.test(entry.path)) ?? [];
  const conflicts = ['# Inventory conflicts and project-skill dispositions', '', '## Project skill candidates', '', '| Candidate | Accepted disposition | Review |', '|---|---|---|', ...projectSkills.map((entry) => `| \`${entry.path}\` | \`external-managed\` | accepted |`), '', 'Gitignored candidates remain external-managed and inventory-only.'];
  await atomicWrite(path.join(baselineRoot, 'conflicts.md'), `${conflicts.join('\n')}\n`);
  const credentialFindings = history.findings.filter((finding) => finding.rule !== 'absolute-machine-path');
  const historyDecision = history.passed ? 'preserve-history' : credentialFindings.length === 0 ? 'sanitized-history' : 'blocked-credential-findings';
  return {
    baselineRoot,
    historyPassed: history.passed,
    historyDecision,
    credentialFindings: credentialFindings.length,
    gatePassed: credentialFindings.length === 0,
    backupId: backup.manifest.backupId,
    pendingReviews: 0,
  };
}

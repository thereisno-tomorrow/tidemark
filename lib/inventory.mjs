import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RUNTIME_EXCLUSIONS } from './constants.mjs';
import { describePath, listTree, pathExists } from './fs-safe.mjs';
import { toPortablePath } from './paths.mjs';

function inventoryExcluded(relative) {
  const parts = relative.toLowerCase().split('/');
  const top = parts[0];
  const runtimeTopLevel = new Set([
    '.git', '.sandbox', '.sandbox-bin', '.sandbox-secrets', '.tmp', '_backups',
    'ambient-suggestions', 'archived_sessions', 'attachments', 'backups', 'cache',
    'caches', 'chrome', 'computer-use', 'data', 'debug', 'downloads', 'file-history',
    'generated_images', 'ide', 'local', 'logs', 'mcp-oauth-locks', 'node_repl',
    'paste-cache', 'plans', 'process_manager', 'projects', 'session-env', 'sessions',
    'shell-snapshots', 'sqlite', 'statsig', 'tasks', 'telemetry', 'thread-writer-locks',
    'tmp', 'todos', 'token-optimizer', 'usage-data', 'vault-runtime', 'visualizations',
    'browser',
  ]);
  const runtimeFiles = new Set([
    '.credentials.json', '.codex-global-state.json', '.codex-global-state.json.bak',
    'auth.json', 'cap_sid', 'goals_1.sqlite', 'history.jsonl', 'installation_id',
    'logs_2.sqlite', 'logs_2.sqlite-shm', 'logs_2.sqlite-wal', 'memories_1.sqlite',
    'models_cache.json', 'realtime-voice-continuity.json', 'session_index.jsonl',
    'state_5.sqlite', 'state_5.sqlite-shm', 'state_5.sqlite-wal', 'token_data.json',
    'transcription-history.jsonl',
  ]);
  return runtimeTopLevel.has(top)
    || runtimeFiles.has(parts.at(-1))
    || parts.some((part) => RUNTIME_EXCLUSIONS.includes(part))
    || partMatches(relative);
}

function inventoryAllowed(label, relative) {
  const top = relative.split('/')[0];
  if (label === 'claude-user') {
    const dirs = new Set(['agents', 'commands', 'hooks', 'plugins', 'research-toolbox', 'skills']);
    const files = new Set(['.gitattributes', '.gitignore', '.mcp.json', '.mcp.json.example', 'CLAUDE.md', 'operator.md', 'README.md', 'settings.json', 'settings.local.json']);
    return dirs.has(top) || (relative === top && files.has(top));
  }
  if (label === 'codex-user') {
    const dirs = new Set(['agents', 'hooks', 'plugins', 'rules', 'skills']);
    const files = new Set(['AGENTS.md', 'config.toml', 'hooks.json', 'version.json']);
    return dirs.has(top) || (relative === top && files.has(top));
  }
  if (label === 'shared-user') return top === 'skills';
  if (label === 'vscode-user') return relative === top && new Set(['settings.json', 'keybindings.json', 'tasks.json']).has(top);
  return true;
}

function partMatches(relative) {
  return relative.startsWith('.git/')
    || relative.startsWith('plugins/cache/')
    || relative.startsWith('plugins/data/')
    || relative.startsWith('plugins/marketplaces/')
    || relative.startsWith('skills/.system/')
    || relative.startsWith('.system/');
}

function gitTrackedMap(root) {
  if (!root || !root.includes(path.sep)) return new Set();
  const topResult = spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (topResult.status !== 0) return new Set();
  const top = path.resolve(topResult.stdout.trim());
  const result = spawnSync('git', ['-c', `safe.directory=${top}`, '-C', top, 'ls-files', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) return new Set();
  const tracked = new Set();
  for (const relative of result.stdout.split('\0').filter(Boolean)) {
    const fromInventoryRoot = path.relative(root, path.join(top, relative));
    if (fromInventoryRoot && !fromInventoryRoot.startsWith('..') && !path.isAbsolute(fromInventoryRoot)) tracked.add(toPortablePath(fromInventoryRoot));
  }
  return tracked;
}

function ownershipFor(relative) {
  if (inventoryExcluded(relative)) return 'runtime-excluded';
  if (relative.startsWith('plugins/') || relative.startsWith('skills/.system/')) return 'external-managed';
  return 'unclassified';
}

export async function inventoryRoot(root, label) {
  if (!await pathExists(root)) return { label, root, exists: false, entries: [] };
  const tracked = gitTrackedMap(root);
  const entries = await listTree(root, { exclude: (relative) => inventoryExcluded(relative) || !inventoryAllowed(label, relative) });
  return {
    label, root: path.resolve(root), exists: true,
    entries: entries.map((entry) => ({ ...entry, tracked: tracked.has(entry.path), ownership: ownershipFor(entry.path) })),
  };
}

function collectKeys(value, prefix = '', result = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const qualified = prefix ? `${prefix}.${key}` : key;
    result.add(qualified);
    collectKeys(child, qualified, result);
  }
  return result;
}

function hookMetadata(value, result = { events: new Set(), scriptPaths: new Set(), skillReferences: new Set() }, parentKey = '') {
  if (Array.isArray(value)) for (const child of value) hookMetadata(child, result, parentKey);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (parentKey === 'hooks' || ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit', 'Stop'].includes(key)) result.events.add(key);
    if (key.toLowerCase().includes('command') && typeof child === 'string') {
      for (const match of child.matchAll(/(?:[A-Za-z]:\\|\/)[^\s"']+\.(?:ps1|sh|mjs|js|cmd|bat)/gi)) result.scriptPaths.add(match[0]);
    }
    if (key === 'prompt' && typeof child === 'string') {
      for (const match of child.matchAll(/\b(?:ask|use|run|invoke|load)\s+(?:the\s+)?\/?([a-z0-9][a-z0-9._-]*)\s+skill\b/gi)) result.skillReferences.add(match[1].toLowerCase());
      for (const match of child.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9._-]*)\b/gi)) result.skillReferences.add(match[1].toLowerCase());
    }
    hookMetadata(child, result, key);
  }
  return result;
}

async function jsonMetadata(target) {
  try { return JSON.parse(await readFile(target, 'utf8')); } catch { return null; }
}

async function extractMetadata(userHome, surfaces) {
  const skills = [];
  for (const surface of surfaces) {
    for (const entry of surface.entries.filter((item) => item.type === 'link' && /(?:^|\/)skills\/[^/]+$/.test(`/${item.path}`))) {
      skills.push({ surface: surface.label, path: entry.path, name: path.posix.basename(entry.path) });
    }
    for (const entry of surface.entries.filter((item) => /(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(`/${item.path}`))) {
      try {
        const content = (await readFile(path.join(surface.root, entry.path), 'utf8')).slice(0, 8192);
        const name = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() ?? null;
        skills.push({ surface: surface.label, path: entry.path, name });
      } catch {}
    }
  }
  const claudeSettings = await jsonMetadata(path.join(userHome, '.claude', 'settings.json'));
  const codexHooks = await jsonMetadata(path.join(userHome, '.codex', 'hooks.json'));
  let codexConfig = '';
  try { codexConfig = await readFile(path.join(userHome, '.codex', 'config.toml'), 'utf8'); } catch {}
  const hookInfo = hookMetadata([claudeSettings?.hooks, codexHooks]);
  return {
    skills,
    mcpServerNames: [...new Set([
      ...[...codexConfig.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map((match) => match[1]),
    ])].sort(),
    hookEvents: [...hookInfo.events].sort(),
    hookScriptPaths: [...hookInfo.scriptPaths].sort(),
    hookSkillReferences: [...hookInfo.skillReferences].sort(),
    settingsKeys: {
      claude: [...collectKeys(claudeSettings)].sort(),
      codex: [...new Set([...codexConfig.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((match) => match[1]))].sort(),
    },
  };
}

async function findInstructionFiles(root) {
  const names = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md']);
  const result = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'vendor') continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (names.has(entry.name)) result.push({ path: target, descriptor: await describePath(target) });
    }
  }
  if (await pathExists(root)) await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function instructionShadows(userHome, projectRoot, fallbackNames = []) {
  const candidates = [
    path.join(userHome, '.codex', 'AGENTS.override.md'),
    path.join(userHome, '.claude', 'CLAUDE.local.md'),
    path.join(userHome, '.claude', 'operator.md'),
    path.join(userHome, '.claude', 'rules'),
    path.join(projectRoot, 'AGENTS.override.md'),
    path.join(projectRoot, 'CLAUDE.local.md'),
    path.join(projectRoot, '.claude', 'rules'),
    ...fallbackNames.flatMap((name) => [path.join(userHome, '.codex', name), path.join(projectRoot, name)]),
  ];
  const result = [];
  for (const candidate of candidates) if (await pathExists(candidate)) {
    const stat = await lstat(candidate);
    result.push({ path: candidate, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file', linkTarget: stat.isSymbolicLink() ? await readlink(candidate) : null });
  }
  return result;
}

export async function inventoryAll({ roots, projectRoot }) {
  const codexConfig = path.join(roots.USER_HOME, '.codex', 'config.toml');
  let fallbacks = [];
  if (await pathExists(codexConfig)) {
    const content = await readFile(codexConfig, 'utf8');
    const match = content.match(/project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/);
    if (match) fallbacks = [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
  }
  const specs = [
    [path.join(roots.USER_HOME, '.claude'), 'claude-user'],
    [path.join(roots.USER_HOME, '.codex'), 'codex-user'],
    [path.join(roots.USER_HOME, '.agents'), 'shared-user'],
    [path.join(projectRoot, '.claude'), 'claude-project'],
    [path.join(projectRoot, '.agents'), 'shared-project'],
    [path.join(projectRoot, '.vscode'), 'vscode-project'],
    [path.join(roots.USER_HOME, 'AppData', 'Roaming', 'Code', 'User'), 'vscode-user'],
  ];
  const surfaces = [];
  for (const [root, label] of specs) surfaces.push(await inventoryRoot(root, label));
  const nativeCandidates = [path.join(roots.USER_HOME, '.claude.json')];
  const nativeFiles = [];
  for (const candidate of nativeCandidates) if (await pathExists(candidate)) nativeFiles.push({ path: candidate, descriptor: await describePath(candidate), ownership: 'runtime-excluded' });
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    roots: Object.fromEntries(Object.entries(roots).filter(([key]) => key !== 'PLATFORM')),
    surfaces,
    metadata: await extractMetadata(roots.USER_HOME, surfaces),
    instructionFiles: await findInstructionFiles(projectRoot),
    nativeFiles,
    instructionShadows: await instructionShadows(roots.USER_HOME, projectRoot, fallbacks),
    exclusions: [...RUNTIME_EXCLUSIONS],
  };
}

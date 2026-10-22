import os from 'node:os';
import path from 'node:path';
import { AgentConfigError, invariant } from './errors.mjs';

export function currentPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  throw new AgentConfigError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${process.platform}`);
}

export function defaultStateRoot(env = process.env) {
  if (process.platform === 'win32') {
    invariant(env.LOCALAPPDATA, 'STATE_ROOT_UNAVAILABLE', 'LOCALAPPDATA is required on Windows');
    return path.resolve(env.LOCALAPPDATA, 'agent-config');
  }
  return path.resolve(os.homedir(), '.local', 'share', 'agent-config');
}

export function resolveRoots({ root, stateRoot, env = process.env } = {}) {
  const userHome = path.resolve(os.homedir());
  const projectsRoot = path.resolve(env.PROJECTS_ROOT || path.join(userHome, 'Projects'));
  const agentConfigRoot = path.resolve(root || env.AGENT_CONFIG_ROOT || process.cwd());
  const agentConfigStateRoot = path.resolve(stateRoot || env.AGENT_CONFIG_STATE_ROOT || defaultStateRoot(env));
  invariant(agentConfigRoot !== agentConfigStateRoot, 'ROOT_COLLISION', 'Authoring and state roots must differ');
  return {
    USER_HOME: userHome,
    PROJECTS_ROOT: projectsRoot,
    AGENT_CONFIG_ROOT: agentConfigRoot,
    AGENT_CONFIG_STATE_ROOT: agentConfigStateRoot,
    PLATFORM: currentPlatform(),
  };
}

export function expandTokens(input, roots) {
  invariant(typeof input === 'string', 'INVALID_PATH_TOKEN', 'Path template must be a string');
  const output = input.replace(/\$\{([A-Z_]+)\}/g, (match, key) => {
    invariant(Object.hasOwn(roots, key), 'UNKNOWN_PATH_TOKEN', `Unknown path token ${match}`);
    return roots[key];
  });
  invariant(!/\$\{[^}]+\}/.test(output), 'UNRESOLVED_PATH_TOKEN', `Unresolved path token in ${input}`);
  return path.resolve(output);
}

export function normalizeRelative(input) {
  invariant(typeof input === 'string' && input.length > 0, 'INVALID_RELATIVE_PATH', 'Relative path is required');
  const normalized = input.replaceAll('\\', '/').replace(/^\.\//, '');
  invariant(!path.isAbsolute(input), 'ABSOLUTE_PATH_DENIED', `Absolute path is not allowed: ${input}`);
  invariant(!normalized.split('/').includes('..'), 'PATH_ESCAPE', `Parent traversal is not allowed: ${input}`);
  invariant(!normalized.includes('\0'), 'INVALID_PATH', 'NUL is not allowed in a path');
  return normalized;
}

export function ensureWithin(root, candidate, { allowRoot = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  invariant(inside, 'PATH_ESCAPE', `Path escapes allowed root: ${resolvedCandidate}`, { root: resolvedRoot });
  invariant(allowRoot || relative !== '', 'BROAD_TARGET_DENIED', `Operation may not target root: ${resolvedRoot}`);
  return resolvedCandidate;
}

export function assertNarrowTarget(candidate, roots) {
  const resolved = path.resolve(candidate);
  const broad = new Set([
    path.parse(resolved).root,
    path.resolve(roots.USER_HOME),
    path.resolve(roots.AGENT_CONFIG_ROOT),
    path.resolve(roots.AGENT_CONFIG_STATE_ROOT),
  ]);
  invariant(!broad.has(resolved), 'BROAD_TARGET_DENIED', `Destructive target is too broad: ${resolved}`);
  return resolved;
}

export function toPortablePath(input) {
  return input.replaceAll('\\', '/');
}

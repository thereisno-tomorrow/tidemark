import { appendFile, lstat, mkdir, open, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWriteJson, copyTree, describePath, hashTree, listTree, pathExists, readJson } from './fs-safe.mjs';
import { ensureWithin } from './paths.mjs';

export function statePaths(root) {
  return {
    root,
    authorizations: path.join(root, 'authorizations'),
    transactions: path.join(root, 'transactions'),
    plans: path.join(root, 'plans'),
    releases: path.join(root, 'releases'),
    suiteObjects: path.join(root, 'suite-objects'),
    active: path.join(root, 'active'),
    installs: path.join(root, 'installs'),
    journal: path.join(root, 'installs', 'journal'),
    backups: path.join(root, 'backups'),
    locks: path.join(root, 'locks'),
    sync: path.join(root, 'sync'),
    logs: path.join(root, 'logs'),
    current: path.join(root, 'installs', 'current.json'),
  };
}

export async function ensureStateLayout(root) {
  const paths = statePaths(root);
  for (const key of ['authorizations', 'transactions', 'plans', 'releases', 'suiteObjects', 'installs', 'journal', 'backups', 'locks', 'sync', 'logs']) {
    ensureWithin(root, paths[key]);
    await mkdir(paths[key], { recursive: true, mode: 0o700 });
  }
  return paths;
}

export async function importSuiteObject({ stateRoot, sourcePath, expectedDigest, maxBytes = 1073741824 }) {
  invariant(/^[a-f0-9]{64}$/.test(expectedDigest ?? ''), 'SUITE_DIGEST_INVALID', 'Suite object digest must be 64 lowercase hex characters');
  const source = path.resolve(sourcePath);
  const sourceDescriptor = await describePath(source);
  invariant(sourceDescriptor.type === 'directory', 'SUITE_SOURCE_INVALID', 'Suite object source must be a directory');
  const entries = await listTree(source);
  invariant(!entries.some((entry) => entry.type === 'link'), 'SUITE_LINK_DENIED', 'Suite object sources may not contain symbolic links or junctions');
  const bytes = entries.filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0);
  invariant(bytes <= maxBytes, 'SUITE_OBJECT_TOO_LARGE', `Suite object exceeds ${maxBytes} bytes`, { bytes });
  invariant(await hashTree(source) === expectedDigest, 'SUITE_DIGEST_MISMATCH', 'Suite source digest does not match the reviewed digest');

  const state = await ensureStateLayout(stateRoot);
  const target = ensureWithin(state.suiteObjects, path.join(state.suiteObjects, expectedDigest));
  const lock = await acquireLock(stateRoot, 'suite-object-import');
  const staged = ensureWithin(state.suiteObjects, path.join(state.suiteObjects, `.${expectedDigest}.${randomUUID()}.staged`));
  try {
    if (await pathExists(target)) {
      const existing = await describePath(target);
      invariant(existing.type === 'directory' && existing.hash === expectedDigest, 'SUITE_OBJECT_CONFLICT', 'Existing suite object does not match its digest');
      return { digest: expectedDigest, path: target, files: entries.filter((entry) => entry.type === 'file').length, bytes, idempotent: true };
    }
    await copyTree(source, staged);
    const copied = await describePath(staged);
    invariant(copied.type === 'directory' && copied.hash === expectedDigest, 'SUITE_COPY_MISMATCH', 'Copied suite object failed digest verification');
    await rename(staged, target);
    return { digest: expectedDigest, path: target, files: entries.filter((entry) => entry.type === 'file').length, bytes, idempotent: false };
  } finally {
    if (await pathExists(staged)) await rm(staged, { recursive: true });
    await lock.release();
  }
}

export async function acquireLock(stateRoot, name, { staleMs = 900000 } = {}) {
  const paths = await ensureStateLayout(stateRoot);
  const lockPath = path.join(paths.locks, `${name}.lock`);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ownerPath = path.join(lockPath, 'owner.json');
    let owner = null;
    try { owner = await readJson(ownerPath); } catch {}
    const age = owner?.createdAt ? Date.now() - Date.parse(owner.createdAt) : 0;
    if (age > staleMs) throw new AgentConfigError('STALE_LOCK', `Stale lock requires recover: ${name}`, { owner });
    throw new AgentConfigError('LOCKED', `Operation lock is held: ${name}`, { owner });
  }
  const owner = { lockId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  await atomicWriteJson(path.join(lockPath, 'owner.json'), owner);
  return {
    ...owner,
    async release() {
      const current = await readJson(path.join(lockPath, 'owner.json'));
      invariant(current.lockId === owner.lockId, 'LOCK_OWNERSHIP_LOST', `Lock ownership changed: ${name}`);
      await rm(lockPath, { recursive: true });
    },
  };
}

export async function appendJournal(stateRoot, operationId, entry) {
  const paths = await ensureStateLayout(stateRoot);
  const journalPath = path.join(paths.journal, `${operationId}.jsonl`);
  const record = { sequence: await journalLength(journalPath), recordedAt: new Date().toISOString(), ...entry };
  const handle = await open(journalPath, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  return record;
}

async function journalLength(journalPath) {
  try { return (await readFile(journalPath, 'utf8')).split(/\r?\n/).filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

export async function readJournal(journalPath) {
  const text = await readFile(journalPath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function switchActive(stateRoot, releaseRoot, operationId) {
  const paths = await ensureStateLayout(stateRoot);
  ensureWithin(paths.releases, releaseRoot);
  const temp = path.join(stateRoot, `.active-${operationId}`);
  await symlink(releaseRoot, temp, process.platform === 'win32' ? 'junction' : 'dir');
  await appendJournal(stateRoot, operationId, { phase: 'activation-barrier-entered', action: 'switch-active', target: paths.active, desired: releaseRoot });
  let previous = null;
  if (await pathExists(paths.active)) {
    const stat = await lstat(paths.active);
    invariant(stat.isSymbolicLink(), 'ACTIVE_INDIRECTION_INVALID', 'Active indirection is not a link');
    previous = await readlink(paths.active);
    const old = path.join(stateRoot, `.active-old-${operationId}`);
    await rename(paths.active, old);
    await rename(temp, paths.active);
    await rm(old, { recursive: true });
  } else {
    await rename(temp, paths.active);
  }
  await appendJournal(stateRoot, operationId, { phase: 'active-switched', action: 'switch-active', target: paths.active, previous, desired: releaseRoot });
  return previous;
}

export async function restoreActive(stateRoot, expectedReleaseRoot, previousActive, operationId) {
  const paths = await ensureStateLayout(stateRoot);
  const current = await (async () => {
    if (!await pathExists(paths.active)) return null;
    const stat = await lstat(paths.active);
    invariant(stat.isSymbolicLink(), 'ACTIVE_INDIRECTION_INVALID', 'Active indirection is not a link');
    return readlink(paths.active);
  })();
  invariant(current && path.resolve(current) === path.resolve(expectedReleaseRoot), 'ACTIVE_ROLLBACK_CONFLICT', 'Active indirection changed after installation', { expectedReleaseRoot, current });
  const temp = path.join(stateRoot, `.active-restore-${operationId}`);
  if (previousActive) await symlink(previousActive, temp, process.platform === 'win32' ? 'junction' : 'dir');
  const old = path.join(stateRoot, `.active-failed-${operationId}`);
  await rename(paths.active, old);
  if (previousActive) await rename(temp, paths.active);
  await rm(old, { recursive: true });
  await appendJournal(stateRoot, operationId, { phase: 'active-restored', expectedReleaseRoot, previousActive });
}

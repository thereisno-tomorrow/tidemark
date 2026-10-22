import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, digestObject } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWrite, atomicWriteJson, copyTree, describePath, matchesDescriptor, pathExists } from './fs-safe.mjs';
import { assertNarrowTarget, ensureWithin } from './paths.mjs';
import { ensureStateLayout } from './state.mjs';

function backupId(date = new Date()) {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

export async function createBackup(stateRoot, targets, roots, { id = backupId(), retentionDays = 30 } = {}) {
  const state = await ensureStateLayout(stateRoot);
  const root = ensureWithin(state.backups, path.join(state.backups, id));
  invariant(!await pathExists(root), 'BACKUP_EXISTS', `Backup already exists: ${id}`);
  await mkdir(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  const entries = [];
  for (const [index, target] of [...new Set(targets.map((item) => path.resolve(item)))].sort().entries()) {
    assertNarrowTarget(target, roots);
    const descriptor = await describePath(target);
    const dataPath = descriptor.type === 'absent' || descriptor.type === 'link' ? null : `data/${String(index).padStart(4, '0')}`;
    if (descriptor.type === 'file') await atomicWrite(path.join(root, dataPath), await import('node:fs/promises').then(({ readFile }) => readFile(target)));
    else if (descriptor.type === 'directory') await copyTree(target, path.join(root, dataPath));
    entries.push({ target, descriptor, dataPath });
  }
  const unsigned = {
    schemaVersion: 1,
    backupId: id,
    createdAt: new Date().toISOString(),
    retentionUntil: new Date(Date.now() + retentionDays * 86400_000).toISOString(),
    accessControl: process.platform === 'win32' ? 'inherited-user-profile-acl' : '0700',
    entries,
  };
  const manifest = { ...unsigned, manifestDigest: digestObject(unsigned) };
  await atomicWriteJson(path.join(root, 'backup-manifest.json'), manifest);
  await verifyBackup(root, manifest);
  return { root, manifest };
}

export async function verifyBackup(root, manifest) {
  const unsigned = structuredClone(manifest);
  delete unsigned.manifestDigest;
  invariant(digestObject(unsigned) === manifest.manifestDigest, 'BACKUP_MANIFEST_TAMPERED', 'Backup manifest digest is invalid');
  for (const entry of manifest.entries) {
    if (!entry.dataPath) continue;
    const descriptor = await describePath(path.join(root, entry.dataPath));
    invariant(descriptor.type === entry.descriptor.type && descriptor.hash === entry.descriptor.hash, 'BACKUP_VERIFY_FAILED', `Backup data mismatch for ${entry.target}`);
  }
  return true;
}

export async function restoreBackupEntry(backupRoot, entry, roots) {
  assertNarrowTarget(entry.target, roots);
  const parentRoot = [path.join(roots.USER_HOME, '.claude'), path.join(roots.USER_HOME, '.codex'), path.join(roots.USER_HOME, '.agents'), path.join(roots.AGENT_CONFIG_STATE_ROOT, 'controller')]
    .find((root) => path.relative(root, entry.target) && !path.relative(root, entry.target).startsWith('..'));
  invariant(parentRoot, 'TARGET_ROOT_DENIED', `Restore target is outside provider roots: ${entry.target}`);
  const current = await describePath(entry.target);
  if (current.type !== 'absent') await rm(entry.target, { recursive: current.type === 'directory', force: false });
  await mkdir(path.dirname(entry.target), { recursive: true });
  if (entry.descriptor.type === 'absent') return;
  if (entry.descriptor.type === 'file') await atomicWrite(entry.target, await import('node:fs/promises').then(({ readFile }) => readFile(path.join(backupRoot, entry.dataPath))));
  else if (entry.descriptor.type === 'directory') await copyTree(path.join(backupRoot, entry.dataPath), entry.target);
  else if (entry.descriptor.type === 'link') {
    const linkType = process.platform === 'win32'
      ? (await lstat(entry.descriptor.linkTarget)).isDirectory() ? 'junction' : 'file'
      : undefined;
    await symlink(entry.descriptor.linkTarget, entry.target, linkType);
  }
  const restored = await describePath(entry.target);
  invariant(matchesDescriptor(restored, entry.descriptor), 'RESTORE_VERIFY_FAILED', `Restored preimage does not match: ${entry.target}`);
}

export async function loadBackup(stateRoot, id) {
  const state = await ensureStateLayout(stateRoot);
  const root = ensureWithin(state.backups, path.join(state.backups, id));
  if (!await pathExists(root)) throw new AgentConfigError('BACKUP_NOT_FOUND', `Backup not found: ${id}`);
  const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(path.join(root, 'backup-manifest.json'), 'utf8')));
  await verifyBackup(root, manifest);
  return { root, manifest };
}

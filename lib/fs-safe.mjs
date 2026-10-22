import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize, sha256 } from './canonical-json.mjs';
import { invariant } from './errors.mjs';
import { ensureWithin, normalizeRelative, toPortablePath } from './paths.mjs';

export async function pathExists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function hashFile(target) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function describePath(target) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      return { type: 'link', size: stat.size, linkTarget: await readlink(target), hash: null };
    }
    if (stat.isFile()) return { type: 'file', size: stat.size, hash: await hashFile(target), linkTarget: null };
    if (stat.isDirectory()) return { type: 'directory', size: null, hash: await hashTree(target), linkTarget: null };
    return { type: 'other', size: stat.size, hash: null, linkTarget: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { type: 'absent', size: 0, hash: null, linkTarget: null };
    throw error;
  }
}

export async function listTree(root, { exclude = () => false } = {}) {
  const result = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = toPortablePath(path.relative(root, absolute));
      if (exclude(relative, entry)) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        result.push({ path: relative, type: 'link', target: await readlink(absolute), size: stat.size });
      } else if (stat.isDirectory()) {
        result.push({ path: relative, type: 'directory', size: null });
        await visit(absolute);
      } else if (stat.isFile()) {
        result.push({ path: relative, type: 'file', size: stat.size, hash: await hashFile(absolute) });
      }
    }
  }
  if (await pathExists(root)) await visit(root);
  return result;
}

export async function hashTree(root, options) {
  return sha256(canonicalize(await listTree(root, options)));
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function atomicWrite(target, data, { mode } = {}) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
}

export async function atomicWriteJson(target, value) {
  await atomicWrite(target, canonicalize(value), { mode: 0o600 });
}

export async function copyTree(source, destination, { sourceRoot = source } = {}) {
  ensureWithin(sourceRoot, source, { allowRoot: true });
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    const stat = await lstat(src);
    if (stat.isSymbolicLink()) {
      await symlink(await readlink(src), dst, process.platform === 'win32' ? 'junction' : undefined);
    } else if (stat.isDirectory()) {
      await copyTree(src, dst, { sourceRoot });
    } else if (stat.isFile()) {
      await copyFile(src, dst);
    }
  }
}

export async function removeVerified(target, expected, { allowedRoot }) {
  ensureWithin(allowedRoot, target);
  const actual = await describePath(target);
  invariant(matchesDescriptor(actual, expected), 'POSTIMAGE_CHANGED', `Current object does not match installed postimage: ${target}`, { expected, actual });
  await rm(target, { recursive: actual.type === 'directory', force: false });
}

export function matchesDescriptor(actual, expected) {
  if (actual.type !== expected.type) return false;
  if (actual.type === 'absent') return true;
  if (actual.type === 'link') return actual.linkTarget === expected.linkTarget;
  if (actual.type === 'file' || actual.type === 'directory') return actual.hash === expected.hash;
  return false;
}

export async function writeProtected(root) {
  if (process.platform === 'win32') return;
  const files = await listTree(root);
  for (const entry of files.reverse()) {
    const absolute = path.join(root, normalizeRelative(entry.path));
    await chmod(absolute, entry.type === 'directory' ? 0o555 : 0o444);
  }
  await chmod(root, 0o555);
}

export async function writeText(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

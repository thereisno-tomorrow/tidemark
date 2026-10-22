import { spawnSync } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWrite } from './fs-safe.mjs';
import { ensureWithin, normalizeRelative } from './paths.mjs';

export function runGit(root, args, { encoding = 'utf8', input, env } = {}) {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args], {
    encoding, input, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new AgentConfigError('GIT_FAILED', `git ${args.join(' ')} failed`, {
      status: result.status,
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr,
    });
  }
  return result.stdout;
}

export function repositoryState(root) {
  const commit = runGit(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const tree = runGit(root, ['rev-parse', `${commit}^{tree}`]).trim();
  const branch = runGit(root, ['branch', '--show-current']).trim() || null;
  const status = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  const commitTime = runGit(root, ['show', '-s', '--format=%cI', commit]).trim();
  return { commit, tree, branch, clean: status === '', status: status ? status.split(/\r?\n/) : [], commitTime };
}

export async function materializeCommit(root, commit, destination) {
  const verified = runGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  invariant(verified === commit, 'SOURCE_COMMIT_MISMATCH', 'Source commit did not resolve exactly');
  await mkdir(destination, { recursive: true });
  const output = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: 'buffer' });
  const records = output.toString('utf8').split('\0').filter(Boolean);
  for (const record of records) {
    const match = record.match(/^(\d+)\s+(\w+)\s+([a-f0-9]+)\t(.+)$/s);
    invariant(match, 'GIT_TREE_INVALID', `Unable to parse Git tree entry: ${record}`);
    const [, mode, type, oid, relativeRaw] = match;
    invariant(type === 'blob', 'GIT_TREE_TYPE_DENIED', `Unsupported Git tree object: ${type} ${relativeRaw}`);
    const relative = normalizeRelative(relativeRaw);
    const target = ensureWithin(destination, path.join(destination, relative));
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = runGit(root, ['cat-file', 'blob', oid], { encoding: 'buffer' });
    if (mode === '120000') {
      await symlink(bytes.toString('utf8'), target, process.platform === 'win32' ? 'junction' : undefined);
    } else {
      await atomicWrite(target, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
    }
  }
  return { commit, tree: runGit(root, ['rev-parse', `${commit}^{tree}`]).trim() };
}

export function createSignedTag(root, commit, tagName, message, allowedSignersFile) {
  const signerArgs = allowedSignersFile ? ['-c', `gpg.ssh.allowedSignersFile=${allowedSignersFile}`] : [];
  runGit(root, [...signerArgs, 'tag', '--sign', '--annotate', tagName, commit, '--message', message]);
  runGit(root, [...signerArgs, 'tag', '--verify', tagName]);
  const tagged = runGit(root, ['rev-list', '-n', '1', tagName]).trim();
  invariant(tagged === commit, 'TAG_COMMIT_MISMATCH', `Signed tag ${tagName} does not reference candidate commit`);
  return tagName;
}

export function verifySignedTag(root, tagName, allowedSignersFile) {
  invariant(allowedSignersFile, 'SIGNER_ALLOWLIST_MISSING', 'Pinned signer allowlist is required');
  runGit(root, ['-c', `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, 'tag', '--verify', tagName]);
  return runGit(root, ['rev-list', '-n', '1', tagName]).trim();
}

export function assertDeploymentBranchNotCheckedOut(root, branch) {
  const blocks = runGit(root, ['worktree', 'list', '--porcelain']).trim().split(/\r?\n\r?\n/);
  const checkedOut = blocks.filter((block) => block.split(/\r?\n/).includes(`branch refs/heads/${branch}`));
  invariant(checkedOut.length === 0, 'DEPLOYMENT_BRANCH_CHECKED_OUT', `Deployment branch ${branch} is checked out; switch that worktree to an authoring branch before finalization`);
}

export function compareAndSwapBranch(root, branch, expectedBase, candidate) {
  const ref = `refs/heads/${branch}`;
  const current = runGit(root, ['rev-parse', '--verify', ref]).trim();
  invariant(current === expectedBase, 'BRANCH_CAS_FAILED', `Deployment branch ${branch} changed`, { expectedBase, current });
  const ancestor = spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'merge-base', '--is-ancestor', expectedBase, candidate]);
  invariant(ancestor.status === 0, 'NON_FAST_FORWARD', 'Candidate is not a fast-forward from deployment base');
  runGit(root, ['update-ref', ref, candidate, expectedBase]);
  return { ref, previous: expectedBase, current: candidate };
}

export function isAncestor(root, ancestor, descendant) {
  const result = spawnSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new AgentConfigError('GIT_FAILED', 'git merge-base --is-ancestor failed', { status: result.status });
}

/** Fast-forward the clean canonical checkout without rewriting or discarding its worktree. */
export function fastForwardCheckedOutBranch(root, branch, expectedBase, candidate) {
  const before = repositoryState(root);
  invariant(before.clean, 'DIRTY_SOURCE', 'Canonical checkout contains authored work; reconciliation refused', { paths: before.status });
  invariant(before.branch === branch, 'RECONCILE_BRANCH_NOT_CHECKED_OUT', `Canonical checkout must have ${branch} checked out`, { current: before.branch });
  invariant(before.commit === expectedBase, 'BRANCH_CAS_FAILED', `Canonical branch ${branch} changed`, { expectedBase, current: before.commit });
  invariant(isAncestor(root, expectedBase, candidate), 'NON_FAST_FORWARD', 'Candidate is not a fast-forward from the recorded transaction base');
  runGit(root, ['merge', '--ff-only', '--no-edit', candidate]);
  const after = repositoryState(root);
  invariant(after.clean && after.branch === branch && after.commit === candidate, 'RECONCILE_POSTCHECK_FAILED', 'Canonical checkout did not reach the exact candidate cleanly');
  return { ref: `refs/heads/${branch}`, previous: expectedBase, current: candidate, worktreeUpdated: true };
}

export function formatReleaseTag(date, commit) {
  const stamp = new Date(date).toISOString().replace(/[-:]/g, '').replace('T', '.').slice(0, 15);
  invariant(/^[a-f0-9]{12,}$/.test(commit), 'INVALID_COMMIT', 'Commit must be a full hexadecimal object id');
  return `agent-config-v${stamp}-${commit.slice(0, 12)}`;
}

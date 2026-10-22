import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rollbackBackup } from './apply.mjs';
import { canonicalize, digestObject } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWriteJson, pathExists, readJson } from './fs-safe.mjs';
import { assertDeploymentBranchNotCheckedOut, compareAndSwapBranch, createSignedTag, fastForwardCheckedOutBranch, formatReleaseTag, runGit } from './git.mjs';
import { loadConfiguration } from './manifest.mjs';
import { verifyPlanDigest } from './planner.mjs';
import { acquireLock, appendJournal, ensureStateLayout } from './state.mjs';

function nonCommentLines(content) {
  return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function planPathForId(planId, install) {
  invariant(/^sha256:[a-f0-9]{64}$/.test(planId), 'PLAN_ID_INVALID', 'A full SHA-256 plan id is required');
  return install?.planPath || path.join(os.tmpdir(), 'agent-config-plans', `${planId.replace(':', '-')}.json`);
}

/**
 * Reconcile an already verified local release into the clean canonical authoring branch.
 * This deliberately does not sign, tag, push, reinstall, or roll back the healthy install.
 */
export async function reconcileRelease({ planId, branch, expectedBase, confirmationPlanId, root, stateRoot }) {
  invariant(confirmationPlanId === planId, 'CONFIRMATION_REQUIRED', `Exact reconciliation confirmation required: ${planId}`);
  const state = await ensureStateLayout(stateRoot);
  invariant(await pathExists(state.current), 'NO_INSTALL', 'No provisional installation exists');
  let install = await readJson(state.current);
  const plan = await readJson(planPathForId(planId, install));
  verifyPlanDigest(plan);
  invariant(path.resolve(plan.source.canonicalRoot || '') === path.resolve(root), 'CANONICAL_ROOT_MISMATCH', 'Plan was not generated for this canonical checkout');
  invariant(/^[a-f0-9]{40}$/.test(expectedBase), 'EXPECTED_BASE_INVALID', 'A full expected base commit is required');
  runGit(root, ['check-ref-format', '--branch', branch]);
  if (install.status === 'active-reconciled' && install.planId === planId && install.reconciliation?.current === plan.source.commit) {
    return { ok: true, status: install.status, install, reconciliation: install.reconciliation, idempotent: true };
  }
  invariant(install.planId === planId && install.status === 'verified-provisional', 'INSTALL_NOT_PROVISIONAL', 'The exact plan is not installed as verified-provisional');
  const lock = await acquireLock(stateRoot, 'promotion');
  try {
    install = await readJson(state.current);
    invariant(install.planId === planId && install.status === 'verified-provisional', 'INSTALL_CHANGED', 'Installed release changed before reconciliation');
    const moved = fastForwardCheckedOutBranch(root, branch, expectedBase, plan.source.commit);
    const reconciliation = { planId, branch, previous: moved.previous, current: moved.current, reconciledAt: new Date().toISOString() };
    const reconciled = { ...install, status: 'active-reconciled', sourceCommit: plan.source.commit, reconciliation, automationDisabled: false, syncState: 'local-reconciled' };
    await atomicWriteJson(state.current, reconciled);
    await appendJournal(stateRoot, install.operationId, { phase: 'release-reconciled', ...reconciliation, status: reconciled.status });
    return { ok: true, status: reconciled.status, install: reconciled, reconciliation };
  } finally { await lock.release(); }
}

export async function finalizeRelease({ planPath, root, stateRoot, now = new Date(), roots = null }) {
  const plan = await readJson(path.resolve(planPath));
  verifyPlanDigest(plan);
  const state = await ensureStateLayout(stateRoot);
  invariant(await pathExists(state.current), 'NO_INSTALL', 'No provisional installation exists');
  const install = await readJson(state.current);
  invariant(install.planId === plan.planId && install.status === 'verified-provisional', 'INSTALL_NOT_PROVISIONAL', 'The exact plan is not installed as verified-provisional');
  const configuration = await loadConfiguration(root);
  const localPolicyDigest = digestObject({ policy: configuration.policy, routing: configuration.routing, trustedRemotes: configuration.trustedRemotes });
  invariant(localPolicyDigest === plan.policyDigest, 'POLICY_CHANGED', 'Local trusted policy changed after planning');
  const lock = await acquireLock(stateRoot, 'promotion');
  const operationId = install.operationId;
  let tagName = null;
  let createdTag = false;
  let branchMoved = false;
  try {
    const allowlist = path.join(root, 'automation', 'trusted-signers');
    const signers = nonCommentLines(await readFile(allowlist, 'utf8'));
    invariant(signers.length > 0, 'SIGNER_ALLOWLIST_EMPTY', 'Pinned signer allowlist has not been configured');
    assertDeploymentBranchNotCheckedOut(plan.source.root, plan.source.deploymentBranch);
    const remotes = configuration.trustedRemotes;
    const remote = remotes.enabled ? remotes.remotes.find((item) => item.enabled !== false) : null;
    if (remotes.enabled) invariant(remote?.name, 'TRUSTED_REMOTE_MISSING', 'Trusted remote is enabled but not configured');
    tagName = formatReleaseTag(now, plan.source.commit);
    const existing = spawnSync('git', ['-c', `safe.directory=${plan.source.root}`, '-C', plan.source.root, 'rev-parse', '--verify', `refs/tags/${tagName}`], { encoding: 'utf8' });
    if (existing.status === 0) {
      const existingCommit = runGit(plan.source.root, ['rev-list', '-n', '1', tagName]).trim();
      invariant(existingCommit === plan.source.commit, 'TAG_COLLISION', `Release tag exists for different content: ${tagName}`);
      runGit(plan.source.root, ['-c', `gpg.ssh.allowedSignersFile=${allowlist}`, 'tag', '--verify', tagName]);
    } else {
      createSignedTag(plan.source.root, plan.source.commit, tagName, `agent-config release ${plan.release.releaseId}\nplan ${plan.planId}\npolicy ${plan.policyDigest}`, allowlist);
      createdTag = true;
    }
    await appendJournal(stateRoot, operationId, { phase: 'signed-tag-created', tagName, commit: plan.source.commit });
    compareAndSwapBranch(plan.source.root, plan.source.deploymentBranch, plan.source.deploymentBase, plan.source.commit);
    branchMoved = true;
    await appendJournal(stateRoot, operationId, { phase: 'branch-promoted', sourceRoot: plan.source.root, branch: plan.source.deploymentBranch, previous: plan.source.deploymentBase, current: plan.source.commit });
    let syncState = 'disabled';
    if (remotes.enabled) {
      const push = spawnSync('git', ['-c', `safe.directory=${plan.source.root}`, '-C', plan.source.root, 'push', '--atomic', remote.name, `refs/heads/${plan.source.deploymentBranch}`, `refs/tags/${tagName}`], { encoding: 'utf8' });
      syncState = push.status === 0 ? 'awaiting-ci-attestation' : 'push-pending';
    }
    const finalized = { ...install, status: 'active', finalizedAt: new Date().toISOString(), tagName, syncState, ciAttestation: 'pending' };
    await atomicWriteJson(state.current, finalized);
    await appendJournal(stateRoot, operationId, { phase: 'finalize-complete', tagName, status: 'active', syncState });
    return { ok: true, install: finalized, tagName, syncState };
  } catch (error) {
    if (branchMoved) {
      await appendJournal(stateRoot, operationId, { phase: 'finalize-interrupted-after-branch', tagName, code: error.code ?? 'INTERNAL', message: error.message });
      throw new AgentConfigError('FINALIZE_RECOVERY_REQUIRED', `Canonical branch moved but finalization state was interrupted: ${error.message}`, { tagName });
    }
    if (createdTag && tagName) {
      spawnSync('git', ['-c', `safe.directory=${plan.source.root}`, '-C', plan.source.root, 'tag', '--delete', tagName], { encoding: 'utf8' });
    }
    try { await rollbackBackup({ backupId: install.backupId, root, stateRoot, roots, expectedInstall: install }); }
    catch (rollbackError) { throw new AgentConfigError('FINALIZE_ROLLBACK_CONFLICT', `Finalization failed and rollback was incomplete: ${error.message}`, { rollback: rollbackError.message }); }
    throw error;
  } finally { await lock.release(); }
}

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { rollbackBackup } from './apply.mjs';
import { digestObject } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWriteJson, pathExists, readJson } from './fs-safe.mjs';
import { runGit, verifySignedTag } from './git.mjs';
import { resolveRoots } from './paths.mjs';
import { acquireLock, appendJournal, readJournal, statePaths } from './state.mjs';

const TERMINAL = new Set([
  'apply-complete',
  'apply-rollback-complete',
  'rollback-complete',
  'finalize-complete',
  'recovery-complete',
]);

async function buildRecoveryPreview(roots) {
  const state = statePaths(roots.AGENT_CONFIG_STATE_ROOT);
  const files = await pathExists(state.journal)
    ? (await readdir(state.journal)).filter((name) => name.endsWith('.jsonl')).sort()
    : [];
  const candidateOperations = [];

  for (const file of files) {
    const journalPath = path.join(state.journal, file);
    const entries = await readJournal(journalPath);
    const last = entries.at(-1);
    if (!last || TERMINAL.has(last.phase)) continue;

    const operationId = path.basename(file, '.jsonl');
    const branchPromotion = [...entries].reverse().find((entry) => entry.phase === 'branch-promoted');
    const signedTag = [...entries].reverse().find((entry) => entry.phase === 'signed-tag-created');
    if (branchPromotion && signedTag) {
      candidateOperations.push({
        operationId,
        action: 'complete-finalization',
        branch: branchPromotion.branch,
        expectedCommit: branchPromotion.current,
        tagName: signedTag.tagName,
        affectedTargets: [state.current],
      });
      continue;
    }

    const backup = [...entries].reverse().find((entry) => entry.backupId);
    const mutations = entries.filter((entry) => entry.phase === 'target-mutated');
    if (!backup) {
      candidateOperations.push({
        operationId,
        action: 'close-before-mutation',
        affectedTargets: [journalPath],
      });
      continue;
    }

    const latest = new Map();
    for (const mutation of mutations) latest.set(mutation.target, mutation.postimage);
    candidateOperations.push({
      operationId,
      action: 'guarded-rollback',
      backupId: backup.backupId,
      targets: [...latest].sort(([left], [right]) => left.localeCompare(right))
        .map(([target, postimage]) => ({ target, postimage })),
      affectedTargets: [...latest.keys()].sort(),
    });
  }

  const affectedTargets = [...new Set(candidateOperations.flatMap((item) => item.affectedTargets))].sort();
  const recoveryPlanId = candidateOperations.length
    ? digestObject({ schemaVersion: 1, candidateOperations })
    : null;
  return {
    schemaVersion: 1,
    mode: 'preview',
    candidateOperations,
    affectedTargets,
    recoveryPlanId,
  };
}

async function applyRecoveryOperation(operation, roots) {
  const state = statePaths(roots.AGENT_CONFIG_STATE_ROOT);
  if (operation.action === 'complete-finalization') {
    try {
      const currentBranch = runGit(roots.AGENT_CONFIG_ROOT, ['rev-parse', '--verify', `refs/heads/${operation.branch}`]).trim();
      if (currentBranch !== operation.expectedCommit) {
        throw new AgentConfigError('BRANCH_RECOVERY_CONFLICT', 'Canonical branch no longer matches the journaled promotion');
      }
      const tagCommit = verifySignedTag(
        roots.AGENT_CONFIG_ROOT,
        operation.tagName,
        path.join(roots.AGENT_CONFIG_ROOT, 'automation', 'trusted-signers'),
      );
      if (tagCommit !== operation.expectedCommit) {
        throw new AgentConfigError('TAG_RECOVERY_CONFLICT', 'Signed tag no longer matches the journaled promotion');
      }
      const current = await readJson(state.current);
      if (current.operationId !== operation.operationId) {
        throw new AgentConfigError('INSTALL_RECOVERY_CONFLICT', 'Install state belongs to a different operation');
      }
      await atomicWriteJson(state.current, {
        ...current,
        status: 'active',
        tagName: operation.tagName,
        finalizedAt: new Date().toISOString(),
        syncState: 'recovery-pending',
      });
      await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operation.operationId, {
        phase: 'recovery-complete',
        action: 'complete-finalization',
        status: 'active',
      });
      return { operationId: operation.operationId, action: operation.action, status: 'active' };
    } catch (error) {
      return {
        operationId: operation.operationId,
        action: 'preserve-finalization-conflict',
        status: 'rollback-conflict',
        error: error.message,
      };
    }
  }

  if (operation.action === 'close-before-mutation') {
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operation.operationId, {
      phase: 'recovery-complete',
      action: 'no-target-mutation-to-reverse',
    });
    return { operationId: operation.operationId, action: operation.action, status: 'recovered' };
  }

  try {
    const result = await rollbackBackup({
      backupId: operation.backupId,
      root: roots.AGENT_CONFIG_ROOT,
      stateRoot: roots.AGENT_CONFIG_STATE_ROOT,
      roots,
      expectedInstall: { targets: operation.targets },
    });
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operation.operationId, {
      phase: 'recovery-complete',
      action: 'guarded-rollback',
      status: result.status,
    });
    return { operationId: operation.operationId, action: operation.action, status: result.status };
  } catch (error) {
    return {
      operationId: operation.operationId,
      action: 'preserve-conflict',
      status: 'rollback-conflict',
      error: error.message,
    };
  }
}

export async function recover({
  root,
  stateRoot,
  roots: providedRoots = null,
  apply = false,
  confirmationPlanId = null,
}) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  if (!apply) return buildRecoveryPreview(roots);

  invariant(confirmationPlanId, 'CONFIRMATION_REQUIRED', 'Recovery apply requires --confirm-plan-id <recoveryPlanId>');
  const lock = await acquireLock(roots.AGENT_CONFIG_STATE_ROOT, 'promotion');
  try {
    const preview = await buildRecoveryPreview(roots);
    invariant(
      preview.recoveryPlanId && confirmationPlanId === preview.recoveryPlanId,
      'STALE_RECOVERY_PLAN',
      'Recovery preview changed or the confirmation plan ID is wrong',
      { expected: preview.recoveryPlanId, provided: confirmationPlanId },
    );
    const operations = [];
    for (const candidate of preview.candidateOperations) {
      operations.push(await applyRecoveryOperation(candidate, roots));
    }
    return {
      ok: operations.every((item) => item.status !== 'rollback-conflict'),
      mode: 'apply',
      recoveryPlanId: preview.recoveryPlanId,
      affectedTargets: preview.affectedTargets,
      operations,
    };
  } finally {
    await lock.release();
  }
}

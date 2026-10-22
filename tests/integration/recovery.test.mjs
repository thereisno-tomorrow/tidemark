import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createBackup } from '../../lib/backup.mjs';
import { describePath } from '../../lib/fs-safe.mjs';
import { recover } from '../../lib/recovery.mjs';
import { appendJournal } from '../../lib/state.mjs';
import { makeFixture } from '../helpers.mjs';

async function interruptedApply(fixture, operationId = 'interrupted-fixture') {
  const target = path.join(fixture.userHome, '.claude', 'CLAUDE.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'before\n', 'utf8');
  const backup = await createBackup(fixture.state, [target], fixture.roots);
  await writeFile(target, 'after\n', 'utf8');
  const postimage = await describePath(target);
  await appendJournal(fixture.state, operationId, { phase: 'started', action: 'apply', planId: 'fixture' });
  await appendJournal(fixture.state, operationId, { phase: 'backup-complete', backupId: backup.manifest.backupId });
  await appendJournal(fixture.state, operationId, { phase: 'target-mutated', target, postimage });
  return { target, operationId };
}

test('recover previews deterministically without writing, then applies only the exact confirmed preview', async () => {
  const fixture = await makeFixture();
  try {
    const { target, operationId } = await interruptedApply(fixture);
    const journal = path.join(fixture.state, 'installs', 'journal', `${operationId}.jsonl`);
    const beforeJournal = await readFile(journal, 'utf8');

    const preview = await recover({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(preview.mode, 'preview');
    assert.match(preview.recoveryPlanId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(preview.candidateOperations.length, 1);
    assert.deepEqual(preview.affectedTargets, [target]);
    assert.equal(await readFile(target, 'utf8'), 'after\n');
    assert.equal(await readFile(journal, 'utf8'), beforeJournal);

    await assert.rejects(
      () => recover({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, apply: true }),
      (error) => error.code === 'CONFIRMATION_REQUIRED',
    );
    await assert.rejects(
      () => recover({
        root: fixture.repo,
        stateRoot: fixture.state,
        roots: fixture.roots,
        apply: true,
        confirmationPlanId: 'sha256:wrong',
      }),
      (error) => error.code === 'STALE_RECOVERY_PLAN',
    );
    assert.equal(await readFile(target, 'utf8'), 'after\n');

    const applied = await recover({
      root: fixture.repo,
      stateRoot: fixture.state,
      roots: fixture.roots,
      apply: true,
      confirmationPlanId: preview.recoveryPlanId,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.mode, 'apply');
    assert.equal(await readFile(target, 'utf8'), 'before\n');

    const empty = await recover({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(empty.recoveryPlanId, null);
    assert.deepEqual(empty.candidateOperations, []);
    assert.deepEqual(empty.affectedTargets, []);
  } finally {
    await fixture.cleanup();
  }
});

test('recovery apply rejects a stale preview after journal state changes', async () => {
  const fixture = await makeFixture();
  try {
    const { target } = await interruptedApply(fixture, 'first-interrupted');
    const preview = await recover({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    await appendJournal(fixture.state, 'second-interrupted', { phase: 'started', action: 'apply', planId: 'second' });

    await assert.rejects(
      () => recover({
        root: fixture.repo,
        stateRoot: fixture.state,
        roots: fixture.roots,
        apply: true,
        confirmationPlanId: preview.recoveryPlanId,
      }),
      (error) => error.code === 'STALE_RECOVERY_PLAN',
    );
    assert.equal(await readFile(target, 'utf8'), 'after\n');
  } finally {
    await fixture.cleanup();
  }
});

test('a successfully auto-rolled-back apply journal is terminal and never reversed again', async () => {
  const fixture = await makeFixture();
  try {
    await appendJournal(fixture.state, 'already-rolled-back', { phase: 'started', action: 'apply', planId: 'fixture' });
    await appendJournal(fixture.state, 'already-rolled-back', { phase: 'apply-failed', code: 'FIXTURE' });
    await appendJournal(fixture.state, 'already-rolled-back', {
      phase: 'apply-rollback-complete',
      action: 'automatic-rollback',
      status: 'rolled-back',
      backupId: 'fixture-backup',
    });
    const preview = await recover({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(preview.recoveryPlanId, null);
    assert.deepEqual(preview.candidateOperations, []);
  } finally {
    await fixture.cleanup();
  }
});

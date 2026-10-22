import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readJson } from '../../lib/fs-safe.mjs';
import { repositoryState, runGit } from '../../lib/git.mjs';
import { loadConfiguration } from '../../lib/manifest.mjs';
import { reconcileRelease } from '../../lib/release.mjs';
import {
  beginTransaction, patchTransaction, promoteTransaction, readTransactionPath,
  reconcileTransaction, supersedeTransaction, testTransaction, transactionStatus,
} from '../../lib/transaction.mjs';
import { addSkill, makeFixture } from '../helpers.mjs';

async function installDemo(fixture, body) {
  const { policy } = await loadConfiguration(fixture.repo);
  const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'demo', provider: 'codex', request: `Update demo to ${body}.`, roots: fixture.roots });
  const current = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/demo/SKILL.md' });
  await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: current.path, expectedHash: current.hash, content: current.content.replace('Original body.', body) }] });
  await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
  const planned = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
  const installed = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: planned.planId, roots: fixture.roots });
  const record = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
  return { ...begun, ...installed, planId: planned.planId, record };
}

test('transaction reconciliation fast-forwards the clean canonical checkout and leaves the healthy install alone', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const installed = await installDemo(fixture, 'Reconciled body.');
    const installPath = path.join(fixture.state, 'installs', 'current.json');
    const beforeInstall = await readFile(installPath, 'utf8');
    const result = await reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: installed.transactionId });
    const canonical = repositoryState(fixture.repo);
    assert.equal(result.phase, 'reconciled');
    assert.equal(result.reconciliation.mode, 'fast-forwarded');
    assert.equal(canonical.commit, installed.record.candidate.commit);
    assert.equal(canonical.clean, true);
    assert.match(await readFile(path.join(fixture.repo, 'skills', 'demo', 'SKILL.md'), 'utf8'), /Reconciled body\./);
    assert.equal(await readFile(installPath, 'utf8'), beforeInstall);
  } finally { await fixture.cleanup(); }
});

test('transaction reconciliation refuses a competing canonical commit without rolling back the install', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const installed = await installDemo(fixture, 'Candidate body.');
    const installPath = path.join(fixture.state, 'installs', 'current.json');
    const beforeInstall = await readFile(installPath, 'utf8');
    await writeFile(path.join(fixture.repo, 'competing.txt'), 'competing\n', 'utf8');
    runGit(fixture.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'add', '--', 'competing.txt']);
    runGit(fixture.repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'competing change']);
    const competing = repositoryState(fixture.repo).commit;
    await assert.rejects(
      () => reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: installed.transactionId }),
      (error) => error.code === 'BRANCH_CAS_FAILED',
    );
    assert.equal(repositoryState(fixture.repo).commit, competing);
    assert.equal(await readFile(installPath, 'utf8'), beforeInstall);
    assert.equal((await transactionStatus({ stateRoot: fixture.state, transactionId: installed.transactionId })).phase, 'verified-provisional');
  } finally { await fixture.cleanup(); }
});

test('release reconciliation requires the exact plan id and then absorbs its transaction candidate', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const installed = await installDemo(fixture, 'Release body.');
    await assert.rejects(
      () => reconcileRelease({ planId: installed.planId, branch: installed.record.base.branch, expectedBase: installed.record.base.commit, confirmationPlanId: 'wrong', root: fixture.repo, stateRoot: fixture.state }),
      (error) => error.code === 'CONFIRMATION_REQUIRED',
    );
    const released = await reconcileRelease({ planId: installed.planId, branch: installed.record.base.branch, expectedBase: installed.record.base.commit, confirmationPlanId: installed.planId, root: fixture.repo, stateRoot: fixture.state });
    assert.equal(released.status, 'active-reconciled');
    assert.equal(repositoryState(fixture.repo).commit, installed.record.candidate.commit);
    const transaction = await reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: installed.transactionId });
    assert.equal(transaction.reconciliation.mode, 'already-current');
    assert.equal((await readJson(path.join(fixture.state, 'installs', 'current.json'))).status, 'active-reconciled');
  } finally { await fixture.cleanup(); }
});

test('a reconciled replacement can mark a non-active sibling superseded while retaining evidence', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const older = await installDemo(fixture, 'Older body.');
    const replacement = await installDemo(fixture, 'Replacement body.');
    await reconcileRelease({ planId: replacement.planId, branch: replacement.record.base.branch, expectedBase: replacement.record.base.commit, confirmationPlanId: replacement.planId, root: fixture.repo, stateRoot: fixture.state });
    await reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: replacement.transactionId });
    const retired = await supersedeTransaction({ stateRoot: fixture.state, transactionId: older.transactionId, replacementTransactionId: replacement.transactionId });
    assert.equal(retired.phase, 'superseded');
    assert.equal(retired.evidenceRetained, true);
    const record = await transactionStatus({ stateRoot: fixture.state, transactionId: older.transactionId });
    assert.equal(record.supersededBy, replacement.transactionId);
    assert.equal(await readFile(path.join(fixture.state, 'transactions', older.transactionId, 'transaction.json'), 'utf8').then(Boolean), true);
  } finally { await fixture.cleanup(); }
});

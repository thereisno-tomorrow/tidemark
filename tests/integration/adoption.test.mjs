import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { rollbackBackup, checkInstalled } from '../../lib/apply.mjs';
import { createBackup } from '../../lib/backup.mjs';
import { canonicalize, sha256, withContentId } from '../../lib/canonical-json.mjs';
import { check, doctor } from '../../lib/diagnostics.mjs';
import { describePath, pathExists, readJson } from '../../lib/fs-safe.mjs';
import { runGit } from '../../lib/git.mjs';
import { loadConfiguration } from '../../lib/manifest.mjs';
import { beginTransaction, patchTransaction, promoteTransaction, readTransactionPath, reconcileTransaction, testTransaction, transactionStatus } from '../../lib/transaction.mjs';
import { appendJournal, readJournal } from '../../lib/state.mjs';
import { makeFixture } from '../helpers.mjs';

const SKILL = '---\nname: adopted\ndescription: Fixture for explicit installed-skill adoption tests.\n---\n\n# Adopted\n\nExisting semantics.\n';
const EXAMPLE_BYTES = Buffer.from("---\r\nname: example-runtime\r\ndescription: Exercise byte-preserving adoption and exact rollback.\r\n---\r\n\r\n# Example runtime\r\n\r\nFixture line 000: preserve neutral bytes.\r\nFixture line 001: preserve neutral bytes.\r\nFixture line 002: preserve neutral bytes.\r\nFixture line 003: preserve neutral bytes.\r\nFixture line 004: preserve neutral bytes.\r\nFixture line 005: preserve neutral bytes.\r\nFixture line 006: preserve neutral bytes.\r\nFixture line 007: preserve neutral bytes.\r\nFixture line 008: preserve neutral bytes.\r\nFixture line 009: preserve neutral bytes.\r\nFixture line 010: preserve neutral bytes.\r\nFixture line 011: preserve neutral bytes.\r\nFixture line 012: preserve neutral bytes.\r\nFixture line 013: preserve neutral bytes.\r\nFixture line 014: preserve neutral bytes.\r\nFixture line 015: preserve neutral bytes.\r\nFixture line 016: preserve neutral bytes.\r\nFixture line 017: preserve neutral bytes.\r\nFixture line 018: preserve neutral bytes.\r\nFixture line 019: preserve neutral bytes.\r\nFixture line 020: preserve neutral bytes.\r\nFixture line 021: preserve neutral bytes.\r\nFixture line 022: preserve neutral bytes.\r\nFixture line 023: preserve neutral bytes.\r\nFixture line 024: preserve neutral bytes.\r\nFixture line 025: preserve neutral bytes.\r\nFixture line 026: preserve neutral bytes.\r\nFixture line 027: preserve neutral bytes.\r\nFixture line 028: preserve neutral bytes.\r\nFixture line 029: preserve neutral bytes.\r\nFixture line 030: preserve neutral bytes.\r\nFixture line 031: preserve neutral bytes.\r\nFixture line 032: preserve neutral bytes.\r\nFixture line 033: preserve neutral bytes.\r\nFixture line 034: preserve neutral bytes.\r\nFixture line 035: preserve neutral bytes.\r\nFixture line 036: preserve neutral bytes.\r\nFixture line 037: preserve neutral bytes.\r\nFixture line 038: preserve neutral bytes.\r\nFixture line 039: preserve neutral bytes.\r\nFixture line 040: preserve neutral bytes.\r\nFixture line 041: preserve neutral bytes.\r\nFixture line 042: preserve neutral bytes.\r\nFixture line 043: preserve neutral bytes.\r\nFixture line 044: preserve neutral bytes.\r\nFixture line 045: preserve neutral bytes.\r\nFixture line 046: preserve neutral bytes.\r\nFixture line 047: preserve neutral bytes.\r\nFixture line 048: preserve neutral bytes.\r\nFixture line 049: preserve neutral bytes.\r\nFixture line 050: preserve neutral bytes.\r\nFixture line 051: preserve neutral bytes.\r\nFixture line 052: preserve neutral bytes.\r\nFixture line 053: preserve neutral bytes.\r\nFixture line 054: preserve neutral bytes.\r\nFixture line 055: preserve neutral bytes.\r\nFixture line 056: preserve neutral bytes.\r\nFixture line 057: preserve neutral bytes.\r\nFixture line 058: preserve neutral bytes.\r\nFixture line 059: preserve neutral bytes.\r\nFixture line 060: preserve neutral bytes.\r\nFixture line 061: preserve neutral bytes.\r\nFixture line 062: preserve neutral bytes.\r\nFixture line 063: preserve neutral bytes.\r\nFixture line 064: preserve neutral bytes.\r\nFixture line 065: preserve neutral bytes.\r\nFixture line 066: preserve neutral bytes.\r\nFixture line 067: preserve neutral bytes.\r\nFixture line 068: preserve neutral bytes.\r\nFixture line 069: preserve neutral bytes.\r\nFixture line 070: preserve neutral bytes.\r\nFixture line 071: preserve neutral bytes.\r\nFixture line 072: preserve neutral bytes.\r\nFixture line 073: preserve neutral bytes.\r\nFixture line 074: preserve neutral bytes.\r\nFixture line 075: preserve neutral bytes.\r\nFixture line 076: preserve neutral bytes.\r\nFixture line 077: preserve neutral bytes.\r\nFixture line 078: preserve neutral bytes.\r\nFixture line 079: preserve neutral bytes.\r\nFixture line 080: preserve neutral bytes.\r\nFixture line 081: preserve neutral bytes.\r\nFixture line 082: preserve neutral bytes.\r\nFixture line 083: preserve neutral bytes.\r\nFixture line 084: preserve neutral bytes.\r\nFixture line 085: preserve neutral bytes.\r\nFixture line 086: preserve neutral bytes.\r\nFixture line 087: preserve neutral bytes.\r\nFixture line 088: preserve neutral bytes.\r\nFixture line 089: preserve neutral bytes.\r\nFixture line 090: preserve neutral bytes.\r\nFixture line 091: preserve neutral bytes.\r\nFixture line 092: preserve neutral bytes.\r\nFixture line 093: preserve neutral bytes.\r\nFixture line 094: preserve neutral bytes.\r\nFixture line 095: preserve neutral bytes.\r\nFixture line 096: preserve neutral bytes.\r\nFixture line 097: preserve neutral bytes.\r\nFixture line 098: preserve neutral bytes.\r\nFixture line 099: preserve neutral bytes.\r\nFixture line 100: preserve neutral bytes.\r\nFixture line 101: preserve neutral bytes.\r\nFixture line 102: preserve neutral bytes.\r\nFixture line 103: preserve neutral bytes.\r\nFixture line 104: preserve neutral bytes.\r\nFixture line 105: preserve neutral bytes.\r\nFixture line 106: preserve neutral bytes.\r\nFixture line 107: preserve neutral bytes.\r\nFixture line 108: preserve neutral bytes.\r\nFixture line 109: preserve neutral bytes.\r\nFixture line 110: preserve neutral bytes.\r\nFixture line 111: preserve neutral bytes.\r\nFixture line 112: preserve neutral bytes.\r\nFixture line 113: preserve neutral bytes.\r\nFixture line 114: preserve neutral bytes.\r\nFixture line 115: preserve neutral bytes.\r\nFixture line 116: preserve neutral bytes.\r\nFixture line 117: preserve neutral bytes.\r\nFixture line 118: preserve neutral bytes.\r\nFixture line 119: preserve neutral bytes.\r\nFixture line 120: preserve neutral bytes.\r\nFixture line 121: preserve neutral bytes.\r\nFixture line 122: preserve neutral bytes.\r\nFixture line 123: preserve neutral bytes.\r\nFixture line 124: preserve neutral bytes.\r\nFixture line 125: preserve neutral bytes.\r\nFixture line 126: preserve neutral bytes.\r\nFixture line 127: preserve neutral bytes.\r\nFixture line 128: preserve neutral bytes.\r\nFixture line 129: preserve neutral bytes.\r\nFixture line 130: preserve neutral bytes.\r\nFixture line 131: preserve neutral bytes.\r\nFixture line 132: preserve neutral bytes.\r\nFixture line 133: preserve neutral bytes.\r\nFixture line 134: preserve neutral bytes.\r\nFixture line 135: preserve neutral bytes.\r\nFixture line 136: preserve neutral bytes.\r\nFixture line 137: preserve neutral bytes.\r\nFixture line 138: preserve neutral bytes.\r\nFixture line 139: preserve neutral bytes.\r\nFixture line 140: preserve neutral bytes.\r\nFixture line 141: preserve neutral bytes.\r\nFixture line 142: preserve neutral bytes.\r\nFixture line 143: preserve neutral bytes.\r\nFixture line 144: preserve neutral bytes.\r\nFixture line 145: preserve neutral bytes.\r\nFixture line 146: preserve neutral bytes.\r\nFixture line 147: preserve neutral bytes.\r\nFixture line 148: preserve neutral bytes.\r\nFixture line 149: preserve neutral bytes.\r\nFixture line 150: preserve neutral bytes.\r\nFixture line 151: preserve neutral bytes.\r\nFixture line 152: preserve neutral bytes.\r\nFixture line 153: preserve neutral bytes.\r\nFixture line 154: preserve neutral bytes.\r\nFixture line 155: preserve neutral bytes.\r\nFixture line 156: preserve neutral bytes.\r\nFixture line 157: preserve neutral bytes.\r\nFixture line 158: preserve neutral bytes.\r\nFixture line 159: preserve neutral bytes.\r\nFixture line 160: preserve neutral bytes.\r\nFixture line 161: preserve neutral bytes.\r\nFixture line 162: preserve neutral bytes.\r\nFixture line 163: preserve neutral bytes.\r\nFixture line 164: preserve neutral bytes.\r\nFixture line 165: preserve neutral bytes.\r\nFixture line 166: preserve neutral bytes.\r\nFixture line 167: preserve neutral bytes.\r\nFixture line 168: preserve neutral bytes.\r\nFixture line 169: preserve neutral bytes.\r\nFixture line 170: preserve neutral bytes.\r\nFixture line 171: preserve neutral bytes.\r\nFixture line 172: preserve neutral bytes.\r\nFixture line 173: preserve neutral bytes.\r\nFixture line 174: preserve neutral bytes.\r\nFixture line 175: preserve neutral bytes.\r\nFixture line 176: preserve neutral bytes.\r\nFixture line 177: preserve neutral bytes.\r\nFixture line 178: preserve neutral bytes.\r\nFixture line 179: preserve neutral bytes.\r\nFixture line 180: preserve neutral bytes.\r\nFixture line 181: preserve neutral bytes.\r\nFixture line 182: preserve neutral bytes.\r\nFixture line 183: preserve neutral bytes.\r\nFixture line 184: preserve neutral bytes.\r\nFixture line 185: preserve neutral bytes.\r\nFixture line 186: preserve neutral bytes.\r\nFixture line 187: preserve neutral bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            \r\n", 'utf8');
const EXAMPLE_SHA256 = '3abc261bfa589a281c261d8ed7b8d181fccad6a468577c1782d84a728c1dab44';
const EXAMPLE_RAW_OID = '5f8e397ef754dfd140294e00632ce481b39f3270';
const EXAMPLE_FILTERED_OID = '7567cfe55d3627b82b44649851087d5a697848df';

function fixedExampleRuntimeArtifact() {
  return {
    id: 'skills.example-runtime', kind: 'skill', ownership: 'shared-link',
    platforms: ['windows', 'macos'], providers: ['claude', 'codex'], risk: 'control-confirm',
    source: ['skills/example-runtime'],
    targets: { claude: '${USER_HOME}/.claude/skills/example-runtime', codex: '${USER_HOME}/.agents/skills/example-runtime' },
    validators: ['skill', 'no-secrets', 'no-machine-paths'],
    allowedInitialFiles: ['SKILL.md', 'agents/**', 'assets/**', 'references/**'],
    deniedFiles: ['scripts/**'], namespaceId: 'portable-skill', creation: true, adoption: true,
  };
}

async function makeRepairFixture() {
  return makeFixture({ setup: async ({ repo }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'controller.runtime-v0.1.0', kind: 'controller-runtime', ownership: 'shared-generated',
      outputs: { state: 'dist/controller/v0.1.0' }, platforms: ['windows', 'macos'], providers: [],
      risk: 'control-confirm', source: ['lib', 'scripts/agent-config-controller.mjs', 'scripts/agent-config.mjs', 'package.json'],
      targets: { state: '${AGENT_CONFIG_STATE_ROOT}/controller/v0.1.0' },
      validators: ['no-secrets', 'no-machine-paths'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
}

async function seedFailedExampleRuntimeAdoption(fixture) {
  const codex = path.join(fixture.userHome, '.agents', 'skills', 'example-runtime');
  const claude = path.join(fixture.userHome, '.claude', 'skills', 'example-runtime');
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(codex, 'SKILL.md'), EXAMPLE_BYTES);
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink(codex, claude, process.platform === 'win32' ? 'junction' : 'dir');
  const codexOriginal = await describePath(codex);
  const claudeOriginal = await describePath(claude);
  assert.equal(codexOriginal.hash, 'bdc3c8d9d6c4b86d999c71d5abfc5768c4006fed9142e409c4d284f4aa3143b5');

  const backupId = '2026-09-01T01-49-12-236Z-3a686d06';
  const backup = await createBackup(fixture.state, [codex, claude], fixture.roots, { id: backupId });
  const releaseId = 'failed-example-runtime-release';
  const releaseRoot = path.join(fixture.state, 'releases', releaseId);
  const releaseExampleRuntime = path.join(releaseRoot, 'source', 'skills', 'example-runtime');
  await mkdir(releaseExampleRuntime, { recursive: true });
  await writeFile(path.join(releaseExampleRuntime, 'SKILL.md'), EXAMPLE_BYTES.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
  await mkdir(path.join(releaseRoot, 'dist'), { recursive: true });
  await symlink(releaseRoot, path.join(fixture.state, 'active'), process.platform === 'win32' ? 'junction' : 'dir');

  const providerPreimages = [
    { provider: 'claude', target: claude, descriptor: claudeOriginal },
    { provider: 'codex', target: codex, descriptor: codexOriginal },
  ];
  const adoption = {
    mode: 'portable-skill-existing-install', artifactId: 'skills.example-runtime',
    canonicalSource: { path: 'skills/example-runtime', preimage: { type: 'absent', size: 0, hash: null, linkTarget: null }, postimage: codexOriginal },
    providerPreimages, topology: { codex: 'regular-directory', claude: 'link-to-codex' },
    cutover: { writer: 'agent-config-apply', backupBeforeMutation: true, providerOwnershipAfter: 'normal-apply-release-only' },
    rollback: { mechanism: 'controller-backup', restore: 'exact-preimages', conflicts: 'fail-loudly' },
    recovery: { mechanism: 'controller-recover', requiresExactPlanId: true },
  };
  const linkTarget = path.join(fixture.state, 'active', 'source', 'skills', 'example-runtime');
  const plan = withContentId({
    schemaVersion: 1, toolVersion: '0.1.0', createdAt: '2026-09-01T01:48:34.000Z',
    source: { root: 'failed-worktree', canonicalRoot: fixture.repo, commit: 'a'.repeat(40), tree: 'b'.repeat(40), treeDigest: 'c'.repeat(64), branch: null, clean: true, deploymentBranch: 'main', deploymentBase: 'd'.repeat(40) },
    platform: fixture.roots.PLATFORM, policyDigest: 'sha256:' + 'e'.repeat(64), risk: 'control-confirm',
    authorization: { provider: 'codex', originAssurance: 'provider-context', scope: 'local-only' },
    artifacts: ['skills.example-runtime'],
    operations: [
      { index: 0, type: 'ensure-link', artifactId: 'skills.example-runtime', provider: 'claude', target: claude, preimage: claudeOriginal, postimage: { type: 'link', hash: null, linkTarget, source: 'skills/example-runtime' } },
      { index: 1, type: 'quarantine-known-directory', artifactId: 'skills.example-runtime', provider: 'codex', target: codex, preimage: codexOriginal, postimage: { type: 'absent', hash: null, linkTarget: null }, quarantineRelative: 'quarantine/0001' },
      { index: 2, type: 'ensure-link', artifactId: 'skills.example-runtime', provider: 'codex', target: codex, preimage: { type: 'absent', size: 0, hash: null, linkTarget: null }, postimage: { type: 'link', hash: null, linkTarget, source: 'skills/example-runtime' } },
    ],
    backupScope: [codex, claude].sort(),
    release: { releaseId, sourceTreeDigest: 'f'.repeat(64), generatedDigest: '1'.repeat(64), snapshotPath: releaseRoot },
    receipts: [], confirmation: { required: true, reason: 'control-confirm' }, adoption,
  });
  const storedPlanPath = path.join(fixture.state, 'plans', plan.planId.replace(':', '-') + '.json');
  await writeFile(storedPlanPath, canonicalize(plan), 'utf8');

  await rm(claude);
  await rm(codex, { recursive: true });
  await symlink(linkTarget, claude, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(linkTarget, codex, process.platform === 'win32' ? 'junction' : 'dir');
  const managedClaude = await describePath(claude);
  const managedCodex = await describePath(codex);
  const operationId = 'failed-operation';
  for (const phase of ['started', 'candidate-preflight-passed', 'backup-complete', 'activation-barrier-entered', 'active-switched']) {
    await appendJournal(fixture.state, operationId, { phase });
  }
  for (let index = 0; index < 3; index += 1) await appendJournal(fixture.state, operationId, { phase: 'target-mutated', operationIndex: index });
  await appendJournal(fixture.state, operationId, { phase: 'apply-complete' });

  const failedTransactionId = 'be637917-871e-4e6d-ab83-6301ec282758';
  const failedRoot = path.join(fixture.state, 'transactions', failedTransactionId);
  await mkdir(failedRoot, { recursive: true });
  await writeFile(path.join(failedRoot, 'transaction.json'), JSON.stringify({
    schemaVersion: 1, transactionId: failedTransactionId, phase: 'verified-provisional',
    artifact: fixedExampleRuntimeArtifact(), adoption, planPath: storedPlanPath,
    release: { releaseId, backupId },
  }, null, 2) + '\n', 'utf8');
  await writeFile(path.join(fixture.state, 'installs', 'current.json'), JSON.stringify({
    schemaVersion: 1, status: 'verified-provisional', operationId, releaseId, releaseRoot,
    planId: plan.planId, planPath: storedPlanPath, backupId,
    activeArtifacts: ['controller.runtime-v0.1.0', 'skills.example-runtime'],
    targets: [
      { target: claude, operationType: 'ensure-link', preimage: claudeOriginal, postimage: managedClaude },
      { target: codex, operationType: 'ensure-link', preimage: codexOriginal, postimage: managedCodex },
    ],
  }, null, 2) + '\n', 'utf8');
  const runtimeTarget = path.join(fixture.state, 'controller', 'v0.1.0');
  await mkdir(runtimeTarget, { recursive: true });
  await writeFile(path.join(runtimeTarget, 'old.txt'), 'old runtime\n', 'utf8');

  return {
    codex, claude, runtimeTarget, backup, backupId, failedTransactionId, failedRoot, storedPlanPath,
    expectedPlanId: plan.planId, expectedOriginalDirectoryHash: codexOriginal.hash,
    operationId, releaseRoot, linkTarget,
  };
}

function forwardRepairChange(binding, overrides = {}) {
  return {
    op: 'forward-repair-adoption', artifact: 'skills.example-runtime',
    failedTransactionId: binding.failedTransactionId,
    expectedPlanId: binding.expectedPlanId,
    expectedBackupId: binding.backupId,
    expectedOriginalDirectoryHash: binding.expectedOriginalDirectoryHash,
    ...overrides,
  };
}

async function installPortableSkill(fixture, { claudeTarget = null, extra = null, skillId = 'adopted', skillBytes = SKILL } = {}) {
  const codex = path.join(fixture.userHome, '.agents', 'skills', skillId);
  const claude = path.join(fixture.userHome, '.claude', 'skills', skillId);
  await mkdir(codex, { recursive: true });
  await writeFile(path.join(codex, 'SKILL.md'), skillBytes);
  if (extra) {
    const target = path.join(codex, extra.path);
    await mkdir(path.dirname(target), { recursive: true });
    if (extra.type === 'link') await symlink(extra.target, target, process.platform === 'win32' ? 'junction' : 'dir');
    else await writeFile(target, extra.content ?? 'fixture\n', 'utf8');
  }
  await mkdir(path.dirname(claude), { recursive: true });
  await symlink(claudeTarget ?? codex, claude, process.platform === 'win32' ? 'junction' : 'dir');
  return { codex, claude };
}

test('ordinary creation refuses an occupied provider target', async () => {
  const fixture = await makeFixture();
  try {
    await installPortableSkill(fixture);
    await assert.rejects(
      () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Create adopted.', allowCreation: true, roots: fixture.roots }),
      (error) => error.code === 'CREATION_TARGET_EXISTS',
    );
  } finally { await fixture.cleanup(); }
});

test('explicit adoption imports exact bytes, binds the immutable cutover, and rollback restores topology', async () => {
  const fixture = await makeFixture();
  try {
    const installed = await installPortableSkill(fixture);
    const original = await describePath(installed.codex);
    const originalManifest = await readFile(path.join(fixture.repo, 'manifest.json'), 'utf8');
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt the existing portable adopted skill.', adoptExisting: true, roots: fixture.roots });
    assert.equal(begun.artifact.risk, 'control-confirm');
    assert.equal(begun.adoption.canonicalSource.postimage.hash, original.hash);
    assert.deepEqual(begun.adoption.topology, { codex: 'regular-directory', claude: 'link-to-codex' });

    const source = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/adopted/SKILL.md' });
    assert.equal(source.content, SKILL);
    const manifestRead = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'manifest.json' });
    const manifest = JSON.parse(manifestRead.content);
    assert.ok(manifestRead.content.length - originalManifest.length < 2_000, 'adoption must append one entry without reformatting the manifest');
    const entry = manifest.artifacts.find((artifact) => artifact.id === 'skills.adopted');
    assert.equal(entry.risk, 'content-auto');
    assert.equal(Object.hasOwn(entry, 'adoption'), false);
    await assert.rejects(
      () => patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: source.path, expectedHash: source.hash, content: `${source.content}\nchanged` }] }),
      (error) => error.code === 'ADOPTION_PATCH_DENIED',
    );

    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.risk, 'control-confirm');
    const gated = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(gated.phase, 'awaiting-confirmation');
    assert.equal(gated.blocker, 'control-confirm');
    const record = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const plan = await readJson(record.planPath);
    assert.equal(plan.adoption.canonicalSource.postimage.hash, original.hash);
    assert.equal(plan.adoption.cutover.backupBeforeMutation, true);
    assert.deepEqual(plan.backupScope.sort(), [installed.claude, installed.codex].sort());
    assert.equal(plan.operations.some((operation) => operation.provider === 'codex' && operation.type === 'quarantine-known-directory' && operation.preimage.hash === original.hash), true);
    assert.equal(plan.operations.some((operation) => operation.provider === 'claude' && operation.preimage.type === 'link'), true);

    const applied = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: gated.planId, roots: fixture.roots });
    assert.equal(applied.phase, 'verified-provisional');
    assert.equal((await lstat(installed.codex)).isSymbolicLink(), true);
    assert.equal((await lstat(installed.claude)).isSymbolicLink(), true);
    assert.equal(await readFile(path.join(installed.codex, 'SKILL.md'), 'utf8'), SKILL);

    const backup = await readJson(path.join(fixture.state, 'backups', applied.release.backupId, 'backup-manifest.json'));
    assert.equal(backup.entries.find((item) => item.target === installed.codex).descriptor.hash, original.hash);
    assert.equal(backup.entries.find((item) => item.target === installed.claude).descriptor.type, 'link');
    const rolledBack = await rollbackBackup({ backupId: applied.release.backupId, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal((await lstat(installed.codex)).isDirectory(), true);
    assert.equal((await lstat(installed.codex)).isSymbolicLink(), false);
    assert.equal(path.resolve(path.dirname(installed.claude), await readlink(installed.claude)), path.resolve(installed.codex));
    assert.equal(await readFile(path.join(installed.codex, 'SKILL.md'), 'utf8'), SKILL);
  } finally { await fixture.cleanup(); }
});

test('adoption rejects missing, mismatched, nested-link, and script topology', async (t) => {
  await t.test('missing target', async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots }),
        (error) => error.code === 'ADOPTION_CODEX_DIRECTORY_REQUIRED',
      );
    } finally { await fixture.cleanup(); }
  });
  await t.test('Claude link points elsewhere with different bytes', async () => {
    const fixture = await makeFixture();
    try {
      const other = path.join(fixture.userHome, '.agents', 'skills', 'other');
      await mkdir(other, { recursive: true });
      await writeFile(path.join(other, 'SKILL.md'), 'different', 'utf8');
      await installPortableSkill(fixture, { claudeTarget: other });
      await assert.rejects(
        () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots }),
        (error) => error.code === 'ADOPTION_LINK_TARGET_MISMATCH',
      );
    } finally { await fixture.cleanup(); }
  });
  await t.test('nested link', async () => {
    const fixture = await makeFixture();
    try {
      const linked = path.join(fixture.userHome, 'linked-assets');
      await mkdir(linked, { recursive: true });
      await installPortableSkill(fixture, { extra: { path: 'assets/linked', type: 'link', target: linked } });
      await assert.rejects(
        () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots }),
        (error) => error.code === 'ADOPTION_NESTED_LINK_DENIED',
      );
    } finally { await fixture.cleanup(); }
  });
  await t.test('script', async () => {
    const fixture = await makeFixture();
    try {
      await installPortableSkill(fixture, { extra: { path: 'scripts/run.mjs' } });
      await assert.rejects(
        () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots }),
        (error) => error.code === 'ADOPTION_FILE_DENIED',
      );
    } finally { await fixture.cleanup(); }
  });
});

test('adoption refuses outside-root targets and provider drift before planning', async (t) => {
  await t.test('outside root', async () => {
    const fixture = await makeFixture({ setup: async ({ repo }) => {
      const manifestPath = path.join(repo, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.namespaces[0].targets.codex = '${PROJECTS_ROOT}/outside/<skill-id>';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } });
    try {
      await assert.rejects(
        () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots }),
        (error) => error.code === 'TARGET_ROOT_DENIED',
      );
    } finally { await fixture.cleanup(); }
  });
  await t.test('drift after transaction begin', async () => {
    const fixture = await makeFixture();
    try {
      const installed = await installPortableSkill(fixture);
      const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'adopted', provider: 'codex', request: 'Adopt.', adoptExisting: true, roots: fixture.roots });
      await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
      await writeFile(path.join(installed.codex, 'SKILL.md'), `${SKILL}\ndrift`, 'utf8');
      await assert.rejects(
        () => promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots }),
        (error) => error.code === 'ADOPTION_PREIMAGE_DRIFT',
      );
      assert.equal(await pathExists(installed.codex), true);
    } finally { await fixture.cleanup(); }
  });
});

test('ordinary CRLF adoption fails at the committed materialized-source gate', async () => {
  const fixture = await makeFixture();
  try {
    const installed = await installPortableSkill(fixture, { skillId: 'example-runtime', skillBytes: EXAMPLE_BYTES });
    assert.equal((EXAMPLE_BYTES.toString('binary').match(/\r\n/g) ?? []).length, 195);
    const sourcePath = path.join(installed.codex, 'SKILL.md');
    const expectedDescriptor = await describePath(installed.codex);
    const normalizedDirectory = path.join(fixture.userHome, 'normalized-example-runtime');
    await mkdir(normalizedDirectory, { recursive: true });
    await writeFile(path.join(normalizedDirectory, 'SKILL.md'), EXAMPLE_BYTES.toString('utf8').replaceAll('\r\n', '\n'), 'utf8');
    const actualDescriptor = await describePath(normalizedDirectory);
    assert.equal(runGit(fixture.repo, ['hash-object', '--no-filters', sourcePath]).trim(), EXAMPLE_RAW_OID);
    assert.equal(runGit(fixture.repo, ['hash-object', '--path=skills/example-runtime/SKILL.md', sourcePath]).trim(), EXAMPLE_FILTERED_OID);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'example-runtime', provider: 'codex', request: 'Adopt CRLF fixture.', adoptExisting: true, roots: fixture.roots });
    await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    let rejection;
    await assert.rejects(
      () => promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots }),
      (error) => {
        rejection = error;
        return error.code === 'ADOPTION_MATERIALIZED_SOURCE_MISMATCH';
      },
    );
    assert.deepEqual(rejection.details.expected, expectedDescriptor);
    assert.deepEqual(rejection.details.actual, actualDescriptor);
    const stopped = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    assert.equal(stopped.planPath, null);
    assert.equal(sha256(await readFile(sourcePath)), EXAMPLE_SHA256);
  } finally { await fixture.cleanup(); }
});

test('forward adoption repair rejects every wrong incident binding without live effects', async (t) => {
  const cases = [
    ['transaction', 'TRANSACTION_NOT_FOUND', async () => ({ failedTransactionId: '00000000-0000-0000-0000-000000000000' })],
    ['plan', 'FORWARD_REPAIR_CURRENT_MISMATCH', async () => ({ expectedPlanId: `sha256:${'0'.repeat(64)}` })],
    ['backup', 'FORWARD_REPAIR_CURRENT_MISMATCH', async () => ({ expectedBackupId: 'wrong-backup' })],
    ['original hash', 'FORWARD_REPAIR_PLAN_MISMATCH', async () => ({ expectedOriginalDirectoryHash: '0'.repeat(64) })],
    ['current install', 'FORWARD_REPAIR_CURRENT_MISMATCH', async (fixture) => {
      const currentPath = path.join(fixture.state, 'installs', 'current.json');
      const current = await readJson(currentPath);
      current.status = 'active-reconciled';
      await writeFile(currentPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      return {};
    }],
    ['provider topology', 'FORWARD_REPAIR_PROVIDER_TOPOLOGY', async (_fixture, binding) => {
      await rm(binding.codex);
      await mkdir(binding.codex, { recursive: true });
      await writeFile(path.join(binding.codex, 'SKILL.md'), EXAMPLE_BYTES);
      return {};
    }],
    ['backup manifest', 'BACKUP_MANIFEST_TAMPERED', async (_fixture, binding) => {
      const manifestPath = path.join(binding.backup.root, 'backup-manifest.json');
      const manifest = await readJson(manifestPath);
      manifest.createdAt = 'tampered';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return {};
    }],
    ['backup data', 'BACKUP_VERIFY_FAILED', async (_fixture, binding) => {
      await writeFile(path.join(binding.backup.root, 'data', '0000', 'SKILL.md'), Buffer.concat([EXAMPLE_BYTES, Buffer.from('drift')]));
      return {};
    }],
  ];
  for (const [name, expectedCode, mutate] of cases) await t.test(name, async () => {
    const fixture = await makeRepairFixture();
    try {
      const binding = await seedFailedExampleRuntimeAdoption(fixture);
      const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'controller.runtime-v0.1.0', provider: 'codex', request: 'Repair the failed ExampleRuntime adoption atomically with the controller runtime.', roots: fixture.roots });
      const { policy } = await loadConfiguration(fixture.repo);
      const overrides = await mutate(fixture, binding);
      const before = {
        current: await readFile(path.join(fixture.state, 'installs', 'current.json'), 'utf8'),
        active: await describePath(path.join(fixture.state, 'active')),
        failedTransaction: await readFile(path.join(binding.failedRoot, 'transaction.json'), 'utf8'),
        storedPlan: await readFile(binding.storedPlanPath, 'utf8'),
        journal: await readFile(path.join(fixture.state, 'installs', 'journal', `${binding.operationId}.jsonl`), 'utf8'),
        backupManifest: await readFile(path.join(binding.backup.root, 'backup-manifest.json'), 'utf8'),
        backupData: await describePath(path.join(binding.backup.root, 'data', '0000')),
        worktree: await describePath(path.join(fixture.state, 'transactions', begun.transactionId, 'worktree')),
        codex: await describePath(binding.codex),
        claude: await describePath(binding.claude),
        runtime: await describePath(binding.runtimeTarget),
      };
      await assert.rejects(() => patchTransaction({
        stateRoot: fixture.state, transactionId: begun.transactionId, policy,
        changes: [forwardRepairChange(binding, overrides)],
      }), (error) => error.code === expectedCode);
      assert.equal(await readFile(path.join(fixture.state, 'installs', 'current.json'), 'utf8'), before.current);
      assert.deepEqual(await describePath(path.join(fixture.state, 'active')), before.active);
      assert.equal(await readFile(path.join(binding.failedRoot, 'transaction.json'), 'utf8'), before.failedTransaction);
      assert.equal(await readFile(binding.storedPlanPath, 'utf8'), before.storedPlan);
      assert.equal(await readFile(path.join(fixture.state, 'installs', 'journal', `${binding.operationId}.jsonl`), 'utf8'), before.journal);
      assert.equal(await readFile(path.join(binding.backup.root, 'backup-manifest.json'), 'utf8'), before.backupManifest);
      assert.deepEqual(await describePath(path.join(binding.backup.root, 'data', '0000')), before.backupData);
      assert.deepEqual(await describePath(path.join(fixture.state, 'transactions', begun.transactionId, 'worktree')), before.worktree);
      assert.deepEqual(await describePath(binding.codex), before.codex);
      assert.deepEqual(await describePath(binding.claude), before.claude);
      assert.deepEqual(await describePath(binding.runtimeTarget), before.runtime);
    } finally { await fixture.cleanup(); }
  });
});

test('forward adoption repair preserves exact ExampleRuntime bytes and installs the runtime pair atomically', async () => {
  const fixture = await makeRepairFixture();
  try {
    const binding = await seedFailedExampleRuntimeAdoption(fixture);
    const runtimePreimage = await describePath(binding.runtimeTarget);
    const claudePreimage = await describePath(binding.claude);
    const codexPreimage = await describePath(binding.codex);
    const failedSource = path.join(binding.backup.root, 'data', '0000', 'SKILL.md');
    assert.equal((EXAMPLE_BYTES.toString('binary').match(/\r\n/g) ?? []).length, 195);
    assert.equal(EXAMPLE_BYTES.length, 10_748);
    assert.equal(sha256(EXAMPLE_BYTES), EXAMPLE_SHA256);
    assert.equal(runGit(fixture.repo, ['hash-object', '--no-filters', failedSource]).trim(), EXAMPLE_RAW_OID);
    assert.equal(runGit(fixture.repo, ['hash-object', '--path=skills/example-runtime/SKILL.md', failedSource]).trim(), EXAMPLE_FILTERED_OID);

    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'controller.runtime-v0.1.0', provider: 'codex', request: 'Repair the failed ExampleRuntime adoption atomically with the controller runtime.', roots: fixture.roots });
    const { policy } = await loadConfiguration(fixture.repo);
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [forwardRepairChange(binding)] });
    const patched = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const attributes = await readFile(path.join(patched.adoption.canonicalSource.path === 'skills/example-runtime' ? path.join(fixture.state, 'transactions', begun.transactionId, 'worktree') : '', '.gitattributes'), 'utf8');
    assert.equal(attributes.split(/\r?\n/).filter((line) => line === 'skills/example-runtime/** -text').length, 1);
    const worktree = path.join(fixture.state, 'transactions', begun.transactionId, 'worktree');
    const worktreeSkill = path.join(worktree, 'skills', 'example-runtime', 'SKILL.md');
    assert.equal(runGit(worktree, ['hash-object', '--path=skills/example-runtime/SKILL.md', worktreeSkill]).trim(), EXAMPLE_RAW_OID);

    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.passed, true);
    const gated = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(gated.phase, 'awaiting-confirmation');
    const plannedRecord = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const plan = await readJson(plannedRecord.planPath);
    assert.deepEqual(plan.artifacts, ['controller.runtime-v0.1.0', 'skills.example-runtime']);
    assert.equal(plan.operations.length, 3);
    assert.deepEqual(plan.operations[0], {
      index: 0, type: 'replace-directory', artifactId: 'controller.runtime-v0.1.0', provider: 'state',
      target: binding.runtimeTarget, preimage: runtimePreimage,
      postimage: { type: 'directory', hash: plan.operations[0].postimage.hash, linkTarget: null, source: 'dist/controller/v0.1.0' },
    });
    assert.match(plan.operations[0].postimage.hash, /^[a-f0-9]{64}$/);
    const expectedLinkPostimage = { type: 'link', hash: null, linkTarget: binding.linkTarget, source: 'skills/example-runtime' };
    assert.deepEqual(plan.operations[1], {
      index: 1, type: 'ensure-link', artifactId: 'skills.example-runtime', provider: 'claude',
      target: binding.claude, preimage: claudePreimage, postimage: expectedLinkPostimage,
    });
    assert.deepEqual(plan.operations[2], {
      index: 2, type: 'ensure-link', artifactId: 'skills.example-runtime', provider: 'codex',
      target: binding.codex, preimage: codexPreimage, postimage: expectedLinkPostimage,
    });
    assert.deepEqual(plan.backupScope, [binding.runtimeTarget, binding.claude, binding.codex].sort());
    assert.equal(runGit(worktree, ['rev-parse', 'HEAD:skills/example-runtime/SKILL.md']).trim(), EXAMPLE_RAW_OID);
    assert.equal(Number(runGit(worktree, ['cat-file', '-s', EXAMPLE_RAW_OID]).trim()), 10_748);
    assert.equal(runGit(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim(), '');

    const applied = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: gated.planId, roots: fixture.roots });
    assert.equal(applied.phase, 'verified-provisional');
    const current = await readJson(path.join(fixture.state, 'installs', 'current.json'));
    const journal = await readJournal(path.join(fixture.state, 'installs', 'journal', `${current.operationId}.jsonl`));
    const backupIndex = journal.findIndex((entry) => entry.phase === 'backup-complete');
    const switchIndex = journal.findIndex((entry) => entry.phase === 'active-switched');
    assert.ok(backupIndex >= 0 && backupIndex < switchIndex);
    assert.equal(journal.filter((entry) => entry.phase === 'backup-complete').length, 1);
    assert.equal(journal.filter((entry) => entry.phase === 'active-switched').length, 1);
    assert.deepEqual(journal.filter((entry) => entry.phase === 'target-mutated').map((entry) => entry.operationIndex), [0, 1, 2]);
    assert.equal(journal.filter((entry) => entry.phase === 'apply-complete').length, 1);
    assert.equal(journal.at(-1).phase, 'apply-complete');
    assert.equal(journal.some((entry) => String(entry.phase).includes('rollback') || String(entry.phase).includes('recover')), false);
    assert.equal(current.status, 'verified-provisional');
    assert.equal(current.targets.length, 3);
    assert.deepEqual(current.targets.map((target) => [target.target, target.operationType]), [
      [binding.runtimeTarget, 'replace-directory'],
      [binding.claude, 'ensure-link'],
      [binding.codex, 'ensure-link'],
    ]);
    assert.equal(sha256(await readFile(path.join(current.releaseRoot, 'source', 'skills', 'example-runtime', 'SKILL.md'))), EXAMPLE_SHA256);
    assert.equal(sha256(await readFile(path.join(binding.codex, 'SKILL.md'))), EXAMPLE_SHA256);
    assert.equal(sha256(await readFile(path.join(binding.claude, 'SKILL.md'))), EXAMPLE_SHA256);

    const runtimeOperation = plan.operations.find((operation) => operation.artifactId === 'controller.runtime-v0.1.0');
    const releaseRuntime = await describePath(path.join(current.releaseRoot, runtimeOperation.postimage.source));
    assert.deepEqual(runtimeOperation.postimage, { type: 'directory', hash: releaseRuntime.hash, linkTarget: null, source: 'dist/controller/v0.1.0' });
    assert.equal((await describePath(binding.runtimeTarget)).hash, releaseRuntime.hash);
    for (const relative of ['lib/controller.mjs', 'lib/manifest.mjs', 'lib/planner.mjs', 'lib/transaction.mjs']) {
      assert.deepEqual(await readFile(path.join(binding.runtimeTarget, relative)), await readFile(path.join(current.releaseRoot, runtimeOperation.postimage.source, relative)));
    }

    assert.equal((await checkInstalled({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots })).ok, true);
    assert.equal((await check({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots })).ok, true);
    assert.equal((await doctor({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots })).ok, true);
    const reconciled = await reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId });
    assert.equal(reconciled.phase, 'reconciled');
    assert.equal(runGit(fixture.repo, ['status', '--porcelain=v1', '--untracked-files=all']).trim(), '');
    assert.equal(runGit(fixture.repo, ['rev-parse', 'HEAD:skills/example-runtime/SKILL.md']).trim(), EXAMPLE_RAW_OID);
  } finally { await fixture.cleanup(); }
});

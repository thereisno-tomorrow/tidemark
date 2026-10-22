import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { rollbackBackup } from '../../lib/apply.mjs';
import { sha256 } from '../../lib/canonical-json.mjs';
import { runGit } from '../../lib/git.mjs';
import { loadConfiguration } from '../../lib/manifest.mjs';
import { describePath, pathExists, readJson } from '../../lib/fs-safe.mjs';
import { addSkill, makeFixture } from '../helpers.mjs';
import { beginTransaction, patchTransaction, promoteTransaction, readTransactionPath, reconcileTransaction, testTransaction, transactionStatus } from '../../lib/transaction.mjs';

// A carrier with no targets yet: each retirement test declares into it, or deliberately
// does not, to exercise the guard.
function withEmptyCarrier(manifest) {
  manifest.artifacts.push({
    id: 'legacy.fixture-retirement', kind: 'legacy-retirement', ownership: 'provider-only',
    platforms: ['windows', 'macos'], providers: ['claude', 'codex'], risk: 'control-confirm',
    source: ['migration-fixture.json'], legacyTargets: [],
    validators: ['known-preimage-only'],
  });
  return manifest;
}

async function retirementFixture({ skills = ['demo'] } = {}) {
  return makeFixture({ setup: async ({ repo }) => {
    for (const skill of skills) await addSkill(repo, skill);
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = withEmptyCarrier(JSON.parse(await readFile(manifestPath, 'utf8')));
    await writeFile(path.join(repo, 'migration-fixture.json'), '{"fixture":true}\n', 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
}

const DEMO_TARGETS = [
  { provider: 'claude', path: '${USER_HOME}/.claude/skills/demo' },
  { provider: 'codex', path: '${USER_HOME}/.agents/skills/demo' },
];

async function declareRetirement(fixture, transactionId, policy, { targets = DEMO_TARGETS, removeSource = true } = {}) {
  const changes = [];
  if (removeSource) {
    const skill = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/demo/SKILL.md' });
    changes.push({ op: 'delete', path: skill.path, expectedHash: skill.hash });
  }
  const manifest = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'manifest.json' });
  const parsed = JSON.parse(manifest.content);
  parsed.artifacts.find((item) => item.id === 'legacy.fixture-retirement').legacyTargets = targets;
  changes.push({ op: 'replace', path: manifest.path, expectedHash: manifest.hash, content: `${JSON.stringify(parsed, null, 2)}\n` });
  await patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes });
}

const BATCH_TARGETS = [
  ...DEMO_TARGETS,
  { provider: 'claude', path: '${USER_HOME}/.claude/skills/second' },
  { provider: 'codex', path: '${USER_HOME}/.agents/skills/second' },
];

async function declareBatchRetirement(fixture, transactionId, policy) {
  const changes = [];
  for (const skillId of ['demo', 'second']) {
    const skill = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: `skills/${skillId}/SKILL.md` });
    changes.push({ op: 'delete', path: skill.path, expectedHash: skill.hash });
  }
  const manifest = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'manifest.json' });
  const parsed = JSON.parse(manifest.content);
  parsed.artifacts.find((item) => item.id === 'legacy.fixture-retirement').legacyTargets = BATCH_TARGETS;
  changes.push({ op: 'replace', path: manifest.path, expectedHash: manifest.hash, content: `${JSON.stringify(parsed, null, 2)}\n` });
  await patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes });
}

test('file-backed artifact begins a transaction without scanning the file as a directory', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'provider.codex-config', kind: 'provider-config', ownership: 'shared-generated',
      outputs: { codex: 'dist/codex/config.toml' }, platforms: ['windows', 'macos'],
      providers: ['codex'], risk: 'control-confirm', source: ['mcp/servers.json'],
      targets: { codex: '${USER_HOME}/.codex/config.toml' }, validators: ['json', 'no-secrets'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
  try {
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'provider.codex-config', provider: 'codex', request: 'Update the MCP registry.', roots: fixture.roots });
    assert.deepEqual(begun.allowedPaths, ['mcp/servers.json']);
  } finally { await fixture.cleanup(); }
});

test('provider-context transaction patches only an allowed file and stops at exact promotion confirmation', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'demo', provider: 'codex', request: 'Update demo wording.', roots: fixture.roots });
    assert.equal(begun.originAssurance, 'provider-context');
    const current = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/demo/SKILL.md' });
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: current.path, expectedHash: current.hash, content: current.content.replace('Original body.', 'Updated body.') }] });
    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.passed, true);
    const promoted = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(promoted.phase, 'awaiting-confirmation');
    assert.equal(promoted.blocker, 'provider-context');
    assert.equal(await pathExists(path.join(fixture.userHome, '.agents', 'skills', 'demo')), false);
  } finally { await fixture.cleanup(); }
});

test('control-confirm transaction installs only after its exact plan is confirmed', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    await addSkill(repo, 'demo');
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'skills.demo', kind: 'skill', ownership: 'provider-only',
      providerOnlyReason: 'Fixture exercises exact confirmation for a provider-only skill.',
      platforms: ['windows', 'macos'], providers: ['claude'], risk: 'control-confirm',
      source: ['skills/demo'], targets: { claude: '${USER_HOME}/.claude/skills/demo' },
      validators: ['skill', 'no-secrets'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo', provider: 'codex', request: 'Update controlled demo wording.', roots: fixture.roots });
    const current = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/demo/SKILL.md' });
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: current.path, expectedHash: current.hash, content: current.content.replace('Original body.', 'Controlled body.') }] });
    await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });

    const gated = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(gated.phase, 'awaiting-confirmation');
    assert.equal(gated.blocker, 'control-confirm');
    assert.equal(await pathExists(path.join(fixture.userHome, '.claude', 'skills', 'demo')), false);

    const installed = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: gated.planId, roots: fixture.roots });
    assert.equal(installed.phase, 'verified-provisional');
    assert.equal(await pathExists(path.join(fixture.userHome, '.claude', 'skills', 'demo')), true);
  } finally { await fixture.cleanup(); }
});

test('content transaction cannot patch an executable support script', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo', { scripts: true }) });
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'demo', provider: 'claude', request: 'Change the executable.', roots: fixture.roots });
    await assert.rejects(() => patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: 'skills/demo/scripts/run.mjs', expectedHash: 'irrelevant', content: 'changed' }] }), (error) => error.code === 'PATH_NOT_AUTHORIZED');
  } finally { await fixture.cleanup(); }
});

test('a new skill is allowed only through the predeclared namespace and receives a controller-generated lockfile', async () => {
  const fixture = await makeFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'fresh-skill', provider: 'codex', request: 'Create the fresh-skill skill.', allowCreation: true, roots: fixture.roots });
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'create', path: 'skills/fresh-skill/SKILL.md', content: '---\nname: fresh-skill\ndescription: A newly routed fixture skill.\n---\n\n# Fresh skill\n\nContent only.\n' }] });
    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.risk, 'content-auto');
    assert.ok(tested.changedPaths.includes('manifest.lock.json'));
    const promoted = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(promoted.phase, 'awaiting-confirmation');
    assert.equal(promoted.blocker, 'provider-context');
  } finally { await fixture.cleanup(); }
});

const FRESH_SKILL = '---\nname: fresh-skill\ndescription: A newly routed fixture skill.\n---\n\n# Fresh skill\n\nContent only.\n';

async function beginFreshSkill(fixture) {
  const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'fresh-skill', provider: 'codex', request: 'Create the fresh-skill skill.', allowCreation: true, roots: fixture.roots });
  const root = path.join(fixture.state, 'transactions', begun.transactionId);
  return { transactionId: begun.transactionId, worktree: path.join(root, 'worktree'), recordPath: path.join(root, 'transaction.json') };
}

function worktreeStatus(worktree) {
  return runGit(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
}

// Regression for the 2026-09-28 typesafe-ai creation: the extensionless LICENSE failed
// RISK_WIDENING after SKILL.md had already been written, leaving it on disk but unrecorded,
// so retrying the same create hit CREATE_EXISTS.
test('a patch whose second change widens risk writes nothing and records nothing', async () => {
  const fixture = await makeFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const { transactionId, worktree, recordPath } = await beginFreshSkill(fixture);
    const recordBefore = await readFile(recordPath, 'utf8');
    const skill = { op: 'create', path: 'skills/fresh-skill/SKILL.md', content: FRESH_SKILL };
    await assert.rejects(
      () => patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes: [skill, { op: 'create', path: 'skills/fresh-skill/assets/LICENSE', content: 'MIT\n' }] }),
      (error) => error.code === 'RISK_WIDENING' && error.message.includes('a file with no extension is control-confirm'),
    );
    assert.equal(await pathExists(path.join(worktree, 'skills', 'fresh-skill')), false);
    assert.equal(worktreeStatus(worktree), '');
    assert.equal(await readFile(recordPath, 'utf8'), recordBefore);

    const retried = await patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes: [skill] });
    assert.deepEqual(retried.changes.map((change) => change.path), ['skills/fresh-skill/SKILL.md']);
  } finally { await fixture.cleanup(); }
});

test('later changes in a patch are checked against the earlier changes in the same patch', async () => {
  const fixture = await makeFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const { transactionId } = await beginFreshSkill(fixture);
    const revised = FRESH_SKILL.replace('Content only.', 'Revised in the same patch.');
    const draft = '# Draft\n';
    const patched = await patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes: [
      { op: 'create', path: 'skills/fresh-skill/SKILL.md', content: FRESH_SKILL },
      { op: 'replace', path: 'skills/fresh-skill/SKILL.md', expectedHash: sha256(FRESH_SKILL), content: revised },
      { op: 'create', path: 'skills/fresh-skill/assets/draft.md', content: draft },
      { op: 'rename', path: 'skills/fresh-skill/assets/draft.md', to: 'skills/fresh-skill/assets/notes.md', expectedHash: sha256(draft) },
    ] });
    assert.deepEqual(patched.changes.map((change) => change.op), ['create', 'replace', 'create', 'rename']);
    assert.equal((await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/fresh-skill/SKILL.md' })).content, revised);
    assert.equal((await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/fresh-skill/assets/notes.md' })).content, draft);
    await assert.rejects(
      () => readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/fresh-skill/assets/draft.md' }),
      (error) => error.code === 'PATH_NOT_FOUND',
    );
    const record = await transactionStatus({ stateRoot: fixture.state, transactionId });
    assert.ok(record.allowedPaths.includes('skills/fresh-skill/assets/notes.md'));
    assert.equal(record.allowedPaths.includes('skills/fresh-skill/assets/draft.md'), false);
  } finally { await fixture.cleanup(); }
});

// Staging cannot know notes.md will be a file by the time nested.md is written, so this
// patch passes every check and then fails on I/O after two writes have landed.
test('a write that fails mid-patch restores the worktree and leaves the record alone', async () => {
  const fixture = await makeFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const { transactionId, worktree, recordPath } = await beginFreshSkill(fixture);
    await patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes: [{ op: 'create', path: 'skills/fresh-skill/SKILL.md', content: FRESH_SKILL }] });
    const recordBefore = await readFile(recordPath, 'utf8');
    const statusBefore = worktreeStatus(worktree);
    await assert.rejects(
      () => patchTransaction({ stateRoot: fixture.state, transactionId, policy, changes: [
        { op: 'replace', path: 'skills/fresh-skill/SKILL.md', expectedHash: sha256(FRESH_SKILL), content: FRESH_SKILL.replace('Content only.', 'Overwritten.') },
        { op: 'create', path: 'skills/fresh-skill/assets/notes.md', content: '# Notes\n' },
        { op: 'create', path: 'skills/fresh-skill/assets/notes.md/nested.md', content: '# Nested\n' },
      ] }),
      (error) => ['ENOTDIR', 'EEXIST'].includes(error.code),
    );
    assert.equal(await readFile(path.join(worktree, 'skills', 'fresh-skill', 'SKILL.md'), 'utf8'), FRESH_SKILL);
    assert.equal(await pathExists(path.join(worktree, 'skills', 'fresh-skill', 'assets')), false);
    assert.equal(worktreeStatus(worktree), statusBefore);
    assert.equal(await readFile(recordPath, 'utf8'), recordBefore);
  } finally { await fixture.cleanup(); }
});

// Planning a retirement against the artifact being retired can only ever yield EMPTY_PLAN,
// because a retired artifact is absent from the manifest by definition. Promotion must
// resolve the legacy-retirement carrier that declares its installed paths instead.
test('retiring a skill promotes against its declared carrier instead of failing EMPTY_PLAN', async () => {
  const fixture = await retirementFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo', provider: 'claude', request: 'Retire the demo skill.', allowRetirement: true, roots: fixture.roots });
    assert.equal(begun.artifact.risk, 'control-confirm');
    assert.ok(begun.allowedPaths.includes('manifest.json'));
    assert.deepEqual(begun.retirement.targets, DEMO_TARGETS);

    await declareRetirement(fixture, begun.transactionId, policy);
    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.risk, 'control-confirm');
    assert.ok(tested.changedPaths.includes('manifest.lock.json'));

    const promoted = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(promoted.phase, 'awaiting-confirmation');
    assert.equal(promoted.blocker, 'control-confirm');

    const record = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const plan = await readJson(record.planPath);
    assert.deepEqual(plan.artifacts, ['legacy.fixture-retirement']);
  } finally { await fixture.cleanup(); }
});

test('one retirement transaction can atomically retire multiple shared skills', async () => {
  const fixture = await retirementFixture({ skills: ['demo', 'second'] });
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({
      root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo',
      retirementArtifacts: ['skills.demo', 'skills.second'],
      provider: 'claude', request: 'Retire the demo and second skills together.',
      allowRetirement: true, roots: fixture.roots,
    });
    assert.equal(begun.artifact.risk, 'control-confirm');
    assert.deepEqual(begun.retirement.artifacts.map((artifact) => artifact.id), ['skills.demo', 'skills.second']);
    assert.deepEqual(begun.retirement.targets, BATCH_TARGETS);
    assert.ok(begun.allowedPaths.includes('skills/demo/SKILL.md'));
    assert.ok(begun.allowedPaths.includes('skills/second/SKILL.md'));

    await declareBatchRetirement(fixture, begun.transactionId, policy);
    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.passed, true);
    assert.ok(tested.changedPaths.includes('manifest.lock.json'));

    const promoted = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(promoted.phase, 'awaiting-confirmation');
    const record = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const plan = await readJson(record.planPath);
    assert.deepEqual(plan.artifacts, ['legacy.fixture-retirement']);
  } finally { await fixture.cleanup(); }
});

test('a retirement that declares no carrier entry is refused', async () => {
  const fixture = await retirementFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo', provider: 'claude', request: 'Retire the demo skill.', allowRetirement: true, roots: fixture.roots });
    await declareRetirement(fixture, begun.transactionId, policy, { targets: [DEMO_TARGETS[0]] });
    await assert.rejects(
      () => promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots }),
      (error) => error.code === 'RETIREMENT_NOT_DECLARED',
    );
  } finally { await fixture.cleanup(); }
});

test('a retirement that leaves its source in place is refused', async () => {
  const fixture = await retirementFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo', provider: 'claude', request: 'Retire the demo skill.', allowRetirement: true, roots: fixture.roots });
    await declareRetirement(fixture, begun.transactionId, policy, { removeSource: false });
    await assert.rejects(
      () => promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots }),
      (error) => error.code === 'RETIREMENT_INCOMPLETE',
    );
  } finally { await fixture.cleanup(); }
});

// The regression guard for 20260804-declared-removal-not-inferred-pruning: deleting an
// artifact's source without asking for a retirement must not quietly become one.
test('deleting a skill source without allowRetirement cannot reach a plan', async () => {
  const fixture = await retirementFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.demo', provider: 'claude', request: 'Remove the demo skill body.', roots: fixture.roots });
    assert.equal(begun.retirement, null);
    assert.equal(begun.allowedPaths.includes('manifest.json'), false);
    const skill = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/demo/SKILL.md' });
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'delete', path: skill.path, expectedHash: skill.hash }] });
    await assert.rejects(
      () => promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots }),
      (error) => error.code === 'EMPTY_PLAN',
    );
  } finally { await fixture.cleanup(); }
});


test('controller runtime stages an existing file authorized by a creation pattern', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'controller.runtime-v0.1.0', kind: 'controller-runtime', ownership: 'shared-generated',
      outputs: { state: 'dist/controller/v0.1.0' }, platforms: ['windows', 'macos'], providers: [],
      risk: 'control-confirm', source: ['lib', 'scripts/agent-config-controller.mjs', 'package.json', 'tests'],
      targets: { state: '${AGENT_CONFIG_STATE_ROOT}/controller/v0.1.0' }, validators: ['controller-tests', 'no-secrets'],
    });
    await mkdir(path.join(repo, 'tests'), { recursive: true });
    await writeFile(path.join(repo, 'tests', 'fixture.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('controller fixture executes', () => assert.equal(1, 1));\n", 'utf8');
    await writeFile(path.join(repo, 'README.md'), '# agent-config fixture version 1\n', 'utf8');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'controller.runtime-v0.1.0', provider: 'claude', request: 'Update the controller documentation.', roots: fixture.roots });
    assert.ok(begun.creationPatterns.includes('README.md'));
    const readme = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'README.md' });
    assert.match(readme.content, /agent-config/);
    const descriptor = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'README.md' });
    await patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: descriptor.path, expectedHash: descriptor.hash, content: '# agent-config fixture version 2\n' }] });
    await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    const promoted = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(promoted.phase, 'awaiting-confirmation');
    assert.equal(promoted.blocker, 'control-confirm');
  } finally { await fixture.cleanup(); }
});


const ATOMIC_ARTIFACTS = ['skills.capture', 'skills.decide', 'instructions.global'];

async function atomicFixture() {
  return makeFixture({ setup: async ({ repo }) => {
    await addSkill(repo, 'capture');
    await addSkill(repo, 'decide');
  } });
}

async function patchAtomicEntrypoints(fixture, transactionId, policy, suffix = 'Atomic route.') {
  const capture = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/capture/SKILL.md' });
  const decide = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'skills/decide/SKILL.md' });
  const operator = await readTransactionPath({ stateRoot: fixture.state, transactionId, relativePath: 'instructions/global.md' });
  await patchTransaction({
    stateRoot: fixture.state,
    transactionId,
    policy,
    changes: [
      { op: 'replace', path: capture.path, expectedHash: capture.hash, content: capture.content.replace('Original body.', suffix) },
      { op: 'replace', path: decide.path, expectedHash: decide.hash, content: decide.content.replace('Original body.', suffix) },
      { op: 'replace', path: operator.path, expectedHash: operator.hash, content: `${operator.content.trimEnd()}\n\n${suffix}\n` },
    ],
  });
}

test('explicit atomic artifacts bind the allowed-path union, preimages, exact plan, install, reconcile, and rollback', async () => {
  const fixture = await atomicFixture();
  try {
    await assert.rejects(
      () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ['skills.capture', 'skills.capture'], provider: 'codex', request: 'Duplicate scope.', roots: fixture.roots }),
      (error) => error.code === 'ATOMIC_ARTIFACTS_DUPLICATE',
    );
    await assert.rejects(
      () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ['skills.decide', 'skills.capture'], provider: 'codex', request: 'Mismatched primary.', roots: fixture.roots }),
      (error) => error.code === 'ATOMIC_PRIMARY_MISMATCH',
    );
    await assert.rejects(
      () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ATOMIC_ARTIFACTS, provider: 'codex', request: 'Mixed mode.', allowRetirement: true, roots: fixture.roots }),
      (error) => error.code === 'ATOMIC_RETIREMENT_CONFLICT',
    );

    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({
      root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ATOMIC_ARTIFACTS,
      provider: 'codex', request: 'Cut over Capture, Decide, and Example Workflow atomically.', roots: fixture.roots,
    });
    assert.deepEqual(begun.artifacts.map((artifact) => artifact.id), ATOMIC_ARTIFACTS);
    assert.equal(begun.artifact.risk, 'control-confirm');
    assert.equal(begun.retirement, null);
    assert.deepEqual(begun.allowedPaths, [
      'automation/controller-routing.md',
      'contracts/example-rules.md',
      'instructions/global.md',
      'providers/claude/instructions.append.md',
      'providers/codex/instructions.append.md',
      'skills/capture/SKILL.md',
      'skills/decide/SKILL.md',
    ]);
    assert.deepEqual(begun.atomicScope.sourcePreimages.map((entry) => entry.path), begun.allowedPaths);
    assert.equal(begun.atomicScope.sourcePreimages.every((entry) => entry.type === 'file' && /^[a-f0-9]{64}$/.test(entry.hash)), true);

    const capture = await readTransactionPath({ stateRoot: fixture.state, transactionId: begun.transactionId, relativePath: 'skills/capture/SKILL.md' });
    assert.equal(begun.atomicScope.sourcePreimages.find((entry) => entry.path === capture.path).hash, capture.hash);
    await assert.rejects(
      () => patchTransaction({ stateRoot: fixture.state, transactionId: begun.transactionId, policy, changes: [{ op: 'replace', path: capture.path, expectedHash: '0'.repeat(64), content: capture.content }] }),
      (error) => error.code === 'EXPECTED_HASH_MISMATCH',
    );

    await patchAtomicEntrypoints(fixture, begun.transactionId, policy);
    const tested = await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(tested.passed, true);
    assert.equal(tested.risk, 'control-confirm');
    const gated = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    assert.equal(gated.phase, 'awaiting-confirmation');
    assert.equal(gated.blocker, 'control-confirm');
    const wrong = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: 'sha256:' + '0'.repeat(64), roots: fixture.roots });
    assert.equal(wrong.phase, 'awaiting-confirmation');
    assert.equal(wrong.planId, gated.planId);

    const record = await transactionStatus({ stateRoot: fixture.state, transactionId: begun.transactionId });
    const plan = await readJson(record.planPath);
    assert.deepEqual(new Set(plan.artifacts), new Set(ATOMIC_ARTIFACTS));
    assert.deepEqual(new Set(plan.operations.map((operation) => operation.artifactId)), new Set(ATOMIC_ARTIFACTS));
    assert.deepEqual(plan.backupScope, plan.operations.map((operation) => operation.target).sort());

    const installed = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: gated.planId, roots: fixture.roots });
    assert.equal(installed.phase, 'verified-provisional');
    const targets = [
      path.join(fixture.userHome, '.claude', 'CLAUDE.md'),
      path.join(fixture.userHome, '.codex', 'AGENTS.md'),
      path.join(fixture.userHome, '.claude', 'skills', 'capture'),
      path.join(fixture.userHome, '.agents', 'skills', 'capture'),
      path.join(fixture.userHome, '.claude', 'skills', 'decide'),
      path.join(fixture.userHome, '.agents', 'skills', 'decide'),
    ];
    assert.equal((await Promise.all(targets.map((target) => describePath(target)))).every((descriptor) => descriptor.type !== 'absent'), true);

    const reconciled = await reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId });
    assert.equal(reconciled.phase, 'reconciled');
    const rolledBack = await rollbackBackup({ backupId: installed.release.backupId, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(rolledBack.status, 'rolled-back');
    assert.equal((await Promise.all(targets.map((target) => describePath(target)))).every((descriptor) => descriptor.type === 'absent'), true);
  } finally { await fixture.cleanup(); }
});

test('atomic transactions fail closed on dirty source, dirty reconciliation, and rollback conflict', async () => {
  const fixture = await atomicFixture();
  try {
    const dirtyPath = path.join(fixture.repo, 'dirty.txt');
    await writeFile(dirtyPath, 'dirty\n', 'utf8');
    await assert.rejects(
      () => beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ATOMIC_ARTIFACTS, provider: 'codex', request: 'Refuse dirty source.', roots: fixture.roots }),
      (error) => error.code === 'DIRTY_SOURCE',
    );
    await rm(dirtyPath);

    const { policy } = await loadConfiguration(fixture.repo);
    const begun = await beginTransaction({ root: fixture.repo, stateRoot: fixture.state, artifact: 'skills.capture', atomicArtifacts: ATOMIC_ARTIFACTS, provider: 'codex', request: 'Exercise dirty and conflict guards.', roots: fixture.roots });
    await patchAtomicEntrypoints(fixture, begun.transactionId, policy, 'Guarded atomic route.');
    await testTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    const gated = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, roots: fixture.roots });
    const installed = await promoteTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId, confirmationPlanId: gated.planId, roots: fixture.roots });

    await writeFile(dirtyPath, 'dirty during reconcile\n', 'utf8');
    await assert.rejects(
      () => reconcileTransaction({ root: fixture.repo, stateRoot: fixture.state, transactionId: begun.transactionId }),
      (error) => error.code === 'DIRTY_SOURCE',
    );

    const changedTarget = path.join(fixture.userHome, '.claude', 'CLAUDE.md');
    await writeFile(changedTarget, 'unknown replacement\n', 'utf8');
    await assert.rejects(
      () => rollbackBackup({ backupId: installed.release.backupId, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots }),
      (error) => error.code === 'ROLLBACK_CONFLICT',
    );
    assert.equal(await readFile(changedTarget, 'utf8'), 'unknown replacement\n');
  } finally { await fixture.cleanup(); }
});

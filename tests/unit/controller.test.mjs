import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createController, toolDefinitions } from '../../lib/controller.mjs';
import { hashTree } from '../../lib/fs-safe.mjs';
import { addSkill, makeFixture } from '../helpers.mjs';

test('controller exposes only the reviewed structured tool surface', () => {
  assert.deepEqual(toolDefinitions.map((tool) => tool.name), [
    'locate', 'transaction_begin', 'transaction_read', 'transaction_patch',
    'transaction_test', 'transaction_promote', 'transaction_status',
    'transaction_reconcile', 'transaction_supersede', 'transaction_abort',
    'suite_object_import', 'release_reconcile', 'sync', 'check', 'doctor',
  ]);
  assert.equal(toolDefinitions.some((tool) => /write.*root|shell/i.test(tool.name)), false);
  const begin = toolDefinitions.find((tool) => tool.name === 'transaction_begin');
  assert.equal(begin.inputSchema.properties.atomicArtifacts.minItems, 2);
  assert.match(begin.description, /non-retirement transaction over an explicit artifact list/);
});

test('controller locate resolves a canonical artifact without provider writes', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'demo') });
  try {
    const controller = createController({ root: fixture.repo, stateRoot: fixture.state, projectRoot: fixture.projectsRoot });
    const located = await controller.invoke('locate', { artifact: 'demo' });
    assert.equal(located.id, 'skills.demo');
    assert.equal(located.risk, 'content-auto');
  } finally { await fixture.cleanup(); }
});


test('controller imports a reviewed suite snapshot by exact digest without provider activation', async () => {
  const fixture = await makeFixture();
  try {
    const source = path.join(fixture.tempRoot, 'suite-source');
    await mkdir(path.join(source, 'runtime', 'bin'), { recursive: true });
    await writeFile(path.join(source, 'runtime', 'bin', 'helper'), 'reviewed bytes\n', 'utf8');
    const digest = await hashTree(source);
    const controller = createController({ root: fixture.repo, stateRoot: fixture.state, projectRoot: fixture.projectsRoot });
    const first = await controller.invoke('suite_object_import', { sourcePath: source, expectedDigest: digest });
    assert.equal(first.digest, digest);
    assert.equal(first.idempotent, false);
    const second = await controller.invoke('suite_object_import', { sourcePath: source, expectedDigest: digest });
    assert.equal(second.idempotent, true);
    assert.equal(await hashTree(first.path), digest);
    await assert.rejects(
      () => controller.invoke('suite_object_import', { sourcePath: source, expectedDigest: '0'.repeat(64) }),
      (error) => error.code === 'SUITE_DIGEST_MISMATCH',
    );
  } finally { await fixture.cleanup(); }
});

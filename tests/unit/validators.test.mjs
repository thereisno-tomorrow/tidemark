import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { makeFixture } from '../helpers.mjs';

for (const [outcome, body, expected] of [
  ['skipped', "test('fixture', { skip: true }, () => {});", /controller-tests reported skipped tests/],
  ['failed', "test('fixture', () => { throw new Error('fixture failure'); });", /controller-tests failed with exit 1/],
  ['passing', "test('fixture', () => {});", null],
]) {
  test(`validation ${expected ? 'rejects' : 'accepts'} ${outcome} controller tests`, async () => {
    const fixture = await makeFixture({ setup: async ({ repo }) => {
      const manifestPath = path.join(repo, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.artifacts.push({
        id: 'controller.runtime-v0.1.0', kind: 'controller-runtime', ownership: 'shared-generated',
        outputs: { state: 'dist/controller/v0.1.0' }, platforms: ['windows', 'macos'], providers: [],
        risk: 'control-confirm', source: ['lib', 'scripts/agent-config-controller.mjs', 'package.json'],
        targets: { state: '${AGENT_CONFIG_STATE_ROOT}/controller/v0.1.0' }, validators: ['controller-tests', 'no-secrets'],
      });
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      await mkdir(path.join(repo, 'tests'));
      await writeFile(path.join(repo, 'tests', 'fixture.test.mjs'), `import test from 'node:test';\n${body}\n`);
    } });
    try {
      // Use a fresh validator process even when our parent is a declared suite.
      const env = { ...process.env, AGENT_CONFIG_CONTROLLER_TESTS_RUNNING: '0' };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import { validateRepository } from './lib/validators.mjs'; console.log(JSON.stringify(await validateRepository(process.cwd(), {runDeclaredValidators: true, artifactIds: ['controller.runtime-v0.1.0']})));"], {
        cwd: fixture.repo, encoding: 'utf8',
        env,
      });
      assert.equal(result.status, 0, result.stderr);
      const validation = JSON.parse(result.stdout);
      assert.equal(validation.ok, !expected, validation.issues.join('\n'));
      if (expected) assert.ok(validation.issues.some((issue) => expected.test(issue)), validation.issues.join('\n'));
      else assert.deepEqual(validation.issues, []);
    } finally { await fixture.cleanup(); }
  });
}

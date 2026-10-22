import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyPlan, checkInstalled } from '../../lib/apply.mjs';
import { calculatePlan } from '../../lib/planner.mjs';
import { makeFixture } from '../helpers.mjs';

for (const format of ['toml', 'json']) test(`check output comparison: ${format === 'toml' ? 'TOML with JSON source validator uses byte comparison' : 'JSON without JSON source validator keeps semantic comparison'}`, async () => {
  const toml = format === 'toml';
  const id = toml ? 'provider.codex-config' : 'provider.codex-hooks';
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    await mkdir(path.join(repo, 'mcp'), { recursive: true });
    await writeFile(path.join(repo, 'mcp/servers.json'), '{"schemaVersion":1,"servers":[]}\n');
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id, kind: toml ? 'provider-config' : 'hook-config', ownership: 'shared-generated',
      platforms: ['windows', 'macos'], providers: ['codex'], risk: 'control-confirm',
      source: toml ? ['providers/codex/config.patch.json', 'mcp/servers.json'] : ['providers/codex/hooks.base.json'],
      outputs: { codex: `dist/codex/${toml ? 'config.toml' : 'hooks.json'}` },
      targets: { codex: '${USER_HOME}/.codex/' + (toml ? 'config.toml' : 'hooks.json') },
      validators: toml ? ['json', 'no-secrets'] : ['no-secrets'],
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } });
  try {
    const planned = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, artifactIds: [id] });
    await applyPlan({ planPath: planned.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: planned.plan.planId });
    const check = () => checkInstalled({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    const clean = await check();
    assert.equal(clean.ok, true);
    assert.equal(clean.checkedTargets, 1);
    assert.deepEqual(clean.drift, []);
    const target = path.join(fixture.userHome, '.codex', toml ? 'config.toml' : 'hooks.json');
    const original = await readFile(target, 'utf8');
    if (toml) {
      // Regeneration strips the managed block. Even a comment edit must drift.
      await writeFile(target, original.replace('# BEGIN agent-config managed mcp\n', '# BEGIN agent-config managed mcp\n# Changed bytes.\n'));
      const edited = await check();
      assert.equal(edited.ok, false);
      assert.ok(edited.drift.some(item => item.artifactId === id && item.reason === 'content-drift'));
      assert.ok(!edited.drift.some(item => item.reason === 'desired-state-build-failed'));
    } else {
      const parsed = JSON.parse(original);
      const reformatted = '\n' + JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 4) + '\n';
      assert.notEqual(reformatted, original);
      await writeFile(target, reformatted);
      assert.equal((await check()).ok, true);
      await writeFile(target, JSON.stringify({ ...parsed, hooks: {} }));
      const edited = await check();
      assert.equal(edited.ok, false);
      assert.ok(edited.drift.some(item => item.artifactId === id && item.reason === 'content-drift'));
    }
  } finally { await fixture.cleanup(); }
});

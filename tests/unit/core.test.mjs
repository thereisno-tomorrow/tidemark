import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { canonicalize, digestObject, withContentId } from '../../lib/canonical-json.mjs';
import { AgentConfigError } from '../../lib/errors.mjs';
import { effectivePathRisk, locateArtifact, loadConfiguration, validateManifestShape } from '../../lib/manifest.mjs';
import { check, inspectSkillRuntimeDependencies } from '../../lib/diagnostics.mjs';
import { pathExists } from '../../lib/fs-safe.mjs';
import { ensureWithin, normalizeRelative } from '../../lib/paths.mjs';
import { makeFixture } from '../helpers.mjs';

test('canonical JSON and content IDs are stable', () => {
  assert.equal(canonicalize({ z: 1, a: { d: 2, b: 3 } }), '{\n  "a": {\n    "b": 3,\n    "d": 2\n  },\n  "z": 1\n}\n');
  const identified = withContentId({ schemaVersion: 1, value: 'same' });
  const body = structuredClone(identified);
  delete body.planId;
  assert.equal(identified.planId, digestObject(body));
});

test('path guards reject traversal and broad roots', () => {
  assert.throws(() => normalizeRelative('../escape'), (error) => error.code === 'PATH_ESCAPE');
  assert.throws(() => ensureWithin('C:\\safe', 'C:\\other\\file'), (error) => error.code === 'PATH_ESCAPE');
  assert.equal(normalizeRelative('skills\\demo\\SKILL.md'), 'skills/demo/SKILL.md');
});

test('risk floor keeps executable and control paths out of content-auto', async () => {
  const fixture = await makeFixture();
  try {
    const { policy } = await loadConfiguration(fixture.repo);
    assert.equal(effectivePathRisk('skills/demo/SKILL.md', 'content-auto', policy), 'content-auto');
    assert.equal(effectivePathRisk('skills/demo/scripts/run.mjs', 'content-auto', policy), 'control-confirm');
    assert.equal(effectivePathRisk('providers/claude/instructions.append.md', 'content-auto', policy), 'content-auto');
    assert.equal(effectivePathRisk('providers/claude/settings.patch.json', 'content-auto', policy), 'control-confirm');
    assert.equal(effectivePathRisk('manifest.json', 'content-auto', policy), 'control-confirm');
  } finally { await fixture.cleanup(); }
});

test('routing resolves exact artifacts and a single creation namespace', async () => {
  const fixture = await makeFixture();
  try {
    const configuration = await loadConfiguration(fixture.repo);
    assert.equal((await locateArtifact(fixture.repo, configuration, 'global instructions')).id, 'instructions.global');
    const creation = await locateArtifact(fixture.repo, configuration, 'new-skill', { allowCreation: true });
    assert.equal(creation.id, 'skills.new-skill');
    assert.equal(creation.creation, true);
    assert.equal(creation.ownership, 'shared-link');
    assert.deepEqual(creation.providers, ['claude', 'codex']);
    assert.equal(creation.targets.claude, '${USER_HOME}/.claude/skills/new-skill');
    assert.equal(creation.targets.codex, '${USER_HOME}/.agents/skills/new-skill');
    await assert.rejects(() => locateArtifact(fixture.repo, configuration, 'Not A Valid Skill', { allowCreation: true }), (error) => error.code === 'ARTIFACT_NOT_FOUND');
  } finally { await fixture.cleanup(); }
});

test('manifest validation rejects duplicate ownership identities', () => {
  const manifest = { schemaVersion: 1, artifacts: [{ id: 'same', ownership: 'shared-link', risk: 'content-auto', providers: ['claude'], platforms: ['windows'], validators: ['skill'] }, { id: 'same', ownership: 'shared-copy', risk: 'content-auto', providers: ['codex'], platforms: ['windows'], validators: ['skill'] }], namespaces: [] };
  assert.ok(validateManifestShape(manifest).some((issue) => issue.includes('duplicate artifact id')));
});

test('manifest dependencies reject missing, self, duplicate, and cyclic edges', () => {
  const artifact = (id, dependencies = []) => ({
    id, kind: 'policy', source: [`${id}.json`], ownership: 'shared-link', risk: 'control-confirm',
    providers: ['codex'], platforms: ['windows'], validators: ['json'], dependencies,
  });
  const valid = { schemaVersion: 1, artifacts: [artifact('a', ['b']), artifact('b')], namespaces: [] };
  assert.equal(validateManifestShape(valid).filter((issue) => issue.includes('depend')).length, 0);

  const invalid = structuredClone(valid);
  invalid.artifacts[0].dependencies = ['missing', 'missing', 'a'];
  assert.ok(validateManifestShape(invalid).some((issue) => issue.includes('unknown dependency: missing')));
  assert.ok(validateManifestShape(invalid).some((issue) => issue.includes('duplicate dependency: missing')));
  assert.ok(validateManifestShape(invalid).some((issue) => issue.includes('cannot depend on itself')));

  const cyclic = { schemaVersion: 1, artifacts: [artifact('a', ['b']), artifact('b', ['a'])], namespaces: [] };
  assert.ok(validateManifestShape(cyclic).some((issue) => issue.includes('artifact dependency cycle')));
});

test('provider-only skills require an explicit incompatibility reason', () => {
  const manifest = {
    schemaVersion: 1,
    artifacts: [{
      id: 'skills.native-only', kind: 'skill', source: ['skills/native-only'],
      ownership: 'provider-only', risk: 'control-confirm', providers: ['claude'],
      platforms: ['windows'], validators: ['skill'],
    }],
    namespaces: [],
  };
  assert.ok(validateManifestShape(manifest).some((issue) => issue.includes('providerOnlyReason')));
  manifest.artifacts[0].providerOnlyReason = 'Requires a Claude-only runtime API.';
  assert.equal(validateManifestShape(manifest).some((issue) => issue.includes('providerOnlyReason')), false);
});


test('health detects prompt hooks that name missing skills and a legacy operator shadow', async () => {
  const fixture = await makeFixture();
  try {
    const claudeRoot = path.join(fixture.userHome, '.claude');
    await mkdir(claudeRoot, { recursive: true });
    await writeFile(path.join(claudeRoot, 'operator.md'), 'legacy shadow\n', 'utf8');
    await writeFile(path.join(claudeRoot, 'settings.json'), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'prompt', prompt: 'Ask the example-tutor skill to capture this.' }] }] },
    }), 'utf8');
    const result = await check({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, projectRoot: fixture.repo });
    assert.deepEqual(result.missingHookSkills, [{ skill: 'example-tutor', reference: 'prompt hook references missing skill example-tutor' }]);
    assert.ok(result.instructionShadows.some((shadow) => shadow.path === path.join(claudeRoot, 'operator.md')));
    assert.equal(result.ok, false);
  } finally { await fixture.cleanup(); }
});

test('runtime dependency inspection fails when a managed skill references a missing sibling runtime', async () => {
  const fixture = await makeFixture();
  try {
    const skill = path.join(fixture.repo, 'skills', 'example-session');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: example-session\ndescription: Runtime dependency fixture.\n---\n\nRun ~/.claude/skills/example-suite/bin/helper.\n', 'utf8');
    const missing = await inspectSkillRuntimeDependencies({ root: fixture.repo, roots: fixture.roots });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].artifactId, 'skills.example-session');
    assert.equal(missing[0].dependency, 'example-suite');
    await mkdir(path.join(fixture.userHome, '.claude', 'skills', 'example-suite'), { recursive: true });
    assert.deepEqual(await inspectSkillRuntimeDependencies({ root: fixture.repo, roots: fixture.roots }), []);
  } finally { await fixture.cleanup(); }
});

test('fixtures never copy local session state or nested checkouts from the template', async () => {
  const template = await makeFixture();
  let fixture = null;
  try {
    // Each planted file carries an absolute machine path, so copying any of them
    // would fail fixture validation the way a copied session worktree does.
    const machinePath = ['', 'Users', 'fixture', 'notes.md'].join('/');
    for (const checkout of [path.join(template.repo, '.claude', 'worktrees', 'quiet-lovelace-0a1b2c'), path.join(template.repo, 'vendor', 'checkout')]) {
      await mkdir(checkout, { recursive: true });
      await writeFile(path.join(checkout, '.git'), 'gitdir: ../elsewhere\n', 'utf8');
      await writeFile(path.join(checkout, 'notes.md'), `${machinePath}\n`, 'utf8');
    }
    await writeFile(path.join(template.repo, '.claude', 'settings.local.json'), `${JSON.stringify({ notes: machinePath })}\n`, 'utf8');
    await writeFile(path.join(template.repo, 'vendor', 'kept.md'), 'Ordinary untracked content.\n', 'utf8');
    fixture = await makeFixture({ template: template.repo });
    assert.equal(await pathExists(path.join(fixture.repo, '.claude')), false);
    assert.equal(await pathExists(path.join(fixture.repo, 'vendor', 'checkout')), false);
    assert.equal(await pathExists(path.join(fixture.repo, 'vendor', 'kept.md')), true);
  } finally {
    await fixture?.cleanup();
    await template.cleanup();
  }
});

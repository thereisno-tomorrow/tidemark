import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfiguration, locateArtifact } from '../../lib/manifest.mjs';
import { addSkill, makeFixture } from '../helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('personal skill routing defaults to shared and an example profile is portable', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addSkill(repo, 'example-profile') });
  try {
  const configuration = await loadConfiguration(fixture.repo);
  const creation = await locateArtifact(fixture.repo, configuration, 'fresh-personal-skill', { allowCreation: true });
  assert.equal(creation.ownership, 'shared-link');
  assert.deepEqual(creation.providers, ['claude', 'codex']);

  const adoption = await locateArtifact(fixture.repo, configuration, 'fresh-personal-skill', { allowAdoption: true });
  assert.equal(adoption.adoption, true);
  assert.equal(adoption.risk, 'control-confirm');
  assert.equal(adoption.namespaceId, 'portable-skill');

  const profile = await locateArtifact(fixture.repo, configuration, 'example-profile');
  assert.equal(profile.ownership, 'shared-link');
  assert.deepEqual(profile.providers, ['claude', 'codex']);
  assert.equal(profile.targets.codex, '${USER_HOME}/.agents/skills/example-profile');

  const providerOnly = JSON.parse(await readFile(path.join(fixture.repo, 'providers/claude/provider-only-skills.json'), 'utf8'));
  assert.equal(providerOnly.skills.includes('example-profile'), false);
  } finally { await fixture.cleanup(); }
});

test('managed routing overrides provider-native personal skill destinations', async () => {
  const routing = await readFile(path.join(root, 'automation/controller-routing.md'), 'utf8');
  const maintainer = await readFile(path.join(root, 'bootstrap/agent-config-maintainer/SKILL.md'), 'utf8');
  assert.match(routing, /Default personal skills to the portable/);
  assert.match(routing, /before using any provider-native/);
  assert.match(routing, /Never create or edit a managed personal skill directly/);
  assert.match(maintainer, /shared Claude and Codex ownership is the default/);
  // Assert the RULE, not one phrasing of it. Commit 4c38777 reworded this from
  // "...transaction path overrides..." to "Apply that guidance only inside the
  // controller-returned transaction path" and left the suite red for two days.
  // \s+ because the sentence is line-wrapped in the skill body; a literal-space
  // regex silently misses it and reads as a missing rule.
  assert.match(maintainer, /provider-native\s+skill\s+creators/i);
  assert.match(maintainer, /controller-returned\s+transaction\s+path/);
});

test('Claude managed settings contain no example optimizer plugin hooks', async () => {
  const settings = JSON.parse(await readFile(path.join(root, 'providers/claude/settings.patch.json'), 'utf8'));
  assert.equal(Object.hasOwn(settings.patch.enabledPlugins, 'example-optimizer@example-marketplace'), false);
  assert.equal(Object.hasOwn(settings.patch.extraKnownMarketplaces, 'example-marketplace'), false);
  assert.equal(Object.hasOwn(settings.patch, 'statusLine'), false);
});

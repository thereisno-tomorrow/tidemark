import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyPlan, checkInstalled } from '../../lib/apply.mjs';
import { describePath, pathExists } from '../../lib/fs-safe.mjs';
import { runGit } from '../../lib/git.mjs';
import { calculatePlan } from '../../lib/planner.mjs';
import { makeFixture } from '../helpers.mjs';

async function addCodexHooksArtifact(repo) {
  const manifestPath = path.join(repo, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.artifacts.some((artifact) => artifact.id === 'provider.codex-hooks')) {
    manifest.artifacts.push({
      id: 'provider.codex-hooks', kind: 'hook-config', ownership: 'shared-generated',
      outputs: { codex: 'dist/codex/hooks.json' }, platforms: ['windows', 'macos'],
      providers: ['codex'], risk: 'control-confirm',
      source: ['providers/codex/hooks.base.json'],
      targets: { codex: '\${USER_HOME}/.codex/hooks.json' }, validators: ['json', 'no-secrets'],
    });
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function addDependencyClosedCodexHooks(repo) {
  await addCodexHooksArtifact(repo);
  await mkdir(path.join(repo, 'example-runtime'), { recursive: true });
  await writeFile(path.join(repo, 'example-runtime', 'example-hook.py'), 'print("example hook")\n');
  await writeFile(path.join(repo, 'example-runtime', 'example-policy.json'), '{"enabled":false}\n');
  const manifestPath = path.join(repo, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const provider = manifest.artifacts.find((artifact) => artifact.id === 'provider.codex-hooks');
  provider.dependencies = ['hooks.example-hook.py'];
  manifest.artifacts.push(
    {
      id: 'hooks.example-hook.py', kind: 'hook-script', ownership: 'shared-link',
      platforms: ['windows'], providers: ['codex'], risk: 'control-confirm',
      source: ['example-runtime/example-hook.py'],
      targets: { codex: '\${USER_HOME}/.codex/hooks/example-hook.py' },
      validators: ['python', 'no-secrets'], dependencies: ['hooks.example-policy.json'],
    },
    {
      id: 'hooks.example-policy.json', kind: 'policy', ownership: 'shared-link',
      platforms: ['windows'], providers: ['codex'], risk: 'control-confirm',
      source: ['example-runtime/example-policy.json'],
      targets: { codex: '\${USER_HOME}/.codex/hooks/example-policy.json' },
      validators: ['json', 'no-secrets'],
    },
  );
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function addClaudeSettingsArtifact(repo) {
  const manifestPath = path.join(repo, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.artifacts.some((artifact) => artifact.id === 'provider.claude-settings')) {
    manifest.artifacts.push({
      id: 'provider.claude-settings', kind: 'provider-config', ownership: 'shared-generated',
      outputs: { claude: 'dist/claude/settings.json' }, platforms: ['windows', 'macos'],
      providers: ['claude'], risk: 'control-confirm',
      source: ['providers/claude/settings.patch.json', 'hooks/mappings.json'],
      targets: { claude: '\${USER_HOME}/.claude/settings.json' }, validators: ['json', 'no-secrets'],
    });
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function fixtureCommit(repo, message) {
  runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'add', '--all']);
  runGit(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', message]);
}

test('Claude settings preserve native hooks and plugins while managed settings update', async () => {
  const nativeGroup = {
    hooks: [{
      type: 'command',
      command: 'powershell.exe -NoProfile -File "C:\\\\Users\\\\Fixture\\\\.claude\\\\hooks\\\\example-agent-state.ps1" session',
      timeout: 10,
    }],
  };
  const exampleMarketplace = {
    source: { source: 'github', repo: 'example/example-plugin' },
  };
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addClaudeSettingsArtifact(repo);
    const settingsModel = JSON.parse(await readFile(path.join(repo, 'providers', 'claude', 'settings.patch.json'), 'utf8'));
    const native = structuredClone(settingsModel.patch);
    native.enabledPlugins['example-plugin@example-marketplace'] = true;
    native.extraKnownMarketplaces['example-marketplace'] = exampleMarketplace;
    native.hooks = { SessionStart: [nativeGroup] };
    const target = path.join(userHome, '.claude', 'settings.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(native, null, 2) + '\n', 'utf8');
  } });
  try {
    const first = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.claude-settings'], roots: fixture.roots });
    await applyPlan({ planPath: first.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: first.plan.planId });

    const settingsPath = path.join(fixture.repo, 'providers', 'claude', 'settings.patch.json');
    const settingsModel = JSON.parse(await readFile(settingsPath, 'utf8'));
    settingsModel.patch.theme = 'dark';
    await writeFile(settingsPath, JSON.stringify(settingsModel, null, 2) + '\n', 'utf8');
    fixtureCommit(fixture.repo, 'update managed Claude theme');

    const second = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.claude-settings'], roots: fixture.roots });
    await applyPlan({ planPath: second.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: second.plan.planId });

    const target = path.join(fixture.userHome, '.claude', 'settings.json');
    const output = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(output.theme, 'dark');
    assert.equal(output.enabledPlugins['example-plugin@example-marketplace'], true);
    assert.deepEqual(output.extraKnownMarketplaces['example-marketplace'], exampleMarketplace);
    assert.deepEqual(output.hooks.SessionStart, [nativeGroup]);

    const reordered = Object.fromEntries(Object.entries(output).reverse());
    await writeFile(target, JSON.stringify(reordered, null, 2) + '\n', 'utf8');
    const health = await checkInstalled({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(health.ok, true);
  } finally { await fixture.cleanup(); }
});

test('Claude settings block an outside edit to managed permissions', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addClaudeSettingsArtifact(repo) });
  try {
    const first = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.claude-settings'], roots: fixture.roots });
    await applyPlan({ planPath: first.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: first.plan.planId });

    const target = path.join(fixture.userHome, '.claude', 'settings.json');
    const current = JSON.parse(await readFile(target, 'utf8'));
    current.permissions.allow.push('Bash(git:*)');
    await writeFile(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    await assert.rejects(
      () => calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.claude-settings'], roots: fixture.roots }),
      (error) => error.code === 'CLAUDE_SETTINGS_MERGE_CONFLICT',
    );
  } finally { await fixture.cleanup(); }
});

test('selected Claude settings reject malformed native JSON', async () => {
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addClaudeSettingsArtifact(repo);
    const target = path.join(userHome, '.claude', 'settings.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'not-json\n', 'utf8');
  } });
  try {
    await assert.rejects(
      () => calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.claude-settings'], roots: fixture.roots }),
      (error) => error.code === 'CLAUDE_SETTINGS_INVALID',
    );
  } finally { await fixture.cleanup(); }
});

test('an unrelated plan never parses or binds native Claude settings', async () => {
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addClaudeSettingsArtifact(repo);
    const target = path.join(userHome, '.claude', 'settings.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'not-json\n', 'utf8');
  } });
  try {
    const planned = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['instructions.global'], roots: fixture.roots, riskOverride: 'content-auto' });
    await writeFile(path.join(fixture.userHome, '.claude', 'settings.json'), 'still-not-json\n', 'utf8');
    await applyPlan({ planPath: planned.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(await readFile(path.join(fixture.userHome, '.claude', 'settings.json'), 'utf8'), 'still-not-json\n');
  } finally { await fixture.cleanup(); }
});

test('Codex adapter preserves unmanaged native config and adds one marked MCP block', async () => {
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'provider.codex-config', kind: 'provider-config', ownership: 'shared-generated',
      outputs: { codex: 'dist/codex/config.toml' }, platforms: ['windows', 'macos'],
      providers: ['codex'], risk: 'control-confirm',
      source: ['providers/codex/config.patch.json', 'mcp/servers.json'],
      targets: { codex: '${USER_HOME}/.codex/config.toml' }, validators: ['toml', 'no-secrets'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const target = path.join(userHome, '.codex', 'config.toml');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'model = "fixture-model"\n\n[projects."fixture"]\ntrust_level = "trusted"\n', 'utf8');
  } });
  try {
    const { plan, planPath } = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-config'], roots: fixture.roots });
    assert.equal(plan.risk, 'control-confirm');
    await applyPlan({ planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: plan.planId });
    const output = await readFile(path.join(fixture.userHome, '.codex', 'config.toml'), 'utf8');
    assert.match(output, /^model = "fixture-model"/);
    assert.equal((output.match(/# BEGIN agent-config managed mcp/g) ?? []).length, 1);
    assert.match(output, /\[mcp_servers\.agent_config\]/);
  } finally { await fixture.cleanup(); }
});

test('controller bootstrap installs one immutable versioned runtime inside local state', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push({
      id: 'controller.runtime-v0.1.0', kind: 'controller-runtime', ownership: 'shared-generated',
      outputs: { state: 'dist/controller/v0.1.0' }, platforms: ['windows', 'macos'], providers: [],
      risk: 'control-confirm', source: ['lib', 'scripts/agent-config-controller.mjs', 'package.json'],
      targets: { state: '${AGENT_CONFIG_STATE_ROOT}/controller/v0.1.0' }, validators: ['controller-tests', 'no-secrets'],
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
  try {
    const { plan, planPath } = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['controller.runtime-v0.1.0'], roots: fixture.roots });
    assert.equal(plan.confirmation.required, true);
    await applyPlan({ planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: plan.planId });
    const installed = path.join(fixture.state, 'controller', 'v0.1.0');
    assert.equal((await describePath(installed)).type, 'directory');
    assert.equal(await pathExists(path.join(installed, 'scripts', 'agent-config-controller.mjs')), true);
  } finally { await fixture.cleanup(); }
});

test('Codex MCP config points to the installed controller entrypoint', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => {
    const manifestPath = path.join(repo, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.artifacts.push(
      {
        id: 'controller.runtime-v0.1.0', kind: 'controller-runtime', ownership: 'shared-generated',
        outputs: { state: 'dist/controller/v0.1.0' }, platforms: ['windows', 'macos'], providers: [],
        risk: 'control-confirm', source: ['lib', 'scripts/agent-config-controller.mjs', 'package.json'],
        targets: { state: '${AGENT_CONFIG_STATE_ROOT}/controller/v0.1.0' }, validators: ['controller-tests', 'no-secrets'],
      },
      {
        id: 'provider.codex-config', kind: 'provider-config', ownership: 'shared-generated',
        outputs: { codex: 'dist/codex/config.toml' }, platforms: ['windows', 'macos'], providers: ['codex'],
        risk: 'control-confirm', source: ['providers/codex/config.patch.json', 'mcp/servers.json'],
        targets: { codex: '${USER_HOME}/.codex/config.toml' }, validators: ['toml', 'no-secrets'],
      },
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } });
  try {
    const artifactIds = ['controller.runtime-v0.1.0', 'provider.codex-config'];
    const canonicalRoot = path.join(fixture.projectsRoot, 'canonical-agent-config');
    const runtimeRoots = { ...fixture.roots, AGENT_CONFIG_ROOT: canonicalRoot };
    const { plan, planPath } = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds, roots: runtimeRoots });
    await applyPlan({ planPath, root: fixture.repo, stateRoot: fixture.state, roots: runtimeRoots, confirmationPlanId: plan.planId });

    const expected = path.join(fixture.state, 'controller', 'v0.1.0', 'scripts', 'agent-config-controller.mjs');
    assert.equal(await pathExists(path.join(fixture.userHome, '.claude', '.mcp.json')), false);
    assert.equal(await pathExists(path.join(plan.release.snapshotPath, 'dist', 'claude', '.mcp.json')), false);
    const codex = await readFile(path.join(fixture.userHome, '.codex', 'config.toml'), 'utf8');
    const configured = `${fixture.state}/controller/v0.1.0/scripts/agent-config-controller.mjs`;
    assert.equal(path.normalize(configured), expected);
    assert.equal(codex.includes(JSON.stringify([configured])), true);
    assert.equal(await pathExists(expected), true);
    assert.equal(codex.includes(`AGENT_CONFIG_ROOT = ${JSON.stringify(canonicalRoot)}`), true);
    assert.equal(plan.source.root, fixture.repo);
    assert.equal(plan.source.canonicalRoot, canonicalRoot);
  } finally { await fixture.cleanup(); }
});

test('Codex hook planning activates registration, dispatcher, and policy as one dependency-closed unit', async () => {
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addDependencyClosedCodexHooks(repo);
    // A directory junction needs no Windows file-symlink privilege. Its exact
    // topology must be restored if replacing it with a file link is denied.
    const target = path.join(userHome, '.codex', 'hooks', 'example-hook.py');
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(repo, 'example-runtime'), target, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  try {
    const planned = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots });
    assert.deepEqual(planned.plan.artifacts, ['hooks.example-hook.py', 'hooks.example-policy.json', 'provider.codex-hooks']);
    assert.equal(planned.plan.operations.length, 3);
    let installed;
    try {
      installed = await applyPlan({ planPath: planned.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: planned.plan.planId });
    } catch (error) {
      assert.equal(process.platform, 'win32');
      assert.equal(error.code, 'FILE_SYMLINK_DENIED');
      assert.match(error.message, /Developer Mode/);
      assert.match(error.message, /administrator rights/);
      assert.match(error.message, /shared-copy/);
      for (const operation of planned.plan.operations) {
        assert.deepEqual(await describePath(operation.target), operation.preimage);
      }
      assert.equal(await pathExists(path.join(fixture.state, 'active')), false);
      const current = JSON.parse(await readFile(path.join(fixture.state, 'installs', 'current.json'), 'utf8'));
      assert.equal(current.status, 'rolled-back');
      const journalRoot = path.join(fixture.state, 'installs', 'journal');
      const events = (await Promise.all((await readdir(journalRoot)).map(async (name) =>
        (await readFile(path.join(journalRoot, name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat();
      assert.ok(events.some((event) => event.phase === 'apply-failed' && event.code === 'FILE_SYMLINK_DENIED'));
      assert.ok(events.some((event) => event.phase === 'apply-rollback-complete' && event.status === 'rolled-back'));
      assert.equal(events.some((event) => event.phase === 'apply-complete'), false);
      return;
    }
    assert.deepEqual(installed.install.activeArtifacts, ['hooks.example-hook.py', 'hooks.example-policy.json', 'provider.codex-hooks']);
    const healthy = await checkInstalled({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(healthy.ok, true);

    const currentPath = path.join(fixture.state, 'installs', 'current.json');
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    current.activeArtifacts = current.activeArtifacts.filter((artifactId) => artifactId !== 'hooks.example-policy.json');
    await writeFile(currentPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
    const incomplete = await checkInstalled({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(incomplete.ok, false);
    assert.ok(incomplete.drift.some((item) => item.reason === 'desired-state-build-failed' && item.actual.code === 'ACTIVE_DEPENDENCY_MISSING'));
  } finally { await fixture.cleanup(); }
});

test('Codex hook adapter preserves native hooks while adding managed hooks', async () => {
  const nativeGroup = {
    matcher: '^shell_command$',
    hooks: [{ type: 'command', command: 'echo native', timeout: 5 }],
  };
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addCodexHooksArtifact(repo);
    const target = path.join(userHome, '.codex', 'hooks.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ description: 'Native user hooks', hooks: { PreToolUse: [nativeGroup] } }, null, 2) + '\n', 'utf8');
  } });
  try {
    const planned = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots });
    await applyPlan({ planPath: planned.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: planned.plan.planId });
    const output = JSON.parse(await readFile(path.join(fixture.userHome, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(output.description, 'Native user hooks');
    assert.deepEqual(output.hooks.PreToolUse, [nativeGroup]);
    assert.equal(output.hooks.SessionStart.length, 1);
    assert.equal(output.hooks.PostToolUse.length, 1);
  } finally { await fixture.cleanup(); }
});

test('Codex hook adapter replaces managed hooks in place and keeps later native additions', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addCodexHooksArtifact(repo) });
  try {
    const first = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots });
    await applyPlan({ planPath: first.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: first.plan.planId });

    const target = path.join(fixture.userHome, '.codex', 'hooks.json');
    const current = JSON.parse(await readFile(target, 'utf8'));
    const nativeGroup = { hooks: [{ type: 'command', command: 'echo later-native', timeout: 7 }] };
    current.hooks.PreCompact = [nativeGroup];
    await writeFile(target, JSON.stringify(current, null, 2) + '\n', 'utf8');

    const basePath = path.join(fixture.repo, 'providers', 'codex', 'hooks.base.json');
    const base = JSON.parse(await readFile(basePath, 'utf8'));
    base.hooks.SessionStart[0].hooks[0].timeout = 31;
    await writeFile(basePath, JSON.stringify(base, null, 2) + '\n', 'utf8');
    fixtureCommit(fixture.repo, 'update managed hook');

    const second = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots });
    await applyPlan({ planPath: second.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: second.plan.planId });
    const output = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(output.hooks.SessionStart[0].hooks[0].timeout, 31);
    assert.deepEqual(output.hooks.PreCompact, [nativeGroup]);
  } finally { await fixture.cleanup(); }
});

test('Codex hook adapter blocks an ambiguous local edit to a managed hook', async () => {
  const fixture = await makeFixture({ setup: async ({ repo }) => addCodexHooksArtifact(repo) });
  try {
    const first = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots });
    await applyPlan({ planPath: first.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: first.plan.planId });
    const target = path.join(fixture.userHome, '.codex', 'hooks.json');
    const current = JSON.parse(await readFile(target, 'utf8'));
    current.hooks.SessionStart[0].hooks[0].timeout = 99;
    await writeFile(target, JSON.stringify(current, null, 2) + '\n', 'utf8');
    await assert.rejects(
      () => calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['provider.codex-hooks'], roots: fixture.roots }),
      (error) => error.code === 'CODEX_HOOK_MERGE_CONFLICT',
    );
  } finally { await fixture.cleanup(); }
});

test('an unrelated plan never parses or binds native Codex hooks', async () => {
  const fixture = await makeFixture({ setup: async ({ repo, userHome }) => {
    await addCodexHooksArtifact(repo);
    const target = path.join(userHome, '.codex', 'hooks.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'not-json\n', 'utf8');
  } });
  try {
    const planned = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['instructions.global'], roots: fixture.roots, riskOverride: 'content-auto' });
    await writeFile(path.join(fixture.userHome, '.codex', 'hooks.json'), 'still-not-json\n', 'utf8');
    await applyPlan({ planPath: planned.planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
    assert.equal(await readFile(path.join(fixture.userHome, '.codex', 'hooks.json'), 'utf8'), 'still-not-json\n');
  } finally { await fixture.cleanup(); }
});

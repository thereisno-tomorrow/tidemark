import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { describePath, readJson } from '../../lib/fs-safe.mjs';
import { createBackup } from '../../lib/backup.mjs';
import { appendJournal } from '../../lib/state.mjs';
import { currentPlatform } from '../../lib/paths.mjs';
import { templateRoot } from '../helpers.mjs';

// Retain these throwaway directories for failure inspection. No live profile is used.
async function starter() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agent-config-e2e-'));
  const repo = path.join(base, 'repo');
  await cp(path.join(templateRoot, 'examples/starter'), repo, { recursive: true });
  for (const entry of ['lib', 'scripts', 'schemas', 'package.json']) {
    await cp(path.join(templateRoot, entry), path.join(repo, entry), { recursive: true });
  }
  await writeFile(path.join(repo, '.gitignore'), 'dist/\n');
  const env = { ...process.env };
  const isolated = {
    HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'),
    LOCALAPPDATA: path.join(base, 'local'), APPDATA: path.join(base, 'roaming'),
    PROJECTS_ROOT: path.join(base, 'projects'), AGENT_CONFIG_ROOT: repo,
    AGENT_CONFIG_STATE_ROOT: path.join(base, 'state'), TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp'),
  };
  for (const [key, value] of Object.entries(isolated)) {
    assert.ok(path.resolve(value).startsWith(path.resolve(base) + path.sep));
    await mkdir(value, { recursive: true });
    env[key] = value;
    console.log(`${key}=${value}`);
  }
  function invoke(executable, args, expected = 0) {
    const result = spawnSync(executable, args, { cwd: repo, env, encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  }
  const cli = (args, expected = 0) => {
    const result = invoke(process.execPath, ['scripts/agent-config.mjs', ...args], expected);
    return JSON.parse(expected === 2 || expected === 3 ? result.stderr : result.stdout);
  };
  const git = (...args) => invoke('git', args).stdout.trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'example-agent');
  git('config', 'user.email', 'example@example.invalid');
  const commit = () => {
    cli(['validate', '--write-lock']);
    git('add', '--all');
    git('commit', '-m', 'Test configuration');
  };
  commit();
  return { base, repo, home: env.HOME, state: env.AGENT_CONFIG_STATE_ROOT, cli, git, commit };
}

async function stateOf(f) {
  return { home: await describePath(f.home), state: await describePath(f.state), branch: f.git('rev-parse', 'refs/heads/main') };
}

test('CLI starter: a second caller holding the exact plan ID installs; missing and wrong IDs leave state unchanged', async () => {
  const f = await starter();
  const planned = f.cli(['plan', '--out', path.join(f.base, 'plan.json')]);
  assert.equal(planned.confirmation.required, true);
  const before = await stateOf(f);
  for (const extra of [[], ['--confirm-plan-id', 'wrong-id']]) {
    assert.equal(f.cli(['apply', '--plan', planned.planPath, ...extra], 2).error.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(await stateOf(f), before);
  }
  // Every CLI invocation is a separate process. The ID carries no caller identity.
  const installed = f.cli(['apply', '--plan', planned.planPath, '--confirm-plan-id', planned.planId]);
  assert.equal(installed.install.status, 'verified-provisional');
  assert.equal(f.cli(['check']).ok, true);
  const claude = path.join(f.home, '.claude/skills/example-notes');
  const codex = path.join(f.home, '.agents/skills/example-notes');
  assert.equal(await realpath(claude), await realpath(codex));
  assert.ok((await realpath(claude)).startsWith(await realpath(installed.install.releaseRoot) + path.sep));
});

test('CLI limitation: direct edits are allowed and detected only by check; source edits leave installed snapshot bytes unchanged', async () => {
  const f = await starter();
  const planned = f.cli(['plan', '--artifact', 'skills.example-notes', '--out', path.join(f.base, 'plan.json')]);
  const installed = f.cli(['apply', '--plan', planned.planPath]);
  assert.equal(f.cli(['check']).ok, true);
  const target = path.join(f.home, '.claude/skills/example-notes/SKILL.md');
  const original = await readFile(target);
  const source = path.join(f.repo, 'skills/example-notes/SKILL.md');
  await writeFile(source, Buffer.concat([original, Buffer.from('\nSource edit.\n')]));
  assert.deepEqual(await readFile(target), original);
  await writeFile(source, original);
  assert.equal(f.cli(['check']).ok, true);
  const current = await readFile(path.join(f.state, 'installs/current.json'));
  await writeFile(target, Buffer.concat([original, Buffer.from('\nDirect edit.\n')]));
  assert.notDeepEqual(await readFile(target), original);
  assert.deepEqual(await readFile(path.join(f.state, 'installs/current.json')), current);
  const drift = f.cli(['check'], 1);
  assert.equal(drift.installed.ok, false);
  assert.ok(drift.installed.drift.some(item => item.reason.startsWith('release-')));
  // Rollback does not discard an unknown edit. Restore known bytes before rollback.
  await writeFile(target, original);
  f.cli(['rollback', installed.backupId]);
  assert.equal(f.cli(['check']).ok, true);
  assert.equal((await describePath(path.dirname(target))).type, 'absent');
});

test('CLI backs up every touched target before mutation and rollback restores binary bytes, junction topology and absence', async () => {
  const f = await starter();
  const instruction = path.join(f.home, '.claude/CLAUDE.md');
  const original = Buffer.from([0, 255, 13, 10, 65, 0, 66]);
  await mkdir(path.dirname(instruction), { recursive: true });
  await writeFile(instruction, original);
  const first = f.cli(['plan', '--artifact', 'skills.example-notes', '--out', path.join(f.base, 'first.json')]);
  f.cli(['apply', '--plan', first.planPath]);
  const target = path.join(f.home, '.claude/skills/example-notes');
  const topology = await describePath(target);
  const oldRealpath = await realpath(target);
  const second = f.cli(['plan', '--artifact', 'skills.example-notes', '--artifact', 'instructions.global', '--out', path.join(f.base, 'second.json')]);
  const plan = await readJson(second.planPath);
  const preimages = new Map();
  for (const op of plan.operations) if (!preimages.has(op.target)) preimages.set(op.target, await describePath(op.target));
  const result = f.cli(['apply', '--plan', second.planPath]);
  const backupRoot = path.join(f.state, 'backups', result.backupId);
  const backup = await readJson(path.join(backupRoot, 'backup-manifest.json'));
  for (const [targetPath, descriptor] of preimages) {
    const entry = backup.entries.find(item => item.target === targetPath);
    assert.ok(entry, targetPath);
    assert.deepEqual(entry.descriptor, descriptor);
    if (entry.dataPath) assert.equal((await describePath(path.join(backupRoot, entry.dataPath))).hash, descriptor.hash);
  }
  const text = await readFile(path.join(f.state, 'installs/journal', result.install.operationId + '.jsonl'), 'utf8');
  const journal = text.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(journal.findIndex(item => item.phase === 'backup-complete') >= 0);
  assert.ok(journal.findIndex(item => item.phase === 'target-mutated') > journal.findIndex(item => item.phase === 'backup-complete'));
  f.cli(['rollback', result.backupId]);
  assert.deepEqual(await readFile(instruction), original);
  assert.equal((await describePath(target)).type, topology.type);
  assert.equal((await describePath(target)).linkTarget, topology.linkTarget);
  assert.equal(await realpath(target), oldRealpath);
  assert.equal((await describePath(path.join(f.home, '.codex/AGENTS.md'))).type, 'absent');
  assert.equal(f.cli(['check']).ok, true);
});

test('CLI control categories each require the exact plan ID before changing state', async t => {
  const f = await starter();
  await mkdir(path.join(f.repo, 'hooks'), { recursive: true });
  await writeFile(path.join(f.repo, 'hooks/mappings.json'), '{"providers":{"claude":{}}}\n');
  await mkdir(path.join(f.repo, 'mcp'), { recursive: true });
  await writeFile(path.join(f.repo, 'mcp/servers.json'), '{"schemaVersion":1,"servers":[]}\n');
  await cp(path.join(templateRoot, 'providers/claude/settings.patch.json'), path.join(f.repo, 'providers/claude/settings.patch.json'));
  await cp(path.join(templateRoot, 'providers/codex/config.patch.json'), path.join(f.repo, 'providers/codex/config.patch.json'));
  const manifestPath = path.join(f.repo, 'manifest.json');
  const manifest = await readJson(manifestPath);
  for (const [id, kind, provider, source, output, target] of [
    ['provider.claude-settings', 'provider-config', 'claude', ['providers/claude/settings.patch.json', 'hooks/mappings.json'], 'dist/claude/settings.json', '.claude/settings.json'],
    ['provider.codex-config', 'provider-config', 'codex', ['providers/codex/config.patch.json', 'mcp/servers.json'], 'dist/codex/config.toml', '.codex/config.toml'],
    ['provider.codex-hooks', 'hook-config', 'codex', ['providers/codex/hooks.base.json'], 'dist/codex/hooks.json', '.codex/hooks.json'],
  ]) manifest.artifacts.push({ id, kind, ownership: 'shared-generated', providers: [provider], platforms: ['windows'], risk: 'control-confirm', source, outputs: { [provider]: output }, targets: { [provider]: '${USER_HOME}/' + target }, validators: ['json', 'no-secrets'] });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  f.commit();
  for (const id of ['skills.example-formatter', 'agents.example-reviewer', 'provider.claude-settings', 'provider.codex-config', 'provider.codex-hooks']) await t.test(id, async t => {
    const planned = f.cli(['plan', '--artifact', id, '--out', path.join(f.base, id + '.json')]);
    assert.equal(planned.risk, 'control-confirm');
    assert.equal(planned.confirmation.required, true);
    const before = await stateOf(f);
    for (const extra of [[], ['--confirm-plan-id', 'wrong-id']]) {
      assert.equal(f.cli(['apply', '--plan', planned.planPath, ...extra], 2).error.code, 'CONFIRMATION_REQUIRED');
      assert.deepEqual(await stateOf(f), before);
    }
    const installed = f.cli(['apply', '--plan', planned.planPath, '--confirm-plan-id', planned.planId]);
    assert.equal(installed.install.status, 'verified-provisional');
    assert.equal(f.cli(['check']).ok, true);
    if (id === 'provider.codex-config') await t.test('check exits 1 after a direct edit of installed config.toml', async () => {
      const target = path.join(f.home, '.codex/config.toml');
      const original = await readFile(target, 'utf8');
      await writeFile(target, original.replace('# BEGIN agent-config managed mcp\n', '# BEGIN agent-config managed mcp\n# Direct edit.\n'));
      assert.notEqual(await readFile(target, 'utf8'), original);
      const checked = f.cli(['check'], 1);
      assert.equal(checked.source.ok, true);
      assert.equal(checked.installed.ok, false);
      assert.ok(checked.installed.drift.some(item => item.artifactId === id && item.target === target && item.reason === 'content-drift'));
      assert.ok(!checked.installed.drift.some(item => item.reason === 'desired-state-build-failed'));
      await writeFile(target, original);
      assert.equal(f.cli(['check']).ok, true);
    });
    f.cli(['rollback', installed.backupId]);
  });
});

test('CLI failed transaction leaves the deployment branch unchanged', async () => {
  const f = await starter();
  const before = f.git('rev-parse', 'refs/heads/main');
  const begun = f.cli(['transaction', 'begin', '--artifact', 'skills.example-formatter', '--provider', 'codex', '--request', 'Test failed patch']);
  const patch = path.join(f.base, 'patch.json');
  await writeFile(patch, JSON.stringify({ changes: [{ op: 'replace', path: 'skills/example-formatter/scripts/format.mjs', expectedHash: 'wrong-hash', content: '// changed\n' }] }));
  f.cli(['transaction', 'patch', begun.transactionId, '--patch', patch], 2);
  f.cli(['transaction', 'promote', begun.transactionId], 2);
  assert.equal(f.git('rev-parse', 'refs/heads/main'), before);
  assert.equal((await describePath(path.join(f.state, 'installs/current.json'))).type, 'absent');
});

test('CLI recover without apply leaves the entire interrupted fixture unchanged', async () => {
  const f = await starter();
  const roots = { USER_HOME: f.home, AGENT_CONFIG_ROOT: f.repo, AGENT_CONFIG_STATE_ROOT: f.state, PROJECTS_ROOT: path.join(f.base, 'projects'), PLATFORM: currentPlatform() };
  const target = path.join(f.home, '.claude/CLAUDE.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'Before interrupted apply.\n');
  const backup = await createBackup(f.state, [target], roots);
  await writeFile(target, 'After interrupted apply.\n');
  const operationId = 'example-interrupted';
  await appendJournal(f.state, operationId, { phase: 'started', action: 'apply', planId: 'example' });
  await appendJournal(f.state, operationId, { phase: 'backup-complete', backupId: backup.manifest.backupId });
  await appendJournal(f.state, operationId, { phase: 'target-mutated', target, postimage: await describePath(target) });
  const before = await describePath(f.base);
  const preview = f.cli(['recover']);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.candidateOperations.length, 1);
  assert.deepEqual(preview.affectedTargets, [target]);
  assert.ok(preview.recoveryPlanId);
  assert.deepEqual(await describePath(f.base), before);
  assert.deepEqual(f.cli(['recover']), preview);
  assert.deepEqual(await describePath(f.base), before);
});

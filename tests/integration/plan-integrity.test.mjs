import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { applyPlan } from '../../lib/apply.mjs';
import { canonicalize, withContentId } from '../../lib/canonical-json.mjs';
import { describePath, readJson } from '../../lib/fs-safe.mjs';
import { calculatePlan } from '../../lib/planner.mjs';
import { makeFixture, templateRoot } from '../helpers.mjs';

// Same isolated starter as the end-to-end CLI tests. Throwaway directories are retained for inspection.
async function starter() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agent-config-integrity-'));
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

// The forger edits a copy of a real plan and recomputes its content ID, so the digest check passes.
async function forge(f, name, planPath, edit) {
  const plan = await readJson(planPath);
  await edit(plan);
  const forged = withContentId(plan);
  const forgedPath = path.join(f.base, `${name}.json`);
  await writeFile(forgedPath, canonicalize(forged));
  return { forged, forgedPath };
}

function assertMismatch(result, expectedPointers) {
  assert.equal(result.error.code, 'PLAN_MISMATCH', JSON.stringify(result));
  for (const pointer of expectedPointers) {
    assert.ok(result.error.details.differences.some((item) => item === pointer || item.startsWith(`${pointer}/`)), `${pointer} not in ${result.error.details.differences}`);
    assert.ok(result.error.message.includes(pointer), result.error.message);
  }
}

test('CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID', async (t) => {
  const f = await starter();
  const commitA = { commit: f.git('rev-parse', 'HEAD'), tree: f.git('rev-parse', 'HEAD^{tree}') };
  await appendFile(path.join(f.repo, 'skills/example-notes/SKILL.md'), '\nKeep each bullet under twenty words.\n');
  f.commit();
  const victim = path.join(f.home, '.claude', 'victim.md');
  await mkdir(path.dirname(victim), { recursive: true });
  await writeFile(victim, 'Existing in-root file.\n');
  const formatter = f.cli(['plan', '--artifact', 'skills.example-formatter', '--out', path.join(f.base, 'formatter.json')]);
  assert.equal(formatter.risk, 'control-confirm');
  assert.equal(formatter.confirmation.required, true);
  const notes = f.cli(['plan', '--artifact', 'skills.example-notes', '--out', path.join(f.base, 'notes.json')]);
  const original = await readFile(formatter.planPath);
  const before = await stateOf(f);

  const attempt = async (name, planPath, edit, expectedPointers, { confirm = true, setup = null } = {}) => {
    await t.test(name, async () => {
      const { forged, forgedPath } = await forge(f, name, planPath, edit);
      if (setup) f.git(...setup);
      try {
        const result = f.cli(['apply', '--plan', forgedPath, ...(confirm ? ['--confirm-plan-id', forged.planId] : [])], 2);
        assertMismatch(result, expectedPointers);
      } finally {
        if (setup) f.git('checkout', 'main');
      }
      assert.deepEqual(await stateOf(f), before);
      assert.equal((await describePath(path.join(f.state, 'backups'))).type, 'absent');
      assert.equal((await describePath(path.join(f.state, 'installs', 'current.json'))).type, 'absent');
    });
  };

  await attempt('1. confirmation.required set to false, digest recomputed', formatter.planPath, (plan) => {
    plan.confirmation.required = false;
  }, ['/confirmation/required'], { confirm: false });

  await attempt('2. control-confirm risk lowered to content-auto', formatter.planPath, (plan) => {
    plan.risk = 'content-auto';
    plan.confirmation = { required: false, reason: null };
  }, ['/risk', '/confirmation/required', '/confirmation/reason'], { confirm: false });

  await attempt('3. backup scope and operation entries omitted', formatter.planPath, (plan) => {
    plan.operations = plan.operations.slice(0, 1);
    plan.backupScope = [];
  }, ['/operations/1', '/backupScope']);

  await attempt('4. operation target swapped to another in-root file', formatter.planPath, async (plan) => {
    plan.operations[0].target = victim;
    plan.operations[0].preimage = await describePath(victim);
    plan.backupScope = [...new Set(plan.operations.map((operation) => operation.target))].sort();
  }, ['/operations/0/target', '/operations/0/preimage', '/backupScope']);

  await attempt('5. extra operation appended', formatter.planPath, async (plan) => {
    const target = path.join(f.home, '.claude', 'skills', 'example-extra');
    plan.operations.push({ ...structuredClone(plan.operations[0]), index: plan.operations.length, target, preimage: await describePath(target) });
    plan.backupScope = [...new Set(plan.operations.map((operation) => operation.target))].sort();
  }, [`/operations/${2}`, '/backupScope']);

  await attempt('6a. source commit and tree rebound to an older commit that is checked out', notes.planPath, (plan) => {
    plan.source.commit = commitA.commit;
    plan.source.tree = commitA.tree;
  }, ['/source/treeDigest', '/release/sourceTreeDigest'], { confirm: false, setup: ['checkout', '--detach', commitA.commit] });

  await attempt('6b. source tree digest binding changed', notes.planPath, (plan) => {
    plan.source.treeDigest = 'f'.repeat(64);
    plan.release.sourceTreeDigest = 'f'.repeat(64);
  }, ['/source/treeDigest', '/release/sourceTreeDigest'], { confirm: false });

  await t.test('7. control: the unmodified plan with its exact ID still installs', async () => {
    assert.deepEqual(await readFile(formatter.planPath), original);
    assert.deepEqual(await stateOf(f), before);
    const installed = f.cli(['apply', '--plan', formatter.planPath, '--confirm-plan-id', formatter.planId]);
    assert.equal(installed.install.status, 'verified-provisional');
    assert.equal(installed.install.planId, formatter.planId);
    assert.equal(f.cli(['check']).ok, true);
    assert.equal(await readFile(victim, 'utf8'), 'Existing in-root file.\n');
  });
});

test('CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs', async () => {
  const f = await starter();
  const begun = f.cli(['transaction', 'begin', '--artifact', 'skills.example-notes', '--provider', 'codex', '--request', 'Add one sentence to the notes skill']);
  const current = f.cli(['transaction', 'read', begun.transactionId, 'skills/example-notes/SKILL.md']);
  const patch = path.join(f.base, 'patch.json');
  await writeFile(patch, JSON.stringify({ changes: [{ op: 'replace', path: current.path, expectedHash: current.hash, content: `${current.content}\nKeep each bullet short.\n` }] }));
  f.cli(['transaction', 'patch', begun.transactionId, '--patch', patch]);
  f.cli(['transaction', 'test', begun.transactionId]);
  const gated = f.cli(['transaction', 'promote', begun.transactionId]);
  assert.equal(gated.phase, 'awaiting-confirmation');
  const original = await readFile(gated.planPath);
  const plan = JSON.parse(original.toString('utf8'));
  const forged = withContentId({ ...plan, confirmation: { required: false, reason: null }, authorization: null });
  await writeFile(gated.planPath, canonicalize(forged));
  const before = await stateOf(f);
  const refused = f.cli(['transaction', 'promote', begun.transactionId, '--confirm-plan-id', forged.planId], 2);
  assertMismatch(refused, ['/authorization', '/confirmation/required', '/confirmation/reason']);
  assert.deepEqual(await stateOf(f), before);
  await writeFile(gated.planPath, original);
  const installed = f.cli(['transaction', 'promote', begun.transactionId, '--confirm-plan-id', gated.planId]);
  assert.equal(installed.phase, 'verified-provisional');
  assert.equal(f.cli(['check']).ok, true);
});

test('direct library apply re-derives a forged plan file with no declared inputs and refuses lowered risk', async () => {
  const fixture = await makeFixture();
  try {
    const { planPath } = await calculatePlan({ root: fixture.repo, stateRoot: fixture.state, artifactIds: ['bootstrap.agent-config-maintainer'], roots: fixture.roots });
    const plan = await readJson(planPath);
    assert.equal(plan.confirmation.required, true);
    const forged = withContentId({ ...plan, risk: 'content-auto', confirmation: { required: false, reason: null } });
    const forgedPath = path.join(fixture.tempRoot, 'forged.json');
    await writeFile(forgedPath, canonicalize(forged));
    const before = { home: await describePath(fixture.userHome), state: await describePath(fixture.state) };
    await assert.rejects(
      () => applyPlan({ planPath: forgedPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots }),
      (error) => error.code === 'PLAN_MISMATCH' && ['/risk', '/confirmation/required'].every((pointer) => error.details.differences.includes(pointer)),
    );
    assert.deepEqual({ home: await describePath(fixture.userHome), state: await describePath(fixture.state) }, before);
    const installed = await applyPlan({ planPath, root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots, confirmationPlanId: plan.planId });
    assert.equal(installed.install.planId, plan.planId);
  } finally { await fixture.cleanup(); }
});

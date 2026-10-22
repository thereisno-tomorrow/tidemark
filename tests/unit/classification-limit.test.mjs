import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { effectivePathRisk } from '../../lib/manifest.mjs';
import { templateRoot } from '../helpers.mjs';

// This test documents a limit. It asserts current behavior, not desired behavior.
// Same isolated starter as the end-to-end CLI tests. Throwaway directories are retained for inspection.
test('limitation: risk classification is by path and type, so a script-header file under references plans as content-only', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'agent-config-classification-'));
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
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: repo, env, encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };

  // A script-header file inside the content-auto starter skill, with an allowed content extension.
  const relative = 'skills/example-notes/references/guide.txt';
  await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
  await writeFile(path.join(repo, relative), '#!/bin/sh\necho "example reference"\n');
  run('git', ['init', '--initial-branch=main']);
  run('git', ['config', 'user.name', 'example-agent']);
  run('git', ['config', 'user.email', 'example@example.invalid']);
  run(process.execPath, ['scripts/agent-config.mjs', 'validate', '--write-lock']);
  run('git', ['add', '--all']);
  run('git', ['commit', '-m', 'Test configuration']);
  assert.match(run('git', ['show', `HEAD:${relative}`]), /^#!/);

  const planned = JSON.parse(run(process.execPath, ['scripts/agent-config.mjs', 'plan', '--artifact', 'skills.example-notes', '--out', path.join(base, 'plan.json')]));
  const plan = JSON.parse(await readFile(planned.planPath, 'utf8'));
  assert.deepEqual(plan.artifacts, ['skills.example-notes']);
  assert.equal(planned.risk, 'content-auto');
  assert.equal(plan.risk, 'content-auto');
  assert.deepEqual(plan.confirmation, { required: false, reason: null });

  // The same path with a script extension is control-confirm: the file type decides, not the content.
  const policy = JSON.parse(await readFile(path.join(repo, 'automation/policy.json'), 'utf8'));
  assert.equal(effectivePathRisk(relative, 'content-auto', policy), 'content-auto');
  assert.equal(effectivePathRisk(relative.replace(/\.txt$/, '.sh'), 'content-auto', policy), 'control-confirm');
});

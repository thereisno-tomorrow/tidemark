import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const command = process.argv[2];
if (!['prepare', 'validate', 'plan'].includes(command)) throw new Error('Use prepare, validate or plan');
const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.resolve(process.env.AGENT_CONFIG_DEMO_ROOT || path.join(os.tmpdir(), 'agent-config-starter-demo'));
const repo = path.join(demo, 'config');
const isolated = {
  HOME: path.join(demo, 'home'), USERPROFILE: path.join(demo, 'home'),
  LOCALAPPDATA: path.join(demo, 'local'), APPDATA: path.join(demo, 'roaming'),
  PROJECTS_ROOT: path.join(demo, 'projects'), AGENT_CONFIG_ROOT: repo,
  AGENT_CONFIG_STATE_ROOT: path.join(demo, 'state'), TEMP: path.join(demo, 'tmp'), TMP: path.join(demo, 'tmp'),
};
if (command === 'prepare' && fs.existsSync(demo)) throw new Error('Demo already exists; choose a new AGENT_CONFIG_DEMO_ROOT');
if (command !== 'prepare' && !fs.existsSync(path.join(repo, '.git'))) throw new Error('Run prepare first');
for (const [key, value] of Object.entries(isolated)) {
  const relative = path.relative(demo, value);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe demo path: ${key}`);
  fs.mkdirSync(value, { recursive: true });
  process.env[key] = value;
  console.log(`${key}=${value}`);
}
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: repo, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const controller = (...args) => run(process.execPath, [path.join(repo, 'scripts', 'agent-config.mjs'), ...args]);
if (command === 'prepare') {
  fs.cpSync(path.join(engine, 'examples', 'starter'), repo, { recursive: true });
  // Planning materializes a complete release, including the controller runtime.
  for (const entry of ['lib', 'scripts', 'schemas', 'package.json']) {
    fs.cpSync(path.join(engine, entry), path.join(repo, entry), { recursive: true, filter: source => path.basename(source) !== 'starter-demo.mjs' });
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  run('git', ['init', '--initial-branch=main']);
  run('git', ['config', 'user.name', 'example-agent']);
  run('git', ['config', 'user.email', 'example@example.invalid']);
  controller('validate', '--write-lock');
  run('git', ['add', '--all']);
  run('git', ['diff', '--cached', '--check']);
  run('git', ['commit', '-m', 'Prepare starter configuration']);
} else controller(command, ...(command === 'plan' ? ['--out', path.join(demo, 'plan.json')] : []));

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { describePath } from '../../lib/fs-safe.mjs';
import { makeFixture, templateRoot } from '../helpers.mjs';

test('runtime has zero package dependencies and only built-in or relative literal imports', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg, 'dependencies'), false);
  let count = 0;
  for (const folder of ['lib', 'scripts']) {
    for (const file of fs.readdirSync(path.join(templateRoot, folder), { recursive: true }).filter(name => name.endsWith('.mjs'))) {
      const content = fs.readFileSync(path.join(templateRoot, folder, file), 'utf8');
      const specifiers = [...content.matchAll(/^import\s+[^\n]*?\bfrom\s*['"]([^'"\r\n]+)['"]|\bimport\s*\(\s*['"]([^'"\r\n]+)['"]|^import\s*['"]([^'"\r\n]+)['"]/gm)];
      for (const match of specifiers) {
        const specifier = match[1] || match[2] || match[3];
        assert.ok(specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'), `${folder}/${file}: ${specifier}`);
        count++;
      }
      assert.doesNotMatch(content, /\brequire\s*\(/, file);
      assert.doesNotMatch(content, /\bimport\s*\(\s*[^'"\s]/, file);
    }
  }
  assert.ok(count > 100, 'scan must inspect the runtime imports');
});

test('limitation: experimental sync is disabled by default, writes nothing and invokes no network or child process', async t => {
  const fixture = await makeFixture();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(fixture.repo, 'automation/trusted-remotes.json')));
    assert.equal(config.enabled, false);
    const starter = JSON.parse(fs.readFileSync(path.join(templateRoot, 'examples/starter/automation/trusted-remotes.json')));
    assert.equal(starter.enabled, false);
    const before = { repo: await describePath(fixture.repo), state: await describePath(fixture.state), home: await describePath(fixture.userHome) };
    let attempts = 0;
    const deny = () => { attempts++; throw new Error('Disabled sync attempted external I/O'); };
    const mocks = [];
    for (const [object, names] of [
      [childProcess, ['spawnSync', 'spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
      [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']],
      [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']],
      [dgram, ['createSocket']], [dns, ['lookup', 'resolve']], [globalThis, ['fetch']],
    ]) for (const name of names) mocks.push(t.mock.method(object, name, deny));
    syncBuiltinESMExports();
    try {
      const { syncTrustedRelease } = await import('../../lib/sync.mjs');
      const result = await syncTrustedRelease({ root: fixture.repo, stateRoot: fixture.state, roots: fixture.roots });
      assert.deepEqual(result, { ok: false, status: 'disabled', blocker: 'trusted-remotes-disabled' });
      assert.equal(attempts, 0);
      assert.deepEqual({ repo: await describePath(fixture.repo), state: await describePath(fixture.state), home: await describePath(fixture.userHome) }, before);
    } finally {
      for (const mock of mocks) mock.mock.restore();
      syncBuiltinESMExports();
    }
  } finally { await fixture.cleanup(); }
});

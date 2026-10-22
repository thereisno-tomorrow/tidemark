import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestIssuer, consumeToken, issueToken } from '../../lib/authorization.mjs';
import { digestObject } from '../../lib/canonical-json.mjs';
import { loadConfiguration } from '../../lib/manifest.mjs';
import { makeFixture } from '../helpers.mjs';

function claims(now, requestDigest) {
  return {
    issuer: 'fixture', provider: 'codex', artifactId: 'skills.demo', scope: 'local-only',
    requestDigest, nonce: 'nonce-0123456789abcdef', iat: Math.floor(now / 1000) - 1,
    exp: Math.floor(now / 1000) + 60,
  };
}

test('trusted-origin tokens are signed, scoped, expiring, and replay protected', async () => {
  const fixture = await makeFixture();
  try {
    const issuer = createTestIssuer();
    const { policy } = await loadConfiguration(fixture.repo);
    const now = Date.now();
    const requestDigest = digestObject({ request: 'Update demo.' });
    const token = issueToken(claims(now, requestDigest), issuer.privateKey);
    const expected = { provider: 'codex', artifactId: 'skills.demo', scope: 'local-only', requestDigest };
    const result = await consumeToken({ token, expected, publicKey: issuer.publicKey, stateRoot: fixture.state, policy, now });
    assert.equal(result.claims.artifactId, 'skills.demo');
    await assert.rejects(() => consumeToken({ token, expected, publicKey: issuer.publicKey, stateRoot: fixture.state, policy, now }), (error) => error.code === 'TOKEN_REPLAY');
    const tampered = `${token.slice(0, -2)}aa`;
    await assert.rejects(() => consumeToken({ token: tampered, expected, publicKey: issuer.publicKey, stateRoot: fixture.state, policy, now }), (error) => error.code === 'TOKEN_SIGNATURE_INVALID');
  } finally { await fixture.cleanup(); }
});

test('expired and widened tokens fail closed before replay state is written', async () => {
  const fixture = await makeFixture();
  try {
    const issuer = createTestIssuer();
    const { policy } = await loadConfiguration(fixture.repo);
    const now = Date.now();
    const requestDigest = digestObject({ request: 'Update demo.' });
    const expiredClaims = claims(now, requestDigest);
    expiredClaims.iat = Math.floor(now / 1000) - 120;
    expiredClaims.exp = Math.floor(now / 1000) - 60;
    const expired = issueToken(expiredClaims, issuer.privateKey);
    const expected = { provider: 'codex', artifactId: 'skills.demo', scope: 'local-only', requestDigest };
    await assert.rejects(() => consumeToken({ token: expired, expected, publicKey: issuer.publicKey, stateRoot: fixture.state, policy, now }), (error) => error.code === 'TOKEN_EXPIRED');
    const widened = issueToken(claims(now, requestDigest), issuer.privateKey);
    await assert.rejects(() => consumeToken({ token: widened, expected: { ...expected, artifactId: 'skills.other' }, publicKey: issuer.publicKey, stateRoot: fixture.state, policy, now }), (error) => error.code === 'TOKEN_SCOPE_MISMATCH');
  } finally { await fixture.cleanup(); }
});

import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalize, digestObject, sha256 } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWriteJson, pathExists, readJson } from './fs-safe.mjs';
import { ensureWithin } from './paths.mjs';
import { ensureStateLayout } from './state.mjs';

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : canonicalize(value), 'utf8').toString('base64url');
}

function decode(value) {
  return Buffer.from(value, 'base64url');
}

export function issueToken(claims, privateKey) {
  const payload = { version: 1, ...claims };
  const encoded = encode(payload);
  const signature = sign(null, Buffer.from(encoded, 'utf8'), privateKey).toString('base64url');
  return `${encoded}.${signature}`;
}

export function createTestIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

export async function consumeToken({ token, expected, publicKey, stateRoot, policy, now = Date.now() }) {
  invariant(typeof token === 'string' && token.split('.').length === 2, 'TOKEN_INVALID', 'Trusted-origin token has invalid format');
  const [encoded, signature] = token.split('.');
  invariant(verify(null, Buffer.from(encoded, 'utf8'), publicKey, decode(signature)), 'TOKEN_SIGNATURE_INVALID', 'Trusted-origin token signature is invalid');
  let claims;
  try { claims = JSON.parse(decode(encoded).toString('utf8')); } catch { throw new AgentConfigError('TOKEN_INVALID', 'Trusted-origin token payload is invalid'); }
  invariant(claims.version === 1, 'TOKEN_VERSION', 'Unsupported token version');
  invariant(typeof claims.iat === 'number' && typeof claims.exp === 'number', 'TOKEN_TIME_INVALID', 'Token timestamps are required');
  const skew = policy.token.clockSkewSeconds * 1000;
  invariant(now + skew >= claims.iat * 1000, 'TOKEN_NOT_YET_VALID', 'Token is not yet valid');
  invariant(now - skew <= claims.exp * 1000, 'TOKEN_EXPIRED', 'Token has expired');
  invariant(claims.exp - claims.iat <= policy.token.maxTtlSeconds, 'TOKEN_TTL_TOO_WIDE', 'Token lifetime exceeds policy');
  for (const field of ['provider', 'artifactId', 'scope', 'requestDigest']) {
    invariant(claims[field] === expected[field], 'TOKEN_SCOPE_MISMATCH', `Token ${field} does not match request`, { expected: expected[field], actual: claims[field] });
  }
  invariant(policy.token.allowedScopes.includes(claims.scope), 'TOKEN_SCOPE_DENIED', `Token scope is denied: ${claims.scope}`);
  invariant(typeof claims.nonce === 'string' && claims.nonce.length >= 16, 'TOKEN_NONCE_INVALID', 'Token nonce is missing or too short');
  const state = await ensureStateLayout(stateRoot);
  const replayRoot = path.join(state.authorizations, 'consumed-nonces');
  await mkdir(replayRoot, { recursive: true, mode: 0o700 });
  const nonceDigest = sha256(claims.nonce);
  const replayPath = ensureWithin(replayRoot, path.join(replayRoot, `${nonceDigest}.json`));
  try { await mkdir(replayPath); } catch (error) {
    if (error.code === 'EEXIST') throw new AgentConfigError('TOKEN_REPLAY', 'Trusted-origin token was already consumed');
    throw error;
  }
  await atomicWriteJson(path.join(replayPath, 'record.json'), { consumedAt: new Date(now).toISOString(), tokenDigest: sha256(token) });
  return { claims, nonceDigest, issuerDigest: sha256(publicKey) };
}

export async function createAuthorization({ provider, artifactId, scope, request, token = null, publicKey = null, stateRoot, policy, now = Date.now() }) {
  const requestDigest = digestObject({ request: String(request).trim() });
  const authorizationId = randomUUID();
  let originAssurance = 'provider-context';
  let tokenEvidence = null;
  if (token) {
    invariant(publicKey, 'ISSUER_KEY_MISSING', 'A pinned issuer public key is required for trusted-origin tokens');
    tokenEvidence = await consumeToken({ token, expected: { provider, artifactId, scope, requestDigest }, publicKey, stateRoot, policy, now });
    originAssurance = 'trusted-local-token';
  }
  const record = {
    schemaVersion: 1, authorizationId, provider, originAssurance, artifactId, scope,
    requestDigest, issuerDigest: tokenEvidence?.issuerDigest ?? null,
    tokenNonceDigest: tokenEvidence?.nonceDigest ?? null,
    createdAt: new Date(now).toISOString(),
    expiresAt: tokenEvidence ? new Date(tokenEvidence.claims.exp * 1000).toISOString() : null,
    status: tokenEvidence ? 'consumed' : 'pending',
  };
  const state = await ensureStateLayout(stateRoot);
  await atomicWriteJson(path.join(state.authorizations, `${authorizationId}.json`), record);
  return record;
}

export async function authorizationStatus({ root, stateRoot, policy, providers = ['claude', 'codex'] }) {
  const state = await ensureStateLayout(stateRoot);
  const issuerPath = path.join(state.authorizations, 'issuer-public-key.pem');
  const issuerPresent = await pathExists(issuerPath);
  const issuerDigest = issuerPresent ? sha256(await readFile(issuerPath)) : null;
  return providers.map((provider) => {
    const enabled = policy.zeroConfirmationProviders.includes(provider) && issuerPresent;
    return {
      provider,
      mode: enabled ? 'trusted-local-token' : 'provider-context',
      zeroConfirmation: enabled,
      issuerDigest,
      replayStore: path.join(state.authorizations, 'consumed-nonces'),
      adversarialTests: enabled ? 'required-before-enablement' : 'not-enabled',
      defaultScope: 'local-only',
    };
  });
}

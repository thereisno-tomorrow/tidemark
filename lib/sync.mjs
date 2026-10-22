import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { applyPlan } from './apply.mjs';
import { canonicalize, digestObject } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWriteJson, pathExists, readJson } from './fs-safe.mjs';
import { runGit, verifySignedTag } from './git.mjs';
import { effectivePathRisk, loadConfiguration } from './manifest.mjs';
import { calculatePlan } from './planner.mjs';
import { resolveRoots } from './paths.mjs';
import { ensureStateLayout } from './state.mjs';
import { validateRepository } from './validators.mjs';

function artifactsForPaths(paths) {
  const result = new Set();
  for (const relative of paths) {
    const normalized = relative.replaceAll('\\', '/');
    const skill = normalized.match(/^skills\/([^/]+)\//)?.[1];
    if (skill) result.add(`skills.${skill}`);
    else if (normalized.startsWith('instructions/') || /providers\/(claude|codex)\/instructions\.append\.md$/.test(normalized)) result.add('instructions.global');
  }
  return [...result];
}

async function verifyAttestation(state, tag, commit, policyDigest, configuration) {
  const target = path.join(state.sync, 'attestations', `${tag}.json`);
  invariant(await pathExists(target), 'CI_ATTESTATION_MISSING', `CI attestation is missing for ${tag}`);
  const attestation = await readJson(target);
  const issuer = configuration.trustedRemotes.ciAttestation.issuers.find((item) => item.id === attestation.issuer);
  invariant(issuer && !issuer.revoked, 'CI_ISSUER_UNTRUSTED', `CI attestation issuer is not trusted: ${attestation.issuer}`);
  invariant(attestation.commit === commit && attestation.policyDigest === policyDigest && attestation.tag === tag, 'CI_ATTESTATION_SCOPE', 'CI attestation is bound to different release content');
  const age = Date.now() - Date.parse(attestation.issuedAt);
  invariant(age >= 0 && age <= configuration.trustedRemotes.ciAttestation.maxAgeSeconds * 1000, 'CI_ATTESTATION_EXPIRED', 'CI attestation is expired');
  const signed = structuredClone(attestation);
  delete signed.signature;
  const key = await readFile(issuer.publicKeyPath, 'utf8');
  invariant(verify(null, Buffer.from(canonicalize(signed), 'utf8'), key, Buffer.from(attestation.signature, 'base64url')), 'CI_ATTESTATION_SIGNATURE', 'CI attestation signature is invalid');
  return attestation;
}

export async function syncTrustedRelease({ root, stateRoot, roots: providedRoots = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const configuration = await loadConfiguration(roots.AGENT_CONFIG_ROOT);
  if (!configuration.trustedRemotes.enabled) return { ok: false, status: 'disabled', blocker: 'trusted-remotes-disabled' };
  const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
  const remote = configuration.trustedRemotes.remotes.find((item) => item.enabled !== false);
  invariant(remote?.name, 'TRUSTED_REMOTE_MISSING', 'No enabled trusted remote is configured');
  runGit(roots.AGENT_CONFIG_ROOT, ['fetch', '--tags', '--prune', remote.name, configuration.manifest.deploymentBranch]);
  const tags = runGit(roots.AGENT_CONFIG_ROOT, ['tag', '--list', 'agent-config-v*', '--sort=-creatordate']).trim().split(/\r?\n/).filter(Boolean);
  invariant(tags.length, 'TRUSTED_RELEASE_MISSING', 'No signed release tags were fetched');
  const tag = tags[0];
  const signerFile = path.join(roots.AGENT_CONFIG_ROOT, 'automation', 'trusted-signers');
  const commit = verifySignedTag(roots.AGENT_CONFIG_ROOT, tag, signerFile);
  const current = await pathExists(state.current) ? await readJson(state.current) : null;
  const base = current?.sourceCommit ?? current?.commit ?? runGit(roots.AGENT_CONFIG_ROOT, ['merge-base', commit, `${remote.name}/${configuration.manifest.deploymentBranch}`]).trim();
  const ancestor = spawnSync('git', ['-c', `safe.directory=${roots.AGENT_CONFIG_ROOT}`, '-C', roots.AGENT_CONFIG_ROOT, 'merge-base', '--is-ancestor', base, commit]);
  invariant(ancestor.status === 0, 'NON_FAST_FORWARD', 'Trusted release is not a fast-forward from the installed release');
  const changedPaths = runGit(roots.AGENT_CONFIG_ROOT, ['diff', '--name-only', base, commit]).trim().split(/\r?\n/).filter(Boolean);
  invariant(changedPaths.length, 'NO_SYNC_CHANGE', 'Trusted release contains no change');
  const locallyControl = changedPaths.filter((relative) => {
    const normalized = relative.replaceAll('\\', '/');
    if (normalized === 'manifest.lock.json') return false;
    const contentCandidate = normalized.startsWith('skills/') || normalized.startsWith('instructions/') || /providers\/(claude|codex)\/instructions\.append\.md$/.test(normalized);
    return !contentCandidate || effectivePathRisk(normalized, 'content-auto', configuration.policy) !== 'content-auto';
  });
  invariant(locallyControl.length === 0, 'SYNC_CONTROL_CHANGE', 'Remote release contains locally classified control-plane changes', { paths: locallyControl });
  const policyDigest = digestObject({ policy: configuration.policy, routing: configuration.routing, trustedRemotes: configuration.trustedRemotes });
  const attestation = await verifyAttestation(state, tag, commit, policyDigest, configuration);
  const worktree = path.join(state.sync, 'worktrees', commit);
  runGit(roots.AGENT_CONFIG_ROOT, ['worktree', 'add', '--detach', worktree, commit]);
  try {
    const validation = await validateRepository(worktree);
    invariant(validation.ok, 'VALIDATION_FAILED', 'Fetched release fails local validation', { issues: validation.issues });
    const artifactIds = artifactsForPaths(changedPaths);
    invariant(artifactIds.length, 'SYNC_ROUTING_FAILED', 'Changed paths do not resolve to deployable content artifacts');
    const { plan, planPath } = await calculatePlan({ root: worktree, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, artifactIds, roots, deploymentBase: base, riskOverride: 'content-auto' });
    invariant(plan.risk === 'content-auto' && !plan.confirmation.required, 'SYNC_RISK_FAILED', 'Local plan is not eligible for unattended content sync');
    const result = await applyPlan({ planPath, root: worktree, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, planContext: { deploymentBase: base, riskOverride: 'content-auto' } });
    const active = { ...result.install, status: 'active', tagName: tag, sourceCommit: commit, syncState: 'synchronized', ciAttestation: { issuer: attestation.issuer, issuedAt: attestation.issuedAt } };
    await atomicWriteJson(state.current, active);
    return { ok: true, status: 'synchronized', tag, commit, releaseId: active.releaseId };
  } finally {
    runGit(roots.AGENT_CONFIG_ROOT, ['worktree', 'remove', '--force', worktree]);
  }
}

import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, digestObject, withContentId } from './canonical-json.mjs';
import { TOOL_VERSION } from './constants.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWrite, describePath, hashTree, listTree, matchesDescriptor, pathExists, readJson } from './fs-safe.mjs';
import { generateOutputs } from './generator.mjs';
import { materializeCommit, repositoryState, runGit } from './git.mjs';
import { effectivePathRisk, expandArtifactDependencies, inspectFrontmatterRisk, loadConfiguration, resolveArtifacts } from './manifest.mjs';
import { ensureWithin, expandTokens, resolveRoots } from './paths.mjs';
import { statePaths } from './state.mjs';
import { validateRepository } from './validators.mjs';

async function overallRisk(root, artifacts, policy) {
  if (artifacts.some((artifact) => artifact.risk !== 'content-auto')) return 'control-confirm';
  for (const artifact of artifacts) {
    for (const source of artifact.source) {
      const absolute = path.join(root, source);
      const descriptor = await describePath(absolute);
      const files = descriptor.type === 'directory'
        ? (await listTree(absolute)).filter((entry) => entry.type === 'file').map((entry) => path.posix.join(source.replaceAll('\\', '/'), entry.path))
        : [source];
      for (const relative of files) {
        if (effectivePathRisk(relative, artifact.risk, policy) === 'control-confirm') return 'control-confirm';
        if (path.extname(relative).toLowerCase() === '.md' && await inspectFrontmatterRisk(path.join(root, relative), artifact.risk, policy, relative) === 'control-confirm') return 'control-confirm';
      }
    }
  }
  return 'content-auto';
}

export function targetRootAllowed(target, roots) {
  return [path.join(roots.USER_HOME, '.claude'), path.join(roots.USER_HOME, '.codex'), path.join(roots.USER_HOME, '.agents'), path.join(roots.AGENT_CONFIG_STATE_ROOT, 'controller')]
    .some((allowed) => {
      const relative = path.relative(allowed, target);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

export async function suiteDesiredTargets(artifact, roots) {
  invariant(artifact.kind === 'external-suite', 'SUITE_ARTIFACT_REQUIRED', 'Expected an external-suite artifact');
  const state = statePaths(roots.AGENT_CONFIG_STATE_ROOT);
  const objectRoot = ensureWithin(state.suiteObjects, path.join(state.suiteObjects, artifact.suite.objectDigest));
  const objectDescriptor = await describePath(objectRoot);
  invariant(objectDescriptor.type === 'directory' && objectDescriptor.hash === artifact.suite.objectDigest, 'SUITE_OBJECT_MISSING', `Verified suite object is unavailable: ${artifact.id}`, { objectRoot, expectedDigest: artifact.suite.objectDigest, actual: objectDescriptor });
  for (const relative of artifact.suite.health ?? []) {
    const probe = ensureWithin(objectRoot, path.join(objectRoot, relative));
    const descriptor = await describePath(probe);
    invariant(['file', 'directory'].includes(descriptor.type), 'SUITE_HEALTH_FAILED', `Suite health path is missing: ${relative}`, { artifactId: artifact.id });
  }
  const targets = [];
  const seen = new Set();
  for (const link of artifact.suite.links) {
    const target = expandTokens(link.target, roots);
    invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', `Suite target is outside provider roots: ${target}`);
    invariant(!seen.has(target), 'DUPLICATE_TARGET', `External suite declares a duplicate target: ${target}`);
    seen.add(target);
    const linkTarget = ensureWithin(objectRoot, path.join(objectRoot, link.source));
    const sourceDescriptor = await describePath(linkTarget);
    invariant(['file', 'directory'].includes(sourceDescriptor.type), 'SUITE_SOURCE_MISSING', `Suite projection source is missing: ${link.source}`, { artifactId: artifact.id });
    targets.push({
      provider: link.provider,
      target,
      postimage: { type: 'link', hash: null, linkTarget, source: link.source, objectRoot, objectDigest: artifact.suite.objectDigest },
    });
  }
  return targets;
}

export async function desiredForArtifact(artifact, provider, releaseRoot, roots) {
  const target = expandTokens(artifact.targets[provider], roots);
  invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', `Target is outside provider roots: ${target}`);
  if (artifact.ownership === 'shared-generated') {
    const relativeSource = artifact.outputs?.[provider]
      ?? (artifact.kind === 'custom-agent'
      ? `dist/${provider}/agents/${artifact.id.slice('agents.'.length)}.${provider === 'claude' ? 'md' : 'toml'}`
      : provider === 'claude' ? 'dist/claude/CLAUDE.md' : 'dist/codex/AGENTS.md');
    const source = path.join(releaseRoot, relativeSource);
    return { type: 'file', hash: (await describePath(source)).hash, source: relativeSource };
  }
  // foreign-owned deploys exactly like shared-link: the vendored bytes live in the
  // immutable release source and both providers link at them. Ownership says who may
  // edit the content; it does not change how the content is delivered.
  if (['shared-link', 'foreign-owned'].includes(artifact.ownership) || (artifact.ownership === 'provider-only' && artifact.kind === 'skill')) {
    const stableSource = artifact.id === 'bootstrap.agent-config-maintainer'
      ? path.join(roots.AGENT_CONFIG_STATE_ROOT, 'active', 'source', 'bootstrap', 'agent-config-maintainer')
      : path.join(roots.AGENT_CONFIG_STATE_ROOT, 'active', 'source', artifact.source[0]);
    return { type: 'link', hash: null, linkTarget: stableSource, source: artifact.source[0] };
  }
  throw new AgentConfigError('OWNERSHIP_NOT_IMPLEMENTED', `Planner does not deploy ownership class ${artifact.ownership}`);
}

// Declared inputs of plans calculated in this process, keyed by content ID. A plan read from
// anywhere else (a CLI file, a forged copy with a recomputed ID) has no entry and is
// re-derived with no declared inputs, exactly as the plan command calculates.
const plannedInputs = new Map();

export async function calculatePlan({ root, stateRoot, out, authorization = null, artifactIds = null, roots: providedRoots = null, deploymentBase = null, riskOverride = null, adoption = null, persist = true }) {
  const sourceRoot = path.resolve(root);
  const roots = providedRoots || resolveRoots({ root: sourceRoot, stateRoot });
  const state = statePaths(roots.AGENT_CONFIG_STATE_ROOT);
  const repo = repositoryState(sourceRoot);
  invariant(repo.clean, 'DIRTY_SOURCE', 'Manual source worktree must be clean', { paths: repo.status });
  const validation = await validateRepository(sourceRoot);
  invariant(validation.ok, 'VALIDATION_FAILED', 'Source validation failed', { issues: validation.issues });
  const configuration = await loadConfiguration(sourceRoot);
  const recordedDeploymentBase = deploymentBase
    ?? runGit(sourceRoot, ['rev-parse', '--verify', `refs/heads/${configuration.manifest.deploymentBranch}`]).trim();
  const allArtifacts = await resolveArtifacts(sourceRoot, configuration.manifest);
  if (artifactIds) {
    const knownArtifactIds = new Set(allArtifacts.map((artifact) => artifact.id));
    const missingRequested = artifactIds.filter((artifactId) => !knownArtifactIds.has(artifactId));
    invariant(missingRequested.length === 0, 'EMPTY_PLAN', 'No deployable artifacts selected', { artifacts: missingRequested });
  }
  const requestedArtifacts = artifactIds ? expandArtifactDependencies(allArtifacts, artifactIds) : allArtifacts;
  if (artifactIds) {
    const unavailable = requestedArtifacts.filter((artifact) => artifact.risk === 'not-deployable' || !artifact.platforms.includes(roots.PLATFORM));
    invariant(unavailable.length === 0, 'ARTIFACT_DEPENDENCY_UNAVAILABLE', 'One or more selected artifacts or dependencies cannot deploy on this platform', { artifacts: unavailable.map((artifact) => artifact.id) });
  }
  const artifacts = requestedArtifacts.filter((artifact) => artifact.risk !== 'not-deployable' && artifact.platforms.includes(roots.PLATFORM));
  invariant(artifacts.length > 0, 'EMPTY_PLAN', 'No deployable artifacts selected');
  if (adoption) {
    const artifactIdsInPlan = artifacts.map((artifact) => artifact.id);
    const exactForwardRepair = adoption.mode === 'forward-repair-adoption'
      && artifactIdsInPlan.length === 2
      && new Set(artifactIdsInPlan).size === 2
      && artifactIdsInPlan.includes('controller.runtime-v0.1.0')
      && artifactIdsInPlan.includes('skills.example-runtime');
    const exactOrdinaryAdoption = adoption.mode !== 'forward-repair-adoption'
      && artifacts.length === 1 && artifacts[0].id === adoption.artifactId;
    invariant(exactForwardRepair || exactOrdinaryAdoption, 'ADOPTION_PLAN_SCOPE', 'Adoption plans must contain exactly the permitted artifact set');
    const canonicalSource = await describePath(path.join(sourceRoot, adoption.canonicalSource.path));
    invariant(matchesDescriptor(canonicalSource, adoption.canonicalSource.postimage), 'ADOPTION_SOURCE_DRIFT', 'Adopted canonical source changed before planning');
    for (const expected of adoption.providerPreimages) {
      const actual = await describePath(expected.target);
      invariant(matchesDescriptor(actual, expected.descriptor), 'ADOPTION_PREIMAGE_DRIFT', `Adoption provider preimage changed before planning: ${expected.target}`, { expected: expected.descriptor, actual });
    }
  }
  const buildRoot = path.join(os.tmpdir(), `agent-config-plan-build-${randomUUID()}`);
  const artifactSetDigest = digestObject({ artifactIds: artifacts.map((artifact) => artifact.id) }).replace(/^sha256:/, "").slice(0, 12);
  const releaseId = `${repo.commit.slice(0, 12)}-${repo.tree.slice(0, 12)}-${artifactSetDigest}`;
  const previewRelease = path.join(buildRoot, releaseId);
  try {
    await materializeCommit(sourceRoot, repo.commit, path.join(previewRelease, 'source'));
    if (adoption) {
      const materializedSource = await describePath(path.join(previewRelease, 'source', adoption.canonicalSource.path));
      const expectedMaterialized = adoption.mode === 'forward-repair-adoption'
        ? adoption.originalDirectoryDescriptor
        : adoption.canonicalSource.postimage;
      invariant(matchesDescriptor(materializedSource, expectedMaterialized), 'ADOPTION_MATERIALIZED_SOURCE_MISMATCH', 'Committed adoption source is not byte-identical to the recorded original', { expected: expectedMaterialized, actual: materializedSource });
    }
    const generated = await generateOutputs(path.join(previewRelease, 'source'), path.join(previewRelease, 'dist'), roots, { artifactIds: artifacts.map((artifact) => artifact.id) });
    const operations = [];
    for (const artifact of artifacts) {
      if (artifact.kind === 'external-suite') {
        for (const desired of await suiteDesiredTargets(artifact, roots)) {
          const preimage = await describePath(desired.target);
          if (desired.postimage.type === 'link' && preimage.type === 'directory') {
            operations.push({
              index: operations.length, type: 'quarantine-known-directory', artifactId: artifact.id,
              provider: desired.provider, target: desired.target, preimage,
              postimage: { type: 'absent', hash: null, linkTarget: null },
              quarantineRelative: `quarantine/${String(operations.length).padStart(4, '0')}`,
            });
          } else if (!['absent', desired.postimage.type].includes(preimage.type)) {
            throw new AgentConfigError('TARGET_TYPE_CONFLICT', `Target type conflicts with external suite projection: ${desired.target}`, { preimage, postimage: desired.postimage });
          }
          operations.push({
            index: operations.length, type: 'ensure-link', artifactId: artifact.id,
            provider: desired.provider, target: desired.target,
            preimage: preimage.type === 'directory' ? { type: 'absent', size: 0, hash: null, linkTarget: null } : preimage,
            postimage: desired.postimage,
          });
        }
        continue;
      }
      if (artifact.kind === 'legacy-retirement') {
        for (const legacy of artifact.legacyTargets ?? []) {
          const target = expandTokens(legacy.path, roots);
          invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', `Legacy target is outside provider roots: ${target}`);
          const preimage = await describePath(target);
          if (preimage.type === 'absent') continue;
          // A managed shared-link skill installs as a junction, not a directory, so declared
          // retirement has to accept both. The operation keeps the name quarantine-known-directory:
          // apply renames the target aside either way, and renaming the type would churn the plan
          // schema, recorded install operationTypes, and existing history for no behavioural gain.
          invariant(['directory', 'link'].includes(preimage.type), 'TARGET_TYPE_CONFLICT', `Legacy retirement only accepts an exact known directory or link: ${target}`);
          operations.push({
            index: operations.length, type: 'quarantine-known-directory', artifactId: artifact.id,
            provider: legacy.provider, target, preimage,
            postimage: { type: 'absent', size: 0, hash: null, linkTarget: null },
            quarantineRelative: `quarantine/${String(operations.length).padStart(4, '0')}`,
          });
        }
        continue;
      }
      if (artifact.kind === 'controller-runtime') {
        const target = expandTokens(artifact.targets.state, roots);
        invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', `Controller target is outside its versioned state root: ${target}`);
        const preimage = await describePath(target);
        invariant(['absent', 'directory'].includes(preimage.type), 'TARGET_TYPE_CONFLICT', `Controller target type conflicts: ${target}`);
        const relativeSource = artifact.outputs.state;
        const postimage = { type: 'directory', hash: (await describePath(path.join(previewRelease, relativeSource))).hash, linkTarget: null, source: relativeSource };
        operations.push({ index: operations.length, type: 'replace-directory', artifactId: artifact.id, provider: 'state', target, preimage, postimage });
        continue;
      }
      for (const provider of artifact.providers) {
        const target = expandTokens(artifact.targets?.[provider], roots);
        const preimage = await describePath(target);
        const postimage = await desiredForArtifact(artifact, provider, previewRelease, roots);
        if (postimage.type === 'link' && preimage.type === 'directory') {
          operations.push({
            index: operations.length,
            type: 'quarantine-known-directory',
            artifactId: artifact.id,
            provider,
            target,
            preimage,
            postimage: { type: 'absent', hash: null, linkTarget: null },
            quarantineRelative: `quarantine/${String(operations.length).padStart(4, '0')}`,
          });
        } else if (!['absent', postimage.type].includes(preimage.type)) {
          throw new AgentConfigError('TARGET_TYPE_CONFLICT', `Target type conflicts with desired output: ${target}`, { preimage, postimage });
        }
        operations.push({ index: operations.length, type: postimage.type === 'file' ? 'replace-file' : 'ensure-link', artifactId: artifact.id, provider, target, preimage: preimage.type === 'directory' ? { type: 'absent', size: 0, hash: null, linkTarget: null } : preimage, postimage });
      }
    }
    const policyDigest = digestObject({ policy: configuration.policy, routing: configuration.routing, trustedRemotes: configuration.trustedRemotes });
    const risk = riskOverride ?? await overallRisk(sourceRoot, artifacts, configuration.policy);
    invariant(['content-auto', 'control-confirm'].includes(risk), 'RISK_OVERRIDE_INVALID', `Invalid plan risk: ${risk}`);
    const body = {
      schemaVersion: 1,
      toolVersion: TOOL_VERSION,
      createdAt: repo.commitTime,
      source: { root: sourceRoot, canonicalRoot: roots.AGENT_CONFIG_ROOT, commit: repo.commit, tree: repo.tree, treeDigest: await hashTree(path.join(previewRelease, 'source')), branch: repo.branch, clean: true, deploymentBranch: configuration.manifest.deploymentBranch, deploymentBase: recordedDeploymentBase },
      platform: roots.PLATFORM,
      policyDigest,
      risk,
      authorization,
      artifacts: artifacts.map((artifact) => artifact.id),
      operations,
      backupScope: [...new Set(operations.map((operation) => operation.target))].sort(),
      release: { releaseId, sourceTreeDigest: await hashTree(path.join(previewRelease, 'source')), generatedDigest: generated.digest, snapshotPath: path.join(state.releases, releaseId) },
      receipts: [{ type: 'validation', digest: digestObject({ issues: validation.issues, lock: validation.lock }), passed: true }],
      confirmation: { required: risk === 'control-confirm' || authorization?.originAssurance === 'provider-context', reason: risk === 'control-confirm' ? 'control-confirm' : authorization?.originAssurance === 'provider-context' ? 'provider-context' : null },
      adoption,
    };
    const plan = withContentId(body);
    if (!persist) return { plan, planPath: null };
    plannedInputs.set(plan.planId, structuredClone({ authorization, deploymentBase, riskOverride, adoption }));
    const planPath = path.resolve(out || path.join(os.tmpdir(), 'agent-config-plans', `${plan.planId.replace(':', '-')}.json`));
    if (await pathExists(planPath)) {
      const existing = await readJson(planPath);
      invariant(canonicalize(existing) === canonicalize(plan), 'PLAN_ID_COLLISION', `Existing plan content differs: ${planPath}`);
    } else await atomicWrite(planPath, canonicalize(plan), { mode: 0o600 });
    return { plan, planPath };
  } finally {
    if (await pathExists(buildRoot)) await rm(buildRoot, { recursive: true });
  }
}

export function verifyPlanDigest(plan, { requireToolVersion = true } = {}) {
  const body = structuredClone(plan);
  delete body.planId;
  invariant(digestObject(body) === plan.planId, 'PLAN_TAMPERED', 'Plan content digest is invalid');
  if (requireToolVersion) invariant(plan.toolVersion === TOOL_VERSION, 'TOOL_VERSION_MISMATCH', `Plan requires ${plan.toolVersion}, running ${TOOL_VERSION}`);
  return true;
}

// Only the planning time and the content ID may differ; every other field must re-derive.
const PLAN_VARYING_FIELDS = new Set(['planId', 'createdAt']);

function planDifferences(saved, derived, pointer = '') {
  if (canonicalize(saved) === canonicalize(derived)) return [];
  const nested = pointer.split('/').length <= 3 && saved && derived && typeof saved === 'object' && typeof derived === 'object';
  if (!nested) return [pointer];
  return [...new Set([...Object.keys(saved), ...Object.keys(derived)])]
    .filter((key) => pointer || !PLAN_VARYING_FIELDS.has(key))
    .flatMap((key) => planDifferences(saved[key], derived[key], `${pointer}/${key}`));
}

// Re-derive a saved plan from the current source and state and refuse any difference. Inputs
// that cannot be derived (authorization, deployment base, risk override, adoption) come from
// the caller, else from this process's own calculatePlan call, else they are absent.
export async function verifyPlanIntegrity(plan, { root, roots, context = null }) {
  invariant(Array.isArray(plan.artifacts) && plan.artifacts.length > 0, 'PLAN_MISMATCH', 'Plan artifact list is missing or empty', { differences: ['/artifacts'] });
  const inputs = context ?? plannedInputs.get(plan.planId) ?? {};
  const { plan: derived } = await calculatePlan({
    root, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, artifactIds: plan.artifacts, persist: false,
    authorization: inputs.authorization ?? null, deploymentBase: inputs.deploymentBase ?? null,
    riskOverride: inputs.riskOverride ?? null, adoption: inputs.adoption ?? null,
  });
  const differences = planDifferences(plan, derived);
  invariant(differences.length === 0, 'PLAN_MISMATCH', `Plan differs from the plan re-derived from current source and state at ${differences.slice(0, 12).join(', ')}`, { differences });
  return true;
}

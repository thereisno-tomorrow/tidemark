import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, digestObject } from './canonical-json.mjs';
import { TOOL_VERSION } from './constants.mjs';
import { createBackup, loadBackup, restoreBackupEntry } from './backup.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWrite, atomicWriteJson, copyTree, describePath, matchesDescriptor, pathExists, readJson } from './fs-safe.mjs';
import { generateOutputs } from './generator.mjs';
import { materializeCommit, repositoryState } from './git.mjs';
import { expandArtifactDependencies, loadConfiguration, resolveArtifacts } from './manifest.mjs';
import { assertNarrowTarget, ensureWithin, expandTokens, resolveRoots } from './paths.mjs';
import { desiredForArtifact, suiteDesiredTargets, targetRootAllowed, verifyPlanDigest, verifyPlanIntegrity } from './planner.mjs';
import { acquireLock, appendJournal, ensureStateLayout, restoreActive, statePaths, switchActive } from './state.mjs';

function providerRootFor(target, roots) {
  return [path.join(roots.USER_HOME, '.claude'), path.join(roots.USER_HOME, '.codex'), path.join(roots.USER_HOME, '.agents')]
    .find((root) => {
      const relative = path.relative(root, target);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

async function verifyPreimages(plan) {
  const virtual = new Map();
  for (const operation of plan.operations) {
    const actual = virtual.get(operation.target) ?? await describePath(operation.target);
    invariant(matchesDescriptor(actual, operation.preimage), 'STALE_PLAN', `Target preimage changed: ${operation.target}`, { expected: operation.preimage, actual });
    virtual.set(operation.target, operation.postimage);
  }
}

async function verifyRelease(releaseRoot, plan) {
  const source = await describePath(path.join(releaseRoot, 'source'));
  const dist = await describePath(path.join(releaseRoot, 'dist'));
  invariant(source.hash === plan.release.sourceTreeDigest, 'RELEASE_SOURCE_MISMATCH', 'Materialized source digest differs from plan');
  invariant(dist.hash === plan.release.generatedDigest, 'RELEASE_GENERATION_MISMATCH', 'Generated output digest differs from plan');
}

async function applyOperation(operation, releaseRoot, backupRoot, roots, stateRoot, operationId) {
  assertNarrowTarget(operation.target, roots);
  const controllerRoot = path.join(roots.AGENT_CONFIG_STATE_ROOT, 'controller');
  const allowedRoot = operation.type === 'replace-directory' ? controllerRoot : providerRootFor(operation.target, roots);
  invariant(allowedRoot, 'TARGET_ROOT_DENIED', `Target is outside provider roots: ${operation.target}`);
  ensureWithin(allowedRoot, operation.target);
  await mkdir(path.dirname(operation.target), { recursive: true });
  if (operation.type === 'quarantine-known-directory') {
    const actual = await describePath(operation.target);
    invariant(matchesDescriptor(actual, operation.preimage), 'STALE_PLAN', `Directory changed before quarantine: ${operation.target}`);
    const quarantine = ensureWithin(backupRoot, path.join(backupRoot, operation.quarantineRelative));
    await mkdir(path.dirname(quarantine), { recursive: true });
    await rename(operation.target, quarantine);
    await appendJournal(stateRoot, operationId, { phase: 'target-mutated', operationIndex: operation.index, action: operation.type, target: operation.target, quarantine, postimage: operation.postimage });
    return;
  }
  const actual = await describePath(operation.target);
  invariant(matchesDescriptor(actual, operation.preimage), 'STALE_PLAN', `Target changed before mutation: ${operation.target}`);
  if (operation.type === 'replace-directory') {
    const staged = path.join(path.dirname(operation.target), `.${path.basename(operation.target)}.${operationId}.staged`);
    await copyTree(path.join(releaseRoot, operation.postimage.source), staged);
    const stagedDescriptor = await describePath(staged);
    invariant(stagedDescriptor.hash === operation.postimage.hash, 'POSTIMAGE_VERIFY_FAILED', `Staged controller digest differs: ${operation.target}`);
    if (actual.type === 'directory') {
      const old = path.join(path.dirname(operation.target), `.${path.basename(operation.target)}.${operationId}.old`);
      await rename(operation.target, old);
      await rename(staged, operation.target);
      await rm(old, { recursive: true });
    } else await rename(staged, operation.target);
  } else if (operation.type === 'replace-file') {
    await atomicWrite(operation.target, await readFile(path.join(releaseRoot, operation.postimage.source)));
  } else if (operation.type === 'ensure-link') {
    if (operation.postimage.objectDigest) {
      const suiteObject = await describePath(operation.postimage.objectRoot);
      invariant(suiteObject.type === 'directory' && suiteObject.hash === operation.postimage.objectDigest, 'SUITE_OBJECT_CHANGED', `Suite object changed after planning: ${operation.postimage.objectRoot}`, { expected: operation.postimage.objectDigest, actual: suiteObject });
    }
    if (actual.type !== 'absent') await rm(operation.target, { recursive: actual.type === 'directory' });
    const linkType = process.platform === 'win32'
      ? (await lstat(operation.postimage.linkTarget)).isDirectory() ? 'junction' : 'file'
      : undefined;
    try {
      await symlink(operation.postimage.linkTarget, operation.target, linkType);
    } catch (error) {
      if (linkType === 'file' && ['EPERM', 'EACCES'].includes(error.code)) {
        throw new AgentConfigError('FILE_SYMLINK_DENIED',
          `Windows denied file symlink creation for ${operation.target}. Enable Developer Mode or run with administrator rights, or use shared-copy ownership for this artifact.`,
          { cause: error.code, target: operation.target });
      }
      throw error;
    }
  } else throw new AgentConfigError('UNKNOWN_OPERATION', `Unsupported operation: ${operation.type}`);
  const post = await describePath(operation.target);
  invariant(matchesDescriptor(post, operation.postimage), 'POSTIMAGE_VERIFY_FAILED', `Installed postimage differs: ${operation.target}`, { expected: operation.postimage, actual: post });
  await appendJournal(stateRoot, operationId, { phase: 'target-mutated', operationIndex: operation.index, action: operation.type, target: operation.target, postimage: operation.postimage });
}

export async function applyPlan({ planPath, root, stateRoot, confirmationPlanId = null, roots: providedRoots = null, localOnly = false, planContext = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const plan = await readJson(path.resolve(planPath));
  verifyPlanDigest(plan);
  invariant(plan.platform === roots.PLATFORM, 'PLATFORM_MISMATCH', `Plan is for ${plan.platform}, running ${roots.PLATFORM}`);
  if (plan.confirmation.required) invariant(confirmationPlanId === plan.planId, 'CONFIRMATION_REQUIRED', `Exact plan confirmation required: ${plan.planId}`);
  // Read-only refusals, including the re-derivation, all happen before the lock, backup or any write.
  const sourceRoot = path.resolve(root || plan.source.root);
  invariant(sourceRoot === path.resolve(plan.source.root), 'SOURCE_ROOT_MISMATCH', 'Apply source root does not match the immutable plan');
  invariant(!plan.source.canonicalRoot || path.resolve(plan.source.canonicalRoot) === path.resolve(roots.AGENT_CONFIG_ROOT), 'CANONICAL_ROOT_MISMATCH', 'Runtime canonical root does not match the immutable plan');
  const repo = repositoryState(sourceRoot);
  invariant(repo.commit === plan.source.commit && repo.tree === plan.source.tree, 'SOURCE_CHANGED', 'Authoring repository no longer matches the plan source');
  invariant(repo.clean, 'DIRTY_SOURCE', 'Manual source worktree is dirty');
  await verifyPreimages(plan);
  await verifyPlanIntegrity(plan, { root: sourceRoot, roots, context: planContext });
  const lock = await acquireLock(roots.AGENT_CONFIG_STATE_ROOT, 'promotion');
  const operationId = randomUUID();
  let backup = null;
  const appliedPostimages = new Map();
  let releaseRoot = null;
  let previousActive = null;
  let activeSwitched = false;
  try {
    await verifyPreimages(plan);
    const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
    const previousInstall = await pathExists(state.current) ? await readJson(state.current) : null;
    const storedPlanPath = path.join(state.plans, `${plan.planId.replace(':', '-')}.json`);
    if (await pathExists(storedPlanPath)) {
      invariant(canonicalize(await readJson(storedPlanPath)) === canonicalize(plan), 'PLAN_ID_COLLISION', `Stored plan content differs: ${storedPlanPath}`);
    } else await atomicWrite(storedPlanPath, canonicalize(plan), { mode: 0o600 });
    releaseRoot = ensureWithin(state.releases, plan.release.snapshotPath);
    invariant(!await pathExists(releaseRoot), 'RELEASE_EXISTS', `Release snapshot already exists: ${releaseRoot}`);
    await mkdir(releaseRoot, { recursive: true });
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'started', action: 'apply', planId: plan.planId, releaseId: plan.release.releaseId });
    await materializeCommit(sourceRoot, plan.source.commit, path.join(releaseRoot, 'source'));
    await generateOutputs(path.join(releaseRoot, 'source'), path.join(releaseRoot, 'dist'), roots, { artifactIds: plan.artifacts });
    await verifyRelease(releaseRoot, plan);
    await atomicWriteJson(path.join(releaseRoot, 'release-manifest.json'), {
      schemaVersion: 1, releaseId: plan.release.releaseId, sourceCommit: plan.source.commit,
      sourceTreeDigest: plan.release.sourceTreeDigest, generatedDigest: plan.release.generatedDigest,
      generatorVersion: TOOL_VERSION, planId: plan.planId,
    });
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'candidate-preflight-passed', releaseRoot });
    backup = await createBackup(roots.AGENT_CONFIG_STATE_ROOT, plan.backupScope, roots);
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'backup-complete', backupId: backup.manifest.backupId, backupDigest: backup.manifest.manifestDigest });
    previousActive = await switchActive(roots.AGENT_CONFIG_STATE_ROOT, releaseRoot, operationId);
    activeSwitched = true;
    for (const operation of plan.operations) {
      try {
        await applyOperation(operation, releaseRoot, backup.root, roots, roots.AGENT_CONFIG_STATE_ROOT, operationId);
      } catch (error) {
        // A denied symlink can follow removal of an existing link. Let the
        // normal rollback restore its backup from the known absent postimage.
        if (error.code === 'FILE_SYMLINK_DENIED') {
          appliedPostimages.set(operation.target, { type: 'absent', size: 0, hash: null, linkTarget: null });
        }
        throw error;
      }
      appliedPostimages.set(operation.target, operation.postimage);
    }
    const latestOperations = new Map();
    for (const operation of plan.operations) latestOperations.set(operation.target, operation);
    const targets = [];
    for (const operation of latestOperations.values()) {
      const actual = await describePath(operation.target);
      invariant(matchesDescriptor(actual, operation.postimage), 'POST_INSTALL_FAILED', `Post-install verification failed: ${operation.target}`);
      const original = plan.operations.find((item) => item.target === operation.target);
      targets.push({ target: operation.target, preimage: original.preimage, postimage: operation.postimage, operationType: operation.type });
    }
    const previousPlan = previousInstall?.planPath ? await readJson(previousInstall.planPath) : null;
    const priorArtifactIds = previousInstall?.status !== 'rolled-back'
      ? (previousInstall?.activeArtifacts ?? previousPlan?.artifacts ?? [])
      : [];
    const releaseConfiguration = await loadConfiguration(path.join(releaseRoot, 'source'));
    const availableArtifactIds = new Set((await resolveArtifacts(path.join(releaseRoot, 'source'), releaseConfiguration.manifest)).map((artifact) => artifact.id));
    const activeArtifacts = [...new Set([
      ...priorArtifactIds.filter((artifactId) => availableArtifactIds.has(artifactId)),
      ...plan.artifacts,
    ])].sort();
    const status = localOnly ? 'active-local' : 'verified-provisional';
    const install = {
      schemaVersion: 1, status, operationId, releaseId: plan.release.releaseId, releaseRoot,
      planId: plan.planId, planPath: storedPlanPath, installedAt: new Date().toISOString(), backupId: backup.manifest.backupId,
      previousActive, activeArtifacts, targets, automationDisabled: localOnly,
    };
    await atomicWriteJson(state.current, install);
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'apply-complete', status, currentDigest: digestObject(install) });
    return { ok: true, install, backupId: backup.manifest.backupId };
  } catch (error) {
    await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'apply-failed', code: error.code ?? 'INTERNAL', message: error.message });
    if (backup) {
      try {
        const rollbackResult = await rollbackBackup({
          backupId: backup.manifest.backupId,
          root: roots.AGENT_CONFIG_ROOT,
          stateRoot: roots.AGENT_CONFIG_STATE_ROOT,
          roots,
          expectedInstall: {
            releaseRoot: activeSwitched ? releaseRoot : null,
            previousActive: activeSwitched ? previousActive : null,
            targets: [...appliedPostimages].map(([target, postimage]) => ({ target, postimage })),
          },
        });
        await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, {
          phase: 'apply-rollback-complete',
          action: 'automatic-rollback',
          status: rollbackResult.status,
          backupId: backup.manifest.backupId,
        });
      }
      catch (rollbackError) {
        throw new AgentConfigError('ROLLBACK_CONFLICT', `Apply failed and rollback was incomplete: ${error.message}`, { cause: error.code, rollback: rollbackError.message });
      }
    }
    throw error;
  } finally { await lock.release(); }
}

export async function rollbackBackup({ backupId, root, stateRoot, roots: providedRoots = null, expectedInstall = undefined }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
  const backup = await loadBackup(roots.AGENT_CONFIG_STATE_ROOT, backupId);
  const install = expectedInstall === null ? null : expectedInstall ?? (await pathExists(state.current) ? await readJson(state.current) : null);
  const operationId = randomUUID();
  const conflicts = [];
  const entriesToRestore = [];
  await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'rollback-started', backupId });
  for (const entry of backup.manifest.entries) {
    const post = install?.targets.find((target) => target.target === entry.target)?.postimage;
    const actual = await describePath(entry.target);
    if (post) {
      if (!matchesDescriptor(actual, post)) { conflicts.push({ target: entry.target, expected: post, actual }); continue; }
    } else if (matchesDescriptor(actual, entry.descriptor)) {
      continue;
    } else {
      conflicts.push({ target: entry.target, expected: entry.descriptor, actual });
      continue;
    }
    entriesToRestore.push(entry);
  }
  // Shared links point through state/active. Restore that indirection before
  // recreating junctions, otherwise Windows cannot inspect their now-missing target.
  if (install?.releaseRoot) {
    try { await restoreActive(roots.AGENT_CONFIG_STATE_ROOT, install.releaseRoot, install.previousActive, operationId); }
    catch (error) { conflicts.push({ target: state.active, error: error.message }); }
  }
  for (const entry of entriesToRestore) {
    try {
      await restoreBackupEntry(backup.root, entry, roots);
      await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'rollback-path-restored', target: entry.target });
    } catch (error) { conflicts.push({ target: entry.target, error: error.message }); }
  }
  const finalStatus = conflicts.length ? 'rollback-conflict' : 'rolled-back';
  if (install) await atomicWriteJson(state.current, { ...install, status: finalStatus, rolledBackAt: new Date().toISOString(), conflicts, automationDisabled: true });
  await appendJournal(roots.AGENT_CONFIG_STATE_ROOT, operationId, { phase: 'rollback-complete', status: finalStatus, conflicts });
  if (conflicts.length) throw new AgentConfigError('ROLLBACK_CONFLICT', 'Rollback preserved one or more changed objects', { conflicts });
  return { ok: true, status: finalStatus, backupId };
}

function driftReason(expected, actual, { retired = false } = {}) {
  if (retired) return 'retired-target-reappeared';
  if (actual.type === 'absent') return 'missing-target';
  if (actual.type !== expected.type) return 'type-drift';
  if (expected.type === 'link') return 'link-drift';
  return 'content-drift';
}

async function buildExpectedTargets(install, roots) {
  const sourceRoot = path.join(install.releaseRoot, 'source');
  const configuration = await loadConfiguration(sourceRoot);
  const allArtifacts = await resolveArtifacts(sourceRoot, configuration.manifest);
  const installedPlan = await readJson(install.planPath);
  const activeArtifactIds = new Set(install.activeArtifacts ?? installedPlan?.artifacts ?? []);
  const knownArtifactIds = new Set(allArtifacts.map((artifact) => artifact.id));
  const unknownActive = [...activeArtifactIds].filter((artifactId) => !knownArtifactIds.has(artifactId));
  invariant(unknownActive.length === 0, 'ACTIVE_ARTIFACT_UNKNOWN', 'Active install names artifacts absent from its release manifest', { artifacts: unknownActive });
  const activeClosure = expandArtifactDependencies(allArtifacts, activeArtifactIds);
  const missingDependencies = activeClosure.filter((artifact) => !activeArtifactIds.has(artifact.id)).map((artifact) => artifact.id);
  invariant(missingDependencies.length === 0, 'ACTIVE_DEPENDENCY_MISSING', 'Active install is missing one or more required artifact dependencies', { artifacts: missingDependencies });
  const artifacts = activeClosure.filter((artifact) => artifact.risk !== 'not-deployable'
    && artifact.platforms.includes(roots.PLATFORM));
  const buildRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-config-check-'));
  const previewRelease = path.join(buildRoot, 'release');
  const targets = [];
  const seen = new Map();
  const add = (entry) => {
    invariant(!seen.has(entry.target), 'DUPLICATE_TARGET', 'Two active artifacts resolve to the same target: ' + entry.target, {
      first: seen.get(entry.target), second: entry.artifactId,
    });
    seen.set(entry.target, entry.artifactId);
    targets.push(entry);
  };
  try {
    await mkdir(previewRelease, { recursive: true });
    await generateOutputs(sourceRoot, path.join(previewRelease, 'dist'), roots, { artifactIds: artifacts.map((artifact) => artifact.id) });
    for (const artifact of artifacts) {
      if (artifact.kind === 'external-suite') {
        for (const desired of await suiteDesiredTargets(artifact, roots)) {
          add({ artifactId: artifact.id, provider: desired.provider, target: desired.target, expected: desired.postimage, comparison: 'descriptor' });
        }
        continue;
      }
      if (artifact.kind === 'legacy-retirement') {
        for (const legacy of artifact.legacyTargets ?? []) {
          const target = expandTokens(legacy.path, roots);
          invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', 'Legacy target is outside provider roots: ' + target);
          add({
            artifactId: artifact.id, provider: legacy.provider, target, retired: true,
            expected: { type: 'absent', size: 0, hash: null, linkTarget: null },
          });
        }
        continue;
      }
      if (artifact.kind === 'controller-runtime') {
        const target = expandTokens(artifact.targets.state, roots);
        invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', 'Controller target is outside its versioned state root: ' + target);
        add({
          artifactId: artifact.id, provider: 'state', target,
          expected: { type: 'directory', hash: (await describePath(path.join(previewRelease, artifact.outputs.state))).hash, linkTarget: null, source: artifact.outputs.state },
        });
        continue;
      }
      for (const provider of artifact.providers) {
        const target = expandTokens(artifact.targets?.[provider], roots);
        const expected = await desiredForArtifact(artifact, provider, previewRelease, roots);
        const comparison = expected.type === 'file' && path.extname(expected.source).toLowerCase() === '.json' ? 'json-semantic' : 'descriptor';
        if (comparison === 'json-semantic') {
          const parsed = JSON.parse(await readFile(path.join(previewRelease, expected.source), 'utf8'));
          expected.semanticHash = digestObject(parsed);
        }
        add({ artifactId: artifact.id, provider, target, expected, comparison });
      }
    }
    return { artifacts: artifacts.length, targets };
  } finally {
    if (await pathExists(buildRoot)) await rm(buildRoot, { recursive: true });
  }
}

export async function checkInstalled({ root, stateRoot, roots: providedRoots = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
  if (!await pathExists(state.current)) return { ok: true, installed: false, checkedTargets: 0, drift: [] };
  const install = await readJson(state.current);
  if (install.status === 'rolled-back') return { ok: true, installed: false, install, checkedTargets: 0, drift: [] };
  const drift = [];
  const record = (reason, target, expected, actual, metadata = {}) => {
    drift.push({ reason, target, expected, actual, artifactId: metadata.artifactId ?? null, provider: metadata.provider ?? null });
  };

  const active = await describePath(state.active);
  if (active.type !== 'link' || path.resolve(active.linkTarget ?? '') !== path.resolve(install.releaseRoot)) {
    record('active-release-drift', state.active, { type: 'link', linkTarget: install.releaseRoot }, active);
  }
  const release = await describePath(install.releaseRoot);
  if (release.type !== 'directory') {
    record('release-missing', install.releaseRoot, { type: 'directory' }, release);
    return { ok: false, installed: true, install, checkedTargets: 0, declaredArtifacts: 0, drift };
  }

  let plan = null;
  try {
    invariant(await pathExists(install.planPath), 'PLAN_MISSING', 'Installed plan is missing');
    plan = await readJson(install.planPath);
    verifyPlanDigest(plan, { requireToolVersion: false });
    if (plan.planId !== install.planId) record('install-plan-mismatch', install.planPath, { planId: install.planId }, { planId: plan.planId });
    if (plan.release.releaseId !== install.releaseId) record('install-release-mismatch', install.releaseRoot, { releaseId: install.releaseId }, { releaseId: plan.release.releaseId });
    if (path.resolve(plan.release.snapshotPath) !== path.resolve(install.releaseRoot)) {
      record('install-release-path-mismatch', install.releaseRoot, { releaseRoot: plan.release.snapshotPath }, { releaseRoot: install.releaseRoot });
    }
  } catch (error) {
    record('plan-invalid', install.planPath, { planId: install.planId }, { code: error.code ?? 'INTERNAL', message: error.message });
  }

  let sourceTrusted = false;
  if (plan) {
    const sourcePath = path.join(install.releaseRoot, 'source');
    const source = await describePath(sourcePath);
    const expectedSource = { type: 'directory', hash: plan.release.sourceTreeDigest };
    if (!matchesDescriptor(source, expectedSource)) record('release-source-drift', sourcePath, expectedSource, source);
    else sourceTrusted = true;

    const distPath = path.join(install.releaseRoot, 'dist');
    const dist = await describePath(distPath);
    const expectedDist = { type: 'directory', hash: plan.release.generatedDigest };
    if (!matchesDescriptor(dist, expectedDist)) record('release-generated-drift', distPath, expectedDist, dist);

    const manifestPath = path.join(install.releaseRoot, 'release-manifest.json');
    const expectedManifest = {
      schemaVersion: 1, releaseId: plan.release.releaseId, sourceCommit: plan.source.commit,
      sourceTreeDigest: plan.release.sourceTreeDigest, generatedDigest: plan.release.generatedDigest,
      generatorVersion: plan.toolVersion, planId: plan.planId,
    };
    try {
      const actualManifest = await readJson(manifestPath);
      if (canonicalize(actualManifest) !== canonicalize(expectedManifest)) record('release-manifest-drift', manifestPath, expectedManifest, actualManifest);
    } catch (error) {
      record('release-manifest-invalid', manifestPath, expectedManifest, { code: error.code ?? 'INTERNAL', message: error.message });
    }
  }

  let checkedTargets = 0;
  let declaredArtifacts = 0;
  const expectedPaths = new Set();
  if (sourceTrusted) {
    try {
      const expected = await buildExpectedTargets(install, roots);
      declaredArtifacts = expected.artifacts;
      checkedTargets = expected.targets.length;
      for (const target of expected.targets) {
        expectedPaths.add(target.target);
        let actual = await describePath(target.target);
        if (target.comparison === 'json-semantic' && actual.type === 'file') {
          try {
            const semanticHash = digestObject(JSON.parse(await readFile(target.target, 'utf8')));
            actual = { ...actual, semanticHash };
            if (semanticHash !== target.expected.semanticHash) {
              record('content-drift', target.target, target.expected, actual, target);
            }
          } catch (error) {
            record('invalid-json', target.target, target.expected, { ...actual, code: error.code ?? 'INVALID_JSON' }, target);
          }
        } else if (!matchesDescriptor(actual, target.expected)) {
          record(driftReason(target.expected, actual, { retired: target.retired }), target.target, target.expected, actual, target);
        }
      }
    } catch (error) {
      record('desired-state-build-failed', install.releaseRoot, { type: 'complete-managed-installation' }, { code: error.code ?? 'INTERNAL', message: error.message });
    }
  }

  for (const target of install.targets) {
    if (expectedPaths.has(target.target)) continue;
    const actual = await describePath(target.target);
    if (!matchesDescriptor(actual, target.postimage)) record('latest-target-drift', target.target, target.postimage, actual);
  }

  return { ok: drift.length === 0, installed: true, install, checkedTargets, declaredArtifacts, drift };
}

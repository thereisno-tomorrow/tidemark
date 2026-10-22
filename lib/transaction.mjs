import { chmod, lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyPlan } from './apply.mjs';
import { createAuthorization } from './authorization.mjs';
import { loadBackup, verifyBackup } from './backup.mjs';
import { sha256 } from './canonical-json.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { atomicWrite, atomicWriteJson, copyTree, describePath, listTree, matchesDescriptor, pathExists, readJson } from './fs-safe.mjs';
import { fastForwardCheckedOutBranch, isAncestor, repositoryState, runGit } from './git.mjs';
import { assertTransactionRisk, effectivePathRisk, inspectFrontmatterRisk, loadConfiguration, locateArtifact } from './manifest.mjs';
import { normalizeRelative, ensureWithin, expandTokens, resolveRoots, toPortablePath } from './paths.mjs';
import { calculatePlan, targetRootAllowed, verifyPlanDigest } from './planner.mjs';
import { acquireLock, ensureStateLayout, readJournal } from './state.mjs';
import { validateRepository } from './validators.mjs';

function transactionPaths(stateRoot, id) {
  const root = path.join(stateRoot, 'transactions', id);
  return { root, worktree: path.join(root, 'worktree'), record: path.join(root, 'transaction.json'), tests: path.join(root, 'test-results.json') };
}

function matchesPattern(relative, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '§§').replaceAll('*', '[^/]*').replaceAll('§§', '.*');
  return new RegExp(`^${escaped}$`).test(relative);
}

function pathAllowed(relative, record) {
  const normalized = normalizeRelative(relative);
  if (record.derivedPaths?.includes(normalized)) return true;
  if (record.allowedPaths.includes(normalized)) return true;
  return record.creationPatterns?.some((pattern) => matchesPattern(normalized, pattern)) ?? false;
}

function retirementTargetsFor(artifact) {
  return (artifact.providers ?? [])
    .map((provider) => ({ provider, path: artifact.targets?.[provider] }))
    .filter((entry) => typeof entry.path === 'string' && entry.path.trim());
}

function sameTargetToken(left, right) {
  return toPortablePath(left).replace(/\/+$/, '') === toPortablePath(right).replace(/\/+$/, '');
}

function explicitNamespaceArtifact(artifact) {
  const entry = structuredClone(artifact);
  delete entry.namespaceId;
  delete entry.creation;
  delete entry.adoption;
  entry.risk = 'content-auto';
  return entry;
}

function appendManifestArtifact(content, artifact) {
  const keyIndex = content.indexOf('"artifacts"');
  invariant(keyIndex >= 0, 'ADOPTION_MANIFEST_INVALID', 'manifest.json has no artifacts array');
  const openIndex = content.indexOf('[', keyIndex);
  invariant(openIndex >= 0, 'ADOPTION_MANIFEST_INVALID', 'manifest.json artifacts is not an array');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let closeIndex = -1;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '[') depth += 1;
    else if (character === ']' && --depth === 0) { closeIndex = index; break; }
  }
  invariant(closeIndex >= 0, 'ADOPTION_MANIFEST_INVALID', 'manifest.json artifacts array is unterminated');

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const closeLineStart = content.lastIndexOf('\n', closeIndex) + 1;
  const closeIndent = content.slice(closeLineStart, closeIndex);
  const body = content.slice(openIndex + 1, closeLineStart);
  const existingIndent = body.match(/(?:^|\r?\n)([ \t]+)\S/)?.[1];
  const indentStep = existingIndent ? Math.max(1, existingIndent.length - closeIndent.length) : 2;
  const itemIndent = existingIndent ?? `${closeIndent}${' '.repeat(indentStep)}`;
  const rendered = JSON.stringify(artifact, null, indentStep).split('\n').map((line) => `${itemIndent}${line}`).join(eol);
  let beforeClose = content.slice(0, closeLineStart);
  const lastNonWhitespace = beforeClose.search(/\s*$/) - 1;
  if (body.trim()) beforeClose = `${beforeClose.slice(0, lastNonWhitespace + 1)},${beforeClose.slice(lastNonWhitespace + 1)}`;
  const updated = `${beforeClose}${rendered}${eol}${content.slice(closeLineStart)}`;
  JSON.parse(updated);
  return updated;
}

async function providerTargetsForCreation(artifact, roots) {
  const targets = [];
  for (const provider of artifact.providers ?? []) {
    const token = artifact.targets?.[provider];
    invariant(typeof token === 'string' && token.trim(), 'TARGET_REQUIRED', `Missing ${provider} target for ${artifact.id}`);
    const target = expandTokens(token, roots);
    invariant(targetRootAllowed(target, roots), 'TARGET_ROOT_DENIED', `Target is outside provider roots: ${target}`);
    targets.push({ provider, target, descriptor: await describePath(target) });
  }
  return targets;
}

function patternAllowsPath(relative, pattern) {
  if (matchesPattern(relative, pattern)) return true;
  if (!pattern.endsWith('/**')) return false;
  const prefix = pattern.slice(0, -3);
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

async function prepareAdoption({ artifact, configuration, roots, worktree }) {
  invariant(artifact.kind === 'skill' && artifact.ownership === 'shared-link', 'ADOPTION_NAMESPACE_INVALID', 'Adoption is limited to portable shared-link skills');
  invariant(artifact.namespaceId === 'portable-skill', 'ADOPTION_NAMESPACE_INVALID', 'Adoption requires the portable-skill namespace');
  invariant(JSON.stringify(artifact.providers) === JSON.stringify(['claude', 'codex']), 'ADOPTION_TOPOLOGY_UNSUPPORTED', 'Adoption requires exactly the Claude and Codex provider topology');

  const targets = await providerTargetsForCreation(artifact, roots);
  const claude = targets.find((entry) => entry.provider === 'claude');
  const codex = targets.find((entry) => entry.provider === 'codex');
  invariant(codex?.descriptor.type === 'directory', 'ADOPTION_CODEX_DIRECTORY_REQUIRED', 'Codex adoption target must be a regular directory');
  invariant(claude?.descriptor.type === 'link', 'ADOPTION_CLAUDE_LINK_REQUIRED', 'Claude adoption target must be a link or junction');
  const resolvedClaudeTarget = path.resolve(path.dirname(claude.target), claude.descriptor.linkTarget);
  invariant(path.resolve(codex.target) === resolvedClaudeTarget, 'ADOPTION_LINK_TARGET_MISMATCH', 'Claude adoption link must target the Codex skill directory');

  const sourceRelative = normalizeRelative(artifact.source[0]);
  const installedEntries = await listTree(codex.target);
  invariant(!installedEntries.some((entry) => entry.type === 'link'), 'ADOPTION_NESTED_LINK_DENIED', 'Adopted skill trees may not contain links');
  for (const entry of installedEntries) {
    invariant(!artifact.deniedFiles.some((pattern) => patternAllowsPath(entry.path, pattern)), 'ADOPTION_FILE_DENIED', `Adopted skill contains a denied path: ${entry.path}`);
    invariant(artifact.allowedInitialFiles.some((pattern) => patternAllowsPath(entry.path, pattern)), 'ADOPTION_FILE_NOT_ALLOWED', `Adopted skill contains a path outside the portable skill allowlist: ${entry.path}`);
    if (entry.type === 'file') {
      const risk = effectivePathRisk(path.posix.join(sourceRelative, entry.path), 'content-auto', configuration.policy);
      invariant(risk === 'content-auto', 'ADOPTION_CONTROL_FILE_DENIED', `Adopted skill contains a control or executable file: ${entry.path}`);
    }
  }
  invariant(installedEntries.some((entry) => entry.type === 'file' && entry.path === 'SKILL.md'), 'ADOPTION_SKILL_MISSING', 'Adopted skill must contain SKILL.md');

  const source = ensureWithin(worktree, path.join(worktree, sourceRelative));
  invariant(!await pathExists(source), 'ADOPTION_CANONICAL_EXISTS', `Canonical adoption source already exists: ${sourceRelative}`);
  await copyTree(codex.target, source);
  const [codexAfterCopy, claudeAfterCopy, sourcePostimage] = await Promise.all([
    describePath(codex.target), describePath(claude.target), describePath(source),
  ]);
  invariant(matchesDescriptor(codexAfterCopy, codex.descriptor) && matchesDescriptor(claudeAfterCopy, claude.descriptor), 'ADOPTION_PREIMAGE_DRIFT', 'Installed provider topology or bytes changed during adoption');
  invariant(sourcePostimage.type === 'directory' && sourcePostimage.hash === codex.descriptor.hash, 'ADOPTION_COPY_MISMATCH', 'Canonical adoption copy is not byte-identical to the installed Codex directory');

  const manifestPath = path.join(worktree, 'manifest.json');
  const manifestContent = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent);
  invariant(!(manifest.artifacts ?? []).some((entry) => entry.id === artifact.id), 'ADOPTION_ARTIFACT_EXISTS', `Manifest artifact already exists: ${artifact.id}`);
  await atomicWrite(manifestPath, appendManifestArtifact(manifestContent, explicitNamespaceArtifact(artifact)));

  return {
    mode: 'portable-skill-existing-install', artifactId: artifact.id,
    canonicalSource: { path: sourceRelative, preimage: { type: 'absent', size: 0, hash: null, linkTarget: null }, postimage: sourcePostimage },
    providerPreimages: targets,
    topology: { codex: 'regular-directory', claude: 'link-to-codex' },
    cutover: { writer: 'agent-config-apply', backupBeforeMutation: true, providerOwnershipAfter: 'normal-apply-release-only' },
    rollback: { mechanism: 'controller-backup', restore: 'exact-preimages', conflicts: 'fail-loudly' },
    recovery: { mechanism: 'controller-recover', requiresExactPlanId: true },
  };
}

const FORWARD_REPAIR_ARTIFACT = 'skills.example-runtime';
const FORWARD_REPAIR_RUNTIME = 'controller.runtime-v0.1.0';
const FORWARD_REPAIR_ATTRIBUTE = 'skills/example-runtime/** -text';

async function stageForwardAdoptionRepair({ stateRoot, paths, record, change }) {
  invariant(record.artifact.id === FORWARD_REPAIR_RUNTIME, 'FORWARD_REPAIR_RUNTIME_REQUIRED', 'Forward adoption repair is limited to the controller runtime transaction');
  invariant(change.artifact === FORWARD_REPAIR_ARTIFACT, 'FORWARD_REPAIR_ARTIFACT_INVALID', 'Forward adoption repair is limited to skills.example-runtime');
  invariant(typeof change.failedTransactionId === 'string' && change.failedTransactionId, 'FORWARD_REPAIR_BINDING_REQUIRED', 'failedTransactionId is required');
  invariant(/^sha256:[a-f0-9]{64}$/.test(change.expectedPlanId ?? ''), 'FORWARD_REPAIR_BINDING_REQUIRED', 'A complete expectedPlanId is required');
  invariant(typeof change.expectedBackupId === 'string' && change.expectedBackupId, 'FORWARD_REPAIR_BINDING_REQUIRED', 'expectedBackupId is required');
  invariant(/^[a-f0-9]{64}$/.test(change.expectedOriginalDirectoryHash ?? ''), 'FORWARD_REPAIR_BINDING_REQUIRED', 'A complete expectedOriginalDirectoryHash is required');

  const state = await ensureStateLayout(stateRoot);
  invariant(await pathExists(state.current), 'FORWARD_REPAIR_CURRENT_MISSING', 'Forward adoption repair requires a current install');
  const current = await readJson(state.current);
  invariant(current.status === 'verified-provisional', 'FORWARD_REPAIR_CURRENT_MISMATCH', 'Current install is not the failed verified-provisional adoption');
  invariant(current.planId === change.expectedPlanId && current.backupId === change.expectedBackupId, 'FORWARD_REPAIR_CURRENT_MISMATCH', 'Current install does not match the bound failed plan and backup');

  const failed = await loadTransaction(stateRoot, change.failedTransactionId);
  invariant(failed.record.transactionId === change.failedTransactionId && failed.record.phase === 'verified-provisional', 'FORWARD_REPAIR_TRANSACTION_MISMATCH', 'Failed transaction binding does not match a verified-provisional transaction');
  invariant(failed.record.planPath && failed.record.release?.releaseId === current.releaseId && failed.record.release?.backupId === change.expectedBackupId, 'FORWARD_REPAIR_TRANSACTION_MISMATCH', 'Failed transaction release binding differs from the current install');

  const storedPlanPath = path.join(state.plans, `${change.expectedPlanId.replace(':', '-')}.json`);
  invariant(await pathExists(storedPlanPath), 'FORWARD_REPAIR_PLAN_MISSING', 'Bound stored plan is missing');
  const failedPlan = await readJson(storedPlanPath);
  verifyPlanDigest(failedPlan, { requireToolVersion: false });
  const failedTransactionPlan = await readJson(failed.record.planPath);
  verifyPlanDigest(failedTransactionPlan, { requireToolVersion: false });
  invariant(failedPlan.planId === change.expectedPlanId && current.planPath === storedPlanPath, 'FORWARD_REPAIR_PLAN_MISMATCH', 'Stored plan or current plan path does not match the binding');
  invariant(failedTransactionPlan.planId === change.expectedPlanId, 'FORWARD_REPAIR_PLAN_MISMATCH', 'Failed transaction does not reference the bound plan');
  invariant(JSON.stringify(failedPlan.artifacts) === JSON.stringify([FORWARD_REPAIR_ARTIFACT]), 'FORWARD_REPAIR_PLAN_MISMATCH', 'Failed plan must contain exactly skills.example-runtime');
  invariant(failedPlan.adoption?.artifactId === FORWARD_REPAIR_ARTIFACT && failedPlan.adoption?.canonicalSource?.postimage?.hash === change.expectedOriginalDirectoryHash, 'FORWARD_REPAIR_PLAN_MISMATCH', 'Failed plan adoption metadata does not match the original directory binding');
  invariant(failedPlan.release?.releaseId === current.releaseId && path.resolve(failedPlan.release?.snapshotPath ?? '') === path.resolve(current.releaseRoot), 'FORWARD_REPAIR_PLAN_MISMATCH', 'Failed plan release does not match the current install');
  invariant(current.activeArtifacts?.includes(FORWARD_REPAIR_RUNTIME) && current.activeArtifacts.includes(FORWARD_REPAIR_ARTIFACT), 'FORWARD_REPAIR_CURRENT_MISMATCH', 'Current install does not contain the runtime and example-runtime pair');
  invariant((current.targets ?? []).length === 2 && (current.targets ?? []).every((target) => failedPlan.adoption.providerPreimages.some((entry) => entry.target === target.target)), 'FORWARD_REPAIR_CURRENT_MISMATCH', 'Current install target scope is not exactly the example-runtime provider pair');

  const active = await describePath(state.active);
  invariant(active.type === 'link' && path.resolve(active.linkTarget ?? '') === path.resolve(current.releaseRoot), 'FORWARD_REPAIR_ACTIVE_MISMATCH', 'Active release does not match the current install');
  const journal = await readJournal(path.join(state.journal, `${current.operationId}.jsonl`));
  const phases = journal.map((entry) => entry.phase);
  invariant(phases[0] === 'started' && phases.includes('backup-complete') && phases.includes('active-switched') && phases.at(-1) === 'apply-complete', 'FORWARD_REPAIR_JOURNAL_MISMATCH', 'Failed adoption journal is incomplete');
  invariant(phases.indexOf('backup-complete') < phases.indexOf('active-switched'), 'FORWARD_REPAIR_JOURNAL_MISMATCH', 'Failed adoption backup did not precede activation');
  invariant(journal.filter((entry) => entry.phase === 'target-mutated').length === 3 && !phases.some((phase) => phase.includes('rollback')), 'FORWARD_REPAIR_JOURNAL_MISMATCH', 'Failed adoption journal does not contain the exact completed three-operation cutover');

  const backup = await loadBackup(stateRoot, change.expectedBackupId);
  await verifyBackup(backup.root, backup.manifest);
  invariant(backup.manifest.backupId === change.expectedBackupId && backup.manifest.entries.length === 2, 'FORWARD_REPAIR_BACKUP_MISMATCH', 'Bound backup does not have the exact adoption scope');
  const originalEntry = backup.manifest.entries.find((entry) => entry.dataPath === 'data/0000');
  const linkEntry = backup.manifest.entries.find((entry) => entry.dataPath === null && entry.descriptor?.type === 'link');
  invariant(originalEntry?.descriptor?.type === 'directory' && originalEntry.descriptor.hash === change.expectedOriginalDirectoryHash, 'FORWARD_REPAIR_BACKUP_MISMATCH', 'Backup original directory does not match the binding');
  invariant(linkEntry && failedPlan.adoption.providerPreimages.some((entry) => entry.target === linkEntry.target && matchesDescriptor(entry.descriptor, linkEntry.descriptor)), 'FORWARD_REPAIR_BACKUP_MISMATCH', 'Backup provider link does not match the failed adoption preimage');
  invariant(originalEntry && failedPlan.adoption.providerPreimages.some((entry) => entry.target === originalEntry.target && matchesDescriptor(entry.descriptor, originalEntry.descriptor)), 'FORWARD_REPAIR_BACKUP_MISMATCH', 'Backup original directory does not match the failed adoption preimage');
  const backupData = path.join(backup.root, 'data', '0000');
  const backupDataDescriptor = await describePath(backupData);
  invariant(backupDataDescriptor.type === 'directory' && backupDataDescriptor.hash === change.expectedOriginalDirectoryHash, 'FORWARD_REPAIR_BACKUP_MISMATCH', 'Verified backup data does not match the original directory');

  const expectedLinkTarget = path.join(stateRoot, 'active', 'source', 'skills', 'example-runtime');
  const providerPreimages = [];
  for (const expected of failedPlan.adoption.providerPreimages) {
    const actual = await describePath(expected.target);
    invariant(actual.type === 'link' && path.resolve(actual.linkTarget ?? '') === path.resolve(expectedLinkTarget), 'FORWARD_REPAIR_PROVIDER_TOPOLOGY', `Managed example-runtime provider link is not exact: ${expected.target}`);
    providerPreimages.push({ provider: expected.provider, target: expected.target, descriptor: actual });
  }
  invariant(providerPreimages.length === 2 && new Set(providerPreimages.map((entry) => entry.provider)).size === 2, 'FORWARD_REPAIR_PROVIDER_TOPOLOGY', 'Forward repair requires exactly the Claude and Codex managed links');

  const sourceRelative = 'skills/example-runtime';
  const source = ensureWithin(paths.worktree, path.join(paths.worktree, sourceRelative));
  invariant(!await pathExists(source), 'FORWARD_REPAIR_CANONICAL_EXISTS', 'Canonical example-runtime source must be absent before forward repair');
  await copyTree(backupData, source);
  const sourcePostimage = await describePath(source);
  invariant(matchesDescriptor(sourcePostimage, originalEntry.descriptor), 'FORWARD_REPAIR_COPY_MISMATCH', 'Forward repair source is not byte-identical to verified backup data');

  const manifestPath = path.join(paths.worktree, 'manifest.json');
  const manifestContent = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestContent);
  invariant(!(manifest.artifacts ?? []).some((entry) => entry.id === FORWARD_REPAIR_ARTIFACT), 'FORWARD_REPAIR_ARTIFACT_EXISTS', 'Canonical manifest already contains skills.example-runtime');
  const failedArtifact = explicitNamespaceArtifact(failed.record.artifact);
  invariant(failedArtifact.id === FORWARD_REPAIR_ARTIFACT, 'FORWARD_REPAIR_TRANSACTION_MISMATCH', 'Failed transaction artifact is not skills.example-runtime');
  await atomicWrite(manifestPath, appendManifestArtifact(manifestContent, failedArtifact));

  const attributesPath = path.join(paths.worktree, '.gitattributes');
  const attributes = await pathExists(attributesPath) ? await readFile(attributesPath, 'utf8') : '';
  const attributeLines = attributes.split(/\r?\n/).filter((line) => line.trim() === FORWARD_REPAIR_ATTRIBUTE);
  invariant(attributeLines.length === 0, 'FORWARD_REPAIR_ATTRIBUTE_CONFLICT', 'example-runtime byte-preservation attribute already exists');
  const eol = attributes.includes('\r\n') ? '\r\n' : '\n';
  const prefix = attributes ? `${attributes.replace(/\r?\n?$/, '')}${eol}` : '';
  await atomicWrite(attributesPath, `${prefix}${FORWARD_REPAIR_ATTRIBUTE}${eol}`);

  const copiedFiles = (await listTree(source)).filter((entry) => entry.type === 'file').map((entry) => normalizeRelative(path.posix.join(sourceRelative, entry.path)));
  record.allowedPaths.push(...copiedFiles, '.gitattributes', 'manifest.json');
  if (!record.derivedPaths.includes('manifest.lock.json')) record.derivedPaths.push('manifest.lock.json');
  record.adoption = {
    mode: 'forward-repair-adoption', artifactId: FORWARD_REPAIR_ARTIFACT,
    canonicalSource: { path: sourceRelative, preimage: { type: 'absent', size: 0, hash: null, linkTarget: null }, postimage: sourcePostimage },
    originalDirectoryDescriptor: originalEntry.descriptor,
    providerPreimages,
    topology: { codex: 'managed-link', claude: 'managed-link' },
    cutover: { writer: 'agent-config-apply', backupBeforeMutation: true, providerOwnershipAfter: 'normal-apply-release-only' },
    rollback: { mechanism: 'controller-backup', restore: 'exact-preimages', conflicts: 'fail-loudly' },
    recovery: { mechanism: 'controller-recover', requiresExactPlanId: true },
    repair: {
      failedTransactionId: change.failedTransactionId,
      failedPlanId: change.expectedPlanId,
      failedBackupId: change.expectedBackupId,
      failedReleaseId: current.releaseId,
      originalDirectoryHash: change.expectedOriginalDirectoryHash,
    },
  };
  record.changes.push(
    { op: change.op, path: sourceRelative, contentHash: sourcePostimage.hash },
    { op: 'controller-forward-repair-manifest', path: 'manifest.json', contentHash: (await describePath(manifestPath)).hash },
    { op: 'controller-forward-repair-attribute', path: '.gitattributes', contentHash: (await describePath(attributesPath)).hash },
  );
}

function retirementArtifactsFor(record) {
  // Transactions created before batch retirement support carry only the primary artifact.
  return record.retirement?.artifacts ?? [record.artifact];
}

// A retired artifact is absent from the manifest by definition, so planning against its own
// id can only ever produce EMPTY_PLAN. The removal is carried by the legacy-retirement
// artifact that declares its installed paths, and that declaration must exist in THIS
// transaction: the controller resolves a carrier the user wrote, it never synthesizes one.
async function resolveRetirementCarrier(worktree, record) {
  const artifacts = retirementArtifactsFor(record);
  for (const artifact of artifacts) {
    for (const source of artifact.source) {
      const present = await pathExists(ensureWithin(worktree, path.join(worktree, source)));
      invariant(!present, 'RETIREMENT_INCOMPLETE', `Retirement must remove every source path first: ${artifact.id}: ${source}`);
    }
  }
  const manifest = await readJson(path.join(worktree, 'manifest.json'));
  for (const artifact of artifacts) {
    const declared = (manifest.artifacts ?? []).some((item) => item.id === artifact.id);
    invariant(!declared, 'RETIREMENT_INCOMPLETE', `Retired artifact is still declared in manifest.json: ${artifact.id}`);
  }
  const carrier = (manifest.artifacts ?? [])
    .filter((item) => item.kind === 'legacy-retirement')
    .find((item) => record.retirement.targets.every((target) => (item.legacyTargets ?? [])
      .some((entry) => entry.provider === target.provider && sameTargetToken(entry.path, target.path))));
  invariant(carrier, 'RETIREMENT_NOT_DECLARED', 'Every installed target must be declared under one legacy-retirement artifact in the same transaction', { targets: record.retirement.targets });
  return carrier.id;
}

async function removeEmptyArtifactParents(target, worktree, artifacts) {
  const sourceRoots = artifacts.flatMap((artifact) => artifact.source.map((source) => ensureWithin(worktree, path.join(worktree, source))));
  const owningRoot = sourceRoots.find((sourceRoot) => target !== sourceRoot && target.startsWith(`${sourceRoot}${path.sep}`));
  if (!owningRoot) return;

  let directory = path.dirname(target);
  while (directory === owningRoot || directory.startsWith(`${owningRoot}${path.sep}`)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Already absent: continue toward the artifact root.
      } else if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) {
        break;
      } else {
        throw error;
      }
    }
    if (directory === owningRoot) break;
    directory = path.dirname(directory);
  }
}

async function save(record, paths) {
  record.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.record, record);
}

export async function beginTransaction({ root, stateRoot, artifact: query, atomicArtifacts = null, provider, request, scope = 'local-only', token = null, issuerPublicKey = null, allowCreation = false, adoptExisting = false, allowRetirement = false, retirementArtifacts = null, activateExisting = false, roots: providedRoots = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  invariant(['claude', 'codex'].includes(provider), 'PROVIDER_INVALID', 'Provider must be claude or codex');
  invariant(typeof request === 'string' && request.trim(), 'REQUEST_REQUIRED', 'A direct explicit user request is required');
  invariant(retirementArtifacts === null || Array.isArray(retirementArtifacts), 'RETIREMENT_ARTIFACTS_INVALID', 'retirementArtifacts must be an array when provided');
  invariant(retirementArtifacts === null || (allowRetirement && retirementArtifacts.length > 0), 'RETIREMENT_ARTIFACTS_REQUIRES_RETIREMENT', 'retirementArtifacts requires allowRetirement and at least one artifact');
  invariant(atomicArtifacts === null || Array.isArray(atomicArtifacts), 'ATOMIC_ARTIFACTS_INVALID', 'atomicArtifacts must be an array when provided');
  invariant(atomicArtifacts === null || atomicArtifacts.length >= 2, 'ATOMIC_ARTIFACTS_REQUIRED', 'Atomic transactions require at least two explicitly enumerated artifacts');
  invariant(atomicArtifacts === null || atomicArtifacts.every((candidate) => typeof candidate === 'string' && candidate.trim()), 'ATOMIC_ARTIFACTS_INVALID', 'Every atomic artifact must be a non-empty string');
  invariant(!(atomicArtifacts && allowRetirement), 'ATOMIC_RETIREMENT_CONFLICT', 'Atomic non-retirement scope and retirement scope are separate transaction modes');
  invariant(!(atomicArtifacts && (allowCreation || adoptExisting || activateExisting)), 'ATOMIC_MODE_CONFLICT', 'Atomic multi-artifact transactions require existing artifacts and cannot create, adopt, or activate');
  invariant(!(allowCreation && adoptExisting), 'ADOPTION_CREATION_CONFLICT', 'Adoption and ordinary creation are separate explicit intents');
  invariant(!(adoptExisting && allowRetirement), 'ADOPTION_RETIREMENT_CONFLICT', 'A transaction cannot adopt and retire artifacts together');
  invariant(!(allowCreation && allowRetirement), 'RETIREMENT_CREATION_CONFLICT', 'A transaction cannot create and retire artifacts together');
  const lock = await acquireLock(roots.AGENT_CONFIG_STATE_ROOT, 'transaction-begin');
  try {
    const configuration = await loadConfiguration(roots.AGENT_CONFIG_ROOT);
    const located = await locateArtifact(roots.AGENT_CONFIG_ROOT, configuration, query, { allowCreation, allowAdoption: adoptExisting });
    const atomicArtifactList = atomicArtifacts === null
      ? []
      : await Promise.all(atomicArtifacts.map((candidate) => locateArtifact(roots.AGENT_CONFIG_ROOT, configuration, candidate, { allowCreation: false })));
    if (atomicArtifacts) {
      invariant(atomicArtifactList[0]?.id === located.id, 'ATOMIC_PRIMARY_MISMATCH', 'artifact must be the first entry in atomicArtifacts');
      const ids = new Set(atomicArtifactList.map((artifact) => artifact.id));
      invariant(ids.size === atomicArtifactList.length, 'ATOMIC_ARTIFACTS_DUPLICATE', 'atomicArtifacts cannot contain duplicates');
    }
    const retirementQueries = allowRetirement ? (retirementArtifacts ?? [query]) : [];
    const retirementArtifactList = allowRetirement
      ? await Promise.all(retirementQueries.map((candidate) => {
        invariant(typeof candidate === 'string' && candidate.trim(), 'RETIREMENT_ARTIFACTS_INVALID', 'Every retirement artifact must be a non-empty string');
        return locateArtifact(roots.AGENT_CONFIG_ROOT, configuration, candidate, { allowCreation: false });
      }))
      : [];
    if (allowRetirement) {
      invariant(retirementArtifactList[0]?.id === located.id, 'RETIREMENT_PRIMARY_MISMATCH', 'artifact must be the first entry in retirementArtifacts');
      const ids = new Set(retirementArtifactList.map((artifact) => artifact.id));
      invariant(ids.size === retirementArtifactList.length, 'RETIREMENT_ARTIFACTS_DUPLICATE', 'retirementArtifacts cannot contain duplicates');
    }
    const transactionArtifactList = atomicArtifacts ? atomicArtifactList : allowRetirement ? retirementArtifactList : [located];
    for (const candidate of transactionArtifactList) {
      invariant(candidate.ownership !== 'project-owned', 'PROJECT_OWNED', `${candidate.id} must be edited in its governed repository`);
      invariant(candidate.risk !== 'not-deployable', 'NOT_DEPLOYABLE', `${candidate.id} is not deployable`);
    }
    // Retirement has to declare the removal in manifest.json, a strict control basename.
    // Elevating the transaction is the honest way to admit that path: a retirement IS a
    // control-plane change, so it earns the control-confirm gate rather than evading it.
    const retirementTargets = allowRetirement ? retirementArtifactList.flatMap(retirementTargetsFor) : [];
    if (atomicArtifacts) {
      located.risk = 'control-confirm';
      for (const candidate of atomicArtifactList) candidate.risk = 'control-confirm';
    }
    if (allowRetirement) {
      invariant(retirementTargets.length > 0, 'RETIREMENT_NOT_APPLICABLE', 'No requested retirement artifact installs a target');
      const targetKeys = retirementTargets.map((target) => `${target.provider}:${toPortablePath(target.path).replace(/\/+$/, '')}`);
      invariant(new Set(targetKeys).size === targetKeys.length, 'RETIREMENT_TARGETS_DUPLICATE', 'retirementArtifacts cannot retire the same provider target twice');
      located.risk = 'control-confirm';
      for (const candidate of retirementArtifactList) candidate.risk = 'control-confirm';
    }
    const activationOnly = Boolean(activateExisting);
    if (activationOnly) {
      invariant(!allowCreation && !adoptExisting && !allowRetirement && retirementArtifacts === null && atomicArtifacts === null, 'ACTIVATION_MODE_INVALID', 'Activation-only transactions cannot create, adopt, retire, or atomically group artifacts');
      invariant(!located.creation, 'ACTIVATION_NOT_EXISTING', 'Activation-only transactions require an existing catalog artifact');
      for (const source of located.source) {
        invariant(await pathExists(path.join(roots.AGENT_CONFIG_ROOT, source)), 'ACTIVATION_SOURCE_MISSING', `Activation source is missing: ${source}`);
      }
      // Installing an already-reviewed source is still a control-plane mutation.
      located.risk = 'control-confirm';
    }
    const base = repositoryState(roots.AGENT_CONFIG_ROOT);
    invariant(base.clean, 'DIRTY_SOURCE', 'Automatic transactions require a clean canonical checkout', { paths: base.status });
    if (located.creation && !adoptExisting) {
      const occupied = (await providerTargetsForCreation(located, roots)).filter((entry) => entry.descriptor.type !== 'absent');
      invariant(occupied.length === 0, 'CREATION_TARGET_EXISTS', 'Ordinary creation refuses existing provider targets; use explicit adoption for a genuinely new portable skill', { targets: occupied });
    }
    const authorization = await createAuthorization({ provider, artifactId: located.id, scope, request, token, publicKey: issuerPublicKey, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, policy: configuration.policy });
    const transactionId = randomUUID();
    const paths = transactionPaths(roots.AGENT_CONFIG_STATE_ROOT, transactionId);
    await mkdir(paths.root, { recursive: false, mode: 0o700 });
    runGit(roots.AGENT_CONFIG_ROOT, ['worktree', 'add', '--detach', paths.worktree, base.commit]);
    let adoption = null;
    try {
      adoption = adoptExisting ? await prepareAdoption({ artifact: located, configuration, roots, worktree: paths.worktree }) : null;
    } catch (error) {
      runGit(roots.AGENT_CONFIG_ROOT, ['worktree', 'remove', '--force', paths.worktree]);
      await rm(paths.root, { recursive: true, force: true });
      throw error;
    }
    const allowedPaths = [];
    const scopedArtifacts = transactionArtifactList;
    for (const scopedArtifact of scopedArtifacts) {
      for (const source of scopedArtifact.source) {
        const sourcePath = path.join(paths.worktree, source);
        if (await pathExists(sourcePath)) {
          const sourceStat = await lstat(sourcePath);
          if (sourceStat.isFile() || sourceStat.isSymbolicLink()) {
            const relative = normalizeRelative(source);
            const effective = await inspectFrontmatterRisk(sourcePath, scopedArtifact.risk, configuration.policy, relative);
            if (effective !== 'control-confirm' || scopedArtifact.risk === 'control-confirm') allowedPaths.push(relative);
          } else {
            const statEntries = await listTree(sourcePath);
            for (const entry of statEntries.filter((item) => item.type === 'file' || item.type === 'link')) {
              const relative = normalizeRelative(path.posix.join(toPortablePath(source), entry.path));
              const effective = await inspectFrontmatterRisk(path.join(paths.worktree, relative), scopedArtifact.risk, configuration.policy, relative);
              if (effective !== 'control-confirm' || scopedArtifact.risk === 'control-confirm') allowedPaths.push(relative);
            }
          }
        }
      }
    }
    const controllerRuntime = located.id === 'controller.runtime-v0.1.0';
    if (allowRetirement || controllerRuntime) allowedPaths.push(normalizeRelative('manifest.json'));
    const sourcePrefix = normalizeRelative(located.source[0]);
    const creationPatterns = [
      ...(controllerRuntime ? ['README.md'] : []),
      ...(located.creation
        ? located.allowedInitialFiles.map((pattern) => pattern === '*' ? sourcePrefix : normalizeRelative(path.posix.join(sourcePrefix, pattern)))
        : []),
    ];
    const allowedPathList = [...new Set(allowedPaths)].sort();
    const atomicSourcePreimages = atomicArtifacts
      ? await Promise.all(allowedPathList.map(async (relative) => ({ path: relative, ...(await describePath(path.join(paths.worktree, relative))) })))
      : null;
    const record = {
      schemaVersion: 1, transactionId, phase: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      artifact: located, base: { commit: base.commit, tree: base.tree, branch: base.branch },
      allowedPaths: allowedPathList, creationPatterns,
      derivedPaths: located.creation || allowRetirement || controllerRuntime ? ['manifest.lock.json', ...(adoption ? ['manifest.json'] : [])] : [],
      atomicScope: atomicArtifacts ? { artifacts: atomicArtifactList, sourcePreimages: atomicSourcePreimages } : null,
      retirement: allowRetirement ? { artifacts: retirementArtifactList, targets: retirementTargets } : null, activationOnly,
      adoption, authorization,
      changes: adoption ? [
        { op: 'controller-adopt', path: adoption.canonicalSource.path, contentHash: adoption.canonicalSource.postimage.hash },
        { op: 'controller-adopt-manifest', path: 'manifest.json', contentHash: (await describePath(path.join(paths.worktree, 'manifest.json'))).hash },
      ] : [],
      receipts: [], planPath: null, blocker: null,
    };
    if (adoption) record.phase = 'patched';
    await save(record, paths);
    return { transactionId, artifact: located, artifacts: transactionArtifactList, atomicScope: record.atomicScope, allowedPaths: record.allowedPaths, creationPatterns, retirement: record.retirement, adoption, activationOnly, originAssurance: authorization.originAssurance, scope };
  } finally { await lock.release(); }
}

export async function loadTransaction(stateRoot, id) {
  const paths = transactionPaths(stateRoot, id);
  invariant(await pathExists(paths.record), 'TRANSACTION_NOT_FOUND', `Transaction not found: ${id}`);
  return { paths, record: await readJson(paths.record) };
}

export async function readTransactionPath({ stateRoot, transactionId, relativePath, maxBytes = 1048576 }) {
  const { paths, record } = await loadTransaction(stateRoot, transactionId);
  const relative = normalizeRelative(relativePath);
  invariant(pathAllowed(relative, record), 'PATH_NOT_AUTHORIZED', `Path is outside transaction scope: ${relative}`);
  const target = ensureWithin(paths.worktree, path.join(paths.worktree, relative));
  invariant(await pathExists(target), 'PATH_NOT_FOUND', `Transaction path does not exist: ${relative}`);
  const content = await readFile(target);
  invariant(content.length <= maxBytes, 'READ_LIMIT', `Transaction read exceeds ${maxBytes} bytes`);
  return { path: relative, size: content.length, hash: sha256(content), content: content.toString('utf8') };
}

export async function patchTransaction({ stateRoot, transactionId, changes, policy }) {
  invariant(Array.isArray(changes) && changes.length > 0, 'PATCH_REQUIRED', 'Structured patch changes are required');
  const { paths, record } = await loadTransaction(stateRoot, transactionId);
  invariant(!record.activationOnly, 'ACTIVATION_PATCH_DENIED', 'Activation-only transactions cannot modify their reviewed source');
  invariant(!record.adoption, 'ADOPTION_PATCH_DENIED', 'Adoption transactions preserve installed bytes; edit the controller-owned skill only in a later ordinary transaction');
  invariant(['open', 'patched', 'tested', 'awaiting-confirmation'].includes(record.phase), 'TRANSACTION_PHASE', `Transaction cannot be patched in phase ${record.phase}`);
  const forwardRepair = changes.some((change) => change.op === 'forward-repair-adoption');
  if (forwardRepair) {
    invariant(changes.length === 1, 'FORWARD_REPAIR_PATCH_SCOPE', 'Forward adoption repair must be the only patch operation');
    await stageForwardAdoptionRepair({ stateRoot, paths, record, change: changes[0] });
    record.allowedPaths = [...new Set(record.allowedPaths)].sort();
    record.derivedPaths = [...new Set(record.derivedPaths)].sort();
    record.phase = 'patched';
    record.receipts = [];
    record.planPath = null;
    record.blocker = null;
    await save(record, paths);
    return { transactionId, phase: record.phase, changes: record.changes };
  }
  const totalBytes = changes.reduce((sum, change) => sum + Buffer.byteLength(change.content ?? '', 'utf8'), 0);
  invariant(totalBytes <= policy.limits.patchBytes, 'PATCH_LIMIT', 'Patch exceeds the configured byte limit');
  const staged = await stagePatch({ changes, paths, record, policy });
  const journal = patchJournal();
  try {
    for (const step of staged.steps) {
      await journal.capture(step.target);
      if (step.op === 'create') {
        await journal.ensureParent(step.target);
        await atomicWrite(step.target, step.content);
      } else if (step.op === 'replace') {
        await atomicWrite(step.target, step.content);
      } else if (step.op === 'delete') {
        await rm(step.target);
        await removeEmptyArtifactParents(step.target, paths.worktree, retirementArtifactsFor(record));
      } else {
        await journal.capture(step.destination);
        await journal.ensureParent(step.destination);
        await rename(step.target, step.destination);
      }
    }
    record.changes.push(...staged.entries);
    record.allowedPaths = staged.allowedPaths.sort();
    record.phase = 'patched';
    record.receipts = [];
    record.planPath = null;
    record.blocker = null;
    await save(record, paths);
  } catch (error) {
    throw await journal.rollback(error, transactionId);
  }
  return { transactionId, phase: record.phase, changes: record.changes };
}

function riskWideningMessage(relative, record, policy) {
  const extension = path.posix.extname(relative).toLowerCase();
  const allowed = policy.contentAuto.allowedExtensions;
  if (record.artifact.risk !== 'content-auto' || allowed.includes(extension)) return `Path requires control-confirm: ${relative}`;
  const kind = extension ? `a ${extension} file` : 'a file with no extension';
  return `Path requires control-confirm: ${relative} (content-auto admits only ${allowed.join(', ')}; ${kind} is control-confirm)`;
}

// A patch is all-or-nothing. Every change is checked against the worktree as the earlier
// changes in the same patch would leave it, before anything is written, so a later change
// that fails policy or a precondition cannot strand earlier ones on disk unrecorded.
async function stagePatch({ changes, paths, record, policy }) {
  const scope = { ...record, allowedPaths: [...record.allowedPaths] };
  // relative -> content hash after the earlier changes in this patch, or null once removed
  const staged = new Map();
  const locate = (relative) => ensureWithin(paths.worktree, path.join(paths.worktree, relative));
  const exists = async (relative) => staged.has(relative) ? staged.get(relative) !== null : pathExists(locate(relative));
  const currentHash = async (relative) => staged.has(relative) ? staged.get(relative) : sha256(await readFile(locate(relative)));
  const steps = [];
  const entries = [];
  for (const change of changes) {
    const relative = normalizeRelative(change.path);
    invariant(pathAllowed(relative, scope), 'PATH_NOT_AUTHORIZED', `Path is outside transaction scope: ${relative}`);
    invariant(!record.derivedPaths?.includes(relative), 'DERIVED_PATH_DENIED', `Controller-owned derived path cannot be patched: ${relative}`);
    invariant(effectivePathRisk(relative, record.artifact.risk, policy) !== 'control-confirm' || record.artifact.risk === 'control-confirm', 'RISK_WIDENING', riskWideningMessage(relative, record, policy));
    const step = { op: change.op, relative, target: locate(relative), content: change.content ?? '' };
    const present = await exists(relative);
    if (change.op === 'create') {
      invariant(!present, 'CREATE_EXISTS', `Create target already exists: ${relative}`);
      staged.set(relative, sha256(step.content));
      if (!scope.allowedPaths.includes(relative)) scope.allowedPaths.push(relative);
    } else if (change.op === 'replace') {
      invariant(present, 'REPLACE_MISSING', `Replace target does not exist: ${relative}`);
      invariant(change.expectedHash === await currentHash(relative), 'EXPECTED_HASH_MISMATCH', `Expected hash does not match: ${relative}`);
      staged.set(relative, sha256(step.content));
    } else if (change.op === 'delete') {
      invariant(present, 'DELETE_MISSING', `Delete target does not exist: ${relative}`);
      invariant(change.expectedHash === await currentHash(relative), 'EXPECTED_HASH_MISMATCH', `Expected hash does not match: ${relative}`);
      staged.set(relative, null);
    } else if (change.op === 'rename') {
      const destinationRelative = normalizeRelative(change.to);
      invariant(pathAllowed(destinationRelative, scope), 'PATH_NOT_AUTHORIZED', `Rename destination is outside transaction scope: ${destinationRelative}`);
      step.destination = locate(destinationRelative);
      invariant(present && !await exists(destinationRelative), 'RENAME_CONFLICT', `Rename precondition failed: ${relative}`);
      const hash = await currentHash(relative);
      invariant(change.expectedHash === hash, 'EXPECTED_HASH_MISMATCH', `Expected hash does not match: ${relative}`);
      staged.set(relative, null);
      staged.set(destinationRelative, hash);
      scope.allowedPaths = scope.allowedPaths.filter((item) => item !== relative);
      if (!scope.allowedPaths.includes(destinationRelative)) scope.allowedPaths.push(destinationRelative);
    } else throw new AgentConfigError('PATCH_OPERATION_INVALID', `Unsupported patch operation: ${change.op}`);
    steps.push(step);
    entries.push({ op: change.op, path: relative, to: change.to ? normalizeRelative(change.to) : null, contentHash: change.content === undefined ? null : sha256(change.content) });
  }
  return { steps, entries, allowedPaths: scope.allowedPaths };
}

// Staging rules out every policy and precondition failure, but a write can still fail on
// I/O. The journal keeps each touched path's preimage and every directory the patch made,
// so a failed patch puts the worktree back as it found it, or says loudly that it could not.
function patchJournal() {
  const preimages = new Map();
  const createdDirectories = [];
  return {
    async capture(target) {
      if (preimages.has(target)) return;
      let stat;
      try { stat = await lstat(target); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        preimages.set(target, null);
        return;
      }
      preimages.set(target, stat.isSymbolicLink()
        ? { linkTarget: await readlink(target) }
        : { bytes: await readFile(target), mode: stat.mode & 0o7777 });
    },
    async ensureParent(target) {
      const parent = path.dirname(target);
      const first = await mkdir(parent, { recursive: true });
      // Windows reports the first created directory in \\?\ form; compare in that form.
      if (first) createdDirectories.push({ first: path.toNamespacedPath(first), parent });
    },
    async rollback(error, transactionId) {
      try {
        for (const [target, preimage] of [...preimages].reverse()) {
          await rm(target, { force: true });
          if (preimage?.linkTarget !== undefined) {
            await mkdir(path.dirname(target), { recursive: true });
            await symlink(preimage.linkTarget, target);
          } else if (preimage) {
            await atomicWrite(target, preimage.bytes);
            await chmod(target, preimage.mode);
          }
        }
        for (const { first, parent } of createdDirectories.reverse()) {
          // Deepest first; a directory still holding a restored file is not the patch's to remove.
          for (let directory = parent; ; directory = path.dirname(directory)) {
            try { await rmdir(directory); } catch (rmdirError) {
              if (['ENOTEMPTY', 'EEXIST'].includes(rmdirError.code)) break;
              if (rmdirError.code !== 'ENOENT') throw rmdirError;
            }
            if (path.toNamespacedPath(directory) === first) break;
          }
        }
      } catch (rollbackError) {
        return new AgentConfigError('PATCH_ROLLBACK_FAILED', `Patch failed and its rollback also failed; the transaction worktree may be partially patched: ${rollbackError.message}`, { transactionId, patchError: error.message, rollbackError: rollbackError.message });
      }
      return error;
    },
  };
}

export async function testTransaction({ root, stateRoot, transactionId, roots: providedRoots = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const configuration = await loadConfiguration(roots.AGENT_CONFIG_ROOT);
  const { paths, record } = await loadTransaction(roots.AGENT_CONFIG_STATE_ROOT, transactionId);
  const testablePhases = record.activationOnly ? ['open', 'tested', 'awaiting-confirmation'] : ['patched', 'tested', 'awaiting-confirmation'];
  invariant(testablePhases.includes(record.phase), 'TRANSACTION_PHASE', record.activationOnly ? 'Activation-only transaction must remain unmodified before testing' : 'Transaction must contain a patch before testing');
  const primarySource = ensureWithin(paths.worktree, path.join(paths.worktree, record.artifact.source[0]));
  const namespaceRetirement = Boolean(record.retirement) || (Boolean(record.artifact.namespaceId) && !await pathExists(primarySource));
  if (record.artifact.creation || namespaceRetirement || record.artifact.id === 'controller.runtime-v0.1.0') {
    if ((namespaceRetirement || record.artifact.id === 'controller.runtime-v0.1.0') && !record.derivedPaths.includes('manifest.lock.json')) record.derivedPaths.push('manifest.lock.json');
    await validateRepository(paths.worktree, { writeLock: true });
  }
  const statusLines = runGit(paths.worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trimEnd().split(/\r?\n/).filter(Boolean);
  const changedPaths = statusLines.map((line) => normalizeRelative(line.slice(3).split(' -> ').at(-1)));
  for (const relative of changedPaths) invariant(pathAllowed(relative, record), 'DIFF_SCOPE_VIOLATION', `Transaction diff escaped allowed paths: ${relative}`);
  if (record.activationOnly) invariant(changedPaths.length === 0, 'ACTIVATION_SOURCE_CHANGED', 'Activation-only transaction detected a source change');
  const riskPaths = changedPaths.filter((relative) => !record.derivedPaths?.includes(relative));
  const risk = record.activationOnly || record.atomicScope ? 'control-confirm' : assertTransactionRisk(riskPaths, record.artifact, configuration.policy);
  const validationArtifactIds = record.adoption?.mode === 'forward-repair-adoption'
    ? [FORWARD_REPAIR_RUNTIME, FORWARD_REPAIR_ARTIFACT]
    : record.atomicScope
    ? record.atomicScope.artifacts.map((artifact) => artifact.id)
    : [record.artifact.id];
  const validation = await validateRepository(paths.worktree, { artifactIds: validationArtifactIds, runDeclaredValidators: true });
  const result = {
    schemaVersion: 1, testedAt: new Date().toISOString(), changedPaths,
    risk, validation: { passed: validation.ok, issues: validation.issues },
    immutablePolicyDigest: sha256(JSON.stringify(configuration.policy)), passed: validation.ok,
  };
  await atomicWriteJson(paths.tests, result);
  record.phase = validation.ok ? 'tested' : 'failed';
  record.blocker = validation.ok ? null : 'validation-failed';
  record.receipts.push({ type: 'transaction-test', passed: validation.ok, risk, changedPaths, digest: sha256(JSON.stringify(result)) });
  await save(record, paths);
  if (!validation.ok) throw new AgentConfigError('VALIDATION_FAILED', 'Transaction validation failed', { issues: validation.issues });
  return result;
}

export async function promoteTransaction({ root, stateRoot, transactionId, confirmationPlanId = null, roots: providedRoots = null }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const configuration = await loadConfiguration(roots.AGENT_CONFIG_ROOT);
  const loaded = await loadTransaction(roots.AGENT_CONFIG_STATE_ROOT, transactionId);
  let { record } = loaded;
  const { paths } = loaded;
  // Refuse an incomplete retirement before generic validation can hide the
  // specific cause behind a stale derived manifest lock.
  if (record.retirement) await resolveRetirementCarrier(paths.worktree, record);
  if (!['tested', 'awaiting-confirmation'].includes(record.phase)) await testTransaction({ root, stateRoot, transactionId, roots });
  ({ record } = await loadTransaction(roots.AGENT_CONFIG_STATE_ROOT, transactionId));
  const testReceipt = [...record.receipts].reverse().find((receipt) => receipt.type === 'transaction-test');
  // The record, not the plan file, declares the inputs; apply re-derives the plan from them.
  const planContext = { authorization: record.authorization, deploymentBase: record.base.commit, riskOverride: testReceipt?.risk, adoption: record.adoption };
  if (!record.planPath) {
    const canonical = repositoryState(roots.AGENT_CONFIG_ROOT);
    invariant(canonical.commit === record.base.commit, 'STALE_BASE', 'Canonical deployment base changed during the transaction');
    const changedPaths = record.changes.flatMap((change) => [change.path, ...(change.to ? [change.to] : [])]);
    runGit(paths.worktree, ['add', '--all', '--', ...new Set([...record.allowedPaths, ...(record.derivedPaths ?? []), ...changedPaths])]);
    const staged = runGit(paths.worktree, ['diff', '--cached', '--name-only']).trim();
    if (record.activationOnly) {
      invariant(!staged, 'ACTIVATION_SOURCE_CHANGED', 'Activation-only transaction has unexpected staged changes');
    } else {
      invariant(staged, 'EMPTY_TRANSACTION', 'Transaction has no staged changes');
      runGit(paths.worktree, ['-c', 'user.name=agent-config-controller', '-c', 'user.email=agent-config@local.invalid', 'commit', '-m', `agent-config: update ${record.artifact.id}`]);
    }
    const candidate = repositoryState(paths.worktree);
    const planArtifactIds = record.adoption?.mode === 'forward-repair-adoption'
      ? [FORWARD_REPAIR_RUNTIME, FORWARD_REPAIR_ARTIFACT]
      : record.retirement
      ? [await resolveRetirementCarrier(paths.worktree, record)]
      : record.atomicScope
      ? record.atomicScope.artifacts.map((artifact) => artifact.id)
      : [record.artifact.id];
    const { plan, planPath } = await calculatePlan({
      root: paths.worktree, stateRoot: roots.AGENT_CONFIG_STATE_ROOT,
      artifactIds: planArtifactIds, roots, ...planContext,
    });
    record.candidate = { commit: candidate.commit, tree: candidate.tree };
    record.planPath = planPath;
    record.phase = plan.confirmation.required ? 'awaiting-confirmation' : 'planned';
    record.blocker = plan.confirmation.required ? plan.confirmation.reason : null;
    await save(record, paths);
  }
  const plan = await readJson(record.planPath);
  const zeroConfirmation = configuration.policy.zeroConfirmationProviders.includes(record.authorization.provider)
    && record.authorization.originAssurance !== 'provider-context';
  if ((plan.risk === 'control-confirm' || !zeroConfirmation) && confirmationPlanId !== plan.planId) {
    record.phase = 'awaiting-confirmation';
    record.blocker = plan.risk === 'control-confirm' ? 'control-confirm' : 'provider-context';
    await save(record, paths);
    return { transactionId, phase: record.phase, planId: plan.planId, planPath: record.planPath, blocker: record.blocker };
  }
  const result = await applyPlan({ planPath: record.planPath, root: paths.worktree, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, confirmationPlanId, planContext });
  record.phase = result.install.status;
  record.blocker = null;
  record.release = { releaseId: result.install.releaseId, backupId: result.backupId };
  await save(record, paths);
  return { transactionId, phase: record.phase, planId: plan.planId, release: record.release };
}

export async function transactionStatus({ stateRoot, transactionId }) {
  const { record } = await loadTransaction(stateRoot, transactionId);
  return record;
}

export async function reconcileTransaction({ root, stateRoot, transactionId }) {
  const lock = await acquireLock(stateRoot, 'promotion');
  try {
    const { paths, record } = await loadTransaction(stateRoot, transactionId);
    if (record.phase === 'reconciled') return { transactionId, phase: record.phase, reconciliation: record.reconciliation, idempotent: true };
    invariant(record.phase === 'verified-provisional', 'TRANSACTION_NOT_PROVISIONAL', 'Only a verified provisional transaction can be reconciled');
    invariant(record.base?.branch && record.base?.commit && record.candidate?.commit, 'TRANSACTION_RECONCILE_METADATA', 'Transaction lacks recorded branch or candidate metadata');
    const canonical = repositoryState(root);
    invariant(canonical.clean, 'DIRTY_SOURCE', 'Canonical checkout contains authored work; reconciliation refused', { paths: canonical.status });
    invariant(canonical.branch === record.base.branch, 'RECONCILE_BRANCH_NOT_CHECKED_OUT', `Canonical checkout must have ${record.base.branch} checked out`, { current: canonical.branch });
    let moved;
    let mode;
    if (canonical.commit === record.base.commit) {
      moved = fastForwardCheckedOutBranch(root, record.base.branch, record.base.commit, record.candidate.commit);
      mode = 'fast-forwarded';
    } else if (canonical.commit === record.candidate.commit || isAncestor(root, record.candidate.commit, canonical.commit)) {
      moved = { ref: `refs/heads/${record.base.branch}`, previous: record.base.commit, current: canonical.commit, worktreeUpdated: false };
      mode = canonical.commit === record.candidate.commit ? 'already-current' : 'absorbed-by-descendant';
    } else {
      invariant(false, 'BRANCH_CAS_FAILED', `Canonical branch ${record.base.branch} diverged from the transaction`, { expectedBase: record.base.commit, candidate: record.candidate.commit, current: canonical.commit });
    }
    record.phase = 'reconciled';
    record.blocker = null;
    record.reconciliation = { mode, branch: record.base.branch, previous: moved.previous, candidate: record.candidate.commit, current: moved.current, reconciledAt: new Date().toISOString() };
    await save(record, paths);
    return { transactionId, phase: record.phase, reconciliation: record.reconciliation };
  } finally { await lock.release(); }
}

export async function supersedeTransaction({ stateRoot, transactionId, replacementTransactionId }) {
  invariant(transactionId !== replacementTransactionId, 'TRANSACTION_SUPERSEDE_SELF', 'A transaction cannot supersede itself');
  const lock = await acquireLock(stateRoot, 'transaction-maintenance');
  try {
    const source = await loadTransaction(stateRoot, transactionId);
    const replacement = await loadTransaction(stateRoot, replacementTransactionId);
    if (source.record.phase === 'superseded' && source.record.supersededBy === replacementTransactionId) {
      return { transactionId, phase: source.record.phase, supersededBy: replacementTransactionId, idempotent: true };
    }
    invariant(source.record.phase === 'verified-provisional', 'TRANSACTION_NOT_PROVISIONAL', 'Only a verified provisional transaction can be marked superseded');
    invariant(replacement.record.phase === 'reconciled', 'REPLACEMENT_NOT_RECONCILED', 'Replacement transaction must be reconciled first');
    invariant(source.record.artifact.id === replacement.record.artifact.id, 'SUPERSEDE_ARTIFACT_MISMATCH', 'Replacement transaction governs a different artifact');
    const state = await ensureStateLayout(stateRoot);
    const current = await pathExists(state.current) ? await readJson(state.current) : null;
    invariant(!source.record.release?.releaseId || current?.releaseId !== source.record.release.releaseId, 'TRANSACTION_IS_ACTIVE', 'The currently installed transaction cannot be marked superseded');
    source.record.phase = 'superseded';
    source.record.blocker = null;
    source.record.supersededBy = replacementTransactionId;
    source.record.supersededAt = new Date().toISOString();
    await save(source.record, source.paths);
    return { transactionId, phase: source.record.phase, supersededBy: replacementTransactionId, evidenceRetained: true };
  } finally { await lock.release(); }
}

export async function abortTransaction({ root, stateRoot, transactionId }) {
  const { paths, record } = await loadTransaction(stateRoot, transactionId);
  invariant(!['active', 'active-local', 'verified-provisional'].includes(record.phase), 'TRANSACTION_ACTIVE', 'An installed transaction cannot be aborted');
  record.phase = 'aborted';
  record.blocker = 'aborted-by-user';
  await save(record, paths);
  ensureWithin(path.join(stateRoot, 'transactions'), paths.worktree);
  runGit(root, ['worktree', 'remove', '--force', paths.worktree]);
  return { transactionId, phase: record.phase };
}

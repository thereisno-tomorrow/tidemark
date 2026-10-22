import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { digestObject } from './canonical-json.mjs';
import { OWNERSHIP, PLATFORMS, PROVIDERS, RISK, STRICT_CONTROL_BASENAMES, STRICT_CONTROL_PREFIXES } from './constants.mjs';
import { AgentConfigError, invariant } from './errors.mjs';
import { pathExists, readJson } from './fs-safe.mjs';
import { normalizeRelative, toPortablePath } from './paths.mjs';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function loadConfiguration(root) {
  const [manifest, policy, routing, trustedRemotes] = await Promise.all([
    readJson(path.join(root, 'manifest.json')),
    readJson(path.join(root, 'automation', 'policy.json')),
    readJson(path.join(root, 'automation', 'routing.json')),
    readJson(path.join(root, 'automation', 'trusted-remotes.json')),
  ]);
  return { manifest, policy, routing, trustedRemotes };
}

export function validateManifestShape(manifest) {
  const issues = [];
  if (manifest?.schemaVersion !== 1) issues.push('manifest.schemaVersion must equal 1');
  if (!Array.isArray(manifest?.artifacts)) issues.push('manifest.artifacts must be an array');
  if (!Array.isArray(manifest?.namespaces)) issues.push('manifest.namespaces must be an array');
  const ids = new Set();
  for (const artifact of [...(manifest.artifacts ?? []), ...(manifest.namespaces ?? [])]) {
    if (!ID_PATTERN.test(artifact.id ?? '')) issues.push(`invalid artifact id: ${artifact.id}`);
    if (ids.has(artifact.id)) issues.push(`duplicate artifact id: ${artifact.id}`);
    ids.add(artifact.id);
    if (!OWNERSHIP.has(artifact.ownership)) issues.push(`invalid ownership for ${artifact.id}: ${artifact.ownership}`);
    if (!RISK.has(artifact.risk)) issues.push(`invalid risk for ${artifact.id}: ${artifact.risk}`);
    for (const provider of artifact.providers ?? []) if (!PROVIDERS.has(provider)) issues.push(`invalid provider for ${artifact.id}: ${provider}`);
    for (const platform of artifact.platforms ?? []) if (!PLATFORMS.has(platform)) issues.push(`invalid platform for ${artifact.id}: ${platform}`);
    if (!Array.isArray(artifact.validators) || artifact.validators.length === 0) issues.push(`validators required for ${artifact.id}`);
    if (artifact.dependencies !== undefined && !Array.isArray(artifact.dependencies)) {
      issues.push(`${artifact.id}: dependencies must be an array`);
    } else {
      const dependencies = artifact.dependencies ?? [];
      const seenDependencies = new Set();
      for (const dependency of dependencies) {
        if (typeof dependency !== 'string' || !ID_PATTERN.test(dependency)) issues.push(`${artifact.id}: invalid dependency id: ${dependency}`);
        if (seenDependencies.has(dependency)) issues.push(`${artifact.id}: duplicate dependency: ${dependency}`);
        if (dependency === artifact.id) issues.push(`${artifact.id}: artifact cannot depend on itself`);
        seenDependencies.add(dependency);
      }
    }
    if (artifact.kind === 'skill' && artifact.ownership === 'provider-only' && !(typeof artifact.providerOnlyReason === 'string' && artifact.providerOnlyReason.trim())) {
      issues.push(`${artifact.id}: provider-only skill requires providerOnlyReason`);
    }
    if (artifact.ownership === 'project-owned' && artifact.risk !== 'not-deployable') issues.push(`${artifact.id}: project-owned must be not-deployable`);
    const deployableExternalSuite = artifact.ownership === 'external-managed' && artifact.kind === 'external-suite' && artifact.risk === 'control-confirm';
    if (artifact.ownership === 'external-managed' && artifact.risk !== 'not-deployable' && !deployableExternalSuite) {
      issues.push(`${artifact.id}: external-managed is deployable only for a control-confirm external-suite`);
    }
    if (['runtime-excluded', 'archived'].includes(artifact.ownership) && artifact.risk !== 'not-deployable') {
      issues.push(`${artifact.id}: ${artifact.ownership} must be not-deployable`);
    }
    if (artifact.kind === 'external-suite') {
      if (artifact.ownership !== 'external-managed') issues.push(`${artifact.id}: external-suite must be external-managed`);
      if (artifact.risk !== 'control-confirm') issues.push(`${artifact.id}: external-suite must be control-confirm`);
      if (!/^[a-f0-9]{64}$/.test(artifact.suite?.objectDigest ?? '')) issues.push(`${artifact.id}: external-suite requires a 64-hex suite.objectDigest`);
      if (!Array.isArray(artifact.suite?.links) || artifact.suite.links.length === 0) issues.push(`${artifact.id}: external-suite requires suite.links`);
      for (const link of artifact.suite?.links ?? []) {
        if (!PROVIDERS.has(link.provider)) issues.push(`${artifact.id}: invalid suite link provider ${link.provider}`);
        if (typeof link.source !== 'string' || !link.source.trim()) issues.push(`${artifact.id}: suite link source is required`);
        if (typeof link.target !== 'string' || !link.target.trim()) issues.push(`${artifact.id}: suite link target is required`);
      }
      for (const probe of artifact.suite?.health ?? []) {
        if (typeof probe !== 'string' || !probe.trim()) issues.push(`${artifact.id}: suite health paths must be non-empty strings`);
      }
    }
  }
  const artifactIds = new Set((manifest.artifacts ?? []).map((artifact) => artifact.id));
  for (const artifact of manifest.artifacts ?? []) {
    for (const dependency of Array.isArray(artifact.dependencies) ? artifact.dependencies : []) {
      if (!artifactIds.has(dependency)) issues.push(`${artifact.id}: unknown dependency: ${dependency}`);
    }
  }
  const dependencyState = new Map();
  const visitDependency = (artifactId, trail = []) => {
    if (dependencyState.get(artifactId) === 'done') return;
    if (dependencyState.get(artifactId) === 'visiting') {
      const start = trail.indexOf(artifactId);
      const cycle = [...trail.slice(start), artifactId];
      issues.push(`artifact dependency cycle: ${cycle.join(' -> ')}`);
      return;
    }
    dependencyState.set(artifactId, 'visiting');
    const artifact = (manifest.artifacts ?? []).find((item) => item.id === artifactId);
    for (const dependency of Array.isArray(artifact?.dependencies) ? artifact.dependencies : []) {
      if (dependency !== artifactId && artifactIds.has(dependency)) visitDependency(dependency, [...trail, artifactId]);
    }
    dependencyState.set(artifactId, 'done');
  };
  for (const artifactId of artifactIds) visitDependency(artifactId);

  const matches = new Set();
  for (const namespace of manifest.namespaces ?? []) {
    if (matches.has(namespace.match)) issues.push(`overlapping namespace match: ${namespace.match}`);
    matches.add(namespace.match);
    if (!namespace.match?.includes('<skill-id>') && !namespace.match?.includes('<artifact-id>')) issues.push(`namespace ${namespace.id} lacks a placeholder`);
    if (!Array.isArray(namespace.allowedInitialFiles) || namespace.allowedInitialFiles.length === 0) issues.push(`namespace ${namespace.id} has no initial file allowlist`);
  }
  return issues;
}

export async function resolveArtifacts(root, manifest) {
  const resolved = manifest.artifacts.map((artifact) => ({ ...structuredClone(artifact), namespaceId: null }));
  const explicitIds = new Set(resolved.map((artifact) => artifact.id));
  for (const namespace of manifest.namespaces) {
    const [prefix, placeholder] = namespace.match.split('/');
    if (!placeholder?.startsWith('<')) continue;
    const namespaceRoot = path.join(root, prefix);
    if (!await pathExists(namespaceRoot)) continue;
    const entries = await readdir(namespaceRoot, { withFileTypes: true });
    const entryPattern = namespace.kind === 'skill' ? SKILL_ID_PATTERN : ID_PATTERN;
    for (const entry of entries.filter((candidate) => candidate.isDirectory() || candidate.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      invariant(entryPattern.test(entry.name), 'INVALID_ARTIFACT_NAME', `Invalid managed artifact id: ${entry.name}`);
      const artifactId = namespace.artifactId.replace('<skill-id>', entry.name).replace('<artifact-id>', entry.name);
      if (explicitIds.has(artifactId)) continue;
      explicitIds.add(artifactId);
      const replace = (value) => value.replaceAll('<skill-id>', entry.name).replaceAll('<artifact-id>', entry.name);
      resolved.push({
        id: artifactId,
        kind: namespace.kind,
        source: [replace(namespace.match)],
        ownership: namespace.ownership,
        risk: namespace.risk,
        providers: [...namespace.providers],
        platforms: [...namespace.platforms],
        validators: [...namespace.validators],
        allowedInitialFiles: namespace.allowedInitialFiles.map(replace),
        deniedFiles: namespace.deniedFiles.map(replace),
        targets: Object.fromEntries(Object.entries(namespace.targets ?? {}).map(([key, value]) => [key, replace(value)])),
        ...(namespace.upstream ? {
          upstream: {
            ...namespace.upstream,
            repo: replace(namespace.upstream.repo),
            path: replace(namespace.upstream.path),
          },
        } : {}),
        namespaceId: namespace.id,
      });
    }
  }
  return resolved.sort((a, b) => a.id.localeCompare(b.id));
}

export function expandArtifactDependencies(artifacts, requestedIds) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const selected = new Set();
  const visiting = new Set();
  const visit = (artifactId, trail = []) => {
    const artifact = byId.get(artifactId);
    invariant(artifact, 'ARTIFACT_DEPENDENCY_MISSING', `Artifact dependency is unavailable: ${artifactId}`, { trail });
    invariant(!visiting.has(artifactId), 'ARTIFACT_DEPENDENCY_CYCLE', `Artifact dependency cycle: ${[...trail, artifactId].join(' -> ')}`);
    if (selected.has(artifactId)) return;
    visiting.add(artifactId);
    for (const dependency of artifact.dependencies ?? []) visit(dependency, [...trail, artifactId]);
    visiting.delete(artifactId);
    selected.add(artifactId);
  };
  for (const artifactId of requestedIds) visit(artifactId);
  return artifacts.filter((artifact) => selected.has(artifact.id));
}

export function effectivePathRisk(relativePath, declaredRisk, policy) {
  const normalized = normalizeRelative(relativePath);
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized).toLowerCase();
  if (STRICT_CONTROL_BASENAMES.has(basename)) return 'control-confirm';
  if (STRICT_CONTROL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'control-confirm';
  if (normalized.startsWith('providers/') && basename !== 'instructions.append.md') return 'control-confirm';
  if (/^agents\/[^/]+\/agent\.json$/.test(normalized)) return 'control-confirm';
  if (policy.contentAuto.deniedBasenames.includes(basename)) return 'control-confirm';
  if (policy.contentAuto.deniedPathPrefixes.some((prefix) => normalized.startsWith(prefix))) return 'control-confirm';
  if (['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.ps1', '.sh', '.cmd', '.bat', '.exe', '.dll', '.py', '.rb'].includes(extension)) return 'control-confirm';
  if (declaredRisk !== 'content-auto') return declaredRisk;
  if (!policy.contentAuto.allowedExtensions.includes(extension)) return 'control-confirm';
  return 'content-auto';
}

export async function inspectFrontmatterRisk(file, declaredRisk, policy, relativePath = file) {
  const relative = toPortablePath(relativePath);
  const pathRisk = effectivePathRisk(relative, declaredRisk, policy);
  if (pathRisk !== 'content-auto' || path.extname(file).toLowerCase() !== '.md') return pathRisk;
  const content = await readFile(file, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return pathRisk;
  const keys = match[1].split(/\r?\n/).map((line) => line.match(/^([A-Za-z0-9_-]+):/)?.[1]?.toLowerCase()).filter(Boolean);
  return keys.some((key) => policy.contentAuto.deniedFrontmatterKeys.includes(key)) ? 'control-confirm' : pathRisk;
}

export async function buildManifestLock(root, configuration) {
  const artifacts = await resolveArtifacts(root, configuration.manifest);
  return {
    $schema: './schemas/manifest-lock.schema.json',
    schemaVersion: 1,
    manifestDigest: digestObject(configuration.manifest),
    generatedBy: 'agent-config validate --write-lock',
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      source: artifact.source,
      ownership: artifact.ownership,
      risk: artifact.risk,
      providers: artifact.providers,
      platforms: artifact.platforms,
      validators: artifact.validators,
      dependencies: artifact.dependencies ?? [],
      targets: artifact.targets ?? {},
      namespaceId: artifact.namespaceId,
    })),
  };
}

function renderNamespaceArtifact(namespace, name) {
  const replace = (value) => value.replaceAll('<skill-id>', name).replaceAll('<artifact-id>', name);
  return {
    id: replace(namespace.artifactId), kind: namespace.kind, source: [replace(namespace.match)],
    ownership: namespace.ownership, risk: namespace.risk, providers: namespace.providers,
    platforms: namespace.platforms, validators: namespace.validators,
    targets: Object.fromEntries(Object.entries(namespace.targets ?? {}).map(([key, value]) => [key, replace(value)])),
    allowedInitialFiles: namespace.allowedInitialFiles.map(replace),
    deniedFiles: namespace.deniedFiles.map(replace),
    ...(namespace.upstream ? {
      upstream: {
        ...namespace.upstream,
        repo: replace(namespace.upstream.repo),
        path: replace(namespace.upstream.path),
      },
    } : {}),
    namespaceId: namespace.id, creation: true,
  };
}

export async function locateArtifact(root, configuration, query, { allowCreation = false, allowAdoption = false } = {}) {
  invariant(typeof query === 'string' && query.trim(), 'ARTIFACT_REQUIRED', 'Artifact query is required');
  invariant(!(allowCreation && allowAdoption), 'ADOPTION_CREATION_CONFLICT', 'Adoption and ordinary creation are separate explicit intents');
  const normalizedQuery = query.trim().toLowerCase();
  const alias = configuration.routing.aliases?.[normalizedQuery];
  const artifacts = await resolveArtifacts(root, configuration.manifest);
  const exact = artifacts.filter((artifact) => artifact.id === alias || artifact.id === normalizedQuery || artifact.id.endsWith(`.${normalizedQuery}`));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new AgentConfigError('AMBIGUOUS_ARTIFACT', `Artifact name is ambiguous: ${query}`, { matches: exact.map((item) => item.id) });
  if ((allowCreation || allowAdoption) && ID_PATTERN.test(normalizedQuery)) {
    const matches = configuration.manifest.namespaces.filter((namespace) => {
      const placeholders = namespace.match?.match(/<[^>]+>/g) ?? [];
      return placeholders.length === 1 && ['<skill-id>', '<artifact-id>'].includes(placeholders[0]);
    });
    invariant(matches.length === 1, 'AMBIGUOUS_NAMESPACE', `Creation requires exactly one matching namespace for ${query}`, { count: matches.length });
    const artifact = renderNamespaceArtifact(matches[0], normalizedQuery);
    if (allowAdoption) {
      artifact.adoption = true;
      artifact.risk = 'control-confirm';
    }
    return artifact;
  }
  throw new AgentConfigError('ARTIFACT_NOT_FOUND', `No managed artifact resolves from: ${query}`);
}

export function assertTransactionRisk(paths, artifact, policy) {
  const risks = new Set(paths.map((relative) => effectivePathRisk(relative, artifact.risk, policy)));
  if (risks.has('control-confirm')) return 'control-confirm';
  if (risks.has('not-deployable')) return 'not-deployable';
  return 'content-auto';
}

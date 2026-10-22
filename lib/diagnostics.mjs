import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkInstalled } from './apply.mjs';
import { inventoryAll } from './inventory.mjs';
import { pathExists } from './fs-safe.mjs';
import { loadConfiguration, resolveArtifacts } from './manifest.mjs';
import { resolveRoots } from './paths.mjs';
import { validateRepository } from './validators.mjs';

export async function inspectSkillRuntimeDependencies({ root, roots }) {
  const configuration = await loadConfiguration(root);
  const artifacts = await resolveArtifacts(root, configuration.manifest);
  const missing = [];
  const seen = new Set();
  const referencePattern = /~\/(\.claude|\.codex|\.agents)\/skills\/([a-z0-9][a-z0-9._-]*)\//gi;
  for (const artifact of artifacts.filter((item) => item.kind === 'skill')) {
    for (const source of artifact.source) {
      const skillFile = path.join(root, source, 'SKILL.md');
      if (!await pathExists(skillFile)) continue;
      const content = await readFile(skillFile, 'utf8');
      for (const match of content.matchAll(referencePattern)) {
        const dependencyRoot = path.join(roots.USER_HOME, match[1], 'skills', match[2]);
        const key = `${artifact.id}\0${dependencyRoot}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!await pathExists(dependencyRoot)) missing.push({
          artifactId: artifact.id,
          dependency: match[2],
          path: dependencyRoot,
          reference: match[0],
        });
      }
    }
  }
  return missing;
}

export async function check({ root, stateRoot, roots: providedRoots = null, projectRoot }) {
  const roots = providedRoots || resolveRoots({ root, stateRoot });
  const validation = await validateRepository(roots.AGENT_CONFIG_ROOT);
  const installed = await checkInstalled({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots });
  const inventory = await inventoryAll({ roots, projectRoot: projectRoot || process.cwd() });
  const runtimeDependencies = await inspectSkillRuntimeDependencies({ root: roots.AGENT_CONFIG_ROOT, roots });
  const availableSkills = new Set(inventory.metadata.skills.map((skill) => skill.name?.toLowerCase()).filter(Boolean));
  const missingHookSkills = (inventory.metadata.hookSkillReferences ?? [])
    .filter((skill) => !availableSkills.has(skill))
    .map((skill) => ({ skill, reference: `prompt hook references missing skill ${skill}` }));
  return {
    ok: validation.ok && installed.ok && runtimeDependencies.length === 0 && missingHookSkills.length === 0,
    source: { ok: validation.ok, issues: validation.issues },
    installed,
    instructionShadows: inventory.instructionShadows,
    runtimeDependencies,
    missingHookSkills,
  };
}

export async function doctor(options) {
  const result = await check(options);
  const facts = [];
  for (const issue of result.source.issues) facts.push({ severity: 'error', category: 'source', message: issue });
  for (const drift of result.installed.drift ?? []) {
    const owner = drift.artifactId ? ` (${drift.artifactId}${drift.provider ? `/${drift.provider}` : ''})` : '';
    facts.push({ severity: 'error', category: drift.reason ?? 'drift', artifactId: drift.artifactId ?? null, provider: drift.provider ?? null, target: drift.target, message: `${drift.reason ?? 'drift'}${owner}: ${drift.target}` });
  }
  for (const shadow of result.instructionShadows) facts.push({ severity: 'warning', category: 'instruction-shadow', message: `Active shadow instruction source: ${shadow.path}` });
  for (const dependency of result.runtimeDependencies ?? []) facts.push({ severity: 'error', category: 'runtime-dependency', artifactId: dependency.artifactId, target: dependency.path, message: `${dependency.artifactId} references missing runtime ${dependency.path}` });
  for (const missing of result.missingHookSkills ?? []) facts.push({ severity: 'error', category: 'missing-hook-skill', target: missing.skill, message: missing.reference });
  return { ok: facts.every((fact) => fact.severity !== 'error'), facts };
}

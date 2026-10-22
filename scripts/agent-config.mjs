#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPlan, checkInstalled, rollbackBackup } from '../lib/apply.mjs';
import { authorizationStatus } from '../lib/authorization.mjs';
import { captureBaseline } from '../lib/baseline.mjs';
import { createBackup } from '../lib/backup.mjs';
import { canonicalize } from '../lib/canonical-json.mjs';
import { check, doctor } from '../lib/diagnostics.mjs';
import { asResultError, AgentConfigError } from '../lib/errors.mjs';
import { pathExists, readJson } from '../lib/fs-safe.mjs';
import { inventoryAll } from '../lib/inventory.mjs';
import { loadConfiguration, locateArtifact } from '../lib/manifest.mjs';
import { calculatePlan } from '../lib/planner.mjs';
import { checkProvenance } from '../lib/provenance.mjs';
import { recover } from '../lib/recovery.mjs';
import { finalizeRelease, reconcileRelease } from '../lib/release.mjs';
import { resolveRoots } from '../lib/paths.mjs';
import { ensureStateLayout } from '../lib/state.mjs';
import { syncTrustedRelease } from '../lib/sync.mjs';
import { abortTransaction, beginTransaction, patchTransaction, promoteTransaction, readTransactionPath, reconcileTransaction, supersedeTransaction, testTransaction, transactionStatus } from '../lib/transaction.mjs';
import { scanGitHistory, validateRepository } from '../lib/validators.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    let value = inline;
    if (value === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) value = argv[++index];
    else if (value === undefined) value = true;
    if (Object.hasOwn(flags, key)) flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
    else flags[key] = value;
  }
  return { positional, flags };
}

function output(value, { pretty = true } = {}) {
  process.stdout.write(pretty ? canonicalize(value) : `${JSON.stringify(value)}\n`);
}

function help() {
  return `agent-config 0.1.0

Usage:
  agent-config inventory [--json]
  agent-config locate <artifact> [--allow-creation | --allow-adoption] [--json]
  agent-config authorization status
  agent-config validate [--write-lock] [--history]
  agent-config plan [--artifact <id>] [--out <path>] [--canonical-root <path>]
  agent-config apply --plan <path> [--confirm-plan-id <id>] [--local-only]
  agent-config release finalize --plan <path>
  agent-config release reconcile --plan-id <id> --branch <name> --expected-base <commit> --confirm-plan-id <id>
  agent-config transaction begin --artifact <id> [--atomic-artifact <id> ...] --provider <claude|codex> --request <text> [--allow-creation | --adopt-existing | --allow-retirement --retirement-artifact <id> ...] [--scope <scope>] [--token <token>]
  agent-config transaction read <id> <path>
  agent-config transaction patch <id> --patch <json-file>
  agent-config transaction test <id>
  agent-config transaction promote <id> [--confirm-plan-id <id>]
  agent-config transaction status <id>
  agent-config transaction reconcile <id>
  agent-config transaction supersede <id> --replacement <id>
  agent-config transaction abort <id>
  agent-config sync
  agent-config check [--provenance [--baseline <id>]]
  agent-config doctor
  agent-config watch
  agent-config backup [--baseline] [--project-root <path>]
  agent-config rollback <backup-id>
  agent-config recover [--apply --confirm-plan-id <recoveryPlanId>]

Global overrides:
  --root <path>           Candidate source checkout
  --canonical-root <path> Runtime canonical checkout (plan/apply only)
  --state-root <path>     Machine-local state root
`;
}

async function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [command = 'help', subcommand, ...rest] = positional;
  if (['help', '-h', '--help'].includes(command)) { process.stdout.write(help()); return 0; }
  const sourceRoot = path.resolve(flags.root || scriptRoot);
  const roots = resolveRoots({ root: flags.canonicalRoot || sourceRoot, stateRoot: flags.stateRoot });
  const configuration = await loadConfiguration(command === 'plan' || command === 'apply' ? sourceRoot : roots.AGENT_CONFIG_ROOT);
  const projectRoot = flags.projectRoot || process.cwd();

  if (command === 'inventory') {
    output(await inventoryAll({ roots, projectRoot }));
    return 0;
  }
  if (command === 'locate') {
    const query = subcommand || flags.artifact;
    output(await locateArtifact(roots.AGENT_CONFIG_ROOT, configuration, query, { allowCreation: Boolean(flags.allowCreation), allowAdoption: Boolean(flags.allowAdoption) }));
    return 0;
  }
  if (command === 'authorization' && subcommand === 'status') {
    output(await authorizationStatus({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, policy: configuration.policy }));
    return 0;
  }
  if (command === 'validate') {
    const validation = await validateRepository(roots.AGENT_CONFIG_ROOT, { writeLock: Boolean(flags.writeLock) });
    const result = { ok: validation.ok, issues: validation.issues, artifacts: validation.artifacts.map((artifact) => artifact.id) };
    if (flags.history) result.history = scanGitHistory(roots.AGENT_CONFIG_ROOT);
    output(result);
    return result.ok && (!result.history || result.history.passed) ? 0 : 1;
  }
  if (command === 'plan') {
    const artifactIds = flags.artifact ? (Array.isArray(flags.artifact) ? flags.artifact : [flags.artifact]) : null;
    const result = await calculatePlan({ root: sourceRoot, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, out: flags.out, artifactIds, roots });
    output({ planId: result.plan.planId, planPath: result.planPath, risk: result.plan.risk, confirmation: result.plan.confirmation });
    return 0;
  }
  if (command === 'apply') {
    if (!flags.plan) throw new AgentConfigError('PLAN_REQUIRED', '--plan is required');
    output(await applyPlan({ planPath: flags.plan, root: sourceRoot, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, confirmationPlanId: flags.confirmPlanId, roots, localOnly: Boolean(flags.localOnly) }));
    return 0;
  }
  if (command === 'release' && subcommand === 'finalize') {
    if (!flags.plan) throw new AgentConfigError('PLAN_REQUIRED', '--plan is required');
    output(await finalizeRelease({ planPath: flags.plan, root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots }));
    return 0;
  }
  if (command === 'release' && subcommand === 'reconcile') {
    if (!flags.planId || !flags.branch || !flags.expectedBase) throw new AgentConfigError('RECONCILE_ARGUMENTS_REQUIRED', '--plan-id, --branch, and --expected-base are required');
    output(await reconcileRelease({ planId: flags.planId, branch: flags.branch, expectedBase: flags.expectedBase, confirmationPlanId: flags.confirmPlanId, root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT }));
    return 0;
  }
  if (command === 'transaction') {
    const action = subcommand;
    const transactionId = rest[0];
    if (action === 'begin') {
      let issuerPublicKey = null;
      const issuerPath = path.join(roots.AGENT_CONFIG_STATE_ROOT, 'authorizations', 'issuer-public-key.pem');
      if (await pathExists(issuerPath)) issuerPublicKey = await readFile(issuerPath, 'utf8');
      const retirementArtifacts = flags.retirementArtifact
        ? (Array.isArray(flags.retirementArtifact) ? flags.retirementArtifact : [flags.retirementArtifact])
        : null;
      const atomicArtifacts = flags.atomicArtifact
        ? (Array.isArray(flags.atomicArtifact) ? flags.atomicArtifact : [flags.atomicArtifact])
        : null;
      output(await beginTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, artifact: flags.artifact, atomicArtifacts, provider: flags.provider, request: flags.request, scope: flags.scope || 'local-only', token: flags.token || null, issuerPublicKey, allowCreation: Boolean(flags.allowCreation), adoptExisting: Boolean(flags.adoptExisting), allowRetirement: Boolean(flags.allowRetirement), retirementArtifacts, roots }));
    } else if (action === 'read') {
      output(await readTransactionPath({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId, relativePath: rest[1], maxBytes: configuration.policy.limits.readBytes }));
    } else if (action === 'patch') {
      if (!flags.patch) throw new AgentConfigError('PATCH_REQUIRED', '--patch JSON file is required');
      const patch = JSON.parse(await readFile(path.resolve(flags.patch), 'utf8'));
      output(await patchTransaction({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId, changes: patch.changes ?? patch, policy: configuration.policy }));
    } else if (action === 'test') output(await testTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId, roots }));
    else if (action === 'promote') output(await promoteTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId, confirmationPlanId: flags.confirmPlanId, roots }));
    else if (action === 'status') output(await transactionStatus({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId }));
    else if (action === 'reconcile') output(await reconcileTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId }));
    else if (action === 'supersede') {
      if (!flags.replacement) throw new AgentConfigError('REPLACEMENT_REQUIRED', '--replacement transaction id is required');
      output(await supersedeTransaction({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId, replacementTransactionId: flags.replacement }));
    }
    else if (action === 'abort') output(await abortTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId }));
    else throw new AgentConfigError('TRANSACTION_ACTION', `Unknown transaction action: ${action}`);
    return 0;
  }
  if (command === 'sync') {
    const result = await syncTrustedRelease({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots });
    output(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'check') {
    if (flags.provenance) {
      const result = await checkProvenance({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, baselineId: flags.baseline ?? null });
      output(result);
      return result.ok ? 0 : 1;
    }
    const result = await check({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, projectRoot });
    output(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'doctor') {
    const result = await doctor({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, projectRoot });
    output(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'watch') {
    process.stdout.write('agent-config watch: diagnostic mode; raw saves are never promoted.\n');
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try { output(await check({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, projectRoot })); }
      finally { running = false; }
    };
    await run();
    const { watch } = await import('node:fs');
    let timer;
    const watcher = watch(roots.AGENT_CONFIG_ROOT, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(run, 500); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { watcher.close(); process.exit(0); });
    await new Promise(() => {});
  }
  if (command === 'backup') {
    if (flags.baseline) output(await captureBaseline({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, projectRoot, roots }));
    else {
      const state = await ensureStateLayout(roots.AGENT_CONFIG_STATE_ROOT);
      if (!await pathExists(state.current)) throw new AgentConfigError('NO_INSTALL', 'No installed targets exist to back up');
      const current = await readJson(state.current);
      output(await createBackup(roots.AGENT_CONFIG_STATE_ROOT, current.targets.map((item) => item.target), roots));
    }
    return 0;
  }
  if (command === 'rollback') {
    if (!subcommand) throw new AgentConfigError('BACKUP_REQUIRED', 'Backup id is required');
    output(await rollbackBackup({ backupId: subcommand, root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots }));
    return 0;
  }
  if (command === 'recover') {
    const result = await recover({
      root: roots.AGENT_CONFIG_ROOT,
      stateRoot: roots.AGENT_CONFIG_STATE_ROOT,
      roots,
      apply: Boolean(flags.apply),
      confirmationPlanId: flags.confirmPlanId ?? null,
    });
    output(result);
    return result.mode === 'preview' || result.ok ? 0 : 1;
  }
  throw new AgentConfigError('COMMAND_UNKNOWN', `Unknown command: ${command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  const result = asResultError(error);
  process.stderr.write(canonicalize(result));
  process.exitCode = error instanceof AgentConfigError ? 2 : 3;
}

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { check, doctor } from './diagnostics.mjs';
import { asResultError } from './errors.mjs';
import { loadConfiguration, locateArtifact } from './manifest.mjs';
import { resolveRoots } from './paths.mjs';
import { reconcileRelease } from './release.mjs';
import { syncTrustedRelease } from './sync.mjs';
import { importSuiteObject } from './state.mjs';
import { abortTransaction, beginTransaction, patchTransaction, promoteTransaction, readTransactionPath, reconcileTransaction, supersedeTransaction, testTransaction, transactionStatus } from './transaction.mjs';

export const toolDefinitions = [
  { name: 'locate', description: 'Resolve one managed artifact without mutating state. allowAdoption resolves only a new portable skill candidate for explicit installed-byte adoption.', inputSchema: { type: 'object', required: ['artifact'], properties: { artifact: { type: 'string' }, allowCreation: { type: 'boolean' }, allowAdoption: { type: 'boolean' } } } },
  { name: 'transaction_begin', description: 'Begin a scoped transaction from a direct explicit user request. atomicArtifacts enables an exact-confirmed non-retirement transaction over an explicit artifact list with the primary first. adoptExisting imports only the exact supported portable-skill topology. Multi-artifact retirement remains separate and requires allowRetirement.', inputSchema: { type: 'object', required: ['artifact', 'provider', 'request'], properties: { artifact: { type: 'string' }, atomicArtifacts: { type: 'array', items: { type: 'string' }, minItems: 2 }, provider: { enum: ['claude', 'codex'] }, request: { type: 'string' }, scope: { enum: ['local-only', 'trusted-sync'] }, token: { type: 'string' }, allowCreation: { type: 'boolean' }, adoptExisting: { type: 'boolean' }, allowRetirement: { type: 'boolean' }, retirementArtifacts: { type: 'array', items: { type: 'string' }, minItems: 1 }, activateExisting: { type: 'boolean' } } } },
  { name: 'transaction_read', description: 'Read one authorized transaction path with its hash.', inputSchema: { type: 'object', required: ['transactionId', 'path'], properties: { transactionId: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'transaction_patch', description: 'Apply structured expected-hash changes inside a transaction.', inputSchema: { type: 'object', required: ['transactionId', 'changes'], properties: { transactionId: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } } } },
  { name: 'transaction_test', description: 'Run immutable controller-owned transaction gates.', inputSchema: { type: 'object', required: ['transactionId'], properties: { transactionId: { type: 'string' } } } },
  { name: 'transaction_promote', description: 'Prepare or promote a tested transaction. Provider-context and control-plane changes stop for confirmation.', inputSchema: { type: 'object', required: ['transactionId'], properties: { transactionId: { type: 'string' }, confirmationPlanId: { type: 'string' } } } },
  { name: 'transaction_status', description: 'Read redacted transaction status.', inputSchema: { type: 'object', required: ['transactionId'], properties: { transactionId: { type: 'string' } } } },
  { name: 'transaction_reconcile', description: 'Fast-forward or absorb one verified provisional transaction into its recorded clean canonical branch without reinstalling.', inputSchema: { type: 'object', required: ['transactionId'], properties: { transactionId: { type: 'string' } } } },
  { name: 'transaction_supersede', description: 'Mark a non-active provisional transaction superseded by a reconciled transaction while retaining evidence and rollback objects.', inputSchema: { type: 'object', required: ['transactionId', 'replacementTransactionId'], properties: { transactionId: { type: 'string' }, replacementTransactionId: { type: 'string' } } } },
  { name: 'transaction_abort', description: 'Abort an uninstalled transaction.', inputSchema: { type: 'object', required: ['transactionId'], properties: { transactionId: { type: 'string' } } } },
  { name: 'suite_object_import', description: 'Import a reviewed external-suite snapshot into the content-addressed candidate store without activating provider targets.', inputSchema: { type: 'object', required: ['sourcePath', 'expectedDigest'], properties: { sourcePath: { type: 'string' }, expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
  { name: 'release_reconcile', description: 'After separate exact confirmation, fast-forward the clean canonical branch to the currently installed verified plan without signing, pushing, reinstalling, or rolling back.', inputSchema: { type: 'object', required: ['planId', 'branch', 'expectedBase', 'confirmationPlanId'], properties: { planId: { type: 'string' }, branch: { type: 'string' }, expectedBase: { type: 'string' }, confirmationPlanId: { type: 'string' } } } },
  { name: 'sync', description: 'Verify and install an eligible trusted signed content release.', inputSchema: { type: 'object', properties: {} } },
  { name: 'check', description: 'Detect source and installed drift without repair.', inputSchema: { type: 'object', properties: {} } },
  { name: 'doctor', description: 'Explain configuration and deployment problems without exposing secrets.', inputSchema: { type: 'object', properties: {} } },
];

export function createController({ root, stateRoot, projectRoot }) {
  const roots = resolveRoots({ root, stateRoot });
  async function invoke(name, args = {}) {
    const configuration = await loadConfiguration(roots.AGENT_CONFIG_ROOT);
    if (name === 'locate') return locateArtifact(roots.AGENT_CONFIG_ROOT, configuration, args.artifact, { allowCreation: args.allowCreation, allowAdoption: args.allowAdoption });
    if (name === 'transaction_begin') {
      const issuerPath = path.join(roots.AGENT_CONFIG_STATE_ROOT, 'authorizations', 'issuer-public-key.pem');
      let issuerPublicKey = null;
      try { issuerPublicKey = await readFile(issuerPath, 'utf8'); } catch {}
      return beginTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, ...args, issuerPublicKey, roots });
    }
    if (name === 'transaction_read') return readTransactionPath({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId, relativePath: args.path, maxBytes: configuration.policy.limits.readBytes });
    if (name === 'transaction_patch') return patchTransaction({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId, changes: args.changes, policy: configuration.policy });
    if (name === 'transaction_test') return testTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId, roots });
    if (name === 'transaction_promote') return promoteTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId, confirmationPlanId: args.confirmationPlanId, roots });
    if (name === 'transaction_status') return transactionStatus({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId });
    if (name === 'transaction_reconcile') return reconcileTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId });
    if (name === 'transaction_supersede') return supersedeTransaction({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId, replacementTransactionId: args.replacementTransactionId });
    if (name === 'transaction_abort') return abortTransaction({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, transactionId: args.transactionId });
    if (name === 'suite_object_import') return importSuiteObject({ stateRoot: roots.AGENT_CONFIG_STATE_ROOT, sourcePath: args.sourcePath, expectedDigest: args.expectedDigest });
    if (name === 'release_reconcile') return reconcileRelease({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, ...args });
    if (name === 'sync') return syncTrustedRelease({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots });
    if (name === 'check') return check({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, projectRoot });
    if (name === 'doctor') return doctor({ root: roots.AGENT_CONFIG_ROOT, stateRoot: roots.AGENT_CONFIG_STATE_ROOT, roots, projectRoot });
    throw new Error(`Unknown controller tool: ${name}`);
  }
  return { roots, invoke };
}

export async function serveStdio(options) {
  const controller = createController(options);
  process.stdin.setEncoding('utf8');
  let buffer = '';
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (request.method === 'notifications/initialized') continue;
      if (request.method === 'initialize') {
        write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-config-controller', version: '0.1.0' } } });
      } else if (request.method === 'tools/list') {
        write({ jsonrpc: '2.0', id: request.id, result: { tools: toolDefinitions } });
      } else if (request.method === 'tools/call') {
        try {
          const result = await controller.invoke(request.params?.name, request.params?.arguments ?? {});
          write({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } });
        } catch (error) {
          const failure = asResultError(error);
          write({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify(failure.error) }], structuredContent: failure } });
        }
      } else if (request.id !== undefined) {
        write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  }
}

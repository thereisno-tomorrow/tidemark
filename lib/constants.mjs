export const TOOL_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const OWNERSHIP = new Set([
  'shared-link', 'shared-copy', 'shared-generated', 'provider-only',
  'platform-overlay', 'project-owned', 'external-managed',
  'runtime-excluded', 'archived',
  // Canonical in ANOTHER governed repository; vendored here only so both
  // providers can reach it. Requires an `upstream` block, and divergence from
  // upstream is a reportable defect rather than an edit. The original taxonomy
  // conflated ownership with distribution and so had nowhere to put a file that
  // someone else owns but agent-config delivers.
  'foreign-owned',
]);
export const RISK = new Set(['content-auto', 'control-confirm', 'not-deployable']);
export const PROVIDERS = new Set(['claude', 'codex']);
export const PLATFORMS = new Set(['windows', 'macos']);
export const STRICT_CONTROL_PREFIXES = [
  'automation/', 'bootstrap/', 'hooks/', 'mcp/', 'platforms/',
  'schemas/', 'scripts/', 'tests/',
];
export const STRICT_CONTROL_BASENAMES = new Set([
  'manifest.json', 'manifest.lock.json', 'package.json', 'trusted-signers',
]);
export const RUNTIME_EXCLUSIONS = [
  '.git', 'cache', 'caches', 'history', 'session', 'sessions', 'telemetry',
  'logs', 'downloads', 'statsig', 'shell-snapshots', 'debug', 'tmp', 'temp',
  'oauth', 'auth', 'credentials', 'cookies', 'browser', 'backups',
];

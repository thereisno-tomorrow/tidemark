# Tidemark

Tidemark is a local controller for personal Claude Code and Codex configuration. It records release snapshots, backs up touched targets, rolls back saved state, and detects drift when checked.
For one person managing local configuration in Git on Windows. It is not for enforcing policy against processes with the same user's access. See [the threat model](SECURITY.md).

Names: the project is Tidemark. The command is still `agent-config`; `package.json` also lists a `tidemark` alias for the same script. The `AGENT_CONFIG_*` environment variables and the `agent-config` state folder keep their names in this version.

Built with AI coding agents. Every behavior claim here maps to a passing test.

## What it does

These named tests passed on Windows with Node 24.20.0: 127 passed, 0 failed, 0 skipped. The limits are part of each claim.

| Behavior | Passing test title and file | Limits |
| --- | --- | --- |
| One source feeds both tools through links into one release snapshot. | `CLI starter: a second caller holding the exact plan ID installs; missing and wrong IDs leave state unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | The example-notes directories resolve to the same release directory. Tool discovery inside Claude or Codex, other machines, and every skill are not demonstrated. |
| Installs record a release snapshot; check detects later snapshot edits. | `CLI limitation: direct edits are allowed and detected only by check; source edits leave installed snapshot bytes unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | Source edits leave installed bytes unchanged. Direct writes still succeed. Immutable describes the release model; it does not mean write protection, authenticity, or automatic monitoring. |
| Installs back up touched targets before changing them. | `CLI backs up every touched target before mutation and rollback restores binary bytes, junction topology and absence` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | Tested binary files, links, and absent targets; journal ordering is observed. Crash durability, disk or ACL failures, every artifact kind, and backup write protection are not demonstrated. |
| Rollback restores exact saved bytes, link topology and absent targets when current state matches the expected install. | `CLI backs up every touched target before mutation and rollback restores binary bytes, junction topology and absence` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `rollback preserves an unknown replacement and reports rollback-conflict` — [apply.test.mjs](tests/integration/apply.test.mjs) | Unknown replacements can cause a conflict. Arbitrary outside edits, ACLs, ownership metadata, and every filesystem type are outside this evidence. |
| check detects managed-content drift when run: exit 0 for a clean install and 1 after a direct edit to managed content. | `CLI limitation: direct edits are allowed and detected only by check; source edits leave installed snapshot bytes unchanged`; `CLI control categories each require the exact plan ID before changing state` (subtest `provider.codex-config`, nested subtest `check exits 1 after a direct edit of installed config.toml`) — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | Demonstrated for starter skill content and the tested Codex config block, not arbitrary configurations or every native edit. Semantic JSON formatting changes are tolerated. No continuous monitoring or write blocking. |
| Provenance checks detect content differences from a recorded baseline. | `provenance flags a content change and ignores line endings`; `provenance reports a missing baseline instead of passing quietly` — [provenance.test.mjs](tests/unit/provenance.test.mjs) | No authentic-origin or signed-lineage claim. Line-ending differences are reported separately. The starter has no provenance baseline. |
| Control-plane installs require the exact plan ID. Before any backup or write, apply re-derives the plan from the current source and state and refuses a saved plan that differs from it, with `PLAN_MISMATCH`. | `CLI control categories each require the exact plan ID before changing state` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID`; `CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs`; `direct library apply re-derives a forged plan file with no declared inputs and refuses lowered risk` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | The ID identifies no caller. A process with your access can run `plan` itself and use the ID. A plan made through a transaction takes its declared inputs from the transaction record in the state folder, which is trusted. A saved plan is also refused if the deployment branch moved or the source changed after planning; plan again. That refusal has no separate named test. Tested categories: script skill, agent tool list, Claude settings/permissions, Codex config and Codex hooks. No host approval, Claude MCP registration, direct-write control, or exhaustive risk-classification claim. |
| A saved plan file cannot lower its own confirmation requirement or drop its backup entries: apply refuses it. | `CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID`; `CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs`; `direct library apply re-derives a forged plan file with no declared inputs and refuses lowered risk` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | Tested forgeries, each with a recomputed content ID: confirmation cleared, risk lowered, backup scope emptied with an operation dropped, a target swapped, an operation added, and the source binding changed (subtests 1 to 6b). Each was refused with `PLAN_MISMATCH` and home and state were unchanged; the CLI tests also compared the deployment branch. The check compares against source and state, so it trusts both. A library caller that passes declared inputs, or that calculated the plan in the same process, is trusted with those inputs. Sync is not exercised. |
| Apply refuses a missing or wrong plan ID when the plan requires confirmation; installed state is unchanged after the refusal. | `CLI starter: a second caller holding the exact plan ID installs; missing and wrong IDs leave state unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | A saved plan that clears its own requirement is refused with `PLAN_MISMATCH` (subtests 1 and 2). Home/state descriptors and deployment branch match after rejection. This does not establish absence of transient writes, timestamp/ACL changes, or hostile parallel writes. |
| Transactions record begin, patch and test stages and require confirmation for control-confirm promotion; the tested failed edits leave the deployment branch unchanged. Promote re-derives its stored plan from the transaction record and refuses a forged one. | `control-confirm transaction installs only after its exact plan is confirmed`; `provider-context transaction patches only an allowed file and stops at exact promotion confirmation` — [transaction.test.mjs](tests/integration/transaction.test.mjs); `CLI failed transaction leaves the deployment branch unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | Wrong-hash patches and untested promotion are covered. Every possible failure and successful signed branch finalization are not demonstrated. The transaction record lives in the state folder and is trusted. |
| recover without --apply records a preview and changes no fixture files. | `recover previews deterministically without writing, then applies only the exact confirmed preview` — [recovery.test.mjs](tests/integration/recovery.test.mjs); `CLI recover without apply leaves the entire interrupted fixture unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | Preview is returned as output. Tree hashes do not observe transient writes, timestamps or ACLs. Evidence covers the isolated fixture, not the whole computer. |
| The runtime has zero npm package dependencies. | `runtime has zero package dependencies and only built-in or relative literal imports` — [public-contract.test.mjs](tests/unit/public-contract.test.mjs) | Manifest and literal-import scan, not a JavaScript parser proof. Node and Git are still required. |
| On Windows, denied file symlinks report FILE_SYMLINK_DENIED and roll back the attempted install. | `Codex hook planning activates registration, dispatcher, and policy as one dependency-closed unit` — [adapters.test.mjs](tests/integration/adapters.test.mjs) | The denial path ran on the tested machine. Successful file symlinks with elevated privilege or Developer Mode and other operating systems are not demonstrated. |

## What it does not do

- The exact plan ID requires confirmation but identifies no caller. A separate process holding it can install. Evidence: `CLI starter: a second caller holding the exact plan ID installs; missing and wrong IDs leave state unchanged` in [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs).
- A direct installed edit is allowed. check detects it when run. Evidence: `CLI limitation: direct edits are allowed and detected only by check; source edits leave installed snapshot bytes unchanged` in [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs).
- Experimental sync is disabled by default. The tested disabled path changes no config or state and invokes no instrumented network or child-process entrypoints. Enabled sync is unsupported. Evidence: `limitation: experimental sync is disabled by default, writes nothing and invokes no network or child process` in [public-contract.test.mjs](tests/unit/public-contract.test.mjs). This is not exhaustive syscall tracing.
- Risk classification goes by path and file type, not by content. A file with a script header (a `#!` line) under a skill's `references/` folder plans as content-only and needs no confirmation. Evidence: `limitation: risk classification is by path and type, so a script-header file under references plans as content-only` in [classification-limit.test.mjs](tests/unit/classification-limit.test.mjs).

No OS-level enforcement, identified human confirmation, continuous monitoring, Claude-side MCP registration, multi-machine synchronization, or macOS or Linux support is claimed. No protection from malware, a compromised account, installed skill code, or third-party suites is claimed. Approval-prompt integration is untested.

## Review status

An adversarial review was started and ended early for tooling reasons. Areas it did not reach are unreviewed.

- **Covered:** attempts to install without the exact plan ID (missing, empty, partial, wrong-case and whitespace IDs, the local-only flag, a direct library call, and reconcile); a plan file edited after planning; a target outside the provider folders; risk classification of nested, mixed-case, oddly named and `package.json` script files; drift detection after an edited file, a deleted link, a link replaced by a copy, a line-ending change and an edit to the release snapshot.
- **Found two issues:** a forged plan file could skip the confirmation and the backup. This is fixed in this version and covered by the plan-integrity tests above. Risk classification goes by path and type, not by content. This is documented above, with a test.
- **Not covered, so unreviewed:** tampering with backups and the journal, rollback after an interrupted install, writes outside the configured folders, network or child-process use, and names built to escape the folders.

Areas the review covered without a finding are not extra claims. The claims are the tested rows above.

## Quickstart

Use a new PowerShell session in this checkout. Set a throwaway HOME and the remaining paths before running anything. Keep the same session for the examples. This changes this process's environment, not persistent Windows settings.

```powershell
$demoRoot = Join-Path $env:TEMP ('agent-config-demo-' + [guid]::NewGuid())
$env:AGENT_CONFIG_DEMO_ROOT = Join-Path $demoRoot 'starter'
$env:HOME = Join-Path $demoRoot 'home'
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = Join-Path $demoRoot 'local'
$env:APPDATA = Join-Path $demoRoot 'roaming'
$env:PROJECTS_ROOT = Join-Path $demoRoot 'projects'
$env:AGENT_CONFIG_ROOT = Join-Path $demoRoot 'config'
$env:AGENT_CONFIG_STATE_ROOT = Join-Path $demoRoot 'state'
$env:TEMP = Join-Path $demoRoot 'tmp'
$env:TMP = $env:TEMP
foreach ($key in 'HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PROJECTS_ROOT','AGENT_CONFIG_ROOT','AGENT_CONFIG_STATE_ROOT','TEMP','TMP') {
  $value = [Environment]::GetEnvironmentVariable($key)
  New-Item -ItemType Directory -Force -Path $value | Out-Null
  Write-Output "$key=$value"
}
```

The three starter commands preview a neutral config. See [starter details](examples/starter/README.md).

```powershell
node scripts/starter-demo.mjs prepare
node scripts/starter-demo.mjs validate
node scripts/starter-demo.mjs plan
```

The launcher uses the new starter subdirectory and prints the actual isolated paths beneath it. For a real plan/apply/check/rollback cycle, stay in the throwaway HOME and use that prepared config. Set its printed paths in the session:

```powershell
$env:HOME = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'home'
$env:USERPROFILE = $env:HOME
$env:LOCALAPPDATA = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'local'
$env:APPDATA = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'roaming'
$env:PROJECTS_ROOT = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'projects'
$env:AGENT_CONFIG_ROOT = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'config'
$env:AGENT_CONFIG_STATE_ROOT = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'state'
$env:TEMP = Join-Path $env:AGENT_CONFIG_DEMO_ROOT 'tmp'
$env:TMP = $env:TEMP
Set-Location $env:AGENT_CONFIG_ROOT
node scripts/agent-config.mjs plan --out ../plan.json
# Inspect ../plan.json and the returned plan ID before applying.
node scripts/agent-config.mjs apply --plan ../plan.json --confirm-plan-id <exact-plan-id>
node scripts/agent-config.mjs check
# Use backupId from the apply result.
node scripts/agent-config.mjs rollback <backup-id>
```

Replace the angle-bracket placeholders with the actual values; those lines are command templates. Full starter installation and these CLI behaviors are covered by the named e2e tests above. Keep experimenting in the printed copy before adapting paths to a profile you use. The confirmation value does not identify who supplied it.

## Requirements

Node 22 or newer and Git. On Windows, directories link with junctions. File-linked artifacts need Developer Mode or admin rights; otherwise the attempted install reports `FILE_SYMLINK_DENIED` and rolls back. The tested denial case is named above; successful privileged file linking has not been demonstrated here. This guide does not change privilege settings.

## Status

Version 0.1.0. Experimental. Tested locally on Windows with Node 24.20.0. A CI workflow (Windows, Node 22 and 24) is defined in `.github/workflows/test.yml`; its results are on the repository's Actions tab. Sync code is present but disabled by default and unsupported. The release snapshot model is called immutable; same-user writes remain possible.

## How it compares

Documentation review, 2026-10-22; these tools were not installed or compared by execution. Tidemark's scope is the tested local release, confirmation and recovery workflow above.

- [skillshare](https://github.com/runkids/skillshare) manages shared agent resources across clients, including skills, agents and MCP. Its scope includes cross-client sharing; this release excludes enabled sync.
- [agentctl](https://github.com/liangquanzhou/agentctl) manages agent configuration and documents plan, apply, rollback and MCP drift checks. The evidence here is limited to Tidemark's named Windows tests.
- [chezmoi](https://www.chezmoi.io/user-guide/command-overview/) manages dotfiles with diff and apply workflows. It is a general dotfile tool; this controller's tests cover agent-specific control-confirm plans.

## Project layout and tests

| Path | Contents |
| --- | --- |
| [lib/](lib/) | Controller implementation |
| [scripts/](scripts/) | CLI entrypoints and starter launcher |
| [scripts/check-claims.mjs](scripts/check-claims.mjs), [.github/workflows/test.yml](.github/workflows/test.yml), [.gitattributes](.gitattributes) | Claims lint, Windows CI definition and LF checkout rule |
| [schemas/](schemas/) | Configuration schemas |
| [tests/](tests/) | Unit and integration tests with isolated fixtures |
| [examples/starter/](examples/starter/) | Neutral example config |
| [platforms/](platforms/) | Windows paths |
| [manifest.json](manifest.json), [providers/](providers/), [automation/](automation/) | Configuration declarations and policies |

In a new PowerShell session, repeat the throwaway environment setup above. From the checkout run `node --test --test-concurrency=1`. This is the same suite command used for the 127-test result. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Nicholas Woo.

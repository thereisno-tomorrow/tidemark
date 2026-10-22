# Threat model and vulnerability reports

Tidemark is tamper-evident and recoverable within the tested scenarios below. It is not tamper-proof. These descriptions concern detection and saved-state recovery, not protection from same-user writes.

## What it helps with

| Behavior | Passing test title and file | Limits |
| --- | --- | --- |
| check detects accidental or unexplained managed-content changes when run. | `CLI limitation: direct edits are allowed and detected only by check; source edits leave installed snapshot bytes unchanged`; `CLI control categories each require the exact plan ID before changing state` (subtest `provider.codex-config`, nested subtest `check exits 1 after a direct edit of installed config.toml`) — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | Demonstrated for starter skill content and the tested Codex config block. Direct writes succeed. No background detection, write blocking, or coverage of every native edit. Semantic JSON formatting differences are tolerated. |
| Installs back up touched targets; rollback restores saved bytes, link topology and absent targets when current state matches the expected install. | `CLI backs up every touched target before mutation and rollback restores binary bytes, junction topology and absence` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `rollback preserves an unknown replacement and reports rollback-conflict` — [apply.test.mjs](tests/integration/apply.test.mjs) | Binary bytes, junctions, absence and journal ordering are covered. No guarantee through arbitrary outside edits, disk/ACL failures or power loss. ACLs and ownership metadata are outside the claim. |
| Control-plane installs require the exact plan ID. Before any backup or write, apply re-derives the plan from the current source and state and refuses a saved plan that differs from it, with `PLAN_MISMATCH`. Transactions record edit and test stages. | `CLI control categories each require the exact plan ID before changing state` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs); `control-confirm transaction installs only after its exact plan is confirmed` — [transaction.test.mjs](tests/integration/transaction.test.mjs); `CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID`; `CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs`; `direct library apply re-derives a forged plan file with no declared inputs and refuses lowered risk` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | The ID identifies no caller and grants no control over direct writes. A process with your access can run `plan` itself and use the ID. A plan made through a transaction takes its declared inputs from the transaction record in the state folder, which is trusted. A saved plan is also refused if the deployment branch moved or the source changed after planning; that refusal has no separate named test. Tested script skill, agent tool list, Claude settings/permissions, Codex config and Codex hooks. Not exhaustive risk classification. |
| A saved plan file cannot lower its own confirmation requirement or drop its backup entries: apply refuses it. | `CLI apply refuses each forged plan with PLAN_MISMATCH before any write; the unmodified plan still installs with its exact ID`; `CLI transaction promote re-derives its stored plan from the transaction record: a forged plan is refused and the original installs`; `direct library apply re-derives a forged plan file with no declared inputs and refuses lowered risk` — [plan-integrity.test.mjs](tests/integration/plan-integrity.test.mjs) | Tested forgeries, each with a recomputed content ID: confirmation cleared, risk lowered, backup scope emptied with an operation dropped, a target swapped, an operation added, and the source binding changed. Each was refused with `PLAN_MISMATCH` and home and state were unchanged; the CLI tests also compared the deployment branch. The check compares against source and state, so it trusts both. A library caller that passes declared inputs, or that calculated the plan in the same process, is trusted with those inputs. Sync is not exercised. |
| recover without --apply records a preview and changes no fixture files. | `CLI recover without apply leaves the entire interrupted fixture unchanged` — [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) | The preview is returned as output. Tree descriptors do not observe transient writes, timestamps or ACLs, and cover the isolated fixture. |

The tests demonstrate those cases on Windows. Immutable describes the release snapshot model. It does not describe file permissions or resistance to direct writes. See the [full behavior table](README.md#what-it-does) for evidence and limits on snapshots, provenance, transactions and file-link rollback.

## What it does not protect against

- Same-user writes to configuration, release snapshots, backups or state. A process with write access can edit them directly. The direct-write test above demonstrates an installed edit and its later detection by check; it does not test every writable path.
- Changes to records in the state folder. Transaction records, install records and backups there are trusted. A process that can write them can change what an install does.
- A confirmation supplied by another caller. `CLI starter: a second caller holding the exact plan ID installs; missing and wrong IDs leave state unchanged` in [e2e-cli.test.mjs](tests/integration/e2e-cli.test.mjs) demonstrates that separate processes can plan and install using the ID alone. It is not evidence of a person's identity or consent.
- Script content in a file that is classified as content. Risk classification goes by path and file type, not by content. A file with a script header (a `#!` line) under a skill's `references/` folder plans as content-only and needs no confirmation. `limitation: risk classification is by path and type, so a script-header file under references plans as content-only` in [classification-limit.test.mjs](tests/unit/classification-limit.test.mjs) demonstrates this.
- Malware or a compromised account. No such protection has been tested or is claimed.
- Code inside installed skills. Assume it runs with your tools' permissions. The tests do not assess the behavior of arbitrary skill code.
- Third-party suites you choose to install. They are outside these tests and this threat model.

No OS-level enforcement, continuous monitoring, Claude-side MCP registration, multi-machine synchronization, or macOS or Linux support is claimed. Experimental sync is disabled by default and unsupported. `limitation: experimental sync is disabled by default, writes nothing and invokes no network or child process` in [public-contract.test.mjs](tests/unit/public-contract.test.mjs) covers the disabled path with instrumented entrypoints, not enabled sync or exhaustive syscall tracing.

## Review status

An adversarial review was started and ended early for tooling reasons. Areas it did not reach are unreviewed.

- **Covered:** attempts to install without the exact plan ID (missing, empty, partial, wrong-case and whitespace IDs, the local-only flag, a direct library call, and reconcile); a plan file edited after planning; a target outside the provider folders; risk classification of nested, mixed-case, oddly named and `package.json` script files; drift detection after an edited file, a deleted link, a link replaced by a copy, a line-ending change and an edit to the release snapshot.
- **Found two issues:** a forged plan file could skip the confirmation and the backup. This is fixed in this version and covered by the plan-integrity tests in the table above. Risk classification goes by path and type, not by content. This is documented in the list above, with a test.
- **Not covered, so unreviewed:** tampering with backups and the journal, rollback after an interrupted install, writes outside the configured folders, network or child-process use, and names built to escape the folders.

Areas the review covered without a finding are not extra claims. The claims are the tested rows above.

## Assumptions

One user. One machine. Local Git. These are the intended operating conditions, not guarantees supplied by the controller. The tests use isolated local fixtures. A writable backup or state record is not an independent trust anchor. Provenance comparison is not proof of authentic origin or signed lineage; see the provenance tests in the README.

## If you need a human in the loop

Configure your tool's own approval prompt for the apply command, including `--confirm-plan-id`. Review the plan through that prompt before the command runs. This recipe has **not been tested** with Claude Code or Codex. The controller's plan ID alone does not identify who confirmed a change. No host approval behavior is claimed here.

## Reporting a vulnerability

Use the hosting platform's private vulnerability reporting for this repository. Include the version, reproduction steps, expected behavior and observed behavior. Omit credentials and private configuration. This local release candidate has no published reporting URL yet.

## Supported versions

0.1.x only. Version 0.1.0 is experimental. The local evidence is 127 passing tests on Windows with Node 24.20.0. CI results (Windows, Node 22 and 24) are on the repository's Actions tab.

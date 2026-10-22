# Inspect a starter installation

The [short demo](../README.md#quickstart) prepares a temporary copy of the starter, validates it and writes an installation plan. You can inspect the proposed Claude and Codex targets before applying anything.

This output was captured on October 23, 2026, on Windows with Node v24.20.0. All three commands exited with code 0. Git setup output and the printed environment paths are omitted here; the temporary root is shown as `<demo>`. Paths and IDs vary between runs.

## Prepare

```text
node scripts/starter-demo.mjs prepare
```

The launcher created a temporary Git repository containing the starter and controller runtime. Its profile, provider targets, state and temporary files are under the demo directory.

## Validate

```text
node scripts/starter-demo.mjs validate
```

Captured result:

```json
{
  "artifacts": [
    "agents.example-reviewer",
    "instructions.global",
    "skills.example-checklist",
    "skills.example-formatter",
    "skills.example-notes"
  ],
  "issues": [],
  "ok": true
}
```

The five artifacts are the reviewer agent, shared instructions and three skills. `ok: true` and the empty `issues` list report that the starter passed source validation.

## Plan

```text
node scripts/starter-demo.mjs plan
```

Captured result:

```json
{
  "confirmation": {
    "reason": "control-confirm",
    "required": true
  },
  "planId": "sha256:8380f5261f3305b7573b028e972caf5e41a18659786922353db8cf079a53b1a0",
  "planPath": "<demo>/plan.json",
  "risk": "control-confirm"
}
```

The starter includes an executable formatter and an agent tool list, so the combined plan requires control confirmation. The ID identifies this recorded plan. It does not identify who confirms it.

The generated `plan.json` contains these ten operations. This table selects the artifact, provider, operation type and target directly from that file; hashes and the remaining plan fields are omitted.

| Artifact | Provider | Operation | Target |
| --- | --- | --- | --- |
| `agents.example-reviewer` | claude | `replace-file` | `<demo>/home/.claude/agents/example-reviewer.md` |
| `agents.example-reviewer` | codex | `replace-file` | `<demo>/home/.codex/agents/example-reviewer.toml` |
| `instructions.global` | claude | `replace-file` | `<demo>/home/.claude/CLAUDE.md` |
| `instructions.global` | codex | `replace-file` | `<demo>/home/.codex/AGENTS.md` |
| `skills.example-checklist` | claude | `ensure-link` | `<demo>/home/.claude/skills/example-checklist` |
| `skills.example-checklist` | codex | `ensure-link` | `<demo>/home/.agents/skills/example-checklist` |
| `skills.example-formatter` | claude | `ensure-link` | `<demo>/home/.claude/skills/example-formatter` |
| `skills.example-formatter` | codex | `ensure-link` | `<demo>/home/.agents/skills/example-formatter` |
| `skills.example-notes` | claude | `ensure-link` | `<demo>/home/.claude/skills/example-notes` |
| `skills.example-notes` | codex | `ensure-link` | `<demo>/home/.agents/skills/example-notes` |

Every target was absent in this run. The plan therefore proposes new files and links under the temporary profile. Each shared artifact has a target in both assistants' native directory layouts.

The walkthrough stops here. Installation, drift checks and rollback have their own [full walkthrough](../README.md#quickstart) and [named behavior tests](../README.md#what-it-does).

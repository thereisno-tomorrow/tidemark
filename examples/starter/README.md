# Starter config

Three skills: notes and checklist are content-auto; formatter has a harmless script and is control-confirm.
The reviewer agent uses read-only tools and a Codex read-only sandbox. No contract is required.
Global instructions and empty provider settings are included. Nothing contacts a server.
Copy this folder to keep your own config. The controller supplies its runtime separately.
From the Tidemark checkout, use Node 22 or newer and Git. Choose a new temporary demo folder, then run the three steps:

```powershell
$env:AGENT_CONFIG_DEMO_ROOT = Join-Path $env:TEMP ('tidemark-demo-' + [guid]::NewGuid())
node scripts/starter-demo.mjs prepare
node scripts/starter-demo.mjs validate
node scripts/starter-demo.mjs plan
```
The launcher copies this config and the controller runtime into a new temporary Git repo.
It prints nine isolated paths; HOME, provider targets, state and temp files stay there.
Plan previews changes and shows the confirmation requirement. It writes `plan.json` without applying it. The starter contains five artifacts targeting both tools: three skills, a reviewer agent and shared instructions. The script and agent tool list make the plan `control-confirm`.

See [captured output](../../docs/demo.md) for the validation result and proposed operations, or the [full walkthrough](../../README.md#quickstart) to try installation and rollback. Edit the printed config copy to experiment.

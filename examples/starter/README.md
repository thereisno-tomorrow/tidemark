# Starter config

Three skills: notes and checklist are content-auto; formatter has a harmless script and is control-confirm.
The reviewer agent uses read-only tools and a Codex read-only sandbox. No contract is required.
Global instructions and empty provider settings are included. Nothing contacts a server.
Copy this folder to keep your own config. The controller supplies its runtime separately.
From the Tidemark checkout, try these three commands with Node 22 or newer:
```text
node scripts/starter-demo.mjs prepare
node scripts/starter-demo.mjs validate
node scripts/starter-demo.mjs plan
```
The launcher copies this config and the controller runtime into a new temporary Git repo.
It prints nine isolated paths; HOME, provider targets, state and temp files stay there.
Plan previews changes and shows the confirmation requirement. Edit the printed config copy to experiment.

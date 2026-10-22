# Building and checking Tidemark

Tidemark was built with AI coding agents. I set requirements for shared use and ordinary-request routing, and selected recovery and rollout behavior. The agents supplied much of the architecture, implementation, defect investigation and tests.

The [design history](design-history.md) follows those decisions. The investigations below show how agents tested and repaired the implementation.

## Internal consistency did not establish a clean import

The earlier configuration migration included text rewrites. Some replacements also matched inside paths and URLs, damaging their contents. Internal checks could still pass because the installed release matched the newly imported source. Both copies contained the same error.

An August 3 audit compared imported files with preserved pre-import bytes. Its initial pass had a coverage gap of its own: it looked for existing skills and did not compare commands that had been converted into skills. A later pass included those originals. The records also describe a corrupted file that an unrelated rewrite had already replaced, so examining only the current version would have missed that history.

The distinction shaped the retained provenance check. Installation consistency asks whether managed outputs match the expected installation. Baseline comparison asks whether source differs from the material it was derived from. Neither result answers the other's question.

The [provenance implementation](../lib/provenance.mjs) compares against configured baselines and reports line-ending differences separately. The [tests](../tests/unit/provenance.test.mjs) cover content differences, a missing baseline, and examples of import damage alongside legitimate prose. The starter has no provenance baseline configured.

## Checking the behavior that matters

During preparation of the public release, an agent tested drift through the CLI. Codex configuration was generated as TOML from JSON source declarations. The checker selected JSON comparison because the source artifact declared a JSON validator. It was choosing how to compare the output from the wrong input.

The repair selected comparison by the generated file's format. TOML used the existing byte comparison; JSON retained semantic comparison, allowing formatting and key-order changes without treating them as managed-content drift.

The [output-comparison tests](../tests/integration/output-comparison.test.mjs) exercise both cases through installation and checking. The [CLI regression](../tests/integration/e2e-cli.test.mjs) changes a comment inside the managed Codex configuration block, requires a content-drift result, restores the bytes, and checks again. This distinguishes detecting an edited file from merely failing to construct the expected state.

The checks compare managed content. The generator preserves designated provider-native content separately.

## A plan ID did not establish that the plan was valid

Review of the public candidate found a different gap. A saved plan could be altered to clear its confirmation requirement or remove backup entries. Recomputing the plan's content ID gave the altered document a matching digest. Digest consistency alone did not establish that its operations followed from the source and state.

Agents repaired the apply path to derive the expected plan again before installation. The [planner](../lib/planner.mjs) can perform that derivation without persisting a new plan. [Apply](../lib/apply.mjs) compares the saved plan against it and refuses differences with `PLAN_MISMATCH`. Transaction promotion supplies its planning inputs from the transaction record.

The [plan-integrity tests](../tests/integration/plan-integrity.test.mjs) retain altered plans with recomputed IDs. Cases change confirmation, risk, backup scope, targets, operations and source binding. Rejection cases compare the fixture's home, state and deployment branch; the unmodified plan must still install. The development record also reports running the new tests against the unfixed implementation, where all 11 added cases failed, before accepting the repair.

This check trusts its source and state. The transaction record remains trusted input, and a matching ID still does not identify a human caller. The [threat model](../SECURITY.md) keeps those boundaries explicit.

## Release evidence

The repository contains the extracted controller and a neutral example configuration. Historical accounts summarize development records; linked source and tests retain the mechanisms and regression cases.

The [README's behavior table](../README.md#what-it-does) records the release's named passing tests, environment and limits. [Contributing](../CONTRIBUTING.md) provides the isolated test setup and suite command.

The [review status](../SECURITY.md#review-status) records the completed adversarial checks and the areas the review did not reach.

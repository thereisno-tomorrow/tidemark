# How Tidemark took shape

Tidemark grew out of keeping Claude Code and Codex aligned. Shared skills were the starting point; the earlier system grew to manage instructions, agents, scripts, hooks and settings as well. Tidemark extracts the local configuration controller from that larger setup.

The design changed as the configuration moved into everyday use. A central source still needed a dependable editing path. Shared capabilities needed clear responsibilities. Recovery needed to show its effects before making changes. The [development account](development.md) explains how coding agents contributed the release machinery and its checks.

## An ordinary request should reach the shared source

A central repository solved where to keep shared configuration. It did not, by itself, change where an assistant would create the next skill.

In July, the proposed workflow still required editing the central source, validating it, committing, planning and applying a release. I asked whether a normal request to either assistant could carry that work through. The agents proposed a transaction workflow, with a separate confirmation requirement for consequential configuration changes.

After the initial cutover, creating another shared skill still required naming the maintainer and specifying the installation procedure. An ordinary creation request could take the provider's native path and produce another separate copy. Keeping the tools aligned depended on remembering an extra instruction every time.

I asked for ordinary creation requests to follow the shared convention automatically. The agents supplied routing instructions and a maintainer workflow: locate the managed source, prepare an isolated transaction, use the provider's design tools there, then test and prepare the installation.

The retained [routing instructions](../automation/controller-routing.md) and [maintainer](../bootstrap/agent-config-maintainer/SKILL.md) express that boundary. A provider-native skill creator can supply design guidance; its usual installation directory does not become the managed source merely because that is its default.

The [governance tests](../tests/unit/personal-skill-governance.test.mjs) check shared defaults in artifact resolution and the routing declarations; live assistant compliance is outside their scope. The [transaction tests](../tests/integration/transaction.test.mjs) exercise scoped edits and promotion gates where confirmation is required.

## Keep shared capabilities reusable

Sharing raised another question: what should a shared capability own?

During the migration review, some globally available capabilities still carried assumptions about one project's work. I separated access from downstream policy: a shared capability should return information, while the calling workflow decides what to produce and where to save it. The agent translated that correction into the detailed refactor.

Availability across assistants and responsibility for a project's outputs are separate choices. A capability can be useful from several projects without acquiring the policy or storage decisions of each one. This decision concerned the earlier configuration; the public checkout contains neutral starter examples.

I also questioned a provider-only classification retained during migration. The agent traced it to the old classification rather than a technical incompatibility. The capability could be shared while its executable parts still required control confirmation.

The starter illustrates that distinction with neutral examples: the notes and checklist skills are shared content, while the formatter is also shared but requires control confirmation. See the [starter manifest](../examples/starter/manifest.json). Who receives an artifact and what is required to install it are different fields.

## Inspect recovery before applying it

The earlier recovery command changed files as soon as it ran. An August 4 development record describes one invocation reversing 17 historical operations, changing installed configuration and leaving diagnostics unable to read the resulting state.

Someone investigating a problem could trigger another change before seeing what recovery intended to do.

On August 19, I chose the agent's recommendation of preview by default over confirmation bundled with recovery or removing the public command. Preview kept recovery available while separating inspection from action. The agents implemented the preview and its confirmation binding.

Today, plain `recover` returns candidate operations, affected targets and a content-derived recovery ID. Applying recovery requires both `--apply` and that exact ID. The controller scans again under its lock and rejects a stale preview if the journal state has changed.

The [recovery implementation](../lib/recovery.mjs) and [tests](../tests/integration/recovery.test.mjs) retain this separation. The fixtures check that preview leaves the target and journal unchanged, missing or incorrect confirmation is refused, a changed journal invalidates the preview, and an already completed automatic rollback is not reversed again. A separate [CLI test](../tests/integration/e2e-cli.test.mjs) compares the interrupted fixture before and after preview.

Recovery also has to account for work done since an installation. The [rollback conflict test](../tests/integration/apply.test.mjs) replaces an installed target with unknown content, then checks that rollback preserves it and reports a conflict. Restoring an older installation should not silently discard that replacement.

## Keep the public release local

The earlier plans included signed remote releases and multiple machines. In August, I kept that work at design and readiness, following the agent's recommendation to settle receiving machines and trust choices before activation.

For the public release, I approved the agents' proposal to extract the controller, tests and neutral starter, with synchronization disabled and unsupported. The [threat model](../SECURITY.md) describes detection and saved-state recovery, including the fact that a process with the same user's access can still write directly to configuration and state.

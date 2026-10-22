# Tidemark documentation

I built Tidemark to maintain my own Claude Code and Codex setup. The [README](../README.md) explains the current controller and provides a short demo. These documents cover the decisions behind it and how the implementation was checked.

| Question | Read |
| --- | --- |
| What does the short demo produce? | [Captured demo output](demo.md) |
| Why does a shared setup need more than a central folder? | [Design history](design-history.md#an-ordinary-request-should-reach-the-shared-source) |
| Which responsibilities belong in a reusable capability? | [Keeping shared capabilities reusable](design-history.md#keep-shared-capabilities-reusable) |
| Why does recovery return a preview before changing anything? | [Inspect recovery before applying it](design-history.md#inspect-recovery-before-applying-it) |
| What did the coding agents contribute? | [AI-assisted development](development.md) |
| How were installation, drift and plan checks tested? | [Checking the behavior that matters](development.md#checking-the-behavior-that-matters) |
| What can the public release establish? | [Behavior evidence](../README.md#what-it-does) and [threat model](../SECURITY.md) |

The design history covers July to October 2026. It summarizes development notes and conversations; private transcripts and personal configuration are not bundled. Links to source and tests identify mechanisms retained in this checkout. Historical incidents describe the earlier system, while the tests use isolated fixtures and neutral example configuration.

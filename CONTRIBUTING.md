# Contributing

Use Node 22 or newer and Git.
Set the throwaway environment from [README.md](README.md#quickstart) before tests.
From the checkout run `node --test --test-concurrency=1`.
Keep zero runtime npm package dependencies.
Run `node scripts/check-claims.mjs`; [.github/workflows/test.yml](.github/workflows/test.yml) defines Windows checks and [.gitattributes](.gitattributes) keeps text checkouts at LF.
Every user-facing behavior claim needs a named passing test and its limits.
Keep changes small and include the relevant test result.

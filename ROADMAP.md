# Roadmap

This roadmap tracks practical OSS readiness work. It is intentionally small and
should be updated as issues and pull requests land.

## v0.12.x

- Keep README quickstart commands aligned with the published package name and
  registry.
- Keep TypeScript and YAML route examples runnable from a fresh checkout.
- Verify package contents with `npm pack --dry-run` before each release.

## v0.13

- Add route regression tests for LLM validation and retry behavior.
- Expand Codex-style review route examples with realistic maintainer workflows.
- Document the route permission model in more detail, including shell command
  execution and secret handling.
- Decide whether the public package should stay on GitHub Packages or move to
  npmjs for easier external installation.

## Backlog

- Add a short terminal recording for the basic route workflow.
- Improve error messages for missing agent runtimes and authentication.
- Add more package-level smoke tests that exercise the built CLI.

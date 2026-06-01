# Contributing to Melos

Thanks for taking the time to improve Melos.

Melos is a route runner for agentic development workflows, so changes should
keep the core contract clear: route files define stopping conditions,
validation, transitions, and reporting behavior.

## Development Setup

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

## Pull Request Guidelines

- Keep changes scoped to one behavior or maintenance concern.
- Add or update tests when route semantics, validation, reports, or CLI behavior
  change.
- Avoid committing runtime artifacts such as `.melos/`, `HANDOFF.md`,
  `WORK_REPORT.json`, `PROGRESS.md`, or local smoke-test output.
- Do not include secrets, access tokens, private prompts, customer data, or
  machine-local configuration in commits.
- Update `README.md` or `docs/workflow-runtime-spec.md` when public behavior
  changes.

## Maintainer Workflow

Maintainers should prefer pull requests for user-visible behavior changes, even
when the change is small. That keeps the project history reviewable and makes it
clear how route semantics evolve over time.

Before merging, run:

```bash
npm test
npm run typecheck
npm run lint
```

## Release Checklist

1. Confirm tests, typecheck, lint, and build pass.
2. Check `npm pack --dry-run` to verify the package contents.
3. Update the version in `package.json`.
4. Tag the release as `vX.Y.Z`.
5. Confirm the publish workflow completes.

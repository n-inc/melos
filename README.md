# Melos

Melos is a route runner for agentic development workflows. It lets maintainers
describe a multi-step coding, review, validation, and reporting loop as a small
route file, then execute that route through a supported agent runtime.

The project is used to make long-running AI coding work auditable: prompts are
not the source of truth for stopping conditions, route configuration is. Every
run writes structured events and a final report so maintainers can inspect what
happened after the agent finishes.

## Why Melos Exists

AI coding agents are good at individual tasks, but real maintenance work usually
needs a repeatable loop:

- implement a change
- run shell checks
- ask an LLM to review behavior or product fit
- retry when validation fails
- stop only when route-level criteria pass
- write a final report that can be reviewed later

Melos turns that loop into a versioned workflow file.

## Features

- Route-based workflow execution with explicit phase transitions
- Shell, LLM, and metric-based validation
- Resume support through `--start-phase`
- YAML and TypeScript route files
- Structured event log at `.melos/events.jsonl`
- Final report output at `.melos/final-report.json`
- Runtime support for Claude Code and OpenAI Codex-style app-server execution
- Skill injection for agent-specific operating instructions

## Installation

Melos is currently published to GitHub Packages as `@n-inc/melos`.

Configure npm for the `@n-inc` scope:

```ini
@n-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` should be a classic PAT with `read:packages`. Do not
commit a real token in `.npmrc`. In GitHub Actions, `GITHUB_TOKEN` can be used
when the workflow has package read permission.

```bash
npm install --save-dev @n-inc/melos
```

If install fails with `401`, check the token and `.npmrc` entry. If it fails
with `404`, check package visibility and that the `@n-inc` scope maps to
`https://npm.pkg.github.com`.

### Developing Locally

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
```

## Usage

Run a route file:

```bash
npm exec -- melos route ./path/to/route.ts
```

Run a single prompt:

```bash
npm exec -- melos run --prompt "Summarize this diff"
```

Common options:

- `route <path>`
- `--route <path>`
- `--prompt <text>`
- `--cwd <dir>`
- `--model <model>`
- `--effort <level>`
- `--output-format text|json|stream-json`
- `--start-phase <phase>`
- `--no-ask`
- `--always-ask`

## Try It in 60 Seconds

Melos routes can ask an agent runtime to run commands and edit files. The basic
example asks the runtime to inspect without editing, but start from a clean or
disposable checkout before running routes that make changes.

From a local checkout:

```bash
npm install
npm run build
node bin/melos.js route examples/basic-route.yaml
```

From a project that installed `@n-inc/melos`:

```bash
cp node_modules/@n-inc/melos/examples/basic-route.yaml ./melos-route.yaml
npm exec -- melos route ./melos-route.yaml
```

After a route run, inspect:

```bash
cat .melos/events.jsonl
cat .melos/final-report.json
```

See [`examples/final-report.example.json`](examples/final-report.example.json)
for the final report shape.

## Route Example

```ts
import { createRoute } from '@n-inc/melos';

export default createRoute({
  run: { engine: 'auto' },
  limit: 12,
  workflow: {
    start: 'implement',
    phases: {
      implement: {
        task: 'Implement the requested change.',
        on: { pass: { goto: 'review' } },
      },
      review: {
        task: 'Review the change for correctness and maintainability.',
        validate: {
          shell: ['npm test'],
          llm: [
            'The implementation satisfies the requested behavior.',
            'The change is scoped and maintainable.',
          ],
        },
        on: {
          pass: 'stop',
          fail: { goto: 'implement' },
        },
      },
    },
  },
});
```

`validate` supports three families:

- `validate.shell`: shell commands that must pass
- `validate.llm`: review criteria evaluated by an agent runtime
- `validate.metrics`: numeric checks with thresholds or plateau detection

Stopping and branching should live in the route file, not in prompt wording.

## Runtime Artifacts

Melos writes run artifacts under `cwd/.melos/`:

- `events.jsonl`: append-only event log for the route run
- `final-report.json`: structured summary generated after the run
- `review-result.json`: review output when the route uses review phases

These files are intentionally ignored by git because they can contain local
working context, prompts, logs, or review details.

## Documentation

- [Basic TypeScript route](examples/basic-route.ts)
- [Basic YAML route](examples/basic-route.yaml)
- [Codex review route](examples/codex-review-route.ts)
- [Workflow runtime spec](docs/workflow-runtime-spec.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Roadmap](ROADMAP.md)

## Project Status

Melos is actively maintained by n-inc as an open-source agent workflow runner.
The public API is still evolving, but route execution, validation, reporting,
and resume behavior are covered by tests and used in real maintenance workflows.

## License

MIT

# Security Policy

Melos may execute shell commands and agent workflows described by route files.
Treat route files like code: review them before running them, especially when
they come from another repository or an untrusted branch.

## Route Permission Model

Melos does not sandbox route files. A route can ask an agent runtime to edit
files, run commands, call tools exposed by that runtime, and write runtime
artifacts under `.melos/`. Shell validators run with the same operating-system
permissions, environment variables, and working directory access as the process
that launched Melos.

Only run routes you trust, or run them inside an isolated checkout/container
with scoped credentials. Do not run routes from untrusted pull requests with
secrets in the environment.

## Threat Model

Important risks include:

- malicious or compromised route files executing shell commands
- prompt or log content leaking through `.melos/` runtime artifacts
- agent runtimes reading files that are visible from the selected `--cwd`
- validators printing secrets to CI logs
- package consumers assuming route execution is sandboxed when it is not

Melos aims to make workflows auditable by recording events and final reports; it
does not replace code review, CI isolation, secret scoping, or runtime-specific
permission controls.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting or contact a project maintainer in
the n-inc organization with enough detail to reproduce the issue. Include:

- affected version or commit
- route file or minimal reproduction
- expected behavior
- observed behavior
- impact and any known workaround

We will acknowledge valid reports, investigate the affected behavior, and
publish a fix or mitigation when appropriate.

## Sensitive Data

Do not commit secrets, private prompts, customer data, local runtime logs, or
machine-specific configuration. Melos runtime artifacts under `.melos/` are
ignored by git because they may contain local context.

If sensitive data is accidentally committed, rotate the affected secret first,
then coordinate history cleanup with the maintainers.

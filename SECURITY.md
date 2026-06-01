# Security Policy

Melos may execute shell commands and agent workflows described by route files.
Treat route files like code: review them before running them, especially when
they come from another repository or an untrusted branch.

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

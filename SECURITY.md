# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities through GitHub private vulnerability
reporting:

https://github.com/gascity/registry/security/advisories/new

Do not open a public issue, public discussion, or public pull request for a
security vulnerability before the maintainers have had time to investigate and
release a fix.

Include as much of the following as you can:

- Affected URL, commit, workflow, or registry artifact.
- Reproduction steps or proof-of-concept details.
- Expected and observed impact.
- Relevant logs, terminal output, or screenshots with secrets removed.
- Whether the issue is already being exploited or publicly discussed.

Maintainers will acknowledge a valid private report within three business days
when possible, triage severity, and coordinate disclosure through the GitHub
security advisory. If a fix is needed, it will be released before public
disclosure unless there is an active exploitation risk that requires faster
notice.

## Supported Versions

This service is deployed continuously. Security fixes target the live
`registry.gascity.com` deployment and the current `main` branch.

| Branch | Supported |
| ------ | --------- |
| main   | Yes       |
| other  | No        |

## Scope

Reports are in scope when they affect confidentiality, integrity, or
availability in normal supported use, including:

- Account sessions, WorkOS/OIDC login, CSRF enforcement, or auth redirects.
- Review, report, profile, star, publisher, and ownership-verification state.
- GitHub App authorization, webhook signature verification, and ownership
  revocation behavior.
- Aggregate registry generation, source pointer validation, and CLI-facing
  `registry.toml` output.
- Secrets handling, logs, generated artifacts, and GitHub Actions/GitOps automation.

Expected behavior in trusted local development environments, documented
administrative actions, and vulnerabilities in third-party tools should be
reported to the relevant upstream project unless this repository creates a new
or materially worse exposure.

## Secret Handling

Never commit production values for `DATABASE_URL`, `SESSION_SECRET`,
`OIDC_CLIENT_SECRET`, `GITHUB_APP_CLIENT_SECRET`, or
`GITHUB_APP_WEBHOOK_SECRET`. Use GitHub and OpenBao secret storage.
The checked-in `.env.example` file must remain placeholder-only.

# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately through GitHub's
"Report a vulnerability" form on the Security tab of the repository. Include:

- what you observed, and the tool call that triggered it,
- the OPRE version, Node version and OS,
- the impact you believe it has (information disclosure, code execution, cross-project access …),
- reproduction steps or a minimal project directory if you can share one safely.

You can expect an acknowledgement within 72 hours and a status update within seven days. We will
tell you when a fix ships and credit you in the release notes unless you prefer otherwise.

## Threat model in one paragraph

OPRE reads content from targets you point it at and runs a dev server you configure. The dangerous
inputs are: (1) untrusted page/package content that may try to manipulate the agent, (2) project
metadata that could be manipulated to escape the project directory, (3) the configured dev command,
which OPRE spawns, and (4) the network, which could be used to reach internal services.

## Controls OPRE implements

- **Untrusted content is data.** Page text, search results and package strings are stored with a
  trust level, wrapped with a warning, scanned for injection patterns, and never executed or
  treated as instructions.
- **Path containment.** All project-relative paths are resolved and verified inside the project
  root, including a symlink-escape check before spawning processes.
- **URL policy.** Only `http(s)`, no embedded credentials, private/loopback targets blocked unless
  `OPRE_ALLOW_PRIVATE_NETWORK=true`, DNS results checked, and every crawl request re-validated
  against the allowed host list.
- **No shell.** Dev servers are spawned with `shell: false`, a denylisted-executable check, and a
  metacharacter check on every argument. `OPRE_RUNNER_ENABLED=false` disables starting processes
  entirely.
- **Scrubbed child environment.** Child processes inherit only a safe allowlist (no API keys,
  tokens, passwords or session cookies).
- **Secret redaction.** Credential-shaped strings are redacted before anything is written to disk
  or returned to the agent.
- **Project isolation.** Every operation is scoped to one project directory; identifiers resolve
  only under `OPRE_HOME`.
- **Non-destructive writes.** Generated markdown is marker-delimited, notes are append-only, and
  JSON writes are atomic.

## What OPRE deliberately does not do

No authentication bypass, no paywall or anti-bot circumvention, no credential harvesting, no
stealth, no exploitation of the analysed target, and no automatic execution of dependency
installers or project scripts. Analysing only software you own or are authorised to inspect is a
requirement, not a preference.

## Hardening your deployment

- Keep `OPRE_ALLOW_PRIVATE_NETWORK=false` unless you need internal targets.
- Run OPRE in a container or VM when analysing untrusted third-party software.
- Set `OPRE_MAX_RESPONSE_CHARS` to a value that fits your agent's budget.
- Review the configured `runnerCommand`/`runnerArgs` — OPRE will not start anything you have not
  explicitly configured.

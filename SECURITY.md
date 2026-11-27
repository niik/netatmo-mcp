# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/niik/netatmo-mcp/security/advisories/new>). Don't open a
public issue for anything that could put users' Netatmo accounts at risk.

Include what you found, how to reproduce it, and the impact you expect. This is a
small personal project, so responses are best effort, but reports are read and
fixes are published as soon as practical. You'll be credited in the advisory
unless you'd rather not be.

## Scope

In scope:

- The server code in `src/`: the stateless OAuth proxy (client registration,
  `/authorize`, `/callback`, `/token`), sealed-token cryptography, redirect URI
  validation, and the MCP endpoint.
- The deployment scripts in `infra/`, the `Dockerfile` and the GitHub Actions
  workflow, where they would leave a deployment insecure by default.

Out of scope:

- Netatmo's own API, OAuth service or apps (report those to Netatmo).
- MCP clients such as Claude or Claude Code (report those to their vendors).
- Misconfiguration of an individual self-hosted deployment, such as serving it
  without HTTPS, leaking its `TOKEN_KEY`, or adding untrusted hosts to
  `ALLOWED_REDIRECT_URIS`.
- Denial of service through sheer request volume.

## Note on authorship

The code in this repository was written by an AI agent (see the README). It has
automated tests but has not had an independent security audit. Review it before
you rely on it.

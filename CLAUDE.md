# netatmo-mcp

Multi-user remote MCP server for Netatmo weather stations. See README.md for tools, the auth design and setup. Open source (MIT); the README states it is AI-agent authored, so keep that note accurate.

## Layout

- `src/app.js`: router, one web-standard `handle(Request) → Response` for all routes; `/mcp` handler.
- `src/oauth.js`: stateless OAuth 2.1 proxy (metadata, DCR, authorize, callback, token).
- `src/crypto.js`: sealed (AES-256-GCM) tokens, the only "storage".
- `src/netatmo.js`: Netatmo OAuth + API client. `src/stations.js`: normalizing/formatting. `src/time.js`: station time zones.
- `src/mcp.js`: MCP server and tools, built per request with the caller's Netatmo token.
- `src/functions/http.js`: Azure Functions catch-all entry. `src/server.js`: production node:http entry (Docker). `src/dev-server.js`: local dev wrapper (loads .env, binds 127.0.0.1).
- `test/`: end-to-end tests against `test/fake-netatmo.js`.
- `infra/`: Azure provisioning/deploy scripts. `infra/lib.sh` loads settings: `infra/config.env` (gitignored, copied from `infra/config.env.example`), overridden by environment variables (`AZURE_SUBSCRIPTION_ID` / `AZURE_RESOURCE_GROUP` / `AZURE_FUNCTION_APP` are accepted aliases). Never commit `infra/config.env` or real subscription ids/resource names.
- `Dockerfile` / `.dockerignore`: image for non-Azure hosts (copies only `package*.json` and `src/`).

## Rules

- Keep the server stateless: no database, no per-user storage. Anything needed later goes in a sealed token with its own purpose string.
- Never print, log or commit `TOKEN_KEY`, the Netatmo client secret, or any token.
- Infra scripts: bash strict mode, idempotent, compatible with macOS bash 3.2; run `bash -n infra/*.sh` after editing.
- Run `npm test` after changes; add tests to `test/flow.test.js` for new tools or auth behavior.

## Deploying

A push to `main` runs the tests, deploys with `infra/deploy.sh --code`, and smoke-tests the endpoints (`.github/workflows/deploy.yml`). The workflow takes its target from the repo variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `AZURE_FUNCTION_APP`, set by `infra/setup-github.sh` (re-run it to refresh them); it doesn't read `infra/config.env`. Without `AZURE_CLIENT_ID` (forks), and on other branches and PRs, it only runs the tests. Actions are pinned to commit SHAs and updated by Dependabot.

# netatmo-mcp

A remote [MCP](https://modelcontextprotocol.io) server that lets AI assistants such as Claude read your [Netatmo Smart Weather Station](https://www.netatmo.com/smart-weather-station): current conditions, history and station details.

- **Multi-user.** One deployment serves anyone with a Netatmo account, or only the accounts you allow (`ALLOWED_NETATMO_USERS`). Each person signs in with Netatmo from their MCP client and only ever sees their own stations.
- **Stores nothing.** No database, no sessions, no per-user files. Everything the server needs later is encrypted into the tokens the MCP client keeps.
- **Read-only.** It asks Netatmo for the `read_station` scope only.
- **Cheap to host.** Runs on Azure Functions (Flex Consumption) with the included scripts, or in a small Docker container on any host.

> [!NOTE]
> **About this project.** This project is entirely AI-agent authored: the code, tests, infrastructure scripts and documentation were written by Claude, Anthropic's AI model, using Claude Code, with a human directing the work and deciding what to build. It has automated tests but no independent human code review or security audit. Review it accordingly before you rely on it. Issues and pull requests are welcome.

## Contents

- [Tools](#tools)
- [How sign-in works](#how-sign-in-works)
- [Privacy](#privacy)
- [Self-hosting](#self-hosting)
  - [1. Create a Netatmo app](#1-create-a-netatmo-app)
  - [2a. Option A: Azure Functions](#2a-option-a-azure-functions)
  - [2b. Option B: Docker or any Node host](#2b-option-b-docker-or-any-node-host)
  - [3. Connect a client](#3-connect-a-client)
- [Local development](#local-development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Tools

| Tool | What it does |
| --- | --- |
| `get_current_weather` | Latest readings from every module: indoor/outdoor temperature (with today's high/low and trend), humidity, CO₂, noise, pressure, rain (latest, last hour, today), wind and gusts, plus battery and signal. Arg: `station`. |
| `get_measurements` | History for one module with a summary (min/max with time, mean, rain totals) and a data table. Args: `module` (`outdoor`, `indoor`, `rain`, `wind`, a name or id), `start`/`end` (`YYYY-MM-DD` or ISO, station time), `scale` (`max`, `30min`, `1hour`, `3hours`, `1day`, `1week`, `1month`; picked automatically if omitted), `types`, `max_points` (up to 2048), `include_series`. Pages through Netatmo's 1024-point limit (at most 2 pages per call). |
| `list_stations` | Stations with city/country, altitude and time zone (never GPS coordinates), and every module with its id, data types, battery, signal and last-seen time. |

Values are metric (°C, mm, km/h, mbar) and times are in the station's time zone. Ask things like "how cold did it get last night?" or "how much rain fell this month compared to last?".

## How sign-in works

The server implements the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) as a thin OAuth 2.1 proxy in front of Netatmo's OAuth. Netatmo doesn't support dynamic client registration, and MCP clients can't hold your Netatmo app's secret, so the server sits in the middle:

```
Client ─ POST /mcp ───────────────▶ 401, WWW-Authenticate → /.well-known/oauth-protected-resource
Client ─ POST /register ──────────▶ client_id = sealed{redirect_uris}                    (RFC 7591)
Client ─ GET  /authorize ─────────▶ 302 to Netatmo, state = sealed{client redirect, PKCE challenge, nonce}, nonce cookie
Netatmo ─ GET /callback ──────────▶ 302 to client, code = sealed{Netatmo code, PKCE challenge}
Client ─ POST /token ─────────────▶ PKCE check, Netatmo code exchange with the app secret,
                                     access_token = sealed{Netatmo access token}, refresh_token = sealed{Netatmo refresh token}
Client ─ POST /mcp (Bearer) ──────▶ unseal → call Netatmo as that user
```

"Sealed" means AES-256-GCM encrypted with a key derived from the server's `TOKEN_KEY` secret, with a separate key per purpose so one kind of token can't be used as another. Short-lived values (state, codes, access tokens) carry an expiry, refresh tokens expire after 90 days without use (each refresh issues a new one), and access and refresh tokens are bound to this server's `/mcp` URL (their audience). Netatmo access tokens last 3 hours, and the client refreshes them through `/token`.

- **Redirect URIs** must exactly match Claude's callbacks (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`) or be an `http` loopback URI (`localhost`, `127.0.0.1`, `[::1]`, any port, as RFC 8252 describes for desktop apps such as Claude Code). Add other clients' exact callback URIs with `ALLOWED_REDIRECT_URIS`; set `ALLOW_LOOPBACK_REDIRECTS=false` if only web clients such as claude.ai use your deployment.
- **Consent happens at Netatmo.** There's no extra consent page on this server: `/authorize` goes straight to Netatmo's sign-in and consent screen. Every client shares one Netatmo app, so that screen shows your app's name rather than the client's; the exact redirect URI allowlist above is what limits which clients can receive a sign-in, and `ALLOWED_NETATMO_USERS` limits who can sign in.
- A short-lived `HttpOnly`, `SameSite=Lax` cookie ties the Netatmo callback to the browser that started the sign-in, which prevents login CSRF.
- **Key rotation:** set the new key as `TOKEN_KEY` and the old one as `TOKEN_KEY_PREVIOUS`. Both are accepted, so active users aren't signed out. Keep the old key for the refresh-token lifetime (90 days) if you don't want idle users to have to reconnect; once it's removed, clients registered under it must also re-add the connector. Replacing `TOKEN_KEY` without that signs everyone out (they just reconnect). `TOKEN_KEY` must be random bytes in base64 (`openssl rand -base64 32`): passphrases are refused, and `/health` reports 500 if the key is missing or invalid.
- **Limits:** request bodies over 64 KB are refused while they're being read, JSON-RPC batches are refused, one tool call makes at most 3 Netatmo requests, and every Netatmo request times out after 10 seconds.

## Privacy

- **The server stores nothing.** It keeps no database, files or sessions. Each request is handled with what the request itself carries.
- **The MCP client stores the tokens**, encrypted. They can't be read without the server's `TOKEN_KEY`, and they only work against that server.
- **Data path:** your MCP client → this server → Netatmo's API (`api.netatmo.com`) and back. Weather data passes through the server's memory for the duration of a request and isn't written anywhere. What the AI assistant does with the results is governed by that assistant's own terms.
- **Access is read-only.** The `read_station` scope lets the server read weather station data. It can't change settings or reach other Netatmo products such as cameras or thermostats.
- **Location:** tools report your station's city, country, altitude and time zone, never its GPS coordinates, since those would pinpoint your home in the assistant's context. Device ids are shown as opaque ids rather than Netatmo's MAC addresses, since Netatmo's public weather map pairs a station's MAC with its location.
- **Names are sanitized.** Station and module names (which the owner of a station shared with you can set) are stripped of markdown, control and invisible Unicode characters before they reach the assistant, and only numbers and known values from other Netatmo fields are passed on.
- **Logs:** the server only logs unexpected errors (error type and message, no request data or tokens). On Azure these go to Application Insights in your own subscription, along with the platform's standard request telemetry. That telemetry includes request URLs, so the Netatmo callback's one-time authorization code (single-use, short-lived, useless without the app secret) can appear there; set a retention period that suits you.
- **Whoever runs the server** holds the Netatmo app secret and `TOKEN_KEY`, so they could in principle read the data of anyone who signs in. Use a deployment you run yourself, or one run by someone you trust.
- To revoke access, remove the connector from your MCP client. Netatmo's account settings may also list the app under connected third-party apps, where you can revoke it.

## Self-hosting

You need:

1. A Netatmo account (the one with your weather station is fine) to create a Netatmo app.
2. A public HTTPS host for the server: Azure Functions with the included scripts (option A), or any machine or platform that runs a Docker container or Node 26 behind HTTPS (option B).

Each deployment needs its own Netatmo app, because Netatmo only redirects to the URIs registered on the app.

### 1. Create a Netatmo app

1. Sign in at <https://dev.netatmo.com/apps> with your Netatmo account and click **Create** (create an app).
2. Fill in the form:
   - **App name**: whatever you like, for example "My weather MCP". People who sign in see this name on Netatmo's consent page.
   - **Description**: a sentence such as "Lets my AI assistant read my weather station."
   - **Website**: your server's URL or this repository's URL.
   - **Company**: optional; leave it empty if this is just for you.
   - **Data protection officer name and email**: required by the form. If you aren't a company, use your own name and email.
   - Accept Netatmo's terms and conditions, then save.
3. On the app's page, under the app technical parameters:
   - **Redirect URI**: `https://<your-host>/callback`, where `<your-host>` is where the server will run. For option A, `infra/set-netatmo-app.sh` prints the exact value once the function app exists; you can come back and set it then. For local development, also add `http://localhost:3000/callback`.
   - **Webhook URI**: leave empty.
   - Save.
4. Note the **client ID** and **client secret**. Keep the secret private.

Netatmo applies rate limits per app and per user. Per Netatmo's docs at the time of writing, the per-user limits are about 50 requests per 10 seconds and 500 requests per hour; check their current documentation. Normal assistant use stays well below that. A long `get_measurements` history can take several requests, since each call returns at most 1024 points (one `get_measurements` call makes at most 3 Netatmo requests).

### 2a. Option A: Azure Functions

The scripts in `infra/` provision everything with the Azure CLI and deploy the code. They're idempotent, so you can re-run them.

**Prerequisites:** an Azure subscription, the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az login`), Node 26, plus `bash`, `curl`, `zip`, `openssl` and `python3`. For CI you also need the [GitHub CLI](https://cli.github.com/) (`gh auth login`).

**Configure.** Copy the example settings and fill in your subscription id and a unique suffix (storage account, Key Vault and function app names are global across Azure):

```bash
cp infra/config.env.example infra/config.env   # gitignored
az account show --query id -o tsv              # your subscription id
openssl rand -hex 3                            # a suffix, e.g. 3f9a1c
```

**Provision and deploy:**

```bash
npm ci
npm run deploy
```

This creates, in the resource group from your config:

- a function app (Flex Consumption, Node 26, 512 MB) with a system-assigned managed identity, set to HTTPS only and TLS 1.2+, with FTP and basic-auth publishing turned off,
- a Key Vault (RBAC, purge protection on) holding `token-key` (generated, never printed) and later the Netatmo client secret. The app gets *Key Vault Secrets User*; you get *Secrets Officer*.
- a storage account (required by Functions) and Application Insights.

**Store the Netatmo app credentials.** The script prints the redirect URI to put on your Netatmo app, then asks for the client ID and the secret (typed at a hidden prompt; the secret goes straight to Key Vault):

```bash
bash infra/set-netatmo-app.sh
```

It finishes by printing your connector URL, `https://<function-app-host>/mcp`.

**Restrict who can use it (recommended).** By default any Netatmo account can sign in to your deployment, using your Azure resources and your Netatmo app's rate limits (people only ever see their own stations). To allow only specific accounts, enter their Netatmo login emails:

```bash
bash infra/set-allowed-users.sh
```

This sets the `ALLOWED_NETATMO_USERS` app setting. Other accounts are refused at sign-in, and an account you remove loses access at its next token refresh (within about 3 hours).

**Optional: deploy from GitHub Actions.** If your copy of the repository is on GitHub:

```bash
bash infra/setup-github.sh            # or GITHUB_REPO=owner/name bash infra/setup-github.sh
```

This creates a user-assigned managed identity `id-netatmo-mcp-github`, trusted through OIDC for pushes to `main` of your repository, with *Website Contributor* on the function app only (no direct Key Vault access, no secrets stored in GitHub). Note that whoever can push to `main` can deploy code that runs with the app's identity, which can read the secrets: protect the `main` branch, and consider moving the deploy job into a GitHub Environment with required reviewers (then change the federated credential subject to `repo:<owner>/<repo>:environment:<name>`). It sets the repo variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, and the repo *secrets* `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `AZURE_FUNCTION_APP`. They're secrets so GitHub masks them in the Actions logs, which are public for a public repository: your server's address isn't published there. From then on every push to `main` runs the tests, deploys and smoke-tests (`.github/workflows/deploy.yml`). Other branches, pull requests and repositories without those variables (such as forks) only run the tests. Re-run the script whenever you need to refresh the variables.

**Cost.** The function app is capped at `MAX_INSTANCES` instances (default 5), and a monthly budget alert of `BUDGET_AMOUNT` (default 50, in your billing currency) on the resource group emails the subscription's Owners at 80% of actual and 100% of forecast spend. It only alerts; nothing is stopped. For personal or family use, Flex Consumption's free monthly grant usually covers the function executions, leaving a few cents a month for storage, Key Vault operations and Application Insights. That's an estimate, not a promise: check Azure's current pricing, and consider a budget alert on the resource group.

You can override any setting from `infra/config.env` with an environment variable of the same name (`AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP` and `AZURE_FUNCTION_APP` work too), and `npm run deploy -- --code` redeploys the code without provisioning.

### 2b. Option B: Docker or any Node host

The `Dockerfile` builds a small image (Node 26 on Alpine, running as a non-root user) that serves the app with the `node:http` entry point, `src/server.js`, on port 3000.

```bash
docker build -t netatmo-mcp .
docker run -d --name netatmo-mcp --restart unless-stopped -p 127.0.0.1:3000:3000 \
  -e PUBLIC_BASE_URL=https://weather-mcp.example.com \
  -e TOKEN_KEY="$(openssl rand -base64 32)" \
  -e NETATMO_CLIENT_ID=your-client-id \
  -e NETATMO_CLIENT_SECRET=your-client-secret \
  netatmo-mcp
```

Store `TOKEN_KEY` somewhere persistent (an env file or your platform's secret store) rather than generating it on every start as in this example: a new key signs everyone out. Without Docker, run `npm ci --omit=dev` and `node src/server.js` with the same environment variables.

| Variable | Required | Description |
| --- | --- | --- |
| `TOKEN_KEY` | yes | Encryption key for all tokens, at least 32 random bytes, base64. Generate with `openssl rand -base64 32`. Keep it secret and stable. |
| `NETATMO_CLIENT_ID` | yes | Client ID of your Netatmo app. |
| `NETATMO_CLIENT_SECRET` | yes | Client secret of your Netatmo app. |
| `PUBLIC_BASE_URL` | yes | The public HTTPS origin of the server, e.g. `https://weather-mcp.example.com`, without a path. Used in OAuth metadata, token audiences and the Netatmo redirect URI, so it must match the redirect URI on your Netatmo app. The server refuses to start without it (only `npm run dev` defaults it to `http://localhost:3000`). |
| `PORT` | no | Port to listen on. Default `3000`. |
| `HOST` | no | Interface to bind. Default `0.0.0.0` (`npm run dev` binds `127.0.0.1`). |
| `ALLOWED_REDIRECT_URIS` | no | Comma-separated exact https redirect URIs for MCP clients other than Claude, added to the built-in Claude callbacks. |
| `ALLOW_LOOPBACK_REDIRECTS` | no | `false` refuses `http://localhost`-style redirect URIs (desktop clients such as Claude Code and MCP Inspector). Default `true`. |
| `TOKEN_KEY_PREVIOUS` | no | The previous `TOKEN_KEY` during a key rotation; tokens sealed with it are still accepted. |
| `ALLOWED_NETATMO_USERS` | no | Comma-separated Netatmo account emails allowed to sign in. Empty means any Netatmo account; a malformed value (an entry that isn't an email) allows nobody. Checked at sign-in and on every token refresh. |

**Put it behind HTTPS.** The container speaks plain HTTP. Run it behind a reverse proxy that terminates TLS for your domain (for example Caddy, nginx or Traefik, or a platform such as Fly.io, Render, Cloud Run or Azure Container Apps that does it for you) and forward everything to port 3000. MCP clients and Netatmo require HTTPS redirect URIs, and the sign-in cookie is only marked `Secure` when `PUBLIC_BASE_URL` is `https://`. With Caddy, for example:

```
weather-mcp.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

The image has a `HEALTHCHECK` against `/health`. The server rejects request bodies over 64 KB itself; add rate limiting at the proxy if you expose it widely.

### 3. Connect a client

Your connector URL is `https://<your-host>/mcp`. No API keys or headers are needed: the client discovers the OAuth endpoints and sends you to Netatmo to sign in.

- **Claude** (claude.ai and the desktop and mobile apps): Settings → Connectors → **Add custom connector**, enter the URL, then **Connect**.
- **Claude Code:**

  ```bash
  claude mcp add --transport http netatmo https://<your-host>/mcp
  ```

  Then run `/mcp` in Claude Code and choose the server to sign in.
- **Other MCP clients** that support remote servers with OAuth (Streamable HTTP transport, dynamic client registration, PKCE) work too. If the client's OAuth redirect URI isn't Claude's or a loopback URI, add the exact URI to `ALLOWED_REDIRECT_URIS` (on Azure: an app setting on the function app).

## Local development

```bash
npm ci
npm test          # end-to-end OAuth + tool tests against a fake Netatmo API
npm run check     # syntax check
npm run dev       # http://localhost:3000/mcp
```

`npm run dev` reads `.env` if it exists (copy `.env.example`): `NETATMO_CLIENT_ID`, `NETATMO_CLIENT_SECRET` and `TOKEN_KEY`. To sign in with real Netatmo locally, add `http://localhost:3000/callback` as a redirect URI on your Netatmo app, then connect with `claude mcp add --transport http netatmo-dev http://localhost:3000/mcp`.

The code is plain ESM JavaScript with no build step:

| Path | Purpose |
| --- | --- |
| `src/app.js` | Router: one web-standard `Request → Response` handler for all routes. |
| `src/oauth.js` | The stateless OAuth 2.1 proxy (metadata, registration, authorize, callback, token). |
| `src/crypto.js` | Sealed tokens (AES-256-GCM, HKDF per purpose). |
| `src/netatmo.js`, `src/stations.js`, `src/time.js` | Netatmo API client, data normalizing and formatting, station time zones. |
| `src/mcp.js` | The MCP tools. |
| `src/functions/http.js`, `src/server.js`, `src/dev-server.js` | Azure Functions, production `node:http` and local development entry points. |
| `infra/` | Azure provisioning, deploy and CI setup scripts. |

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending changes.

## Troubleshooting

**Netatmo says the redirect URI is invalid or doesn't match.** The redirect URI on your Netatmo app must be exactly `<PUBLIC_BASE_URL>/callback`: same scheme, host and port, no trailing slash. On Azure, `bash infra/set-netatmo-app.sh` prints the right value. On Docker, check that `PUBLIC_BASE_URL` is your public HTTPS origin and not the default `http://localhost:3000`.

**Sign-in fails at the end with `invalid_client`** (shown in the client's error, or as "Netatmo token request failed"). The client ID or secret is wrong. Copy both again from dev.netatmo.com. On Azure, re-run `bash infra/set-netatmo-app.sh`, which also restarts the app so it picks up the new secret.

**"Redirect URI not allowed" when connecting.** The MCP client uses a redirect URI that isn't allowed. Add its exact URI to `ALLOWED_REDIRECT_URIS`.

**"This sign-in was started in another browser or has already been used."** The callback must open in the same browser that started the sign-in, within 15 minutes. Start the connection again from the client. Behind a proxy, also check that it passes cookies through.

**Everyone was signed out.** `TOKEN_KEY` changed: it was replaced without `TOKEN_KEY_PREVIOUS`, regenerated on container start, or differs between instances. Every token is sealed with it, so all tokens become invalid at once. Reconnect, and keep the key stable (and identical across instances). To rotate without signing anyone out, see [How sign-in works](#how-sign-in-works).

**Requests fail with a server error.** On Azure, look at the function app's logs in Application Insights (Azure portal → the function app → *Application Insights* → *Failures*, or query `traces` and `exceptions` under *Logs*). Check that the app settings `TOKEN_KEY` and `NETATMO_CLIENT_SECRET` show as resolved Key Vault references in the portal (Environment variables). On Docker, run `docker logs netatmo-mcp`.

**Sign-in fails with "This Netatmo account isn't allowed".** The deployment has `ALLOWED_NETATMO_USERS` set and the account isn't on it. Add the account's Netatmo login email (on Azure: `bash infra/set-allowed-users.sh`).

**Rate limited by Netatmo.** Netatmo's per-user and per-app limits apply (see [step 1](#1-create-a-netatmo-app)). Wait a while, and prefer coarser `scale` values for long `get_measurements` ranges.

## License

[MIT](LICENSE) © 2026 Markus Olsson. Netatmo is a trademark of Netatmo; this project isn't affiliated with or endorsed by Netatmo. To report a security problem, see [SECURITY.md](SECURITY.md).

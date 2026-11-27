// End-to-end: MCP OAuth discovery → registration → authorize → Netatmo
// callback → token → MCP tool calls → refresh, against a fake Netatmo.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startFakeNetatmo } from "./fake-netatmo.js";

const BASE = "https://mcp.example";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let fake, handle;

before(async () => {
  fake = await startFakeNetatmo();
  Object.assign(process.env, {
    NETATMO_BASE_URL: fake.url,
    NETATMO_CLIENT_ID: "app-id",
    NETATMO_CLIENT_SECRET: "app-secret",
    TOKEN_KEY: randomBytes(32).toString("base64"),
    PUBLIC_BASE_URL: BASE,
    ALLOWED_NETATMO_USERS: "someone@example.com, Owner@Example.com",
  });
  ({ handle } = await import("../src/app.js"));
});
after(() => fake.server.close());

const req = (path, init = {}) => handle(new Request(BASE + path, init));
const form = (obj) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(obj).toString(),
});

async function mcp(token, method, params = {}, id = 1) {
  const res = await req("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

const callTool = async (token, name, args = {}) => (await mcp(token, "tools/call", { name, arguments: args })).body.result;

let tokens, clientId;

test("discovery: 401 points to protected-resource metadata, which points to the AS", async () => {
  const res = await req("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\/\.well-known\/oauth-protected-resource"/);

  const prm = await (await req("/.well-known/oauth-protected-resource")).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);

  const as = await (await req("/.well-known/oauth-authorization-server")).json();
  assert.equal(as.token_endpoint, `${BASE}/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("registration only accepts allowed redirect URIs", async () => {
  const bad = await req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
  });
  assert.equal(bad.status, 400);
  // Only Claude's exact callback is allowed on claude.ai, not any path, port or userinfo.
  for (const uri of ["https://claude.ai/some/other/path", "https://claude.ai:8443/api/mcp/auth_callback", "https://user@claude.ai/api/mcp/auth_callback"]) {
    const r = await req("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
    assert.equal(r.status, 400, uri);
  }

  const res = await req("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT, "http://localhost/callback"], client_name: "Claude" }),
  });
  assert.equal(res.status, 201);
  clientId = (await res.json()).client_id;
  assert.ok(clientId);
});

test("full authorization code flow with PKCE", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authz = await req(
    `/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
      scope: "read_station",
    })}`,
  );
  // A consent page comes first, with the flow sealed into the form and a nonce cookie.
  assert.equal(authz.status, 200);
  assert.match(authz.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await authz.text();
  assert.match(html, /<strong>Claude<\/strong> \(returning to <strong>claude\.ai<\/strong>\)/);
  const flow = html.match(/name="flow" value="([^"]+)"/)[1];
  const cookie = authz.headers.get("set-cookie").split(";")[0];
  assert.match(authz.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Secure/);

  // Submitting the consent form without the cookie (e.g. from another site) fails.
  assert.equal((await req("/authorize", form({ flow, decision: "allow" }))).status, 400);

  const consent = await req("/authorize", { ...form({ flow, decision: "allow" }), headers: { ...form({}).headers, cookie } });
  assert.equal(consent.status, 303);
  const netatmoUrl = new URL(consent.headers.get("location"));
  assert.equal(netatmoUrl.origin + netatmoUrl.pathname, `${fake.url}/oauth2/authorize`);
  assert.equal(netatmoUrl.searchParams.get("redirect_uri"), `${BASE}/callback`);
  assert.equal(netatmoUrl.searchParams.get("scope"), "read_station");

  const state = netatmoUrl.searchParams.get("state");
  // Without the browser cookie the callback is refused (login CSRF protection).
  assert.equal((await req(`/callback?code=netatmo-code&state=${encodeURIComponent(state)}`)).status, 400);

  const cb = await req(`/callback?code=netatmo-code&state=${encodeURIComponent(state)}`, { headers: { cookie } });
  assert.equal(cb.status, 302);
  const back = new URL(cb.headers.get("location"));
  assert.equal(back.origin + back.pathname, CLAUDE_REDIRECT);
  assert.equal(back.searchParams.get("state"), "client-state");
  assert.equal(back.searchParams.get("iss"), BASE);
  const code = back.searchParams.get("code");

  const wrong = await req("/token", form({ grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: clientId, redirect_uri: CLAUDE_REDIRECT }));
  assert.equal(wrong.status, 400);
  const noClient = await req("/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_REDIRECT }));
  assert.equal(noClient.status, 400);
  const wrongResource = await req("/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT, resource: "https://evil.example/mcp" }));
  assert.equal((await wrongResource.json()).error, "invalid_target");

  const ok = await req("/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT }));
  assert.equal(ok.status, 200);
  tokens = await ok.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.expires_in > 10000);
  // The Netatmo tokens never appear in clear text.
  assert.ok(!JSON.stringify(tokens).includes("na-access"));
});

test("authorize rejects unregistered redirect URIs", async () => {
  const res = await req(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.ai/other", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`,
  );
  assert.equal(res.status, 400);
});

test("MCP: initialize and list tools", async () => {
  const init = await mcp(tokens.access_token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "netatmo");
  const list = await mcp(tokens.access_token, "tools/list");
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), ["get_current_weather", "get_measurements", "list_stations"]);
});

test("MCP: current weather", async () => {
  const r = await callTool(tokens.access_token, "get_current_weather");
  const t = r.content[0].text;
  assert.ok(!r.isError, t);
  assert.match(t, /Temperature: 21\.4°C/);
  assert.match(t, /Temperature: -3\.2°C \(trend: down\)/);
  assert.match(t, /Rain, today: 3\.2 mm/);
  assert.match(t, /battery 77%/);
});

test("MCP: list stations", async () => {
  const t = (await callTool(tokens.access_token, "list_stations")).content[0].text;
  assert.match(t, /# Home/);
  assert.match(t, /Stockholm, SE, altitude 20 m/);
  // GPS coordinates pinpoint the user's home and are never sent to the model.
  assert.doesNotMatch(t, /59\.33|18\.07|lat /);
  assert.match(t, /\*\*Rain gauge\*\*: Rain gauge/);
});

test("MCP: measurements page through Netatmo's 1024-point limit", async () => {
  const before = fake.calls.filter((c) => c.path === "/api/getmeasure").length;
  const r = await callTool(tokens.access_token, "get_measurements", {
    module: "outdoor",
    start: "2026-01-01",
    end: "2026-02-15",
    scale: "30min",
    max_points: 2500,
    include_series: false,
  });
  const t = r.content[0].text;
  assert.ok(!r.isError, t);
  assert.match(t, /2026-01-01 00:00 → 2026-02-15 23:59 \(Europe\/Stockholm\)/);
  assert.match(t, /2208 points/); // 46 days × 48
  const calls = fake.calls.filter((c) => c.path === "/api/getmeasure").slice(before);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query.module_id, "02:00:00:00:00:01");
  assert.match(t, /Temperature: min .* max .* mean/);
});

test("MCP: daily rain totals and module lookup by kind", async () => {
  const t = (await callTool(tokens.access_token, "get_measurements", { module: "rain", start: "2026-03-01", end: "2026-03-10", scale: "1day" })).content[0].text;
  assert.match(t, /Rain gauge/);
  assert.match(t, /sum_rain: .*total 5 mm/); // 10 days × 0.5
  assert.match(t, /\| 2026-03-0\d \| 0\.5 \|/);
});

test("MCP: daily min/max with record times", async () => {
  const t = (
    await callTool(tokens.access_token, "get_measurements", {
      module: "Outdoor",
      start: "2026-03-01",
      end: "2026-03-05",
      scale: "1day",
      types: ["min_temp", "date_min_temp", "max_temp", "date_max_temp"],
    })
  ).content[0].text;
  assert.match(t, /Lowest temperature: .* °C at 2026-03-0\d \d\d:\d\d/);
});

test("MCP: unknown module gives a helpful error", async () => {
  const r = await callTool(tokens.access_token, "get_measurements", { module: "garage" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Modules: Indoor .*Outdoor .*Rain gauge/);
});

test("refresh token yields a new working access token", async () => {
  const res = await req("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
  assert.equal(res.status, 200);
  const next = await res.json();
  assert.notEqual(next.access_token, tokens.access_token);
  const r = await callTool(next.access_token, "get_current_weather");
  assert.ok(!r.isError);
  const last = fake.calls.filter((c) => c.path === "/api/getstationsdata").at(-1);
  assert.ok(last);
});

test("forged or wrong-purpose tokens are rejected", async () => {
  const forged = await mcp("n1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "tools/list");
  assert.equal(forged.status, 401);
  // A refresh token can't be used as an access token.
  const swapped = await mcp(tokens.refresh_token, "tools/list");
  assert.equal(swapped.status, 401);
});

test("cancelling on the consent page returns access_denied to the client", async () => {
  const authz = await req(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: "a".repeat(43), code_challenge_method: "S256", state: "s1" })}`,
  );
  const flow = (await authz.text()).match(/name="flow" value="([^"]+)"/)[1];
  const cookie = authz.headers.get("set-cookie").split(";")[0];
  const res = await req("/authorize", { ...form({ flow, decision: "deny" }), headers: { ...form({}).headers, cookie } });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get("location"));
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), "s1");
});

test("authorize rejects a foreign resource indicator", async () => {
  const res = await req(
    `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: "a".repeat(43), code_challenge_method: "S256", resource: "https://evil.example/mcp" })}`,
  );
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location")).searchParams.get("error"), "invalid_target");
});

test("tokens are bound to this server's URL (audience)", async () => {
  const saved = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://other.example";
  try {
    const res = await handle(
      new Request("https://other.example/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    assert.equal(res.status, 401);
  } finally {
    process.env.PUBLIC_BASE_URL = saved;
  }
});

test("JSON-RPC batches and oversized bodies are rejected", async () => {
  const batch = await req("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
  });
  assert.equal(batch.status, 400);
  const big = await req("/register", { method: "POST", headers: { "content-type": "application/json", "content-length": String(1e6) }, body: "x" });
  assert.equal(big.status, 413);
});

test("responses carry security headers", async () => {
  const res = await req("/.well-known/oauth-protected-resource");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("strict-transport-security"), /max-age=/);
  const missing = await req("/nope");
  assert.equal(missing.headers.get("access-control-allow-origin"), "*");
});

test("PUBLIC_BASE_URL is required outside development", async () => {
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    const res = await req("/.well-known/oauth-protected-resource");
    assert.equal(res.status, 500);
  } finally {
    process.env.PUBLIC_BASE_URL = saved;
  }
});

test("accounts outside ALLOWED_NETATMO_USERS can't get tokens", async () => {
  const saved = process.env.ALLOWED_NETATMO_USERS;
  process.env.ALLOWED_NETATMO_USERS = "someone-else@example.com";
  try {
    // Sign in fresh (the fake Netatmo hands out tokens for owner@example.com).
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authz = await req(
      `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE_REDIRECT, code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
    const flow = (await authz.text()).match(/name="flow" value="([^"]+)"/)[1];
    const cookie = authz.headers.get("set-cookie").split(";")[0];
    const consent = await req("/authorize", { ...form({ flow, decision: "allow" }), headers: { ...form({}).headers, cookie } });
    const state = new URL(consent.headers.get("location")).searchParams.get("state");
    const cb = await req(`/callback?code=netatmo-code&state=${encodeURIComponent(state)}`, { headers: { cookie } });
    const code = new URL(cb.headers.get("location")).searchParams.get("code");
    const res = await req("/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error_description, /isn't allowed/);
  } finally {
    process.env.ALLOWED_NETATMO_USERS = saved;
  }
});

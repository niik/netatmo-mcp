// The Azure Functions adapter: bodies, redirects and Set-Cookie survive the round trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import azureFunctions from "@azure/functions";
const { HttpRequest } = azureFunctions;

Object.assign(process.env, {
  NETATMO_CLIENT_ID: "app-id",
  NETATMO_CLIENT_SECRET: "app-secret",
  TOKEN_KEY: randomBytes(32).toString("base64"),
  PUBLIC_BASE_URL: "https://fn.example",
});
const { httpHandler } = await import("../src/functions/http.js");
const ctx = { warn() {}, error() {}, log() {} };

test("register (POST JSON) through the Functions adapter", async () => {
  const res = await httpHandler(
    new HttpRequest({
      method: "POST",
      url: "https://fn.example/register",
      headers: { "content-type": "application/json" },
      body: { string: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) },
    }),
    ctx,
  );
  assert.equal(res.status, 201);
  const clientId = JSON.parse(res.body).client_id;

  const authz = await httpHandler(
    new HttpRequest({
      method: "GET",
      url: `https://fn.example/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
      })}`,
    }),
    ctx,
  );
  assert.equal(authz.status, 302);
  assert.match(authz.headers.location, /\/oauth2\/authorize\?/);
  assert.equal(authz.cookies.length, 1);
  assert.match(authz.cookies[0].name, /^nmcp_/);
  assert.equal(authz.cookies[0].httpOnly, true);
  assert.equal(authz.cookies[0].secure, true);
  assert.equal(authz.cookies[0].path, "/");
});

test("401 on /mcp without a token", async () => {
  const res = await httpHandler(new HttpRequest({ method: "POST", url: "https://fn.example/mcp", body: { string: "{}" } }), ctx);
  assert.equal(res.status, 401);
  assert.match(res.headers["www-authenticate"], /resource_metadata=/);
});

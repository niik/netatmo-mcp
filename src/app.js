// Router: one web-standard handler (Request → Response) for every route, used
// by both the Azure Functions entry and the Node server.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { baseUrl } from "./config.js";
import { createServer } from "./mcp.js";
import {
  authorizationServerMetadata,
  authorize,
  bearerToNetatmo,
  callback,
  CORS_HEADERS,
  json,
  protectedResourceMetadata,
  register,
  token,
  wwwAuthenticate,
} from "./oauth.js";

/** Largest request body accepted, in bytes (entry points enforce it while reading). */
export const MAX_BODY_BYTES = 64 * 1024;

async function handleMcp(request) {
  const netatmoToken = bearerToNetatmo(request);
  if (!netatmoToken) {
    const hasAuth = request.headers.has("authorization");
    return json(
      401,
      { error: hasAuth ? "invalid_token" : "unauthorized", error_description: "Sign in with Netatmo to use this server" },
      { "www-authenticate": wwwAuthenticate(request, hasAuth ? "invalid_token" : undefined) },
    );
  }
  // Stateless Streamable HTTP: no sessions and no server-initiated streams.
  if (request.method !== "POST")
    return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { allow: "POST" });

  // One JSON-RPC message per request: batches would multiply Netatmo calls.
  const raw = await request.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  if (Array.isArray(parsed))
    return json(400, { jsonrpc: "2.0", error: { code: -32600, message: "Batch requests are not supported" }, id: null });

  const server = createServer(netatmoToken);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(new Request(request.url, { method: "POST", headers: request.headers, body: raw }));
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    // Buffer the body before the server is closed.
    const body = res.body ? await res.text() : null;
    return new Response(body, { status: res.status, headers });
  } finally {
    await server.close().catch(() => {});
  }
}

const ROUTES = {
  "/mcp": { GET: handleMcp, POST: handleMcp, DELETE: handleMcp },
  "/.well-known/oauth-protected-resource": { GET: protectedResourceMetadata },
  "/.well-known/oauth-protected-resource/mcp": { GET: protectedResourceMetadata },
  "/.well-known/oauth-authorization-server": { GET: authorizationServerMetadata },
  "/.well-known/oauth-authorization-server/mcp": { GET: authorizationServerMetadata },
  "/.well-known/openid-configuration": { GET: authorizationServerMetadata },
  "/register": { POST: register },
  "/authorize": { GET: authorize },
  "/callback": { GET: callback },
  "/token": { POST: token },
  "/health": { GET: () => json(200, { ok: true }) },
  "/": {
    GET: (request) =>
      new Response(`Netatmo MCP server. Add ${baseUrl(request)}/mcp as a remote MCP connector.\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
  },
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
};

async function route(request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  const r = ROUTES[path];
  if (!r) return json(404, { error: "not_found" });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const handler = r[request.method];
  if (!handler) return json(405, { error: "method_not_allowed" }, { allow: Object.keys(r).join(", ") });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json(413, { error: "request_too_large" });
  try {
    return await handler(request);
  } catch (e) {
    // Log the error type and message only: never request data or tokens.
    console.error(`${request.method} ${path} failed: ${e?.name}: ${e?.message}`);
    return json(500, { error: "server_error" });
  }
}

export async function handle(request) {
  const res = await route(request);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  return res;
}

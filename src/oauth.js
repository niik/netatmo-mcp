// Stateless OAuth 2.1 authorization server that fronts Netatmo's OAuth, as the
// MCP authorization spec expects (protected-resource metadata, AS metadata,
// dynamic client registration, PKCE).
//
// Netatmo has no dynamic client registration and MCP clients can't hold this
// server's Netatmo client secret, so the server proxies the flow:
//
//   MCP client ──/register────▶ client_id = sealed {redirect_uris}
//   MCP client ──GET /authorize▶ checks client + PKCE, sets a nonce cookie and redirects to Netatmo with
//                                state = sealed {client redirect, PKCE challenge, nonce}
//   Netatmo ───/callback──────▶ checks state + cookie, redirects to the client with
//                                code = sealed {Netatmo code, PKCE challenge, ...}
//   MCP client ──/token───────▶ checks PKCE, exchanges the Netatmo code with the app secret, returns
//                                access_token = sealed {Netatmo access token}, refresh_token = sealed {Netatmo refresh token}
//
// Nothing is stored server-side: every value the server needs later travels
// inside an encrypted blob (see crypto.js). There is no consent page of our
// own: Netatmo's consent screen is the only one. Every client shares one
// Netatmo app, so that screen can't tell clients apart; the exact redirect URI
// allowlist and ALLOWED_NETATMO_USERS limit what that exposes.

import { baseUrl, config, NETATMO_SCOPE } from "./config.js";
import { fingerprint, pkceMatches, randomToken, seal, unseal } from "./crypto.js";
import { exchangeCode, netatmoAuthorizeUrl, NetatmoClient, NetatmoError, refreshTokens } from "./netatmo.js";

const FLOW_TTL = 15 * 60; // Netatmo sign-in must finish within 15 minutes
const CODE_TTL = 5 * 60;
const COOKIE_PREFIX = "nmcp_";
// Netatmo access tokens live 3 h; ours expires a little earlier so the client
// refreshes before Netatmo starts rejecting it.
const ACCESS_MARGIN = 120;
const MAX_URI_LENGTH = 2048;

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS, ...headers },
  });

const oauthError = (status, error, description) => json(status, { error, error_description: description });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function page(status, title, bodyHtml, headers = {}) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<body style="font:16px/1.5 system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222">
${bodyHtml}</body></html>`;
  return new Response(html, { status, headers: { ...HTML_HEADERS, ...headers } });
}

const htmlError = (status, message) =>
  page(
    status,
    "Netatmo MCP – sign-in problem",
    `<h1 style="font-size:1.3rem">Couldn't connect Netatmo</h1><p>${escapeHtml(message)}</p>
<p>Close this window and try connecting again from your MCP client.</p>`,
  );

const redirect = (location, headers = {}) =>
  new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers } });

function withParams(uri, params) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.toString();
}

// One cookie per sign-in, named after its nonce, so parallel sign-ins don't clash.
const cookieName = (nonce) => `${COOKIE_PREFIX}${fingerprint(nonce).slice(0, 10)}`;

function cookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ── Metadata ────────────────────────────────────────────────────────────────

const resourceUrl = (request) => `${baseUrl(request)}/mcp`;

export function protectedResourceMetadata(request) {
  const base = baseUrl(request);
  return json(
    200,
    {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [NETATMO_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Netatmo Weather",
    },
    { "cache-control": "public, max-age=3600" },
  );
}

export function authorizationServerMetadata(request) {
  const base = baseUrl(request);
  return json(
    200,
    {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [NETATMO_SCOPE],
      authorization_response_iss_parameter_supported: true,
    },
    { "cache-control": "public, max-age=3600" },
  );
}

/** Value for WWW-Authenticate on 401s from /mcp, pointing clients at the metadata. */
export const wwwAuthenticate = (request, error) =>
  `Bearer resource_metadata="${baseUrl(request)}/.well-known/oauth-protected-resource"` +
  (error ? `, error="${error}"` : "");

// ── Redirect URI policy ─────────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseUri(uri) {
  if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) return null;
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** Allowed: an exact https URI from the allowlist, or an http(s) loopback URI. */
function redirectUriAllowed(uri) {
  const url = parseUri(uri);
  if (!url) return false;
  if (LOOPBACK.has(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && config().allowedRedirectUris.includes(uri);
}

/** Exact match, except that loopback redirects may use any port (RFC 8252 §7.3). */
function redirectUriRegistered(uri, registered) {
  if (registered.includes(uri)) return true;
  const url = parseUri(uri);
  if (!url || !LOOPBACK.has(url.hostname)) return false;
  return registered.some((r) => {
    const reg = parseUri(r);
    return (
      reg &&
      LOOPBACK.has(reg.hostname) &&
      reg.protocol === url.protocol &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

/** RFC 8707: if the client names a resource, it must be this server's MCP endpoint. */
function resourceOk(request, resource) {
  if (!resource) return true;
  const ours = resourceUrl(request);
  return resource === ours || resource === baseUrl(request) || resource === `${ours}/`;
}

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

export async function register(request) {
  let meta;
  try {
    meta = await request.json();
  } catch {
    return oauthError(400, "invalid_client_metadata", "Body must be JSON");
  }
  const uris = meta?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string"))
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array of URLs");
  if (!uris.every(redirectUriAllowed))
    return oauthError(
      400,
      "invalid_redirect_uri",
      "Redirect URI not allowed. This server accepts Claude's callback and loopback URIs; the operator can allow more with ALLOWED_REDIRECT_URIS.",
    );

  const name = typeof meta.client_name === "string" ? meta.client_name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) : undefined;
  const issuedAt = Math.floor(Date.now() / 1000);
  // The client id *is* the registration: a sealed record of the redirect URIs.
  const clientId = seal("client", { r: uris, n: name, iat: issuedAt });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: NETATMO_SCOPE,
  });
}

// ── Authorization endpoint ──────────────────────────────────────────────────

export function authorize(request) {
  const p = new URL(request.url).searchParams;
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  const client = unseal("client", clientId);
  if (!client) return htmlError(400, "Unknown client. Remove the connector and add it again.");
  if (!redirectUri || !redirectUriRegistered(redirectUri, client.r) || !redirectUriAllowed(redirectUri))
    return htmlError(400, "The redirect URI isn't registered for this client.");

  // From here on, errors go back to the client.
  const iss = baseUrl(request);
  const fail = (error, description) =>
    redirect(withParams(redirectUri, { error, error_description: description, state: p.get("state"), iss }));
  if (p.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const challenge = p.get("code_challenge");
  if (!challenge || p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!resourceOk(request, p.get("resource"))) return fail("invalid_target", "Unknown resource");
  if (!config().clientId) return fail("server_error", "Netatmo app credentials are not configured on the server");

  const nonce = randomToken();
  const fl = { ru: redirectUri, cs: p.get("state") ?? undefined, cc: challenge, cid: fingerprint(clientId), nn: nonce };
  const secure = iss.startsWith("https:") ? "; Secure" : "";
  // SameSite=Lax: sent on the top-level redirect back from Netatmo.
  const setCookie = `${cookieName(nonce)}=${nonce}; Path=/; Max-Age=${FLOW_TTL}; HttpOnly; SameSite=Lax${secure}`;
  const state = seal("state", fl, FLOW_TTL);
  return redirect(netatmoAuthorizeUrl({ redirectUri: `${iss}/callback`, state }), { "set-cookie": setCookie });
}

// ── Netatmo redirect back to us ─────────────────────────────────────────────

export function callback(request) {
  const p = new URL(request.url).searchParams;
  const st = unseal("state", p.get("state"));
  if (!st) return htmlError(400, "The sign-in link expired or is invalid.");
  // Bind the flow to the browser that started it (prevents login CSRF).
  if (cookie(request, cookieName(st.nn)) !== st.nn)
    return htmlError(400, "This sign-in was started in another browser or has already been used.");

  const clear = { "set-cookie": `${cookieName(st.nn)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` };
  const iss = baseUrl(request);
  const error = p.get("error");
  if (error) {
    const denied = error === "access_denied";
    const description = denied ? "The user declined access at Netatmo" : "Netatmo sign-in failed";
    return redirect(withParams(st.ru, { error: denied ? error : "server_error", error_description: description, state: st.cs, iss }), clear);
  }
  const netatmoCode = p.get("code");
  if (!netatmoCode)
    return redirect(withParams(st.ru, { error: "server_error", error_description: "Netatmo returned no code", state: st.cs, iss }), clear);

  // The Netatmo code is exchanged later, at /token, once PKCE has been checked.
  const code = seal("code", { nc: netatmoCode, cc: st.cc, ru: st.ru, cid: st.cid }, CODE_TTL);
  return redirect(withParams(st.ru, { code, state: st.cs, iss }), clear);
}

// ── Token endpoint ──────────────────────────────────────────────────────────

async function formParams(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    return new URLSearchParams(Object.entries(body ?? {}).map(([k, v]) => [k, String(v)]));
  }
  return new URLSearchParams(await request.text());
}

/**
 * With ALLOWED_NETATMO_USERS set, only those Netatmo accounts may use this
 * deployment. Checked whenever tokens are issued (sign-in and every refresh),
 * so removing someone takes effect within one access-token lifetime.
 */
async function userAllowed(netatmo) {
  const allowed = config().allowedUsers;
  if (!allowed.length) return true;
  const body = await new NetatmoClient(netatmo.accessToken).getStationsData();
  const mail = String(body?.user?.mail || "").trim().toLowerCase();
  return mail !== "" && allowed.includes(mail);
}

const NOT_ALLOWED = () =>
  oauthError(400, "invalid_grant", "This Netatmo account isn't allowed to use this server. Ask the server's operator for access.");

function issueTokens(request, netatmo, clientFp, previousRefresh) {
  const ttl = Math.max(60, netatmo.expiresIn - ACCESS_MARGIN);
  const aud = resourceUrl(request);
  return json(200, {
    access_token: seal("access", { t: netatmo.accessToken, aud }, ttl),
    token_type: "Bearer",
    expires_in: ttl,
    // Netatmo rotates refresh tokens; keep the old one if it ever doesn't.
    refresh_token: seal("refresh", { t: netatmo.refreshToken ?? previousRefresh, cid: clientFp, aud }),
    scope: NETATMO_SCOPE,
  });
}

export async function token(request) {
  const p = await formParams(request);
  const grant = p.get("grant_type");
  const clientId = p.get("client_id");
  if (!clientId) return oauthError(400, "invalid_request", "client_id is required");
  const clientFp = fingerprint(clientId);
  if (!resourceOk(request, p.get("resource"))) return oauthError(400, "invalid_target", "Unknown resource");

  if (grant === "authorization_code") {
    const code = unseal("code", p.get("code"));
    if (!code) return oauthError(400, "invalid_grant", "Authorization code is invalid or expired");
    if (clientFp !== code.cid) return oauthError(400, "invalid_grant", "Code was issued to another client");
    if (p.get("redirect_uri") !== code.ru) return oauthError(400, "invalid_grant", "redirect_uri does not match");
    if (!pkceMatches(p.get("code_verifier"), code.cc)) return oauthError(400, "invalid_grant", "PKCE verification failed");
    try {
      const netatmo = await exchangeCode(code.nc, `${baseUrl(request)}/callback`);
      if (!(await userAllowed(netatmo))) return NOT_ALLOWED();
      return issueTokens(request, netatmo, code.cid);
    } catch (e) {
      // Netatmo codes are single-use, so a replayed code fails here.
      return oauthError(400, "invalid_grant", e instanceof NetatmoError ? e.message : "Code exchange failed");
    }
  }

  if (grant === "refresh_token") {
    const rt = unseal("refresh", p.get("refresh_token"));
    if (!rt || !rt.t || rt.aud !== resourceUrl(request)) return oauthError(400, "invalid_grant", "Refresh token is invalid");
    if (clientFp !== rt.cid) return oauthError(400, "invalid_grant", "Refresh token was issued to another client");
    try {
      const netatmo = await refreshTokens(rt.t);
      if (!(await userAllowed(netatmo))) return NOT_ALLOWED();
      return issueTokens(request, netatmo, rt.cid, rt.t);
    } catch (e) {
      return oauthError(400, "invalid_grant", e instanceof NetatmoError ? e.message : "Refresh failed");
    }
  }

  return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** Netatmo access token from an `Authorization: Bearer` header issued for this server, or null. */
export function bearerToNetatmo(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)\s*$/i);
  if (!m) return null;
  const at = unseal("access", m[1]);
  return at?.t && at.aud === resourceUrl(request) ? at.t : null;
}

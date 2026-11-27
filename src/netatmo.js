// Minimal Netatmo Weather API client: OAuth token calls (made with this
// server's app credentials) and the two station endpoints the tools use.
// https://dev.netatmo.com/apidocumentation/weather

import { config, NETATMO_SCOPE } from "./config.js";

export class NetatmoError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
  /** Netatmo error codes 2 (invalid token) and 3 (expired token) mean the user must re-authenticate. */
  get isAuthError() {
    return this.code === 2 || this.code === 3 || this.status === 401;
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

async function tokenRequest(params) {
  const { netatmoBase, clientId, clientSecret } = config();
  if (!clientId || !clientSecret) throw new NetatmoError("Netatmo app credentials are not configured on the server");
  const res = await fetch(`${netatmoBase}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret }),
  });
  const body = await readJson(res);
  if (!res.ok || !body.access_token) {
    const msg = body.error_description || body.error || `HTTP ${res.status}`;
    throw new NetatmoError(`Netatmo token request failed: ${msg}`, { status: res.status });
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: Number(body.expires_in) || 10800,
    scope: Array.isArray(body.scope) ? body.scope.join(" ") : body.scope || NETATMO_SCOPE,
  };
}

export function netatmoAuthorizeUrl({ redirectUri, state }) {
  const { netatmoBase, clientId } = config();
  const url = new URL(`${netatmoBase}/oauth2/authorize`);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: NETATMO_SCOPE, state });
  return url.toString();
}

export const exchangeCode = (code, redirectUri) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, scope: NETATMO_SCOPE });

export const refreshTokens = (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

/** API client bound to one user's Netatmo access token. */
export class NetatmoClient {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async get(path, params = {}) {
    const url = new URL(`${config().netatmoBase}/api/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.accessToken}` } });
    const body = await readJson(res);
    if (!res.ok || body.error) {
      const err = body.error || {};
      throw new NetatmoError(`Netatmo API error: ${err.message || body.raw || `HTTP ${res.status}`}`, {
        status: res.status,
        code: err.code,
      });
    }
    return body.body;
  }

  /** Stations (devices) with their modules and latest readings, plus the user's unit preferences. */
  getStationsData() {
    return this.get("getstationsdata", { get_favorites: false });
  }

  /**
   * Historical measurements. Returns [{ time (unix s), values: [...] }] in `types` order.
   * Uses optimize=false, where the body is { "<unix ts>": [v1, v2, ...] }.
   */
  async getMeasure({ deviceId, moduleId, scale, types, dateBegin, dateEnd, limit = 1024 }) {
    const body = await this.get("getmeasure", {
      device_id: deviceId,
      module_id: moduleId && moduleId !== deviceId ? moduleId : undefined,
      scale,
      type: types.join(","),
      date_begin: dateBegin,
      date_end: dateEnd,
      limit,
      optimize: false,
      real_time: false,
    });
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    return Object.entries(body)
      .map(([ts, values]) => ({ time: Number(ts), values }))
      .filter((p) => Number.isFinite(p.time))
      .sort((a, b) => a.time - b.time);
  }
}

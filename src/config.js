// Runtime configuration, read from the environment on every call so tests and
// the dev server can set it before the first request.

export const NETATMO_SCOPE = "read_station";

// OAuth redirect URIs MCP clients may register (exact match, https). Loopback
// http redirects (Claude Code, MCP Inspector) are always allowed.
const DEFAULT_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function config() {
  return {
    netatmoBase: (process.env.NETATMO_BASE_URL || "https://api.netatmo.com").replace(/\/+$/, ""),
    clientId: (process.env.NETATMO_CLIENT_ID || "").trim(),
    clientSecret: (process.env.NETATMO_CLIENT_SECRET || "").trim(),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    allowedRedirectUris: [...DEFAULT_REDIRECT_URIS, ...list(process.env.ALLOWED_REDIRECT_URIS)],
    // Netatmo account emails allowed to sign in. Empty = any Netatmo account.
    allowedUsers: list(process.env.ALLOWED_NETATMO_USERS).map((e) => e.toLowerCase()),
  };
}

/**
 * The server's public origin. PUBLIC_BASE_URL is required outside development:
 * deriving it from Host/X-Forwarded-Host would let a client pick the issuer
 * and the Netatmo redirect URI.
 */
export function baseUrl(request) {
  const { publicBaseUrl } = config();
  if (publicBaseUrl) return publicBaseUrl;
  if (process.env.NODE_ENV !== "development") throw new Error("PUBLIC_BASE_URL is not configured");
  return new URL(request.url).origin;
}

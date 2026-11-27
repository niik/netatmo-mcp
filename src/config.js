// Runtime configuration, read from the environment on every call so tests and
// the dev server can set it before the first request.

export const NETATMO_SCOPE = "read_station";

// OAuth redirect URIs MCP clients may register (exact match, https). Loopback
// http redirects (Claude Code, MCP Inspector) are always allowed.
const DEFAULT_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];

/**
 * Email comparison for the allowlist: printable ASCII only, ASCII letters
 * lowercased. Full Unicode toLowerCase() would fold e.g. the Kelvin sign
 * into "k" and let a look-alike address match. Returns "" if not usable.
 */
export function normalizeEmail(v) {
  const s = String(v || "").trim();
  if (!/^[\x21-\x7e]+@[\x21-\x7e]+$/.test(s)) return "";
  return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * ALLOWED_NETATMO_USERS: unset/blank → anyone ({ any: true }). Otherwise the
 * listed emails; if any entry isn't a usable email (e.g. " , " or a
 * space-separated list), fail closed and allow nobody rather than everybody.
 */
function allowlist(raw) {
  if (!String(raw || "").trim()) return { any: true, users: [] };
  const entries = list(raw);
  const users = entries.map(normalizeEmail);
  if (!users.length || users.some((u) => !u)) return { any: false, users: [], invalid: true };
  return { any: false, users };
}

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
    // Netatmo account emails allowed to sign in (see allowlist()).
    allowedUsers: allowlist(process.env.ALLOWED_NETATMO_USERS),
    // Loopback redirect URIs (Claude Code, MCP Inspector). On unless "false"/"off"/"0".
    allowLoopback: !/^(false|off|0|no)$/i.test((process.env.ALLOW_LOOPBACK_REDIRECTS || "").trim()),
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

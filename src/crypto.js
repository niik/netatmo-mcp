// Sealed tokens: everything this server hands out (client ids, OAuth state,
// authorization codes, access and refresh tokens) is an AES-256-GCM encrypted
// JSON blob. That is what lets the server stay stateless: there is no
// database, only the TOKEN_KEY secret.
//
// Each purpose gets its own HKDF-derived key, so a blob sealed as one kind of
// token can never be opened as another.
//
// Key rotation: set TOKEN_KEY to the new key and TOKEN_KEY_PREVIOUS to the old
// one. New tokens use TOKEN_KEY; both are accepted when opening, so nobody is
// signed out. Keep TOKEN_KEY_PREVIOUS for as long as refresh tokens live (see
// REFRESH_TTL in oauth.js): an idle user's refresh token sealed with the old
// key stops working once it is removed.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "n1";
const keyCache = new Map();

// TOKEN_KEY must be random bytes in canonical base64 (`openssl rand -base64 32`).
// HKDF doesn't stretch keys, so a passphrase would be open to offline guessing
// (every client_id is a known-plaintext sample); Buffer.from(…, "base64")
// silently skips invalid characters, so non-canonical input is refused.
function parseKey(raw, name) {
  const s = raw.trim();
  const key = Buffer.from(s, "base64");
  const canonical = key.toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "");
  if (!canonical || key.length < 32 || new Set(key).size < 16)
    throw new Error(`${name} must be at least 32 random bytes, base64-encoded (openssl rand -base64 32)`);
  return key;
}

/** Master keys, newest first. Throws if TOKEN_KEY / TOKEN_KEY_PREVIOUS are missing or invalid. */
export function masterKeys() {
  const current = (process.env.TOKEN_KEY || "").trim();
  if (!current) throw new Error("TOKEN_KEY is not configured");
  const keys = [parseKey(current, "TOKEN_KEY")];
  const previous = (process.env.TOKEN_KEY_PREVIOUS || "").trim();
  if (previous) keys.push(parseKey(previous, "TOKEN_KEY_PREVIOUS"));
  return keys;
}

function derive(master, purpose) {
  const cacheKey = `${purpose}:${createHash("sha256").update(master).digest("base64")}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `netatmo-mcp/${purpose}`, 32));
    keyCache.set(cacheKey, key);
  }
  return key;
}

const now = () => Math.floor(Date.now() / 1000);

/** Encrypt `payload` for `purpose`. `ttl` (seconds) adds an expiry checked by unseal. */
export function seal(purpose, payload, ttl) {
  const body = ttl ? { ...payload, exp: now() + ttl } : payload;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(masterKeys()[0], purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url")}`;
}

function openWith(key, purpose, buf) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
  } catch {
    return null;
  }
}

/** Decrypt a sealed token. Returns null if it is malformed, forged, for another purpose or expired. */
export function unseal(purpose, token) {
  if (typeof token !== "string" || !token.startsWith(`${VERSION}.`) || token.length > 16384) return null;
  const encoded = token.slice(VERSION.length + 1);
  const buf = Buffer.from(encoded, "base64url");
  // Only the exact encoding seal() produces, so a token string is a stable identifier.
  if (buf.length < 12 + 16 + 2 || buf.toString("base64url") !== encoded) return null;
  for (const master of masterKeys()) {
    const pt = openWith(derive(master, purpose), purpose, buf);
    if (!pt) continue;
    try {
      const body = JSON.parse(pt.toString("utf8"));
      if (body.exp && body.exp < now()) return null;
      return body;
    } catch {
      return null;
    }
  }
  return null;
}

/** Short, stable fingerprint of a string (used to bind tokens to a client id). */
export const fingerprint = (s) => createHash("sha256").update(String(s)).digest("base64url").slice(0, 16);

/** PKCE S256 check. */
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Opaque, stable stand-in for a Netatmo device id. Those ids are MAC
 * addresses, and Netatmo's public weather map pairs a station's MAC with its
 * GPS location, so they aren't shown to clients. Keyed (HMAC with a key
 * derived from TOKEN_KEY): a plain hash of a MAC with a known vendor prefix
 * could be reversed by trying all ~16M device suffixes.
 */
export const opaqueId = (raw) =>
  createHmac("sha256", derive(masterKeys()[0], "device-id")).update(String(raw).toLowerCase()).digest("base64url").slice(0, 10);

export const randomToken = (bytes = 16) => randomBytes(bytes).toString("base64url");

// Azure Functions entry: one anonymous catch-all HTTP function that hands
// every request to the web-standard router in ../app.js. Auth is done by the
// app itself (OAuth bearer tokens), not by Functions keys.

import { app } from "@azure/functions";
import { handle, MAX_BODY_BYTES, SECURITY_HEADERS } from "../app.js";

// Stream request bodies to the worker instead of having the host buffer them
// whole first, so the size limit below applies while reading.
app.setup({ enableHttpStream: true });

class TooLarge extends Error {}

/** The request body, read with a running size limit (one copy). */
async function readBody(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) throw new TooLarge();
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const COOKIE_ATTRS = new Set(["path", "max-age", "httponly", "secure", "samesite"]);

/** The app's Set-Cookie headers as Functions cookie objects. Fails loudly on anything it can't carry over. */
export function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  if (eq <= 0) throw new Error("Set-Cookie without a name=value pair");
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  for (const a of attrs) {
    const i = a.indexOf("=");
    const key = (i < 0 ? a : a.slice(0, i)).toLowerCase();
    const v = i < 0 ? "" : a.slice(i + 1);
    if (!COOKIE_ATTRS.has(key)) throw new Error(`Unsupported Set-Cookie attribute: ${key}`);
    if (key === "path") cookie.path = v;
    else if (key === "max-age") {
      cookie.maxAge = Number(v);
      if (!Number.isInteger(cookie.maxAge)) throw new Error("Invalid Max-Age");
    } else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = v;
  }
  return cookie;
}

const tooLarge = () => ({
  status: 413,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...SECURITY_HEADERS },
  body: JSON.stringify({ error: "request_too_large" }),
});

export async function httpHandler(request, context) {
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  let body;
  try {
    body = hasBody ? await readBody(request) : undefined;
  } catch (e) {
    if (e instanceof TooLarge) return tooLarge();
    throw e;
  }
  const webRequest = new Request(request.url, { method: request.method, headers: request.headers, body });
  const res = await handle(webRequest);
  const headers = {};
  const cookies = [];
  for (const [k, v] of res.headers) {
    if (k === "set-cookie") cookies.push(parseSetCookie(v));
    else headers[k] = v;
  }
  const resBody = res.body ? await res.text() : undefined;
  if (res.status >= 500) context.warn(`${request.method} ${new URL(request.url).pathname} -> ${res.status}`);
  return { status: res.status, headers, cookies, body: resBody };
}

app.http("http", {
  route: "{*path}",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  handler: httpHandler,
});

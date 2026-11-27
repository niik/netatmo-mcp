// Azure Functions entry: one anonymous catch-all HTTP function that hands
// every request to the web-standard router in ../app.js. Auth is done by the
// app itself (OAuth bearer tokens), not by Functions keys.

import { app } from "@azure/functions";
import { handle, MAX_BODY_BYTES } from "../app.js";

function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(";").map((s) => s.trim());
  const eq = pair.indexOf("=");
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  for (const a of attrs) {
    const [k, v] = a.split("=");
    const key = k.toLowerCase();
    if (key === "path") cookie.path = v;
    else if (key === "max-age") cookie.maxAge = Number(v);
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "secure") cookie.secure = true;
    else if (key === "samesite") cookie.sameSite = v;
  }
  return cookie;
}

const tooLarge = () => ({
  status: 413,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "request_too_large" }),
});

export async function httpHandler(request, context) {
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) return tooLarge();
  const body = hasBody ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > MAX_BODY_BYTES) return tooLarge();
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

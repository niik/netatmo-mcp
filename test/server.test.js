// The node:http entry (Docker): request shapes the router never sees.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";

Object.assign(process.env, { TOKEN_KEY: randomBytes(32).toString("base64"), PUBLIC_BASE_URL: "https://mcp.example" });
const { listen } = await import("../src/server.js");
let server, port;
before(async () => {
  server = await listen({ port: 0, host: "127.0.0.1" });
  port = server.address().port;
});
after(() => server.close());

const raw = (method, path, body) =>
  new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, method, path }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    r.on("error", reject);
    r.end(body);
  });

test("unknown methods get 405 with security headers", async () => {
  const res = await raw("TRACE", "/");
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test("paths that would change the origin are refused", async () => {
  assert.equal((await raw("GET", "//evil.example/mcp")).statusCode, 400);
  assert.equal((await raw("GET", "/health")).statusCode, 200);
});

test("chunked bodies over the limit get 413 with security headers", async () => {
  const res = await raw("POST", "/register", "x".repeat(100 * 1024));
  assert.equal(res.statusCode, 413);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

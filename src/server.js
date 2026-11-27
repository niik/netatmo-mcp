#!/usr/bin/env node
// Production Node entry point (Docker or any Node host): `node src/server.js`.
// Configure with environment variables (see README); put it behind HTTPS.
//   PORT (default 3000), HOST (default 0.0.0.0), PUBLIC_BASE_URL (required),
//   TOKEN_KEY, NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, ...

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { handle, MAX_BODY_BYTES } from "./app.js";

class TooLarge extends Error {}

async function readBody(req) {
  if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw new TooLarge();
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(c);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/** Bridge node:http to the web-standard handler. */
export function listen({ port, host }) {
  const server = createServer(async (req, res) => {
    try {
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
      const base = process.env.PUBLIC_BASE_URL || `http://${req.headers.host || "localhost"}`;
      const request = new Request(new URL(req.url, base), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
        body,
      });
      const response = await handle(request);
      const headers = {};
      for (const [k, v] of response.headers) headers[k] = k === "set-cookie" ? response.headers.getSetCookie() : v;
      res.writeHead(response.status, headers);
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (e) {
      if (e instanceof TooLarge) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" }).end('{"error":"request_too_large"}');
        req.destroy();
        return;
      }
      console.error(`Request failed: ${e?.name}: ${e?.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PUBLIC_BASE_URL) {
    console.error("PUBLIC_BASE_URL is required (e.g. https://weather.example.com)");
    process.exit(1);
  }
  const server = await listen({ port: Number(process.env.PORT) || 3000, host: process.env.HOST || "0.0.0.0" });
  console.log(`Netatmo MCP server listening on ${JSON.stringify(server.address())}, public URL ${process.env.PUBLIC_BASE_URL}/mcp`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

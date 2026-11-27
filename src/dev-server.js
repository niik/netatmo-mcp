#!/usr/bin/env node
// Local development server: `npm run dev`. Loads .env if present (see
// .env.example), listens on 127.0.0.1 only, and defaults PUBLIC_BASE_URL to
// http://localhost:PORT. Add http://localhost:3000/callback as a redirect URI
// on your Netatmo app to sign in locally. For production use src/server.js.

import { existsSync } from "node:fs";
import { listen } from "./server.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const port = Number(process.env.PORT) || 3000;
process.env.NODE_ENV ||= "development";
process.env.PUBLIC_BASE_URL ||= `http://localhost:${port}`;

await listen({ port, host: "127.0.0.1" });
console.log(`Netatmo MCP dev server: ${process.env.PUBLIC_BASE_URL}/mcp`);

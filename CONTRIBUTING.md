# Contributing

Issues and pull requests are welcome.

## Getting started

```bash
npm ci
npm test       # end-to-end OAuth + tool tests against a fake Netatmo API
npm run check  # syntax check
npm run dev    # local server on http://localhost:3000 (see README)
```

Node 22 or newer is required. There's no build step and no linter config; match
the style of the surrounding code.

## Guidelines

- **Keep the server stateless.** No database, cache or per-user storage. Anything
  the server needs later travels inside a sealed token with its own purpose
  string (`src/crypto.js`).
- **No secrets in the repo, logs or test fixtures.** Never commit or print
  `TOKEN_KEY`, a Netatmo client secret, or any access/refresh token. Your Azure
  settings belong in `infra/config.env`, which is gitignored.
- **Add tests** in `test/flow.test.js` for new tools or auth behavior, and make
  sure `npm test` passes.
- Keep the Netatmo scope read-only (`read_station`).
- Keep pull requests focused, and explain the why in the description.

## About the codebase

This project was written by an AI agent (Claude, via Claude Code) under human
direction; see the README. Contributions from people (and from agents) are
equally welcome, and reviews that catch mistakes are especially appreciated.

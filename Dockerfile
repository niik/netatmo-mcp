# Container image for running the server on any Docker / Node host (the Azure
# Functions deployment doesn't use it). It runs the plain node:http entry
# (src/server.js) and must sit behind an HTTPS reverse proxy.
#
#   docker build -t netatmo-mcp .
#   docker run -d -p 3000:3000 \
#     -e PUBLIC_BASE_URL=https://netatmo-mcp.example.com \
#     -e TOKEN_KEY=... -e NETATMO_CLIENT_ID=... -e NETATMO_CLIENT_SECRET=... \
#     netatmo-mcp
FROM node:26-alpine

# tini as PID 1 forwards SIGTERM so `docker stop` exits promptly.
RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]

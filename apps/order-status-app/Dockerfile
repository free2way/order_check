FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    APP_VERSION=0.1.0

WORKDIR /app

# Copy only the runtime surface; tests, ops tooling and docs stay in the repo.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# The official image ships an unprivileged "node" user (uid 1000).
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((res) => { if (!res.ok) { process.exit(1); } return res.json(); }).then((body) => { if (!body || body.service !== 'order-status-app') { process.exit(1); } }).catch(() => process.exit(1));"

CMD ["node", "src/server.mjs"]

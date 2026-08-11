# CRMF backend — ingestion + fleet portal API (monitoring-only).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY backend/. .

# Credential-provisioning output (scripts/provision-rigs.js --json / --out).
# Created here and owned by `node` so the named volume mounted over it inherits
# that ownership — a volume mounted onto a path absent from the image is created
# root-owned, and the unprivileged runtime user then cannot write to it.
RUN mkdir -p /provisioning && chown node:node /provisioning

USER node
EXPOSE 6000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://127.0.0.1:6000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

# CRMF backend — ingestion + fleet portal API (monitoring-only).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY backend/. .

USER node
EXPOSE 6000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://127.0.0.1:6000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]

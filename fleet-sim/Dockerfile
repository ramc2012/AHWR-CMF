# CRMF fleet simulator (demo only) — no external dependencies.
FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY sim.js .
USER node
CMD ["node", "sim.js"]

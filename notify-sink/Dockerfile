# CRMF demo webhook sink (demo only) — no external dependencies.
FROM node:20-alpine
WORKDIR /app
COPY server.js .
USER node
EXPOSE 9020
CMD ["node", "server.js"]

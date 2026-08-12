# ahwr-central-mcp-server (read-only)

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the **CRMF central facility** (fleet monitoring) to AI systems — **read-only**.

It mints a `viewer`-role JWT (signed with the central `JWT_SECRET`), so the central RBAC rejects any write. Transport is **streamable HTTP** (stateless JSON) at `POST /mcp`.

**Security:** serves **HTTPS** when `TLS_CERT_FILE`/`TLS_KEY_FILE` are set (required for Cowork / claude.ai connectors), requires an **API key** (`MCP_API_KEY` → `Authorization: Bearer <key>`), and **audit-logs** every request. Self-signed cert mounted for local use; use a CA-signed cert in production. Endpoint: `https://127.0.0.1:8766/mcp`.

## Tools (all read-only)

| Tool | Purpose |
|------|---------|
| `central_get_fleet` | All rigs + live status / health / alarms / sync lag |
| `central_get_fleet_summary` | Fleet KPI aggregates |
| `central_get_rig` | One rig's detail + rolled-up status |
| `central_get_rig_live` | One rig's live telemetry mirror |
| `central_get_rig_history` | Multi-metric history for a rig (`metrics`, `minutes`) |
| `central_get_rig_alarms` | A rig's alarm history |
| `central_get_rig_activity` | A rig's activity timeline (`hours`) |
| `central_get_alarms` | Fleet-wide active alarms (`priority` filter) |
| `central_get_data_quality` | Per-rig data-quality / completeness / freshness |
| `central_get_governance` | Rollout gates, escalations, decisions |
| `central_get_workover` | Cross-fleet workover analytics (`hours`) |
| `central_get_wells` | Fleet wells (`query`/`status`/`assetUnit`) |
| `central_get_maintenance_summary` | PM compliance + overdue/breakdown counts |
| `central_get_fleet_report` | Period-aware fleet report (`period`) |
| `central_list_tags` | Canonical tag dictionary (valid dataKeys) |

## Run (via the central stack)

Wired into `central/docker-compose.yml` as the `crmf-mcp` service:

```bash
cd central
docker compose --profile demo up -d --build      # brings up timescaledb, backend, fleet-sim, crmf-mcp, portal
# MCP endpoint: http://127.0.0.1:8766/mcp
```

Config (env): `JWT_SECRET` (shared with central backend, required), `BACKEND_URL` (default `http://crmf-backend:6000`),
`MCP_API_KEY` (optional bearer guard), `MCP_CENTRAL_BIND`/`MCP_CENTRAL_PORT` (default `127.0.0.1:8766`).

## Scope

Read-only only — control/governance writes (gate changes, escalations, user/rig management) are intentionally **not** exposed.
The edge counterpart is `edge-mcp-server/` (per-rig). Central is monitoring-only by design.

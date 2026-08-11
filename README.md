# CRMF - Centralised Rig Monitoring Facility

A **separately deployable** central platform for the ONGC AHWR fleet, implementing
the *Central Facility* of the DGC proposal (§3 architecture, §5 hardware sizing,
§6 software requirements). It aggregates live data from up to 50+ rig-edge digital
twins and provides fleet-wide surveillance, a data-quality monitor, an alarm
command centre, a workover-performance view, automated reporting, and a governance
& rollout workspace.

> **No control path.** The CRMF *receives* telemetry and events from the rig edge,
> and its only downstream channel is read-only operator **text messages** to a
> rig HMI (acknowledged by the operator). It can never write a PLC tag or actuate
> equipment — monitoring + one-way messaging, never remote control (proposal §6.6;
> ESD/lockout surface as read-only alarms on the top alarm strip).

This project is fully self-contained and **does not modify the rig-edge app**. The
edge's existing store-and-forward sync agent (`../backend/lib/sync.js`) already
POSTs gzipped batches to `/ingest` in exactly the contract this backend accepts —
point its `CENTRAL_URL` here and a real rig streams in with zero code changes.

---

## Quickstart

```bash
cd central
cp .env.example .env
# Required — the backend refuses to start without these:
#   PGPASSWORD    openssl rand -hex 16
#   JWT_SECRET    openssl rand -hex 32   (>=32 chars; placeholders are rejected)
#   ADMIN_PASSWORD  your initial portal admin password (no default)
#   INGEST_TOKEN  openssl rand -hex 24   (only the fallback for unprovisioned rigs)
docker compose up -d --build
```

Open **http://localhost:8090** and sign in as `admin` with the `ADMIN_PASSWORD`
you set. There is **no default admin password** — a published one would be an
open door on every deployment.

| User | Password | Role |
|------|----------|------|
| `admin` | `ADMIN_PASSWORD` from `.env` | admin (edit governance) |
| `operator` | `OPERATOR_PASSWORD` from `.env` | operator |
| `viewer` | `VIEWER_PASSWORD` from `.env` | viewer (read-only) |

Point real rig-edge agents at `http://<this-host>:6000` via their `CENTRAL_URL`.
For a real fleet, issue each rig its own credential rather than sharing
`INGEST_TOKEN` — see `backend/scripts/provision-rigs.js`.

---
## Architecture

```
 rig-edge sync agents â”€â”€HTTPS gzip batchesâ”€â”€â–¶  crmf-backend (/ingest)
 (store-and-forward,     X-Device-Id + token        â”‚
  proposal §6.3)                                     â”œâ”€â–¶ TimescaleDB  (telemetry hypertable,
                                                     â”‚     1-min continuous aggregate, compression)
                                                     â”œâ”€â–¶ PostgreSQL   (rig/tag/governance masters)
                                                     â””â”€â–¶ Socket.IO â”€â”€â–¶ crmf-frontend (fleet portal)
```

| Service | Tech | Role |
|---------|------|------|
| `timescaledb` | TimescaleDB 2.17 / PostgreSQL 16 | Canonical telemetry + relational store (proposal §6.4) |
| `crmf-backend` | Node.js, Express, Socket.IO, `pg` | Ingestion, fleet API, live updates, RBAC |
| `crmf-frontend` | React 18, Vite, MUI, Recharts, nginx | Fleet portal UI |

The stack mirrors the rig-edge app's technology choices so the two are operationally
consistent.

---

## Portal modules (proposal §6.1)

- **Fleet Overview** — KPI bar, geographic field map, searchable/filterable rig list with live status, data-quality and alarm rollups.
- **Rig Drill-Down** — per-rig KPIs, live trend charts (TimescaleDB-backed), equipment/parameter groups, alarm and torque-turn connection history, deployment status.
- **Alarm Command Centre** — cross-rig active alarms, priority filters, P1 (ESD/lockout/well-control) surfacing.
- **Data Quality Monitor** — per-rig freshness + tag-completeness health score, sync-lag and stale/missing-tag flags.
- **Workover Performance** — torque-turn connection quality and fleet benchmarking, activity/NPT feed.
- **Governance & Rollout Workspace** — stage-gate funnel, per-rig rollout status (editable), value-realization KPIs (§7), escalation register, decision log.
- **Reports** — consolidated fleet operations report + CSV export.
- **Config Registry** — standard tag dictionary (§4.4) and rig master.

---

## Ingestion contract

`POST /ingest` accepts the edge sync agent's native payload:

```
Headers: X-Device-Id, X-Schema-Version, Content-Encoding: gzip,
         Authorization: Bearer <device-token>   (optional)
Body (gzipped JSON):
{ "seq": 123, "deviceId": "AHWR-50-3", "schemaVersion": "1.0",
  "createdAt": "<ISO>",
  "channels": [ { "ts": "<ISO>", "values": { "drawworks.hook_load": 96.2, ... } } ],
  "events":   [ { "ts": "<ISO>", "type": "alarm|connection|activity", "payload": {...} } ] }
Response: { "ack": true, "seq": 123, "receivedPoints": N, "receivedEvents": M }
```

Unknown devices auto-register as **pending** rigs so onboarding is visible in the
governance workspace.

---

## Connecting the existing rig-edge app

In the edge stack's `.env` (repo root), set:

```env
CENTRAL_URL=http://<crmf-host>:6000
DEVICE_ID=AHWR-50-3
DEVICE_TOKEN=<token>        # must match the CRMF INGEST_TOKEN, if set
SYNC_ENABLED=true
```

The edge buffers during any WAN/central outage and replays oldest-first on
restoration — central downtime never affects rig operations (proposal §6.3).

---

## Configuration

See `.env.example`. Key variables: `PGPASSWORD`, `JWT_SECRET`, `INGEST_TOKEN`,
`FLEET_SIZE`, `FRONTEND_PORT`, `OFFLINE_SEC`, and `CENTRAL_LATENCY_TARGET`.

## Production notes

- Place `crmf-backend` behind the API gateway / MQTT broker on the ONGC WAN VPN; issue per-rig device certificates/tokens.
- TimescaleDB ships HA (Patroni) + streaming replication to the DR site (proposal §5.3); this compose runs a single node for the pilot.
- Federate Keycloak/ONGC AD for SSO on top of the built-in local accounts (proposal §6.5).


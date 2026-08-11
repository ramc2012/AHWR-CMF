# CRMF logging → Loki (proposal §6.4 / §6.5)

This note describes how CRMF container logs reach Loki and the retention rules for the
**immutable audit log** (proposal §6.5). It is documentation only — no CRMF-specific Loki
config is required here because Loki and the log shipper are installed cluster-wide.

## 1. How logs flow

CRMF follows the **twelve-factor** convention: the backend, frontend (nginx), fleet-sim and
all platform components log as **structured lines to stdout/stderr**. They do *not* write log
files inside the container, which is consistent with `readOnlyRootFilesystem: true`.

```
  crmf-backend / crmf-frontend / fleet-sim  (stdout/stderr, JSON lines)
            │
            ▼   container runtime writes to /var/log/pods/*
  Node-level agent  ──  Promtail  OR  Grafana Alloy  (DaemonSet, one per node)
            │            • discovers pods via the Kubernetes SD API
            │            • attaches labels: namespace, pod, container, node,
            │              app_kubernetes_io_name, app_kubernetes_io_component
            ▼
        Loki (gateway / distributor)  ──►  object storage (S3 / on-prem MinIO)
            │
            ▼
        Grafana  ── "Explore" + log panels, correlated with Prometheus metrics
```

### Which agent
Either works; pick whichever your platform team already runs cluster-wide:
- **Promtail** — the classic Loki shipper. Kubernetes SD + relabel config already ships pod
  labels. No CRMF action needed; CRMF pods are picked up automatically because they run in
  namespace `crmf` with standard `app.kubernetes.io/*` labels.
- **Grafana Alloy** — the newer unified collector (Promtail is in maintenance mode). Use the
  `loki.source.kubernetes` / `discovery.kubernetes` components. Same outcome.

### CRMF-side requirements (already satisfied by the app/platform manifests)
1. Log to **stdout/stderr only** — already true; backend uses a JSON logger, nginx logs to
   stdout/stderr. This is why `readOnlyRootFilesystem` is feasible.
2. Keep the standard labels (`app.kubernetes.io/part-of: crmf`, `name`, `component`) so logs
   are filterable in Grafana, e.g. `{namespace="crmf", app_kubernetes_io_name="crmf-backend"}`.
3. Emit a stable `level` field (info/warn/error) and, for ingest, a `batch_id` / `rig_id` so a
   firing `CRMFHighIngestErrorRate` / `CRMFNoIngest` alert can be pivoted straight to the
   relevant log lines in Grafana Explore.

### Correlating metrics ↔ logs ↔ alerts
In Grafana, the CRMF dashboard (Prometheus) and Loki share the same time range and label set.
A typical investigation: alert fires → open dashboard → "Explore" with
`{namespace="crmf", app_kubernetes_io_name="crmf-backend"} | json | level="error"`.

## 2. Audit log: immutable, separately retained (proposal §6.5)

CRMF is **monitoring-only** — it never writes back to any rig or PLC — so the audit trail is
about *who looked at / changed the monitoring platform*, not control actions. Audit events
(authentications via OIDC/Keycloak, JWT-authenticated `/api` mutations, admin actions,
acknowledgements of ESD/lockout alarms on the top alarm strip) MUST be retained immutably.

Audit logging is **two-tiered**, and the two tiers have different retention:

| Tier | Where | Retention | Append-only control |
|------|-------|-----------|---------------------|
| Operational container logs (all stdout) | Loki | 30 days (default tenant retention) | rolled off / compacted |
| **Audit events** | Postgres/TimescaleDB `audit_log` table (system of record) **and** a dedicated Loki stream `audit` (independent copy) | **≥ 365 days** (per §6.5; tune to your regulatory requirement) | DB trigger + least-privilege role (below) |

### Append-only enforcement in the database (the real control)

The immutability is enforced **at the SQL level in TimescaleDB**, not by Loki WORM. The schema
(`db/init.sql`, mirrored into `timescaledb/01-schema-configmap.yaml`) installs:

- A **`BEFORE UPDATE OR DELETE` trigger on `audit_log`** whose function **`RAISE`s an
  exception**, so any attempt to modify or delete an existing audit row fails — even for the
  table owner. New rows can only be appended (`INSERT`). `TRUNCATE` is separately blocked from
  the application role by the grant model below.
- A **least-privilege application role `crmf_app` (`NOSUPERUSER`)** that holds **`INSERT` on
  `audit_log`** and `SELECT/INSERT/UPDATE/DELETE` on the operational tables only. The schema
  carries a comment that **the application should connect as `crmf_app` in production** rather
  than as the superuser/owner, so a compromise of the API/ingest process cannot bypass the
  trigger via owner privileges or `TRUNCATE`.

> The earlier revision of this note claimed "no UPDATE/DELETE grants for the app role; only
> INSERT" and an S3/MinIO **object-lock / WORM** bucket as the mechanism that makes the audit
> log immutable. **Neither of those is the enforced control today** — the enforced control is
> the trigger + `crmf_app` role above. WORM object storage for the Loki audit chunks remains a
> *defence-in-depth option* (see below) but is not required for, and is not the source of, the
> append-only guarantee.

### Loki side (independent copy, optional WORM hardening)

- The backend also emits each audit event as a structured log line `{stream="audit"}` to
  stdout, so Loki captures an **independent** copy of the trail outside the database.
- In Loki, route the audit stream to a **separate tenant** (`X-Scope-OrgID: audit`) or at
  minimum a distinct stream label, and set a **longer per-tenant retention period** via the
  compactor (`limits_config.retention_period` override) — do **not** apply the 30-day
  operational retention to it.
- **Optional hardening:** back that tenant's object store with **object-lock / WORM** (S3
  Object Lock or MinIO retention). This protects the Loki *copy* from chunk deletion; the
  authoritative append-only guarantee for the trail still comes from the DB trigger + role.

## 3. What this directory does and does not configure

- **Configures (CRMF-specific):** Prometheus alert rules, the Grafana dashboard, and a
  ServiceMonitor for the MQTT broker.
- **Does not configure (cluster-wide, owned by the platform team):** Loki itself, the
  Promtail/Alloy DaemonSet, object-store buckets, and the multi-tenant retention policy.
  Hooking CRMF in requires *no* CRMF-specific shipper config because pods log to stdout with
  standard labels — the cluster agent picks them up automatically. The only platform-team
  action is to create the `audit` tenant with WORM storage and the long retention override
  described above.

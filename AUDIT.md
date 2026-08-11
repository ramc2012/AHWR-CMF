# CRMF — Gap Audit

Multi-dimension audit (backend, security, frontend, data/DB, proposal coverage, K8s/deploy, operability) with adversarial verification against the code and the live stack.

**Severity tally:** 1 critical · 9 high · 14 medium · 7 low — 35 verified gaps total.

> ## Remediation status (2026-06-17)
> **Critical + High + Medium (#1–#30): FIXED & VERIFIED.** Low items (#31–#35) deferred.
> Implemented across backend, DB schema, deploy/K8s, and frontend, then adversarially
> reviewed (5 cross-agent issues found and corrected). Verified on a freshly re-initialised
> stack: fail-closed `/ingest` (401/401/200), append-only `audit_log` trigger (UPDATE/DELETE
> raise), store-and-forward replay dedup (identical batch → no duplicate rows), non-superuser
> `crmf_app` role, 5-year retention policies, `connections` hypertable, real-time CAGG,
> `/livez` no-DB liveness, closed CORS, `/metrics` guard, 404→404, new **Maintenance &
> Reliability** and **User & Access Management** modules (API + schema + UI), period-scoped
> reporting, OpenAPI/`/api/v1`. `helm lint`/`kubeconform` and `node --check` all green.
> Deferred lows: #31 frontend a11y/code-split, #32 lexical-ts compare, #33 metrics-accuracy,
> #34 k8s nginx-resolver/PodMonitor-labels, #35 WITSML/ETP/ML still scaffold-only.

## Executive summary

The CRMF audit surfaced one critical and a cluster of high-severity gaps that would block a production ONGC pilot. The single most serious issue is that the only externally-reachable write path — POST /ingest on port 6000 — ships fail-open: with the default-empty INGEST_TOKEN (present in the live .env, .env.example and docker-compose), any network peer can auto-register fake rigs and inject arbitrary telemetry/alarm events, poisoning the entire monitoring picture with no actor binding. The audit-immutability requirement (proposal §6.5) is asserted in comments and the Loki note but has zero enforcement — and the app connects as a Postgres superuser, so the trail is fully rewritable. Several proposal §6.1 modules are wholly missing (Maintenance & Reliability across data/API/UI; User & Access Management UI/API), the central store has no data-retention or cold-archive policy (TimescaleDB grows unbounded toward a fixed 50Gi PVC), ingest has no replay idempotency despite a store-and-forward contract, and the production K8s layer has two apply-as-shipped breakers (a namespace-wide default-deny NetworkPolicy with no allows for the stateful services, and CNPG backup/DR pointed at an HTTPS MinIO endpoint that serves plain HTTP). Operationally the backend has no graceful-shutdown handler and ties its liveness probe to DB reachability, so any CNPG switchover can trigger a fleet-wide restart storm. After dropping false-positives and merging cross-dimension duplicates (audit immutability, the missing modules, retention, shutdown, and liveness each appeared in 2-4 dimensions), 31 distinct gaps remain. Evidence is code- and live-probe-backed throughout; the MVP is a credible monitoring demo but is not yet production-safe.


## CRITICAL

### #1 · [Security · effort M] Unauthenticated /ingest accepts arbitrary telemetry and auto-registers rigs (fail-open default ships everywhere)

- **Where:** backend/lib/ingest.js:35-39 (authorize returns true when no device_token and empty GLOBAL_INGEST_TOKEN), :20-32 (ensureRig auto-insert), :101 (rigId from attacker-controlled batch.deviceId); .env.example:21, docker-compose.yml:56, live .env (INGEST_TOKEN empty)
- **Impact:** The only WAN-exposed write path is open. Any network peer can auto-enroll fake rigs (live proof: AUDIT-PROBE-RIG-DELETEME persists in /api/config/rigs), inject arbitrary telemetry into the hypertable, and forge alarm/connection events that drive the alarm command centre, health scores and Socket.IO fan-out, with no authenticated identity bound to rigId. Silently poisons the monitoring picture operators rely on.
- **Fix:** Make ingest fail-closed: return 401 when neither INGEST_TOKEN nor a per-rig device_token (or mTLS) is configured, instead of returning true at ingest.js:38-39. Bind an authenticated device identity to rigId rather than trusting batch.deviceId. Remove the empty default from compose/.env.example or gate the open-demo path behind an explicit ALLOW_OPEN_INGEST flag that NODE_ENV=production refuses.


## HIGH

### #2 · [Security · effort M] Audit log labelled 'Immutable' (§6.5) has zero enforcement; app runs as a Postgres superuser and there is no read surface

- **Where:** db/init.sql:193-201 (plain BIGSERIAL, comment only); app role crmf is table owner and rolsuper=t (live DB); deploy .../03-loki-note.md:65-67/82-85 asserts INSERT-only grants + WORM that don't exist; no /api/audit route (server.js:123-184), live GET /api/audit -> 404
- **Impact:** Proposal §6.5 requires an immutable audit trail. There is no append-only enforcement (no REVOKE/trigger/hash-chain/WORM), and because the application role is a DB superuser it can UPDATE/DELETE/TRUNCATE the trail regardless of any grant. Any compromise of the same role serving public /ingest and /api can silently rewrite or erase governance/login history, defeating the trail's evidentiary purpose. The trail is also unreadable from the portal.
- **Fix:** Run the app under a least-privilege non-superuser role; REVOKE UPDATE/DELETE/TRUNCATE on audit_log and insert via a dedicated writer role or SECURITY DEFINER function; add a BEFORE UPDATE/DELETE trigger that raises; optionally hash-chain rows. Back long retention with a real WORM bucket. Expose a read-only admin GET /api/audit + portal view. Correct init.sql:193 and the Loki note to match reality.

### #3 · [Data/DB · effort M] No data-retention or cold-archive policy on telemetry/events — unbounded growth toward a fixed 50Gi PVC (§6.5 unmet)

- **Where:** db/init.sql:67-73 (compression only, no add_retention_policy); deploy/.../timescaledb/01-schema-configmap.yaml mirrors it; 00-cluster.yaml:41-46 (50Gi data/20Gi WAL fixed), :112 (30d = backup retention only); live DB jobs table has zero policy_retention jobs, telemetry ~15M rows
- **Impact:** §6.5 requires 1-5y central retention plus a cold tier. The store has neither a retention policy nor any tiering; compression slows but does not bound growth. A real 50+ rig fleet fills the 50Gi PVC, at which point Postgres stops accepting writes and ingest fails (compounded by the DB-coupled liveness probe). Data-loss/outage risk and an unmanaged cost driver.
- **Fix:** Add add_retention_policy on telemetry (and events, and connections once it is a hypertable) sized to the §6.5 window, keep the 1-minute CAGG for long-range rollups, enable TimescaleDB tiered storage or a chunk-export-to-S3 cold tier, and add a PVC-near-full alert. Keep pgBackRest's 30d backup retention decoupled from data retention.

### #4 · [Data/DB · effort M] Ingest has no replay idempotency on seq — store-and-forward retries silently duplicate every row

- **Where:** backend/lib/ingest.js:54-59 (insertTelemetry INSERT...SELECT unnest, no ON CONFLICT), :80/:86-91 (events/connections plain inserts), last_seq written at :137 but read nowhere; live DB: 0 unique constraints on telemetry/events
- **Impact:** The edge contract is explicitly store-and-forward with a seq; a batch that commits but whose ACK is lost is re-sent. With no unique key on (rig_id, metric, ts) and no seq comparison, each replay inserts a full duplicate set, corrupting every aggregate (telemetry_1m avg/min/max, workover pass/fail counts, alarm counts) and inflating storage. The stored last_seq gives the false appearance of replay protection.
- **Fix:** Reject batches whose seq <= rigs.last_seq inside the ingest transaction (monotonic-seq fast path), and/or add a unique constraint with ON CONFLICT DO NOTHING keyed on (rig_id, metric, ts) for telemetry (must include the ts partitioning column) plus a dedup key for events.

### #5 · [K8s/Deploy · effort M] Platform default-deny NetworkPolicy bricks the data plane — no allow policies for CNPG/Kafka/Keycloak/MinIO

- **Where:** deploy/.../platform/01-network-baseline.yaml:18-21 (podSelector:{} Ingress+Egress deny-all, only DNS re-opened); only Helm networkpolicy.yaml adds allows, covering backend/frontend only — DB/Kafka/Keycloak/MinIO pod ingress is denied with no companion allow
- **Impact:** Applying the platform layer as documented produces a non-functional data plane: even backend->DB is dropped because the Helm policy opens backend egress but nothing allows the DB pod's ingress; CNPG replication/switchover, Kafka KRaft quorum, Keycloak->DB and MinIO peer traffic are all denied. README.md:345-348 claims per-workload allows exist for these, but they do not.
- **Fix:** Ship per-workload allow NetworkPolicies alongside the baseline (CNPG intra-cluster 5432 + backend/keycloak/mlflow ingress; Strimzi inter-broker+client; Keycloak<->DB; MinIO peer+clients; EMQX), or scope the default-deny podSelector to app pods only, or document that stateful pods need their own allows first.

### #6 · [K8s/Deploy · effort S] CNPG backup/DR point at https://minio.ongc.local:9000 but bundled MinIO serves plain HTTP as in-cluster Service 'minio'

- **Where:** deploy/.../timescaledb/00-cluster.yaml:115, 03-dr-replica-cluster.yaml:90,107 (https://minio.ongc.local:9000); minio/00-minio-tenant.yaml:133-137 (no TLS args), Service is ClusterIP 'minio' only, no Ingress/Cert/DNS for minio.ongc.local; MLflow + bucket-init use http://minio:9000 against the same crmf-backups bucket/Secret
- **Impact:** Two real mismatches break barman-cloud against the bundled MinIO: scheme (CNPG dials HTTPS, MinIO serves HTTP -> TLS handshake fails) and host (minio.ongc.local is not an in-cluster name and no Ingress/DNS ships). WAL archiving and the daily ScheduledBackup fail, and the DR replica that bootstraps from this bucket can never sync — defeating the §5.3 DR design.
- **Fix:** Set CNPG endpointURL to http://minio:9000 (matching MLflow/bucket-init), or front MinIO with a real TLS Ingress/Certificate and DNS for minio.ongc.local before using https. Align ansible group_vars all.example.yml:158 (same default).

### #7 · [Proposal-coverage · effort L] Maintenance & Reliability module (§6.1, CAPS-flagged) is entirely absent — no table, API, UI, or nav

- **Where:** db/init.sql (no maintenance_record/pm_schedule — all to_regclass NULL live); server.js (no route, live GET /api/maintenance -> 404); App.jsx (8 routes none maintenance), Layout.jsx:16-24 (7 nav items); only trace is 2 value_metrics rows seed.js:77-78
- **Impact:** A named required §6.1 module (PM compliance, downtime/NPT tracking, calibration, condition-based triggers, MTBF/MTTR) does not exist at any layer. The PM-compliance/HPU-breakdown figures appear only as static KPI numbers inside the Governance value-realization table, not as a data-driven module.
- **Fix:** Add a maintenance_record/pm_schedule entity (rig_id, type=PM/calibration/breakdown, due/performed dates, status, runtime hours, outcome), an ingestion or manual-entry path, GET /api/maintenance, and a Maintenance & Reliability portal page with condition-based trigger flags derived from telemetry. Treat the seed KPIs as placeholders.

### #8 · [Proposal-coverage · effort L] User & Access Management module (§6.1) has no admin UI or user-management API — accounts are seed-only

- **Where:** seed.js:56-69 (3 fixed bcrypt accounts); server.js exposes no /api/users (live GET /api/users -> 404); App.jsx/Layout.jsx have no users page; api.js has no user CRUD; AuthContext can() role-gates but there is no provisioning screen
- **Impact:** §6.1 requires a User & Access Management module. The MVP ships three fixed accounts and JWT RBAC but provides no way to add/disable/re-role users, reset passwords, or view access from the portal. operator123/viewer123 are also not env-overridable, so the demo creds are likely to survive into a pilot with no way to manage them.
- **Fix:** Add an admin-only Users page plus POST/PATCH/DELETE /api/users (admin role, audit-logged), gated behind can('admin'). At minimum document delegation to Keycloak and surface a read-only user/role list in the portal.

### #9 · [Operability · effort S] No SIGTERM/graceful-shutdown handler — HTTP server, timers, pg pool and Kafka producer never closed on termination

- **Where:** backend/server.js:189-221 (two setInterval at :194/:207, server.listen :218, no process.on/server.close/io.close/clearInterval/pool.end anywhere — grep empty); lib/kafka.js:112-117 stop() is dead code; values-prod.yaml:43-46 HPA 3-12, 00-cluster.yaml:38 switchover churn
- **Impact:** On every K8s rolling update, scale-down, or pod delete, Node is hard-killed: in-flight /ingest and /api requests are dropped mid-write, Socket.IO clients severed, the pg pool torn down abruptly, and the Kafka producer never flushed/disconnected. With an HPA scaling 3-12 plus switchover-driven churn this yields avoidable request errors and connection-leak noise on every deploy/scale event. No unhandledRejection/uncaughtException logging either.
- **Fix:** Add SIGTERM/SIGINT handler: stop accepting connections, server.close() with a drain timeout, io.close(), clearInterval both timers, await kafka.stop(), await pool.end(), process.exit(0). Set terminationGracePeriodSeconds to match. Add unhandledRejection/uncaughtException logging.

### #10 · [Operability · effort S] Liveness probe tied to DB-dependent /healthz — a TimescaleDB blip/switchover restarts every backend pod

- **Where:** deploy/helm/crmf/templates/backend-deployment.yaml:50-65 (readiness AND liveness both hit /healthz, liveness failureThreshold 3 period 20s); server.js:112-115 (/healthz does SELECT 1, returns 503 on DB error); 00-cluster.yaml:38 primaryUpdateMethod: switchover
- **Impact:** A liveness probe must answer 'is the process wedged', not depend on an external service. During any transient DB unavailability (CNPG switchover, sync-replica hiccup, network blip) /healthz 503s, liveness fails 3x and the kubelet kills the pod — across all replicas at once, turning a recoverable DB event into a fleet-wide backend restart storm exactly when the DB is already stressed. Undermines §6.5 availability.
- **Fix:** Split probes: keep readiness on /healthz (DB-aware, drains traffic), point liveness at a DB-free endpoint (e.g. /livez returning 200 when the event loop is alive). Optionally raise liveness failureThreshold/period above the switchover window.

### #11 · [Backend · effort S] Untrusted ingest fields (channel ts, batch.seq) crash the whole batch with HTTP 500 + full rollback (data loss + retry storm)

- **Where:** backend/lib/ingest.js:124,131,141 (raw snap.ts into rig_latest INSERT and Date(latestTs).toISOString()); :141 binds batch.seq into BIGINT last_seq; server.js:69 echoes the raw PG error. Live: bad ts and seq:'xx' both -> HTTP 500 with the DB error string leaked
- **Impact:** A single malformed timestamp or non-integer seq from untrusted edge input rejects the entire BEGIN/COMMIT, discarding all telemetry/events already inserted for that batch and returning 500. The edge sync agent retries on non-2xx, so one bad field head-of-line-blocks that rig's backlog indefinitely. The raw Postgres error (column name/type) is leaked to the caller.
- **Fix:** Validate/coerce before binding: tsIso = Number.isFinite(Date.parse(snap.ts)) ? new Date(...).toISOString() : now; seq = Number.isSafeInteger(Number(batch.seq)) ? Number(batch.seq) : null. Skip individual malformed channels rather than failing the batch. Return a generic error to the caller and log full detail server-side.

### #12 · [Frontend · effort S] No global ErrorBoundary — any render-time exception blanks the entire monitoring wall

- **Where:** frontend/src (grep ErrorBoundary/componentDidCatch/getDerivedStateFromError -> empty); main.jsx:9-20 and App.jsx:21-38 render routed pages with no boundary; pages dereference assumed-array payloads (e.g. Governance.jsx:26 g.funnel.map, RigDetail.jsx:43)
- **Impact:** Under React 18 a single render-time throw (malformed/unexpected API payload, recharts on a bad value, a null where an array is assumed) unmounts the whole tree, leaving the operator a blank white screen with no recovery — a hard availability failure for a 24/7 control room.
- **Fix:** Wrap the routed Outlet (and ideally each major panel/card) in an ErrorBoundary that renders a 'panel failed to load — retry' fallback and logs the error, so one bad payload degrades a single card instead of crashing the wall.

### #13 · [Security · effort S] Weak fallback JWT secret and static, non-overridable operator/viewer passwords

- **Where:** backend/lib/auth.js:10 (JWT_SECRET || 'change-me-in-production', HS256); seed.js:59-63 (operator123/viewer123 hardcoded, only ADMIN_PASSWORD env-overridable); no login-specific rate limit/lockout beyond the shared 600/min limiter (server.js:120-121)
- **Impact:** If JWT_SECRET is unset the library silently falls back to a public well-known string, enabling forgery of an admin HS256 token and full RBAC bypass. Compose mitigates this via a :? guard (and the live .env sets a real secret), so the forge path is bounded to non-compose runners (bare node, tests, helm, CI) — but the static, env-unmodifiable operator/viewer creds plus no failed-login throttling make the demo accounts brute-forceable and likely to survive into a pilot.
- **Fix:** Throw on startup if JWT_SECRET is unset or equals the placeholder. Make all seed passwords env-driven and required in non-dev (or force a first-login reset). Add a dedicated stricter rate-limiter on /api/auth/login and log failed attempts.


## MEDIUM

### #14 · [Security · effort S] Sensitive write actions are not audit-logged (failed logins, decision-add, ingest-driven rig/status changes)

- **Where:** server.js:123-129 (only successful logins logged; the auth==null path writes nothing); governance.js:94-99 addDecision has no audit insert unlike its 3 siblings (:65,76,88); ingest.js never audits rig auto-registration or status/alarm overwrites
- **Impact:** Audit coverage is partial. Failed/blocked auth attempts leave no trail (credential-stuffing and forged-token probing are invisible), a §6.1 governance decision mutation is unaudited, and high-impact /ingest mutations (rig creation, live-status overwrite) have no provenance record. §6.5 also enumerates alarm-ack and report-edit auditing, neither of which is implemented. Undercuts forensic value even before the immutability gap.
- **Fix:** Audit failed logins (action='login.failed') and 403 RBAC denials, add the missing audit_log INSERT to addDecision(), and record a provenance entry on rig auto-registration and accepted ingest batches (device identity, rigId, seq). Document ack/report-edit auditing as out-of-scope if the central tier is monitoring-only.

### #15 · [Security · effort S] /metrics exposed unauthenticated — leaks fleet topology and operational telemetry

- **Where:** server.js:98-107 (GET /metrics registered before the /api auth middleware at :135, not under /api); live curl returns 200 with crmf_fleet_rigs{status=...} per-status counts, crmf_fleet_alarms_active, ingest rate/latency — no token
- **Impact:** On the WAN-exposed port, any unauthenticated caller can read CRMF-specific gauges (rig counts by status, active alarms, ingest rate/latency) plus process internals, disclosing operational state of ONGC rigs and aiding reconnaissance. §6.6 expects access control on management surfaces.
- **Fix:** Bind /metrics to localhost / an internal scrape network, require a metrics token, or place it behind the gateway with a NetworkPolicy. In K8s scrape via an internal ServiceMonitor, not the public ingress.

### #16 · [Security · effort S] Permissive CORS — origin reflects any site, and Socket.IO CORS defaults to true

- **Where:** server.js:32 (cors origin: CORS_ORIGIN || true) and :35 (Socket.IO same); CORS_ORIGIN unset in docker-compose.yml:60 and the live .env, so '|| true' echoes any Origin
- **Impact:** With the shipped/live default, CORS is effectively open: origin:true echoes any requesting site's Origin, letting any page script the API/socket if it can obtain a token (e.g. XSS on a partner site or a leaked token). Auth is bearer-token not cookie, so this is not classic CSRF, but it removes a defence-in-depth layer that an internal ONGC tool should keep.
- **Fix:** Default CORS to a closed allowlist (drop '|| true'); require CORS_ORIGIN in non-dev set to the portal origin(s), and apply the same explicit origin to the Socket.IO server.

### #17 · [K8s/Deploy · effort M] CI deploy-staging and Ansible app-install hard-fail (atomic rollback) — crmf-secrets and TimescaleDB are not guaranteed to exist

- **Where:** .gitlab-ci.yml:317-326 (helm --install --atomic --wait, no DB in staging per :17) with values-prod.yaml:63-64 externalSecret.enabled=true so secret.yaml does not render; backend-deployment.yaml:48-49 secretRef crmf-secrets non-optional; ansible 30-crmf-deploy.yml:110-139 installs values-prod while external_secrets_enabled defaults false (group_vars:172)
- **Impact:** With values-prod the chart relies on an out-of-band crmf-secrets (ESO/Vault). In staging nothing provisions it and no DB exists, so backend pods crashloop on the missing Secret; --atomic --wait times out and rolls back — a guaranteed red pipeline. The Ansible path has the same missing-Secret crashloop under atomic:true because external-secrets is disabled while the app expects it.
- **Fix:** Make external-secrets default-on whenever the app deploys with externalSecret.enabled=true (flip the Ansible default or assert it), ensure staging provisions crmf-secrets and the platform DB before the atomic upgrade (or use a staging overlay that renders the Secret), and add an explicit precondition check so the failure is reported clearly rather than via atomic rollback.

### #18 · [K8s/Deploy · effort S] ETP/WITSML ships replicas:1 with a non-existent placeholder image (ImagePullBackOff); MLflow runtime pip-install + missing 'mlflow' DB

- **Where:** standards/01-etp-witsml.yaml:75 replicas:1, :99 image harbor.ongc.local/crmf/crmf-etp-witsml:0.1.0 (placeholder) vs kafka/03-stream-processor.yaml:81 and mqtt/01-mqtt-kafka-bridge.yaml:118 replicas:0 guards; ml/00-mlflow.yaml:91 replicas:1, :122 runtime pip install, :125 backend DB 'mlflow' never created by CNPG bootstrap (only 'crmf')
- **Impact:** The scaffold story is inconsistent: stream-processor and the MQTT bridge are honestly guarded at replicas:0, but ETP/WITSML applies at replicas:1 against an image absent from Harbor -> permanent ImagePullBackOff on platform apply. MLflow likewise runs at replicas:1, pip-installs drivers at container start (defeating readOnlyRootFilesystem) and depends on an 'mlflow' database/role no manifest creates.
- **Fix:** Set ETP/WITSML and MLflow to replicas:0 matching the other scaffolds (or gate behind a flag) until real images/DB exist. For MLflow, add the mlflow DB/role to the CNPG bootstrap and pre-bake Python deps into a Harbor-mirrored image so readOnlyRootFilesystem can be true.

### #19 · [K8s/Deploy · effort S] Kafka TLS listener (:9093) is the documented backend path but the Strimzi cluster CA is never trusted

- **Where:** values.yaml:163-164 (KAFKA_BROKERS ...:9093, KAFKA_SSL=true); kafka/00-kafka.yaml:91-96 (9093 listener tls:true, self-signed cluster CA); backend/lib/kafka.js:32 (ssl is a bare boolean, no KAFKA_SSL_CA/ca: anywhere); backend-deployment.yaml mounts no cluster-CA volume
- **Impact:** When KAFKA_ENABLED=true (the documented path), the backend connects to the Strimzi TLS listener served with a self-signed cluster CA, but kafkajs ssl:true validates against Node's built-in public CA bundle, which lacks the Strimzi CA -> producer connect fails with a self-signed-certificate error. Kafka is off by default so the MVP is unaffected, but the as-documented 'on' configuration is broken.
- **Fix:** Mount crmf-kafka-cluster-ca-cert into the backend and extend kafka.js to read a CA bundle (KAFKA_SSL_CA -> ssl:{ca:[...]}), or use the SCRAM-over-plaintext internal listener (9092) inside the trusted network. Document the requirement by the KAFKA_* block.

### #20 · [Data/DB · effort S] Continuous aggregate telemetry_1m is materialized_only with a 3h refresh window — long-range charts silently lose data after any refresh outage

- **Where:** db/init.sql:76-88 (CAGG, start_offset 3h/end_offset 1m/schedule 1m); live continuous_aggregates.materialized_only=t; fleet.js getHistory:150-154 reads telemetry_1m only for ranges >180min with no raw fallback/union
- **Impact:** Because real-time aggregation is off and the refresh window slides at 3h, if the refresh job is down >3h (DB/backend restart, overnight stop, maintenance) the buckets that age out during the outage are never backfilled. Long-range (>3h) drill-down charts then show silent holes with no error and no raw fallback — a correctness trap that only manifests after an outage.
- **Fix:** Set materialized_only=false so unmaterialized recent buckets fall back to a real-time union over raw data, or widen start_offset beyond any expected refresh outage plus add a boot-time refresh_continuous_aggregate over the retained range.

### #21 · [Data/DB · effort S] 'connections' is a plain non-hypertable table with no retention — unbounded, unpartitioned growth on the hot path

- **Where:** db/init.sql:105-114 (normal BIGSERIAL, never create_hypertable'd; live hypertables list = telemetry, events only); written per connection event ingest.js:86-91; range-scanned by governance.js getWorkover:113
- **Impact:** Torque-turn connection records are continuous time-series during make-up ops, but the table is a flat heap with no time partitioning, compression, or retention. Over a fleet's lifetime it grows unbounded and getWorkover range scans get no chunk exclusion — inconsistent with the telemetry/events hypertable design.
- **Fix:** Make connections a hypertable on ts (PK adjusted to include ts), apply the same compression+retention strategy, and keep the connections_rig_ts index.

### #22 · [Data/DB · effort M] rig_latest JSONB merge keeps stale tags forever under one batch timestamp — frozen sensors look fresh

- **Where:** ingest.js:119-125 (values = rig_latest.values || EXCLUDED.values, keys only added) under a single ts; fleet.js getRig:104-117,127 returns that one latestTs and iterates every merged key with no per-field age; live AHWR-50-1 holds 39 merged keys under one ts; getDataQuality measures only whole-batch lag/completeness
- **Impact:** If a sensor/tag stops reporting, its last value persists indefinitely in rig_latest and is rendered on the drill-down with the freshest batch timestamp, so an operator cannot distinguish a frozen tag from a live one. metric_count (from the latest snapshot) can also disagree with the number of keys rendered. A frozen-but-present tag is invisible to the §6.5 data-quality goal.
- **Fix:** Store a per-field timestamp ({metric:{v,ts}} or a parallel updated_at map), surface per-tag age in getRig, and expire/flag tags not seen within N intervals — or replace rather than merge on a full snapshot.

### #23 · [Backend · effort S] Fleet KPI alarm totals include stale alarms from offline rigs, contradicting the Alarm Command Centre

- **Where:** fleet.js:92-93 (getFleetSummary sums alarm.active/p1 with no status filter); getAlarms:161 filters status!=='offline'; sweepOffline:197 nulls only alarm_highest; liveize:52-56 nulls only alarm.highest for offline rigs; ingest.js:145-152 writes alarm columns only on an alarm event (sticky)
- **Impact:** Alarm counts are sticky and neither sweepOffline nor liveize zeroes them for offline rigs, while getFleetSummary sums across all statuses. A rig that goes offline mid-alarm keeps inflating the dashboard alarmsActive/alarmsP1 KPI cards indefinitely yet is excluded from the Alarm Command Centre list — the two surfaces disagree and the headline count drifts upward as rigs drop offline with open alarms.
- **Fix:** Make getFleetSummary exclude offline (and ideally pending) rigs from the alarm sums to match getAlarms, and/or have sweepOffline zero the alarm_* counters when flipping a rig offline.

### #24 · [Backend · effort S] GET /api/rigs/:id for an unknown rig returns HTTP 500 instead of 404

- **Where:** server.js:145 throws Object.assign(new Error('rig not found'), {status:404}) but the shared wrap helper (server.js:137-139) catches with res.status(500) and never reads e.status; live GET /api/rigs/NONEXISTENT -> 500
- **Impact:** Every not-found is reported as a server error, corrupting client error handling and inflating uptime/alert metrics with false 5xx. Wrong HTTP semantic across all wrapped routes.
- **Fix:** In wrap: catch (e) { res.status(e.status || 500).json({ error: e.message }); }.

### #25 · [Frontend · effort M] All non-401 data-fetch errors are silently swallowed — failed loads show a permanently empty/stale view with no indication

- **Where:** Empty catches in DataQuality.jsx:14, WorkoverPerformance.jsx:15, Reports.jsx:13, ConfigRegistry.jsx:14-15, AlarmCommandCentre.jsx:17, Governance.jsx:22, FleetContext.jsx:23; RigDetail.jsx:23 is the only view that surfaces the error (setErr -> Alert :47)
- **Impact:** Every list/dashboard view except RigDetail discards non-401 API errors with an empty catch, so a 500/timeout leaves the table empty or stale with no message, no retry, and no way to distinguish 'no alarms' from 'alarms API down'. A robustness/operator-trust gap on a monitoring tool.
- **Fix:** Track a per-view error state and render an Alert on non-401 failures (reuse the RigDetail pattern), plus a loading indicator distinct from the genuinely-empty case.

### #26 · [Operability · effort S] No alert for the degraded/stale rig condition — the §6.1 data-quality failure mode is metric-only

- **Where:** live /metrics: crmf_fleet_rigs{status="degraded"}=2, {status="stale"}=1 (derived fleet.js:20-25); observability/00-prometheusrule.yaml defines only 6 alerts and never references degraded/stale in an expr
- **Impact:** A degraded/stale rig is connected and ingesting but its data quality/completeness has fallen below threshold — exactly what the §6.1 Data Quality Monitor exists to surface. Only the binary offline case and aggregate ingest-error rate are alerted, so a fleet silently producing low-completeness data (sensor dropouts, partial tag sets) pages no one despite the metric already existing.
- **Fix:** Add a PrometheusRule alerting when sum(crmf_fleet_rigs{status=~"degraded|stale"})/clamp_min(sum(crmf_fleet_rigs{status!="pending"}),1) exceeds a threshold for N minutes, and/or a per-rig data-quality gauge for targeted alerting.

### #27 · [Operability · effort S] Alert coverage gaps: no cert-expiry, no PVC/disk-full, no backup/WAL-archive-stall alert

- **Where:** observability/00-prometheusrule.yaml (only 6 app/fleet/DB alerts; grep cert/expir/disk/pvc/backup/wal -> only annotation prose); TLS is cert-manager-issued (ingress/00-cert-manager-issuer.yaml), CNPG archives to MinIO (00-cluster.yaml:107-129, 02-backup.yaml) — both silent-failure-prone
- **Impact:** Three high-value failure modes are unmonitored: TLS cert expiry (failed ACME renewal silently dark-fails the portal and /ingest); PVC/disk pressure (tied to the missing retention policy — a filling volume halts the DB); and backup/WAL-archive health (a stalled barman-cloud archive silently makes the documented PITR/DR window unrecoverable). The DR runbook assumes backups are flowing but nothing alerts when they aren't.
- **Fix:** Add alerts for certmanager_certificate_expiration_timestamp_seconds nearing expiry, kubelet_volume_stats_available_bytes/capacity below threshold for the DB PVCs, and CNPG backup/WAL health (cnpg_collector_last_failed_backup_timestamp / WAL archiving failure).

### #28 · [Operability · effort M] No backup restore-test / verification — only forward backup + DR-promotion runbooks exist

- **Where:** deploy/.../timescaledb/README.md §5/§6 (PITR + DR promotion) and 02-backup.yaml (daily 02:30 base backup); grep restore-test/verify-restore across deploy/ -> none; README warns the timescaledb extension must be present or restore fails
- **Impact:** Backups that are never test-restored are false comfort: a corrupt object store, an image/extension mismatch (the README warns of exactly this), or a broken WAL chain is discovered only during a real disaster. The repo can take backups and describes DR promotion but provides no mechanism or runbook to regularly confirm a backup restores cleanly.
- **Fix:** Add a periodic restore-verification job: bootstrap a throwaway CNPG cluster from the latest backup to a recent targetTime, run sanity checks (extensions present, hypertable row counts, latest ts within RPO), report success to Prometheus, tear down. Add a restore-test runbook section and an alert if verification hasn't succeeded within its window.

### #29 · [Proposal-coverage · effort M] Reporting module lacks daily/weekly/monthly periods (§6.1) — only a single live snapshot

- **Where:** governance.js:135-143 getFleetReport returns one current-state row per rig (no time window); server.js:171-184 /api/reports/fleet[.csv] expose only that snapshot; live ?period=daily ignored (200, same shape), /api/reports/daily -> 404; Reports.jsx:45 has no period selector
- **Impact:** §6.1 reporting calls for daily/weekly/monthly consolidated (DWR) reports. The implementation produces only a real-time fleet snapshot with CSV export — no time-windowed, historical, or scheduled report and no period selection.
- **Fix:** Add period-scoped report generation (daily/weekly/monthly) backed by telemetry/events history and the continuous aggregates, with date-range selection and scheduled/stored report artifacts (the deploy layer already provisions a crmf-reports MinIO bucket).

### #30 · [Proposal-coverage · effort M] Integration API is neither documented nor versioned (§6.1)

- **Where:** no OpenAPI/Swagger anywhere (grep across README.md + backend/ empty); routes unversioned (all /api/..., no /v1; server.js:123-184); README documents only the inbound /ingest contract
- **Impact:** §6.1 requires an Integration API. The REST surface works but is undocumented (no machine-readable contract) and unversioned, so external integrators have no stable, discoverable contract; only inbound ingestion is documented.
- **Fix:** Publish an OpenAPI/Swagger document for /api, introduce a version prefix (/api/v1) before external consumers integrate, and document auth, pagination, and rate limits in the README.


## LOW

### #31 · [Frontend · effort M] Frontend robustness/UX lows: no a11y affordances, no code-splitting, missing empty-states, stale-user flash, unhandled socket connect_error, live-merge race

- **Where:** grep aria-/role/alt -> empty (FleetMap.jsx:32-46 mouse-only SVG, AlarmStrip Layout.jsx:76-87 clickable div); no lazy/Suspense/manualChunks (App.jsx:5-13, vite.config.js — recharts loads up-front); DataQuality.jsx:46-70 & ConfigRegistry.jsx:36-82 lack empty-state rows; AuthContext.jsx:8-10 never revalidates the cached user (api.me unused); socket.js/FleetContext.jsx have no connect_error handler; FleetContext.jsx:22-29 refresh() not awaited before the live listener attaches
- **Impact:** Cluster of polish/robustness gaps for a government control-room deployment: zero ARIA/keyboard semantics on the clickable map and alarm strip (likely accessibility-compliance gap); a monolithic unsplit JS bundle hurts first paint on low-bandwidth remote sites; headed-but-empty tables look broken on error/initial load; an expired cached user briefly flashes the protected console before the 401 bounce; a rejected websocket handshake shows only a permanent 'Reconnecting…' dot with the live fleet silently frozen; and an initial REST snapshot can momentarily clobber a newer live delta (self-healing at 1 Hz). None is a security hole; all are individually low.
- **Fix:** Add ARIA/role/tabIndex/onKeyDown to the map nodes and alarm strip and accessible names to charts; React.lazy + Suspense the routes and add Vite manualChunks (split mui/recharts/socket.io); add colSpan empty-state rows to DataQuality/ConfigRegistry matching the other tables; call api.me() on mount to validate the cached token; add a connect_error handler that distinguishes auth failure from transient network and surfaces a 'live link lost' banner; and have refresh() merge into rather than replace byId.current (or await it before attaching the listener).

### #32 · [Data/DB · effort S] Lexical (string) timestamp comparison in latestSnapshot mis-selects the newest channel under mixed/non-ISO offsets

- **Where:** backend/lib/ingest.js:69 ((snap.ts||'') >= (best.ts||''), string comparison); edge ts accepted as opaque strings (:46,:124); Node repro: '100' >= '99' is false, and '+05:30' vs 'Z' forms mis-order
- **Impact:** The 'latest snapshot wins' decision compares ts as strings, correct only for fixed-width UTC ISO-8601. An edge emitting epoch-ms numbers, unpadded strings, or IST-offset timestamps (plausible for an India deployment) would mis-order snapshots, feeding the wrong values into rig_latest and health/sync-lag scoring. Latent — the current sim sends uniform UTC; the timestamptz storage column is unaffected.
- **Fix:** Compare by Date.parse(snap.ts) numerically with a NaN fallback (mirroring the ingest-crash fix), and normalize/validate incoming ts to a canonical instant on ingest rather than falling back to now().

### #33 · [Operability · effort M] Observability accuracy lows: ingest_batches_total counts rejects, dashboard 'Rigs reporting'/offline-ratio include pending rigs, plaintext logs break the documented JSON/Loki pivot

- **Where:** metrics.js:65 (ingestBatches.inc unconditional, help text says 'accepted'; server.js:56,59 use observeIngest not incIngestError on bad-gzip/bad-json); 01-grafana-dashboard.yaml:124/324 + prometheusrule offline-ratio use sum(crmf_fleet_rigs) incl. pending (live pending=29/56); no pino/winston in package.json, all console.* plaintext vs 03-loki-note.md:10,36-43 which promises `| json | level=` LogQL with batch_id/rig_id
- **Impact:** Three observability-accuracy gaps: any success-rate built on crmf_ingest_batches_total is wrong (rejected batches inflate both the counter and the duration histogram); the 'Rigs reporting' KPI shows ~56 when only ~27 actually report and the offline-ratio denominator is diluted by never-commissioned pending rigs, making a real regional outage look smaller; and the backend emits free-form plaintext, so the documented Loki alert->Explore `| json | level="error"` pivot with rig/batch correlation simply does not work. All degrade triage/observability, none is an outage.
- **Fix:** Increment ingestBatches only inside the if(ok) branch (or add a separate accepted counter) and use incIngestError() for early bad-gzip/bad-json rejections; switch the dashboard/rule to sum(crmf_fleet_rigs{status!="pending"}); adopt pino with level/rig_id/batch_id/seq fields (or correct the Loki note and LogQL to the actual plaintext format).

### #34 · [K8s/Deploy · effort M] K8s deploy lows: frontend nginx hardcodes Docker DNS resolver, operator PodMonitors rely on a NilUsesHelmValues escape hatch, Keycloak egress selects a version-dependent label, Redis (§6.4) substituted by Postgres with no manifest

- **Where:** frontend/nginx.conf:9 (resolver 127.0.0.11 + /api,/socket.io proxy — dead in k8s, Ingress diverts those paths); CNPG/pooler/keycloak-db PodMonitors carry no release label and base values ServiceMonitor labels {} (scraped only via *SelectorNilUsesHelmValues=false or values-prod); helm networkpolicy.yaml:151-157 egress selects app: keycloak but the CR is labeled app.kubernetes.io/name: crmf-keycloak; rig_latest replaces the §6.4 Redis last-value cache with no Redis manifest anywhere (README.md:102 'Not deployed')
- **Impact:** Latent/brittle deploy issues, none a hard break as shipped: the Docker-only nginx config would 502 only if an /api request ever landed on the frontend pod (the Ingress normally diverts it); the unlabeled PodMonitors aren't scraped under a default kube-prometheus-stack install (the cnpg replication-lag alert would be data-less) unless the Ansible escape hatch or values-prod is used; the Keycloak egress fast-path may silently not match (OIDC still works via the ingress 443 path); and §6.4 Redis is a deliberate, documented Postgres substitution with no production Redis path for scale beyond FLEET_SIZE=50.
- **Fix:** Use a cluster-DNS resolver or drop the /api,/socket.io proxy blocks from the production frontend image; standardize on *SelectorNilUsesHelmValues=false (document as required) or add a templated release label to every PodMonitor; select Keycloak by app.kubernetes.io/name: crmf-keycloak (or a value); and document the Postgres-as-last-value §6.4 deviation, optionally adding a feature-flagged Redis cache path for the production profile.

### #35 · [Proposal-coverage · effort L] Standards/ML interop surfaces (WITSML 1.4.1 + ETP 2.0, predictive analytics) are scaffold-only

- **Where:** deploy/README.md:98,104 (ETP/WITSML and KServe 'Scaffolded'); standards/00-etp-witsml-note.md (placeholder image, deployment contract only; live GET /witsml/store -> 404); ml/01-kserve-note.md 'Phase 2 — SCAFFOLDED', no inference code in backend (grep empty), live /api/ml/predictions -> 404; ml/00-mlflow.yaml is a real tracking server with no models registered
- **Impact:** §6.1/§6.3 reference standards-based interoperability (WITSML SOAP store, ETP 2.0 WebSocket) and predictive analytics (HPU condition, hookload anomaly, NPT classifier). These exist only as Kubernetes deployment contracts pointing at a placeholder image and Phase-2 design notes with example InferenceService YAML — no functional server, trained model, backend integration, or portal surface. The deploy layer is honest about the scaffold status.
- **Fix:** Either build and ship the crmf-etp-witsml read-only server image and wire backend inference calls + advisory dashboard flags, or clearly down-scope WITSML/ETP and predictive analytics to a future phase in the proposal mapping; today they are contract/notes only.

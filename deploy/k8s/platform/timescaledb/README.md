# CRMF TimescaleDB — HA + Disaster Recovery (CloudNativePG)

This directory provisions the **central** time-series database for the
Centralised Rig Monitoring Facility (CRMF) as a highly-available,
PITR-backed PostgreSQL 16 + TimescaleDB cluster managed by the
**CloudNativePG (CNPG)** operator, plus a cross-DC disaster-recovery
standby (proposal §5.3).

> **Monitoring-only.** This database only ever *receives* telemetry and
> events from rig-edge agents. Nothing here is ever written back to a
> rig or PLC.

## Files (apply in order)

| File | Kind | Purpose |
|------|------|---------|
| `00-cluster.yaml` | `Cluster` | Primary-site HA cluster `crmf-timescaledb`: 3 instances (1 primary + 2 replicas, 1 synchronous), 50Gi data + WAL storage, WAL+base-backup to MinIO/S3, PodMonitor. |
| `01-schema-configmap.yaml` | `ConfigMap` | `crmf-schema` — the canonical CRMF DDL, applied at bootstrap. Faithful copy of `repo/central/db/init.sql`. |
| `02-backup.yaml` | `ScheduledBackup` | Daily 02:30 base backup → object store. |
| `03-dr-replica-cluster.yaml` | `Cluster` (replica mode) | DR standby `crmf-timescaledb-dr` at the **second ONGC data centre**; bootstraps + streams from the primary's object store. |
| `04-pooler.yaml` | `Pooler` | Optional PgBouncer (rw) `crmf-timescaledb-pooler-rw`. |
| `05-restore-test.yaml` | `CronJob` (+ SA/Role/RoleBinding/ConfigMap) | Weekly **backup restore-verification**: bootstraps a throwaway cluster from the latest backup, runs sanity checks, pushes a success gauge, then tears it down. See §8. |

### Services produced by CNPG
- `crmf-timescaledb-rw` — primary (read-write). **This is the host the backend wires to (`PGHOST`).**
- `crmf-timescaledb-ro` — replicas (read-only, load-balanced).
- `crmf-timescaledb-r` — any instance (read).
- `crmf-timescaledb-pooler-rw` — PgBouncer rw (if `04` applied).

---

## 1. Install the CloudNativePG operator

```bash
# Pin to a known-good release; mirror the image into Harbor for air-gapped sites.
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml

# Wait for the operator to be ready
kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager
```

The operator also installs the CRDs used here (`Cluster`, `ScheduledBackup`,
`Pooler`, `Backup`). The `monitoring.enablePodMonitor: true` settings require
the **Prometheus Operator** CRDs (`monitoring.coreos.com/v1 PodMonitor`) to be
present in the cluster; if you do not run Prometheus Operator, set those to
`false` before applying.

---

## 2. Prerequisite secrets (create before applying `00`)

CNPG can auto-generate app/superuser credentials, but for CRMF we pin them so
the backend `Secret` (`crmf-secrets.PGPASSWORD`) and the DB stay in lockstep.
Create these in namespace `crmf`:

```bash
# DB OWNER role "crmf" — bootstraps and OWNS the schema (NOT the backend's login user)
kubectl -n crmf create secret generic crmf-db-app \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=crmf \
  --from-literal=password='REPLACE_WITH_OWNER_PASSWORD'

# Least-privilege APP role "crmf_app" — the role the BACKEND connects as (audit #2;
# Helm config.PGUSER=crmf_app). It CANNOT tamper with the append-only audit_log. CNPG
# managed.roles (00-cluster.yaml) sets crmf_app's login password from THIS Secret, which
# MUST equal crmf-secrets.PGPASSWORD or the backend crash-loops on auth. In a full Vault
# deploy this is materialised automatically by the crmf-db-app-login ExternalSecret
# (vault/01-secretstore.yaml) from the SAME Vault key as PGPASSWORD — create it by hand
# ONLY when not using ESO/Vault.
kubectl -n crmf create secret generic crmf-db-app-login \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=crmf_app \
  --from-literal=password='REPLACE_WITH_SAME_VALUE_AS_crmf-secrets.PGPASSWORD'

# Superuser (postgres) — needed so CREATE EXTENSION timescaledb succeeds at init
kubectl -n crmf create secret generic crmf-db-superuser \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=postgres \
  --from-literal=password='REPLACE_WITH_SUPERUSER_PASSWORD'

# MinIO / S3 credentials for Barman object-store backups (PITR)
kubectl -n crmf create secret generic crmf-backup-s3 \
  --from-literal=ACCESS_KEY_ID='REPLACE_WITH_S3_ACCESS_KEY' \
  --from-literal=SECRET_ACCESS_KEY='REPLACE_WITH_S3_SECRET_KEY'
```

> The BACKEND connects as the least-privilege role **crmf_app** (audit #2), NOT the owner.
> Keep `crmf-db-app-login.password` identical to `crmf-secrets.PGPASSWORD` — that is the
> credential the backend actually uses. `crmf-db-app` is only the schema OWNER/bootstrap
> role (`crmf`); `crmf-db-superuser` is `postgres` (extension creation).

Provision the bucket in MinIO before first backup:
```bash
mc mb ongc-minio/crmf-backups
```

---

## 3. Apply the primary site

```bash
NS=crmf
kubectl -n $NS apply -f 01-schema-configmap.yaml   # schema FIRST (referenced by bootstrap)
kubectl -n $NS apply -f 00-cluster.yaml
kubectl -n $NS apply -f 02-backup.yaml
kubectl -n $NS apply -f 04-pooler.yaml             # optional

# Watch cluster come up (Cluster in Healthy state, 3/3 instances)
kubectl -n $NS get cluster crmf-timescaledb -w
cnpg status crmf-timescaledb -n $NS                # kubectl-cnpg plugin
```

---

## 4. TimescaleDB image caveat (IMPORTANT)

Stock CloudNativePG / `ghcr.io/cloudnative-pg/postgresql` images **do not
ship the TimescaleDB extension**. The schema (`CREATE EXTENSION timescaledb`,
hypertables, compression policies, continuous aggregates) will fail on them.

This layer therefore uses a TimescaleDB-enabled PostgreSQL 16 image:

```
ghcr.io/imusmanmalik/timescaledb-postgis:16
```

and sets:

```yaml
postgresql:
  shared_preload_libraries: ["timescaledb"]
```

`shared_preload_libraries` **must** include `timescaledb` or the extension
will not load even if installed.

Notes / alternatives:
- For production, **mirror the image into Harbor** (`harbor.ongc.local/crmf/
  timescaledb-postgis:16`) and update `imageName` in `00-` and `03-`. An
  air-gapped ONGC cluster cannot pull from ghcr.io.
- Any PostgreSQL 16 image that bundles `timescaledb` works; the primary and DR
  clusters **must use the same image** for WAL compatibility.
- If you later build an in-house image, base it on the CNPG `postgresql`
  image + the matching TimescaleDB apt packages so CNPG's instance-manager
  entrypoint is preserved.

---

## 5. High availability & failover

- **Topology:** 1 primary + 2 streaming replicas, with **1 synchronous**
  standby (`maxSyncReplicas: 1`) so an acknowledged ingest write survives a
  single-node loss. Instances use pod anti-affinity to spread across nodes.
- **Automatic failover:** CNPG watches the primary; on failure it promotes the
  most-aligned replica and repoints the `-rw` Service. The backend only ever
  talks to `crmf-timescaledb-rw`, so failover is transparent (connections drop
  and reconnect). With the pooler, clients reconnect to the new primary via the
  pooler's `-rw` endpoint.
- **Switchover (planned, e.g. node maintenance):**
  ```bash
  cnpg promote crmf-timescaledb <target-instance-name> -n crmf
  ```
- **Rolling updates:** `primaryUpdateStrategy: unsupervised` +
  `primaryUpdateMethod: switchover` upgrades replicas first, then switches over,
  minimising primary downtime.

### Point-in-time recovery (PITR), same DC
Restore into a brand-new cluster from the object store to any timestamp in the
retention window:

```yaml
spec:
  bootstrap:
    recovery:
      source: clusterBackup
      recoveryTarget:
        targetTime: "2026-06-16 09:30:00+00"
  externalClusters:
    - name: clusterBackup
      barmanObjectStore:
        serverName: crmf-timescaledb
        destinationPath: s3://crmf-backups/crmf-timescaledb
        endpointURL: http://minio:9000   # in-cluster MinIO Service serves plain HTTP (#6)
        s3Credentials: { accessKeyId: {name: crmf-backup-s3, key: ACCESS_KEY_ID},
                         secretAccessKey: {name: crmf-backup-s3, key: SECRET_ACCESS_KEY} }
```

---

## 6. Disaster-recovery promotion runbook (second ONGC data centre)

`03-dr-replica-cluster.yaml` (`crmf-timescaledb-dr`) runs at the **second ONGC
data centre** as a continuously-replaying, **read-only** standby fed from the
primary's MinIO/S3 bucket. RPO is bounded by WAL archive cadence; RTO is the
time to promote + repoint the app.

**Steady state (primary healthy):**
- DR cluster is in replica mode, no writable primary, lag visible via
  `cnpg status crmf-timescaledb-dr -n crmf`.
- DR site MinIO should replicate (or share) the `crmf-backups` bucket so WAL is
  reachable from the DR DC.

**Promote DR to primary (primary site lost):**
1. **Confirm the primary site is truly down** and will not come back and
   double-write (split-brain guard). Stop primary-site ingest/Ingress if it may
   recover.
2. **Promote** by disabling replica mode on the DR cluster:
   ```bash
   kubectl -n crmf patch cluster crmf-timescaledb-dr --type merge \
     -p '{"spec":{"replica":{"enabled":false}}}'
   kubectl -n crmf get cluster crmf-timescaledb-dr -w   # wait for Healthy primary
   ```
   CNPG activates a primary in the DR cluster; `crmf-timescaledb-dr-rw` becomes
   read-write.
3. **Repoint the backend** to the DR primary: set `PGHOST=crmf-timescaledb-dr-rw`
   in ConfigMap `crmf-config` (or update DNS/Service alias) and restart the
   backend Deployment.
4. **Re-establish backups** — the DR cluster already archives to
   `s3://crmf-backups/crmf-timescaledb-dr`; confirm a base backup runs.

**Fail back to the primary site (after recovery):**
1. Rebuild the original primary as a fresh **replica** cluster bootstrapping
   from the DR cluster's object store (`...-dr` path) — same pattern as `03`,
   sourcing the DR bucket.
2. Let it catch up, then schedule a controlled switchover back during a
   maintenance window and repoint `PGHOST` to `crmf-timescaledb-rw`.

> Because CRMF is monitoring-only and rig-edge agents use **store-and-forward**
> (`POST /ingest`), edges buffer telemetry while central is failing over and
> backfill on reconnect — so a DR promotion loses little to no rig data beyond
> the WAL-archive RPO window.

---

## 7. Verifying the schema / TimescaleDB

```bash
kubectl -n crmf exec -it crmf-timescaledb-1 -- psql -U postgres -d crmf -c "\dx"
# expect: timescaledb, pgcrypto

kubectl -n crmf exec -it crmf-timescaledb-1 -- psql -U postgres -d crmf \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# expect: telemetry, events
```

---

## 8. Backup restore-verification (`05-restore-test.yaml`)

Backups that are never test-restored are **false comfort** — a corrupt object store, an
image/extension mismatch (see §4), or a broken WAL chain is only discovered during a real
disaster. `05-restore-test.yaml` runs a **weekly** `CronJob` (Sun 03:30) that proves the
backups are actually restorable:

1. **Creates a throwaway cluster** `crmf-timescaledb-restoretest` (1 instance) that
   bootstraps via CNPG `recovery` from the **latest** base backup + WAL in
   `s3://crmf-backups/crmf-timescaledb` (the same bucket the primary archives into). It uses
   the same TimescaleDB image so WAL replay and the extension are binary-compatible.
2. **Waits** for the cluster to reach a healthy primary.
3. **Runs sanity checks** against the restored DB:
   - the `timescaledb` extension is present,
   - the expected hypertables (`telemetry`, `events`) exist,
   - `telemetry` has rows, and the latest `ts` lag is reported (warned if older than
     `RPO_MAX_SECONDS`, default 2h).
4. **Pushes** `crmf_restore_test_success` (1/0) and `crmf_restore_test_timestamp_seconds`
   to the Prometheus **Pushgateway** (best-effort; override `PUSHGATEWAY_URL`).
5. **Deletes** the throwaway cluster (always, via an EXIT trap).

The verifier runs as the least-privilege ServiceAccount `crmf-restore-test`, whose Role can
only create/get/delete CNPG `Cluster`s and read/exec the pods it needs — it cannot touch the
production clusters' data. A failed check exits non-zero (the Job goes `Failed`); the
`CRMFRestoreTestStale` alert (`observability/00-prometheusrule.yaml`) fires when no
verification has succeeded in >8 days or the last run failed.

```bash
# Run an on-demand verification immediately (don't wait for the weekly schedule):
kubectl -n crmf create job --from=cronjob/crmf-timescaledb-restore-test restore-test-now
kubectl -n crmf logs -f job/restore-test-now
# The throwaway cluster is named crmf-timescaledb-restoretest and is auto-deleted at the end.
```

> Prerequisites: the `crmf-backup-s3` and `crmf-db-superuser` Secrets from §2 must exist, and
> at least one successful base backup must be present in the bucket.

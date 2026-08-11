# CRMF — Production Kubernetes Deployment (RKE2)

Authoritative deployment guide for the **Centralised Rig Monitoring Facility
(CRMF)** — the central tier of the ONGC AHWR Digital Twin (proposal **§6.4**).
This directory deploys the CRMF monitoring platform to a production **RKE2**
cluster: the application (Node/Express/Socket.IO backend + React/nginx
frontend) plus the surrounding data, messaging, identity, observability and
secrets plane.

> **Monitoring-only platform — project-wide invariant.**
> CRMF only ever *receives* telemetry and events from rig-edge agents. **Nothing
> in this deployment writes back to any rig or PLC.** ESD/lockout signals are
> read-only alarms; ML inference and the ETP/WITSML server are read/advisory
> only; the AD federation is `READ_ONLY`. Every NetworkPolicy and ACL here is
> shaped so no egress path back toward the field exists.

---

## 1. Architecture (production platform on RKE2)

```
                          rig-edge agents (store-and-forward)
                  HTTPS POST /ingest (gzip batches)   │   MQTT-TLS publish (CN=rigId)
                                       │              │
                                       ▼              ▼
        ┌──────────────────────────────────────────────────────────────────────────┐
        │  RKE2 cluster  (Cilium CNI · PSA=restricted · default-deny NetworkPolicy)  │
        │                                                                            │
        │   ingress-nginx  ──TLS (cert-manager: letsencrypt-or-ongc-ca)──────────┐   │
        │   host crmf.ongc.local                                                 │   │
        │     /ingest      ─▶ Service crmf-backend  :6000 (rig store-and-forward) │   │
        │     /api         ─▶ Service crmf-backend  :6000 (REST, JWT)             │   │
        │     /socket.io   ─▶ Service crmf-backend  :6000 (websocket live)        │   │
        │     /            ─▶ Service crmf-frontend :80   (React SPA, nginx)      │   │
        │                                  │  (proxy-body-size 64m, RT/ST 3600s)  │   │
        │   ┌──────────────────────────────┼───────────────────────────────────┐ │   │
        │   ▼                              ▼                ▼                    ▼ │   │
        │ crmf-backend (Deploy, HPA 3-12) │          crmf-frontend (Deploy)      │   │
        │   envFrom crmf-config+crmf-secrets                                      │   │
        │   │ PG (always)     │ Kafka (opt) │ OIDC (opt)                          │   │
        │   ▼                 ▼             ▼                                     │   │
        │ ┌───────────────┐  ┌───────────┐ ┌──────────────┐  ┌──────────────────┐│   │
        │ │ TimescaleDB   │  │  Kafka    │ │  Keycloak    │  │  EMQX MQTT broker ││   │
        │ │ (CloudNativePG)│ │ (Strimzi) │ │ (Operator)   │  │  :8883 mqtts      ││   │
        │ │ crmf-timescaledb│ │crmf-kafka │ │ crmf-keycloak│  │  per-rig cert id  ││   │
        │ │ 3 inst (1 sync) │ │ 3 brokers │ │ 2 inst  ──┐  │  └────────┬─────────┘│   │
        │ │ -rw / -ro / -r  │ │ KRaft     │ │           │  │           │ bridge    │   │
        │ │     │ barman     │ │ topics:   │ │  crmf-     │  │           ▼ (Option  │   │
        │ │     ▼ WAL+base   │ │ telemetry.│ │  keycloak- │  │     telemetry.ingest │   │
        │ └─────┼────────────┘ │ ingest /  │ │  db (CNPG) │  │     events.*         │   │
        │       │              │ events.*  │ │  2 inst    │  │                      │   │
        │       │              │ derived.  │ └─────┬──────┘  │  crmf-stream         │   │
        │       │              │ channels  │       │ LDAPS    │  (Kafka Streams,     │   │
        │       │              └─────┬─────┘       ▼ READ_ONLY│   SCAFFOLD repl=0)   │   │
        │       │                    │       ONGC Active Dir  │       │ derived      │   │
        │       ▼                    ▼       (ad.ongc.local)  │       ▼              │   │
        │   ┌────────────────────────────────────────────────────────────────────┐ │   │
        │   │ MinIO (S3)  buckets: crmf-reports · crmf-backups · crmf-mlflow      │ │   │
        │   └───────┬──────────────────────────────┬─────────────────────────────┘ │   │
        │           ▼                              ▼                                │   │
        │   MLflow (Phase 1)              ETP 2.0 + WITSML 1.4.1 (read-only)        │   │
        │   KServe (Phase 2 note)         host etp.ongc.local                       │   │
        │                                                                            │   │
        │   Secrets:   Vault ──(External Secrets Operator)──▶ crmf-secrets           │   │
        │   Observ.:   kube-prometheus-stack ◀─ ServiceMonitor/PodMonitor/PrometheusRule│
        │              Grafana dashboard "CRMF — Fleet & Ingest" · Loki (logs)       │   │
        └──────────────────────────────────────────────────────────────────────────┘
                                       │  CNPG barman WAL/base to s3://crmf-backups
                                       ▼
        ┌──────────────────────────────────────────────────────────────────────────┐
        │  SECOND ONGC DATA CENTRE (DR site)                                         │
        │   crmf-timescaledb-dr  (CNPG replica mode, 2 inst, read-only until promoted)│
        └──────────────────────────────────────────────────────────────────────────┘
```

Everything runs in the single namespace **`crmf`** (PodSecurity `restricted`).
Operators run cluster-wide in their own namespaces.

---

## 2. Proposal §6.4 component → artifact → status

Status legend: **Implemented** = real, apply-ready CR/manifest/code in this repo that runs the
component · **Scaffolded** = manifest/contract present but guarded (e.g. `replicas: 0`, placeholder
image, or a `.md` design note) pending app code/Phase 2 · **Via upstream operator** = this repo
ships the *consuming CR*; the controller itself is installed from an upstream chart/manifest.

| §6.4 component | Artifact(s) in this repo | Status |
|---|---|---|
| **Kubernetes / RKE2** | `ansible/playbooks/10-rke2-bootstrap.yml`, `ansible/group_vars/all.example.yml` (`rke2_version v1.30.4+rke2r1`, Cilium CNI, bundled ingress disabled) | Implemented (IaC) |
| **NGINX Ingress** | `helm/crmf/templates/ingress.yaml` (class `nginx`, path routing, proxy-body-size 64m, RT/ST 3600s, websocket upgrade); installed by `ansible/playbooks/20-operators.yml` | Implemented + Via upstream operator |
| **GitLab CE + Harbor registry** | `../.gitlab-ci.yml` (lint → build → Trivy scan → deploy-staging → deploy-prod, pushes `harbor.ongc.local/crmf/*`); Harbor referenced as `image.registry` in `helm/crmf/values.yaml` + Ansible `harbor_*` vars and `harbor-crmf-pull` imagePullSecret | Implemented (CI/registry integration); Harbor/GitLab servers external |
| **Ansible (IaC)** | `ansible/site.yml` + 3 phase playbooks + `inventory.example.ini` + `group_vars/all.example.yml` | Implemented |
| **API gateway / MQTT broker** | Ingress is the HTTP API gateway (above). MQTT: `k8s/platform/mqtt/00-emqx.yaml` (EMQX 5.8.0 StatefulSet, mqtts :8883 mutual-TLS, per-rig CN ACL) | Implemented (EMQX single-node default; scale-to-HA documented) |
| **MQTT → Kafka bridge** | `k8s/platform/mqtt/01-mqtt-kafka-bridge.yaml` (Option A: EMQX rule-engine bridge, no pod; Option B: standalone Deployment, `replicas: 0`, placeholder image) | Scaffolded |
| **Apache Kafka** | `k8s/platform/kafka/00-kafka.yaml` (`Kafka crmf-kafka`, 3-broker KRaft via `KafkaNodePool`), `01-topics.yaml` (5 `KafkaTopic`), `02-users.yaml` (2 `KafkaUser` SCRAM+ACL), `04-metrics-configmap.yaml` | Via upstream operator (Strimzi) |
| **Kafka Streams (derived channels)** | `k8s/platform/kafka/03-stream-processor.yaml` (`crmf-stream` Deployment, `replicas: 0`, image `crmf/crmf-stream:scaffold`) | Scaffolded |
| **ETP 2.0 server + WITSML store** | `k8s/platform/standards/01-etp-witsml.yaml` (`crmf-etp-witsml` Deploy/Svc, ports 8080 WITSML SOAP / 8443 ETP ws, `READ_ONLY=true`), `00-etp-witsml-note.md` | Scaffolded (in-house image `crmf/crmf-etp-witsml:0.1.0` built separately) |
| **TimescaleDB HA (Patroni-equivalent)** | `k8s/platform/timescaledb/00-cluster.yaml` (`Cluster crmf-timescaledb`, 3 inst = 1 primary + 2 replicas, 1 synchronous), `01-schema-configmap.yaml`, `02-backup.yaml`, `03-dr-replica-cluster.yaml`, `04-pooler.yaml`, `05-restore-test.yaml` (weekly restore-verification) | Via upstream operator (CloudNativePG; auto-failover replaces Patroni) |
| **PostgreSQL** | TimescaleDB cluster above (PG16 + timescaledb ext); plus dedicated `crmf-keycloak-db` (`keycloak/01-keycloak-db.yaml`); MLflow `mlflow` DB on `crmf-timescaledb` | Via upstream operator (CNPG) |
| **MinIO (object store)** | `k8s/platform/minio/00-minio-tenant.yaml` (StatefulSet + `minio` Svc + bucket-init Job: `crmf-reports`, `crmf-backups`, `crmf-mlflow`) | Implemented (single-node; Operator `Tenant` HA path documented in `minio/README.md`) |
| **Redis** | — (no Redis manifest; not required by the current backend) | Not deployed |
| **MLflow** | `k8s/platform/ml/00-mlflow.yaml` (`crmf-mlflow` Deploy/Svc, PG backend-store on CNPG, artifacts on `s3://crmf-mlflow`) | Implemented (Phase 1 tracking) |
| **KServe (model serving)** | `k8s/platform/ml/01-kserve-note.md` (InferenceService examples for `hpu-condition`, `hookload-anomaly`, `npt-classifier`) | Scaffolded (Phase 2 note) |
| **React portal** | `helm/crmf/templates/frontend-*.yaml` (`crmf-frontend` Deploy/Svc, image `crmf/crmf-frontend`) | Implemented |
| **Grafana** | `k8s/platform/observability/01-grafana-dashboard.yaml` (ConfigMap `crmf-grafana-dashboard`, `grafana_dashboard: "1"`) | Implemented (dashboard) + Via upstream operator (Grafana from kube-prometheus-stack) |
| **Keycloak + AD SSO** | `k8s/platform/keycloak/00-keycloak.yaml` (`Keycloak crmf-keycloak`, 2 inst), `01-keycloak-db.yaml` (CNPG), `02-realm.yaml` (`KeycloakRealmImport ongc`: clients `crmf-portal`/`crmf-api`, roles admin/operator/viewer, ONGC AD LDAPS `READ_ONLY` federation + group mapper). Backend OIDC verifier: `../backend/lib/oidc.js` | Via upstream operator (Keycloak Operator) |
| **Vault** | `k8s/platform/vault/01-secretstore.yaml` (`SecretStore crmf-vault` + `ExternalSecret crmf-secrets`), `00-vault-note.md` | Scaffolded (ESO `SecretStore`/`ExternalSecret` implemented; Vault server external) |
| **Prometheus** | `helm/crmf/templates/servicemonitor.yaml` (backend `/metrics`), `k8s/platform/observability/00-prometheusrule.yaml` (`crmf-alerts`), `02-podmonitor-or-servicemonitor.yaml` (MQTT). Backend exporter: `../backend/lib/metrics.js` | Implemented (CRMF wiring) + Via upstream operator (kube-prometheus-stack) |
| **Grafana/Loki (logs)** | `k8s/platform/observability/03-loki-note.md` (Promtail/Alloy ship → Loki; immutable audit-log retention §6.5) | Scaffolded (note; Loki installed cluster-wide) |

---

## 3. Prerequisites

**Control host** (runs `ansible-playbook` / `helm` / `kubectl`):
- `ansible` + `kubernetes` Python client, `ansible-galaxy collection install kubernetes.core`
- `helm` v3, `kubectl`, optionally `cnpg` (kubectl-cnpg plugin), `mc` (MinIO client)

**Target hosts (RKE2):** clean RHEL/Rocky 9 or Ubuntu 22.04, passwordless `sudo`,
control-plane ports 6443/9345/2379-2380 reachable, DNS for `crmf.ongc.local` and the
control-plane SAN `crmf-cp.ongc.local`. Air-gapped sites need a reachable **Harbor**
mirror (`harbor.ongc.local`).

**Cluster operators — exact install order** (each provides CRDs consumed by later steps;
versions from `ansible/group_vars/all.example.yml`, applied by `ansible/playbooks/20-operators.yml`):

| # | Operator | Version | Provides | Namespace |
|---|---|---|---|---|
| 1 | **cert-manager** | v1.15.3 | `ClusterIssuer`/`Certificate` (TLS for all Ingress + webhooks) | `cert-manager` |
| 2 | **ingress-nginx** | 4.11.2 | class `nginx`, HTTP-01 solver, `proxy-body-size 64m` | `ingress-nginx` |
| 3 | **External Secrets Operator** | 0.10.4 | `SecretStore`/`ExternalSecret` (Vault → `crmf-secrets`); optional | `external-secrets` |
| 4 | **CloudNativePG** | 0.22.0 (op release-1.24) | `Cluster`/`ScheduledBackup`/`Pooler` (TimescaleDB, Keycloak DB) | `cnpg-system` |
| 5 | **Strimzi** | 0.43.0 | `Kafka`/`KafkaNodePool`/`KafkaTopic`/`KafkaUser` | `kafka` (watches `crmf`) |
| 6 | **Keycloak Operator** | 25.0.4 (manifests) | `Keycloak`/`KeycloakRealmImport` | `keycloak` |
| 7 | **kube-prometheus-stack** | 62.6.0 | `ServiceMonitor`/`PodMonitor`/`PrometheusRule`, Prometheus/Grafana/Alertmanager | `monitoring` |
| 8 | **MinIO Operator** (optional) | 5.0.15 | HA `Tenant` CR — skippable; repo ships a StatefulSet instead | `minio-operator` |

> **CRDs before CRs.** Apply each operator and wait for its controller/CRDs to be Ready
> before applying CRs that reference them, or `kubectl apply` fails with `no matches for kind`.
> The DR TimescaleDB and primary **must use the same TimescaleDB-enabled PG16 image**
> (`ghcr.io/imusmanmalik/timescaledb-postgis:16`) — stock CNPG images lack the `timescaledb`
> extension and the schema bootstrap will fail. Mirror it to Harbor for air-gapped sites.

---

## 4. Step-by-step deployment

You can drive the whole flow with Ansible (recommended) or apply the layers by hand. Both
converge on the **same** `helm/crmf` chart, `values-prod.yaml`, Harbor registry and `crmf`
namespace.

### Option A — Ansible (one command)

```bash
cd deploy/ansible
cp inventory.example.ini inventory.ini
cp group_vars/all.example.yml group_vars/all.yml
$EDITOR inventory.ini group_vars/all.yml     # host IPs, rke2_join_token, harbor_*, crmf_secrets / external_secrets

ansible-playbook -i inventory.ini site.yml                  # full bring-up
#   --tags rke2        cluster only
#   --tags operators   operators only
#   --tags deploy      platform CRs + app chart only
#   -e target_cluster=rke2_dr   bring up the DR-site cluster

export KUBECONFIG=deploy/ansible/.artifacts/crmf.kubeconfig
kubectl -n crmf get pods,ingress,svc
```

`30-crmf-deploy.yml` creates the namespace + Harbor pull secret, applies the platform CRs in
dependency order, **waits on the CNPG cluster**, then `helm upgrade --install`s the app with
`values-prod.yaml` and waits for the rollouts (`atomic: true` auto-rolls-back a failed upgrade).

### Option B — manual, layer by layer

```bash
# --- 0. Operators (see §3 table; or run: ansible-playbook ... --tags operators) ---

# --- 1. Namespace + default-deny network baseline + per-workload data-plane allows ---
kubectl apply -f k8s/platform/00-namespace.yaml
kubectl apply -f k8s/platform/01-network-baseline.yaml
kubectl apply -f k8s/platform/02-network-allows.yaml   # CNPG/Kafka/Keycloak/MinIO/EMQX allows

# --- 2. TLS issuer (needs cert-manager) ---
kubectl apply -f k8s/platform/ingress/00-cert-manager-issuer.yaml

# --- 3. Object store (needed by CNPG backups + MLflow) ---
kubectl apply -f k8s/platform/minio/00-minio-tenant.yaml
kubectl -n crmf wait --for=condition=complete job/minio-bucket-init --timeout=180s

# --- 4. Prerequisite DB secrets, then TimescaleDB HA (schema FIRST) ---
kubectl -n crmf create secret generic crmf-db-app       --type=kubernetes.io/basic-auth --from-literal=username=crmf     --from-literal=password='<APP_PW>'
kubectl -n crmf create secret generic crmf-db-superuser --type=kubernetes.io/basic-auth --from-literal=username=postgres --from-literal=password='<SU_PW>'
kubectl -n crmf create secret generic crmf-backup-s3    --from-literal=ACCESS_KEY_ID='<S3_KEY>' --from-literal=SECRET_ACCESS_KEY='<S3_SECRET>'
kubectl -n crmf apply -f k8s/platform/timescaledb/01-schema-configmap.yaml
kubectl -n crmf apply -f k8s/platform/timescaledb/00-cluster.yaml
kubectl -n crmf apply -f k8s/platform/timescaledb/02-backup.yaml
kubectl -n crmf apply -f k8s/platform/timescaledb/04-pooler.yaml          # optional pooler
kubectl -n crmf apply -f k8s/platform/timescaledb/05-restore-test.yaml    # weekly restore-verification CronJob
kubectl -n crmf get cluster crmf-timescaledb -w                            # wait Healthy 3/3

# --- 5. Kafka (Strimzi) — only if using the KAFKA_ENABLED path ---
kubectl apply -f k8s/platform/kafka/04-metrics-configmap.yaml
kubectl apply -f k8s/platform/kafka/00-kafka.yaml
kubectl apply -f k8s/platform/kafka/01-topics.yaml
kubectl apply -f k8s/platform/kafka/02-users.yaml
#   03-stream-processor.yaml is a SCAFFOLD (replicas: 0) — apply only when the image exists.

# --- 6. MQTT broker (EMQX) ---
kubectl apply -f k8s/platform/mqtt/00-emqx.yaml
#   01-mqtt-kafka-bridge.yaml is a SCAFFOLD — prefer EMQX rule-engine bridge (Option A).

# --- 7. Keycloak + ONGC AD realm (DB first) ---
kubectl apply -f k8s/platform/keycloak/01-keycloak-db.yaml
kubectl wait --for=condition=Ready cluster/crmf-keycloak-db -n crmf --timeout=300s
kubectl apply -f k8s/platform/keycloak/00-keycloak.yaml
kubectl wait --for=condition=Ready keycloak/crmf-keycloak -n crmf --timeout=600s
kubectl apply -f k8s/platform/keycloak/02-realm.yaml                       # edit LDAP/DB secrets first

# --- 8. Secrets via Vault/ESO (after one-time Vault setup — see vault/00-vault-note.md) ---
kubectl apply -f k8s/platform/vault/01-secretstore.yaml
kubectl -n crmf get externalsecret crmf-secrets                            # expect SecretSynced

# --- 9. Observability wiring (kube-prometheus-stack already installed) ---
kubectl apply -f k8s/platform/observability/00-prometheusrule.yaml
kubectl apply -f k8s/platform/observability/01-grafana-dashboard.yaml
kubectl apply -f k8s/platform/observability/02-podmonitor-or-servicemonitor.yaml

# --- 10. ML tracking (Phase 1) + Energistics standards (in-house image) ---
kubectl apply -f k8s/platform/ml/00-mlflow.yaml
kubectl apply -f k8s/platform/standards/01-etp-witsml.yaml

# --- 11. The CRMF application (Helm) ---
helm upgrade --install crmf ./helm/crmf -n crmf -f ./helm/crmf/values-prod.yaml
```

### Verify

```bash
kubectl -n crmf rollout status deploy/crmf-backend
kubectl -n crmf rollout status deploy/crmf-frontend
kubectl -n crmf get ingress crmf -o wide
curl -sk https://crmf.ongc.local/api/healthz          # backend health via /api
# Metrics target + alerts in Prometheus UI → Targets/Rules; dashboard in Grafana → folder "CRMF".
```

`values-prod.yaml` raises backend/frontend to 3 replicas, HPA 3-12, PDB minAvailable 2,
sets the Harbor `harbor-crmf-pull` imagePullSecret, and — crucially — sets
**`externalSecret.enabled: true`** so the chart does **not** render a plaintext `crmf-secrets`;
the ESO `ExternalSecret` (step 8) must own it.

---

## 5. Compose-MVP vs Kubernetes-production — same images, same ingest contract

The MVP runs locally via `../docker-compose.yml`; production runs on RKE2 via this directory.
**The application code and its ingest contract are identical** — only the surrounding plane
changes.

| Concern | Compose MVP (`../docker-compose.yml`) | Kubernetes production (this dir) |
|---|---|---|
| Backend image | `build: backend/Dockerfile` | **same** Dockerfile → CI pushes `harbor.ongc.local/crmf/crmf-backend`; Helm pulls it |
| Frontend image | `build: frontend/Dockerfile` | **same** Dockerfile → `harbor.ongc.local/crmf/crmf-frontend` |
| Backend port / health | `:6000`, `GET /healthz` | Service `crmf-backend:6000`, probes `GET /healthz` |
| Ingest contract | `POST /ingest` (gzip batches, `INGEST_TOKEN`) | **identical** — Ingress `/api`+`/ingest`, `proxy-body-size 64m` for the same batches |
| Live updates | Socket.IO `/socket.io` | **identical** — Ingress `/socket.io`, `proxy-read-timeout 3600` |
| DB wiring (env) | `PGHOST=timescaledb`, `PGUSER/PGPASSWORD/PGDATABASE` | `PGHOST=crmf-timescaledb-rw` via ConfigMap `crmf-config`; same env keys |
| Secrets | `.env` (`JWT_SECRET`, `INGEST_TOKEN`, …) | Secret `crmf-secrets` (ESO/Vault) — **same key names** |
| Demo data | `fleet-sim` (profile `demo`, ~14 rigs) | real rig-edge agents (or fleet-sim against the Ingress) |

The decoupling layers that are *off by default* in compose are *opt-in* in K8s via feature
flags in ConfigMap `crmf-config`, so the **same image** behaves identically until enabled:

- `METRICS_ENABLED: "true"` (default on) — `/metrics` for Prometheus (`../backend/lib/metrics.js`).
- `KAFKA_ENABLED: "false"` (default off) — when on, the backend produces to `telemetry.ingest`
  and consumes `derived.channels` (`../backend/lib/kafka.js`); NetworkPolicy opens Kafka egress.
- `OIDC_ENABLED: "false"` (default off) — when on, the backend validates Keycloak JWTs
  (`../backend/lib/oidc.js`); NetworkPolicy opens Keycloak egress.

Because both paths build from the same Dockerfiles and honour the same `/ingest` + Socket.IO +
env contract, a chart or image change is validated identically whether it ships via GitLab CI
(`../.gitlab-ci.yml`: lint → build → Trivy → `helm upgrade --install`) or via Ansible.

> **CI environments & secrets (#17).** `deploy-prod` uses `values-prod.yaml`
> (`externalSecret.enabled: true`) and `--atomic`, so production secrets MUST come from
> ESO/Vault as Secret `crmf-secrets`. **`deploy-staging` instead uses
> `helm/crmf/values-staging.yaml`** (`externalSecret.enabled: false`), so the chart renders
> `crmf-secrets` from demo values and staging needs **no** ESO/Vault. Staging also drops
> `--atomic`: a staging cluster that has not provisioned a TimescaleDB leaves the backend
> NotReady (readiness is DB-aware), which is reported as a soft warning rather than triggering
> a guaranteed atomic-rollback. To run staging fully green, provision a CNPG cluster (or point
> `config.PGHOST` in the overlay at a reachable DB) before the deploy. The Ansible app-install
> (`30-crmf-deploy.yml`) keeps `external_secrets_enabled` consistent with the chart it applies.

> **OIDC (read before enabling).** The Keycloak realm import (`keycloak/02-realm.yaml`) is the
> single source of truth: issuer **`https://keycloak.ongc.local/realms/ongc`**, audience
> (bearer-only client) **`crmf-api`**. The chart `config` (`helm/crmf/values.yaml`) and
> `ansible/group_vars/all.example.yml` are aligned to these values; the backend NetworkPolicy
> opens egress both to the in-namespace Keycloak pod and to the ingress-nginx controller on 443
> (the JWKS fetch uses the public host). To go live, expose `keycloak.ongc.local` via an Ingress
> and flip `config.OIDC_ENABLED=true`; local break-glass accounts keep working alongside SSO.

---

## 6. DR, backup/restore, and the monitoring-only guarantee

### Backups (continuous, primary site)
- The primary `crmf-timescaledb` cluster archives **WAL + base backups** to MinIO/S3
  (`s3://crmf-backups/crmf-timescaledb`) via CNPG's barman-cloud (`timescaledb/00-cluster.yaml`).
- `timescaledb/02-backup.yaml` (`ScheduledBackup crmf-timescaledb-daily`) adds a **02:30 daily
  base backup**; `retentionPolicy: 30d` prunes old chains. The bucket-init Job in
  `minio/00-minio-tenant.yaml` also sets a 90-day object lifecycle on `crmf-backups`.
- **Restore-verification (#28):** `timescaledb/05-restore-test.yaml` runs a **weekly** CronJob
  that bootstraps a throwaway cluster from the latest backup, runs sanity checks (extension +
  hypertables + recent rows), pushes `crmf_restore_test_success` to the Pushgateway, and tears
  the cluster down. The `CRMFRestoreTestStale` alert fires if no verification has succeeded in
  >8 days or the last run failed. See `timescaledb/README.md` §8.

### Point-in-time recovery (same DC)
Bootstrap a brand-new cluster from the object store to any timestamp in the window
(full example in `timescaledb/README.md` §5):
```yaml
spec:
  bootstrap:
    recovery:
      source: clusterBackup
      recoveryTarget:
        targetTime: "2026-06-16 09:30:00+00"
```

### DR runbook — CNPG replica promotion (second ONGC data centre)
`timescaledb/03-dr-replica-cluster.yaml` (`crmf-timescaledb-dr`, 2 inst) runs at the DR site in
**replica mode**: it bootstraps from the primary's bucket and continuously replays WAL — **read-only
until promoted**. RPO ≈ WAL-archive cadence; RTO ≈ promote + repoint.

```bash
# 1. Confirm the primary site is truly down (split-brain guard) — stop primary Ingress/ingest if it may recover.

# 2. Promote: disable replica mode on the DR cluster.
kubectl -n crmf patch cluster crmf-timescaledb-dr --type merge \
  -p '{"spec":{"replica":{"enabled":false}}}'
kubectl -n crmf get cluster crmf-timescaledb-dr -w        # wait for a Healthy primary

# 3. Repoint the backend at the DR primary, then restart it.
kubectl -n crmf patch configmap crmf-config --type merge \
  -p '{"data":{"PGHOST":"crmf-timescaledb-dr-rw"}}'
kubectl -n crmf rollout restart deploy/crmf-backend

# 4. Confirm the DR cluster's own backups run (s3://crmf-backups/crmf-timescaledb-dr).
```
**Fail back**: rebuild the old primary as a fresh replica sourcing the DR bucket, let it catch
up, then switch over in a maintenance window and repoint `PGHOST` back to `crmf-timescaledb-rw`.

> Because rig-edge agents use **store-and-forward** (`POST /ingest`), edges buffer telemetry
> during a failover and backfill on reconnect — so a DR promotion loses little to no rig data
> beyond the WAL-archive RPO window.

Planned failover/switchover within a DC is automatic (CNPG promotes the most-aligned replica and
repoints `crmf-timescaledb-rw`); the backend only ever talks to `-rw`, so it is transparent.

### Monitoring-only guarantee (enforced, not just policy)
- Namespace PSA = **restricted**; baseline **default-deny** NetworkPolicy
  (`k8s/platform/01-network-baseline.yaml`) re-opens only DNS. Per-workload **allows** are split
  across two layers: the platform stateful data plane (CNPG TimescaleDB + Keycloak DB, Strimzi
  Kafka, Keycloak, MinIO, EMQX) is opened by `k8s/platform/02-network-allows.yaml`; the app pods
  (ingress-nginx → frontend/backend, backend → TimescaleDB `-rw`, Kafka/Keycloak **only when the
  matching flag is on**, Prometheus scrape) are opened by the Helm chart
  (`helm/crmf/templates/networkpolicy.yaml`). **No NetworkPolicy permits egress toward rigs/PLCs.**
- MQTT (`mqtt/00-emqx.yaml`) ACL: rigs may **publish** under `rigs/${cn}/...` only and are
  explicitly **denied subscribe** — one-way ingest.
- Kafka ACLs (`kafka/02-users.yaml`): `crmf-backend` produces telemetry/events + reads derived;
  `crmf-stream` is the sole derived writer. No principal has a path back to the field.
- ETP/WITSML (`standards/`) runs `READ_ONLY=true` (`WMLS_AddToStore`/`DeleteFromStore` disabled);
  Keycloak AD federation is `editMode: READ_ONLY`; KServe outputs are advisory dashboard flags.

Alert rules (`observability/00-prometheusrule.yaml`, `crmf-alerts`): `CRMFBackendDown`,
`CRMFBackendAbsent`, `CRMFHighIngestErrorRate`, `CRMFNoIngest`, `CRMFFleetOfflineRatioHigh`,
`CRMFTimescaleReplicationLag`.

---

## 7. What is real vs scaffolded for the pilot (don't be misled)

**Real and apply-ready for the pilot:**
- **App chart** (`helm/crmf`): backend + frontend Deployments/Services, Ingress (path routing +
  proxy/websocket tuning), HPA, PDB, NetworkPolicies, ServiceMonitor, ConfigMap, ServiceAccount.
  Production hardening throughout (non-root, readOnlyRootFS, drop ALL caps, seccomp).
- **TimescaleDB HA + DR** (`timescaledb/`): real CNPG `Cluster`s, scheduled backups, PITR/DR
  runbook, optional pooler. The single caveat is the **image must carry the timescaledb extension**.
- **Kafka** (`kafka/00,01,02,04`): real Strimzi `Kafka`/`KafkaTopic`/`KafkaUser` with ACLs.
- **MQTT broker** (`mqtt/00-emqx.yaml`): real EMQX StatefulSet (single-node default; HA documented).
- **Keycloak + AD SSO** (`keycloak/`): real `Keycloak` + dedicated CNPG DB + `ongc` realm with
  ONGC AD LDAPS federation and group→role RBAC. Backend OIDC verifier code exists.
- **MinIO** (`minio/`): real StatefulSet + buckets (`crmf-reports`/`crmf-backups`/`crmf-mlflow`).
- **MLflow** (`ml/00-mlflow.yaml`): real Phase-1 tracking server.
- **Observability** (`observability/00,01,02`): real PrometheusRule, Grafana dashboard, MQTT
  ServiceMonitor. Backend `/metrics` exporter code exists.
- **CI/CD + IaC**: real `../.gitlab-ci.yml` pipeline and Ansible RKE2/operators/deploy playbooks.

**Scaffolded — present as contract/design, not running yet:**
- **Derived-channels Kafka Streams job** (`kafka/03-stream-processor.yaml`) — `replicas: 0`,
  placeholder image `crmf/crmf-stream:scaffold`; app code owned by another workstream.
- **MQTT→Kafka bridge** (`mqtt/01-mqtt-kafka-bridge.yaml`) — `replicas: 0`; prefer the EMQX
  rule-engine bridge (Option A, no pod) in production.
- **ETP 2.0 + WITSML server** (`standards/01-etp-witsml.yaml`) — manifest real, but the in-house
  image `crmf/crmf-etp-witsml:0.1.0` is built separately; point at the real tag at rollout.
- **KServe model serving** (`ml/01-kserve-note.md`) — Phase 2 design note only.
- **Vault** (`vault/`) — the ESO `SecretStore`/`ExternalSecret` are real, but they require an
  external Vault and one-time `vault` CLI setup; until then `crmf-secrets` can be created manually.
- **Loki log shipping** (`observability/03-loki-note.md`) — design note; Loki/Promtail installed
  cluster-wide out of band.

**Not deployed / external by design:** Redis (not required by the current backend); the
**GitLab CE**, **Harbor**, **Vault**, **Loki/Grafana** *servers* themselves (this repo integrates
with them — ships the consuming CRs/CI config — but assumes they exist).

**Defaults to change before any non-lab use:** every `ChangeMe-*` / `changeme-*` /
`CHANGE-ME-*` placeholder (DB, MinIO, Keycloak DB, AD bind, MLflow, RKE2 join token, Harbor robot,
`crmf-secrets`). In production set `externalSecret.enabled: true` and source all secrets from Vault.

---

## 8. Directory map

```
deploy/
├── README.md                         # this guide
├── helm/crmf/                        # CRMF application chart (backend + frontend)
│   ├── Chart.yaml  values.yaml  values-prod.yaml  values-staging.yaml
│   └── templates/                    # deployments, services, ingress, hpa, pdb,
│                                     #   networkpolicy, servicemonitor, configmap, secret, ...
├── k8s/platform/                     # platform custom resources (namespace crmf)
│   ├── 00-namespace.yaml  01-network-baseline.yaml  02-network-allows.yaml  README.md
│   ├── ingress/                      # cert-manager ClusterIssuers
│   ├── timescaledb/                  # CNPG HA cluster, schema, backup, DR replica, pooler
│   ├── kafka/                        # Strimzi Kafka, topics, users, stream-processor(scaffold)
│   ├── mqtt/                         # EMQX broker, MQTT→Kafka bridge (scaffold)
│   ├── keycloak/                     # Keycloak, backing DB, ongc realm + AD federation
│   ├── minio/                        # MinIO StatefulSet + buckets
│   ├── ml/                           # MLflow (Phase 1) + KServe note (Phase 2)
│   ├── standards/                    # ETP 2.0 + WITSML server (scaffold) + note
│   ├── vault/                        # ESO SecretStore/ExternalSecret + Vault note
│   └── observability/                # PrometheusRule, Grafana dashboard, MQTT monitor, Loki note
└── ansible/                          # RKE2 bootstrap → operators → platform CRs + app chart
    ├── site.yml  inventory.example.ini  group_vars/all.example.yml  README.md
    └── playbooks/ 10-rke2-bootstrap.yml  20-operators.yml  30-crmf-deploy.yml
```

Per-area deep dives live in the sibling READMEs: `k8s/platform/README.md`,
`k8s/platform/timescaledb/README.md`, `k8s/platform/keycloak/README.md`,
`k8s/platform/minio/README.md`, `k8s/platform/mqtt/README.md`,
`k8s/platform/observability/README.md`, and `ansible/README.md`.

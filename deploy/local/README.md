# CRMF — local Kubernetes deploy (kind)

Stand up the **real production deployment mechanics** on a laptop so you can *feel* how
the CRMF central facility is deployed — operators, a CRD-managed database, the Helm
application with its real health probes / autoscaling / disruption budgets / ingress —
without an RKE2 cluster or the ONGC data centre.

This is the same Helm chart (`deploy/helm/crmf`) and the same CloudNativePG bootstrap
wiring (`deploy/k8s/platform/timescaledb`) used in production, just **sized down** to fit
~4–5 GiB of Docker memory and pointed at locally-built images + a self-signed issuer.

> **Monitoring-only**, like everything in this project: the stack only *ingests*. There is
> no write path back to any rig/PLC.

---

## Prerequisites

Already present on the dev box: `docker`, `kind`, `kubectl`, `helm`.
The app images must exist locally first (built once by the compose stack):

```bash
cd repo/central
docker compose build crmf-backend crmf-frontend fleet-sim
```

`up.sh` retags those images to the chart's expected refs and `kind load`s them — it never
reaches for a real registry.

## Quickstart

```bash
cd repo/central/deploy/local
./up.sh                  # ~4–8 min the first time (operator + DB image pulls)
# ... portal at https://crmf.localtest.me:9443  (admin / admin123)
./down.sh                # delete the whole cluster
```

`*.localtest.me` resolves to `127.0.0.1`, so no `/etc/hosts` edit is needed. The browser
will warn about the self-signed certificate — that's expected (cert-manager issued it from
the local self-signed `ClusterIssuer`).

---

## What it deploys, and how it maps to production

| Component | Local (this profile) | Production (RKE2 / `deploy/k8s/platform`) |
|---|---|---|
| Cluster | 1 kind node (control-plane + worker) | 3 control-plane + 4 worker RKE2 (Ansible) |
| Ingress | `ingress-nginx` (kind variant), hostPort 80/443 → host 9081/9443 | `ingress-nginx`, north-south TLS |
| TLS | cert-manager **self-signed** `ClusterIssuer` | cert-manager + Let's Encrypt / ONGC CA |
| TimescaleDB | **CloudNativePG**, **1 instance**, 512Mi, 2Gi disk | CNPG **3 instances** HA + sync standby, 4–8Gi, 50Gi+20Gi WAL, Barman→MinIO backup, DR replica |
| App backend | Helm `crmf-backend`, HPA 1→3, PDB, NetworkPolicy | same chart, HPA 3→12, PDB minAvailable 2 |
| App frontend | Helm `crmf-frontend`, 1 replica | 3 replicas |
| Metrics | `metrics-server` (so HPA shows live CPU%) | kube-prometheus-stack + ServiceMonitor |
| Live data | in-cluster `fleet-sim` (6 rigs) → `/ingest` | the real rig-edge sync agents |
| Kafka / Keycloak / EMQX / MinIO / MLflow | **not deployed** (RAM) — see below | operator-managed, feature-flagged on |

The **deployment pattern is identical** — a CRD-managed stateful database the operator
provisions and health-checks, plus a Helm-released app with rolling updates, probes,
autoscaling and an ingress. The omitted data-plane services are *more of the same* pattern.

## Container health / self-healing you can observe

```bash
kubectl -n crmf get pods                      # Running/Ready; restart count on crashloop
kubectl -n crmf get cluster crmf-timescaledb  # CNPG: readyInstances 1/1, phase healthy
kubectl -n crmf get hpa crmf-backend          # live CPU% vs 70% target (real metrics-server)
kubectl -n crmf get pdb                        # backend + frontend disruption budgets
kubectl -n crmf describe deploy crmf-backend  # readiness /healthz (DB-aware), liveness /livez (DB-free)
```

Try the **liveness-vs-readiness split** that prevents DB-failover restart storms: scale the
DB down (`kubectl -n crmf scale cluster crmf-timescaledb --replicas=0` is operator-managed;
instead `kubectl -n crmf delete pod crmf-timescaledb-1`) and watch the backend go
**NotReady** (drained from the Service) but **not restart** — liveness `/livez` makes no DB
call, so a DB blip never kills the pod. When the DB pod returns, readiness flips back.

## Access + smoke tests

```bash
curl -sk https://crmf.localtest.me:9443/api/livez     # {"ok":true}
curl -sk https://crmf.localtest.me:9443/api/healthz   # DB-aware readiness
TOK=$(curl -sk https://crmf.localtest.me:9443/api/auth/login -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"admin123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -sk https://crmf.localtest.me:9443/api/fleet -H "Authorization: Bearer $TOK" | head -c 300
```

Browser routing through the ingress: `/` → frontend SPA; `/api`, `/socket.io`, `/ingest`
→ backend.

---

## Why not the *entire* platform locally

This box gives Docker **~9.7 GiB**. The full prod platform (CNPG 3×4–8Gi + Kafka 3×2–4Gi +
Keycloak + EMQX + MinIO + kube-prometheus-stack) sums to **~25 GiB of pod requests** — it
will not schedule here. Two honest options for the rest:

- **Raise Docker's memory** to ~14–16 GiB and layer the platform CRs in
  `deploy/k8s/platform/*` (they'd need the same down-sizing applied here).
- **Use the real path** for the full HA stack: `deploy/ansible` bootstraps a multi-node
  RKE2 cluster and installs every operator — that's the environment those CRs are written
  for. See `deploy/README.md`.

Recent **`kindnet` enforces NetworkPolicy**, so the chart's default-deny + explicit allows
actually filter traffic here — you can watch the backend reject a pod that isn't ingress-nginx
or Prometheus (the demo fleet-sim needs its own allow policy in `20-fleet-sim-local.yaml` to
reach the backend). Inspect with `kubectl -n crmf get networkpolicy`.

## Files

| File | Purpose |
|---|---|
| `up.sh` / `down.sh` | bring-up / tear-down |
| `kind-cluster.yaml` | 1-node kind cluster + ingress port mappings |
| `00-selfsigned-issuer.yaml` | local cert-manager `ClusterIssuer` |
| `10-timescaledb-local.yaml` | down-sized CNPG TimescaleDB + its credential secrets |
| `20-fleet-sim-local.yaml` | optional in-cluster demo data |
| `values-local.yaml` | Helm overlay (local images, self-signed TLS, smaller replicas) |

# CRMF platform layer

Cluster-level scaffolding for the **Centralised Rig Monitoring Facility** on Kubernetes
(namespace `crmf`). This directory holds the namespace, network baseline, and the supporting
data-plane / platform services the app workloads (backend, frontend, TimescaleDB, Kafka,
Keycloak — owned by other agents) depend on.

> **Monitoring-only.** CRMF ingests rig telemetry and serves dashboards. Nothing here (or
> anywhere in CRMF) writes back to a rig/PLC. ML inference and the ETP/WITSML server are
> read/advisory only.

## Layout

| Path                              | What it is                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `00-namespace.yaml`               | Namespace `crmf` with Pod Security Admission = `restricted`.               |
| `01-network-baseline.yaml`        | Default-deny-all NetworkPolicy + allow-DNS egress.                         |
| `02-network-allows.yaml`          | Per-workload ALLOW policies for the stateful data plane (CNPG, Kafka, Keycloak + its DB, MinIO, EMQX). Required after the default-deny or the data plane is bricked. |
| `ingress/00-cert-manager-issuer.yaml` | ClusterIssuer `letsencrypt-or-ongc-ca` (+ `ongc-internal-ca`) for app TLS. |
| `minio/`                          | S3-compatible object store (reports, backups, ML artifacts).               |
| `vault/`                          | Vault + External Secrets — materialises `crmf-secrets`.                    |
| `ml/`                             | MLflow tracking (Phase 1) + KServe serving note (Phase 2).                 |
| `standards/`                      | In-house ETP 2.0 + WITSML 1.4.1 server (Energistics interop).              |

## Operator install order

Install these **cluster-wide operators first** (each provides CRDs the manifests below
reference). Order matters where one operator's resources are consumed by another.

| # | Operator                       | Provides / why                                                     | Typical install                                                        |
| - | ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1 | **cert-manager**               | `ClusterIssuer`/`Certificate` for all TLS (app Ingress, ETP).      | `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml` |
| 2 | **NGINX Ingress Controller**   | Ingress class `nginx`; HTTP-01 solver target; app/ETP routing.     | `helm install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace` |
| 3 | **External Secrets Operator**  | `SecretStore`/`ExternalSecret` (Vault → `crmf-secrets`).           | `helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace` |
| 4 | **CloudNativePG (CNPG)**       | `Cluster` CRD for `crmf-timescaledb`; MLflow backend DB.           | `kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml` |
| 5 | **Strimzi**                    | `Kafka`/`KafkaTopic`/`KafkaUser` (telemetry bus).                  | `kubectl create -f 'https://strimzi.io/install/latest?namespace=crmf' -n crmf` |
| 6 | **Keycloak Operator**         | `Keycloak`/`KeycloakRealmImport` (OIDC for the platform).          | `kubectl apply -f https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/24.0.0/kubernetes/keycloaks.k8s.keycloak.org-v1.yml` (+ operator) |
| 7 | **kube-prometheus-stack**      | `ServiceMonitor`/`PrometheusRule` CRDs; Prometheus/Grafana/Alertmanager for `/metrics`. | `helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack -n monitoring --create-namespace` |
| — | **MinIO** (optional operator)  | HA `Tenant` CR. Skippable — this repo ships a StatefulSet instead. | `kubectl apply -k "github.com/minio/operator?ref=v6.0.4"` (see `minio/README.md`) |

> **CRDs before CRs.** Apply each operator and wait for its CRDs/controller to be Ready
> before applying manifests that reference them. `kubectl apply` of a CR whose CRD is absent
> fails with `no matches for kind`.

## Apply order (this layer)

```sh
# 1. Namespace + network baseline (everything else lives in / depends on these)
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-network-baseline.yaml
# Per-workload allows for the stateful data plane — apply alongside the baseline,
# otherwise CNPG replication, Kafka quorum, Keycloak<->DB, MinIO and EMQX are denied.
kubectl apply -f 02-network-allows.yaml

# 2. TLS issuer (needs cert-manager from the operator table)
kubectl apply -f ingress/00-cert-manager-issuer.yaml

# 3. Object store (needed by CNPG backups, MLflow)
kubectl apply -f minio/00-minio-tenant.yaml
kubectl -n crmf wait --for=condition=complete job/minio-bucket-init --timeout=180s

# 4. Secrets (needs External Secrets + Vault reachable — see vault/00-vault-note.md)
kubectl apply -f vault/01-secretstore.yaml

# 5. ML tracking (Phase 1; needs MinIO + the CNPG "mlflow" DB)
kubectl apply -f ml/00-mlflow.yaml

# 6. Energistics standards endpoints (in-house image)
kubectl apply -f standards/01-etp-witsml.yaml
```

App workloads (backend/frontend/Timescale/Kafka/Keycloak + their Ingress, HPAs, PDBs,
ServiceMonitors, NetworkPolicies) are applied by their own agents on top of this baseline.

## How it fits together

```
                          Ingress (NGINX) ── TLS via cert-manager (letsencrypt-or-ongc-ca)
                          host crmf.ongc.local
                            /api,/socket.io ─▶ crmf-backend:6000
                            /               ─▶ crmf-frontend:80
                                   │
            ┌──────────────────────┼───────────────────────────────────────────┐
            ▼                      ▼                       ▼                     ▼
   crmf-timescaledb-rw       Kafka (Strimzi)        Keycloak (OIDC)       MinIO (object store)
     (CNPG historian)        telemetry bus          auth for /api          reports / backups / ML
            ▲                      ▲                                              ▲
            │  backups (barman-cloud) ─────────────────────────────────────────┘
            │
   MLflow (Phase 1) ── artifacts ▶ s3://crmf-mlflow ; backend store ▶ "mlflow" DB on CNPG
   KServe (Phase 2)  ── serves hpu-condition / hookload-anomaly / npt-classifier (advisory)
   ETP/WITSML server ── reads historian, publishes Energistics feeds to external clients

   Secrets:  Vault ──(External Secrets Operator)──▶ crmf-secrets  (PGPASSWORD, JWT_SECRET, …)
   Security: namespace PSA=restricted; default-deny NetworkPolicy + per-workload allows.
```

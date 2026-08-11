# CRMF observability layer (proposal §6.4 + §6.5)

CRMF-specific Prometheus / Grafana / Loki configuration for the **Centralised Rig Monitoring
Facility**. This layer assumes the heavy lifting (Prometheus, Alertmanager, Grafana, Loki) is
already installed **cluster-wide**; the files here only wire CRMF into it.

> CRMF is a **monitoring-only** platform. It ingests telemetry from rigs and never writes back
> to any rig/PLC. Nothing in this directory changes that — these are read-only metrics,
> dashboards, alerts and logs.

## Contents

| File | Kind | Purpose |
|------|------|---------|
| `00-prometheusrule.yaml` | `monitoring.coreos.com/v1` PrometheusRule `crmf-alerts` | Alert rules: backend down/absent, high ingest error rate, no ingest, fleet offline ratio, TimescaleDB replication lag. |
| `01-grafana-dashboard.yaml` | `v1` ConfigMap `crmf-grafana-dashboard` (`grafana_dashboard: "1"`) | "CRMF — Fleet & Ingest Overview" dashboard: fleet status breakdown, ingest rate, ingest errors, p95 ingest duration, rigs reporting, alarm counts. |
| `02-podmonitor-or-servicemonitor.yaml` | `monitoring.coreos.com/v1` ServiceMonitor `crmf-mqtt` | Scrapes the MQTT broker's `/metrics` (the one platform component without its own operator-managed monitor). |
| `03-loki-note.md` | doc | How stdout logs reach Loki via Promtail/Alloy + the immutable audit-log retention rule (§6.5). |
| `README.md` | doc | This file. |

## Prerequisites — what must already be installed cluster-wide

### 1. kube-prometheus-stack (Prometheus Operator + Prometheus + Alertmanager + Grafana)
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
```
This provides the CRDs used here: `PrometheusRule`, `ServiceMonitor`, `PodMonitor`. It also
runs the **Grafana sidecar** that auto-imports dashboards from ConfigMaps labelled
`grafana_dashboard: "1"` in any namespace.

### 2. Loki + a log shipper (Promtail or Grafana Alloy)
```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
# Single-binary or scalable Loki, plus a DaemonSet shipper:
helm install loki grafana/loki        --namespace logging --create-namespace
helm install promtail grafana/promtail --namespace logging   # or grafana/alloy
```
See `03-loki-note.md` for how CRMF logs flow in and for the audit-log retention policy.

## How these hook in

- **Selector labels.** The Prometheus Operator only picks up `PrometheusRule` and
  `ServiceMonitor` objects that match its `ruleSelector` / `serviceMonitorSelector`. The
  kube-prometheus-stack default selects on the stack's Helm **release label**. Both
  `00-prometheusrule.yaml` and `02-...servicemonitor.yaml` therefore carry
  `release: kube-prometheus-stack`.
  - **If your stack release name differs**, change that label value (and the `prometheus` /
    `role` labels on the rule) — or set `prometheus.prometheusSpec.ruleSelectorNilUsesHelm
    Values=false` and `serviceMonitorSelectorNilUsesHelmValues=false` on the stack so it
    selects everything cluster-wide.
- **Dashboard.** The Grafana sidecar watches **all namespaces** for ConfigMaps labelled
  `grafana_dashboard: "1"` and imports them. `01-grafana-dashboard.yaml` carries that label,
  plus `grafana_folder: "CRMF"` so it lands in a dedicated folder. The dashboard uses a
  `${DS_PROMETHEUS}` datasource variable so it binds to whatever Prometheus datasource Grafana
  has, no hard-coded UID.
- **MQTT ServiceMonitor.** `crmf-mqtt` selects the broker Service by
  `app.kubernetes.io/component: mqtt-broker` in namespace `crmf`. It is a no-op until the
  mqtt agent's broker Service exists and exposes a `metrics` port; delete that document if the
  broker has no Prometheus endpoint.
- **What is NOT here (covered elsewhere):** crmf-backend/frontend ServiceMonitors (app Helm
  chart), CloudNativePG PodMonitor (`crmf-timescaledb` Cluster `monitoring.enablePodMonitor`),
  Strimzi Kafka metrics (Kafka resource / Strimzi PodMonitors), Keycloak `/metrics`.

## Metric names this layer depends on

Exported by the backend (`/metrics`, `METRICS_ENABLED=true`, scraped on container port 6000):

| Metric | Type | Used by |
|--------|------|---------|
| `crmf_ingest_batches_total` | counter | ingest rate, CRMFNoIngest, ingest-error ratio |
| `crmf_ingest_points_total` | counter | ingest rate |
| `crmf_ingest_events_total` | counter | ingest rate, alarm counts |
| `crmf_ingest_errors_total` | counter | CRMFHighIngestErrorRate, errors panel |
| `crmf_ingest_duration_seconds` | histogram | p50/p95/p99 ingest duration |
| `crmf_fleet_rigs` (by `status`) | gauge | fleet status breakdown, offline ratio, CRMFFleetOfflineRatioHigh |
| `up{job="crmf-backend"}` | Prometheus | CRMFBackendDown / CRMFBackendAbsent |
| `cnpg_pg_replication_lag{cluster="crmf-timescaledb"}` | CNPG | CRMFTimescaleReplicationLag |

## Apply

These are plain manifests (not part of the app Helm chart):

```bash
kubectl apply -f 00-prometheusrule.yaml
kubectl apply -f 01-grafana-dashboard.yaml
kubectl apply -f 02-podmonitor-or-servicemonitor.yaml
# (the .md files are documentation, nothing to apply)
```

### Quick verification
```bash
# Rule loaded by Prometheus:
kubectl -n crmf get prometheusrule crmf-alerts
# Dashboard ConfigMap present and labelled:
kubectl -n crmf get configmap crmf-grafana-dashboard --show-labels
# ServiceMonitor target picked up (after the broker exists):
kubectl -n crmf get servicemonitor crmf-mqtt
# Then check Prometheus UI → Status → Rules / Targets, and Grafana → Dashboards → CRMF.
```

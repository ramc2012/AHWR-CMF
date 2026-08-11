# CRMF — Ansible Infrastructure-as-Code

Infrastructure automation for the **Centralised Rig Monitoring Facility (CRMF)**
production layer (ONGC AHWR Digital Twin, proposal §6.4: GitLab CE + Harbor
registry + Ansible on **RKE2**).

These playbooks stand up the whole platform on bare-metal / VM hosts:

```
RKE2 cluster  ->  operators  ->  platform CRs + CRMF app chart
```

CRMF is a **monitoring-only** platform: it ingests telemetry from rig-edge
agents and serves the fleet portal. It never writes back to any rig or PLC, so
there is nothing in this automation that opens an outbound control path to the
field.

---

## What the playbooks do

| Playbook | Purpose |
|---|---|
| `site.yml` | Top-level entry point. Imports the three phases below in order. |
| `playbooks/10-rke2-bootstrap.yml` | Installs **RKE2** on the control-plane servers (HA, first server bootstraps, others join) and the worker agents. Writes `/etc/rancher/rke2/config.yaml` with the shared join token, TLS SANs and CNI; disables the bundled ingress (we install `ingress-nginx` ourselves); fetches an admin **kubeconfig** to `.artifacts/crmf.kubeconfig` with the API endpoint substituted. |
| `playbooks/20-operators.yml` | Helm-installs the cluster operators via `kubernetes.core`: **cert-manager** (+ `ClusterIssuer letsencrypt-or-ongc-ca`), **ingress-nginx** (default class `nginx`, `proxy-body-size 64m`), **external-secrets** (optional), **CloudNativePG**, **Strimzi** (Kafka), **Keycloak operator** (upstream manifests + CRDs), **kube-prometheus-stack** (Prometheus Operator → ServiceMonitor/PrometheusRule), and the **MinIO operator**. |
| `playbooks/30-crmf-deploy.yml` | Creates the `crmf` namespace + Harbor image-pull secret, applies the **platform CRs** in `deploy/k8s/platform` in dependency order (CNPG `crmf-timescaledb` first, then Kafka, Keycloak, MinIO, MQTT bridge, monitoring), waits for the database, then **`helm upgrade --install`** the CRMF app chart (`deploy/helm/crmf` with `values-prod.yaml`) and waits for the `crmf-backend` / `crmf-frontend` rollouts. |

The deployed app matches the shared wiring conventions: namespace `crmf`,
Services `crmf-backend:6000` and `crmf-frontend:80`, CNPG cluster
`crmf-timescaledb` (RW service `crmf-timescaledb-rw:5432`, db/user `crmf`),
ingress host `crmf.ongc.local` with path routing (`/api` + `/socket.io` →
backend, `/` → frontend).

---

## Layout

```
deploy/ansible/
├── README.md                       # this file
├── site.yml                        # top-level playbook (imports phases)
├── inventory.example.ini           # control-plane + worker + DR hosts
├── group_vars/
│   └── all.example.yml             # versions, registry, hostnames, secret refs
└── playbooks/
    ├── 10-rke2-bootstrap.yml       # install RKE2 + fetch kubeconfig
    ├── 20-operators.yml            # helm-install operators
    └── 30-crmf-deploy.yml          # platform CRs + app chart
```

Referenced from sibling directories:

```
deploy/helm/crmf/        # CRMF application Helm chart (+ values-prod.yaml)
deploy/k8s/platform/     # platform custom resources (CNPG, Kafka, Keycloak, ...)
```

---

## Prerequisites

**Control host** (where you run `ansible-playbook` from):

```bash
# Ansible + Python client + collection + helm
pip install ansible kubernetes
ansible-galaxy collection install kubernetes.core
# helm v3 binary on PATH
helm version --short
```

**Target hosts:**

- A clean, supported Linux (RHEL/Rocky 9, Ubuntu 22.04) per RKE2 requirements.
- SSH access for the `ansible` user with passwordless `sudo`.
- Network reachability between control-plane servers (ports 6443, 9345, 2379–2380)
  and from agents to the server registration address (9345).
- DNS / `/etc/hosts` so `crmf.ongc.local` and the control-plane SAN
  (`crmf-cp.ongc.local`) resolve.
- Air-gapped sites: a reachable **Harbor** mirror (`harbor.ongc.local`) and,
  optionally, an RKE2 system-default-registry.

---

## Usage

1. **Copy and edit the examples** (never commit real secrets — use `ansible-vault`
   or external-secrets):

   ```bash
   cp inventory.example.ini inventory.ini
   cp group_vars/all.example.yml group_vars/all.yml
   $EDITOR inventory.ini group_vars/all.yml
   ```

   At minimum set: host IPs, `rke2_join_token`, `harbor_robot_password`, the
   `crmf_secrets.*` values (or enable `external_secrets_enabled`), and the
   `rke2_tls_san` / `rke2_api_endpoint` for your control-plane VIP.

2. **Full bring-up** (all three phases):

   ```bash
   ansible-playbook -i inventory.ini site.yml
   ```

3. **Run a single phase** with tags:

   ```bash
   ansible-playbook -i inventory.ini site.yml --tags rke2        # cluster only
   ansible-playbook -i inventory.ini site.yml --tags operators   # operators only
   ansible-playbook -i inventory.ini site.yml --tags deploy      # CRs + app only
   ```

4. **DR cluster** (warm standby — same layout, second site):

   ```bash
   ansible-playbook -i inventory.ini site.yml --tags rke2 -e target_cluster=rke2_dr
   ```

After a successful run the kubeconfig is at
`deploy/ansible/.artifacts/crmf.kubeconfig`:

```bash
export KUBECONFIG=deploy/ansible/.artifacts/crmf.kubeconfig
kubectl -n crmf get pods,ingress,svc
```

Portal: `https://crmf.ongc.local/` · API: `…/api` · ingest endpoint: `…/ingest`.

---

## How this fits with the GitLab CI pipeline

- **Ansible** owns the *cluster* and *operators* (one-time / occasional, run by
  platform engineers): RKE2, cert-manager, CNPG, Strimzi, Keycloak, monitoring,
  MinIO, ingress-nginx.
- **GitLab CI** (`/.gitlab-ci.yml`) owns the *application* lifecycle on every
  commit: lint → build → Harbor push (tagged by commit SHA) → Trivy scan →
  `helm upgrade --install` to the `crmf` namespace (staging auto, prod manual).

Both converge on the same `deploy/helm/crmf` chart and `values-prod.yaml`, the
same Harbor registry (`harbor.ongc.local/crmf/*`) and the same namespace, so a
chart change is validated identically whether it ships via CI or via
`30-crmf-deploy.yml`.

---

## Idempotency & safety notes

- All tasks use idempotent modules (`kubernetes.core.helm`, `kubernetes.core.k8s`
  with `apply: true`, RKE2 installs guarded by `creates:`); re-running converges
  rather than duplicating.
- Secret-bearing tasks use `no_log: true`.
- `30-crmf-deploy.yml` waits on the CNPG cluster before installing the app so the
  backend never starts against a missing database, and uses `atomic: true` on the
  helm release so a failed upgrade rolls back automatically.
- Nothing here establishes a write path to rig PLCs — consistent with the
  project-wide monitoring-only rule.

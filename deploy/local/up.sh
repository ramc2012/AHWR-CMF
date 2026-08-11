#!/usr/bin/env bash
# =============================================================================
# CRMF — local "production-shape" Kubernetes bring-up on kind.
#
# Stands up the REAL deployment mechanics on a laptop: cert-manager + ingress-nginx
# + CloudNativePG + metrics-server (operators), a CNPG-managed TimescaleDB, and the
# CRMF Helm chart with its production probes / HPA / PDB / NetworkPolicy / Ingress+TLS,
# plus optional live data. Sized down to fit ~4-5 GiB of Docker memory.
#
# Usage:   ./up.sh            # bring everything up
#          ./down.sh          # tear the cluster down
#
# Prereqs (already present on this box): docker, kind, kubectl, helm.
# The CRMF app images must exist locally first (build once via the compose stack:
#   cd repo/central && docker compose build crmf-backend crmf-frontend fleet-sim ).
# =============================================================================
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTRAL="$(cd "$HERE/../.." && pwd)"   # repo/central
CLUSTER="crmf-local"
NS="crmf"

# Pinned operator versions (match the Ansible/RKE2 prod layer where applicable).
CERT_MANAGER_VER="v1.15.3"
INGRESS_NGINX_VER="controller-v1.11.2"
CNPG_URL="https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml"
METRICS_SERVER_URL="https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"

step() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

# ---------------------------------------------------------------------------
step "1/8  Create kind cluster ($CLUSTER)"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "    cluster already exists — reusing"
else
  kind create cluster --config "$HERE/kind-cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

# ---------------------------------------------------------------------------
step "2/8  Install operators (cert-manager, ingress-nginx, CloudNativePG, metrics-server)"
kubectl apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VER}/cert-manager.yaml"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_NGINX_VER}/deploy/static/provider/kind/deploy.yaml"
kubectl apply --server-side -f "$CNPG_URL"
kubectl apply -f "$METRICS_SERVER_URL"
# kind kubelet uses a self-signed serving cert — let metrics-server trust it.
kubectl -n kube-system patch deploy metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' || true

step "    Waiting for operators to be ready..."
kubectl -n cert-manager rollout status deploy/cert-manager --timeout=240s
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=240s
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=240s
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=240s

# ---------------------------------------------------------------------------
step "3/8  Retag + load the CRMF images into the kind node"
docker tag central-crmf-backend:latest  harbor.ongc.local/crmf/crmf-backend:1.0.0
docker tag central-crmf-frontend:latest harbor.ongc.local/crmf/crmf-frontend:1.0.0
docker tag central-fleet-sim:latest     harbor.ongc.local/crmf/fleet-sim:1.0.0
kind load docker-image --name "$CLUSTER" \
  harbor.ongc.local/crmf/crmf-backend:1.0.0 \
  harbor.ongc.local/crmf/crmf-frontend:1.0.0 \
  harbor.ongc.local/crmf/fleet-sim:1.0.0
# CNPG-compatible TimescaleDB operand image, built natively for this CPU arch (the prod
# ghcr.io/imusmanmalik/timescaledb-postgis:16 is amd64-only). Cached after first build.
echo "    building + loading the local TimescaleDB operand image (first build ~2 min)..."
docker build --platform linux/arm64 -f "$HERE/timescaledb-cnpg.Dockerfile" -t crmf/timescaledb-cnpg:16 "$HERE"
kind load docker-image --name "$CLUSTER" crmf/timescaledb-cnpg:16

# ---------------------------------------------------------------------------
step "4/8  Namespace + self-signed issuer + DB secrets + schema + TimescaleDB"
kubectl apply -f "$CENTRAL/deploy/k8s/platform/00-namespace.yaml"
kubectl apply -f "$HERE/00-selfsigned-issuer.yaml"
kubectl apply -f "$CENTRAL/deploy/k8s/platform/timescaledb/01-schema-configmap.yaml"
kubectl apply -f "$HERE/10-timescaledb-local.yaml"

# ---------------------------------------------------------------------------
step "5/8  Wait for the CNPG TimescaleDB cluster to come up (image pull can take a few min)"
ready=""
for i in $(seq 1 60); do
  ready="$(kubectl -n "$NS" get cluster crmf-timescaledb -o jsonpath='{.status.readyInstances}' 2>/dev/null || true)"
  phase="$(kubectl -n "$NS" get cluster crmf-timescaledb -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  printf "\r    readyInstances=%s  phase='%s'  (%ds) " "${ready:-0}" "${phase:-pending}" "$((i*10))"
  [ "${ready:-0}" = "1" ] && break
  sleep 10
done
echo
[ "${ready:-0}" = "1" ] || { echo "!! TimescaleDB not ready — inspect: kubectl -n $NS describe cluster crmf-timescaledb"; exit 1; }

# The app connects as crmf_app, whose login password is set by CNPG managed.roles AFTER
# the cluster reports healthy. Wait for that role before installing the app so the
# backend doesn't crash-loop on auth during its first boot.
echo "    waiting for the crmf_app login role (CNPG managed.roles)..."
for i in $(seq 1 24); do
  if kubectl -n "$NS" exec crmf-timescaledb-1 -c postgres -- \
       env PGPASSWORD=crmf-local-pg psql -U crmf_app -h 127.0.0.1 -d crmf -tAc "select 1" >/dev/null 2>&1; then
    echo "    crmf_app ready"; break
  fi
  sleep 5
done

# ---------------------------------------------------------------------------
step "6/8  helm install the CRMF application"
helm upgrade --install crmf "$CENTRAL/deploy/helm/crmf" \
  -n "$NS" -f "$HERE/values-local.yaml" --wait --timeout 5m

# ---------------------------------------------------------------------------
step "7/8  Optional live data (in-cluster fleet-sim → backend /ingest)"
kubectl apply -f "$HERE/20-fleet-sim-local.yaml" || echo "    (fleet-sim optional — skipped)"

# ---------------------------------------------------------------------------
step "8/8  Status"
kubectl -n "$NS" get pods -o wide
echo
kubectl -n "$NS" get svc,ingress,hpa,pdb,networkpolicy

cat <<EOF

\033[1;32m✔ CRMF is up on kind.\033[0m

  Portal:   https://crmf.localtest.me:9443      (admin / admin123 — self-signed cert warning is expected)
  Ingress routes:  /  -> frontend   |   /api /socket.io /ingest -> backend

  Smoke tests:
    kubectl -n $NS get pods                               # all Running/Ready
    kubectl -n $NS get cluster crmf-timescaledb           # CNPG: 1/1 healthy
    kubectl -n $NS get hpa crmf-backend                   # live CPU% (metrics-server)
    curl -sk https://crmf.localtest.me:9443/api/livez     # backend process liveness
    curl -sk https://crmf.localtest.me:9443/api/healthz   # backend DB-aware readiness
    TOK=\$(curl -sk https://crmf.localtest.me:9443/api/auth/login -H 'Content-Type: application/json' \\
          -d '{"username":"admin","password":"admin123"}' | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
    curl -sk https://crmf.localtest.me:9443/api/fleet -H "Authorization: Bearer \$TOK" | head -c 300

  Tear down:  $HERE/down.sh
EOF

# Secrets — HashiCorp Vault + External Secrets Operator (proposal §6.5)

CRMF holds several long-lived secrets: the TimescaleDB password (`PGPASSWORD`), the API
signing key (`JWT_SECRET`), the rig-edge store-and-forward token (`INGEST_TOKEN`), the
seeded admin password (`ADMIN_PASSWORD`), plus MinIO root keys and Keycloak/OIDC client
secrets. These must **not** live as plaintext in Git. The production pattern is:

```
HashiCorp Vault  ──(KV v2 secrets engine)──▶  External Secrets Operator  ──▶  k8s Secret "crmf-secrets"
   (source of truth)                              (controller, syncs)           (consumed by backend)
```

- **Vault** is the source of truth. Run it HA (Raft) or point ESO at an existing ONGC
  enterprise Vault. Secrets live under a KV v2 mount at path `crmf/` (e.g.
  `crmf/data/backend`).
- **External Secrets Operator (ESO)** runs in-cluster. A namespaced `SecretStore` tells ESO
  how to authenticate to Vault; an `ExternalSecret` declares which Vault keys to pull and
  what k8s Secret to write. ESO reconciles on an interval (`refreshInterval`) so rotations
  in Vault propagate automatically.

## Why this shape

- Git stays secret-free — only the *references* (`SecretStore`/`ExternalSecret`) are
  committed. This is the GitOps-safe pattern (proposal §6.5).
- Rotation is centralised in Vault; ESO re-materialises `crmf-secrets` without a redeploy.
- The same `crmf-secrets` contract the backend already expects (from the shared spec) is
  preserved exactly — workloads are unaware Vault is involved.

## Vault authentication (Kubernetes auth method)

ESO authenticates to Vault using the **Kubernetes auth method**, exchanging the
`crmf-vault-auth` ServiceAccount token for a Vault token. One-time Vault setup (run by a
platform admin against the Vault CLI/API, shown for reference — not applied by kubectl):

```sh
# Enable KV v2 and write the CRMF secrets
vault secrets enable -path=crmf -version=2 kv
vault kv put crmf/backend \
  PGPASSWORD='...'  JWT_SECRET='...'  INGEST_TOKEN='...'  ADMIN_PASSWORD='...'

# Enable Kubernetes auth and bind a policy/role to the ESO ServiceAccount
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host="https://kubernetes.default.svc"

vault policy write crmf-read - <<'EOF'
path "crmf/data/backend" { capabilities = ["read"] }
EOF

vault write auth/kubernetes/role/crmf-backend \
  bound_service_account_names=crmf-vault-auth \
  bound_service_account_namespaces=crmf \
  policies=crmf-read  ttl=1h
```

The companion manifest `01-secretstore.yaml` creates the `crmf-vault-auth` ServiceAccount,
the `SecretStore`, and an `ExternalSecret` that materialises `crmf-secrets`.

## Install order

1. Install ESO (see platform `README.md`): `helm install external-secrets ...`.
2. Stand up / reach Vault and run the one-time setup above.
3. `kubectl apply -f 01-secretstore.yaml`.
4. Confirm: `kubectl -n crmf get externalsecret crmf-secrets` → `SecretSynced`, and
   `kubectl -n crmf get secret crmf-secrets` exists.

## Bootstrap fallback

Until Vault/ESO is wired in a given environment, `crmf-secrets` can be created manually
(`kubectl create secret generic crmf-secrets --from-literal=...`). Once ESO owns the secret,
remove the manual copy so ESO is the sole writer.

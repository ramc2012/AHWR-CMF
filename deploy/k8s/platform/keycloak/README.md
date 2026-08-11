# CRMF Identity Layer — Keycloak (Operator) + ONGC AD Federation

This directory provisions the **identity provider** for the Centralised Rig
Monitoring Facility (CRMF), per proposal **§6.5**: Keycloak federated with ONGC
Active Directory, with **RBAC by rig and role**. It is **manifests only** — the
backend's OIDC token-verification code lives in another component.

> **Monitoring-only platform.** CRMF never writes back to any rig/PLC. The AD
> federation here is configured `READ_ONLY` (`editMode: READ_ONLY`,
> `syncRegistrations: false`): Keycloak imports/validates ONGC directory
> identities but never mutates the directory.

## Files

| File | Kind | Purpose |
|------|------|---------|
| `00-keycloak.yaml` | `k8s.keycloak.org/v2alpha1` `Keycloak` | 2-instance HA Keycloak server `crmf-keycloak`, hostname `keycloak.ongc.local`, DB pointed at the CNPG cluster below. |
| `01-keycloak-db.yaml` | `postgresql.cnpg.io/v1` `Cluster` + `Secret` | Dedicated 2-instance CloudNativePG cluster `crmf-keycloak-db` backing Keycloak. |
| `02-realm.yaml` | `k8s.keycloak.org/v2alpha1` `KeycloakRealmImport` + LDAP `Secret` | Realm `ongc`: clients, roles, group→role mappings, ONGC AD/LDAPS federation, and the `roles` token claim. |

Apply order is encoded in the filename prefixes; `kubectl apply -f .` applies
them all (the operator reconciles once the CRDs and operator are installed).

---

## 1. Prerequisites — install the Keycloak Operator + CloudNativePG

Both operators must be installed cluster-wide (or into a watched namespace)
**before** applying these manifests. The `crmf` namespace is owned by the
namespace/RBAC agent; create it first if it does not exist.

```bash
# --- CloudNativePG operator (shared with the timescaledb agent) -------------
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.0.yaml

# --- Keycloak Operator (v2alpha1 CRDs: Keycloak, KeycloakRealmImport) --------
# Pin to the Keycloak version matching the image in 00-keycloak.yaml (25.0.6).
KC_VERSION=25.0.6
kubectl apply -f \
  https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/${KC_VERSION}/kubernetes/keycloaks.k8s.keycloak.org-v1.yml
kubectl apply -f \
  https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/${KC_VERSION}/kubernetes/keycloakrealmimports.k8s.keycloak.org-v1.yml
kubectl apply -n crmf -f \
  https://raw.githubusercontent.com/keycloak/keycloak-k8s-resources/${KC_VERSION}/kubernetes/kubernetes.yml
```

Verify the CRDs are present:

```bash
kubectl get crd keycloaks.k8s.keycloak.org keycloakrealmimports.k8s.keycloak.org
kubectl get crd clusters.postgresql.cnpg.io
```

---

## 2. Apply the CRMF identity layer

```bash
# 1) Database first so Keycloak has somewhere to connect.
kubectl apply -f 01-keycloak-db.yaml
kubectl wait --for=condition=Ready cluster/crmf-keycloak-db -n crmf --timeout=300s

# 2) Keycloak server.
kubectl apply -f 00-keycloak.yaml
kubectl wait --for=condition=Ready keycloak/crmf-keycloak -n crmf --timeout=600s

# 3) Realm import (clients, roles, AD federation).
kubectl apply -f 02-realm.yaml
kubectl get keycloakrealmimport ongc -n crmf -o jsonpath='{.status.conditions}' | jq
```

> **Edit secrets before applying in production.** Replace the `ChangeMe-*`
> placeholders in `01-keycloak-db.yaml` (`crmf-keycloak-db-app`) and
> `02-realm.yaml` (`crmf-keycloak-ldap`) — ideally by sourcing them from Vault /
> the External Secrets Operator rather than committing real credentials.

### TLS / public exposure

TLS for `keycloak.ongc.local` is terminated at the **NGINX Ingress** with a
**cert-manager** certificate (cluster-issuer `letsencrypt-or-ongc-ca`). The
Ingress object that routes `keycloak.ongc.local` → the operator-managed
`crmf-keycloak-service:8080` is owned by the **Ingress agent**. `00-keycloak.yaml`
sets `ingress.enabled: false` and `proxy.headers: xforwarded` so Keycloak builds
correct `https://keycloak.ongc.local/...` URLs behind that proxy.

For **end-to-end TLS into the pod**, instead set `spec.http.tlsSecret:
crmf-keycloak-tls` (a cert-manager `Certificate` secret) and remove
`http.httpEnabled`.

---

## 3. ONGC Active Directory (LDAPS) federation

Configured in `02-realm.yaml` as a `ldap` user-storage provider on the `ongc`
realm:

- **Connection:** `ldaps://ad.ongc.local:636` (placeholder host — set to your
  AD). `useTruststoreSpi: ldapsOnly` — the LDAPS CA must be in Keycloak's
  truststore (mount it / add via the operator's truststore config).
- **Bind account:** `${LDAP_BIND_DN}` / `${LDAP_BIND_CREDENTIAL}`, injected from
  Secret `crmf-keycloak-ldap`. Use a low-privilege AD **service account** with
  read access to the users/groups OUs.
- **Vendor `ad`, `editMode: READ_ONLY`** — Keycloak imports users, never writes
  to AD.
- **Group mapper** maps AD security groups (`OU=Groups,DC=ongc,DC=local`) into
  Keycloak realm groups. Put the relevant AD users into the AD groups that
  correspond to the realm groups:

  | AD security group | Keycloak realm group | Realm role granted |
  |-------------------|----------------------|--------------------|
  | `rig-admins`      | `/rig-admins`        | `admin`            |
  | `rig-operators`   | `/rig-operators`     | `operator`         |
  | `rig-viewers`     | `/rig-viewers`       | `viewer`           |

  The realm's **group→role mappings** (in `02-realm.yaml`) then grant the
  matching realm role to every member transitively.

Trigger / inspect a sync:

```bash
# Logs of the running Keycloak pod will show LDAP full/changed sync activity.
kubectl logs -n crmf -l app=keycloak,app.kubernetes.io/name=crmf-keycloak -f
```

> **RBAC "by rig"** beyond the three coarse roles (e.g. per-rig scoping) is
> enforced in the backend from the AD group / OU membership carried in the
> token. Add finer-grained AD groups (e.g. `rig-NR12-operators`) and a matching
> group claim mapper if per-rig authorization is required; the three realm roles
> above are the baseline RBAC.

---

## 4. Token claims the backend expects

The backend (`crmf-backend`) is a **bearer-only** resource server. It validates
access tokens minted for the `crmf-portal` client and authorizes by realm role.

| Claim | Value | Source |
|-------|-------|--------|
| `iss` (issuer) | `https://keycloak.ongc.local/realms/ongc` | realm `ongc` |
| `aud` (audience) | `crmf-api` | `crmf-api-audience` mapper on the `crmf-api` client |
| `roles` | array of `admin` \| `operator` \| `viewer` | realm-role mapper (`oidc-usermodel-realm-role-mapper`) on the `roles` scope and the `crmf-api` client |
| `azp` | `crmf-portal` | issuing public client |

Discovery / JWKS endpoints:

```
OIDC discovery : https://keycloak.ongc.local/realms/ongc/.well-known/openid-configuration
JWKS (verify)  : https://keycloak.ongc.local/realms/ongc/protocol/openid-connect/certs
```

### Backend environment values (set in ConfigMap `crmf-config`)

```yaml
OIDC_ENABLED:  "true"
OIDC_ISSUER:   "https://keycloak.ongc.local/realms/ongc"
OIDC_JWKS_URI: "https://keycloak.ongc.local/realms/ongc/protocol/openid-connect/certs"
OIDC_AUDIENCE: "crmf-api"
```

The backend should:
1. Fetch JWKS from `OIDC_JWKS_URI` (cache + honor key rotation).
2. Verify token signature, `iss == OIDC_ISSUER`, `aud` contains `OIDC_AUDIENCE`,
   and `exp`/`nbf`.
3. Authorize requests against the `roles` claim (`admin` > `operator` >
   `viewer`).

### Frontend (SPA) OIDC config

```
authority    = https://keycloak.ongc.local/realms/ongc
client_id    = crmf-portal
redirect_uri = https://crmf.ongc.local/   (any path under https://crmf.ongc.local/*)
response_type = code            (Authorization Code + PKCE / S256)
scope        = openid profile email roles
```

---

## 5. Break-glass local admin (retained)

The Keycloak Operator bootstraps a **temporary local admin** in the **`master`**
realm and stores its credentials in a Secret named
**`crmf-keycloak-initial-admin`** in the `crmf` namespace. This local admin is
**independent of ONGC AD** and is the **break-glass** account — keep it for
recovery if AD/LDAPS is unreachable.

```bash
# Username (usually "admin") and password:
kubectl get secret crmf-keycloak-initial-admin -n crmf \
  -o jsonpath='{.data.username}' | base64 -d; echo
kubectl get secret crmf-keycloak-initial-admin -n crmf \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Operational guidance:
- After first login, **rotate** this password and store it in the org password
  vault; do not delete the account (it is the recovery path).
- The break-glass admin lives in `master`, **not** the `ongc` realm, so it is
  unaffected by AD outages or realm re-imports.
- Restrict admin-console exposure (the Ingress agent should limit
  `keycloak.ongc.local` admin paths to the ops network / VPN).

---

## 6. Wiring summary

```
ONGC AD (ldaps://ad.ongc.local)
        │  READ_ONLY federation + group mapper
        ▼
Keycloak realm "ongc"  (crmf-keycloak, 2 replicas)  ── DB ──▶  crmf-keycloak-db (CNPG, 2 replicas)
        │   clients: crmf-portal (public+PKCE), crmf-api (bearer-only)
        │   roles:   admin / operator / viewer   (via group→role mapping)
        │   token:   iss=…/realms/ongc  aud=crmf-api  roles=[…]
        ▼
crmf-portal (SPA) ──login──▶ access token ──Authorization: Bearer──▶ crmf-backend (verifies JWKS/iss/aud/roles)
```

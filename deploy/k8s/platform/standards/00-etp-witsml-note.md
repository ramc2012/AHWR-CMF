# Energistics standards endpoints — ETP 2.0 + WITSML 1.4.1 (CRMF interoperability)

CRMF exposes its rig telemetry to external/partner systems through the Energistics standard
interfaces so third-party WITSML clients and real-time consumers can subscribe without a
bespoke integration:

- **ETP 2.0** (Energistics Transfer Protocol) — a WebSocket + Avro streaming protocol for
  real-time channel data (the modern, low-latency feed). Endpoint: `wss://.../etp`.
- **WITSML 1.4.1.1** — the legacy SOAP/WS-* store interface (`WMLS_*` operations:
  `WMLS_GetFromStore`, `WMLS_AddToStore`, etc.) over HTTP. Endpoint: `https://.../witsml/store`.

Both are served by an **in-house** server image (`crmf/crmf-etp-witsml`) that reads from the
same TimescaleDB historian (`crmf-timescaledb-rw`) the rest of CRMF uses. **Read-only /
monitoring-only**: the server publishes CRMF data outward; it does not accept control writes
back to any rig/PLC. `WMLS_AddToStore`/`WMLS_DeleteFromStore` are disabled (it is a store
*provider*, not a sink).

## Deployment shape

```
                         ┌──────────────────────────────────────────┐
   external WITSML/ETP   │  Ingress (NGINX)  host: etp.ongc.local    │
   clients  ───────────▶ │   /etp        (wss, websocket, long TO)   │
                         │   /witsml     (https SOAP)                 │
                         └───────────────┬──────────────────────────┘
                                         ▼
                         Service crmf-etp-witsml (ClusterIP)
                            :8080 http   (WITSML SOAP)
                            :8443 etp    (ETP websocket)
                                         ▼
                         Deployment crmf-etp-witsml  ── reads ──▶ crmf-timescaledb-rw:5432
```

- **Deployment + Service** are provided as a minimal manifest in `01-etp-witsml.yaml`
  (placeholder image `crmf/crmf-etp-witsml`, two ports: `http` SOAP, `etp` websocket).
- **Ingress** is intentionally **not** created here to avoid colliding with the app Ingress
  owned by another agent. When wired, the ETP route needs the same websocket annotations as
  `/socket.io`:
  - `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`
  - websocket upgrade support (services/upgrade headers)
  on a dedicated host such as `etp.ongc.local`, TLS via the cert-manager ClusterIssuer
  `letsencrypt-or-ongc-ca` (see `../ingress/00-cert-manager-issuer.yaml`).

## Auth

ETP/WITSML clients authenticate with the platform OIDC (Keycloak) using the same
`OIDC_ISSUER`/`OIDC_AUDIENCE` the backend uses, or with a dedicated WITSML basic-auth
realm — both terminate at the in-house server, not at the rig.

## Status

The server image is in-house and built separately; this directory provides the **deployment
contract** (Service name `crmf-etp-witsml`, ports, env wiring to the historian) so the rest
of the platform can target it. Treat the bundled manifest as the runtime shape — point it at
the real image tag at rollout.

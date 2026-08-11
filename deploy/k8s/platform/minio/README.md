# MinIO — CRMF object store

S3-compatible object storage for the Centralised Rig Monitoring Facility. It backs three
concerns from the proposal (§5.1 reports/archives, §6.4 ML artifacts, §6.5 backups):

| Bucket         | Used by                                   | Contents                                              |
| -------------- | ----------------------------------------- | ----------------------------------------------------- |
| `crmf-reports` | backend report generator                  | Generated PDF/CSV rig reports, historian exports      |
| `crmf-backups` | CloudNativePG (barman-cloud), Kafka/MM2   | CNPG base backups + WAL archive, Kafka topic archives |
| `crmf-mlflow`  | MLflow tracking server, KServe            | Model artifacts, registered model versions            |

## What's in this directory

- `00-minio-tenant.yaml` — a single-node `StatefulSet` + `Service` (`minio`) + headless
  `Service` (`minio-hl`), a root-credentials `Secret` (`crmf-minio-credentials`), and a
  one-shot bucket-init `Job` that creates the three buckets and a 90-day lifecycle rule on
  `crmf-backups`. Chosen over the MinIO Operator `Tenant` CRD so the platform has **no hard
  dependency** on the operator. Bucket names, the `minio` Service, and the credentials
  contract are identical to the operator path below, so swapping later is non-breaking.

## Endpoints (in-cluster)

- S3 API:  `http://minio.crmf.svc.cluster.local:9000`
- Console: `http://minio.crmf.svc.cluster.local:9001`

## Credentials

Root access/secret keys live in the `crmf-minio-credentials` Secret
(`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`). The committed values are **defaults — rotate
them in production**. Preferably materialise this Secret from Vault via External Secrets
(see `../vault/01-secretstore.yaml`) and delete the inline `stringData` block.

For least-privilege access, create scoped service accounts/policies per consumer with
`mc admin user svcacct add` rather than handing the root key to MLflow/CNPG.

## Apply

```sh
kubectl apply -f 00-minio-tenant.yaml
kubectl -n crmf rollout status statefulset/minio
kubectl -n crmf wait --for=condition=complete job/minio-bucket-init --timeout=180s
kubectl -n crmf logs job/minio-bucket-init        # should list the 3 buckets
```

> The `default-deny-all` NetworkPolicy (`../01-network-baseline.yaml`) blocks traffic to
> MinIO by default. CNPG, MLflow, and the backend each ship their own NetworkPolicy
> allowing egress to the `minio` pods on 9000 — verify those exist if a consumer can't reach
> the store.

## Production HA alternative — MinIO Operator Tenant

For a real multi-node, erasure-coded deployment, install the MinIO Operator and replace the
StatefulSet with a `Tenant` CR (`minio.min.io/v2`), e.g. 4 servers × 4 drives:

```sh
kubectl apply -k "github.com/minio/operator?ref=v6.0.4"
```

```yaml
apiVersion: minio.min.io/v2
kind: Tenant
metadata:
  name: crmf-minio
  namespace: crmf
spec:
  configuration:
    name: crmf-minio-credentials   # same Secret as above (MINIO_ROOT_USER/PASSWORD)
  pools:
    - name: pool-0
      servers: 4
      volumesPerServer: 4
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 500Gi
```

Create the buckets either via `spec.buckets` on the Tenant or by re-using the
`minio-bucket-init` Job from this directory.

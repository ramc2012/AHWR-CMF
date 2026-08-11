# KServe model serving — CRMF inference (proposal §6.4, Phase 2 — SCAFFOLDED)

> **Status: Phase 2 / scaffolded.** No production CRMF path depends on these models yet.
> The monitoring-only contract is unchanged: model outputs are advisory annotations on the
> dashboard — inference **never** writes back to any rig/PLC.

## Models to serve

The fleet telemetry CRMF already ingests feeds three inference services:

| Model                  | Purpose                                                              | Inputs (from telemetry)                                  |
| ---------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| `hpu-condition`        | Hydraulic Power Unit condition / degradation classifier             | HPU pressure, temp, flow, motor current trends           |
| `hookload-anomaly`     | Hookload anomaly detection (stuck pipe, overpull, abnormal trends)  | Hookload, block position, RPM, ROP windows               |
| `npt-classifier`       | Non-Productive Time root-cause classifier                           | Multi-channel state vectors, rig activity codes          |

## Serving shape

Each model is a KServe `InferenceService` (`serving.kserve.io/v1beta1`) in the `crmf`
namespace, loading its artifact from MLflow's MinIO bucket (`s3://crmf-mlflow/...`). The
CRMF backend calls them over the in-cluster predict endpoint; results are streamed to the
dashboard via the existing Socket.IO path as advisory flags.

```yaml
# EXAMPLE — not applied in Phase 1. Requires KServe + a model-serving runtime installed.
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: hookload-anomaly
  namespace: crmf
  labels:
    app.kubernetes.io/part-of: crmf
    app.kubernetes.io/component: ml-serving
    crmf.ongc.local/phase: "2"
spec:
  predictor:
    serviceAccountName: crmf-mlflow          # carries MinIO/S3 creds for artifact pull
    model:
      modelFormat:
        name: sklearn                         # or onnx / mlflow flavor per model
      storageUri: "s3://crmf-mlflow/models/hookload-anomaly/Production"
      resources:
        requests:
          cpu: "100m"
          memory: "256Mi"
        limits:
          cpu: "1"
          memory: "1Gi"
```

The `hpu-condition` and `npt-classifier` services follow the same shape with their own
`storageUri` and `modelFormat`.

## Prerequisites (defer to Phase 2)

- KServe (and its dependency Knative Serving + a network layer, or KServe RawDeployment
  mode to avoid Knative) installed cluster-wide.
- A registered, `Production`-staged model version in MLflow for each service.
- A NetworkPolicy allowing backend -> InferenceService and InferenceService -> `minio:9000`.

## Why scaffold now

Logging experiments to MLflow (Phase 1, `00-mlflow.yaml`) from day one means that when
Phase 2 begins, promoting a model to a KServe `InferenceService` is a config change, not a
new platform build. Keeping serving out of Phase 1 avoids pulling Knative/KServe into the
critical path of a monitoring-only system.

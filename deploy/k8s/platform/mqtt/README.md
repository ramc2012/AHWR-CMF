# CRMF Ingestion Backbone — MQTT + Kafka

Proposal **§6.3 (per-rig device identity / MQTT-TLS)** and **§6.4 (Apache Kafka,
decoupled ingestion, derived channels)**.

This directory plus `../kafka/` make up the **ingestion backbone** of the
Centralised Rig Monitoring Facility (CRMF). It is a **monitoring-only** platform:
data flows **rig → central** only. Nothing here ever publishes commands, set
points, or any signal back to a rig or PLC.

```
                          ┌───────────────────────── central (k8s ns: crmf) ──────────────────────────┐
                          │                                                                             │
  rig-edge agent ─MQTT/TLS┼─► EMQX broker ─(rule-engine bridge)─► Kafka ─► stream proc ─► TimescaleDB   │
  (per-rig client cert)   │   (mqtts 8883)    OR standalone        topics    (derived)     (canonical)  │
                          │                   bridge Deployment      │                        ▲          │
  rig-edge agent ─HTTPS───┼─────────────────► backend POST /ingest ──┘  (produce to Kafka)    │          │
  (gzip store&forward)    │                   (JWT/INGEST_TOKEN)                               │          │
                          │   backend ◄── consume derived.channels ──────────────────────────┘          │
                          │      └─ /socket.io live fan-out, /api REST                                   │
                          └─────────────────────────────────────────────────────────────────────────────┘
```

Both ingress paths — **MQTT-TLS** and **HTTP `/ingest`** — converge on the same
Kafka topics and therefore the **same canonical store** (TimescaleDB). Consumers
never need to know which path a sample arrived on.

---

## Why two ingress paths

| Path | Used by | Strengths |
|------|---------|-----------|
| **MQTT-TLS** (EMQX, `00-emqx.yaml`) | Rigs with native MQTT device stacks; constrained/low-bandwidth links | Lightweight, per-message QoS, persistent sessions, strong per-device identity via client certs, push semantics |
| **HTTP `/ingest`** (backend) | Rigs running the rig-edge store-and-forward agent | Large **gzip batches**, simple firewall/proxy traversal, replays a backlog after reconnect, reuses existing JWT/`INGEST_TOKEN` auth |

Keeping both means a rig can use whichever fits its connectivity, and the central
platform still presents **one** ingestion contract downstream.

---

## Device-identity model (§6.3)

- Each rig is issued a **per-rig X.509 client certificate** with `CN = <rigId>`,
  signed by the CRMF CA (the same CA that signs the EMQX server cert so the
  broker can `verify_peer`).
- The `8883` **mqtts** listener requires a client cert
  (`verify = verify_peer`, `fail_if_no_peer_cert = true`).
- EMQX maps the cert **CN → MQTT username**, so the authenticated identity *is*
  the `rigId`. No shared passwords cross the wire.
- **Authorization (ACL)** restricts every rig to **publish only** under its own
  prefix and forbids all subscribes (monitoring-only):

  ```
  allow publish  rigs/${username}/telemetry        # ${username} == rigId == cert CN
  allow publish  rigs/${username}/telemetry/#
  allow publish  rigs/${username}/events/#
  allow publish  rigs/${username}/status
  deny  subscribe #
  deny  publish   #
  ```

  A rig therefore cannot read another rig's data, cannot read its own, and
  cannot reach any non-`rigs/<self>/…` topic.

- The `1883` plaintext listener exists for **in-cluster debugging only** and
  must not be exposed at the edge.

### MQTT topic namespace

```
rigs/<rigId>/telemetry            primary high-rate channel samples
rigs/<rigId>/telemetry/<group>    optional sub-grouping (e.g. /hpu, /drawworks)
rigs/<rigId>/events/alarm         ESD / lockout / threshold alarms (read-only)
rigs/<rigId>/events/connection    online/offline transitions
rigs/<rigId>/events/activity      operational state-change events
rigs/<rigId>/status               LWT / heartbeat (drives OFFLINE_SEC logic)
```

---

## MQTT → Kafka bridge (`01-mqtt-kafka-bridge.yaml`)

Device publishes are forwarded to Kafka so they share the canonical pipeline.
Two implementations are scaffolded; **Option A is preferred**:

- **Option A — EMQX rule-engine data bridge (no extra pod).** Rules on
  `rigs/+/telemetry/#` and `rigs/+/events/#` forward to Kafka with
  `key = ${clientid}` (the rigId) so records land on the right partition. This
  is configured inside EMQX and needs no separate Deployment.
- **Option B — standalone bridge Deployment.** A small MQTT client subscribes
  over mqtts and produces to Kafka, useful when payload normalisation /
  topic-mapping logic should live outside the broker. Placeholder image
  `crmf/crmf-mqtt-bridge`, shipped with `replicas: 0`.

Either way the bridge authenticates to Kafka as SCRAM user **`crmf-stream`**
(produce rights to `telemetry.ingest` and `events.*`).

| MQTT filter | Kafka topic |
|-------------|-------------|
| `rigs/+/telemetry/#` | `telemetry.ingest` |
| `rigs/+/events/alarm` | `events.alarm` |
| `rigs/+/events/connection` | `events.connection` |
| `rigs/+/events/activity` | `events.activity` |

---

## Kafka topic design (`../kafka/`)

Defined in `../kafka/01-topics.yaml` on cluster **`crmf-kafka`** (3 brokers,
KRaft, SCRAM-SHA-512, TLS listener `:9093`).

| Topic | Partitions | Retention / policy | Purpose |
|-------|-----------:|--------------------|---------|
| `telemetry.ingest` | 12 | 7d, `delete` | Canonical raw telemetry from **both** ingress paths |
| `events.alarm` | 6 | 30d, `delete` | ESD / lockout / threshold alarms (read-only signals) |
| `events.connection` | 6 | 30d, `delete` | Rig online/offline transitions |
| `events.activity` | 6 | 14d, `delete` | Operational activity / state-change events |
| `derived.channels` | 12 | `compact,delete`, 7d changelog | Latest-value-per-key derived signals |

**Partition key = `rigId`** (`rigId|channel` for `derived.channels`) so a rig's
stream stays ordered and co-partitioned across topics.

### Users & ACLs (`../kafka/02-users.yaml`)

- **`crmf-backend`** — produce `telemetry.ingest` + `events.*`; consume
  `derived.channels` (for `/socket.io` live fan-out). Read-only on derived.
- **`crmf-stream`** — consume `telemetry.ingest` + `events.*`; **sole producer**
  of `derived.channels`; owns its Kafka Streams internal topics.

Passwords are generated by the Strimzi **User Operator** into Secrets named
after each KafkaUser (`crmf-backend`, `crmf-stream`), separate from the platform
`crmf-secrets`.

### Derived channels (`../kafka/03-stream-processor.yaml`)

The scaffolded **`crmf-stream`** Kafka Streams job (placeholder image
`crmf/crmf-stream`, `replicas: 0`) computes and emits to `derived.channels`,
and materialises current state into TimescaleDB:

- **Hookload deviation** — measured vs modelled/expected hookload.
- **HPU efficiency index** — hydraulic power unit output/input ratio.
- **Trip-speed statistics** — rolling mean / percentiles of pipe trip rate.

---

## Apply order

```sh
# 1) Kafka cluster, topics, users, metrics
kubectl apply -f ../kafka/04-metrics-configmap.yaml
kubectl apply -f ../kafka/00-kafka.yaml
kubectl apply -f ../kafka/01-topics.yaml
kubectl apply -f ../kafka/02-users.yaml
kubectl apply -f ../kafka/03-stream-processor.yaml   # scaffold (replicas:0)

# 2) MQTT broker + bridge
kubectl apply -f 00-emqx.yaml
kubectl apply -f 01-mqtt-kafka-bridge.yaml           # scaffold (replicas:0)
```

Prerequisites: the **Strimzi** operator and (for the optional TLS Certificate)
**cert-manager** with cluster-issuer `letsencrypt-or-ongc-ca` must be installed
in the cluster. Namespace `crmf` and the platform `crmf-config` / `crmf-secrets`
are owned by other agents.

## Scaffold status

| Object | File | State |
|--------|------|-------|
| `crmf-stream` Deployment | `../kafka/03-stream-processor.yaml` | **scaffold** — `replicas: 0`, placeholder image |
| `crmf-mqtt-bridge` Deployment | `01-mqtt-kafka-bridge.yaml` | **scaffold** — `replicas: 0`, prefer EMQX rule-engine (Option A) |
| EMQX server TLS `Certificate` | `00-emqx.yaml` | commented — enable once the CA/cluster-issuer is live |
| Kafka external listener | `../kafka/00-kafka.yaml` | commented — in-cluster only by default |

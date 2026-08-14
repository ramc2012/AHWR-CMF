-- =====================================================================
-- CRMF — Centralised Rig Monitoring Facility
-- Canonical central data model (proposal §6.2) on TimescaleDB / PostgreSQL 16.
--
-- Monitoring-only platform: this schema only ever RECEIVES telemetry and
-- events from rig-edge systems. Nothing here is ever written back to a rig
-- or a PLC. (See repo rule: monitoring-only / no signal backflow.)
--
-- Runs once on first container start (mounted into /docker-entrypoint-initdb.d).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Rig master (proposal §6.2 "Rig") + live status rollup
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rigs (
    rig_id          TEXT PRIMARY KEY,                 -- device id, e.g. AHWR-50-3
    name            TEXT NOT NULL,
    section         TEXT,                             -- owner section
    asset_unit      TEXT,                             -- ONGC Asset/Basin (pan-ONGC: any unit)
    field           TEXT,                             -- e.g. Ankleshwar
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    commissioned_at DATE,
    device_token    TEXT,                             -- per-rig device credential (proposal §6.3)
    schema_version  TEXT,
    -- live rollup (updated on every ingest; lets the fleet view load in one query)
    status          TEXT    NOT NULL DEFAULT 'pending',  -- online | degraded | stale | offline | pending
    last_data_at    TIMESTAMPTZ,
    last_seq        BIGINT,
    sync_lag_sec    INTEGER,
    health_score    INTEGER DEFAULT 0,                -- 0-100 data-quality score
    metric_count    INTEGER DEFAULT 0,                -- distinct tags seen in last batch
    active_job      TEXT,                             -- current well / workover job
    active_activity TEXT,                             -- current rig activity (RIH, MAKE_UP, ...)
    alarm_active    INTEGER DEFAULT 0,
    alarm_unack     INTEGER DEFAULT 0,
    alarm_p1        INTEGER DEFAULT 0,
    alarm_p2        INTEGER DEFAULT 0,
    alarm_p3        INTEGER DEFAULT 0,
    alarm_highest   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest telemetry snapshot per rig (last-value cache, proposal §6.4 "Redis last-value").
-- Kept in Postgres for the MVP so the stack has no extra moving parts.
CREATE TABLE IF NOT EXISTS rig_latest (
    rig_id     TEXT PRIMARY KEY REFERENCES rigs(rig_id) ON DELETE CASCADE,
    ts         TIMESTAMPTZ,
    values     JSONB NOT NULL DEFAULT '{}'::jsonb      -- { "measurement.field": number, ... }
);

-- Operator messages from Central Control Room to a specific Edge rig app.
-- This is UI/database/WebSocket only; no PLC write path is involved.
CREATE TABLE IF NOT EXISTS rig_messages (
    message_id       TEXT PRIMARY KEY,
    target_rig_id    TEXT NOT NULL REFERENCES rigs(rig_id) ON DELETE CASCADE,
    target_rig_name  TEXT,
    message_type     TEXT NOT NULL DEFAULT 'General',
    message_text     TEXT NOT NULL,
    sender_username  TEXT NOT NULL,
    sender_display   TEXT,
    sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','acknowledged','failed')),
    delivered_at     TIMESTAMPTZ,
    acknowledged_at  TIMESTAMPTZ,
    acknowledged_by  TEXT,
    failed_at        TIMESTAMPTZ,
    failure_reason   TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rig_messages_target_idx ON rig_messages(target_rig_id, sent_at DESC);

-- ---------------------------------------------------------------------
-- Telemetry point (proposal §6.2) — TimescaleDB hypertable, long format
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry (
    ts      TIMESTAMPTZ      NOT NULL,
    rig_id  TEXT             NOT NULL,
    metric  TEXT             NOT NULL,                 -- "measurement.field"
    value   DOUBLE PRECISION NOT NULL
);
-- 1-HOUR chunks (was 1 day). Compression only ever acts on a CLOSED chunk, so
-- with day-long chunks a 1-hour compress policy still accrues a full day
-- (~28 GB at design load) of uncompressed data before the first chunk
-- becomes eligible. Hour chunks let compression keep pace with ingest.
SELECT create_hypertable('telemetry', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 hour');
CREATE INDEX IF NOT EXISTS telemetry_rig_metric_ts ON telemetry (rig_id, metric, ts DESC);

-- Native compression after 7 days (proposal §5.1 "hot storage, compressed").
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'rig_id, metric',
    timescaledb.compress_orderby   = 'ts DESC'
);
-- CAPACITY NOTE: at the proposal's design load (50 rigs x ~110 tags x 1 Hz) the
-- raw hypertable grows ~28 GB/DAY uncompressed, so a 7-day compress delay means
-- ~200 GB of uncompressed hot data before the first chunk is ever compressed —
-- it filled a 460 GB dev box in two days. Compress after 1 HOUR instead: the
-- hot window stays queryable, and segmentby (rig_id, metric) + orderby ts gives
-- ~10-20x on this shape. Override per deployment if a longer raw window is
-- genuinely needed.
SELECT add_compression_policy('telemetry',
    COALESCE(current_setting('ahwr.compress_after', true), '1 hour')::interval,
    if_not_exists => TRUE);

-- Continuous aggregate: 1-minute rollup (proposal §6.4 "continuous aggregates").
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       rig_id, metric,
       avg(value) AS avg, min(value) AS min, max(value) AS max
FROM telemetry
GROUP BY bucket, rig_id, metric
WITH NO DATA;
SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);

-- Real-time aggregation (audit #20): unmaterialised recent buckets fall back to
-- a union over raw telemetry, so long-range charts have no silent holes after a
-- refresh outage (overnight stop, maintenance, DB/backend restart > start_offset).
ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);

-- Idempotency for store-and-forward replays (audit #4): a UNIQUE index lets the
-- ingest path use ON CONFLICT DO NOTHING keyed on (rig_id, metric, ts). On a
-- hypertable the unique index MUST include the partitioning column (ts), which
-- it does. Plain (non-CONCURRENT) creation is safe at bootstrap.
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_rig_metric_ts_uniq
    ON telemetry (rig_id, metric, ts);

-- Raw retention. 5 years of RAW 1 Hz telemetry is ~51 TB at design load, which
-- no single PVC holds; the 1-minute continuous aggregate above is what actually
-- carries the long-range history (and is not dropped here). Keep raw bounded and
-- let the aggregate + cold archival serve anything older.
SELECT add_retention_policy('telemetry',
    COALESCE(current_setting('ahwr.raw_retention', true), '3 days')::interval,
    if_not_exists => TRUE);

-- ---------------------------------------------------------------------
-- Event stream (alarm / activity / connection events from the edge)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id       BIGSERIAL,
    ts       TIMESTAMPTZ NOT NULL,
    rig_id   TEXT        NOT NULL,
    type     TEXT        NOT NULL,                     -- alarm | connection | activity
    payload  JSONB       NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('events', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '7 days');
CREATE INDEX IF NOT EXISTS events_rig_ts  ON events (rig_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, ts DESC);

-- Replay dedup for events (audit #4): unique index supporting ON CONFLICT DO
-- NOTHING. Includes the partitioning column (ts) as required on a hypertable, and
-- a payload hash so a store-and-forward REPLAY (identical payload) dedups while
-- two genuinely distinct events of the same type at the same ts are both kept.
CREATE UNIQUE INDEX IF NOT EXISTS events_rig_ts_type_uniq
    ON events (rig_id, ts, type, md5(payload::text));

-- Data-retention policy (audit #3): drop event chunks older than 5 years.
SELECT add_retention_policy('events', INTERVAL '5 years', if_not_exists => TRUE);

-- Connection record (proposal §6.2 "Connection record") — torque-turn quality.
-- Time-series on the hot path, so it is a hypertable on ts (audit #21). The
-- partitioning column ts must be part of any PRIMARY KEY / UNIQUE constraint, so
-- the PK is (id, ts) rather than a standalone id.
CREATE TABLE IF NOT EXISTS connections (
    id          BIGSERIAL,
    ts          TIMESTAMPTZ NOT NULL,
    rig_id      TEXT NOT NULL,
    peak_torque DOUBLE PRECISION,
    result      TEXT,                                  -- PASS | FAIL
    joint       INTEGER,
    payload     JSONB,
    PRIMARY KEY (id, ts)
);
SELECT create_hypertable('connections', 'ts', if_not_exists => TRUE, migrate_data => TRUE, chunk_time_interval => INTERVAL '7 days');
CREATE INDEX IF NOT EXISTS connections_rig_ts ON connections (rig_id, ts DESC);

-- Replay dedup for connections (audit #4): the PK (id, ts) never conflicts because
-- id is a fresh BIGSERIAL on every insert, so ingest's ON CONFLICT DO NOTHING was a
-- no-op. This unique index on the business key (incl. the ts partition column + a
-- payload hash) makes a re-sent store-and-forward batch dedup correctly.
CREATE UNIQUE INDEX IF NOT EXISTS connections_rig_ts_uniq
    ON connections (rig_id, ts, md5(payload::text));

-- Same compression + retention strategy as telemetry/events (audit #21).
ALTER TABLE connections SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'rig_id',
    timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('connections', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('connections', INTERVAL '5 years', if_not_exists => TRUE);

-- ---------------------------------------------------------------------
-- Maintenance & Reliability (proposal §6.1, audit #7)
-- PM / calibration / breakdown / inspection records per rig. Manual-entry
-- and (future) condition-based triggers feed PM-compliance and MTBF/MTTR.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maintenance_record (
    id            BIGSERIAL PRIMARY KEY,
    rig_id        TEXT REFERENCES rigs(rig_id) ON DELETE CASCADE,
    type          TEXT CHECK (type IN ('PM','calibration','breakdown','inspection')),
    title         TEXT NOT NULL,
    status        TEXT DEFAULT 'open',                 -- open | in_progress | done | overdue
    due_date      DATE,
    performed_at  TIMESTAMPTZ,
    runtime_hours DOUBLE PRECISION,
    outcome       TEXT,
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_record_rig_due ON maintenance_record (rig_id, due_date);

-- ---------------------------------------------------------------------
-- Alarm notifications (proposal §6.1 alarm command centre — escalation):
-- outbound webhook/email channels + a dispatch log. Monitoring-only: these are
-- alerts ABOUT received data; nothing is ever sent toward a rig/PLC.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_channels (
    id           BIGSERIAL PRIMARY KEY,
    type         TEXT NOT NULL,                          -- webhook | email
    name         TEXT,
    target       TEXT NOT NULL,                          -- webhook URL or email address
    min_severity TEXT NOT NULL DEFAULT 'P1',             -- notify at/above this severity (P1|P2|P3)
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
    id             BIGSERIAL PRIMARY KEY,
    ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
    rig_id         TEXT,
    severity       TEXT,                                 -- P1 | P2 | P3
    kind           TEXT,                                 -- raised | escalated | test
    channel_type   TEXT,
    channel_target TEXT,
    status         TEXT,                                 -- sent | failed
    error          TEXT,
    payload        JSONB
);
CREATE INDEX IF NOT EXISTS notifications_ts ON notifications (ts DESC);

-- ---------------------------------------------------------------------
-- Standard tag dictionary / config registry (proposal §6.1, §6.2 "Tag")
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
    metric        TEXT PRIMARY KEY,                    -- "measurement.field"
    label         TEXT,
    unit          TEXT,
    group_name    TEXT,                                -- Hoisting & load, HPU, ...
    sample_hz     DOUBLE PRECISION DEFAULT 1,
    expected      BOOLEAN DEFAULT TRUE                 -- counted toward completeness score
);

-- ---------------------------------------------------------------------
-- Governance & rollout workspace (proposal §6.1, §6.2 "Deployment status")
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_status (
    rig_id          TEXT PRIMARY KEY REFERENCES rigs(rig_id) ON DELETE CASCADE,
    gate            TEXT DEFAULT 'gate0',              -- gate0 | discovery | implementation | operation | live
    edge_version    TEXT,
    commissioning   TEXT DEFAULT 'planned',           -- planned | in_progress | commissioned
    site_ready      BOOLEAN DEFAULT FALSE,
    security_review BOOLEAN DEFAULT FALSE,
    adoption_pct    INTEGER DEFAULT 0,
    open_issues     INTEGER DEFAULT 0,
    wave            INTEGER,
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Escalation register for stalled deployments (proposal §6.1).
CREATE TABLE IF NOT EXISTS escalations (
    id         BIGSERIAL PRIMARY KEY,
    rig_id     TEXT REFERENCES rigs(rig_id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    severity   TEXT DEFAULT 'medium',                  -- low | medium | high
    status     TEXT DEFAULT 'open',                    -- open | in_progress | resolved
    owner      TEXT,
    opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    notes      TEXT
);

-- Decision log (proposal §6.1 "decision log").
CREATE TABLE IF NOT EXISTS decisions (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    title     TEXT NOT NULL,
    detail    TEXT,
    author    TEXT
);

-- Value-realization metrics (proposal §6.2 "Value metric", §7).
CREATE TABLE IF NOT EXISTS value_metrics (
    id          BIGSERIAL PRIMARY KEY,
    kpi         TEXT NOT NULL,
    category    TEXT,
    baseline    DOUBLE PRECISION,
    target      DOUBLE PRECISION,
    actual      DOUBLE PRECISION,
    unit        TEXT,
    period      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Users & access (proposal §6.1 "User & access management")
-- Local accounts + break-glass admin; AD/SSO federates on top in production.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    username    TEXT PRIMARY KEY,
    password    TEXT NOT NULL,                         -- bcrypt hash
    display     TEXT,
    role        TEXT NOT NULL DEFAULT 'viewer',        -- admin | operator | viewer
    source      TEXT NOT NULL DEFAULT 'local',         -- local | ad
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Account enable/disable for user-management (audit #8). Disabled accounts are
-- rejected at login (auth.login()) without deleting their history.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Immutable audit log (proposal §6.5 "Audit").
CREATE TABLE IF NOT EXISTS audit_log (
    id        BIGSERIAL PRIMARY KEY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor     TEXT,
    action    TEXT NOT NULL,
    target    TEXT,
    detail    JSONB
);

-- Append-only enforcement at the SQL level (audit #2, proposal §6.5).
-- A BEFORE UPDATE OR DELETE trigger raises, so the trail cannot be rewritten or
-- erased even by the row owner; only INSERT and SELECT are permitted in practice.
-- (TRUNCATE is additionally blocked from the app via the crmf_app grants below.)
CREATE OR REPLACE FUNCTION audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutate ON audit_log;
CREATE TRIGGER audit_log_no_mutate
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ---------------------------------------------------------------------
-- App settings (user-configurable: storage retention, update rate, offline
-- threshold, …) and user presence/liveness (who is currently signed in).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
    username   TEXT PRIMARY KEY,
    display    TEXT,
    role       TEXT,
    source     TEXT,                                  -- local | ldap | ad
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip         TEXT
);
CREATE INDEX IF NOT EXISTS user_sessions_seen ON user_sessions (last_seen DESC);

-- ---------------------------------------------------------------------
-- Well management (WITSML-inspired: Well -> run/wellbore -> logs). A well is a
-- first-class lifecycle entity; a "well_run" links telemetry to a well over a
-- time window (a rig working that well), so a well's recorded data — incl. past
-- runs for offline EDR replay — is queryable by well. (Ref: WellView/Peloton,
-- Pason DataHub, WITSML data model.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wells (
    well_id        TEXT PRIMARY KEY,                 -- UWI / well name, e.g. GS-11#4
    name           TEXT NOT NULL,
    uwi            TEXT,                             -- unique well identifier / API no.
    well_type      TEXT,                             -- production|injection|exploration|appraisal|workover
    service_type   TEXT,
    status         TEXT NOT NULL DEFAULT 'planned',  -- planned|drilling|completed|producing|workover|suspended|abandoned
    field          TEXT,
    asset_unit     TEXT,
    country        TEXT,
    company_man    TEXT,
    toolpusher     TEXT,
    objective      TEXT,
    location       TEXT,
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    spud_date      DATE,
    td_date        DATE,
    total_depth    DOUBLE PRECISION,                 -- m
    operator       TEXT,
    block_lease    TEXT,
    current_rig_id TEXT REFERENCES rigs(rig_id) ON DELETE SET NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wells_asset ON wells (asset_unit);

-- A run = a rig working a well over [started_at, ended_at]. Telemetry on rig_id
-- within that window belongs to this well — the basis for per-well stored data
-- and offline past-run EDR replay. ended_at NULL = the currently-active run.
CREATE TABLE IF NOT EXISTS well_runs (
    id          BIGSERIAL PRIMARY KEY,
    well_id     TEXT REFERENCES wells(well_id) ON DELETE CASCADE,
    rig_id      TEXT REFERENCES rigs(rig_id) ON DELETE SET NULL,
    job_no      TEXT,
    service     TEXT,
    started_by  TEXT,
    joints      INTEGER,
    depth_delta DOUBLE PRECISION,
    productive_sec DOUBLE PRECISION,
    npt_sec     DOUBLE PRECISION,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,
    summary     TEXT
);
CREATE INDEX IF NOT EXISTS well_runs_well ON well_runs (well_id, started_at DESC);
CREATE INDEX IF NOT EXISTS well_runs_rig_active ON well_runs (rig_id) WHERE ended_at IS NULL;

-- ---------------------------------------------------------------------
-- Central -> rig operator messaging, and later-added well/run columns.
--
-- These objects used to be created at BOOT by backend/lib/db.js
-- ensureAppMigrations(). That only worked because the backend was connecting as
-- the schema OWNER: a least-privilege crmf_app has no CREATE on schema public,
-- so the app crash-looped with "permission denied for schema public" and the
-- deployment was "fixed" by downgrading PGUSER to the owner — which silently
-- disabled the append-only audit protection this whole section exists for.
-- Schema changes belong here, owner-run at init; the app only backfills DATA.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rig_messages (
    message_id      TEXT PRIMARY KEY,
    target_rig_id   TEXT NOT NULL REFERENCES rigs(rig_id) ON DELETE CASCADE,
    target_rig_name TEXT,
    message_type    TEXT NOT NULL DEFAULT 'General',
    message_text    TEXT NOT NULL,
    sender_username TEXT NOT NULL,
    sender_display  TEXT,
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    status          TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent','delivered','acknowledged','failed')),
    delivered_at    TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    failed_at       TIMESTAMPTZ,
    failure_reason  TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rig_messages_target_idx
    ON rig_messages (target_rig_id, sent_at DESC);

ALTER TABLE wells
    ADD COLUMN IF NOT EXISTS service_type TEXT,
    ADD COLUMN IF NOT EXISTS country      TEXT,
    ADD COLUMN IF NOT EXISTS company_man  TEXT,
    ADD COLUMN IF NOT EXISTS toolpusher   TEXT,
    ADD COLUMN IF NOT EXISTS objective    TEXT,
    ADD COLUMN IF NOT EXISTS location     TEXT;

ALTER TABLE well_runs
    ADD COLUMN IF NOT EXISTS service        TEXT,
    ADD COLUMN IF NOT EXISTS started_by     TEXT,
    ADD COLUMN IF NOT EXISTS joints         INTEGER,
    ADD COLUMN IF NOT EXISTS depth_delta    DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS productive_sec DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS npt_sec        DOUBLE PRECISION;

-- ---------------------------------------------------------------------
-- Ingest-concurrency hardening (fleet-scale review).
-- ---------------------------------------------------------------------
-- Sender attribution: which transport wrote a telemetry row ('sync' HTTP
-- store-and-forward, 'etp' live stream, ...). Nullable, not part of the dedup
-- key; exists so two publishers under one rig_id are separable after the fact.
ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS source TEXT;

-- Sender epoch: identifies the incarnation of a rig's seq counter (minted by
-- the edge when its sync state is created). last_seq comparisons are scoped to
-- it, replacing the backward-jump-magnitude heuristic with a deterministic
-- answer. seq_conflict_at flags a detected multi-sender / seq-domain conflict
-- for the fleet API (fleet.js selects r.*, so it surfaces without a UI change).
ALTER TABLE rigs ADD COLUMN IF NOT EXISTS sender_epoch    TEXT;
ALTER TABLE rigs ADD COLUMN IF NOT EXISTS seq_conflict_at TIMESTAMPTZ;

-- INVARIANT: at most one open run per rig. Its absence let two writers each
-- open a run for the same rig, and forced every writer into wide sweep UPDATEs
-- whose lock footprints collided (the observed 40P01 deadlocks). Close any
-- duplicates (keep the newest) before creating the index, so init re-runs and
-- migrated volumes both converge.
UPDATE well_runs SET ended_at = COALESCE(ended_at, now())
 WHERE ended_at IS NULL AND id NOT IN (
    SELECT DISTINCT ON (rig_id) id FROM well_runs
     WHERE ended_at IS NULL ORDER BY rig_id, started_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS well_runs_one_open_per_rig
    ON well_runs (rig_id) WHERE ended_at IS NULL;

-- Both predicates are hit (and their rows locked) on every batch that touches a
-- well; unindexed they were seq scans that locked rows in heap order.
CREATE INDEX IF NOT EXISTS wells_name_idx ON wells (name);
CREATE INDEX IF NOT EXISTS wells_current_rig_idx
    ON wells (current_rig_id) WHERE current_rig_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- CMMS mirror (edge -> central). The rig edge is the SYSTEM OF RECORD for
-- maintenance; central holds the latest snapshot per rig purely so the fleet
-- Maintenance view can render asset health, PM, work orders, the maintenance
-- log, downtime/NPT and instruments without querying 50 rigs directly.
-- One row per rig, replaced wholesale on each snapshot: idempotent, and a
-- missed event self-heals on the next one.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rig_cmms (
    rig_id       TEXT PRIMARY KEY REFERENCES rigs(rig_id) ON DELETE CASCADE,
    snapshot     JSONB NOT NULL,
    generated_at TIMESTAMPTZ,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accumulating CMMS HISTORY (unlike rig_cmms, these are never replaced):
-- downtime/NPT records and maintenance-log entries upserted from each
-- cmms.snapshot by ingest's persistCmmsHistory. Conflict keys match the
-- ON CONFLICT targets in backend/lib/ingest.js.
CREATE TABLE IF NOT EXISTS rig_downtime (
    rig_id       TEXT NOT NULL,
    record_id    TEXT NOT NULL,
    asset_id     TEXT,
    asset        TEXT,
    reason_code  TEXT,
    start_ts     TIMESTAMPTZ,
    end_ts       TIMESTAMPTZ,
    duration_min DOUBLE PRECISION,
    notes        TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rig_id, record_id)
);
CREATE INDEX IF NOT EXISTS rig_downtime_rig_start_idx ON rig_downtime(rig_id, start_ts DESC);

CREATE TABLE IF NOT EXISTS rig_maint_log (
    rig_id          TEXT NOT NULL,
    entry_id        TEXT NOT NULL,
    log_type        TEXT,
    category        TEXT,
    asset_id        TEXT,
    asset           TEXT,
    text            TEXT,
    by_who          TEXT,
    shift           TEXT,
    notification_no TEXT,
    at_ts           TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rig_id, entry_id)
);
CREATE INDEX IF NOT EXISTS rig_maint_log_rig_at_idx ON rig_maint_log(rig_id, at_ts DESC);

-- ---------------------------------------------------------------------
-- Least-privilege application role (audit #2).
-- The bootstrap/owner role (crmf, a superuser) creates the schema, but the
-- running application SHOULD connect as crmf_app in production. crmf_app is a
-- non-superuser with INSERT-only on audit_log (no UPDATE/DELETE/TRUNCATE) and
-- ordinary DML on the operational tables. Combined with the append-only trigger
-- this gives a tamper-evident, non-rewritable audit trail.
-- Idempotent: re-running init re-applies grants without erroring.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmf_app') THEN
        CREATE ROLE crmf_app NOSUPERUSER NOCREATEDB NOCREATEROLE LOGIN;
    END IF;
END;
$$;

COMMENT ON ROLE crmf_app IS
    'Least-privilege CRMF application role. Production app connections SHOULD use crmf_app (not the superuser owner): INSERT-only on audit_log + DML on operational tables.';

-- Schema usage.
GRANT USAGE ON SCHEMA public TO crmf_app;

-- Operational tables: full DML (SELECT/INSERT/UPDATE/DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    rigs, rig_latest, telemetry, events, connections, tags,
    deployment_status, escalations, decisions, value_metrics,
    maintenance_record, users, notification_channels, notifications,
    app_settings, user_sessions, wells, well_runs, rig_messages, rig_cmms,
    rig_downtime, rig_maint_log
    TO crmf_app;

-- The continuous aggregate is read-only for the app.
GRANT SELECT ON telemetry_1m TO crmf_app;

-- Audit log: INSERT + SELECT only — never UPDATE/DELETE/TRUNCATE.
GRANT SELECT, INSERT ON audit_log TO crmf_app;

-- Sequences backing the BIGSERIAL keys (needed for INSERT).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crmf_app;

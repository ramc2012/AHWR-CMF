'use strict';
// PostgreSQL / TimescaleDB connection pool for the CRMF.
// The schema itself is created by db/init.sql on first container start; here we
// only connect and wait until the database is reachable (compose ordering can
// race the DB becoming ready even with depends_on: healthy).
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PGHOST || 'timescaledb',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'crmf',
    password: process.env.PGPASSWORD || 'crmf',
    database: process.env.PGDATABASE || 'crmf',
    // 50 rigs at 10s batches means bursts of ~5 concurrent ingest transactions
    // plus portal/fleet queries; 10 connections queued unboundedly under load.
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: 30000,
    // Bound the wait for a pooled client. Without this, pool exhaustion queued
    // requests forever instead of shedding load — a stalled DB turned into an
    // unbounded backlog of open HTTP requests rather than fast 5xx retries
    // (the edge's store-and-forward treats a 5xx as transient and re-sends).
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

const query = (text, params) => pool.query(text, params);

// Schema objects are owned by db/init.sql, which runs as the DB owner at init.
// The application connects as the least-privilege crmf_app (audit #2) and has no
// CREATE on schema public, so DDL from here raises 42501 insufficient_privilege.
// We still attempt it, because a deployment that connects as the owner (or an
// older volume created before init.sql carried these objects) relies on this
// self-migration — but a privilege error is EXPECTED and must not crash boot.
// Anything genuinely wrong (missing table, bad SQL) still throws.
const INSUFFICIENT_PRIVILEGE = '42501';

async function tryDdl(sql) {
    try {
        await pool.query(sql);
    } catch (e) {
        if (e && e.code === INSUFFICIENT_PRIVILEGE) return false; // init.sql owns it
        throw e;
    }
    return true;
}

// Fail fast and clearly if a schema object the app depends on is absent, rather
// than surfacing it later as a confusing runtime 500 on the first message send.
async function assertSchemaObject(table) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS oid', [`public.${table}`]);
    if (!rows[0] || !rows[0].oid) {
        throw new Error(
            `required table "${table}" is missing and this connection cannot create it. ` +
            'Recreate the volume so db/init.sql runs, or apply init.sql as the DB owner.');
    }
}

const MIGRATION_REMEDY =
    'this volume predates the ingest-concurrency migration and the app role cannot apply DDL. ' +
    'Run the "Ingest-concurrency hardening" section of db/init.sql once as the DB owner ' +
    '(e.g. docker exec -i <db-container> psql -U <owner> -d <db> < db/init.sql), then restart.';

async function assertColumn(table, column) {
    const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column]);
    if (!rows.length) throw new Error(`required column ${table}.${column} is missing — ${MIGRATION_REMEDY}`);
}

async function assertIndex(indexName) {
    const { rows } = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [indexName]);
    if (!rows.length) throw new Error(`required index ${indexName} is missing — ${MIGRATION_REMEDY}`);
}

async function ensureAppMigrations() {
    await tryDdl(`
        CREATE TABLE IF NOT EXISTS rig_messages (
            message_id TEXT PRIMARY KEY,
            target_rig_id TEXT NOT NULL REFERENCES rigs(rig_id) ON DELETE CASCADE,
            target_rig_name TEXT,
            message_type TEXT NOT NULL DEFAULT 'General',
            message_text TEXT NOT NULL,
            sender_username TEXT NOT NULL,
            sender_display TEXT,
            sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','delivered','acknowledged','failed')),
            delivered_at TIMESTAMPTZ,
            acknowledged_at TIMESTAMPTZ,
            acknowledged_by TEXT,
            failed_at TIMESTAMPTZ,
            failure_reason TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await tryDdl(`ALTER TABLE rig_messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'General'`);
    await tryDdl(`CREATE INDEX IF NOT EXISTS rig_messages_target_idx ON rig_messages(target_rig_id, sent_at DESC)`);
    await tryDdl(`
        ALTER TABLE wells
          ADD COLUMN IF NOT EXISTS service_type TEXT,
          ADD COLUMN IF NOT EXISTS country TEXT,
          ADD COLUMN IF NOT EXISTS company_man TEXT,
          ADD COLUMN IF NOT EXISTS toolpusher TEXT,
          ADD COLUMN IF NOT EXISTS objective TEXT,
          ADD COLUMN IF NOT EXISTS location TEXT
    `);
    await tryDdl(`
        ALTER TABLE well_runs
          ADD COLUMN IF NOT EXISTS service TEXT,
          ADD COLUMN IF NOT EXISTS started_by TEXT,
          ADD COLUMN IF NOT EXISTS joints INTEGER,
          ADD COLUMN IF NOT EXISTS depth_delta DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS productive_sec DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS npt_sec DOUBLE PRECISION
    `);
    // Ingest-concurrency hardening (same DDL as init.sql; owner-run setups
    // self-migrate here, crmf_app deployments get it from init.sql / manual DDL).
    await tryDdl(`ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS source TEXT`);
    await tryDdl(`ALTER TABLE rigs ADD COLUMN IF NOT EXISTS sender_epoch TEXT`);
    await tryDdl(`ALTER TABLE rigs ADD COLUMN IF NOT EXISTS seq_conflict_at TIMESTAMPTZ`);
    // Close duplicate open runs (keep the newest per rig) BEFORE the unique
    // index: plain DML, so it runs under either role, and it prevents the index
    // build from failing with 23505 on a volume that accumulated duplicates.
    await pool.query(`
        UPDATE well_runs SET ended_at = COALESCE(ended_at, now())
         WHERE ended_at IS NULL AND id NOT IN (
            SELECT DISTINCT ON (rig_id) id FROM well_runs
             WHERE ended_at IS NULL ORDER BY rig_id, started_at DESC, id DESC)`);
    await tryDdl(`CREATE UNIQUE INDEX IF NOT EXISTS well_runs_one_open_per_rig
        ON well_runs (rig_id) WHERE ended_at IS NULL`);
    await tryDdl(`CREATE INDEX IF NOT EXISTS wells_name_idx ON wells (name)`);
    await tryDdl(`CREATE INDEX IF NOT EXISTS wells_current_rig_idx
        ON wells (current_rig_id) WHERE current_rig_id IS NOT NULL`);
    await assertSchemaObject('rig_messages');
    // The ingest path SELECTs/UPDATEs these unconditionally and its well_runs
    // INSERTs name the partial unique index as conflict target — if the tryDdl
    // calls above were skipped for privilege (crmf_app cannot DDL) on a volume
    // whose owner-run migration never happened, every batch would fail with a
    // confusing 42703/42P10 instead. Fail AT BOOT with the remediation.
    await assertColumn('rigs', 'sender_epoch');
    await assertColumn('rigs', 'seq_conflict_at');
    await assertIndex('well_runs_one_open_per_rig');
    // --- data backfills below: ordinary DML, within crmf_app's grants ---
    await pool.query(`
        UPDATE wells w
        SET current_rig_id = NULL, updated_at = now()
        FROM rigs r
        WHERE w.current_rig_id = r.rig_id
          AND COALESCE(r.active_job, '') = ''
          AND w.well_id ~ '^GS-[0-9]+#[0-9]+$'
    `);
    await pool.query(`
        UPDATE rigs
        SET field = 'Ankleshwar',
            asset_unit = 'Ankleshwar',
            updated_at = now()
        WHERE rig_id = 'AHWR-50-6'
          AND (field = 'Mumbai High' OR asset_unit = 'Mumbai High')
    `);
    await pool.query(`
        UPDATE wells
        SET field = 'ANKLESHWAR',
            asset_unit = 'Ankleshwar',
            location = COALESCE(location, 'ANK'),
            operator = COALESCE(operator, 'ONGC'),
            updated_at = now()
        WHERE current_rig_id = 'AHWR-50-6'
          AND (field = 'Mumbai High' OR asset_unit = 'Mumbai High')
    `);
}

// Block until the DB answers a trivial query (bounded retry on boot).
async function waitForDb(retries = 30, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT 1');
            // init.sql may still be applying on a brand-new volume — wait for a core table.
            await pool.query('SELECT 1 FROM rigs LIMIT 1').catch(() => {
                throw new Error('schema not ready');
            });
            await ensureAppMigrations();
            return;
        } catch (e) {
            console.log(`Waiting for TimescaleDB (${i + 1}/${retries}): ${e.message}`);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw new Error('TimescaleDB not reachable / schema not initialised');
}

module.exports = { pool, query, waitForDb };

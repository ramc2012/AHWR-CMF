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
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

const query = (text, params) => pool.query(text, params);

async function ensureAppMigrations() {
    await pool.query(`
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
    await pool.query(`ALTER TABLE rig_messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'General'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS rig_messages_target_idx ON rig_messages(target_rig_id, sent_at DESC)`);
    await pool.query(`
        ALTER TABLE wells
          ADD COLUMN IF NOT EXISTS service_type TEXT,
          ADD COLUMN IF NOT EXISTS country TEXT,
          ADD COLUMN IF NOT EXISTS company_man TEXT,
          ADD COLUMN IF NOT EXISTS toolpusher TEXT,
          ADD COLUMN IF NOT EXISTS objective TEXT,
          ADD COLUMN IF NOT EXISTS location TEXT
    `);
    await pool.query(`
        ALTER TABLE well_runs
          ADD COLUMN IF NOT EXISTS service TEXT,
          ADD COLUMN IF NOT EXISTS started_by TEXT,
          ADD COLUMN IF NOT EXISTS joints INTEGER,
          ADD COLUMN IF NOT EXISTS depth_delta DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS productive_sec DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS npt_sec DOUBLE PRECISION
    `);
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

'use strict';
// =====================================================================
// Well management (WITSML / WellView / Peloton-inspired). A WELL is a
// first-class lifecycle entity (planning -> drilling -> completion ->
// workover -> abandonment). A WELL_RUN links telemetry to a well over a
// time window (a rig working that well), so a well's recorded data — incl.
// PAST runs for OFFLINE EDR replay — is queryable by well.
//
// MONITORING-ONLY: nothing here is ever written back to a rig or PLC. Run
// tracking is a passive side-effect of receiving ingest that carried a job.
// =====================================================================
const { query, pool } = require('./db');

// Lifecycle enums (mirror db/init.sql column comments).
const WELL_STATUSES = ['planned', 'drilling', 'completed', 'producing', 'workover', 'suspended', 'abandoned'];
const WELL_TYPES = ['production', 'injection', 'exploration', 'appraisal', 'workover'];

// well_id / name must be a sane identifier (same character class as rigId).
const ID_RE = /^[A-Za-z0-9 .#_/-]{2,64}$/;

const err = (msg, status) => Object.assign(new Error(msg), { status });

// Map a raw wells row -> the camelCase contract shape used by the API.
function rowToWell(r) {
    return {
        wellId: r.well_id,
        name: r.name,
        uwi: r.uwi,
        wellType: r.well_type,
        serviceType: r.service_type,
        status: r.status,
        field: r.field,
        assetUnit: r.asset_unit,
        country: r.country,
        companyMan: r.company_man,
        toolpusher: r.toolpusher,
        objective: r.objective,
        location: r.location,
        latitude: r.latitude,
        longitude: r.longitude,
        spudDate: r.spud_date,
        tdDate: r.td_date,
        totalDepth: r.total_depth,
        operator: r.operator,
        blockLease: r.block_lease,
        currentRigId: r.current_rig_id,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

// ---------------------------------------------------------------------
// READ: list (proposal §6.1 — Wells list). activeRun = EXISTS an open run.
// ---------------------------------------------------------------------
async function getWells({ assetUnit, status, q } = {}) {
    // No rig-attachment filter: the registry is the WELL's lifecycle, not the
    // rig's. Producing / planned / suspended / abandoned wells are by definition
    // not on a rig — the old `current_rig_id IS NOT NULL` clause meant the Wells
    // page could only ever display in-workover wells and the other KPI tiles
    // were structurally pinned at zero.
    const where = [], vals = [];
    if (assetUnit) { vals.push(assetUnit); where.push(`w.asset_unit = $${vals.length}`); }
    if (status) { vals.push(status); where.push(`w.status = $${vals.length}`); }
    if (q) {
        vals.push(`%${String(q).toLowerCase()}%`);
        const i = vals.length;
        where.push(`(lower(w.name) LIKE $${i} OR lower(w.well_id) LIKE $${i} OR lower(COALESCE(w.uwi,'')) LIKE $${i} OR lower(COALESCE(w.field,'')) LIKE $${i})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // current_operation: what is being DONE on the well right now — the attached
    // rig's live activity code (RIH / POOH / MILLING / CDR / ...), present only
    // while a rig is actually on the well. This is the operational axis the
    // Wells page categorises by; lifecycle status is the well's own state.
    const { rows } = await query(
        `SELECT w.well_id, w.name, w.uwi, w.well_type, w.service_type, w.status, w.asset_unit, w.field,
                w.total_depth, w.current_rig_id, w.spud_date, w.td_date,
                CASE WHEN w.current_rig_id IS NOT NULL THEN r.active_activity END AS current_operation,
                EXISTS (SELECT 1 FROM well_runs wr WHERE wr.well_id = w.well_id AND wr.ended_at IS NULL) AS active_run,
                (SELECT wr2.rig_id FROM well_runs wr2 WHERE wr2.well_id = w.well_id ORDER BY wr2.started_at DESC LIMIT 1) AS last_rig_id
         FROM wells w
         LEFT JOIN rigs r ON r.rig_id = w.current_rig_id ${clause}
         ORDER BY w.well_id`, vals);
    return rows.map((r) => ({
        wellId: r.well_id,
        name: r.name,
        uwi: r.uwi,
        wellType: r.well_type,
        serviceType: r.service_type,
        status: r.status,
        assetUnit: r.asset_unit,
        field: r.field,
        totalDepth: r.total_depth,
        currentRigId: r.current_rig_id,
        currentOperation: r.current_operation || null,
        spudDate: r.spud_date,
        tdDate: r.td_date,
        lastRigId: r.last_rig_id,
        activeRun: r.active_run === true,
    }));
}

// Shared runs query: newest first; durationSec spans to now() when active.
async function runsForWell(wellId) {
    const { rows } = await query(
        `SELECT id, rig_id, job_no, service, started_by, joints, depth_delta, productive_sec, npt_sec,
                started_at, ended_at,
                EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at))::bigint AS duration_sec,
                (ended_at IS NULL) AS active
         FROM well_runs WHERE well_id = $1 ORDER BY started_at DESC`, [wellId]);
    return rows.map((r) => ({
        id: Number(r.id),
        rigId: r.rig_id,
        jobNo: r.job_no,
        service: r.service,
        startedBy: r.started_by,
        joints: r.joints == null ? null : Number(r.joints),
        depthDelta: r.depth_delta == null ? null : Number(r.depth_delta),
        productiveSec: r.productive_sec == null ? null : Number(r.productive_sec),
        nptSec: r.npt_sec == null ? null : Number(r.npt_sec),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
        active: r.active === true,
    }));
}

// ---------------------------------------------------------------------
// READ: well detail + runs + stats (proposal §6.1 — Well drill-down).
// ---------------------------------------------------------------------
async function getWell(id) {
    const { rows } = await query('SELECT * FROM wells WHERE well_id = $1', [id]);
    if (!rows.length) throw err('well not found', 404);
    const runs = await runsForWell(id);
    const stats = {
        runCount: runs.length,
        totalRuntimeSec: runs.reduce((s, r) => s + (r.durationSec || 0), 0),
    };
    return { ...rowToWell(rows[0]), runs, stats };
}

// READ: just the runs array (GET /api/wells/:id/runs).
async function getRuns(id) {
    const { rows } = await query('SELECT 1 FROM wells WHERE well_id = $1', [id]);
    if (!rows.length) throw err('well not found', 404);
    return runsForWell(id);
}

// ---------------------------------------------------------------------
// WRITE (admin, audited): add / update / delete.
// ---------------------------------------------------------------------
function coerceCoord(v, lo, hi, label) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw err(`${label} must be between ${lo} and ${hi}`, 400);
    return n;
}
function coerceDepth(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw err('totalDepth must be a non-negative number', 400);
    return n;
}
function coerceDate(v, label) {
    if (v == null || v === '') return null;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) throw err(`${label} must be a valid date`, 400);
    return new Date(ms).toISOString().slice(0, 10);
}

async function addWell(body, actor) {
    const b = body || {};
    const wellId = String(b.wellId || '').trim();
    const name = String(b.name || '').trim();
    if (!wellId || !ID_RE.test(wellId)) {
        throw err('wellId is required (2-64 chars: letters, digits, space . # _ / -)', 400);
    }
    if (!name || name.length > 120) throw err('name is required (1-120 chars)', 400);

    const wellType = b.wellType == null || b.wellType === '' ? 'workover' : String(b.wellType);
    if (!WELL_TYPES.includes(wellType)) throw err(`wellType must be one of: ${WELL_TYPES.join(', ')}`, 400);
    const status = b.status == null || b.status === '' ? 'planned' : String(b.status);
    if (!WELL_STATUSES.includes(status)) throw err(`status must be one of: ${WELL_STATUSES.join(', ')}`, 400);

    const lat = coerceCoord(b.latitude, -90, 90, 'latitude');
    const lon = coerceCoord(b.longitude, -180, 180, 'longitude');
    const totalDepth = coerceDepth(b.totalDepth);
    const spudDate = coerceDate(b.spudDate, 'spudDate');

    const dup = await query('SELECT 1 FROM wells WHERE well_id = $1', [wellId]);
    if (dup.rows.length) throw err('well already exists', 409);

    const { rows } = await query(
        `INSERT INTO wells
           (well_id, name, uwi, well_type, status, field, asset_unit, latitude, longitude,
            spud_date, total_depth, operator, block_lease)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [wellId, name, b.uwi || null, wellType, status, b.field || null, b.assetUnit || null,
         lat, lon, spudDate, totalDepth, b.operator || null, b.blockLease || null]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'well.create', wellId, { name, wellType, status, assetUnit: b.assetUnit || null }]).catch(() => {});
    return rowToWell(rows[0]);
}

async function updateWell(id, patch, actor) {
    const exists = await query('SELECT 1 FROM wells WHERE well_id = $1', [id]);
    if (!exists.rows.length) throw err('well not found', 404);

    // Map camelCase patch keys -> columns, validating where appropriate.
    const p = patch || {};
    const sets = [], vals = [id];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if ('name' in p) {
        const name = String(p.name || '').trim();
        if (!name || name.length > 120) throw err('name must be 1-120 chars', 400);
        push('name', name);
    }
    if ('uwi' in p) push('uwi', p.uwi || null);
    if ('wellType' in p) {
        if (p.wellType != null && p.wellType !== '' && !WELL_TYPES.includes(String(p.wellType))) {
            throw err(`wellType must be one of: ${WELL_TYPES.join(', ')}`, 400);
        }
        push('well_type', p.wellType || null);
    }
    if ('status' in p) {
        if (!WELL_STATUSES.includes(String(p.status))) throw err(`status must be one of: ${WELL_STATUSES.join(', ')}`, 400);
        push('status', p.status);
    }
    if ('field' in p) push('field', p.field || null);
    if ('assetUnit' in p) push('asset_unit', p.assetUnit || null);
    if ('latitude' in p) push('latitude', coerceCoord(p.latitude, -90, 90, 'latitude'));
    if ('longitude' in p) push('longitude', coerceCoord(p.longitude, -180, 180, 'longitude'));
    if ('spudDate' in p) push('spud_date', coerceDate(p.spudDate, 'spudDate'));
    if ('tdDate' in p) push('td_date', coerceDate(p.tdDate, 'tdDate'));
    if ('totalDepth' in p) push('total_depth', coerceDepth(p.totalDepth));
    if ('operator' in p) push('operator', p.operator || null);
    if ('blockLease' in p) push('block_lease', p.blockLease || null);
    if ('notes' in p) push('notes', p.notes || null);
    if ('currentRigId' in p) push('current_rig_id', p.currentRigId || null);

    if (!sets.length) {
        // No-op patch: return the current well unchanged rather than erroring.
        return getWell(id);
    }
    sets.push('updated_at = now()');
    const { rows } = await query(`UPDATE wells SET ${sets.join(', ')} WHERE well_id = $1 RETURNING *`, vals);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'well.update', id, p]).catch(() => {});
    return rowToWell(rows[0]);
}

async function deleteWell(id, actor) {
    const { rowCount } = await query('DELETE FROM wells WHERE well_id = $1', [id]);
    if (!rowCount) throw err('well not found', 404);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'well.delete', id, {}]).catch(() => {});
    return { ok: true };
}

// ---------------------------------------------------------------------
// RUN TRACKING — passive side-effect of ingest. Resolves the well a rig is
// currently working (by name = job), auto-creating a minimal well if needed,
// and maintains the open well_run so PAST runs accrue for offline EDR replay.
// Idempotent + NON-THROWING: failures here must never break ingest.
// ---------------------------------------------------------------------
// Core well-run tracking, running on the CALLER's transaction client.
//
// Ingest calls this INSIDE its batch transaction (under the rigs row lock it
// takes as its first statement). It used to be a separate fire-and-forget
// transaction spawned after the ack, which locked well_runs -> wells — the
// OPPOSITE order to ingest's startWellForRig (wells -> well_runs) — and the two
// overlapped for the same rig by construction: the primary 40P01 deadlock. It
// also raced ingest's own view of active_job and could fork duplicate open runs
// (now additionally excluded by the partial unique index one-open-run-per-rig).
//
// Lock hierarchy (must match ingest.js lockWellsForRig):
//   rigs (already held by the caller) -> wells in ascending well_id -> well_runs.
// THROWS on failure — the ingest caller wraps it in a SAVEPOINT so a tracking
// failure rolls back only the tracking, never the batch.

// Stamp productive/NPT seconds + joints onto a JUST-CLOSED run when the edge did
// not declare them. Productive/NPT are reconstructed from the run window's
// activity events (the edge's own productive flag wins per event, else the
// phase classification); joints = make-up connection records in the window.
// Best-effort and SAVEPOINT-contained: a failure here must never poison the
// enclosing ingest transaction.
async function backfillRunStats(client, runId) {
    if (runId == null) return;
    await client.query('SAVEPOINT run_stats');
    try {
        const { rows } = await client.query(
            `SELECT id, rig_id, started_at, ended_at, productive_sec, npt_sec, joints
             FROM well_runs WHERE id = $1`, [runId]);
        const run = rows[0];
        if (!run || !run.ended_at) { await client.query('RELEASE SAVEPOINT run_stats'); return; }
        const needSplit = run.productive_sec == null || run.npt_sec == null;
        const needJoints = run.joints == null;
        let prod = null; let npt = null; let joints = null;
        if (needSplit) {
            const seg = await client.query(
                `WITH ev0 AS (
                    (SELECT ts,
                            upper(COALESCE(payload->>'activity', payload->>'phase')) AS phase,
                            payload->>'productive' AS declared
                     FROM events
                     WHERE rig_id = $1 AND type = 'activity' AND ts < $2
                     ORDER BY ts DESC LIMIT 1)
                    UNION ALL
                    SELECT ts,
                           upper(COALESCE(payload->>'activity', payload->>'phase')) AS phase,
                           payload->>'productive' AS declared
                    FROM events
                    WHERE rig_id = $1 AND type = 'activity' AND ts >= $2 AND ts <= $3
                 ), ev AS (
                    -- The phase in force at run open is set by the last event BEFORE
                    -- the window; clamp its segment start to the run start.
                    SELECT GREATEST(ts, $2::timestamptz) AS ts, phase, declared,
                           LEAD(GREATEST(ts, $2::timestamptz)) OVER (ORDER BY ts) AS next_ts
                    FROM ev0
                 ), seg AS (
                    SELECT EXTRACT(EPOCH FROM (COALESCE(next_ts, $3::timestamptz) - ts)) AS dur,
                           CASE WHEN declared = 'true' THEN 'p'
                                WHEN declared = 'false' THEN 'n'
                                WHEN phase IN ('WAIT','IDLE','REPAIR','STOP') THEN 'n'
                                WHEN phase IN ('RIH','POOH','CIRCULATE','MAKE_UP','BREAK_OUT','PWOC','TRIP','DRILL','RUN','PULL') THEN 'p'
                                ELSE 'o' END AS cls
                    FROM ev
                 )
                 SELECT COALESCE(sum(dur) FILTER (WHERE cls = 'p'), 0) AS prod,
                        COALESCE(sum(dur) FILTER (WHERE cls = 'n'), 0) AS npt,
                        count(*) AS n
                 FROM seg`,
                [run.rig_id, run.started_at, run.ended_at]);
            if (Number(seg.rows[0].n) > 0) {
                prod = Math.round(Number(seg.rows[0].prod));
                npt = Math.round(Number(seg.rows[0].npt));
            }
        }
        if (needJoints) {
            const c = await client.query(
                `SELECT count(*) AS n FROM connections
                 WHERE rig_id = $1 AND ts >= $2 AND ts <= $3
                   AND COALESCE(payload->>'op', 'MAKE_UP') = 'MAKE_UP'`,
                [run.rig_id, run.started_at, run.ended_at]);
            joints = Number(c.rows[0].n);   // a genuine 0 is a known count, keep it
        }
        if (prod != null || npt != null || joints != null) {
            await client.query(
                `UPDATE well_runs SET
                    productive_sec = COALESCE(productive_sec, $2),
                    npt_sec = COALESCE(npt_sec, $3),
                    joints = COALESCE(joints, $4)
                 WHERE id = $1`,
                [runId, prod, npt, joints]);
        }
        await client.query('RELEASE SAVEPOINT run_stats');
    } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT run_stats').catch(() => {});
        console.warn('[wells] run-stats backfill failed (run ' + runId + '):', e.message);
    }
}

async function trackRunInTxn(client, rigId, job) {
    if (!rigId || !job) return;
    const jobName = String(job).trim();
    if (!jobName) return;

    // Resolve the well whose name matches the job. ORDER BY well_id: wells.name
    // has no unique constraint, and an unordered LIMIT 1 let this path bind to a
    // DIFFERENT row than startWellForRig's by-id resolution — the two writers
    // then rotated the rig between two wells forever.
    let well = (await client.query(
        'SELECT well_id FROM wells WHERE name = $1 ORDER BY well_id LIMIT 1', [jobName])).rows[0];

    // Pre-lock the target (if it exists) and every well this rig currently holds,
    // in PK order, BEFORE any write (same hierarchy as ingest.lockWellsForRig).
    await client.query(
        `SELECT well_id FROM wells
          WHERE well_id = $2 OR current_rig_id = $1
          ORDER BY well_id
          FOR NO KEY UPDATE`,
        [rigId, well ? well.well_id : jobName]);

    // The name resolution above ran UNLOCKED (it must — the lock statement needs
    // its result). A portal deleteWell can commit in that window, leaving `well`
    // pointing at a row that no longer exists; the well_runs INSERT below would
    // then die on the FK and (via the caller's savepoint) silently skip tracking
    // for the batch. Re-verify under the lock and fall through to auto-create.
    if (well) {
        const { rows: still } = await client.query(
            'SELECT well_id FROM wells WHERE well_id = $1', [well.well_id]);
        if (!still.length) well = null;
    }

    if (!well) {
        // Auto-INSERT a minimal workover well, copying asset/field/coords from the rig.
        const rigRow = (await client.query(
            'SELECT asset_unit, field, latitude, longitude FROM rigs WHERE rig_id = $1', [rigId])).rows[0] || {};
        await client.query(
            `INSERT INTO wells (well_id, name, well_type, status, asset_unit, field, latitude, longitude, current_rig_id)
             VALUES ($1,$1,'workover','workover',$2,$3,$4,$5,$6)
             ON CONFLICT (well_id) DO NOTHING`,
            [jobName, rigRow.asset_unit || null, rigRow.field || null,
             rigRow.latitude ?? null, rigRow.longitude ?? null, rigId]);
        well = { well_id: jobName };
    }
    const wellId = well.well_id;

    // Current open run for this rig (if any). Row-locked: it is about to be
    // closed or updated, and the lock keeps a concurrent writer honest.
    const open = (await client.query(
        `SELECT id, well_id, job_no FROM well_runs
          WHERE rig_id = $1 AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1
          FOR NO KEY UPDATE`,
        [rigId])).rows[0];

    if (open && open.well_id === wellId) {
        if (!open.job_no) {
            await client.query('UPDATE well_runs SET job_no = $2 WHERE id = $1', [open.id, jobName]);
        }
        return;
    }

    if (open) {
        // The rig moved to a DIFFERENT well/job: close the stale run and clear the
        // stale well's current_rig_id (only if it still points at this rig). A
        // well the rig has LEFT is no longer "in workover" — mark it completed,
        // but only from the in-service states; an operator/edge-declared final
        // state (producing/abandoned/suspended) is never overwritten by inference.
        await client.query('UPDATE well_runs SET ended_at = now() WHERE id = $1', [open.id]);
        await backfillRunStats(client, open.id);
        if (open.well_id && open.well_id !== wellId) {
            await client.query(
                `UPDATE wells SET current_rig_id = NULL,
                        status = CASE WHEN status IN ('workover','active','drilling') THEN 'completed' ELSE status END,
                        updated_at = now()
                  WHERE well_id = $1 AND current_rig_id = $2`,
                [open.well_id, rigId]);
        }
    }

    // Open a fresh run for the new well/job. The partial unique index
    // (one open run per rig) is the backstop against forked history.
    await client.query(
        `INSERT INTO well_runs (well_id, rig_id, job_no, started_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (rig_id) WHERE ended_at IS NULL DO NOTHING`,
        [wellId, rigId, jobName]);
    // Point the well at this rig — and put it IN WORKOVER: a rig actively
    // running on a well overrides any resting state (completed / producing /
    // suspended); without this, a rig returning to a previously-completed well
    // showed a live operation chip against a 'completed' status.
    await client.query(
        `UPDATE wells SET current_rig_id = $2, status = 'workover', updated_at = now() WHERE well_id = $1`,
        [wellId, rigId]);
}

// Standalone wrapper for callers outside an existing transaction. No longer used
// by the ingest path (which calls trackRunInTxn on its own client); kept for API
// compatibility. Non-throwing, as before.
async function trackRun(rigId, job, _nowMs) {
    if (!rigId || !job) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await trackRunInTxn(client, rigId, job);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[wells.trackRun] error:', e.message);
    } finally {
        client.release();
    }
}

module.exports = {
    getWells, getWell, getRuns, addWell, updateWell, deleteWell, trackRun, trackRunInTxn,
    WELL_STATUSES, WELL_TYPES, backfillRunStats };

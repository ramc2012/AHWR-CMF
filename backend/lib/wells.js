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
    const where = ['w.current_rig_id IS NOT NULL'], vals = [];
    if (assetUnit) { vals.push(assetUnit); where.push(`w.asset_unit = $${vals.length}`); }
    if (status) { vals.push(status); where.push(`w.status = $${vals.length}`); }
    if (q) {
        vals.push(`%${String(q).toLowerCase()}%`);
        const i = vals.length;
        where.push(`(lower(w.name) LIKE $${i} OR lower(w.well_id) LIKE $${i} OR lower(COALESCE(w.uwi,'')) LIKE $${i} OR lower(COALESCE(w.field,'')) LIKE $${i})`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(
        `SELECT w.well_id, w.name, w.uwi, w.well_type, w.service_type, w.status, w.asset_unit, w.field,
                w.total_depth, w.current_rig_id, w.spud_date,
                EXISTS (SELECT 1 FROM well_runs wr WHERE wr.well_id = w.well_id AND wr.ended_at IS NULL) AS active_run
         FROM wells w ${clause}
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
        spudDate: r.spud_date,
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
async function trackRun(rigId, job, nowMs) {
    if (!rigId || !job) return;
    const jobName = String(job).trim();
    if (!jobName) return;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Resolve (or auto-create) the well whose name matches the job. The well_id
        // equals the job name (the sim/edge name a rig's well as its job).
        let well = (await client.query(
            'SELECT well_id FROM wells WHERE name = $1 LIMIT 1', [jobName])).rows[0];
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

        // Current open run for this rig (if any).
        const open = (await client.query(
            'SELECT id, well_id, job_no FROM well_runs WHERE rig_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
            [rigId])).rows[0];

        if (open && open.well_id === wellId) {
            if (!open.job_no) {
                await client.query('UPDATE well_runs SET job_no = $2 WHERE id = $1', [open.id, jobName]);
            }
            await client.query('COMMIT');
            return;
        }

        if (open) {
            // The rig moved to a DIFFERENT well/job: close the stale run and clear the
            // stale well's current_rig_id (only if it still points at this rig).
            await client.query('UPDATE well_runs SET ended_at = now() WHERE id = $1', [open.id]);
            if (open.well_id && open.well_id !== wellId) {
                await client.query(
                    'UPDATE wells SET current_rig_id = NULL, updated_at = now() WHERE well_id = $1 AND current_rig_id = $2',
                    [open.well_id, rigId]);
            }
        }

        // Open a fresh run for the new well/job.
        await client.query(
            'INSERT INTO well_runs (well_id, rig_id, job_no, started_at) VALUES ($1,$2,$3,now())',
            [wellId, rigId, jobName]);
        // Point the well at this rig.
        await client.query(
            'UPDATE wells SET current_rig_id = $2, updated_at = now() WHERE well_id = $1',
            [wellId, rigId]);

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // Non-throwing: log and swallow so ingest is never affected.
        console.error('[wells.trackRun] error:', e.message);
    } finally {
        client.release();
    }
}

module.exports = {
    getWells, getWell, getRuns, addWell, updateWell, deleteWell, trackRun,
    WELL_STATUSES, WELL_TYPES,
};

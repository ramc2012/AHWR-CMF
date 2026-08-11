'use strict';
// Central ingestion (proposal §6.3). Accepts store-and-forward batches from the
// rig-edge sync agent (backend/lib/sync.js) in their native contract:
//
//   { seq, deviceId, schemaVersion, createdAt,
//     channels: [{ ts, values: { "measurement.field": number } }],
//     events:   [{ ts, type, payload }] }
//
// Writes telemetry to the TimescaleDB hypertable, events/connections to their
// tables, refreshes the last-value cache, and recomputes the per-rig
// data-quality health score. MONITORING-ONLY: nothing is ever sent back to a rig.
const { pool, query } = require('./db');
const { EXPECTED_METRICS } = require('./tags');
const { computeHealth } = require('./fleet');

const GLOBAL_INGEST_TOKEN = process.env.INGEST_TOKEN || '';
// Open-demo escape hatch (audit #1): only honoured in non-production and never
// in production. When no device_token and no INGEST_TOKEN are configured, ingest
// stays FAIL-CLOSED unless this is explicitly set.
const ALLOW_OPEN_INGEST =
    process.env.ALLOW_OPEN_INGEST === 'true' && process.env.NODE_ENV !== 'production';

// Reserved key inside rig_latest.values that carries a per-tag last-seen map
// ({ metric: tsIso }) so fleet.getRig can surface per-field staleness (audit #22)
// without a schema change to rig_latest.
const TS_KEY = '__ts';

// Coerce an untrusted timestamp to a canonical ISO instant, or null if unusable
// (audit #11/#32). Accepts ISO strings and epoch-ms numbers; compares numerically.
function coerceTsIso(raw) {
    if (raw == null) return null;
    let ms;
    if (typeof raw === 'number') ms = raw;
    else ms = Date.parse(String(raw));
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

// Numeric instant for a snapshot (NaN-safe), used to pick the latest snapshot.
function tsMillis(raw) {
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;
    return Date.parse(String(raw));
}

// Auto-register an unknown device as a pending rig so onboarding is visible in
// the governance workspace (proposal §6.1 "adoption progress per rig"). Only
// called for already-authorized devices (audit #1).
async function ensureRig(client, rigId, token, schemaVersion) {
    const { rows } = await client.query(
        'SELECT rig_id, device_token, last_seq FROM rigs WHERE rig_id = $1', [rigId]);
    if (rows.length) return { ...rows[0], _new: false };
    await client.query(
        `INSERT INTO rigs (rig_id, name, status, device_token, schema_version, field)
         VALUES ($1, $2, 'pending', $3, $4, 'Ankleshwar')
         ON CONFLICT (rig_id) DO NOTHING`,
        [rigId, rigId, token || null, schemaVersion || null]
    );
    await client.query('INSERT INTO deployment_status (rig_id, gate, commissioning) VALUES ($1, $2, $3) ON CONFLICT (rig_id) DO NOTHING',
        [rigId, 'discovery', 'in_progress']);
    return { rig_id: rigId, device_token: token || null, last_seq: null, _new: true };
}

// Fail-closed authorization (audit #1). Accept a batch ONLY if the bearer token
// matches a per-rig device_token OR the global INGEST_TOKEN. If neither is
// configured anywhere, REJECT unless ALLOW_OPEN_INGEST is set (and not prod).
function authorize(rig, token) {
    if (GLOBAL_INGEST_TOKEN && token === GLOBAL_INGEST_TOKEN) return true;
    if (rig && rig.device_token) return token === rig.device_token;
    return ALLOW_OPEN_INGEST; // fail-closed by default; open only when explicitly allowed
}

// Decide whether this device is allowed to ingest WITHOUT auto-registering an
// unknown rig first (audit #1: only auto-register authorized devices). When a
// device_token has been provisioned for an existing rig, that wins; otherwise we
// fall back to the global INGEST_TOKEN / open-demo policy.
function authorizeKnown(rig, token) {
    if (GLOBAL_INGEST_TOKEN && token === GLOBAL_INGEST_TOKEN) return true;
    if (rig && rig.device_token) return token === rig.device_token;
    return ALLOW_OPEN_INGEST;
}

// Bulk-insert telemetry rows with a single UNNEST'd statement. Idempotent on
// replay via ON CONFLICT DO NOTHING keyed on (rig_id, metric, ts) — the SCHEMA
// agent provides the matching unique index (audit #4).
async function insertTelemetry(client, rigId, channels) {
    const ts = [], metric = [], value = [];
    for (const snap of channels) {
        if (!snap || !snap.values) continue;
        // Bad/missing channel ts -> use now() (skip-bad-channel semantics: we keep
        // the channel but stamp it now rather than failing the batch). (audit #11)
        const t = coerceTsIso(snap.ts) || new Date().toISOString();
        for (const [m, v] of Object.entries(snap.values)) {
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            ts.push(t); metric.push(m); value.push(n);
        }
    }
    if (!ts.length) return 0;
    await client.query(
        `INSERT INTO telemetry (ts, rig_id, metric, value)
         SELECT u.ts, $2, u.metric, u.value
         FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)
         ON CONFLICT (rig_id, metric, ts) DO NOTHING`,
        [ts, rigId, metric, value]
    );
    return ts.length;
}

// Latest snapshot wins; merge over the existing cache so a partial batch never
// wipes previously-seen tags. Compares ts NUMERICALLY (audit #32).
function latestSnapshot(channels) {
    let best = null, bestMs = -Infinity;
    for (const snap of channels || []) {
        if (!snap || !snap.values) continue;
        const ms = tsMillis(snap.ts);
        const m = Number.isFinite(ms) ? ms : -Infinity;
        if (!best || m >= bestMs) { best = snap; bestMs = m; }
    }
    return best;
}

function cleanWellText(v) {
    if (v == null || typeof v === 'object') return '';
    const s = String(v).trim();
    return s && s !== '--' ? s : '';
}

function cleanStatus(v) {
    const text = cleanWellText(v).toLowerCase();
    if (!text) return '';
    if (['active', 'started', 'inprogress', 'in_progress', 'running'].includes(text.replace(/[^a-z0-9]/g, ''))) return 'active';
    if (['complete', 'completed', 'done', 'ended'].includes(text)) return 'completed';
    return text;
}

function firstNumber(obj, keys) {
    for (const key of keys) {
        const n = Number(obj && obj[key]);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

function firstTimestamp(obj, keys) {
    for (const key of keys) {
        const ts = coerceTsIso(obj && obj[key]);
        if (ts) return ts;
    }
    return '';
}

function isWellMetric(metric) {
    const s = String(metric || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return ['well', 'wellid', 'wellname', 'wellbore', 'wellborename', 'job', 'jobname', 'activejob', 'currentwell', 'currentwellname'].includes(s)
        || s.endsWith('wellname')
        || s.endsWith('wellid')
        || s.endsWith('wellbore')
        || s.endsWith('wellborename')
        || s.endsWith('jobname')
        || s.includes('wellname')
        || s.includes('currentwell')
        || s.includes('activejob');
}

function findWellNameInSnapshot(snap) {
    const values = snap && snap.values;
    if (!values || typeof values !== 'object') return '';
    const keys = [
        'wellName', 'well_name', 'well.name', 'well', 'wellId', 'well_id',
        'currentWell', 'current_well', 'currentWellName', 'current_well_name',
        'wellboreName', 'wellbore_name', 'wellbore.name',
        'jobName', 'job_name', 'job.name', 'job', 'activeJob', 'active_job',
    ];
    for (const key of keys) {
        const text = cleanWellText(values[key]);
        if (text) return text;
    }
    for (const [metric, value] of Object.entries(values)) {
        if (isWellMetric(metric)) {
            const text = cleanWellText(value);
            if (text) return text;
        }
    }
    return '';
}

function findWellNameInBatch(batch, channels) {
    const keys = [
        'wellName', 'well_name', 'well', 'wellId', 'well_id',
        'currentWell', 'current_well', 'currentWellName', 'current_well_name',
        'wellboreName', 'wellbore_name',
        'jobName', 'job_name', 'job', 'activeJob', 'active_job',
    ];
    for (const key of keys) {
        const text = cleanWellText(batch && batch[key]);
        if (text) return text;
    }
    for (const snap of channels || []) {
        const text = findWellNameInSnapshot(snap);
        if (text) return text;
    }
    return '';
}

function firstText(obj, keys) {
    for (const key of keys) {
        const text = cleanWellText(obj && obj[key]);
        if (text) return text;
    }
    return '';
}

function mergeWellPayload(...sources) {
    const merged = {};
    for (const src of sources) {
        if (src && typeof src === 'object' && !Array.isArray(src)) Object.assign(merged, src);
    }
    return merged;
}

function nestedWellPayload(src) {
    if (!src || typeof src !== 'object') return null;
    const keys = [
        'well', 'activeWell', 'active_well', 'currentWell', 'current_well',
        'wellManagement', 'well_management', 'wellRun', 'well_run',
    ];
    for (const key of keys) {
        const value = src[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    }
    return null;
}

function normalizeWellPayload(payload) {
    const p = payload || {};
    const nested = nestedWellPayload(p);
    const data = nested ? mergeWellPayload(p, nested) : p;
    const wellId = firstText(data, ['wellId', 'well_id', 'uwi', 'id', 'name', 'wellName', 'well_name', 'currentWell', 'current_well', 'currentWellName', 'current_well_name', 'wellboreName', 'wellbore_name', 'job', 'jobName', 'job_name', 'activeJob', 'active_job']);
    const name = firstText(data, ['name', 'wellName', 'well_name', 'currentWell', 'current_well', 'currentWellName', 'current_well_name', 'wellboreName', 'wellbore_name', 'job', 'jobName', 'job_name', 'activeJob', 'active_job', 'wellId', 'well_id', 'uwi', 'id']) || wellId;
    return {
        wellId,
        name,
        uwi: firstText(data, ['uwi', 'api', 'apiNo', 'api_no']),
        field: firstText(data, ['field', 'area']),
        assetUnit: firstText(data, ['assetUnit', 'asset_unit', 'asset']),
        wellType: firstText(data, ['wellType', 'well_type', 'type']) || 'workover',
        service: firstText(data, ['service', 'serviceType', 'service_type', 'wellService', 'well_service']),
        operator: firstText(data, ['operator']),
        blockLease: firstText(data, ['blockLease', 'block_lease', 'block']),
        country: firstText(data, ['country']),
        companyMan: firstText(data, ['companyMan', 'company_man']),
        toolpusher: firstText(data, ['toolpusher', 'toolPusher', 'tool_pusher']),
        objective: firstText(data, ['objective']),
        location: firstText(data, ['location', 'blockLocation', 'block_location']),
        status: cleanStatus(data.status) || cleanStatus(data.state),
        jobNo: firstText(data, ['jobNo', 'job_no', 'jobNumber', 'job_number', 'job', 'jobName', 'job_name', 'currentWellName', 'current_well_name']) || name || wellId,
        startedAt: firstTimestamp(data, ['startedAt', 'started_at', 'startTime', 'start_time', 'start', 'started']),
        startedBy: firstText(data, ['startedBy', 'started_by', 'user', 'username', 'createdBy', 'created_by']),
        totalDepth: firstNumber(data, ['totalDepth', 'total_depth', 'plannedTd', 'plannedTD', 'planned_td', 'td']),
        joints: firstNumber(data, ['joints', 'jointCount', 'joint_count']),
        depthDelta: firstNumber(data, ['depthDelta', 'depth_delta', 'depthChange', 'depth_change']),
        productiveSec: firstNumber(data, ['productiveSec', 'productive_sec', 'productiveSeconds', 'productive_seconds']),
        nptSec: firstNumber(data, ['nptSec', 'npt_sec', 'nptSeconds', 'npt_seconds']),
        latitude: firstNumber(data, ['latitude', 'lat']),
        longitude: firstNumber(data, ['longitude', 'lon', 'lng']),
        spudDate: firstText(data, ['spudDate', 'spud_date']),
        tdDate: firstText(data, ['tdDate', 'td_date', 'completedAt', 'completed_at']),
        notes: firstText(data, ['notes', 'summary']),
    };
}

function findWellPayloadInSource(src) {
    if (!src || typeof src !== 'object') return null;
    const nested = nestedWellPayload(src);
    if (nested) return mergeWellPayload(src, nested);
    const well = normalizeWellPayload(src);
    return well.wellId || well.name ? src : null;
}

function findWellPayloadInBatch(batch, channels) {
    const top = findWellPayloadInSource(batch);
    if (top) return top;
    for (const snap of channels || []) {
        const fromSnap = findWellPayloadInSource(snap);
        if (fromSnap) return fromSnap;
        const fromValues = findWellPayloadInSource(snap && snap.values);
        if (fromValues) return fromValues;
    }
    return null;
}

function normalizeWellEvent(ev) {
    const p = (ev && ev.payload && typeof ev.payload === 'object') ? ev.payload : {};
    return normalizeWellPayload(p);
}

async function upsertWellFromEvent(client, rigId, well, statusOverride, assignRig) {
    if (!well.wellId) return null;
    const rigRow = (await client.query(
        'SELECT asset_unit, field, latitude, longitude FROM rigs WHERE rig_id = $1', [rigId])).rows[0] || {};
    await client.query(
        `INSERT INTO wells
           (well_id, name, uwi, well_type, service_type, status, field, asset_unit, country,
            company_man, toolpusher, objective, location, latitude, longitude, total_depth,
            operator, block_lease, current_rig_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (well_id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, wells.name),
           uwi = COALESCE(EXCLUDED.uwi, wells.uwi),
           well_type = COALESCE(EXCLUDED.well_type, wells.well_type),
           service_type = COALESCE(EXCLUDED.service_type, wells.service_type),
           status = EXCLUDED.status,
           field = COALESCE(EXCLUDED.field, wells.field),
           asset_unit = COALESCE(EXCLUDED.asset_unit, wells.asset_unit),
           country = COALESCE(EXCLUDED.country, wells.country),
           company_man = COALESCE(EXCLUDED.company_man, wells.company_man),
           toolpusher = COALESCE(EXCLUDED.toolpusher, wells.toolpusher),
           objective = COALESCE(EXCLUDED.objective, wells.objective),
           location = COALESCE(EXCLUDED.location, wells.location),
           latitude = COALESCE(EXCLUDED.latitude, wells.latitude),
           longitude = COALESCE(EXCLUDED.longitude, wells.longitude),
           total_depth = COALESCE(EXCLUDED.total_depth, wells.total_depth),
           operator = COALESCE(EXCLUDED.operator, wells.operator),
           block_lease = COALESCE(EXCLUDED.block_lease, wells.block_lease),
           current_rig_id = CASE WHEN $21::boolean THEN EXCLUDED.current_rig_id ELSE wells.current_rig_id END,
           notes = COALESCE(EXCLUDED.notes, wells.notes),
           updated_at = now()`,
        [well.wellId, well.name || well.wellId, well.uwi || null, well.wellType || 'workover', well.service || null, statusOverride || well.status || 'workover',
         well.field || rigRow.field || null, well.assetUnit || rigRow.asset_unit || null,
         well.country || null, well.companyMan || null, well.toolpusher || null, well.objective || null, well.location || null,
         well.latitude ?? rigRow.latitude ?? null, well.longitude ?? rigRow.longitude ?? null,
         well.totalDepth, well.operator || null, well.blockLease || null, assignRig ? rigId : null, well.notes || null, !!assignRig]
    );
    return well.wellId;
}

async function startWellForRig(client, rigId, ev) {
    const well = normalizeWellEvent(ev);
    if (!well.wellId) return null;
    const wellId = await upsertWellFromEvent(client, rigId, well, well.status || 'workover', true);
    const jobNo = well.jobNo || well.name || wellId;
    const startedAt = well.startedAt || coerceTsIso(ev.ts) || new Date().toISOString();
    await client.query(
        `UPDATE well_runs SET ended_at = COALESCE(ended_at, $3)
         WHERE rig_id = $1 AND ended_at IS NULL AND well_id <> $2`,
        [rigId, wellId, startedAt]
    );
    const open = (await client.query(
        'SELECT id FROM well_runs WHERE rig_id = $1 AND well_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
        [rigId, wellId])).rows[0];
    if (!open) {
        await client.query(
            `INSERT INTO well_runs
               (well_id, rig_id, job_no, service, started_by, joints, depth_delta, productive_sec, npt_sec, started_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [wellId, rigId, jobNo, well.service || null, well.startedBy || null, well.joints, well.depthDelta, well.productiveSec, well.nptSec, startedAt]
        );
    } else {
        await client.query(
            `UPDATE well_runs SET
               job_no = COALESCE($3, job_no),
               service = COALESCE($4, service),
               started_by = COALESCE($5, started_by),
               joints = COALESCE($6, joints),
               depth_delta = COALESCE($7, depth_delta),
               productive_sec = COALESCE($8, productive_sec),
               npt_sec = COALESCE($9, npt_sec),
               started_at = LEAST(started_at, $10)
             WHERE id = $1 AND rig_id = $2`,
            [open.id, rigId, jobNo, well.service || null, well.startedBy || null, well.joints, well.depthDelta, well.productiveSec, well.nptSec, startedAt]
        );
    }
    await client.query('UPDATE wells SET current_rig_id = NULL, updated_at = now() WHERE current_rig_id = $1 AND well_id <> $2', [rigId, wellId]);
    await client.query('UPDATE wells SET current_rig_id = $2, status = $3, updated_at = now() WHERE well_id = $1', [wellId, rigId, well.status || 'active']);
    return { wellId, name: well.name || wellId, jobNo };
}

async function completeWellForRig(client, rigId, ev) {
    const well = normalizeWellEvent(ev);
    let wellId = well.wellId;
    let activeOpen = null;
    if (wellId) {
        activeOpen = (await client.query(
            'SELECT id, well_id FROM well_runs WHERE rig_id = $1 AND well_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
            [rigId, wellId])).rows[0] || null;
    } else {
        activeOpen = (await client.query(
            'SELECT id, well_id FROM well_runs WHERE rig_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [rigId])).rows[0] || null;
        wellId = activeOpen && activeOpen.well_id;
    }
    if (!wellId) return null;
    await upsertWellFromEvent(client, rigId, { ...well, wellId, name: well.name || wellId }, 'completed', false);
    const endedAt = coerceTsIso(ev.ts) || new Date().toISOString();
    await client.query('UPDATE well_runs SET ended_at = $3, summary = COALESCE(summary, $4) WHERE rig_id = $1 AND well_id = $2 AND ended_at IS NULL',
        [rigId, wellId, endedAt, well.notes || null]);
    await client.query('UPDATE wells SET status = $2, current_rig_id = CASE WHEN current_rig_id = $4 THEN NULL ELSE current_rig_id END, td_date = COALESCE(td_date, $3::date), updated_at = now() WHERE well_id = $1',
        [wellId, 'completed', well.tdDate || endedAt, rigId]);
    return { wellId, name: well.name || wellId, wasActive: !!activeOpen };
}
async function processEvents(client, rigId, events) {
    let alarmCounts = null;
    let activity = null;
    let clearActiveJob = false;
    let lifecycle = null;
    for (const ev of events || []) {
        if (!ev || !ev.type) continue;
        const ts = coerceTsIso(ev.ts) || new Date().toISOString();
        // Idempotent on replay (audit #4): a dedup unique index on
        // (rig_id, ts, type, payload) lets a re-sent batch insert nothing twice.
        await client.query(
            `INSERT INTO events (ts, rig_id, type, payload) VALUES ($1,$2,$3,$4)
             ON CONFLICT DO NOTHING`,
            [ts, rigId, ev.type, ev.payload || {}]);
        if (ev.type === 'alarm') {
            alarmCounts = ev.payload || {};
        } else if (ev.type === 'connection') {
            const p = ev.payload || {};
            await client.query(
                `INSERT INTO connections (ts, rig_id, peak_torque, result, joint, payload)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT DO NOTHING`,
                [ts, rigId, p.peakTorque ?? p.peak_torque ?? null, p.result || null,
                 p.joint ?? p.jointCount ?? null, p]
            );
        } else if (ev.type === 'activity') {
            activity = ev.payload || {};
        } else if (ev.type === 'well.created' || ev.type === 'well.updated') {
            const well = normalizeWellEvent(ev);
            if (well.wellId) await upsertWellFromEvent(client, rigId, well, well.status || 'workover', false);
        } else if (ev.type === 'well.started') {
            const started = await startWellForRig(client, rigId, ev);
            if (started) {
                activity = { ...(activity || {}), job: started.name, wellName: started.name, phase: 'well.started' };
                clearActiveJob = false;
                lifecycle = { type: 'started', ...started };
            }
        } else if (ev.type === 'well.completed') {
            const completed = await completeWellForRig(client, rigId, ev);
            if (completed) {
                activity = { ...(activity || {}), phase: 'well.completed' };
                clearActiveJob = !!completed.wasActive;
                lifecycle = { type: 'completed', ...completed };
            }
        }
    }
    return { alarmCounts, activity, clearActiveJob, lifecycle };
}
// Cheap provenance audit on rig auto-registration / accepted ingest (audit #14).
// Sampled: only on first-register (registered=true) so the trail records the
// device/rigId/seq binding without one row per batch. Never throws into ingest.
async function auditProvenance(client, { rigId, token, seq, registered }) {
    if (!registered) return;
    try {
        const device = token ? `token:${String(token).slice(0, 6)}…` : 'anonymous';
        await client.query(
            'INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
            ['ingest', 'rig.autoregister', rigId, { device, rigId, seq: seq ?? null }]);
    } catch { /* never block ingest on audit */ }
}

// Main entry. `rigId`/`token` are extracted from headers/body by the caller.
async function ingestBatch({ rigId, token, schemaVersion }, batch) {
    rigId = batch.deviceId || rigId;
    if (!rigId) return { ok: false, code: 400, error: 'missing deviceId' };

    // Coerce seq to a safe integer or null up front (audit #11) — never bind a
    // raw untrusted value into the BIGINT last_seq column.
    const seq = Number.isSafeInteger(Number(batch.seq)) ? Number(batch.seq) : null;

    const channels = Array.isArray(batch.channels) ? batch.channels : [];
    let events = Array.isArray(batch.events) ? batch.events : [];
    const wellPayload = findWellPayloadInBatch(batch, channels);
    const normalizedSnapshotWell = wellPayload ? normalizeWellPayload(wellPayload) : null;
    const hasIncomingWellLifecycleEvent = events.some((ev) => ev && ['well.created', 'well.updated', 'well.started', 'well.completed'].includes(ev.type));
    if (!hasIncomingWellLifecycleEvent && normalizedSnapshotWell && normalizedSnapshotWell.wellId) {
        events = [
            ...events,
            {
                ts: normalizedSnapshotWell.startedAt || batch.createdAt || new Date().toISOString(),
                type: normalizedSnapshotWell.status === 'completed' ? 'well.completed' : 'well.started',
                payload: { ...wellPayload, ...normalizedSnapshotWell },
            },
        ];
    }
    const hasWellLifecycleEvent = events.some((ev) => ev && ['well.created', 'well.updated', 'well.started', 'well.completed'].includes(ev.type));

    const client = await pool.connect();
    let points = 0;
    let registered = false;
    let alarmTransition = null;   // rising-edge info for the notification dispatcher
    let activeJob = null;         // job/well this batch is working (for well-run tracking)
    try {
        await client.query('BEGIN');

        // Look up the rig WITHOUT creating it, so an unauthorized unknown device
        // cannot auto-enroll a fake rig (audit #1).
        const { rows: existing } = await client.query(
            `SELECT rig_id, device_token, last_seq, alarm_active, alarm_p1, alarm_highest, active_job
             FROM rigs WHERE rig_id = $1`, [rigId]);
        let rig = existing[0] || null;

        if (!authorizeKnown(rig, token)) {
            await client.query('ROLLBACK').catch(() => {});
            return { ok: false, code: 401, error: 'unauthorized device' };
        }

        // Authorized: now it is safe to auto-register an unknown device.
        if (!rig) {
            const r = await ensureRig(client, rigId, token, schemaVersion || batch.schemaVersion);
            rig = r;
            registered = !!r._new;
        }

        // Replay idempotency fast-path (audit #4): reject batches whose seq is not
        // newer than the last accepted seq, read in this same transaction. A null
        // incoming seq is treated as always-accept (legacy/uncounted senders).
        const lastSeq = rig && rig.last_seq != null ? Number(rig.last_seq) : null;
        if (seq != null && lastSeq != null && seq <= lastSeq && !hasWellLifecycleEvent) {
            await client.query('ROLLBACK').catch(() => {});
            return { ok: true, rigId, points: 0, events: 0, seq, duplicate: true };
        }

        points = await insertTelemetry(client, rigId, channels);

        const snap = latestSnapshot(channels);
        const snapWellName = (snap ? findWellNameInSnapshot(snap) : '') || findWellNameInBatch(batch, channels);
        if (snap) {
            // Per-tag last-seen map (audit #22): stamp each metric with this
            // snapshot's ts under the reserved __ts key, merged into the cache.
            const snapTsIso = coerceTsIso(snap.ts) || new Date().toISOString();
            const tsMap = {};
            for (const m of Object.keys(snap.values)) tsMap[m] = snapTsIso;
            // Insert values already carrying the reserved __ts map so per-tag age is
            // available from the very first batch (audit #22); on conflict, merge
            // both the values and the __ts map so a frozen tag keeps its old ts.
            const insertValues = { ...snap.values, [TS_KEY]: tsMap };
            await client.query(
                `INSERT INTO rig_latest (rig_id, ts, values)
                 VALUES ($1, $2, $3::jsonb)
                 ON CONFLICT (rig_id) DO UPDATE
                   SET ts = EXCLUDED.ts,
                       values = (rig_latest.values || EXCLUDED.values)
                                 || jsonb_build_object($4::text,
                                      COALESCE(rig_latest.values->$4, '{}'::jsonb) || $5::jsonb)`,
                [rigId, snapTsIso, JSON.stringify(insertValues), TS_KEY, JSON.stringify(tsMap)]
            );
        }

        const processed = await processEvents(client, rigId, events);
        const alarmCounts = processed.alarmCounts;
        const clearActiveJob = !!processed.clearActiveJob;
        let activity = processed.activity;
        if (snapWellName) activity = { ...(activity || {}), job: (activity && activity.job) || snapWellName, wellName: (activity && activity.wellName) || snapWellName };

        // Alarm rising-edge (for notifications, dispatched post-commit by the caller).
        if (alarmCounts) {
            alarmTransition = {
                prev: {
                    active: Number(rig && rig.alarm_active) || 0,
                    p1: Number(rig && rig.alarm_p1) || 0,
                    highest: (rig && rig.alarm_highest) || null,
                },
                next: {
                    active: alarmCounts.active ?? 0, p1: alarmCounts.p1 ?? 0,
                    p2: alarmCounts.p2 ?? 0, p3: alarmCounts.p3 ?? 0,
                    highest: alarmCounts.highest ?? null,
                },
            };
        }

        // --- Data-quality health (proposal §6.1 data quality monitor) ---
        const receivedTs = Date.now();
        const latestMs = snap ? tsMillis(snap.ts) : NaN;
        const createdMs = tsMillis(batch.createdAt);
        // Dashboard freshness is central receive freshness, so a PLC/edge timestamp
        // offset does not make the central live page appear 5-10 seconds behind.
        const latestTs = receivedTs;
        const presentMetrics = snap ? Object.keys(snap.values) : [];
        const health = computeHealth({ latestTs, presentMetrics });

        // Compose rollup update. Telemetry health/count changes only when this
        // batch carries a snapshot; well-only event batches must not wipe live data.
        const sets = ['updated_at = now()'];
        const vals = [rigId];
        let i = vals.length;
        if (snap) {
            sets.push(`last_data_at = $${++i}`); vals.push(new Date(latestTs).toISOString());
            sets.push(`sync_lag_sec = $${++i}`); vals.push(health.syncLagSec);
            sets.push(`health_score = $${++i}`); vals.push(health.score);
            sets.push(`metric_count = $${++i}`); vals.push(presentMetrics.length);
            sets.push(`status = $${++i}`); vals.push(health.status);
        }
        const newLastSeq = seq != null ? (lastSeq != null ? Math.max(seq, lastSeq) : seq) : (lastSeq != null ? lastSeq : null);
        if (newLastSeq != null) { sets.push(`last_seq = $${++i}`); vals.push(newLastSeq); }
        if (batch.schemaVersion) { sets.push(`schema_version = $${++i}`); vals.push(batch.schemaVersion); }
        if (alarmCounts) {
            sets.push(`alarm_active = $${++i}`); vals.push(alarmCounts.active ?? 0);
            sets.push(`alarm_unack = $${++i}`);  vals.push(alarmCounts.unack ?? 0);
            sets.push(`alarm_p1 = $${++i}`);     vals.push(alarmCounts.p1 ?? 0);
            sets.push(`alarm_p2 = $${++i}`);     vals.push(alarmCounts.p2 ?? 0);
            sets.push(`alarm_p3 = $${++i}`);     vals.push(alarmCounts.p3 ?? 0);
            sets.push(`alarm_highest = $${++i}`); vals.push(alarmCounts.highest ?? null);
        }
        if (activity) {
            if (activity.phase || activity.activity) { sets.push(`active_activity = $${++i}`); vals.push(activity.phase || activity.activity); }
            if (activity.job) { sets.push(`active_job = $${++i}`); vals.push(activity.job); activeJob = String(activity.job); }
        }
        if (clearActiveJob) {
            sets.push(`active_job = $${++i}`); vals.push(null);
            activeJob = null;
        }
        // Resolve the job for well-run tracking: the activity payload's job wins;
        // otherwise fall back to whatever active_job the rig already has on record.
        if (!activeJob && !clearActiveJob) {
            activeJob = (rig && rig.active_job) ? String(rig.active_job) : null;
        }
        await client.query(`UPDATE rigs SET ${sets.join(', ')} WHERE rig_id = $1`, vals);

        await auditProvenance(client, { rigId, token, seq, registered });

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // Surface a tagged error so server.js can log full detail server-side and
        // return a generic message to the untrusted caller (audit #11).
        return { ok: false, code: 500, error: 'ingest failed', detail: e.message };
    } finally {
        client.release();
    }

    return { ok: true, rigId, points, events: events.length, seq, alarmTransition, activeJob };
}

module.exports = { ingestBatch, EXPECTED_METRICS };

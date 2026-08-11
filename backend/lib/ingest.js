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
const { EXPECTED_METRICS, WIRE_ALIASES, canonicalMetric } = require('./tags');
const { safeEqual } = require('./secrets');
const metrics = require('./metrics');
const wells = require('./wells');
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

// How far BELOW the stored high-water mark an incoming seq must fall before it is
// read as "the sender restarted its counter" rather than "this is a replayed
// batch". Buffered replays after a WAN outage step back by at most the buffer
// depth (SYNC_BUFFER_DAYS at SYNC_BATCH_SECONDS ~= 130k batches at the 15d/10s
// default), while a true reset drops to 1 from wherever the rig had reached.
const SEQ_RESET_GAP = Number(process.env.INGEST_SEQ_RESET_GAP || 500000);

// ---------------------------------------------------------------------------
// Seq-conflict detection. ONE legitimate reset (edge reinstall, offline volume
// transfer) is a single event; repeated resets inside a short window mean two
// live senders are alternating seq domains under one rig_id — corruption that
// the reset heuristic would otherwise convert into silent acceptance, at one
// warn line per batch (a firehose nobody reads). Instead: rigs.seq_conflict_at
// is stamped for the fleet API, a COOLED error logs once per window, an
// audit_log row records the episode, and a Prometheus counter tracks volume.
// ---------------------------------------------------------------------------
const SEQ_RESET_WINDOW_MS = Number(process.env.INGEST_SEQ_CONFLICT_WINDOW_MS || 10 * 60_000);
const SEQ_RESET_EPISODE = Math.max(2, Number(process.env.INGEST_SEQ_CONFLICT_RESETS || 3));
const seqResetLog = new Map();   // rigId -> { times: number[], lastLoggedAt: number }

function trackSeqReset(rigId) {
    const now = Date.now();
    let e = seqResetLog.get(rigId);
    if (!e) { e = { times: [], lastLoggedAt: 0 }; seqResetLog.set(rigId, e); }
    e.times.push(now);
    while (e.times.length && now - e.times[0] > SEQ_RESET_WINDOW_MS) e.times.shift();
    const conflict = e.times.length >= SEQ_RESET_EPISODE;
    const shouldLog = conflict && (now - e.lastLoggedAt > SEQ_RESET_WINDOW_MS);
    if (shouldLog) e.lastLoggedAt = now;
    return { conflict, shouldLog, resets: e.times.length };
}

function seqResetsInWindow(rigId) {
    const e = seqResetLog.get(rigId);
    if (!e) return 0;
    const now = Date.now();
    while (e.times.length && now - e.times[0] > SEQ_RESET_WINDOW_MS) e.times.shift();
    return e.times.length;
}

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
        'SELECT rig_id, device_token, last_seq, sender_epoch, seq_conflict_at FROM rigs WHERE rig_id = $1', [rigId]);
    if (rows.length) return { ...rows[0], _new: false };
    // Never persist the FLEET-WIDE token as this rig's per-rig credential. Doing
    // so makes every auto-registered rig look provisioned while all 50 in fact
    // share one secret — and it hides them from `provision-rigs.js`, which skips
    // rigs that already have a token. Leave it NULL so the rig keeps using the
    // shared fallback until a real per-rig token is issued.
    const perRigToken = token && token !== GLOBAL_INGEST_TOKEN ? token : null;
    // RETURNING tells the truth about whether WE created the row. ON CONFLICT DO
    // NOTHING with an unconditional `_new: true` reported a fresh registration —
    // and fired the registration audit — even when a concurrent transaction had
    // just created the rig and this INSERT inserted nothing.
    const ins = await client.query(
        `INSERT INTO rigs (rig_id, name, status, device_token, schema_version, field)
         VALUES ($1, $2, 'pending', $3, $4, 'Ankleshwar')
         ON CONFLICT (rig_id) DO NOTHING
         RETURNING rig_id`,
        [rigId, rigId, perRigToken, schemaVersion || null]
    );
    const isNew = ins.rowCount === 1;
    if (!isNew) {
        // Lost the registration race: the rig now exists with fields we never saw
        // (possibly a provisioned device_token). Re-read the real row — the caller
        // MUST re-authorize against it, not against our null-token stand-in.
        const { rows: raced } = await client.query(
            `SELECT rig_id, device_token, last_seq, sender_epoch, seq_conflict_at
             FROM rigs WHERE rig_id = $1 FOR NO KEY UPDATE`, [rigId]);
        if (raced.length) return { ...raced[0], _new: false };
    }
    await client.query('INSERT INTO deployment_status (rig_id, gate, commissioning) VALUES ($1, $2, $3) ON CONFLICT (rig_id) DO NOTHING',
        [rigId, 'discovery', 'in_progress']);
    return { rig_id: rigId, device_token: perRigToken, last_seq: null, sender_epoch: null, seq_conflict_at: null, _new: isNew };
}

// Fail-closed authorization (audit #1). Accept a batch ONLY if the bearer token
// matches a per-rig device_token OR the global INGEST_TOKEN. If neither is
// configured anywhere, REJECT unless ALLOW_OPEN_INGEST is set (and not prod).
function authorize(rig, token) {
    // A provisioned per-rig credential is AUTHORITATIVE and the fleet-wide token
    // no longer satisfies that rig. Checking the shared token first (the previous
    // behaviour) meant per-rig provisioning bought no isolation: one leaked shared
    // secret could write telemetry as any of the 50 rigs. The shared token remains
    // valid only for rigs that have not been provisioned yet, so onboarding still
    // works. Mirrors auth.socketAuth so both ingress paths agree.
    if (rig && rig.device_token) return safeEqual(token, rig.device_token);
    if (GLOBAL_INGEST_TOKEN) return safeEqual(token, GLOBAL_INGEST_TOKEN);
    return ALLOW_OPEN_INGEST; // fail-closed by default; open only when explicitly allowed
}

// Decide whether this device is allowed to ingest WITHOUT auto-registering an
// unknown rig first (audit #1: only auto-register authorized devices). When a
// device_token has been provisioned for an existing rig, that wins; otherwise we
// fall back to the global INGEST_TOKEN / open-demo policy.
function authorizeKnown(rig, token) {
    // Same precedence as authorize(): per-rig credential wins, shared token is
    // only the not-yet-provisioned fallback.
    if (rig && rig.device_token) return safeEqual(token, rig.device_token);
    if (GLOBAL_INGEST_TOKEN) return safeEqual(token, GLOBAL_INGEST_TOKEN);
    return ALLOW_OPEN_INGEST;
}

// Rows per INSERT statement. One giant UNNEST over an unbounded replay drain
// built multi-million-element arrays in a single statement; chunking bounds
// per-statement memory while staying inside one transaction.
const INSERT_CHUNK = Math.max(1000, Number(process.env.INGEST_INSERT_CHUNK || 10000));

// Bulk-insert telemetry rows with chunked UNNEST statements. Idempotent on
// replay via ON CONFLICT DO NOTHING keyed on (rig_id, metric, ts) — the SCHEMA
// agent provides the matching unique index (audit #4).
// Returns BOTH counts: `attempted` is what the batch carried, `inserted` is what
// the database actually stored (rowCount). Reporting attempted as "received"
// made silent loss invisible — a batch whose rows all collided (or were dropped
// by a trigger/retention policy) still acked as fully stored.
// `source` attributes each row to its transport ('sync' | 'etp'), so two
// publishers under one rig_id are separable after the fact.
async function insertTelemetry(client, rigId, channels, nowIso, source) {
    const ts = [], metric = [], value = [];
    for (const snap of channels) {
        if (!snap || !snap.values) continue;
        // Bad/missing channel ts -> the batch's frozen arrival instant (identical
        // across retry attempts; see freezeTimestamps). (audit #11)
        const t = coerceTsIso(snap.ts) || nowIso;
        for (const [m, v] of Object.entries(snap.values)) {
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            ts.push(t); metric.push(m); value.push(n);
        }
    }
    if (!ts.length) return { attempted: 0, inserted: 0 };
    let inserted = 0;
    const sourceSql = await telemetryHasSource();
    for (let o = 0; o < ts.length; o += INSERT_CHUNK) {
        const end = Math.min(o + INSERT_CHUNK, ts.length);
        const r = sourceSql
            ? await client.query(
                `INSERT INTO telemetry (ts, rig_id, metric, value, source)
                 SELECT u.ts, $2, u.metric, u.value, $5
                 FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)
                 ON CONFLICT (rig_id, metric, ts) DO NOTHING`,
                [ts.slice(o, end), rigId, metric.slice(o, end), value.slice(o, end), source || null])
            : await client.query(
                `INSERT INTO telemetry (ts, rig_id, metric, value)
                 SELECT u.ts, $2, u.metric, u.value
                 FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)
                 ON CONFLICT (rig_id, metric, ts) DO NOTHING`,
                [ts.slice(o, end), rigId, metric.slice(o, end), value.slice(o, end)]);
        inserted += r.rowCount || 0;
    }
    return { attempted: ts.length, inserted };
}

// One-time capability probe: does telemetry carry the source column yet? Checked
// OUTSIDE the ingest transaction (a 42703 inside it would abort the whole batch)
// and cached for the process lifetime. Lets this code run against a volume whose
// schema predates the migration instead of hard-failing every batch.
let _hasSource = null;
async function telemetryHasSource() {
    if (_hasSource === null) {
        _hasSource = pool.query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'telemetry' AND column_name = 'source'`)
            .then((r) => r.rows.length > 0)
            .catch(() => { _hasSource = null; return false; });
    }
    return _hasSource;
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

// Global lock hierarchy for every writer that touches wells/well_runs:
//   rigs (taken at transaction start) -> wells, in ASCENDING well_id -> well_runs.
// Lock the target well and every well currently assigned to this rig up front,
// in PK order, BEFORE any well or well_run row is written. Without this, the
// "sweep other wells" UPDATE and the target-well upsert acquired the same two
// rows in opposite orders across transactions (two rigs starting each other's
// wells), which is a textbook 40P01 cycle. FOR NO KEY UPDATE, not FOR UPDATE:
// concurrent well_runs inserts take FK KEY SHARE on wells, which NO KEY UPDATE
// admits but FOR UPDATE would deadlock against. A target well that does not
// exist yet cannot be pre-locked; concurrent creators of the same PK serialise
// on the unique index instead (a wait, never a cycle).
async function lockWellsForRig(client, rigId, wellId) {
    await client.query(
        `SELECT well_id FROM wells
          WHERE well_id = $2 OR current_rig_id = $1
          ORDER BY well_id
          FOR NO KEY UPDATE`,
        [rigId, wellId]);
}

async function startWellForRig(client, rigId, ev) {
    const well = normalizeWellEvent(ev);
    if (!well.wellId) return null;
    await lockWellsForRig(client, rigId, well.wellId);
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
        // The partial unique index (one open run per rig) is the backstop: if a
        // concurrent writer opened a run despite the locks, insert nothing rather
        // than forking history into two open runs.
        await client.query(
            `INSERT INTO well_runs
               (well_id, rig_id, job_no, service, started_by, joints, depth_delta, productive_sec, npt_sec, started_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (rig_id) WHERE ended_at IS NULL DO NOTHING`,
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
    await lockWellsForRig(client, rigId, wellId);
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
// (Provenance audit moved to AFTER commit in ingestBatchOnce: run inside the
// transaction with a swallowed catch, a failed INSERT poisoned the transaction —
// every later statement died with 25P02 and COMMIT silently rolled back while
// ingest still returned ok:true.)

// Main entry. `rigId`/`token` are extracted from headers/body by the caller.
// Canonicalise wire metric names before anything downstream sees them, so
// telemetry rows, rig_latest, the per-tag freshness map and the completeness
// score all key off ONE spelling. Pre-consolidation edges emit the BOP group as
// `wellcontrol.*`; the canonical wire name is `well_control.*` (see lib/tags.js).
// Returns the input untouched when a batch carries no aliased metric, so the
// common path allocates nothing.
function normalizeChannelMetrics(channels) {
    if (!channels.length) return channels;
    return channels.map((snap) => {
        const values = snap && snap.values;
        if (!values || typeof values !== 'object') return snap;
        let hit = false;
        for (const k of Object.keys(values)) {
            if (WIRE_ALIASES[k]) { hit = true; break; }
        }
        if (!hit) return snap;
        const out = {};
        for (const [k, v] of Object.entries(values)) {
            // A canonical key already present wins over an aliased duplicate.
            const c = canonicalMetric(k);
            if (c in out && c !== k) continue;
            out[c] = v;
        }
        return { ...snap, values: out };
    });
}

// Stamp a fixed instant onto every channel/event that lacks a usable timestamp.
//
// This MUST happen before the transaction runs, and the same instant must be
// reused by every retry attempt. The write path falls back to
// `coerceTsIso(x.ts) || new Date().toISOString()` in six places, and `ts` is part
// of the dedup keys — telemetry (rig_id, metric, ts) and events
// (rig_id, ts, type, payload). If the clock were read per attempt, a retried
// transaction would compute DIFFERENT keys, ON CONFLICT DO NOTHING would find no
// conflict, and the same physical reading would be stored twice. Freezing the
// fallback here is what makes the transaction genuinely replay-safe.
function freezeTimestamps(channels, events, nowIso) {
    const frozenChannels = channels.map((snap) =>
        (snap && !coerceTsIso(snap.ts)) ? { ...snap, ts: nowIso } : snap);
    const frozenEvents = events.map((ev) =>
        (ev && !coerceTsIso(ev.ts)) ? { ...ev, ts: nowIso } : ev);
    return { frozenChannels, frozenEvents };
}

// Transient serialization failures Postgres expects the client to retry.
const RETRYABLE_SQLSTATES = new Set([
    '40P01',  // deadlock_detected
    '40001',  // serialization_failure
]);
const INGEST_ATTEMPTS = Math.max(1, Number(process.env.INGEST_TXN_ATTEMPTS || 3));

// Per-transaction bounds. 3600 channel snapshots = one hour of 1 Hz data in a
// single batch — an order of magnitude above the sync agent's ~10 s batches.
const MAX_CHANNELS_PER_BATCH = Math.max(60, Number(process.env.INGEST_MAX_CHANNELS || 3600));
const MAX_EVENTS_PER_BATCH = Math.max(50, Number(process.env.INGEST_MAX_EVENTS || 2000));

// Retry wrapper. A 40P01 victim currently surfaces as a 500 to the edge, which
// then treats the batch as a transient failure and re-sends it whole — so the
// work happens anyway, just a round-trip later and with a scary log line. Doing
// the retry here is cheaper and keeps the ack honest. Safe because every write in
// the transaction is ON CONFLICT-idempotent, the timestamps are frozen above, and
// all side effects (notifications) are dispatched by the caller AFTER commit.
async function ingestBatch(ctx, batch) {
    const nowIso = new Date().toISOString();
    let last;
    for (let attempt = 1; attempt <= INGEST_ATTEMPTS; attempt++) {
        last = await ingestBatchOnce(ctx, batch, nowIso);
        if (last.ok || !RETRYABLE_SQLSTATES.has(last.sqlState)) return last;
        console.warn(`[ingest] ${last.rigId || 'unknown'}: ${last.sqlState} on attempt ${attempt}/${INGEST_ATTEMPTS}; retrying`);
        // Jittered backoff so the two victims of a cycle don't collide again.
        await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 25));
    }
    return last;
}

async function ingestBatchOnce({ rigId, token, schemaVersion }, batch, nowIso) {
    rigId = batch.deviceId || rigId;
    if (!rigId) return { ok: false, code: 400, error: 'missing deviceId' };

    // Coerce seq to a safe integer or null up front (audit #11) — never bind a
    // raw untrusted value into the BIGINT last_seq column.
    const seq = Number.isSafeInteger(Number(batch.seq)) ? Number(batch.seq) : null;

    const frozen = freezeTimestamps(
        normalizeChannelMetrics(Array.isArray(batch.channels) ? batch.channels : []),
        Array.isArray(batch.events) ? batch.events : [],
        nowIso);
    let channels = frozen.frozenChannels;
    let events = frozen.frozenEvents;

    // Bound the transaction. An uncapped batch (a store-and-forward drain, or a
    // hostile sender) built multi-million-row arrays inside one transaction. Keep
    // the NEWEST channels — the tail carries current state — and say so in the
    // log; a silent cap would read as "stored everything" when it did not. The
    // edge's own batches are ~10s of channels, far below any sane cap; only a
    // sender that ignores the batching contract ever hits this.
    if (channels.length > MAX_CHANNELS_PER_BATCH) {
        console.warn(`[ingest] ${rigId || batch.deviceId}: batch carried ${channels.length} channel snapshots; keeping newest ${MAX_CHANNELS_PER_BATCH}`);
        channels = channels.slice(-MAX_CHANNELS_PER_BATCH);
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
        console.warn(`[ingest] ${rigId || batch.deviceId}: batch carried ${events.length} events; keeping newest ${MAX_EVENTS_PER_BATCH}`);
        events = events.slice(-MAX_EVENTS_PER_BATCH);
    }
    const wellPayload = findWellPayloadInBatch(batch, channels);
    const normalizedSnapshotWell = wellPayload ? normalizeWellPayload(wellPayload) : null;
    const hasIncomingWellLifecycleEvent = events.some((ev) => ev && ['well.created', 'well.updated', 'well.started', 'well.completed'].includes(ev.type));
    if (!hasIncomingWellLifecycleEvent && normalizedSnapshotWell && normalizedSnapshotWell.wellId) {
        events = [
            ...events,
            {
                // nowIso, not a fresh clock read — this synthesized event is part of
                // the events dedup key and must be identical on every retry attempt.
                ts: normalizedSnapshotWell.startedAt || batch.createdAt || nowIso,
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
    let mergedMetrics = null;     // rig_latest key set after this batch merged in
    let pointsAttempted = 0;      // rows the batch carried (vs `points` = rows stored)
    let activeJob = null;         // job/well this batch is working (for well-run tracking)
    try {
        await client.query('BEGIN');

        // Look up the rig WITHOUT creating it, so an unauthorized unknown device
        // cannot auto-enroll a fake rig (audit #1).
        //
        // FOR NO KEY UPDATE (not FOR UPDATE): this is the transaction's first
        // lock and it serialises ALL ingest for one rig, closing the lost-update
        // TOCTOU on the read-modify-write below — two concurrent batches both
        // read last_seq/alarm_* and the loser's Math.max regressed the high-water
        // mark and computed its alarm rising-edge from a stale snapshot. It also
        // establishes the global lock hierarchy (rigs -> wells -> well_runs).
        // NO KEY UPDATE specifically, because concurrent wells writes take FK
        // KEY SHARE on this row — compatible with NO KEY UPDATE, but FOR UPDATE
        // would turn every well insert into a lock conflict and manufacture the
        // very deadlocks this ordering exists to remove.
        const { rows: existing } = await client.query(
            `SELECT rig_id, device_token, last_seq, sender_epoch, seq_conflict_at,
                    alarm_active, alarm_p1, alarm_highest, active_job
             FROM rigs WHERE rig_id = $1
             FOR NO KEY UPDATE`, [rigId]);
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
            // Registration race: another transaction created this rig first and
            // ensureRig returned ITS row. The earlier authorize ran against a
            // null rig (shared-token path); the real row may carry a provisioned
            // device_token that must now be honoured.
            if (!r._new && !authorizeKnown(rig, token)) {
                await client.query('ROLLBACK').catch(() => {});
                return { ok: false, code: 401, error: 'unauthorized device' };
            }
        }

        // Replay idempotency fast-path (audit #4): skip batches whose seq is not
        // newer than the last accepted seq, read in this same transaction. A null
        // incoming seq is treated as always-accept (legacy/uncounted senders).
        //
        // This is only a FAST PATH — correctness against true replays comes from
        // the unique index on (rig_id, metric, ts) + ON CONFLICT DO NOTHING, which
        // makes re-delivery harmless regardless of seq.
        //
        // Counter-restart recognition, strongest signal first:
        //  1. SENDER EPOCH (deterministic). The edge mints an epoch id whenever
        //     its sync state is created and sends it on every batch. Same epoch ->
        //     a backward seq is a true replay, no matter how large the jump.
        //     Different epoch -> the counter restarted, re-baseline exactly once.
        //  2. Magnitude heuristic (fallback for epoch-less senders): a small
        //     backward step is a replay; a jump of >= SEQ_RESET_GAP is a restart.
        //     Necessary because treating every backward jump as a replay silently
        //     blackholes a rig that lost sync_state.json — it keeps getting
        //     ok:true / 0 points while nothing is stored.
        const lastSeq = rig && rig.last_seq != null ? Number(rig.last_seq) : null;
        const batchEpoch = typeof batch.epoch === 'string' && batch.epoch.trim()
            ? batch.epoch.trim().slice(0, 64) : null;
        const storedEpoch = rig && rig.sender_epoch ? String(rig.sender_epoch) : null;
        let backwards = false;
        let senderReset = false;
        let resetReason = '';
        if (seq != null && lastSeq != null) {
            if (batchEpoch && storedEpoch) {
                if (batchEpoch !== storedEpoch) {
                    senderReset = true;
                    resetReason = `sender epoch changed (${storedEpoch} -> ${batchEpoch})`;
                } else {
                    backwards = seq <= lastSeq;   // same epoch: strictly monotonic
                }
            } else {
                backwards = seq <= lastSeq;
                senderReset = backwards && (lastSeq - seq) >= SEQ_RESET_GAP;
                if (senderReset) resetReason = `large backward jump (incoming ${seq} << last ${lastSeq})`;
            }
        }
        if (backwards && !senderReset && !hasWellLifecycleEvent) {
            await client.query('ROLLBACK').catch(() => {});
            return { ok: true, rigId, points: 0, events: 0, seq, duplicate: true };
        }
        let seqConflict = false;
        if (senderReset) {
            const track = trackSeqReset(rigId);
            seqConflict = track.conflict;
            if (track.shouldLog) {
                // Cooled: once per window, as an ERROR — repeated resets mean two
                // live senders under one rig_id, which is data corruption, not noise.
                console.error(`[ingest] ${rigId}: SEQ-DOMAIN CONFLICT — ${track.resets} sequence resets in ${Math.round(SEQ_RESET_WINDOW_MS / 60000)} min (latest: ${resetReason}). Two senders are likely publishing as this rig; their rows are interleaving under one identity.`);
                metrics.incSeqConflict(rigId);
                // Audit the episode (fire-and-forget on the POOL, not this client:
                // must not abort the transaction, and should survive its rollback).
                pool.query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                    ['ingest', 'ingest.seq_conflict', rigId,
                        { resetsInWindow: track.resets, reason: resetReason, seq, lastSeq }]).catch(() => {});
            } else {
                console.warn(`[ingest] ${rigId}: sequence reset detected (${resetReason}); re-baselining`);
            }
            metrics.incSeqReset(rigId);
        }

        const source = String(schemaVersion || batch.schemaVersion || '').startsWith('etp20') ? 'etp' : 'sync';
        const insertedCounts = await insertTelemetry(client, rigId, channels, nowIso, source);
        points = insertedCounts.inserted;
        pointsAttempted = insertedCounts.attempted;

        const snap = latestSnapshot(channels);
        const snapWellName = (snap ? findWellNameInSnapshot(snap) : '') || findWellNameInBatch(batch, channels);
        let snapAccepted = false;
        if (snap) {
            // Per-tag last-seen map (audit #22): stamp each metric with this
            // snapshot's ts under the reserved __ts key, merged into the cache.
            const snapTsIso = coerceTsIso(snap.ts) || nowIso;
            const tsMap = {};
            for (const m of Object.keys(snap.values)) tsMap[m] = snapTsIso;
            // Insert values already carrying the reserved __ts map so per-tag age is
            // available from the very first batch (audit #22); on conflict, merge
            // both the values and the __ts map so a frozen tag keeps its old ts.
            const insertValues = { ...snap.values, [TS_KEY]: tsMap };
            // MONOTONIC in snapshot time: the WHERE guard makes an out-of-order
            // store-and-forward replay leave the cache alone. Without it, whichever
            // batch COMMITTED last won — an hours-old buffered snapshot draining
            // after an outage overwrote live values (both || merges are
            // right-operand-wins) and was then stamped fresh by the health update.
            // RETURNING the merged row lets completeness be scored from the rig's
            // ACTUAL current state rather than from this one batch; zero rows back
            // means the snapshot was stale, so live state and health stay untouched
            // (the telemetry HISTORY rows above are still stored).
            const up = await client.query(
                `INSERT INTO rig_latest (rig_id, ts, values)
                 VALUES ($1, $2, $3::jsonb)
                 ON CONFLICT (rig_id) DO UPDATE
                   SET ts = EXCLUDED.ts,
                       values = (rig_latest.values || EXCLUDED.values)
                                 || jsonb_build_object($4::text,
                                      COALESCE(rig_latest.values->$4, '{}'::jsonb) || $5::jsonb)
                 WHERE rig_latest.ts IS NULL OR EXCLUDED.ts >= rig_latest.ts
                 RETURNING values`,
                [rigId, snapTsIso, JSON.stringify(insertValues), TS_KEY, JSON.stringify(tsMap)]
            );
            const merged = up.rows[0] && up.rows[0].values;
            if (merged) {
                snapAccepted = true;
                mergedMetrics = Object.keys(merged).filter((k) => k !== TS_KEY);
            }
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
        // Score completeness against the rig's MERGED current state, not this single
        // batch. Scoring per-batch meant any narrower publisher for the same rig
        // redefined its health: a 7-channel ETP frame arriving between 119-metric
        // sync batches dropped the rig to metric_count=7 / health=59 / "degraded",
        // then the next sync batch restored it — flapping purely on which sender
        // committed last. It also punished any edge that legitimately splits its
        // metrics across batches. rig_latest is the authoritative current state.
        const presentMetrics = mergedMetrics || (snap ? Object.keys(snap.values) : []);
        const health = computeHealth({ latestTs, presentMetrics });

        // Compose rollup update. Telemetry health/count changes only when this
        // batch carried a snapshot the cache ACCEPTED (snapAccepted): well-only
        // event batches must not wipe live data, and a stale replayed snapshot
        // must not stamp the rig fresh (rig_latest already rejected it above).
        const sets = ['updated_at = now()'];
        const vals = [rigId];
        let i = vals.length;
        if (snapAccepted) {
            sets.push(`last_data_at = $${++i}`); vals.push(new Date(latestTs).toISOString());
            sets.push(`sync_lag_sec = $${++i}`); vals.push(health.syncLagSec);
            sets.push(`health_score = $${++i}`); vals.push(health.score);
            sets.push(`metric_count = $${++i}`); vals.push(presentMetrics.length);
            sets.push(`status = $${++i}`); vals.push(health.status);
        }
        // Adopt/roll the sender epoch, and maintain the conflict flag: stamp it on
        // a detected conflict episode; clear it once resets stop and a clean
        // in-order batch arrives (the flag is r.* on the fleet API, so the portal
        // sees a rig enter and leave the conflicted state without a UI change).
        if (batchEpoch && batchEpoch !== storedEpoch) {
            sets.push(`sender_epoch = $${++i}`); vals.push(batchEpoch);
        }
        if (seqConflict) {
            sets.push('seq_conflict_at = now()');
        } else if (rig && rig.seq_conflict_at && seq != null && !backwards && seqResetsInWindow(rigId) === 0) {
            sets.push('seq_conflict_at = NULL');
        }
        // On a detected sender reset, adopt the NEW counter instead of keeping the
        // old high-water mark — otherwise max() pins last_seq at the stale value and
        // every subsequent batch from the restarted edge is dropped as a replay.
        const newLastSeq = seq == null
            ? lastSeq
            : (senderReset || lastSeq == null ? seq : Math.max(seq, lastSeq));
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

        // Well-run tracking, INSIDE this transaction. It used to run as a separate
        // fire-and-forget transaction after the ack (server.js), which (a) locked
        // wells/well_runs in the OPPOSITE order to startWellForRig — the primary
        // 40P01 lock-order inversion — and (b) raced this transaction's own view of
        // active_job, flip-flopping runs between the old and new well. In here it
        // runs under the rigs row lock (fully serialised per rig) and follows the
        // same rigs -> wells -> well_runs hierarchy. Skipped when this batch
        // carried an explicit lifecycle event: startWellForRig already did the
        // rotation, and doing it twice from two different name-resolution paths is
        // exactly the disagreement that forked duplicate open runs.
        // SAVEPOINT preserves trackRun's old "never breaks ingest" contract:
        // a failure rolls back only the tracking, not the whole batch.
        if (activeJob && !hasWellLifecycleEvent && !processed.lifecycle) {
            await client.query('SAVEPOINT track_run');
            try {
                await wells.trackRunInTxn(client, rigId, activeJob);
                await client.query('RELEASE SAVEPOINT track_run');
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT track_run');
                console.error(`[ingest] ${rigId}: well-run tracking failed (batch unaffected):`, e.message);
            }
        }

        await client.query(`UPDATE rigs SET ${sets.join(', ')} WHERE rig_id = $1`, vals);

        await client.query('COMMIT');

        // Provenance audit AFTER commit, on the pool. Inside the transaction, its
        // swallowed catch hid a poisoned transaction: if the INSERT failed, every
        // later statement died with 25P02, "COMMIT" silently rolled back, and
        // ingest still answered ok:true — an acked batch that stored nothing.
        if (registered) {
            const device = token ? `token:${String(token).slice(0, 6)}…` : 'anonymous';
            pool.query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                ['ingest', 'rig.autoregister', rigId, { device, rigId, seq: seq ?? null }])
                .catch((e) => console.warn('[ingest] autoregister audit failed:', e.message));
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // Surface a tagged error so server.js can log full detail server-side and
        // return a generic message to the untrusted caller (audit #11).
        // sqlState lets the retry wrapper distinguish a transient serialization
        // failure (40P01/40001 — worth another attempt) from a real fault.
        return { ok: false, code: 500, error: 'ingest failed', detail: e.message, sqlState: e.code, rigId };
    } finally {
        client.release();
    }

    return { ok: true, rigId, points, pointsAttempted, events: events.length, seq, alarmTransition, activeJob };
}

module.exports = { ingestBatch, EXPECTED_METRICS };

'use strict';
// Fleet status, data-quality scoring, drill-down queries and the offline sweeper.
// (proposal Â§6.1: fleet overview, rig drill-down, data quality monitor, alarm command centre)
const { query } = require('./db');
const { EXPECTED_METRICS, KEY_METRICS, TAG_BY_METRIC } = require('./tags');

const FRESH_SEC = Number(process.env.CENTRAL_LATENCY_TARGET || 30); // proposal <30 s
// Offline threshold (no data => offline). Mutable so the Settings screen can retune
// it live (lib/settings.js calls setOfflineSec); seeded from the env at boot.
let OFFLINE_SEC = Number(process.env.OFFLINE_SEC || 120);
const TS_KEY = '__ts'; // reserved per-tag last-seen map inside rig_latest.values (audit #22)

// Live setter for the offline threshold, invoked by lib/settings.js when an admin
// PATCHes offline_sec. Clamped to a sane floor so the sweeper can't be disabled.
function setOfflineSec(n) {
    const v = Math.round(Number(n));
    if (Number.isFinite(v) && v >= 10) OFFLINE_SEC = v;
    return OFFLINE_SEC;
}

// Per-rig data-quality health (0-100) from freshness (sync lag) + tag completeness.
function computeHealth({ latestTs, presentMetrics }) {
    const now = Date.now();
    const syncLagSec = Math.max(0, Math.round((now - (latestTs || 0)) / 1000));
    const present = new Set(presentMetrics || []);
    const expectedPresent = EXPECTED_METRICS.filter((m) => present.has(m)).length;
    const completeness = EXPECTED_METRICS.length ? expectedPresent / EXPECTED_METRICS.length : 1;
    const freshness = syncLagSec <= FRESH_SEC ? 1
        : syncLagSec >= OFFLINE_SEC ? 0
        : 1 - (syncLagSec - FRESH_SEC) / (OFFLINE_SEC - FRESH_SEC);
    const score = Math.round((0.55 * completeness + 0.45 * freshness) * 100);
    let status;
    if (syncLagSec >= OFFLINE_SEC) status = 'offline';
    else if (score >= 80) status = 'online';
    else if (score >= 50) status = 'degraded';
    else status = 'stale';
    return { syncLagSec, score, status, completeness: Math.round(completeness * 100), missingTags: EXPECTED_METRICS.length - expectedPresent };
}

// Apply a live offline/lag override so the fleet view is current even between sweeps.
function liveize(row) {
    const lastMs = row.last_data_at ? Date.parse(row.last_data_at) : null;
    const lagSec = lastMs ? Math.round((Date.now() - lastMs) / 1000) : null;
    let status = row.status;
    if (status !== 'pending') {
        if (lastMs == null) status = 'offline';
        else if (lagSec >= OFFLINE_SEC) status = 'offline';
    }
    return {
        rigId: row.rig_id,
        name: row.name,
        section: row.section,
        assetUnit: row.asset_unit,
        field: row.field,
        latitude: row.latitude,
        longitude: row.longitude,
        status,
        healthScore: status === 'offline' ? 0 : row.health_score,
        metricCount: row.metric_count,
        syncLagSec: lagSec,
        lastDataAt: row.last_data_at,
        activeJob: row.active_job,
        activeActivity: row.active_activity,
        // Non-null while central is detecting repeated sequence resets for this
        // rig — i.e. two senders are likely publishing under its identity.
        seqConflictAt: row.seq_conflict_at || null,
        alarm: {
            active: row.alarm_active, unack: row.alarm_unack,
            p1: row.alarm_p1, p2: row.alarm_p2, p3: row.alarm_p3,
            highest: status === 'offline' ? null : row.alarm_highest,
        },
        edgeVersion: row.edge_version,
        gate: row.gate,
        adoptionPct: row.adoption_pct,
        commissioned: row.commissioned_at,
    };
}

const FLEET_SELECT = `
    SELECT r.*, d.gate, d.edge_version, d.adoption_pct,
           cw.well_id AS current_well_id, cw.name AS current_well_name
    FROM rigs r
    LEFT JOIN deployment_status d ON d.rig_id = r.rig_id
    LEFT JOIN LATERAL (
        SELECT well_id, name
        FROM wells
        WHERE current_rig_id = r.rig_id
        ORDER BY well_id
        LIMIT 1
    ) cw ON true`;

async function getFleet() {
    const { rows } = await query(`${FLEET_SELECT} ORDER BY r.rig_id`);
    return rows.map(liveize);
}

// Lightweight single-rig fleet row for Socket.IO deltas.
async function getFleetRow(rigId) {
    const { rows } = await query(`${FLEET_SELECT} WHERE r.rig_id = $1`, [rigId]);
    return rows.length ? liveize(rows[0]) : null;
}

async function getFleetSummary() {
    const fleet = await getFleet();
    const by = (s) => fleet.filter((r) => r.status === s).length;
    // Average health over rigs that are actually reporting (online/degraded/stale),
    // so the score reflects data quality of the live link, not onboarding progress.
    const reporting = fleet.filter((r) => ['online', 'degraded', 'stale'].includes(r.status));
    // Alarm KPI cards must agree with the Alarm Command Centre (audit #23): exclude
    // offline and pending rigs, whose sticky alarm columns are no longer live.
    const alarmable = fleet.filter((r) => r.status !== 'offline' && r.status !== 'pending');
    return {
        total: fleet.length,
        online: by('online'),
        degraded: by('degraded'),
        stale: by('stale'),
        offline: by('offline'),
        pending: by('pending'),
        alarmsActive: alarmable.reduce((s, r) => s + (r.alarm.active || 0), 0),
        alarmsP1: alarmable.reduce((s, r) => s + (r.alarm.p1 || 0), 0),
        avgHealth: reporting.length ? Math.round(reporting.reduce((s, r) => s + (r.healthScore || 0), 0) / reporting.length) : 0,
        rigsReporting: fleet.filter((r) => r.lastDataAt).length,
    };
}

async function getRig(rigId) {
    const { rows } = await query(`${FLEET_SELECT} WHERE r.rig_id = $1`, [rigId]);
    if (!rows.length) return null;
    const base = liveize(rows[0]);

    const latest = await query('SELECT ts, values FROM rig_latest WHERE rig_id = $1', [rigId]);
    const offline = base.status === 'offline' || base.status === 'pending';
    // Offline/pending rigs may have old rig_latest rows from a previous connection or
    // seeded data. Do not present those as current values in the rig drill-down.
    const rawValues = offline ? {} : (latest.rows[0]?.values || {});
    // Per-tag last-seen map maintained by ingest under the reserved __ts key
    // (audit #22), so a frozen tag can be told apart from a live one.
    const tsMap = rawValues[TS_KEY] || {};
    const now = Date.now();
    const ageSecOf = (metric) => {
        const seen = tsMap[metric];
        const ms = seen ? Date.parse(seen) : NaN;
        return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 1000)) : null;
    };
    // Display values exclude the reserved bookkeeping key.
    const values = {};
    for (const [k, v] of Object.entries(rawValues)) { if (k !== TS_KEY) values[k] = v; }
    // Group latest values by equipment group, decorated with label/unit from the tag dictionary.
    const groups = {};
    for (const [metric, value] of Object.entries(values)) {
        const tag = TAG_BY_METRIC[metric];
        const group = tag?.group || 'Other';
        const ageSec = ageSecOf(metric);
        (groups[group] = groups[group] || []).push({
            metric, value,
            label: tag?.label || metric,
            unit: tag?.unit || '',
            key: !!tag?.key,
            perTagAgeSec: ageSec,
            stale: ageSec != null && ageSec > OFFLINE_SEC,
        });
    }

    const alarms = await query(
        `SELECT ts, payload FROM events WHERE rig_id = $1 AND type = 'alarm' ORDER BY ts DESC LIMIT 20`, [rigId]);
    const connections = await query(
        `SELECT ts, peak_torque, result, joint FROM connections WHERE rig_id = $1 ORDER BY ts DESC LIMIT 20`, [rigId]);
    const deployment = await query('SELECT * FROM deployment_status WHERE rig_id = $1', [rigId]);

    return {
        ...base,
        latestTs: latest.rows[0]?.ts || null,
        groups,
        keyMetrics: KEY_METRICS.map((m) => ({
            metric: m, label: TAG_BY_METRIC[m]?.label || m, unit: TAG_BY_METRIC[m]?.unit || '',
            value: values[m] ?? null,
            perTagAgeSec: ageSecOf(m),
            stale: (() => { const a = ageSecOf(m); return a != null && a > OFFLINE_SEC; })(),
        })),
        recentAlarms: alarms.rows,
        recentConnections: connections.rows,
        deployment: deployment.rows[0] || null,
    };
}

// Time-series for one metric (proposal: rig drill-down trends). Uses the 1-min
// continuous aggregate for long ranges, raw points for short ones.
async function getHistory(rigId, metric, minutes = 30) {
    const mins = Math.min(Math.max(Number(minutes) || 30, 1), 60 * 24 * 7);
    if (mins <= 180) {
        const { rows } = await query(
            `SELECT ts, value FROM telemetry
             WHERE rig_id = $1 AND metric = $2 AND ts > now() - ($3 || ' minutes')::interval
             ORDER BY ts ASC`, [rigId, metric, mins]);
        return rows.map((r) => ({ ts: r.ts, value: r.value }));
    }
    const { rows } = await query(
        `SELECT bucket AS ts, avg, min, max FROM telemetry_1m
         WHERE rig_id = $1 AND metric = $2 AND bucket > now() - ($3 || ' minutes')::interval
         ORDER BY bucket ASC`, [rigId, metric, mins]);
    return rows.map((r) => ({ ts: r.ts, value: r.avg, min: r.min, max: r.max }));
}

// Alarm command centre (proposal Â§6.1): cross-rig active alarms, newest first.
async function getAlarms({ priority } = {}) {
    const fleet = await getFleet();
    let list = fleet
        .filter((r) => r.alarm && r.alarm.active > 0 && r.status !== 'offline')
        .map((r) => ({
            rigId: r.rigId, name: r.name, field: r.field,
            active: r.alarm.active, unack: r.alarm.unack,
            p1: r.alarm.p1, p2: r.alarm.p2, p3: r.alarm.p3,
            highest: r.alarm.highest, lastDataAt: r.lastDataAt, activeActivity: r.activeActivity,
        }));
    if (priority === 'p1') list = list.filter((a) => a.p1 > 0);
    else if (priority === 'p2') list = list.filter((a) => a.p2 > 0);
    else if (priority === 'p3') list = list.filter((a) => a.p3 > 0);
    // P1 first, then by active count.
    list.sort((a, b) => (b.p1 - a.p1) || (b.active - a.active));
    return list;
}

// Data quality monitor (proposal Â§6.1): per-rig freshness + completeness.
async function getDataQuality() {
    const fleet = await getFleet();
    return fleet.map((r) => {
        const missing = r.status === 'pending' ? EXPECTED_METRICS.length
            : Math.max(0, Math.round(EXPECTED_METRICS.length * (1 - (r.healthScore || 0) / 100) * 0.55 / 0.55));
        return {
            rigId: r.rigId, name: r.name, status: r.status,
            healthScore: r.healthScore, syncLagSec: r.syncLagSec,
            metricCount: r.metricCount, expectedMetrics: EXPECTED_METRICS.length,
            lastDataAt: r.lastDataAt,
            staleFlag: r.syncLagSec != null && r.syncLagSec > FRESH_SEC,
            offline: r.status === 'offline',
        };
    });
}

// Mark rigs offline once their data ages past the threshold. Returns the rig ids
// whose status flipped so the caller can emit a fleet delta.
async function sweepOffline() {
    // Zero ALL alarm counters when flipping offline (audit #23) so a rig that drops
    // offline mid-alarm stops inflating the fleet KPI cards. The counters are
    // sticky (only written on an alarm event), so they must be cleared here.
    const { rows } = await query(
        `UPDATE rigs SET status = 'offline', health_score = 0,
                         alarm_active = 0, alarm_unack = 0,
                         alarm_p1 = 0, alarm_p2 = 0, alarm_p3 = 0,
                         alarm_highest = NULL, updated_at = now()
         WHERE status NOT IN ('offline','pending')
           AND last_data_at IS NOT NULL
           AND last_data_at < now() - ($1 || ' seconds')::interval
         RETURNING rig_id`, [OFFLINE_SEC]);
    return rows.map((r) => r.rig_id);
}

module.exports = {
    computeHealth, getFleet, getFleetRow, getFleetSummary, getRig, getHistory,
    getAlarms, getDataQuality, sweepOffline, setOfflineSec, FRESH_SEC,
    // Expose the current threshold via a getter so callers always read the live value.
    get OFFLINE_SEC() { return OFFLINE_SEC; },
};

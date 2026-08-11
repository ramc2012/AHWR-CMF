'use strict';
// Governance & rollout workspace + workover performance + reporting queries
// (proposal §6.1 governance workspace, workover performance, reporting; §7 value realization).
const { query } = require('./db');

const GATES = ['gate0', 'discovery', 'implementation', 'operation', 'live'];
const GATE_LABEL = {
    gate0: 'Gate 0 — Approval', discovery: 'Phase 1a — Discovery',
    implementation: 'Phase 1b — Implementation', operation: 'Phase 1c — Operation',
    live: 'Phase 2 — Live / Fleet',
};

// ----- Governance workspace -----
async function getGovernance() {
    const rigs = await query(`
        SELECT r.rig_id, r.name, r.field, r.status, r.commissioned_at,
               d.gate, d.commissioning, d.site_ready, d.security_review,
               d.adoption_pct, d.open_issues, d.wave, d.edge_version, d.notes
        FROM rigs r LEFT JOIN deployment_status d ON d.rig_id = r.rig_id
        ORDER BY r.rig_id`);
    const escalations = await query(
        `SELECT e.*, r.name AS rig_name FROM escalations e
         LEFT JOIN rigs r ON r.rig_id = e.rig_id ORDER BY
         CASE e.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.opened_at DESC`);
    const decisions = await query('SELECT * FROM decisions ORDER BY ts DESC LIMIT 100');
    const value = await query('SELECT * FROM value_metrics ORDER BY id');

    // Stage-gate funnel counts.
    const funnel = GATES.map((g) => ({
        gate: g, label: GATE_LABEL[g],
        count: rigs.rows.filter((r) => (r.gate || 'gate0') === g).length,
    }));
    const adoptionAvg = rigs.rows.length
        ? Math.round(rigs.rows.reduce((s, r) => s + (r.adoption_pct || 0), 0) / rigs.rows.length) : 0;

    return {
        rigs: rigs.rows,
        funnel,
        gates: GATES.map((g) => ({ value: g, label: GATE_LABEL[g] })),
        escalations: escalations.rows,
        decisions: decisions.rows,
        valueMetrics: value.rows,
        summary: {
            total: rigs.rows.length,
            commissioned: rigs.rows.filter((r) => r.commissioning === 'commissioned').length,
            live: rigs.rows.filter((r) => (r.gate || '') === 'live').length,
            openEscalations: escalations.rows.filter((e) => e.status !== 'resolved').length,
            adoptionAvg,
        },
    };
}

async function updateDeployment(rigId, patch, actor) {
    const allow = ['gate', 'commissioning', 'site_ready', 'security_review', 'adoption_pct', 'open_issues', 'wave', 'edge_version', 'notes'];
    const sets = [], vals = [rigId];
    for (const k of allow) {
        if (k in (patch || {})) { sets.push(`${k} = $${vals.length + 1}`); vals.push(patch[k]); }
    }
    if (!sets.length) return null;
    sets.push('updated_at = now()');
    await query(
        `INSERT INTO deployment_status (rig_id) VALUES ($1) ON CONFLICT (rig_id) DO NOTHING`, [rigId]);
    await query(`UPDATE deployment_status SET ${sets.join(', ')} WHERE rig_id = $1`, vals);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'deployment.update', rigId, patch]);
    const { rows } = await query('SELECT * FROM deployment_status WHERE rig_id = $1', [rigId]);
    return rows[0];
}

async function addEscalation({ rigId, title, severity, owner, notes }, actor) {
    const { rows } = await query(
        `INSERT INTO escalations (rig_id, title, severity, owner, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [rigId || null, title, severity || 'medium', owner || null, notes || null]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'escalation.add', rigId, { title }]);
    return rows[0];
}

async function updateEscalation(id, patch, actor) {
    const allow = ['status', 'severity', 'owner', 'notes'];
    const sets = [], vals = [id];
    for (const k of allow) if (k in (patch || {})) { sets.push(`${k} = $${vals.length + 1}`); vals.push(patch[k]); }
    if (patch.status === 'resolved') sets.push('resolved_at = now()');
    if (!sets.length) return null;
    await query(`UPDATE escalations SET ${sets.join(', ')} WHERE id = $1`, vals);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'escalation.update', String(id), patch]);
    const { rows } = await query('SELECT * FROM escalations WHERE id = $1', [id]);
    return rows[0];
}

async function addDecision({ title, detail }, actor) {
    const { rows } = await query(
        'INSERT INTO decisions (title, detail, author) VALUES ($1,$2,$3) RETURNING *',
        [title, detail || null, actor || 'system']);
    // Audit the mutation like its sibling governance writes (audit #14).
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'decision.add', String(rows[0].id), { title }]);
    return rows[0];
}

// ----- Workover performance (proposal §6.1) -----
async function getWorkover({ hours = 24 } = {}) {
    const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
    // Connection quality fleet-wide.
    const conn = await query(`
        SELECT c.rig_id, r.name,
               count(*) AS total,
               count(*) FILTER (WHERE c.result = 'PASS') AS pass,
               count(*) FILTER (WHERE c.result = 'FAIL') AS fail,
               round(avg(c.peak_torque)::numeric, 0) AS avg_peak,
               max(c.peak_torque) AS max_peak
        FROM connections c LEFT JOIN rigs r ON r.rig_id = c.rig_id
        WHERE c.ts > now() - ($1 || ' hours')::interval
        GROUP BY c.rig_id, r.name ORDER BY total DESC`, [h]);
    // Recent activity events (NPT/activity tracking).
    const activity = await query(`
        SELECT e.rig_id, r.name, e.ts, e.payload
        FROM events e LEFT JOIN rigs r ON r.rig_id = e.rig_id
        WHERE e.type = 'activity' AND e.ts > now() - ($1 || ' hours')::interval
        ORDER BY e.ts DESC LIMIT 200`, [h]);
    return {
        windowHours: h,
        connections: conn.rows.map((r) => ({
            rigId: r.rig_id, name: r.name,
            total: Number(r.total), pass: Number(r.pass), fail: Number(r.fail),
            passRate: Number(r.total) ? Math.round((Number(r.pass) / Number(r.total)) * 100) : null,
            avgPeak: r.avg_peak != null ? Number(r.avg_peak) : null,
            maxPeak: r.max_peak != null ? Number(r.max_peak) : null,
        })),
        activity: activity.rows,
    };
}

// ----- Reporting (proposal §6.1) -----
// Snapshot report (current live state per rig) — unchanged default behaviour.
async function getFleetReport() {
    const rigs = await query(`
        SELECT r.rig_id, r.name, r.field, r.status, r.health_score, r.metric_count,
               r.last_data_at, r.active_activity, r.alarm_active, r.alarm_p1,
               d.gate, d.adoption_pct, d.commissioning
        FROM rigs r LEFT JOIN deployment_status d ON d.rig_id = r.rig_id
        ORDER BY r.rig_id`);
    return rigs.rows;
}

// Daily/weekly/monthly consolidated report (audit #29 / proposal §6.1 DWR).
// Aggregates per rig over the chosen window from the 1-minute continuous
// aggregate (telemetry health/ingest), the events stream (alarms), and the
// connections table (workover pass-rate). `period` is snapshot|daily|weekly|monthly.
const PERIODS = { daily: '1 day', weekly: '7 days', monthly: '30 days' };

async function getFleetReportPeriod(period = 'snapshot') {
    const p = String(period || 'snapshot').toLowerCase();
    if (p === 'snapshot' || !PERIODS[p]) {
        return { period: 'snapshot', windowInterval: null, rows: await getFleetReport() };
    }
    const win = PERIODS[p];

    // Telemetry rollup over the window from the 1-minute CAGG.
    const tel = await query(`
        SELECT rig_id,
               count(*)                         AS sample_buckets,
               count(DISTINCT metric)           AS distinct_metrics,
               round(avg(avg)::numeric, 2)      AS avg_value
        FROM telemetry_1m
        WHERE bucket > now() - $1::interval
        GROUP BY rig_id`, [win]);
    const telBy = new Map(tel.rows.map((r) => [r.rig_id, r]));

    // Alarm + activity event counts over the window.
    const evt = await query(`
        SELECT rig_id,
               count(*) FILTER (WHERE type = 'alarm')      AS alarm_events,
               count(*) FILTER (WHERE type = 'activity')   AS activity_events,
               count(*) FILTER (WHERE type = 'connection') AS connection_events
        FROM events
        WHERE ts > now() - $1::interval
        GROUP BY rig_id`, [win]);
    const evtBy = new Map(evt.rows.map((r) => [r.rig_id, r]));

    // Connection pass-rate over the window.
    const conn = await query(`
        SELECT rig_id,
               count(*)                                   AS total,
               count(*) FILTER (WHERE result = 'PASS')    AS pass
        FROM connections
        WHERE ts > now() - $1::interval
        GROUP BY rig_id`, [win]);
    const connBy = new Map(conn.rows.map((r) => [r.rig_id, r]));

    const rigs = await query(`
        SELECT r.rig_id, r.name, r.field, r.status, r.health_score,
               d.gate, d.adoption_pct, d.commissioning
        FROM rigs r LEFT JOIN deployment_status d ON d.rig_id = r.rig_id
        ORDER BY r.rig_id`);

    const rows = rigs.rows.map((r) => {
        const t = telBy.get(r.rig_id);
        const e = evtBy.get(r.rig_id);
        const c = connBy.get(r.rig_id);
        const total = c ? Number(c.total) : 0;
        const pass = c ? Number(c.pass) : 0;
        return {
            rig_id: r.rig_id, name: r.name, field: r.field, status: r.status,
            gate: r.gate, adoption_pct: r.adoption_pct, commissioning: r.commissioning,
            // Window aggregates:
            avg_value: t && t.avg_value != null ? Number(t.avg_value) : null,
            sample_buckets: t ? Number(t.sample_buckets) : 0,
            distinct_metrics: t ? Number(t.distinct_metrics) : 0,
            alarm_events: e ? Number(e.alarm_events) : 0,
            activity_events: e ? Number(e.activity_events) : 0,
            connection_total: total,
            connection_pass: pass,
            connection_pass_rate: total ? Math.round((pass / total) * 100) : null,
        };
    });
    return { period: p, windowInterval: win, rows };
}

module.exports = {
    GATES, GATE_LABEL, getGovernance, updateDeployment, addEscalation,
    updateEscalation, addDecision, getWorkover, getFleetReport, getFleetReportPeriod,
};

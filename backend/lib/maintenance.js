'use strict';
// Maintenance & Reliability module (proposal §6.1, audit #7).
// Tracks PM / calibration / breakdown / inspection records per rig and rolls up
// PM-compliance, overdue and breakdown KPIs. The maintenance_record table is
// provided by the SCHEMA agent (see db/init.sql). MONITORING-ONLY: this is a
// manual-entry/record-keeping surface, never a write path back to a rig.
const { query } = require('./db');

const TYPES = ['PM', 'calibration', 'breakdown', 'inspection'];
const STATUSES = ['open', 'in_progress', 'done', 'overdue'];

// Column allow-list shared by create + patch (keeps untrusted bodies bounded).
const FIELDS = ['type', 'title', 'status', 'due_date', 'performed_at',
    'runtime_hours', 'outcome', 'notes'];

// GET /api/maintenance — optional ?rigId & ?status filters, newest activity first.
async function listMaintenance({ rigId, status } = {}) {
    const where = [], vals = [];
    if (rigId) { vals.push(rigId); where.push(`m.rig_id = $${vals.length}`); }
    if (status) { vals.push(status); where.push(`m.status = $${vals.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`
        SELECT m.*, r.name AS rig_name
        FROM maintenance_record m
        LEFT JOIN rigs r ON r.rig_id = m.rig_id
        ${clause}
        ORDER BY
          CASE m.status WHEN 'overdue' THEN 0 WHEN 'open' THEN 1
                        WHEN 'in_progress' THEN 2 ELSE 3 END,
          COALESCE(m.due_date, '9999-12-31') ASC,
          m.created_at DESC`, vals);
    return rows;
}

// GET /api/maintenance/summary — PM-compliance + overdue/open/breakdown KPIs.
async function maintenanceSummary() {
    // Overdue = past due_date and not done. Treat an explicit 'overdue' status
    // and a past-due open/in_progress record the same way.
    const { rows: agg } = await query(`
        SELECT
          count(*) FILTER (WHERE type = 'PM')                                       AS pm_total,
          count(*) FILTER (WHERE type = 'PM' AND status = 'done')                   AS pm_done,
          count(*) FILTER (WHERE type = 'breakdown')                               AS breakdown_count,
          count(*) FILTER (WHERE status IN ('open','in_progress'))                  AS open_count,
          count(*) FILTER (
            WHERE status = 'overdue'
               OR (status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date < now()::date)
          )                                                                         AS overdue
        FROM maintenance_record`);
    const a = agg[0] || {};
    const pmTotal = Number(a.pm_total) || 0;
    const pmDone = Number(a.pm_done) || 0;

    const { rows: byRig } = await query(`
        SELECT m.rig_id, r.name AS rig_name,
               count(*) FILTER (WHERE m.type = 'PM')                     AS pm_total,
               count(*) FILTER (WHERE m.type = 'PM' AND m.status = 'done') AS pm_done,
               count(*) FILTER (WHERE m.type = 'breakdown')              AS breakdown_count,
               count(*) FILTER (
                 WHERE m.status = 'overdue'
                    OR (m.status IN ('open','in_progress') AND m.due_date IS NOT NULL AND m.due_date < now()::date)
               )                                                          AS overdue
        FROM maintenance_record m
        LEFT JOIN rigs r ON r.rig_id = m.rig_id
        GROUP BY m.rig_id, r.name
        ORDER BY overdue DESC, breakdown_count DESC, m.rig_id`);

    return {
        pmCompliancePct: pmTotal ? Math.round((pmDone / pmTotal) * 100) : null,
        overdue: Number(a.overdue) || 0,
        openCount: Number(a.open_count) || 0,
        breakdownCount: Number(a.breakdown_count) || 0,
        // Map to the camelCase contract the frontend reads (rigId/name/pmCompliancePct/...).
        byRig: byRig.map((b) => {
            const t = Number(b.pm_total) || 0;
            return {
                rigId: b.rig_id,
                name: b.rig_name || b.rig_id,
                pmCompliancePct: t ? Math.round(((Number(b.pm_done) || 0) / t) * 100) : null,
                overdue: Number(b.overdue) || 0,
                breakdownCount: Number(b.breakdown_count) || 0,
            };
        }),
    };
}

function pickFields(body) {
    const out = {};
    for (const k of FIELDS) if (k in (body || {})) out[k] = body[k];
    return out;
}

// POST /api/maintenance (operator+). Validates type/status; rig must exist (FK).
async function addMaintenance(body, actor) {
    const b = body || {};
    if (!b.title || !String(b.title).trim()) {
        throw Object.assign(new Error('title is required'), { status: 400 });
    }
    if (!b.rigId && !b.rig_id) {
        throw Object.assign(new Error('rigId is required'), { status: 400 });
    }
    const rigId = b.rigId || b.rig_id;
    const type = TYPES.includes(b.type) ? b.type : 'inspection';
    const status = STATUSES.includes(b.status) ? b.status : 'open';
    const { rows } = await query(`
        INSERT INTO maintenance_record
          (rig_id, type, title, status, due_date, performed_at, runtime_hours, outcome, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
        [rigId, type, String(b.title).trim(), status,
         b.due_date || b.dueDate || null,
         b.performed_at || b.performedAt || null,
         b.runtime_hours ?? b.runtimeHours ?? null,
         b.outcome || null, b.notes || null]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'maintenance.add', rigId, { id: rows[0].id, type, title: rows[0].title }])
        .catch(() => {});
    return rows[0];
}

// PATCH /api/maintenance/:id (operator+). Updates an allow-listed subset.
async function updateMaintenance(id, body, actor) {
    const patch = pickFields(body);
    // Normalise camelCase aliases the frontend may send.
    if ('dueDate' in (body || {}) && !('due_date' in patch)) patch.due_date = body.dueDate;
    if ('performedAt' in (body || {}) && !('performed_at' in patch)) patch.performed_at = body.performedAt;
    if ('runtimeHours' in (body || {}) && !('runtime_hours' in patch)) patch.runtime_hours = body.runtimeHours;
    if ('type' in patch && !TYPES.includes(patch.type)) delete patch.type;
    if ('status' in patch && !STATUSES.includes(patch.status)) delete patch.status;

    const sets = [], vals = [id];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = $${vals.length + 1}`); vals.push(v); }
    if (!sets.length) throw Object.assign(new Error('no updatable fields'), { status: 400 });
    const { rows } = await query(
        `UPDATE maintenance_record SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!rows.length) throw Object.assign(new Error('maintenance record not found'), { status: 404 });
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'maintenance.update', String(id), patch]).catch(() => {});
    return rows[0];
}

module.exports = {
    TYPES, STATUSES, listMaintenance, maintenanceSummary, addMaintenance, updateMaintenance,
};

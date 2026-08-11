'use strict';
// Audit read surface (proposal §6.5, audit #2). Append-only immutability is
// enforced at the SQL level by the SCHEMA agent (BEFORE UPDATE/DELETE trigger +
// least-privilege crmf_app role). This module only READS the trail, admin-only,
// paginated, newest-first.
const { query } = require('./db');

const MAX_LIMIT = 200;

// GET /api/audit?limit&offset&action&actor — newest first, paginated.
async function listAudit({ limit, offset, action, actor } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
    const off = Math.max(Number(offset) || 0, 0);

    const where = [], vals = [];
    if (action) { vals.push(action); where.push(`action = $${vals.length}`); }
    if (actor) { vals.push(actor); where.push(`actor = $${vals.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await query(`SELECT count(*)::int AS c FROM audit_log ${clause}`, vals);
    const total = countRes.rows[0].c;

    vals.push(lim); const limIdx = vals.length;
    vals.push(off); const offIdx = vals.length;
    const { rows } = await query(
        `SELECT id, ts, actor, action, target, detail
         FROM audit_log ${clause}
         ORDER BY ts DESC, id DESC
         LIMIT $${limIdx} OFFSET $${offIdx}`, vals);

    return { total, limit: lim, offset: off, rows };
}

module.exports = { listAudit };

'use strict';
// Per-rig ACTIVITY timeline reconstruction (proposal §6.1 rig drill-down — mirrors
// the rig-edge ActivityPage). Rebuilds the day's activity timeline from the events
// stream (type='activity'): collapses consecutive same-phase rows into segments,
// aggregates duration per phase, and computes productive / NPT / other splits so the
// portal can render the same width-proportional colored activity bar as the edge.
//
// MONITORING-ONLY / READ-ONLY: this only reshapes events already received from a rig.
const { query } = require('./db');

// Phase classification (per the CRMF activity spec). A phase is PRODUCTIVE if it
// appears in PRODUCTIVE_PHASES, NPT if in NPT_PHASES; anything else is "other".
const PRODUCTIVE_PHASES = new Set(['RIH', 'POOH', 'CIRCULATE', 'MAKE_UP', 'BREAK_OUT', 'TRIP', 'DRILL', 'RUN', 'PULL']);
const NPT_PHASES = new Set(['WAIT', 'IDLE', 'REPAIR', 'STOP']);

const phaseKey = (phase) => String(phase || '').trim().toUpperCase();
const isProductive = (phase) => PRODUCTIVE_PHASES.has(phaseKey(phase));
const isNpt = (phase) => NPT_PHASES.has(phaseKey(phase));
// code: first 4 chars of the (upper) phase name, matching the edge convention.
const phaseCode = (phase) => phaseKey(phase).slice(0, 4);

function emptyResult() {
    return {
        current: { phase: null, code: null, job: null, sinceSec: 0 },
        segments: [],
        byPhase: [],
        totals: { productiveSec: 0, nptSec: 0, otherSec: 0, total: 0, prodPct: 0, nptPct: 0, otherPct: 0 },
    };
}

// Reconstruct the activity timeline for one rig over the trailing `hours` window.
async function getActivity(rigId, hours = 24) {
    const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 31);

    const { rows } = await query(
        `SELECT ts, payload->>'phase' AS phase
         FROM events
         WHERE rig_id = $1 AND type = 'activity' AND ts > now() - ($2 || ' hours')::interval
         ORDER BY ts ASC`,
        [rigId, String(h)]);

    // active_job for the `current` block (independent of whether events exist).
    let job = null;
    try {
        const jr = await query('SELECT active_job FROM rigs WHERE rig_id = $1', [rigId]);
        job = jr.rows.length ? (jr.rows[0].active_job || null) : null;
    } catch { /* leave job null */ }

    // Drop rows with no phase (defensive — payload may be malformed).
    const evs = rows.filter((r) => r.phase != null && String(r.phase).trim() !== '');
    if (!evs.length) {
        const out = emptyResult();
        out.current.job = job;
        return out;
    }

    const nowMs = Date.now();

    // Build SEGMENTS by collapsing consecutive same-phase rows. Each segment ends
    // where the NEXT row begins; the final segment runs to now().
    const segments = [];
    let cur = null;
    for (let idx = 0; idx < evs.length; idx++) {
        const phase = phaseKey(evs[idx].phase);
        const startMs = new Date(evs[idx].ts).getTime();
        if (cur && cur.phase === phase) {
            // same phase continues — extend (start unchanged, end set later)
            continue;
        }
        // close the previous segment at this row's start
        if (cur) cur.endMs = startMs;
        cur = { phase, code: phaseCode(phase), startMs, endMs: null };
        segments.push(cur);
    }
    // last open segment runs to now()
    if (cur && cur.endMs == null) cur.endMs = nowMs;

    // Finalise per-segment derived fields.
    for (const s of segments) {
        s.durationSec = Math.max(0, Math.round((s.endMs - s.startMs) / 1000));
        s.productive = isProductive(s.phase);
    }

    // Aggregate byPhase (sum durationSec per phase) + pct of total.
    const totalSec = segments.reduce((a, s) => a + s.durationSec, 0);
    const perPhase = new Map();
    for (const s of segments) perPhase.set(s.phase, (perPhase.get(s.phase) || 0) + s.durationSec);
    const byPhase = Array.from(perPhase.entries())
        .map(([phase, durationSec]) => ({
            phase,
            durationSec,
            pct: totalSec > 0 ? Math.round((durationSec / totalSec) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.durationSec - a.durationSec);

    // Totals: productive / npt / other seconds + pct.
    let productiveSec = 0; let nptSec = 0; let otherSec = 0;
    for (const s of segments) {
        if (isProductive(s.phase)) productiveSec += s.durationSec;
        else if (isNpt(s.phase)) nptSec += s.durationSec;
        else otherSec += s.durationSec;
    }
    const pct = (n) => (totalSec > 0 ? Math.round((n / totalSec) * 1000) / 10 : 0);

    // current = latest segment's phase; sinceSec = now - last segment start.
    const last = segments[segments.length - 1];
    const current = {
        phase: last.phase,
        code: last.code,
        job,
        sinceSec: Math.max(0, Math.round((nowMs - last.startMs) / 1000)),
    };

    return {
        current,
        segments,
        byPhase,
        totals: {
            productiveSec, nptSec, otherSec, total: totalSec,
            prodPct: pct(productiveSec), nptPct: pct(nptSec), otherPct: pct(otherSec),
        },
    };
}

module.exports = { getActivity, PRODUCTIVE_PHASES, NPT_PHASES };

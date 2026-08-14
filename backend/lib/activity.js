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
const PRODUCTIVE_PHASES = new Set(['RIH', 'POOH', 'CIRCULATE', 'MAKE_UP', 'BREAK_OUT', 'PWOC', 'TRIP', 'DRILL', 'RUN', 'PULL']);
const NPT_PHASES = new Set(['WAIT', 'IDLE', 'REPAIR', 'STOP']);

const phaseKey = (phase) => String(phase || '').trim().toUpperCase();
// The EDGE is authoritative: it ships `productive` (and an npt reason) with every
// activity event, computed from its own code table. Only fall back to the local
// phase lists when a row predates that (or came from another producer) — the
// lists do not know the edge's MILLING / CDR / WASH / PERFORATION / FISHING codes
// and disagree with it on IDLE, which the edge counts as productive.
const isProductive = (phase, declared) => (
    declared === true || declared === 'true' ? true
        : declared === false || declared === 'false' ? false
            : PRODUCTIVE_PHASES.has(phaseKey(phase)));
const isNpt = (phase, declared) => (
    declared === false || declared === 'false' ? true
        : declared === true || declared === 'true' ? false
            : NPT_PHASES.has(phaseKey(phase)));
// The activity CODE is the edge's own operation code — RIH, POOH, MAKE_UP,
// BREAK_OUT, CIRCULATE, MILLING, CDR, WASH, PERFORATION, FISHING, SWAB, ...
// It is NOT a 4-character abbreviation: truncating produced BREAK_OUT -> "BREA",
// CIRCULATE -> "CIRC", PERFORATION -> "PERF", which no consumer could match
// against the operation vocabulary the fleet view categorises by.
const phaseCode = (phase) => phaseKey(phase);

function emptyResult() {
    return {
        current: { phase: null, code: null, job: null, sinceSec: 0 },
        segments: [],
        byPhase: [],
        totals: { productiveSec: 0, nptSec: 0, otherSec: 0, total: 0, prodPct: 0, nptPct: 0, otherPct: 0 },
    };
}

// Reconstruct the activity timeline for one rig over the trailing `hours`
// window, or over an ABSOLUTE [fromMs, toMs] range when both are given (used by
// the well-history module to replay a completed run's operations log).
async function getActivity(rigId, hours = 24, fromMs = null, toMs = null) {
    const h = Math.min(Math.max(Number(hours) || 24, 1), 24 * 31);
    const ranged = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;

    // The edge emits { activity, label, productive, npt, source, since } — there is
    // NO 'phase' key. Reading payload->>'phase' filtered out EVERY row, so this
    // returned an empty timeline for every rig. Accept the edge's own keys (and
    // keep 'phase' for any legacy/synthesised producer), and carry the edge's
    // productive/npt booleans through rather than re-deriving them from a
    // hardcoded phase list that does not know MILLING/CDR/WASH/PERFORATION.
    const { rows } = await query(
        ranged
            ? `SELECT ts,
                      COALESCE(payload->>'activity', payload->>'phase')       AS phase,
                      payload->>'label'                                       AS label,
                      payload->>'productive'                                  AS productive,
                      payload->'npt'->>'reason'                               AS npt_reason
               FROM events
               WHERE rig_id = $1 AND type = 'activity'
                 AND ts >= to_timestamp($2::double precision / 1000.0)
                 AND ts <= to_timestamp($3::double precision / 1000.0)
               ORDER BY ts ASC`
            : `SELECT ts,
                      COALESCE(payload->>'activity', payload->>'phase')       AS phase,
                      payload->>'label'                                       AS label,
                      payload->>'productive'                                  AS productive,
                      payload->'npt'->>'reason'                               AS npt_reason
               FROM events
               WHERE rig_id = $1 AND type = 'activity' AND ts > now() - ($2 || ' hours')::interval
               ORDER BY ts ASC`,
        ranged ? [rigId, fromMs, toMs] : [rigId, String(h)]);

    // active_job for the `current` block (independent of whether events exist).
    // In RANGED (historical) mode the rig's live job is unrelated to the window
    // being replayed — leave it null so a completed run never reports today's job.
    let job = null;
    if (!ranged) {
        try {
            const jr = await query('SELECT active_job FROM rigs WHERE rig_id = $1', [rigId]);
            job = jr.rows.length ? (jr.rows[0].active_job || null) : null;
        } catch { /* leave job null */ }
    }

    // Drop rows with no phase (defensive — payload may be malformed).
    const evs = rows.filter((r) => r.phase != null && String(r.phase).trim() !== '');
    if (!evs.length) {
        const out = emptyResult();
        out.current.job = job;
        return out;
    }

    const nowMs = ranged ? toMs : Date.now();

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
        cur = {
            phase, code: phaseCode(phase), startMs, endMs: null,
            // Carry the edge's own label + declared classification onto the segment.
            label: evs[idx].label || phase,
            declared: evs[idx].productive,
            nptReason: evs[idx].npt_reason || null,
        };
        segments.push(cur);
    }
    // last open segment runs to now()
    if (cur && cur.endMs == null) cur.endMs = nowMs;

    // Finalise per-segment derived fields.
    for (const s of segments) {
        s.durationSec = Math.max(0, Math.round((s.endMs - s.startMs) / 1000));
        s.productive = isProductive(s.phase, s.declared);
        s.npt = isNpt(s.phase, s.declared);
    }

    // Aggregate byPhase (sum durationSec per phase) + pct of total.
    const totalSec = segments.reduce((a, s) => a + s.durationSec, 0);
    const perPhase = new Map();
    const phaseLabel = new Map();
    for (const s of segments) {
        perPhase.set(s.phase, (perPhase.get(s.phase) || 0) + s.durationSec);
        if (!phaseLabel.has(s.phase)) phaseLabel.set(s.phase, s.label || s.phase);
    }
    const byPhase = Array.from(perPhase.entries())
        .map(([phase, durationSec]) => ({
            phase,
            label: phaseLabel.get(phase) || phase,
            durationSec,
            pct: totalSec > 0 ? Math.round((durationSec / totalSec) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.durationSec - a.durationSec);

    // Totals: productive / npt / other seconds + pct.
    let productiveSec = 0; let nptSec = 0; let otherSec = 0;
    for (const s of segments) {
        if (s.productive) productiveSec += s.durationSec;
        else if (s.npt) nptSec += s.durationSec;
        else otherSec += s.durationSec;
    }
    const pct = (n) => (totalSec > 0 ? Math.round((n / totalSec) * 1000) / 10 : 0);

    // current = latest segment's phase; sinceSec = now - last segment start.
    const last = segments[segments.length - 1];
    const current = {
        phase: last.phase,
        code: last.code,
        label: last.label || last.phase,
        productive: last.productive,
        npt: last.npt,
        nptReason: last.nptReason,
        job,
        sinceSec: Math.max(0, Math.round((nowMs - last.startMs) / 1000)),
    };

    return {
        current,
        segments: segments.map((sg) => ({
            phase: sg.phase, code: sg.code, label: sg.label,
            start: new Date(sg.startMs).toISOString(),
            end: new Date(sg.endMs).toISOString(),
            durationSec: sg.durationSec, productive: sg.productive, npt: sg.npt,
            nptReason: sg.nptReason,
        })),
        byPhase,
        totals: {
            productiveSec, nptSec, otherSec, total: totalSec,
            prodPct: pct(productiveSec), nptPct: pct(nptSec), otherPct: pct(otherSec),
        },
    };
}

module.exports = { getActivity, PRODUCTIVE_PHASES, NPT_PHASES };

'use strict';
// =====================================================================
// CRMF Fleet Simulator — DEMO ONLY
// Emulates N rig-edge sync agents streaming store-and-forward batches to the
// CRMF /ingest endpoint, in the EXACT contract produced by the real edge agent
// (repo backend/lib/sync.js): gzipped JSON, X-Device-Id header, optional bearer.
//
// Stands in for 50 physical rigs so the fleet portal is live end-to-end. Some
// rigs are healthy, one is intentionally degraded (missing tags), and one is
// flaky (drops offline and recovers) so the data-quality monitor and alarm
// command centre have something real to show.
// =====================================================================
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://crmf-backend:6000';
const TOKEN = process.env.INGEST_TOKEN || '';
const ACTIVE = Number(process.env.ACTIVE_RIGS || 14);
// Optional per-rig credentials, mirroring a real provisioned fleet where each of
// the 50 rigs holds its own device token. JSON map { "AHWR-50-3": "<token>" },
// as emitted by backend/scripts/provision-rigs.js --json. Falls back to the
// shared INGEST_TOKEN per rig when absent.
const RIG_TOKENS = (() => {
    const f = process.env.RIG_TOKENS_FILE;
    if (!f) return {};
    try {
        const map = JSON.parse(require('fs').readFileSync(f, 'utf8'));
        console.log(`fleet-sim: loaded per-rig tokens for ${Object.keys(map).length} rig(s) from ${f}`);
        return map;
    } catch (e) {
        console.warn(`fleet-sim: could not read RIG_TOKENS_FILE ${f}: ${e.message} — using the shared token`);
        return {};
    }
})();
const BATCH_SECONDS = Number(process.env.BATCH_SECONDS || 10);
// Seconds between PERSISTED samples (see the tick loop). 1 = full 1 Hz.
const SAMPLE_EVERY_S = Math.max(1, Number(process.env.SAMPLE_EVERY_S || 5));
// How often each rig ships a CMMS/maintenance snapshot (real edge: ~60 s).
const CMMS_SNAPSHOT_SECONDS = Math.max(BATCH_SECONDS, Number(process.env.CMMS_SNAPSHOT_SECONDS || 60));

const osc = (t, base, amp, period, phase = 0) => base + amp * Math.sin((2 * Math.PI * (t + phase)) / period);
const noise = (a) => (Math.random() - 0.5) * a;
const r = (v, d = 1) => Number(Number(v).toFixed(d));

// Scripted workover cycle (mirrors the edge mock) so activity / torque-turn / alarms are demonstrable.
const PHASES = [['RIH', 20], ['MAKE_UP', 8], ['CIRCULATE', 15], ['POOH', 20], ['BREAK_OUT', 8]];
const CYCLE_LEN = PHASES.reduce((s, p) => s + p[1], 0);
function phaseAt(tt) {
    const cycleIndex = Math.floor(tt / CYCLE_LEN);
    let x = tt % CYCLE_LEN;
    for (const [name, dur] of PHASES) { if (x < dur) return { phase: name, elapsed: x, dur, cycleIndex }; x -= dur; }
    return { phase: 'RIH', elapsed: 0, dur: 20, cycleIndex };
}

// Monotonic seq base so a sim RESTART never replays seqs the backend already saw
// (the central rejects seq <= last_seq for replay idempotency). Epoch seconds only
// ever grow, mirroring the real edge agent persisting its seq across restarts.
const SEQ_BASE = Math.floor(Date.now() / 1000);

// Each rig ROTATES its job through a small set of 3 wells every ~150 s, so
// well_runs transitions accumulate PAST runs with real telemetry for offline EDR
// replay. The base job + two siblings keep the names realistic ("GS-{block}#{n}").
const JOB_ROTATE_SECONDS = Number(process.env.JOB_ROTATE_SECONDS || 150);
function wellSetFor(n) {
    const block = 10 + n;
    const base = 3 + (n % 5);                 // historical base job number
    // Base job and two siblings on the same block (stable, distinct names).
    return [`GS-${block}#${base}`, `GS-${block}#${base + 5}`, `GS-${block}#${base + 9}`];
}
// Current job for rig n at sim-time t: stable within each JOB_ROTATE_SECONDS window.
function jobAt(rig, t) {
    const idx = Math.floor(t / JOB_ROTATE_SECONDS) % rig.wells.length;
    return rig.wells[idx];
}

// Per-rig runtime state.
// Rig ids that a REAL rig-edge twin is already streaming. The simulator must
// never publish as one of them: central authorises per rig_id, so two senders
// under one id both succeed and interleave their data. In practice the edge
// counts seq from 1 while the sim derives it from the clock, so each side keeps
// tripping central's sequence-reset detection and re-baselining the other —
// observed at ~6 resets/minute, with both senders' rows landing under one rig.
// Comma-separated; empty (the default) preserves the previous behaviour.
const EXCLUDED = new Set(
    String(process.env.SIM_EXCLUDE_RIGS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
);

const rigs = [];
for (let n = 1; n <= ACTIVE; n++) {
    const rigId = `AHWR-50-${n}`;
    if (EXCLUDED.has(rigId)) continue;
    const wells = wellSetFor(n);
    rigs.push({
        id: rigId,
        n,                                   // rig index (deterministic CMMS spread)
        offset: (n * 7) % CYCLE_LEN,         // desync the cycles
        seq: 1,
        batch: { channels: [], events: [] },
        blockPos: 40 + (n % 10),
        lastMakeupPeak: 12000,
        alarmActive: false,
        degraded: n % 7 === 0,               // missing-tag rig -> lower completeness score
        flaky: n === ACTIVE,                 // last rig drops offline periodically
        wells,                               // 3-well rotation set for this rig
        well: wells[0],                      // current well (updated each tick by jobAt)
        sealCountdown: (n * 3) % BATCH_SECONDS,
    });
}

function snapshot(rig, t) {
    const tt = t + rig.offset;
    const wf = phaseAt(tt);
    if (wf.phase === 'RIH') rig.blockPos = Math.max(3, rig.blockPos - 2);
    else if (wf.phase === 'POOH') rig.blockPos = Math.min(88, rig.blockPos + 2);
    const pumping = wf.phase === 'CIRCULATE';

    let makeupTorque = r(500 + noise(50));
    if (wf.phase === 'MAKE_UP') {
        const peak = (wf.cycleIndex % 4 === 3) ? 19500 : (11500 + (wf.cycleIndex % 3) * 1400);
        makeupTorque = r(2000 + (wf.elapsed / wf.dur) * (peak - 2000) + noise(150));
        rig.lastMakeupPeak = peak;
    }
    const tubing = (pumping && wf.cycleIndex % 3 === 1) ? r(222 + noise(4)) : r(118 + noise(4));
    const tankGL = (wf.phase === 'RIH' && wf.cycleIndex % 4 === 2 && wf.elapsed > 5) ? r(2.2 + noise(0.2), 2) : r(noise(0.5), 2);
    const esd = (tt % 90 >= 40 && tt % 90 < 47) ? 1 : 0;
    const lockout = (tt % 120 >= 80 && tt % 120 < 86) ? 1 : 0;

    const v = {
        'drawworks.hook_load': r(osc(t, 95, 18, 60) + noise(2)),
        'drawworks.block_position': r(rig.blockPos),
        'drawworks.rope_wear': r(osc(t, 2.5, 0.3, 300), 2),
        'drilling.wob': r(Math.max(0, osc(t, 14, 9, 75) + noise(1))),
        'drilling.rop': r(Math.max(0, osc(t, 18, 8, 90) + noise(2))),
        'drilling.rpm': r(osc(t, 95, 25, 50)),
        'drilling.torque': r(osc(t, 9000, 3000, 70)),
        'drilling.bit_depth': r(1480 + osc(t, 0, 6, 200)),
        'drilling.hole_depth': r(1500 + (t / 600)),
        'htd.rpm': r(osc(t, 85, 30, 50)),
        'htd.torque': r(osc(t, 8000, 3000, 70)),
        'pct.makeup_torque': makeupTorque,
        'pct.last_makeup_torque': r(rig.lastMakeupPeak + noise(100)),
        'hpu.aux_pressure': r(osc(t, 150, 15, 80)),
        'hpu.discharge_pressure': r(osc(t, 180, 20, 75)),
        'hpu.oil_temp': r(osc(t, 50, 6, 250) + (rig.degraded ? 0 : 0)),
        'hpu.oil_level': r(osc(t, 82, 4, 400)),
        'hpu.pilot_pressure': r(osc(t, 25, 3, 90)),
        'wellhead.tubing_pressure': tubing,
        'wellhead.casing_pressure': r(88 + noise(4)),
        'wellhead.wellhead_pressure': r(108 + noise(4)),
        'mudpump.spm': pumping ? r(osc(t, 95, 12, 40)) : r(6 + noise(1)),
        'mudpump.flow_in': pumping ? r(osc(t, 2000, 150, 55)) : r(40 + noise(10)),
        'mudpump.pressure': pumping ? r(osc(t, 195, 30, 65)) : r(15 + noise(3)),
        'fluid.tank_gain_loss': tankGL,
        'fluid.total_tank_volume': r(osc(t, 220, 8, 400)),
        'fluid.trip_tank': r(osc(t, 18, 2, 200)),
        // The edge attaches this honesty flag alongside the BOP group: 1 = the rig
        // really has BOP data mapped. Simulated rigs report 1; a rig with no BOP
        // field map sends 0 and central must not read the pressures as "safe".
        'well_control.available': 1,
        'well_control.accumulator_pressure': r(osc(t, 2950, 80, 300)),
        'well_control.annular_pressure': r(osc(t, 1400, 120, 120)),
        'well_control.manifold_pressure': r(osc(t, 1200, 100, 110)),
        'safety.esd_active': esd,
        'safety.lockout_active': lockout,
        'cat_engine.rpm': r(osc(t, 1200, 120, 45)),
        'cat_engine.load': r(osc(t, 62, 18, 60)),
        'cat_engine.coolant_temp': r(osc(t, 85, 4, 200)),
        'cat_engine.oil_pressure': r(osc(t, 45, 4, 90)),
        'cat_engine.fuel_rate': r(osc(t, 110, 20, 70)),
        'cat_engine.fuel_temp': r(osc(t, 40, 3, 300)),
        'cat_engine.battery_voltage': r(osc(t, 26, 1, 120), 2),

        // --- Richer equipment status (mirrors the edge rig_data shape) so the
        //     central per-rig HMI panels show full equipment state. Enums per the
        //     edge field map. Booleans are emitted as 0/1 (telemetry is numeric). ---
        'drilling.operation_mode': ({ RIH: 2, POOH: 3, CIRCULATE: 1, MAKE_UP: 0, BREAK_OUT: 0 }[wf.phase]) ?? 1,
        'drilling.delta_torque': r(osc(t, 500, 200, 40)),
        'htd.status': (pumping || wf.phase === 'RIH' || wf.phase === 'POOH') ? 2 : 1,
        'htd.torque_command': r(osc(t, 8000, 3000, 70) + 200),
        'htd.work_mode': 1, 'htd.rotation_status': 1, 'htd.gear_status': 2,
        'htd.ibop_status': 3, 'htd.elevator_status': 3, 'htd.brake_status': 4, 'htd.tilt_status': 2,
        'htd.vertical_speed': r(osc(t, 0, 0.3, 30), 2),
        'pct.status': 2, 'pct.op_mode': 1,
        'pct.sequence': wf.phase === 'MAKE_UP' ? 1 : wf.phase === 'BREAK_OUT' ? 2 : 0,
        'pct.spinner_floating': 1, 'pct.spinner_makeup_torque': r(makeupTorque * 0.9),
        'pct.rotation_makeup_pressure': r(osc(t, 280, 20, 70)),
        'pct.clamp_up_pressure': r(osc(t, 190, 20, 70)), 'pct.clamp_up_status': 4,
        'pct.clamp_low_status': 4, 'pct.dolly_status': 6,
        'hpu.status': 2,
        'hpu.pdw_pump_status': 1, 'hpu.pdw_pump_flow': r(osc(t, 70, 15, 60)), 'hpu.pdw_pump_press': r(osc(t, 210, 15, 70)),
        'hpu.htd_pump1_status': 2, 'hpu.htd_pump1_flow': r(osc(t, 55, 12, 60)), 'hpu.htd_pump1_press': r(osc(t, 200, 15, 70)),
        'hpu.htd_pump2_status': 1, 'hpu.htd_pump2_flow': r(osc(t, 45, 12, 62)), 'hpu.htd_pump2_press': r(osc(t, 185, 15, 72)),
        'hpu.oil_filter_1': 0, 'hpu.oil_filter_2': 1, 'hpu.oil_filter_3': 0,
        'cat_engine.status': 2, 'cat_engine.fuel_pressure': r(osc(t, 12.5, 1, 90), 1),
        'cat_engine.run_hours': r(4200 + t / 3600, 1), 'cat_engine.total_hours': r(23400 + t / 3600, 1),
        'cat_engine.source_cmd': 2,
        'cwk.status': 1, 'cwk.clamp_status': 4, 'cwk.clamp_pressure': r(osc(t, 85, 10, 70)), 'cwk.clamp_force': r(osc(t, 500, 40, 70)),
        'acs.status': 1, 'acs.crownsaver': r(osc(t, 2200, 200, 60)), 'acs.floorsaver': r(osc(t, 1800, 150, 60)),
        'acs.bottomsaver': r(osc(t, 1500, 120, 60)), 'acs.upper_tag': 2400, 'acs.lower_tag': 200,
        'well_control.annular_open': 0, 'well_control.annular_close': 1,
        'well_control.pipe_ram_open': 0, 'well_control.pipe_ram_close': 1,
        'well_control.blind_ram_open': 0, 'well_control.blind_ram_close': 1, 'well_control.shear_ram_open': 0,
    };

    // Degraded rig: drop many EXPECTED tags so its completeness (and health score)
    // falls into the "degraded" band — exercises the data-quality monitor.
    if (rig.degraded) {
        for (const k of ['mudpump.flow_in', 'mudpump.pressure', 'mudpump.spm', 'wellhead.casing_pressure',
            'wellhead.wellhead_pressure', 'drilling.bit_depth', 'drilling.wob', 'drilling.rop', 'htd.torque',
            'hpu.oil_level', 'hpu.aux_pressure', 'well_control.annular_pressure', 'cat_engine.coolant_temp',
            'cat_engine.oil_pressure', 'fluid.total_tank_volume']) delete v[k];
    }

    // ----- Events -----
    const events = [];
    // Activity each tick boundary (cheap; one per batch is enough — emit on seal instead).
    rig._wf = wf;

    // Connection record at the end of MAKE_UP.
    if (wf.phase === 'MAKE_UP' && wf.elapsed === wf.dur - 1) {
        const fail = wf.cycleIndex % 4 === 3;
        events.push({ type: 'connection', payload: {
            peakTorque: rig.lastMakeupPeak, result: fail ? 'FAIL' : 'PASS',
            joint: wf.cycleIndex + 1, limit: 18000,
        } });
    }

    // Unified current alarm snapshot (mirrors the edge's alarms.evaluate output: the
    // latest alarm event always carries the FULL current counts, so conditions clear
    // correctly). ESD/lockout are read-only P1 indications — never actuated.
    const p1 = (esd || lockout) ? 1 : 0;
    const p2 = tubing > 200 ? 1 : 0;
    const active = p1 + p2;
    const highest = p1 ? 'P1' : (p2 ? 'P2' : null);
    const sig = `${active}|${p1}|${p2}`;
    if (sig !== rig.lastAlarmSig) {
        rig.lastAlarmSig = sig;
        events.push({ type: 'alarm', payload: { active, unack: active, p1, p2, p3: 0, highest } });
    }

    return { v, events };
}

function post(rig, batch) {
    const json = Buffer.from(JSON.stringify(batch));
    const body = zlib.gzipSync(json);
    let u; try { u = new URL('/ingest', CENTRAL_URL); } catch { return; }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
        'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
        'X-Device-Id': rig.id, 'X-Schema-Version': '1.0', 'Content-Length': body.length,
    };
    // A provisioned rig authenticates with ITS OWN token; the shared INGEST_TOKEN
    // is only the fallback for rigs not yet provisioned (see ingest.authorize()).
    const rigToken = RIG_TOKENS[rig.id] || TOKEN;
    if (rigToken) headers.Authorization = `Bearer ${rigToken}`;
    const req = lib.request(u, { method: 'POST', headers, timeout: 8000 }, (res) => {
        res.resume();
        if (res.statusCode >= 300) console.warn(`${rig.id}: ingest HTTP ${res.statusCode}`);
    });
    req.on('error', (e) => console.warn(`${rig.id}: post error ${e.message}`));
    req.on('timeout', () => req.destroy());
    req.end(body);
}

let t = 0;
function tick() {
    t += 1;
    for (const rig of rigs) {
        // Flaky rig: 40s offline every ~3 min so it flips offline then recovers.
        if (rig.flaky && (t % 180) >= 140) { rig.sealCountdown = 0; rig.batch = { channels: [], events: [] }; continue; }

        // Rotate the rig's current job (stable within each JOB_ROTATE_SECONDS window)
        // so well_runs transitions accumulate PAST runs for offline EDR replay.
        rig.well = jobAt(rig, t);

        const { v, events } = snapshot(rig, t);
        // DEV DENSITY: the sim models 1 Hz sampling, but persisting every sample
        // for a 50-rig fleet writes ~28 GB/day — far more than is needed to see
        // the features work, and it filled the dev box. Keep only every Nth
        // sample (SAMPLE_EVERY_S, default 5 s) so trends, EDR, aggregates and the
        // fleet view all still render from real movement at ~1/5 the volume.
        // Set SAMPLE_EVERY_S=1 for full-rate collection (production behaviour).
        if (t % SAMPLE_EVERY_S === 0) {
            rig.batch.channels.push({ ts: new Date().toISOString(), values: v });
        }
        for (const e of events) rig.batch.events.push({ ts: new Date().toISOString(), ...e });

        rig.sealCountdown -= 1;
        if (rig.sealCountdown <= 0) {
            // Activity event once per batch.
            if (rig._wf) rig.batch.events.push({ ts: new Date().toISOString(), type: 'activity', payload: { phase: rig._wf.phase, job: rig.well } });
            // CMMS snapshot once a minute per rig (same cadence as the real edge),
            // staggered by rig index so 50 rigs don't all ship one on the same tick.
            if ((t + rig.n * 3) % CMMS_SNAPSHOT_SECONDS < BATCH_SECONDS) {
                rig.batch.events.push({ ts: new Date().toISOString(), type: 'cmms.snapshot', payload: buildCmmsSnapshot(rig, t) });
            }
            const batch = {
                seq: SEQ_BASE + (rig.seq++), deviceId: rig.id, schemaVersion: '1.0',
                createdAt: new Date().toISOString(),
                channels: rig.batch.channels, events: rig.batch.events,
            };
            post(rig, batch);
            rig.batch = { channels: [], events: [] };
            rig.sealCountdown = BATCH_SECONDS;
        }
    }
}

console.log(`CRMF fleet-sim: streaming ${rigs.length} rigs -> ${CENTRAL_URL}/ingest every ${BATCH_SECONDS}s (sampling every ${SAMPLE_EVERY_S}s)`);
if (EXCLUDED.size) {
    console.log(`fleet-sim: NOT simulating ${[...EXCLUDED].join(', ')} (real edge attached)`);
}
setInterval(tick, 1000);

// ---------------------------------------------------------------------------
// CMMS snapshot (maintenance) — the real rig edge ships this once a minute via
// sync.enqueueEvent('cmms.snapshot', ...). Without it the central rig
// drill-down's Maintenance tab shows "No maintenance snapshot received" for
// every SIMULATED rig, so the whole CMMS feature was only visible on the one
// real edge. Shape mirrors edge backend/server.js buildCmmsSnapshot() exactly:
// { rigName, assets, counts, pm, downtime, workOrders, logbook, instruments,
//   runHours, cmmsSummary, instrumentSummary, generatedAt }.
// Values are DERIVED from each rig's own index/telemetry so they are stable
// per rig and differ across the fleet (not one cloned payload).
// ---------------------------------------------------------------------------
const CMMS_ASSETS = [
    { id: 'engine', name: 'CAT Engine', category: 'Power', base: 4200, interval: 250 },
    { id: 'hpu', name: 'Hydraulic Power Unit', category: 'Hydraulics', base: 3360, interval: 500 },
    { id: 'htd', name: 'Top Drive (HTD)', category: 'Rotary', base: 2520, interval: 500 },
    { id: 'drawworks', name: 'Drawworks', category: 'Hoisting', base: 3855, interval: 250 },
    { id: 'mudpump', name: 'Mud Pump', category: 'Circulating', base: 3622, interval: 250 },
];
const WO_TITLES = ['Engine oil & filter change', 'HPU filter replacement', 'Top drive gearbox inspection',
    'Drawworks brake adjustment', 'Mud pump liner change', 'Rope slip & cut'];
const LOG_OPS = ['RIH to 1500 m', 'POOH for bit change', 'Circulating bottoms up', 'Make-up connection',
    'Rigging up power tong', 'Fishing job in progress'];
const LOG_MAINT = ['Greased crown block', 'Replaced HPU return filter', 'Checked engine coolant level',
    'Torqued top drive bolts', 'Calibrated SPP transducer'];
const INSTR = [
    { id: 'spp', name: 'Standpipe Pressure Transducer', type: 'Pressure', interval: 180 },
    { id: 'hookload', name: 'Hookload Load Cell', type: 'Load', interval: 365 },
    { id: 'h2s', name: 'H2S Detector (rig floor)', type: 'Gas', interval: 90 },
];
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

function buildCmmsSnapshot(rig, t) {
    const n = rig.n;                                 // per-rig deterministic spread
    const runH = (t / 3600);                         // sim uptime contribution
    const assets = CMMS_ASSETS.map((a, i) => {
        const hours = Math.round((a.base + n * 37 + i * 11 + runH) * 10) / 10;
        const sinceService = (hours % a.interval);
        const dueIn = Math.round(a.interval - sinceService);
        const status = dueIn < 0 ? 'overdue' : dueIn < 40 ? 'due-soon' : 'ok';
        // Field names MUST match the real edge's maintenance.getSummary() asset
        // shape (verified against a live AHWR-50-3 snapshot), or the central
        // panel renders blanks: nextDueInHours (not nextDueInH), pmStatus with a
        // HYPHEN ('due-soon'), source (not hoursSource), and health[] as a
        // {label,value} array (not a readings object).
        const readings = a.id === 'engine'
            ? [{ label: 'Coolant °C', value: 78 + (n % 12) }, { label: 'Oil bar', value: 40 + (n % 9) }]
            : a.id === 'hpu' ? [{ label: 'Oil Temp °C', value: 42 + (n % 10) }, { label: 'Disch bar', value: 180 + (n % 20) }]
            : a.id === 'htd' ? [{ label: 'RPM', value: 60 + (n % 50) }, { label: 'Torque', value: 600 + (n % 400) }]
            : a.id === 'drawworks' ? [{ label: 'Hook Load t', value: 70 + (n % 30) }, { label: 'Rope wear', value: r(2 + (n % 3) / 10, 2) }]
            : [{ label: 'SPP bar', value: 14 + (n % 8) }, { label: 'SPM', value: 5 + (n % 4) }];
        return {
            id: a.id, name: a.name, category: a.category, hours,
            source: a.id === 'drawworks' || a.id === 'mudpump' ? 'derived' : 'measured',
            nextDueInHours: dueIn, pmStatus: status, status, pmTasks: 1 + (i % 2),
            openDowntime: a.id === CMMS_ASSETS[n % CMMS_ASSETS.length].id && n % 4 === 0 ? 1 : 0,
            health: readings,
        };
    });
    const overdue = assets.filter((a) => a.pmStatus === 'overdue').length;
    const dueSoon = assets.filter((a) => a.pmStatus === 'due-soon').length;
    const openWOs = 1 + (n % 3);
    const workOrders = Array.from({ length: openWOs }, (_, i) => ({
        woNo: `WO-${2000 + n * 10 + i}`,
        type: i % 2 === 0 ? 'PREVENTIVE' : 'BREAKDOWN',
        assetId: CMMS_ASSETS[(n + i) % CMMS_ASSETS.length].id,
        asset: CMMS_ASSETS[(n + i) % CMMS_ASSETS.length].name,
        title: WO_TITLES[(n + i) % WO_TITLES.length],
        priority: `P${1 + ((n + i) % 3)}`,
        status: i === 0 ? 'OPEN' : 'IN_PROGRESS',
        raisedAt: isoDaysAgo((i + 1) * 2),
        assignedTo: ['R. Sharma', 'V. Patel', 'A. Kumar'][(n + i) % 3],
        // Maintenance log references a NOTIFICATION number (SAP-style), not a WO.
        notificationNo: `NOTIF-${100000 + n * 100 + i}`,
    }));
    const logbook = [
        ...LOG_OPS.slice(0, 3).map((text, i) => ({
            id: `op-${n}-${i}`, logType: 'OPERATIONS', category: 'Operations',
            text, at: isoDaysAgo(i * 0.25), by: 'driller', shift: i % 2 ? 'NIGHT' : 'DAY',
        })),
        ...LOG_MAINT.slice(0, 2).map((text, i) => ({
            id: `mt-${n}-${i}`, logType: 'MAINTENANCE', category: 'Maintenance',
            text, at: isoDaysAgo(i * 0.5 + 0.2), by: 'mechanic', shift: 'DAY',
            notificationNo: `NOTIF-${100000 + n * 100 + i}`,
        })),
    ];
    const downtime = [{
        id: `dt-${n}`, assetId: CMMS_ASSETS[n % CMMS_ASSETS.length].id,
        asset: CMMS_ASSETS[n % CMMS_ASSETS.length].name,
        reasonCode: ['Equipment Failure', 'Waiting on Parts', 'Weather'][n % 3],
        start: isoDaysAgo(0.4), end: n % 4 === 0 ? null : isoDaysAgo(0.2),
        durationMin: n % 4 === 0 ? null : 288, notes: 'Sim-generated downtime record',
        by: 'toolpusher',
    }];
    const instrumentRows = INSTR.map((ins, i) => {
        const lastCalDays = 30 + ((n + i * 40) % 200);
        const dueInDays = ins.interval - lastCalDays;
        return {
            id: `${ins.id}-${n}`, name: ins.name, type: ins.type,
            serial: `SN-${1000 + n * 7 + i}`, intervalDays: ins.interval,
            lastCalDate: isoDaysAgo(lastCalDays), dueInDays,
            calStatus: dueInDays < 0 ? 'OVERDUE' : dueInDays < 30 ? 'DUE_SOON' : 'VALID',
        };
    });
    // Per-day run hours for the last 7 days, per asset (feeds the Run Hours tab).
    const runHours = Array.from({ length: 7 }, (_, d) => ({
        date: isoDaysAgo(d).slice(0, 10),
        assets: CMMS_ASSETS.reduce((acc, a, i) => {
            acc[a.id] = Math.round((6 + ((n + d + i) % 14)) * 10) / 10;
            return acc;
        }, {}),
    }));
    return {
        rigName: rig.id,
        assets, counts: { overdue, dueSoon, ok: assets.length - overdue - dueSoon },
        pm: assets.map((a) => ({
            assetId: a.id, asset: a.name, task: `${a.name} scheduled service`,
            intervalH: CMMS_ASSETS.find((x) => x.id === a.id).interval,
            nextDueInHours: a.nextDueInHours, status: a.pmStatus, pmStatus: a.pmStatus,
        })),
        downtime, workOrders, logbook, instruments: instrumentRows, runHours,
        cmmsSummary: {
            workOrders: { open: openWOs, breakdownOpen: openWOs > 1 ? 1 : 0, preventiveOpen: 1, p1Open: n % 5 === 0 ? 1 : 0 },
            overhauls: { active: n % 6 === 0 ? 1 : 0, planned: 1 },
            logbook: { today: 5, operationsToday: 3, maintenanceToday: 2 },
        },
        instrumentSummary: {
            total: instrumentRows.length,
            overdue: instrumentRows.filter((i) => i.calStatus === 'OVERDUE').length,
            dueSoon: instrumentRows.filter((i) => i.calStatus === 'DUE_SOON').length,
            valid: instrumentRows.filter((i) => i.calStatus === 'VALID').length,
        },
        generatedAt: new Date().toISOString(),
    };
}

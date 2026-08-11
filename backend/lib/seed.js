'use strict';
// Idempotent seed for a demonstrable fleet: a 50-rig registry distributed across
// ONGC's pan-India Asset units at varied rollout stages (proposal Â§6.2 rig master,
// Â§8 stage-gate plan), the standard tag dictionary, default portal users, and Â§7
// value-realization KPIs.
const { query } = require('./db');
const { hash } = require('./auth');
const { TAGS } = require('./tags');

const FLEET_SIZE = Number(process.env.FLEET_SIZE || 2);
const SEEDED_RIG_NUMBERS = String(process.env.SEED_RIG_NUMBERS || '3,6')
    .split(',')
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
const SEEDED_RIG_SET = new Set(SEEDED_RIG_NUMBERS);
// Rigs the fleet-sim streams live (must match fleet-sim/sim.js ACTIVE_RIGS). Each
// gets a current well seeded under its sim job name so the Wells list shows the
// live, rig-attached wells from the very first boot.
const ACTIVE_RIGS = Number(process.env.ACTIVE_RIGS || 14);

// Pan-ONGC Asset units (real ONGC assets, representative lat/lon). The India map
// and these seed coordinates must agree so rig dots land in the right region.
// [name, field, lat, lon]
const ASSET_UNITS = [
    ['Mumbai High',          'Mumbai High',        19.45, 71.30],
    ['Bassein & Satellite',  'Bassein',            19.60, 71.95],
    ['Mehsana',              'Mehsana',            23.60, 72.40],
    ['Ahmedabad',            'Ahmedabad',          23.03, 72.58],
    ['Ankleshwar',           'Ankleshwar',         21.63, 73.01],
    ['Cambay',               'Cambay',             22.30, 72.62],
    ['Rajahmundry (KG)',     'KG Basin',           17.00, 81.78],
    ['Karaikal (Cauvery)',   'Cauvery',            10.92, 79.84],
    ['Assam (Sivasagar)',    'Sivasagar',          26.98, 94.64],
    ['Tripura (Agartala)',   'Tripura',            23.83, 91.28],
    ['Rajasthan (Barmer)',   'Barmer',             26.10, 71.40],
    ['Jorhat (Assam)',       'Jorhat',             26.75, 94.22],
];
const UNIT_BY_NAME = Object.fromEntries(ASSET_UNITS.map((u) => [u[0], u]));

// Assign each rig (1..50) to an Asset unit. The first ~14 rigs â€” the ones the
// fleet-sim streams live â€” are spread across a handful of units (Ankleshwar,
// Mumbai High, Assam, Rajahmundry/KG, Mehsana) so the India map shows live dots
// in multiple regions. The remainder are distributed round-robin so every unit is
// represented.
function unitFor(n) {
    const live = {
        1: 'Ankleshwar', 2: 'Ankleshwar', 3: 'Ankleshwar',
        4: 'Mumbai High', 5: 'Mumbai High', 6: 'Ankleshwar',
        7: 'Assam (Sivasagar)', 8: 'Assam (Sivasagar)',
        9: 'Rajahmundry (KG)', 10: 'Rajahmundry (KG)',
        11: 'Mehsana', 12: 'Mehsana',
        13: 'Bassein & Satellite', 14: 'Cambay',
    };
    if (live[n]) return UNIT_BY_NAME[live[n]];
    // Round-robin the rest across all units so each Asset is on the map.
    return ASSET_UNITS[(n - 1) % ASSET_UNITS.length];
}

// Deterministic small jitter (Â±~0.25Â°) around an Asset centroid so each unit reads
// as a cluster of rigs rather than a single overlapping dot.
function jitter(n, salt) {
    const s = Math.sin(n * 12.9898 + salt * 78.233) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * 0.5; // ~[-0.25, +0.25]
}

// Stage-gate distribution across the fleet (demonstrates rollout governance).
function plan(n) {
    if (n <= 10) return { gate: 'live', commissioning: 'commissioned', site: true, sec: true, adopt: 78 + (n % 5) * 4, ver: 'v1.4.1', wave: 1 };
    if (n <= 16) return { gate: 'operation', commissioning: 'commissioned', site: true, sec: true, adopt: 50 + (n % 4) * 7, ver: 'v1.4.0', wave: 2 };
    if (n <= 24) return { gate: 'implementation', commissioning: 'in_progress', site: true, sec: true, adopt: 20 + (n % 4) * 6, ver: 'v1.3.2', wave: 3 };
    if (n <= 34) return { gate: 'discovery', commissioning: 'in_progress', site: (n % 2 === 0), sec: false, adopt: (n % 3) * 5, ver: null, wave: 4 };
    return { gate: 'gate0', commissioning: 'planned', site: false, sec: false, adopt: 0, ver: null, wave: 5 };
}

async function seedRigs() {
    for (const n of SEEDED_RIG_NUMBERS) {
        const rigId = `AHWR-50-${n}`;
        const name = `AHWR-50-${n}`;
        const p = plan(n);
        const [assetUnit, field, baseLat, baseLon] = unitFor(n);
        // Cluster near the unit centroid with deterministic Â±0.25Â° jitter.
        const lat = baseLat + jitter(n, 1);
        const lon = baseLon + jitter(n, 2);
        await query(
            `INSERT INTO rigs (rig_id, name, section, asset_unit, field, latitude, longitude, commissioned_at, status, schema_version)
             VALUES ($1,$2,'Workover Services',$3,$4,$5,$6,$7,$8,'1.0')
             ON CONFLICT (rig_id) DO NOTHING`,
            [rigId, name, assetUnit, field, Number(lat.toFixed(5)), Number(lon.toFixed(5)),
             p.commissioning === 'commissioned' ? '2026-01-15' : null,
             p.gate === 'gate0' || p.gate === 'discovery' ? 'pending' : 'offline']);
        await query(
            `INSERT INTO deployment_status (rig_id, gate, commissioning, site_ready, security_review, adoption_pct, edge_version, wave)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (rig_id) DO NOTHING`,
            [rigId, p.gate, p.commissioning, p.site, p.sec, p.adopt, p.ver, p.wave]);
    }
}

async function seedTags() {
    for (const t of TAGS) {
        await query(
            `INSERT INTO tags (metric, label, unit, group_name, expected)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (metric) DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit,
               group_name = EXCLUDED.group_name, expected = EXCLUDED.expected`,
            [t.metric, t.label, t.unit, t.group, t.expected]);
    }
}

async function seedUsers() {
    // All seed passwords are env-overridable (audit #8/#13) so demo creds don't
    // survive into a pilot. Defaults remain for the local docker-compose demo.
    const adminPw = process.env.ADMIN_PASSWORD || 'Admin123';
    const operatorPw = process.env.OPERATOR_PASSWORD || 'operator123';
    const viewerPw = process.env.VIEWER_PASSWORD || 'viewer123';

    // Keep the break-glass admin password aligned with ADMIN_PASSWORD even when
    // an existing database volume is moved to another offline PC.
    await query(
        `INSERT INTO users (username, password, display, role, source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (username) DO UPDATE SET
           password = EXCLUDED.password,
           display = EXCLUDED.display,
           role = EXCLUDED.role,
           source = EXCLUDED.source,
           disabled = false`,
        ['admin', hash(adminPw), 'Asset Administrator', 'admin', 'local']);

    const users = [
        ['operator', operatorPw, 'Monitoring Operator', 'operator'],
        ['viewer', viewerPw, 'Management Viewer', 'viewer'],
    ];
    for (const [u, pw, d, role] of users) {
        await query(
            `INSERT INTO users (username, password, display, role, source)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (username) DO NOTHING`,
            [u, hash(pw), d, role, 'local']);
    }
}
async function seedValueMetrics() {
    const { rows } = await query('SELECT count(*)::int AS c FROM value_metrics');
    if (rows[0].c > 0) return;
    const vm = [
        ['NPT % per AHWR', 'Operations', 14, 11.5, 12.8, '%', '24-month'],
        ['Job cycle time (rig-upâ†’down)', 'Operations', 100, 87, 94, 'index', '24-month'],
        ['HPU breakdowns during ops', 'Reliability', 100, 70, 82, 'index', '24-month'],
        ['PM compliance', 'Reliability', 71, 95, 88, '%', '24-month'],
        ['Manual reporting effort', 'Efficiency', 100, 30, 41, 'index', '24-month'],
        ['Data availability to mgmt', 'Visibility', 0, 100, 96, '%', 'live'],
        ['Per-rig data-freshness score', 'Data quality', 0, 98, 94, '%', 'live'],
    ];
    for (const v of vm) {
        await query(
            `INSERT INTO value_metrics (kpi, category, baseline, target, actual, unit, period)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`, v);
    }
}

async function seedGovernanceExtras() {
    const { rows } = await query('SELECT count(*)::int AS c FROM escalations');
    if (rows[0].c === 0) {
        // Each demo escalation references a specific rig â€” guard with WHERE EXISTS so a
        // small fleet (e.g. a 3-edge pilot with FLEET_SIZE < 33) doesn't hit the
        // escalations_rig_id_fkey FK and abort seeding. Same pattern as the wells/
        // maintenance seeds below. Escalations for rigs outside the fleet are skipped.
        const escalations = [
            ['AHWR-50-21', 'Cellular link unstable â€” sync lag > 10 min during peak', 'high', 'open', 'Instrumentation', 'Dual-SIM failover not provisioned; VSAT survey requested'],
            ['AHWR-50-28', 'PLC tag access pending vendor approval', 'medium', 'in_progress', 'Asset OT', 'Read-only tap design submitted for security review'],
            ['AHWR-50-33', 'Panel temperature alarms during commissioning', 'low', 'open', 'Site team', 'Ventilation kit dispatched'],
        ];
        for (const e of escalations) {
            await query(
                `INSERT INTO escalations (rig_id, title, severity, status, owner, notes)
                 SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM rigs WHERE rig_id = $1)`,
                e);
        }
    }
    const d = await query('SELECT count(*)::int AS c FROM decisions');
    if (d.rows[0].c === 0) {
        await query(`INSERT INTO decisions (title, detail, author) VALUES
            ('Adopt TimescaleDB as canonical central store','Ratified per architecture review; continuous aggregates for 1sâ†’1mâ†’1h rollups','Architecture Board'),
            ('Standard edge kit ratified for fleet','Single BoQ prevents fragmented parallel development across rigs','Instrumentation Section')`);
    }
}

// Maintenance & Reliability sample records (audit #7 / proposal Â§6.1). Seeded
// against commissioned rigs so the PM-compliance/overdue/breakdown KPIs read as a
// live module rather than the static governance value-realization figures.
async function seedMaintenance() {
    // Guard on table existence so the backend still boots if the SCHEMA agent's
    // maintenance_record table has not been applied yet (defensive, idempotent).
    const reg = await query("SELECT to_regclass('public.maintenance_record') AS t");
    if (!reg.rows[0] || !reg.rows[0].t) {
        console.warn('Seed: maintenance_record table not present yet â€” skipping maintenance seed.');
        return;
    }
    const { rows } = await query('SELECT count(*)::int AS c FROM maintenance_record');
    if (rows[0].c > 0) return;

    // [rig#, type, title, status, dueOffsetDays(null=none), performedOffsetDays(null=none), runtimeHours, outcome, notes]
    const recs = [
        [1,  'PM',          'Quarterly HPU preventive maintenance', 'done',        -20, -18, 2100, 'pass', 'Filters + hydraulic oil replaced'],
        [2,  'PM',          'Drawworks brake inspection PM',        'done',        -12, -12, 1850, 'pass', 'Brake linings within tolerance'],
        [3,  'calibration', 'Hookload sensor calibration',          'done',        -30, -29, null, 'pass', 'Calibrated against reference load cell'],
        [4,  'PM',          'Monthly rotary table PM',              'overdue',      -5,  null, 2400, null,  'Awaiting spare bearing kit'],
        [5,  'breakdown',   'HPU pump seal failure',                'done',        null, -3,  2600, 'repaired', 'Seal kit replaced; 6h NPT'],
        [6,  'inspection',  'Wireline BOP visual inspection',       'open',         7,   null, null, null,  'Scheduled with OEM technician'],
        [7,  'PM',          'Top-drive gearbox oil change',         'in_progress',  2,   null, 1990, null,  'Oil sample sent for analysis'],
        [8,  'calibration', 'HTD torque transducer calibration',    'open',         10,  null, null, null,  'Calibration certificate due'],
        [9,  'breakdown',   'Mud pump liner washout',               'done',        null, -8,  2750, 'repaired', 'Liner + piston replaced'],
        [10, 'PM',          'Annual structural integrity PM',       'open',         21,  null, 3100, null,  'Third-party NDT planned'],
        [12, 'inspection',  'Crown block sheave inspection',        'overdue',     -2,  null, 2200, null,  'Access platform required'],
        [14, 'PM',          'Diesel genset 500h service',           'done',        -40, -39, 500,  'pass', 'Routine service completed'],
    ];

    for (const [n, type, title, status, dueOff, perfOff, runtime, outcome, notes] of recs) {
        const rigId = `AHWR-50-${n}`;
        const dueExpr = dueOff == null ? null : new Date(Date.now() + dueOff * 86400000).toISOString().slice(0, 10);
        const perfExpr = perfOff == null ? null : new Date(Date.now() + perfOff * 86400000).toISOString();
        await query(
            `INSERT INTO maintenance_record
               (rig_id, type, title, status, due_date, performed_at, runtime_hours, outcome, notes)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
             WHERE EXISTS (SELECT 1 FROM rigs WHERE rig_id = $1)`,
            [rigId, type, title, status, dueExpr, perfExpr, runtime, outcome, notes]);
    }
}

// Seed a demo webhook notification channel when NOTIFY_DEMO_WEBHOOK_URL is set
// (compose points it at the notify-sink), so P1 alerts are demonstrable end-to-end.
async function seedNotificationChannels() {
    const url = process.env.NOTIFY_DEMO_WEBHOOK_URL;
    if (!url) return;
    const { rows } = await query('SELECT count(*)::int AS c FROM notification_channels');
    if (rows[0].c > 0) return;
    await query(
        `INSERT INTO notification_channels (type, name, target, min_severity, enabled)
         VALUES ('webhook', 'Demo webhook (notify-sink)', $1, 'P1', true)`, [url]);
}

// ---------------------------------------------------------------------
// Well management seed (WITSML-inspired; proposal Â§6.1 well drill-down).
// 1) For each STREAMING rig, seed its CURRENT well under the rig's sim job name
//    (well_id = base job name, type/status 'workover', asset/field/coords copied
//    from the rig, current_rig_id = rig). Runs accrue at runtime from trackRun.
// 2) ~25 EXTRA wells across asset units with varied lifecycle/type/operator/depth
//    and NO current rig, so the Wells list is rich on first boot.
// Idempotent: ON CONFLICT DO NOTHING (and trackRun owns current_rig_id at runtime).
// ---------------------------------------------------------------------

// Base sim job name for rig n â€” MUST match fleet-sim/sim.js (the base of its
// 3-well rotation set). The rotating siblings are created at runtime by trackRun.
function baseJobFor(n) { return `GS-${10 + n}#${3 + (n % 5)}`; }

async function seedWells() {
    // Guard on table existence so the backend still boots if the wells tables have
    // not been applied yet (defensive, idempotent).
    const reg = await query("SELECT to_regclass('public.wells') AS t");
    if (!reg.rows[0] || !reg.rows[0].t) {
        console.warn('Seed: wells table not present yet â€” skipping well seed.');
        return;
    }

    if (String(process.env.SEED_SIM_WELLS || '').toLowerCase() === 'true') {
        // 1) Seed known sim wells without attaching them as current; real edge ingest
        // owns current_rig_id / active_job so central does not show stale demo wells.
        const liveRigNumbers = SEEDED_RIG_NUMBERS.filter((n) => n <= ACTIVE_RIGS);
        for (const n of liveRigNumbers) {
            const rigId = `AHWR-50-${n}`;
            const job = baseJobFor(n);
            const [assetUnit, field, baseLat, baseLon] = unitFor(n);
            const lat = Number((baseLat + jitter(n, 3)).toFixed(5));
            const lon = Number((baseLon + jitter(n, 4)).toFixed(5));
            const spud = new Date(Date.now() - (30 + (n % 20)) * 86400000).toISOString().slice(0, 10);
            await query(
                `INSERT INTO wells
                   (well_id, name, uwi, well_type, status, field, asset_unit, latitude, longitude,
                    spud_date, total_depth, operator)
                 SELECT $1,$1,$2,'workover','workover',$3,$4,$5,$6,$7,$8,'ONGC'
                 WHERE EXISTS (SELECT 1 FROM rigs WHERE rig_id = $9)
                 ON CONFLICT (well_id) DO NOTHING`,
                [job, `IN-ONGC-${1000 + n}`, field, assetUnit, lat, lon, spud,
                 Number((1500 + (n % 7) * 60).toFixed(0)), rigId]);
        }
    } else {
        console.log('Seed: simulator wells disabled; edge ingest owns active wells.');
    }

    if (String(process.env.SEED_DEMO_WELLS || '').toLowerCase() !== 'true') {
        console.log('Seed: demo well catalogue disabled; only rig-attached wells will be shown.');
        return;
    }

    // 2) ~25 extra wells across asset units (varied lifecycle), NO current rig.
    // [suffix, well_type, status, totalDepth]
    const profiles = [
        ['production', 'producing', 1820], ['production', 'producing', 2050],
        ['injection', 'producing', 1640], ['production', 'suspended', 1910],
        ['exploration', 'planned', 2600], ['appraisal', 'planned', 2380],
        ['production', 'completed', 1750], ['workover', 'workover', 1480],
        ['production', 'abandoned', 1990], ['injection', 'suspended', 1560],
        ['production', 'producing', 2120], ['exploration', 'drilling', 2740],
        ['production', 'producing', 1880], ['appraisal', 'completed', 2290],
        ['production', 'suspended', 1700], ['injection', 'producing', 1610],
        ['production', 'producing', 1960], ['workover', 'workover', 1520],
        ['production', 'abandoned', 1840], ['exploration', 'planned', 2810],
        ['production', 'producing', 2030], ['appraisal', 'drilling', 2470],
        ['production', 'completed', 1790], ['injection', 'suspended', 1580],
        ['production', 'producing', 2160],
    ];
    let idx = 0;
    for (const [wellType, status, td] of profiles) {
        idx += 1;
        // Spread across all asset units round-robin.
        const [assetUnit, field, baseLat, baseLon] = ASSET_UNITS[(idx - 1) % ASSET_UNITS.length];
        const wellId = `${field.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${100 + idx}`;
        const lat = Number((baseLat + jitter(idx + 100, 5)).toFixed(5));
        const lon = Number((baseLon + jitter(idx + 100, 6)).toFixed(5));
        const spud = (status === 'planned')
            ? null
            : new Date(Date.now() - (90 + idx * 11) * 86400000).toISOString().slice(0, 10);
        await query(
            `INSERT INTO wells
               (well_id, name, uwi, well_type, status, field, asset_unit, latitude, longitude,
                spud_date, total_depth, operator, block_lease)
             VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ONGC',$11)
             ON CONFLICT (well_id) DO NOTHING`,
            [wellId, `IN-ONGC-${2000 + idx}`, wellType, status, field, assetUnit, lat, lon,
             spud, td, `${field} Block`]);
    }
}

async function seedAll() {
    await seedRigs();
    await seedTags();
    await seedUsers();
    await seedValueMetrics();
    await seedGovernanceExtras();
    await seedMaintenance();
    await seedNotificationChannels();
    await seedWells();
    console.log(`Seed complete: ${SEEDED_RIG_NUMBERS.length}-rig registry (${SEEDED_RIG_NUMBERS.map((n) => `AHWR-50-${n}`).join(', ')}), tag dictionary, users, value metrics, maintenance records, wells.`);
}

module.exports = { seedAll };


'use strict';
// Standard tag dictionary (proposal §4.4 representative parameter set, §6.1 config registry).
// metric === "<measurement>.<field>" as flattened by the edge sync agent (backend/lib/sync.js).
// `expected` tags count toward the per-rig data-completeness health score.
// `key` tags surface as headline KPIs on the fleet/rig views.
//
// CONSOLIDATION NOTE (edge <-> central wire contract)
// ---------------------------------------------------
// This dictionary is derived from the ACTUAL flattened payload a rig-edge twin emits
// (backend/lib/sync.js flatten(): every numeric field of every non-underscore
// measurement in the live rig object). It was reconciled against a live edge capture
// of 112 metrics across 12 measurements.
//
// Two naming corrections were made against the pre-consolidation dictionary:
//
//  1. BOP is `well_control.*`, NOT `wellcontrol.*`. The edge reads the Influx
//     measurement `wellcontrol`, then renames it to `well_control` and attaches an
//     `available` flag before sync (backend/server.js), deleting the original key.
//     The old dictionary declared `wellcontrol.accumulator_pressure` /
//     `wellcontrol.annular_pressure` as expected, so those two BOP tags could never
//     match a real rig's telemetry and scored as permanently missing on every rig.
//     The bundled fleet-sim emitted the OLD spelling, which masked the bug in demos.
//     WIRE_ALIASES below keeps pre-consolidation edges working.
//
//  2. `safety.esd_active` / `safety.lockout_active` are mapped from PLC digital
//     inputs (edge backend/lib/fieldmap.js) and are therefore absent until a rig's
//     PLC field map is configured. They are deliberately NOT `expected` — scoring
//     them would penalise every rig that has not yet been mapped, and the edge's
//     safety contract forbids fabricating a benign 0 for an absent safety signal.
//     They are `key` so they surface immediately once a rig does report them.
//     Flip these to expected:true once fieldmap coverage is confirmed fleet-wide.

const TAGS = [
    // ---------------------------------------------------------------
    // Hoisting & load
    // ---------------------------------------------------------------
    { metric: 'drawworks.hook_load',        label: 'Hookload',            unit: 't',      group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drawworks.block_position',   label: 'Block position',      unit: 'ft',     group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drawworks.rope_wear',        label: 'Rope wear',           unit: 'ton/km', group: 'Hoisting & load',  expected: false, key: false },
    { metric: 'drilling.wob',               label: 'Weight on bit',       unit: 't',      group: 'Hoisting & load',  expected: true,  key: false },
    { metric: 'drilling.rop',               label: 'Rate of penetration', unit: 'm/h',    group: 'Hoisting & load',  expected: true,  key: false },
    { metric: 'drilling.hole_depth',        label: 'Hole depth',          unit: 'm',      group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drilling.bit_depth',         label: 'Bit depth',           unit: 'm',      group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drilling.operation_mode',    label: 'OP.MODE',             unit: '',       group: 'Hoisting & load',  expected: false, key: true },

    // ---------------------------------------------------------------
    // Anti-collision system (ACS) — crown/floor/bottom saver envelope
    // ---------------------------------------------------------------
    { metric: 'acs.status',                 label: 'ACS',                 unit: '',       group: 'Anti-collision',   expected: false, key: true },
    { metric: 'acs.block_position',         label: 'ACS block position',  unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.crownsaver',             label: 'Crown saver',         unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.floorsaver',             label: 'Floor saver',         unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.bottomsaver',            label: 'Bottom saver',        unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.upper_tag',              label: 'Upper tag limit',     unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.lower_tag',              label: 'Lower tag limit',     unit: 'ft',     group: 'Anti-collision',   expected: false, key: false },
    { metric: 'acs.calibration_status',     label: 'ACS calibration',     unit: '',       group: 'Anti-collision',   expected: false, key: false },

    // ---------------------------------------------------------------
    // Rotary — hydraulic top drive (HTD)
    // ---------------------------------------------------------------
    { metric: 'htd.rpm',                    label: 'HTD RPM',             unit: 'rpm',    group: 'Top drive (HTD)',  expected: true,  key: true },
    { metric: 'htd.torque',                 label: 'HTD torque',          unit: 'Nm',     group: 'Top drive (HTD)',  expected: true,  key: true },
    { metric: 'htd.status',                 label: 'HTD status',          unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.op_mode',                label: 'HTD op mode',         unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.work_mode',              label: 'HTD work mode',       unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.rotation_status',        label: 'Rotation status',     unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.brake_status',           label: 'Brake status',        unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.elevator_status',        label: 'Elevator status',     unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.gear_status',            label: 'Gear status',         unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.ibop_status',            label: 'IBOP status',         unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.lube_status',            label: 'Lube status',         unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.tilt_status',            label: 'Tilt status',         unit: '',       group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.inclination',            label: 'Inclination',         unit: '°',      group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.vertical_speed',         label: 'Vertical speed',      unit: 'm/s',    group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'htd.working_hours',          label: 'HTD working hours',   unit: 'h',      group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'drilling.rpm',               label: 'String RPM',          unit: 'rpm',    group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'drilling.torque',            label: 'String torque',       unit: 'Nm',     group: 'Top drive (HTD)',  expected: false, key: false },
    { metric: 'drilling.delta_torque',      label: 'Delta torque',        unit: 'daN·m',  group: 'Top drive (HTD)',  expected: false, key: false },

    // ---------------------------------------------------------------
    // Power casing tong (PCT) — make-up / torque-turn
    // ---------------------------------------------------------------
    { metric: 'pct.makeup_torque',          label: 'Make-up torque',      unit: 'Nm',     group: 'Casing tong (PCT)', expected: true,  key: false },
    { metric: 'pct.last_makeup_torque',     label: 'Last make-up peak',   unit: 'Nm',     group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.spinner_makeup_torque',  label: 'Spinner make-up',     unit: 'Nm',     group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.status',                 label: 'PCT status',          unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.op_mode',                label: 'PCT op mode',         unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.sequence',               label: 'PCT sequence step',   unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.dolly_status',           label: 'Dolly status',        unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.spinner_floating',       label: 'Spinner floating',    unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.clamp_up_status',        label: 'Upper clamp status',  unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.clamp_up_pressure',      label: 'Upper clamp press.',  unit: 'bar',    group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.clamp_low_status',       label: 'Lower clamp status',  unit: '',       group: 'Casing tong (PCT)', expected: false, key: false },
    { metric: 'pct.clamp_low_pressure',     label: 'Lower clamp press.',  unit: 'bar',    group: 'Casing tong (PCT)', expected: false, key: false },

    // ---------------------------------------------------------------
    // Catwalk / pipe handling (CWK)
    // ---------------------------------------------------------------
    { metric: 'cwk.status',                 label: 'Catwalk status',      unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.carrier_status',         label: 'Carrier status',      unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.clamp_status',           label: 'CWK clamp status',    unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.clamp_force',            label: 'CWK clamp force',     unit: 'kN',     group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.clamp_pressure',         label: 'CWK clamp pressure',  unit: 'bar',    group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.skate_status',           label: 'Skate status',        unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.slide_status',           label: 'Slide status',        unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.indexer_dx',             label: 'Indexer DX',          unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.indexer_sx',             label: 'Indexer SX',          unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.kickers_dx',             label: 'Kickers DX',          unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.kickers_sx',             label: 'Kickers SX',          unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },
    { metric: 'cwk.source_cmd',             label: 'CWK command source',  unit: '',       group: 'Pipe handling (CWK)', expected: false, key: false },

    // ---------------------------------------------------------------
    // Hydraulic power unit (HPU)
    // ---------------------------------------------------------------
    { metric: 'hpu.discharge_pressure',     label: 'HPU discharge',       unit: 'bar',    group: 'Hydraulic power unit', expected: true,  key: true },
    { metric: 'hpu.oil_temp',               label: 'HPU oil temp',        unit: '°C',     group: 'Hydraulic power unit', expected: true,  key: true },
    { metric: 'hpu.aux_pressure',           label: 'HPU aux pressure',    unit: 'bar',    group: 'Hydraulic power unit', expected: true,  key: false },
    { metric: 'hpu.oil_level',              label: 'HPU oil level',       unit: '%',      group: 'Hydraulic power unit', expected: true,  key: false },
    { metric: 'hpu.pilot_pressure',         label: 'HPU pilot pressure',  unit: 'bar',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.status',                 label: 'HPU status',          unit: '',       group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.run_hours',              label: 'HPU run hours',       unit: 'h',      group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.gate_valve',             label: 'Gate valve',          unit: '',       group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.htd_pump1_press',        label: 'HTD pump 1 press.',   unit: 'bar',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.htd_pump1_flow',         label: 'HTD pump 1 flow',     unit: 'lpm',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.htd_pump2_press',        label: 'HTD pump 2 press.',   unit: 'bar',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.htd_pump2_flow',         label: 'HTD pump 2 flow',     unit: 'lpm',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.pdw_pump_press',         label: 'PDW pump press.',     unit: 'bar',    group: 'Hydraulic power unit', expected: false, key: false },
    { metric: 'hpu.pdw_pump_flow',          label: 'PDW pump flow',       unit: 'lpm',    group: 'Hydraulic power unit', expected: false, key: false },

    // ---------------------------------------------------------------
    // Well parameters — wellhead, mud pump, fluids
    // ---------------------------------------------------------------
    { metric: 'wellhead.tubing_pressure',   label: 'Tubing pressure',     unit: 'bar',    group: 'Well parameters',  expected: true,  key: true },
    { metric: 'wellhead.casing_pressure',   label: 'Casing pressure',     unit: 'bar',    group: 'Well parameters',  expected: true,  key: false },
    { metric: 'wellhead.wellhead_pressure', label: 'Wellhead pressure',   unit: 'bar',    group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.pressure',           label: 'Standpipe pressure',  unit: 'bar',    group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.delta_pressure',     label: 'Delta pressure',      unit: 'bar',    group: 'Well parameters',  expected: false, key: false },
    { metric: 'mudpump.spm',                label: 'Pump strokes/min',    unit: 'spm',    group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.total_spm',          label: 'Total strokes',       unit: 'strokes',group: 'Well parameters',  expected: false, key: false },
    { metric: 'mudpump.flow_in',            label: 'Flow in',             unit: 'lpm',    group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.flow_out',           label: 'Flow out',            unit: '%',      group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.tank_gain_loss',       label: 'Tank gain/loss',      unit: 'm³',     group: 'Well parameters',  expected: true,  key: true },
    { metric: 'fluid.total_tank_volume',    label: 'Active tank volume',  unit: 'm³',     group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.trip_tank',            label: 'Trip tank',           unit: 'm³',     group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.trip_tank_percentage', label: 'Trip tank level',     unit: '%',      group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.tank_1',               label: 'Pit tank 1',          unit: 'm³',     group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.tank_2',               label: 'Pit tank 2',          unit: 'm³',     group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.tank_3',               label: 'Pit tank 3',          unit: 'm³',     group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.tank_4',               label: 'Pit tank 4',          unit: 'm³',     group: 'Well parameters',  expected: false, key: false },

    // ---------------------------------------------------------------
    // BOP & well control  (canonical namespace: well_control.*)
    // Ram/annular open|close arrive as booleans and are coerced to 1|0 by the
    // edge flattener, so they are numeric here. `available` is the edge's
    // honesty flag: 0 => the rig has no BOP data mapped, do NOT read the
    // pressures as "safe".
    // ---------------------------------------------------------------
    { metric: 'well_control.available',            label: 'BOP data available',   unit: '',    group: 'BOP & well control', expected: true,  key: true },
    { metric: 'well_control.accumulator_pressure', label: 'Accumulator pressure', unit: 'psi', group: 'BOP & well control', expected: true,  key: true },
    { metric: 'well_control.annular_pressure',     label: 'Annular pressure',     unit: 'psi', group: 'BOP & well control', expected: true,  key: false },
    { metric: 'well_control.manifold_pressure',    label: 'Manifold pressure',    unit: 'psi', group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.annular_open',         label: 'Annular open',         unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.annular_close',        label: 'Annular closed',       unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.pipe_ram_open',        label: 'Pipe ram open',        unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.pipe_ram_close',       label: 'Pipe ram closed',      unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.blind_ram_open',       label: 'Blind ram open',       unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.blind_ram_close',      label: 'Blind ram closed',     unit: '',    group: 'BOP & well control', expected: false, key: false },
    { metric: 'well_control.shear_ram_open',       label: 'Shear ram open',       unit: '',    group: 'BOP & well control', expected: false, key: false },

    // Safety digital inputs — present only once the rig's PLC field map is
    // configured (see header note 2). key:true, expected:false by design.
    { metric: 'safety.esd_active',          label: 'ESD active',          unit: '',       group: 'BOP & well control', expected: false, key: true },
    { metric: 'safety.lockout_active',      label: 'Lockout active',      unit: '',       group: 'BOP & well control', expected: false, key: true },

    // ---------------------------------------------------------------
    // Engine / power & auxiliaries
    // ---------------------------------------------------------------
    { metric: 'cat_engine.load',            label: 'Engine load',         unit: '%',      group: 'Engine & power',   expected: true,  key: true },
    { metric: 'cat_engine.rpm',             label: 'Engine RPM',          unit: 'rpm',    group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.coolant_temp',    label: 'Coolant temp',        unit: '°C',     group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.oil_pressure',    label: 'Engine oil pressure', unit: 'psi',    group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.coolant_level',   label: 'Coolant level',       unit: '%',      group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.fuel_rate',       label: 'Fuel rate',           unit: 'l/h',    group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.fuel_temp',       label: 'Fuel temp',           unit: '°C',     group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.total_fuel',      label: 'Total fuel used',     unit: 'l',      group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.battery_voltage', label: 'Battery voltage',     unit: 'V',      group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.status',          label: 'Engine status',       unit: '',       group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.run_hours',       label: 'Engine run hours',    unit: 'h',      group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.total_hours',     label: 'Engine total hours',  unit: 'h',      group: 'Engine & power',   expected: false, key: false },
];

// Back-compat for pre-consolidation edges that still emit the old BOP namespace.
// Applied on ingest so historical and new rows share one canonical metric name.
const WIRE_ALIASES = {
    'wellcontrol.accumulator_pressure': 'well_control.accumulator_pressure',
    'wellcontrol.annular_pressure':     'well_control.annular_pressure',
    'wellcontrol.manifold_pressure':    'well_control.manifold_pressure',
};

// Normalise a wire metric name to its canonical form (identity for known tags).
function canonicalMetric(metric) {
    return WIRE_ALIASES[metric] || metric;
}

const EXPECTED_METRICS = TAGS.filter((t) => t.expected).map((t) => t.metric);
const KEY_METRICS = TAGS.filter((t) => t.key).map((t) => t.metric);
const TAG_BY_METRIC = Object.fromEntries(TAGS.map((t) => [t.metric, t]));
const GROUPS = [...new Set(TAGS.map((t) => t.group))];

module.exports = {
    TAGS, EXPECTED_METRICS, KEY_METRICS, TAG_BY_METRIC, GROUPS,
    WIRE_ALIASES, canonicalMetric,
};

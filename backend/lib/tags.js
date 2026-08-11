'use strict';
// Standard tag dictionary (proposal §4.4 representative parameter set, §6.1 config registry).
// metric === "<measurement>.<field>" as flattened by the edge sync agent (backend/lib/sync.js).
// `expected` tags count toward the per-rig data-completeness health score.
// `key` tags surface as headline KPIs on the fleet/rig views.

const TAGS = [
    // Hoisting & load
    { metric: 'drawworks.hook_load',        label: 'Hookload',            unit: 't',    group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drawworks.block_position',   label: 'Block position',      unit: 'ft',   group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drawworks.rope_wear',        label: 'Rope wear',           unit: '%',    group: 'Hoisting & load',  expected: false, key: false },
    { metric: 'drilling.wob',               label: 'Weight on bit',       unit: 't',    group: 'Hoisting & load',  expected: true,  key: false },
    { metric: 'drilling.rop',               label: 'Rate of penetration', unit: 'm/h',  group: 'Hoisting & load',  expected: true,  key: false },
    { metric: 'drilling.hole_depth',        label: 'Hole depth',          unit: 'm',    group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drilling.bit_depth',         label: 'Bit depth',           unit: 'm',    group: 'Hoisting & load',  expected: true,  key: true },
    { metric: 'drilling.operation_mode',    label: 'OP.MODE',             unit: '',     group: 'Hoisting & load',  expected: false, key: true },
    { metric: 'acs.status',                 label: 'ACS',                 unit: '',     group: 'Hoisting & load',  expected: false, key: true },

    // Rotary / tong systems (HTD, PCT)
    { metric: 'drilling.rpm',               label: 'String RPM',          unit: 'rpm',  group: 'Rotary / tongs',   expected: false, key: false },
    { metric: 'drilling.torque',            label: 'String torque',       unit: 'Nm',   group: 'Rotary / tongs',   expected: false, key: false },
    { metric: 'htd.rpm',                    label: 'HTD RPM',             unit: 'rpm',  group: 'Rotary / tongs',   expected: true,  key: true },
    { metric: 'htd.torque',                 label: 'HTD torque',          unit: 'Nm',   group: 'Rotary / tongs',   expected: true,  key: true },
    { metric: 'pct.makeup_torque',          label: 'Make-up torque',      unit: 'Nm',   group: 'Rotary / tongs',   expected: true,  key: false },
    { metric: 'pct.last_makeup_torque',     label: 'Last make-up peak',   unit: 'Nm',   group: 'Rotary / tongs',   expected: false, key: false },

    // Hydraulic power unit
    { metric: 'hpu.aux_pressure',           label: 'HPU aux pressure',    unit: 'bar',  group: 'Hydraulic power unit', expected: true, key: false },
    { metric: 'hpu.discharge_pressure',     label: 'HPU discharge',       unit: 'bar',  group: 'Hydraulic power unit', expected: true, key: true },
    { metric: 'hpu.oil_temp',               label: 'HPU oil temp',        unit: '°C',   group: 'Hydraulic power unit', expected: true, key: true },
    { metric: 'hpu.oil_level',              label: 'HPU oil level',       unit: '%',    group: 'Hydraulic power unit', expected: true, key: false },
    { metric: 'hpu.pilot_pressure',         label: 'HPU pilot pressure',  unit: 'bar',  group: 'Hydraulic power unit', expected: false, key: false },

    // Well parameters
    { metric: 'wellhead.tubing_pressure',   label: 'Tubing pressure',     unit: 'bar',  group: 'Well parameters',  expected: true,  key: true },
    { metric: 'wellhead.casing_pressure',   label: 'Casing pressure',     unit: 'bar',  group: 'Well parameters',  expected: true,  key: false },
    { metric: 'wellhead.wellhead_pressure', label: 'Wellhead pressure',   unit: 'bar',  group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.spm',                label: 'Pump strokes/min',    unit: 'spm',  group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.flow_in',            label: 'Flow in',             unit: 'lpm',  group: 'Well parameters',  expected: true,  key: false },
    { metric: 'mudpump.pressure',           label: 'Standpipe pressure',  unit: 'bar',  group: 'Well parameters',  expected: true,  key: false },
    { metric: 'fluid.tank_gain_loss',       label: 'Tank gain/loss',      unit: 'm³',   group: 'Well parameters',  expected: true,  key: true },
    { metric: 'fluid.total_tank_volume',    label: 'Active tank volume',  unit: 'm³',   group: 'Well parameters',  expected: false, key: false },
    { metric: 'fluid.trip_tank',            label: 'Trip tank',           unit: 'm³',   group: 'Well parameters',  expected: false, key: false },

    // BOP & safety systems
    { metric: 'wellcontrol.accumulator_pressure', label: 'Accumulator pressure', unit: 'psi', group: 'BOP & safety', expected: true, key: true },
    { metric: 'wellcontrol.annular_pressure',     label: 'Annular pressure',     unit: 'psi', group: 'BOP & safety', expected: true, key: false },
    { metric: 'wellcontrol.manifold_pressure',    label: 'Manifold pressure',    unit: 'psi', group: 'BOP & safety', expected: false, key: false },
    { metric: 'safety.esd_active',          label: 'ESD active',          unit: '',     group: 'BOP & safety',     expected: true,  key: false },
    { metric: 'safety.lockout_active',      label: 'Lockout active',      unit: '',     group: 'BOP & safety',     expected: true,  key: false },

    // Engine / power & auxiliaries
    { metric: 'cat_engine.rpm',             label: 'Engine RPM',          unit: 'rpm',  group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.load',            label: 'Engine load',         unit: '%',    group: 'Engine & power',   expected: true,  key: true },
    { metric: 'cat_engine.coolant_temp',    label: 'Coolant temp',        unit: '°C',   group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.oil_pressure',    label: 'Engine oil pressure', unit: 'psi',  group: 'Engine & power',   expected: true,  key: false },
    { metric: 'cat_engine.fuel_rate',       label: 'Fuel rate',           unit: 'l/h',  group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.fuel_temp',       label: 'Fuel temp',           unit: '°C',   group: 'Engine & power',   expected: false, key: false },
    { metric: 'cat_engine.battery_voltage', label: 'Battery voltage',     unit: 'V',    group: 'Engine & power',   expected: false, key: false },
];

const EXPECTED_METRICS = TAGS.filter((t) => t.expected).map((t) => t.metric);
const KEY_METRICS = TAGS.filter((t) => t.key).map((t) => t.metric);
const TAG_BY_METRIC = Object.fromEntries(TAGS.map((t) => [t.metric, t]));

module.exports = { TAGS, EXPECTED_METRICS, KEY_METRICS, TAG_BY_METRIC };

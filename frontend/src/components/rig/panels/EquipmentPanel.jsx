import React, { useEffect, useMemo, useState } from 'react';
import { Box, Paper, Typography, Stack, Button, IconButton, Alert } from '@mui/material';
import { Speed, Timeline, WaterDrop, Shield, Apps, Anchor } from '@mui/icons-material';
import { useRigData } from '../../../context/RigDataContext';
import EdrView from '../EdrView';
import { fmtNum } from '../../common';

const BLUE = '#38bdf8';
const GREEN = '#4ade80';
const YELLOW = '#facc15';
const ORANGE = '#fb923c';
const PURPLE = '#a855f7';
const PANEL = '#293648';
const BG = '#0b1220';

const EQUIP_TABS = [
    { key: 'cat', label: 'CAT', icon: Speed },
    { key: 'hpu', label: 'HPU', icon: Timeline },
    { key: 'htd', label: 'HTD', icon: WaterDrop },
    { key: 'mud', label: 'MUD', icon: WaterDrop },
    { key: 'acs', label: 'ACS', icon: Shield },
    { key: 'catwalk', label: 'CATWALK', icon: Apps },
    { key: 'pct', label: 'PCT', icon: Anchor },
];

const TREND_CHANNELS = {
    cat: [
        'cat_engine.status', 'cat_engine.source_cmd', 'cat_engine.rpm', 'cat_engine.load', 'cat_engine.coolant_temp', 'cat_engine.fuel_pressure',
        'cat_engine.oil_pressure', 'cat_engine.battery_voltage', 'cat_engine.fuel_rate',
        'cat_engine.accel_pedal', 'cat_engine.accelerator_pedal', 'cat_engine.throttle_position',
        'cat_engine.total_fuel_used', 'cat_engine.fuel_used_total', 'cat_engine.total_fuel', 'cat_engine.fuel_consumed',
    ],
    hpu: [
        'hpu.status', 'hpu.operating_mode', 'hpu.mode', 'hpu.pilot_status', 'hpu.gate_valve',
        'hpu.aux_pressure', 'hpu.discharge_pressure', 'hpu.pilot_pressure', 'hpu.pilot_ls_press',
        'hpu.oil_temp', 'hpu.oil_level', 'hpu.temp_status', 'hpu.oil_temp_status', 'hpu.level_status', 'hpu.oil_level_status',
        'hpu.oil_filter_1', 'hpu.oil_filter_2', 'hpu.oil_filter_3', 'hpu.oil_filter_4',
        'hpu.oil_filter_5', 'hpu.oil_filter_6', 'hpu.oil_filter_7', 'hpu.oil_filter_8',
        'hpu.pdw_pump_status', 'hpu.pdw_flow', 'hpu.pdw_press',
        'hpu.htd_pump_1_status', 'hpu.htd_pump1_status', 'hpu.htd_pump_2_status', 'hpu.htd_pump_2_flow', 'hpu.htd_pump_2_press',
        'hpu.htd_pump_4_status', 'hpu.htd_pump2_status', 'hpu.htd_pump_4_flow', 'hpu.htd_pump_4_press',
    ],
    htd: [
        'htd.status', 'htd.work_mode', 'htd.op_mode', 'htd.rotation', 'htd.rotation_status',
        'htd.rpm', 'htd.rpm_req', 'htd.rpm_cmd', 'htd.torque', 'htd.torque_req', 'htd.torque_cmd',
        'htd.vertical_speed', 'htd.inclination', 'htd.elevator_status', 'htd.ibop_status',
        'htd.brake_status', 'htd.link_rotation', 'htd.link_rotation_status', 'htd.gear_selection', 'htd.gear_status', 'htd.suspension', 'htd.suspension_status',
        'htd.lube_status', 'htd.link_tilt_status', 'htd.tilt_status', 'htd.tilt_status_db65', 'htd.inclination_status',
        'htd.working_time', 'htd.working_hours', 'htd.working_minutes',
    ],
    mud: [
        'mudpump.status', 'mudpump.source_cmd', 'mudpump.spm', 'mudpump.pressure',
        'mudpump.total_spm', 'mudpump.flow_in', 'mudpump.flow_out', 'mudpump.flow_out_percentage',
        'mudpump.total_strokes', 'fluid.total_tank_volume', 'fluid.tank_gain_loss', 'fluid.trip_tank',
        'fluid.trip_tank_gain_loss', 'fluid.tank_1', 'fluid.tank_2', 'fluid.tank_3', 'fluid.tank_4',
        'fluid.pit_volume_1', 'fluid.pit_volume_2', 'fluid.pit_volume_3', 'fluid.pit_volume_4',
    ],
    acs: [
        'acs.status', 'acs.calibration', 'acs.block_position', 'acs.upper_tag', 'acs.lower_tag',
        'acs.crownsaver', 'acs.floorsaver', 'acs.bottomsaver', 'acs.active_limits',
    ],
    catwalk: [
        'cwk.status', 'cwk.source_cmd', 'cwk.clamp_status', 'cwk.carrier_status',
        'cwk.clamp_pressure', 'cwk.clamp_force', 'cwk.position', 'cwk.speed',
        'cwk.indexer_dx', 'cwk.indexer_sx', 'cwk.kickers_dx', 'cwk.kickers_sx',
        'cwk.skate', 'cwk.slide',
    ],
    pct: [
        'pct.status', 'pct.operation_mode', 'pct.sequence', 'pct.clamp_rotation',
        'pct.makeup_torque', 'pct.last_makeup_torque', 'pct.spinner_torque', 'pct.spinner_bo_torque',
        'pct.rotation_makeup_pressure', 'pct.rotation_bo_pressure', 'pct.clamp_up_pressure', 'pct.clamp_low_pressure',
        'pct.clamp_up_force', 'pct.clamp_low_force', 'pct.clamp_up_status', 'pct.clamp_low_status',
        'pct.dolly_direction', 'pct.dolly_status', 'pct.spinner_rotation', 'pct.spinner_rotation_status',
        'pct.spinner_gripper', 'pct.spinner_gripper_status', 'pct.spinner_floating',
    ],
};
const TREND_LABELS = {
    cat: 'ENGINE', hpu: 'HPU', htd: 'HTD', mud: 'MUD', acs: 'ACS', catwalk: 'CATWALK', pct: 'PCT',
};
const CAT_MAPS = {
    status: { '-1': 'UNKNOWN', 0: 'READY', 1: 'IN PROGRESS', 2: 'DONE', 3: 'EMERGENCY NOT OK', 4: 'NOT READY', 5: 'FAULT', 6: 'RUNNING + FAULT', 7: 'STOP FORCED' },
    sourceCmd: { 0: 'NONE', 1: 'LOCAL', 2: 'REMOTE', 3: 'MANUAL', 4: 'AUTO', 5: 'DCC', 6: '---' },
};
function catLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const key = String(Number(value));
    const map = CAT_MAPS[mapName] || {};
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return String(value);
}
const HPU_MAPS = {
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    opMode: { 0: 'UNKNOWN', 1: 'DRILLING', 2: 'RIGUP' },
    pilotStatus: { 0: 'OFF', 1: 'ON', 2: 'FAULT' },
    gateValve: { 0: 'CLOSE', 1: 'OPEN' },
    oilTemp: { 0: 'TEMP. OK', 1: 'TEMP. LOW', 2: 'TEMP. HIGH', 3: 'TEMP. HIGH-HIGH' },
    oilLevel: { 0: 'LEVEL OK', 1: 'LEVEL LOW', 2: 'LEVEL LOW-LOW', 3: 'LEVEL HIGH', 4: 'LEVEL HIGH-HIGH' },
    filter: { 0: 'CLOGGED', 1: 'OK' },
    pump: { 0: 'NOT READY', 1: 'READY', 2: 'ENABLE' },
};
function hpuLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = HPU_MAPS[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}
const HTD_MAPS = {
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    workMode: { 0: 'UNKNOWN', 1: 'DRILL', 2: 'SPIN', 3: 'TORQUE' },
    opMode: { 0: 'UNKNOWN', 1: 'DOLLY', 2: 'LINK' },
    rotation: { 0: 'STAND STILL', 1: 'ROTATION FWD', 2: 'ROTATION BWD', 3: 'NEUTRAL' },
    lube: { 0: 'OFF', 1: 'CMD RUN', 2: 'RUNNING', 3: 'FAULT' },
    gearSelection: { '-1': 'FAULT', 0: 'UNKNOWN', 1: 'GEAR 1', 2: 'GEAR 2', 3: 'GEAR 3', 4: 'GEAR 4', 5: 'GEAR 1 REGENERATIVE', 6: 'GEAR 2 REGENERATIVE', 7: 'GEAR 3 REGENERATIVE', 8: 'GEAR 4 REGENERATIVE' },
    brake: { 0: 'UNKNOWN', 1: 'CLOSING', 2: 'CLOSED', 3: 'OPENING', 4: 'OPEN', 5: 'FAULT' },
    elevator: { 0: 'UNKNOWN', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT' },
    ibop: { 0: 'UNKNOWN', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT' },
    linkRotation: { 0: 'UNKNOWN', 1: 'UNLOCKING', 2: 'UNLOCKED', 3: 'ROT. FWD', 4: 'ROT. BWD', 5: 'LOCKING', 6: 'LOCKED', 7: 'FAULT' },
    linkTilt: { 0: 'NONE', 1: 'FLOAT ON', 2: 'VERTICAL', 3: 'FLOAT OFF', 4: 'EXTEND', 5: 'RETRACT', 6: 'FAULT' },
    suspension: { 0: 'NONE', 1: 'IN PUSH', 2: 'IN PULL' },
    tilt: { 1: 'TILTING IN', 2: 'TILT IN', 3: 'TILTING OUT', 4: 'TILT OUT', 5: 'HALF WAY', 6: 'STAND STILL' },
    inclinationStatus: { 1: 'INCLINATION IN IN PROGRESS', 2: 'INCLINATION IN', 3: 'INCLINATION OUT IN PROGRESS', 4: 'INCLINATED OUT', 5: 'HALF WAY', 6: 'STAND STILL', 7: 'TILTED IN', 8: 'TILTED OUT' },
};
function htdLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = HTD_MAPS[mapName] || {};
    if (Number.isFinite(n)) {
        if (Object.prototype.hasOwnProperty.call(map, n)) return map[n];
        if (Object.prototype.hasOwnProperty.call(map, String(n))) return map[String(n)];
    }
    return String(value);
}
const ACS_MAPS = {
    status: { 0: 'UNKNOWN', 1: 'ON', 2: 'OFF', 3: 'DISABLE' },
    calibration: { 0: 'UNKNOWN', 1: 'SEQ IN PROGRESS', 2: 'NOT CALIBRATED', 3: 'CALIBRATED', 10: 'MOVE UP TO CROWN', 11: 'MOVE DOWN TO TAG LOW' },
};
function acsLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = ACS_MAPS[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}
const CWK_MAPS = {
    status: { 0: 'NOT IN PARK POSITION', 1: 'PARK POSITION' },
    sourceCmd: { 0: 'UNKNOWN', 1: 'DCC', 2: 'RADIOCONTROL' },
    clamp: { 0: 'NONE', 1: 'OPENING', 2: 'CLOSING', 3: 'IS OPEN', 4: 'IS CLOSE', 5: 'FAULT' },
    carrier: { 1: 'STOP', 2: 'PARKING POSITION', 3: 'WORK POSITION', 4: 'LIFTING', 5: 'LOWERING', 6: 'FAULT' },
    indexer: { 1: 'UP', 2: 'DOWN', 3: 'FAULT' },
    kicker: { 1: 'EXTEND', 2: 'RETRACT', 3: 'FAULT' },
    skate: { 1: 'IDLE', 2: 'PARKING POSITION', 3: 'FWD CMD', 4: 'BWD CMD', 5: 'FAULT' },
    slide: { 1: 'IDLE', 2: 'PARKING POSITION', 3: 'FWD CMD', 4: 'BWD CMD', 5: 'FAULT' },
};
function cwkLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = CWK_MAPS[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}
const PCT_MAPS = {
    sequence: { 0: 'OFF', 1: 'MAKE-UP', 2: 'BREAK-OUT', 3: 'RESET', 4: 'FAULT' },
    operationMode: { 0: 'UNKNOWN', 1: 'NORMAL', 2: 'MANUAL' },
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    dollyWorkPark: { 0: 'NONE', 1: 'OUT PARK. POS', 2: 'MOVE WORK', 3: 'MOVE PARK', 4: 'IN PARK', 5: 'FAULT', 6: 'IN WORK' },
    clamp: { 0: 'NONE', 1: 'OPENING', 2: 'CLOSING', 3: 'IS OPEN', 4: 'IS CLOSE', 5: 'FAULT' },
    dollyUpDown: { 0: 'NO CMD ACTIVE', 1: 'MOVE UP', 2: 'MOVE DOWN' },
    spinnerRotation: { 0: 'NO CMD ACTIVE', 1: 'FULLY UP', 2: 'FULLY DOWN', 3: 'MAKE-UP', 4: 'BREAK-OUT', 10: 'SPINNER NOT MOUNTED' },
    spinnerGripper: { 0: 'NONE', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT', 10: 'SPINNER NOT MOUNTED' },
    spinnerFloating: { 0: 'OFF', 1: 'ON', 10: 'SPINNER NOT MOUNTED' },
};
function pctLabel(mapName, value, fallback = '---') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = PCT_MAPS[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}

function val(value, d = 0, fallback = '--') {
    if (value == null || value === '') return fallback;
    if (typeof value === 'number') return fmtNum(value, d);
    const n = Number(value);
    return Number.isFinite(n) ? fmtNum(n, d) : String(value);
}

function numericValue(value) {
    if (value == null || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function defaultMaxForUnit(unit) {
    const text = String(unit || '').toLowerCase();
    if (text.includes('%')) return 100;
    if (text.includes('rpm')) return 2500;
    if (text.includes('bar')) return 350;
    if (text.includes('degc') || text.includes('°c')) return 120;
    if (text.includes('v')) return 32;
    if (text.includes('l/h')) return 150;
    if (text.includes('l')) return 10000;
    if (text.includes('dan-m')) return 50000;
    if (text.includes('dan')) return 50000;
    if (text.includes('mm/sec')) return 300;
    return 100;
}

function barPercent(value, unit, max, min = 0) {
    const n = numericValue(value);
    if (n == null) return 0;
    const hi = Number(max || defaultMaxForUnit(unit));
    const lo = Number(min);
    if (!Number.isFinite(hi) || hi <= lo) return 0;
    return Math.max(0, Math.min(100, ((n - lo) / (hi - lo)) * 100));
}

function ValueBar({ value, unit, color = BLUE, max, min = 0 }) {
    const pct = barPercent(value, unit, max, min);
    return (
        <Box sx={{ mt: 1.35, height: 12, borderRadius: 99, bgcolor: 'rgba(148,163,184,.28)', overflow: 'hidden' }}>
            <Box sx={{ width: `${pct}%`, height: '100%', borderRadius: 99, bgcolor: color, boxShadow: pct > 0 ? `0 0 12px ${color}` : 'none', transition: 'width .25s ease' }} />
        </Box>
    );
}

function StatusBox({ label, value }) {
    return (
        <Box sx={{ minWidth: 130 }}>
            <Typography variant="caption" fontWeight={900} color="text.secondary">{label}</Typography>
            <Box sx={{ mt: 0.75, border: '1px solid rgba(148,163,184,.35)', bgcolor: '#334155', borderRadius: 0.75, px: 2, py: 1, textAlign: 'center', minHeight: 36 }}>
                <Typography fontWeight={900} color="#94a3b8">{value ?? '---'}</Typography>
            </Box>
        </Box>
    );
}

function RuntimeBox({ label, value, unit = 'HRS', blue = false }) {
    const n = numericValue(value);
    const display = n == null ? (value ?? '---') : val(value, 2, '0.00');
    return (
        <Box sx={{ textAlign: 'right', minWidth: 150 }}>
            <Typography variant="caption" fontWeight={900}>{label}</Typography>
            <Typography fontWeight={900} sx={{ fontSize: 24, color: blue ? BLUE : '#fff', whiteSpace: 'nowrap' }}>{display}{n != null && unit ? <Typography component="span" color="text.secondary" fontSize={13} fontWeight={900}> {unit}</Typography> : null}</Typography>
        </Box>
    );
}

function TopStatus({ left = [], right = [] }) {
    return (
        <Paper sx={{ p: 1.8, mb: 2, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.22)', borderRadius: 0.75, overflow: 'hidden' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} useFlexGap flexWrap="wrap">
                <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap" divider={<Box sx={{ display: { xs: 'none', md: 'block' }, width: 1, height: 46, bgcolor: 'rgba(148,163,184,.2)' }} />}>
                    {left.map((item) => <StatusBox key={item.label} {...item} />)}
                </Stack>
                <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap" sx={{ ml: 'auto' }}>
                    {right.map((item) => <RuntimeBox key={item.label} {...item} />)}
                </Stack>
            </Stack>
        </Paper>
    );
}

function Section({ title, children }) {
    return (
        <Box sx={{ mb: 2.25 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 1.4, mb: 1, color: '#dbeafe' }}>{title}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
                {children}
            </Box>
        </Box>
    );
}

function MetricTile({ label, value, unit, color = BLUE, note, max, min = 0 }) {
    return (
        <Paper sx={{ p: 1.8, minHeight: 112, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 0.6, fontSize: 14, color: '#dbeafe' }}>{label}</Typography>
            <Stack direction="row" alignItems="baseline" spacing={0.75} mt={1.6}>
                <Typography fontWeight={900} sx={{ color, fontSize: 34, lineHeight: 1 }}>{value}</Typography>
                <Typography fontWeight={900} color="#dbeafe">{unit}</Typography>
            </Stack>
            <ValueBar value={value} unit={unit} color={color} max={max} min={min} />
            {note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{note}</Typography>}
        </Paper>
    );
}

function FilterTile({ label, value }) {
    const text = hpuLabel('filter', value, 'CLOGGED');
    const ok = text === 'OK';
    return (
        <Box sx={{ bgcolor: '#07111f', border: `1px solid ${ok ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)'}`, borderRadius: 0.75, p: 1, minHeight: 58, textAlign: 'center' }}>
            <Typography fontWeight={900} sx={{ fontSize: 12 }}>{label}</Typography>
            <Typography fontWeight={900} sx={{ color: ok ? GREEN : '#ff3b4f', fontSize: 13, mt: 0.5 }}>{text}</Typography>
        </Box>
    );
}

function OilFiltersPanel({ g }) {
    const filters = [1, 2, 3, 4, 5, 6, 7, 8];
    return (
        <Paper sx={{ p: 1.6, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 1.4, mb: 1.25, color: '#dbeafe' }}>OIL FILTERS</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 1 }}>
                {filters.map((n) => <FilterTile key={n} label={`FILTER ${n}`} value={g[`oil_filter_${n}`]} />)}
            </Box>
        </Paper>
    );
}

function PumpCard({ title, status, flow, press }) {
    return (
        <Box sx={{ bgcolor: '#0f172a', border: '1px solid rgba(62,166,255,.12)', borderRadius: 0.75, p: 1.25, minHeight: 112 }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
                <Typography fontWeight={900}>{title}</Typography>
                <Box sx={{ border: '1px solid rgba(148,163,184,.45)', borderRadius: 0.5, minWidth: 74, px: 1, py: 0.25, textAlign: 'center' }}>
                    <Typography color="text.secondary" fontWeight={900} sx={{ fontSize: 12 }}>{hpuLabel('pump', status)}</Typography>
                </Box>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                <Box>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>FLOW</Typography>
                    <Typography fontWeight={900}>{val(flow, 2, '0.00')} %</Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>PRESS</Typography>
                    <Typography fontWeight={900}>{val(press, 2, '0.00')} bar</Typography>
                </Box>
            </Box>
        </Box>
    );
}

function HydraulicPumpsPanel({ g }) {
    return (
        <Paper sx={{ p: 1.6, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 1.4, mb: 1.25, color: '#dbeafe' }}>HYDRAULIC PUMPS</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.25 }}>
                <PumpCard title="PUMP-3 PDW" status={g.pdw_pump_status ?? g.pump_3_status} flow={g.flow ?? g.pdw_flow ?? g.pdw_pump_flow} press={g.pressure ?? g.pdw_press ?? g.pdw_pump_press} />
                <PumpCard title="HTD PUMP-2" status={g.htd_pump_2_status ?? g.htd_pump1_status} flow={g.htd_pump_2_flow ?? g.htd_pump1_flow} press={g.htd_pump_2_press ?? g.htd_pump1_press} />
                <PumpCard title="HTD PUMP-4" status={g.htd_pump_4_status ?? g.htd_pump2_status ?? g.htd_pump4_status} flow={g.htd_pump_4_flow ?? g.htd_pump2_flow ?? g.htd_pump4_flow} press={g.htd_pump_4_press ?? g.htd_pump2_press ?? g.htd_pump4_press} />
            </Box>
        </Paper>
    );
}

function StatusTile({ label, value }) {
    return (
        <Paper sx={{ p: 1.8, minHeight: 92, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1, display: 'grid', placeItems: 'center' }}>
            <Box sx={{ width: '100%' }}>
                <Typography fontWeight={900} sx={{ letterSpacing: 0.6, fontSize: 14, textAlign: 'center' }}>{label}</Typography>
                <Box sx={{ mt: 1.5, border: '1px solid rgba(148,163,184,.35)', bgcolor: '#334155', borderRadius: 0.75, py: 1, textAlign: 'center' }}>
                    <Typography fontWeight={900} color="text.secondary">{value ?? '---'}</Typography>
                </Box>
            </Box>
        </Paper>
    );
}
function TrendPanel({ rigId, active }) {
    const channels = TREND_CHANNELS[active] || TREND_CHANNELS.cat;
    const strips = useMemo(() => [{
        title: TREND_LABELS[active] || 'ENGINE',
        pens: channels.map((channelId, i) => ({ channelId, color: [BLUE, ORANGE, GREEN, PURPLE][i % 4], min: 0, max: 100, enabled: true })),
    }], [active, channels]);

    return (
        <Paper sx={{ height: 'calc(100vh - 245px)', minHeight: 650, p: 1.5, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1, display: 'flex', flexDirection: 'column' }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 2, mb: 1 }}> {TREND_LABELS[active]} TRENDS</Typography>
            <Box sx={{ flex: 1, minHeight: 0 }}>
                <EdrView
                    key={`equip-trend-v5-${active}`}
                    mode="compact"
                    rigId={rigId}
                    storageKey={`crmf-equip-v5-${active}-${rigId}`}
                    defaultStrips={strips}
                    channels={channels}
                    timeWindowLabel="5m"
                />
            </Box>
        </Paper>
    );
}

function CatPage({ d }) {
    const g = d.cat_engine || {};
    const accelPedal = g.accel_pedal ?? g.accelerator_pedal ?? g.accel_pedal_position ?? g.throttle_position ?? g.throttle ?? g.acc_pedal;
    const totalFuelUsed = g.total_fuel_used ?? g.fuel_used_total ?? g.total_fuel ?? g.total_fuel_consumed ?? g.fuel_consumed ?? g.fuel_consumption_total;
    return <>
        <TopStatus left={[{ label: 'ENGINE STATUS', value: catLabel('status', g.status) }, { label: 'SOURCE CMD', value: catLabel('sourceCmd', g.source_cmd) }]} right={[{ label: 'RUN HOURS', value: g.run_hours }, { label: 'TOTAL ENGINE HOURS', value: g.total_hours, blue: true }]} />
        <Section title="PERFORMANCE">
            <MetricTile label="ENGINE SPEED" value={val(g.rpm)} unit="RPM" />
            <MetricTile label="ENGINE LOAD" value={val(g.load)} unit="%" color={GREEN} />
            <MetricTile label="ACCEL PEDAL" value={val(accelPedal)} unit="%" color={PURPLE} />
            <MetricTile label="FUEL RATE" value={val(g.fuel_rate, 1)} unit="L/h" color="#22d3ee" />
        </Section>
        <Section title="FUEL & ELECTRICAL">
            <MetricTile label="FUEL PRESSURE" value={val(g.fuel_pressure, 1)} unit="bar" />
            <MetricTile label="FUEL TEMP" value={val(g.fuel_temp)} unit="degC" color={ORANGE} />
            <MetricTile label="TOTAL FUEL USED" value={val(totalFuelUsed)} unit="L" color={PURPLE} note="Lifetime consumption" />
            <MetricTile label="BATTERY VOLTAGE" value={val(g.battery_voltage, 1)} unit="V" color={GREEN} note="DC bus potential" />
        </Section>
        <Section title="LUBRICATION & COOLING">
            <MetricTile label="OIL PRESSURE" value={val(g.oil_pressure)} unit="bar" color={YELLOW} />
            <MetricTile label="COOLANT TEMP" value={val(g.coolant_temp)} unit="degC" color={ORANGE} />
            <MetricTile label="COOLANT LEVEL" value={val(g.coolant_level)} unit="%" color="#22d3ee" />
        </Section>
    </>;
}

function HpuPage({ d }) {
    const g = d.hpu || {};
    return <>
        <TopStatus
            left={[
                { label: 'SYSTEM STATUS', value: hpuLabel('status', g.status) },
                { label: 'OPERATING MODE', value: hpuLabel('opMode', g.operating_mode ?? g.mode) },
                { label: 'PILOT STATUS', value: hpuLabel('pilotStatus', g.pilot_status) },
                { label: 'GATE VALVE', value: hpuLabel('gateValve', g.gate_valve) },
            ]}
            right={[{ label: 'RUN HOURS', value: g.run_hours, blue: true }]}
        />
        <Section title="PRESSURES">
            <MetricTile label="DISCHARGE PRESS" value={val(g.discharge_pressure ?? g.dis_press ?? g.pressure, 2)} unit="bar" />
            <MetricTile label="AUX PRESSURE" value={val(g.aux_pressure ?? g.aux_press, 2)} unit="bar" color={PURPLE} />
            <MetricTile label="PILOT LS PRESS" value={val(g.pilot_pressure ?? g.pilot_ls_press, 2)} unit="bar" color="#22d3ee" />
        </Section>
        <Section title="HYDRAULIC OIL">
            <MetricTile label="OIL TEMP" value={val(g.oil_temp ?? g.temperature, 2)} unit="degC" color={ORANGE} />
            <MetricTile label="OIL LEVEL" value={val(g.oil_level, 2)} unit="%" color="#22d3ee" />
            <StatusTile label="TEMP STATUS" value={hpuLabel('oilTemp', g.temp_status ?? g.oil_temp_status)} />
            <StatusTile label="LEVEL STATUS" value={hpuLabel('oilLevel', g.level_status ?? g.oil_level_status)} />
        </Section>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '0.95fr 1.35fr' }, gap: 1.5, mt: 1 }}>
            <OilFiltersPanel g={g} />
            <HydraulicPumpsPanel g={g} />
        </Box>
    </>;
}
function ListRow({ label, value }) {
    return (
        <Box sx={{ bgcolor: '#0f172a', borderRadius: 0.75, px: 1.25, py: 1, minHeight: 47, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography fontWeight={900}>{label}</Typography>
            <Box sx={{ border: '1px solid rgba(148,163,184,.45)', borderRadius: 0.5, minWidth: 106, px: 1, py: 0.35, textAlign: 'center' }}>
                <Typography color="text.secondary" fontWeight={900} sx={{ fontSize: 12 }}>{value ?? '---'}</Typography>
            </Box>
        </Box>
    );
}

function ListPanel({ title, rows }) {
    return (
        <Paper sx={{ p: 1.6, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 1.4, mb: 1.25, color: '#dbeafe' }}>{title}</Typography>
            <Stack spacing={1}>
                {rows.map((row) => <ListRow key={row.label} {...row} />)}
            </Stack>
        </Paper>
    );
}

function ReadoutPanel({ title, value, unit, color = BLUE, subtitle, max, min = 0 }) {
    return (
        <Paper sx={{ p: 1.7, minHeight: 120, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 0.6, fontSize: 14 }}>{title}</Typography>
            <Typography fontWeight={900} sx={{ mt: 1.4, color, fontSize: 36, lineHeight: 1 }}>{value}<Typography component="span" sx={{ ml: 0.6, color: '#dbeafe', fontSize: 16, fontWeight: 900 }}>{unit}</Typography></Typography>
            {subtitle && <Typography variant="caption" sx={{ display: 'block', mt: 1.2 }}>{subtitle}</Typography>}
            <ValueBar value={value} unit={unit} color={color} max={max} min={min} />
        </Paper>
    );
}

function DarkValueBox({ label, value, unit, color = BLUE, max, min = 0 }) {
    return (
        <Box sx={{ bgcolor: '#0f172a', borderRadius: 0.75, p: 1.5, minHeight: 112, display: 'grid', alignContent: 'center', textAlign: 'center' }}>
            <Typography fontWeight={900} sx={{ color, fontSize: 30, lineHeight: 1 }}>{value}</Typography>
            <Typography color="text.secondary">{label} {unit ? `(${unit})` : ''}</Typography>
            <ValueBar value={value} unit={unit} color={color} max={max} min={min} />
        </Box>
    );
}

function TankVolumesPanel({ fluid }) {
    const tanks = [1, 2, 3, 4];
    return (
        <Paper sx={{ p: 1.7, bgcolor: '#0f172a', borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography sx={{ fontSize: 20, mb: 1.5 }}>MUD TANK INDIVIDUAL VOLUMES</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
                {tanks.map((n) => <DarkValueBox key={n} label={`TANK ${n}`} value={val(fluid[`tank_${n}`] ?? fluid[`pit_volume_${n}`], 2, '0.00')} unit="m3" color="#fff" max={120} />)}
            </Box>
        </Paper>
    );
}

function ClampCard({ title, color, pressure, force, extra }) {
    const pressureValue = val(pressure, 2, '0.00');
    const forceValue = val(force, 2, '0.00');
    return (
        <Box sx={{ bgcolor: '#0f172a', borderRadius: 0.75, p: 1.5, minHeight: 150 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.5}>
                <Typography fontWeight={900} sx={{ color, fontSize: 20 }}>{title}</Typography>
                <Typography color="text.secondary" fontWeight={900}>{extra ?? '---'}</Typography>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                <Box>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>PRESSURE (bar)</Typography>
                    <Typography fontWeight={900} sx={{ fontSize: 28, color }}>{pressureValue}</Typography>
                    <ValueBar value={pressureValue} unit="bar" color={color} max={350} />
                </Box>
                <Box>
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>FORCE (daN)</Typography>
                    <Typography fontWeight={900} sx={{ fontSize: 28, color }}>{forceValue}</Typography>
                    <ValueBar value={forceValue} unit="daN" color={color} max={50000} />
                </Box>
            </Box>
        </Box>
    );
}

function ClampDetailsPanel({ g }) {
    return (
        <Paper sx={{ p: 1.6, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography fontWeight={900} sx={{ letterSpacing: 1.4, mb: 1.25, color: '#dbeafe' }}>CLAMP DETAILS</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
                <ClampCard title="UP CLAMP" color={BLUE} pressure={g.clamp_up_pressure ?? g.up_clamp_pressure} force={g.clamp_up_force ?? g.up_clamp_force} extra={pctLabel('clamp', g.clamp_up_status ?? g.clamp_upper_status)} />
                <ClampCard title="LOW CLAMP" color={PURPLE} pressure={g.clamp_low_pressure ?? g.low_clamp_pressure} force={g.clamp_low_force ?? g.low_clamp_force} extra={pctLabel('clamp', g.clamp_low_status)} />
            </Box>
        </Paper>
    );
}

function htdWorkingTime(g) {
    const hours = g.working_hours;
    const minutes = g.working_minutes;
    if (hours != null || minutes != null) return `${val(hours, 0, '0')}h ${val(minutes, 0, '0')}m`;
    return g.working_time ?? g.run_hours;
}

function HtdPage({ d }) {
    const g = d.htd || {};
    return <>
        <TopStatus
            left={[{ label: 'STATUS', value: htdLabel('status', g.status) }, { label: 'WORK MODE', value: htdLabel('workMode', g.work_mode) }, { label: 'GEAR SELECTION', value: htdLabel('gearSelection', g.gear_selection ?? g.gear_status) }, { label: 'ROTATION', value: htdLabel('rotation', g.rotation_status ?? g.rotation) }]}
            right={[{ label: 'WORKING TIME', value: htdWorkingTime(g), unit: '', blue: true }]}
        />
        <Section title="ROTARY & MOTION">
            <MetricTile label="TOP DRIVE RPM" value={val(g.rpm)} unit="RPM" color={BLUE} note={`REQ ${val(g.rpm_req ?? g.rpm_request, 0, '0')} - CMD ${val(g.rpm_cmd ?? g.rpm_command, 0, '0')}`} />
            <MetricTile label="HTD TORQUE" value={val(g.torque, 2)} unit="daN-m" color={YELLOW} note={`REQ ${val(g.torque_req ?? g.torque_request, 0, '0')} - CMD ${val(g.torque_cmd ?? g.torque_command, 0, '0')}`} />
            <MetricTile label="VERTICAL SPEED" value={val(g.v_speed ?? g.vertical_speed, 2)} unit="mm/sec" color={GREEN} />
            <MetricTile label="INCLINATION" value={val(g.inclination, 1)} unit="%" color={PURPLE} />
        </Section>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr 1fr' }, gap: 1.5 }}>
            <ListPanel title="MECHANISMS & LINKS" rows={[{ label: 'ELEVATOR', value: htdLabel('elevator', g.elevator_status) }, { label: 'IBOP', value: htdLabel('ibop', g.ibop_status) }, { label: 'BRAKE', value: htdLabel('brake', g.brake ?? g.brake_status) }, { label: 'LINK ROTATION', value: htdLabel('linkRotation', g.link_rotation_status ?? g.link_rotation) }]} />
            <ListPanel title="DRIVE SYSTEM" rows={[{ label: 'GEAR SELECTION', value: htdLabel('gearSelection', g.gear_selection ?? g.gear_status) }, { label: 'SUSPENSION', value: htdLabel('suspension', g.suspension ?? g.suspension_status) }, { label: 'LUBE', value: htdLabel('lube', g.lube_status) }]} />
            <ListPanel title="POSITIONING" rows={[{ label: 'LINK TILT', value: htdLabel('linkTilt', g.link_tilt_status ?? g.tilt_status_db65 ?? g.link_tilt) }, { label: 'TILT', value: htdLabel('tilt', g.tilt_status ?? g.tilt_status_db65) }, { label: 'INCLINATION STATUS', value: htdLabel('inclinationStatus', g.inclination_status) }, { label: 'INCLINATION', value: val(g.inclination, 1, '---') }]} />
        </Box>
    </>;
}

function MudPage({ d }) {
    const g = d.mudpump || {}; const fl = d.fluid || {};
    return <>
        <Box sx={{ mb: 2 }}><Typography variant="h5" fontWeight={900} color={BLUE}>Pump Systems</Typography></Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(5, minmax(0, 1fr))' }, gap: 1.5, mb: 3 }}>
            <ReadoutPanel title="PUMP SPM" value={val(g.spm)} unit="SPM" color="#f472b6" max={200} />
            <ReadoutPanel title="PRESSURE" value={val(g.pressure)} unit="bar" color="#ff4d57" max={500} />
            <ReadoutPanel title="FLOW OUT" value={val(g.flow_out ?? g.flow_out_percentage)} unit="%" color={GREEN} max={100} />
            <ReadoutPanel title="INLET FLOW" value={val(g.flow_in)} unit="Lt/min" color="#3b82f6" max={3000} />
            <ReadoutPanel title="TOTAL STROKES" value={val(g.total_strokes)} unit="ct" color={PURPLE} subtitle="Lifetime count" max={50000} />
        </Box>
        <Box sx={{ mb: 2 }}><Typography variant="h5" fontWeight={900} color={BLUE}>Tank & Fluid Systems</Typography></Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5, mb: 1.5 }}>
            <ReadoutPanel title="ACTIVE VOLUME" value={val(fl.total_tank_volume, 1, '0.0')} unit="m3" color="#0ea5e9" max={500} />
            <ReadoutPanel title="VOLUME GAIN/LOSS" value={val(fl.tank_gain_loss, 2, '0.00')} unit="m3" color={GREEN} subtitle="Gaining" min={-50} max={50} />
            <ReadoutPanel title="TRIP TANK VOLUME" value={val(fl.trip_tank, 1, '0.0')} unit="m3" color="#6366f1" max={50} />
            <ReadoutPanel title="TRIP GAIN/LOSS" value={val(fl.trip_tank_gain_loss, 1, '0.0')} unit="%" color={GREEN} max={100} />
        </Box>
        <TankVolumesPanel fluid={fl} />
    </>;
}

function AcsPage({ d }) {
    const g = d.acs || {};
    return <>
        <TopStatus left={[{ label: 'SYSTEM STATUS', value: acsLabel('status', g.status) }, { label: 'CALIBRATION', value: acsLabel('calibration', g.calibration) }]} right={[]} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '0.9fr 1.9fr' }, gap: 1.5, mb: 1.5 }}>
            <Paper sx={{ p: 1.5, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
                <Typography sx={{ color: '#93b4d8', mb: 1.5, fontSize: 18 }}>BLOCK POSITION</Typography>
                <DarkValueBox label="" value={val(g.block_position, 0, '0')} unit="mm" color={BLUE} />
            </Paper>
            <Paper sx={{ p: 1.5, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
                <Typography sx={{ color: '#93b4d8', mb: 1.5, fontSize: 18 }}>TAG POSITIONS</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
                    <DarkValueBox label="UPPER TAG" value={val(g.upper_tag, 0, '0')} unit="mm" />
                    <DarkValueBox label="LOWER TAG" value={val(g.lower_tag, 0, '0')} unit="mm" />
                </Box>
            </Paper>
        </Box>
        <Paper sx={{ p: 1.5, bgcolor: PANEL, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1, maxWidth: 640 }}>
            <Typography sx={{ color: '#93b4d8', mb: 1.5, fontSize: 18 }}>SAVER THRESHOLDS</Typography>
            <Stack spacing={1.25}>
                {[{ label: 'CROWNSAVER', value: g.crownsaver, color: '#ff4d57' }, { label: 'FLOORSAVER', value: g.floorsaver, color: YELLOW }, { label: 'BOTTOMSAVER', value: g.bottomsaver, color: BLUE }].map((row) => (
                    <Box key={row.label} sx={{ bgcolor: '#0f172a', borderRadius: 0.75, px: 2, py: 1.75, display: 'flex', justifyContent: 'space-between' }}>
                        <Typography sx={{ color: '#93b4d8', fontSize: 20 }}>{row.label}</Typography>
                        <Typography fontWeight={900} sx={{ color: row.color, fontSize: 22 }}>{val(row.value, 0, '0')} mm</Typography>
                    </Box>
                ))}
            </Stack>
        </Paper>
    </>;
}

function CatwalkPage({ d }) {
    const g = d.cwk || {};
    return <>
        <TopStatus left={[{ label: 'GLOBAL STATUS', value: cwkLabel('status', g.status) }, { label: 'SOURCE CMD', value: cwkLabel('sourceCmd', g.source_cmd) }, { label: 'CLAMP', value: cwkLabel('clamp', g.clamp_status) }, { label: 'CARRIER', value: cwkLabel('carrier', g.carrier_status) }]} right={[]} />
        <Section title="CLAMP MEASUREMENTS">
            <MetricTile label="CLAMP PRESSURE" value={val(g.clamp_pressure, 2, '---')} unit="bar" />
            <MetricTile label="CLAMP FORCE" value={val(g.clamp_force, 2, '---')} unit="daN" color={PURPLE} />
        </Section>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1.5 }}>
            <ListPanel title="INDEXERS & KICKERS" rows={[{ label: 'INDEXER DX', value: cwkLabel('indexer', g.indexer_dx) }, { label: 'INDEXER SX', value: cwkLabel('indexer', g.indexer_sx) }, { label: 'KICKERS DX', value: cwkLabel('kicker', g.kickers_dx) }, { label: 'KICKERS SX', value: cwkLabel('kicker', g.kickers_sx) }]} />
            <ListPanel title="MOTION & HANDLING" rows={[{ label: 'SKATE', value: cwkLabel('skate', g.skate) }, { label: 'SLIDE', value: cwkLabel('slide', g.slide) }, { label: 'CARRIER', value: cwkLabel('carrier', g.carrier_status) }, { label: 'CLAMP STATUS', value: cwkLabel('clamp', g.clamp_status) }]} />
        </Box>
    </>;
}

function PctPage({ d }) {
    const g = d.pct || {};
    return <>
        <TopStatus left={[{ label: 'SYSTEM STATUS', value: pctLabel('status', g.status) }, { label: 'SEQUENCE', value: pctLabel('sequence', g.sequence, 'OFF') }, { label: 'LOW CLAMP STATUS', value: pctLabel('clamp', g.clamp_low_status, 'NONE') }, { label: 'UPPER CLAMP STATUS', value: pctLabel('clamp', g.clamp_up_status ?? g.clamp_upper_status, 'NONE') }]} right={[]} />
        <Section title="TORQUE & ROTATION">
            <MetricTile label="MAKEUP TORQUE" value={val(g.makeup_torque, 2, '---')} unit="daN-m" />
            <MetricTile label="LAST MAKEUP" value={val(g.last_makeup_torque, 2, '---')} unit="daN-m" color={YELLOW} />
            <MetricTile label="SPINNER MU TORQUE" value={val(g.spinner_torque ?? g.spinner_makeup_torque, 2, '---')} unit="daN-m" color={GREEN} />
            <MetricTile label="SPINNER BO TORQUE" value={val(g.spinner_bo_torque, 2, '---')} unit="daN-m" color={PURPLE} />
            <MetricTile label="ROTATION MU PRESS" value={val(g.rotation_makeup_pressure, 2, '---')} unit="bar" color="#22d3ee" />
            <MetricTile label="ROTATION BO PRESS" value={val(g.rotation_bo_pressure, 2, '---')} unit="bar" color={ORANGE} />
        </Section>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.15fr 0.85fr' }, gap: 1.5 }}>
            <ClampDetailsPanel g={g} />
            <ListPanel title="DOLLY & SPINNER" rows={[{ label: 'DOLLY DIRECTION', value: pctLabel('dollyUpDown', g.dolly_direction) }, { label: 'DOLLY STATUS', value: pctLabel('dollyWorkPark', g.dolly_status) }, { label: 'SPINNER ROTATION', value: pctLabel('spinnerRotation', g.spinner_rotation_status ?? g.spinner_rotation) }, { label: 'SPINNER GRIPPER', value: pctLabel('spinnerGripper', g.spinner_gripper_status ?? g.spinner_gripper) }, { label: 'SPINNER FLOATING', value: pctLabel('spinnerFloating', g.spinner_floating) }]} />
        </Box>
    </>;
}
const PAGE = { cat: CatPage, hpu: HpuPage, htd: HtdPage, mud: MudPage, acs: AcsPage, catwalk: CatwalkPage, pct: PctPage };

export default function EquipmentPanel({ rigId }) {
    const { data, loading, error } = useRigData();
    const activeKey = `crmf-equip-active-${rigId}`;
    const [active, setActive] = useState(() => {
        try {
            const saved = localStorage.getItem(activeKey);
            return EQUIP_TABS.some((tab) => tab.key === saved) ? saved : 'cat';
        } catch (e) {
            return 'cat';
        }
    });
    const Page = PAGE[active] || CatPage;
    const safe = data || {};

    useEffect(() => {
        try { localStorage.setItem(activeKey, active); } catch (e) { /* best effort */ }
    }, [activeKey, active]);

    return (
        <Box sx={{ height: '100%', bgcolor: BG, overflow: 'auto', p: 1.25 }}>
            <Paper sx={{ p: 1.25, mb: 1.5, bgcolor: '#1f2a3d', borderColor: 'rgba(148,163,184,.25)', borderRadius: 1 }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(7, 1fr)' }, gap: 1.25 }}>
                    {EQUIP_TABS.map(({ key, label, icon: Icon }) => (
                        <Button
                            key={key}
                            onClick={() => setActive(key)}
                            startIcon={<Icon />}
                            variant={active === key ? 'contained' : 'text'}
                            sx={{ height: 48, fontWeight: 900, fontSize: 16, color: active === key ? '#06111f' : '#d1d5db', bgcolor: active === key ? BLUE : 'transparent', '&:hover': { bgcolor: active === key ? BLUE : 'rgba(255,255,255,0.06)' } }}
                        >
                            {label}
                        </Button>
                    ))}
                </Box>
            </Paper>

            {error && <Alert severity="warning" sx={{ mb: 1 }}>{String(error)}</Alert>}
            {loading && !data && <Typography color="text.secondary" sx={{ mb: 1 }}>Loading...</Typography>}

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 500px' }, gap: 1.5, alignItems: 'stretch' }}>
                <Box sx={{ minWidth: 0 }}>
                    <Page d={safe} />
                </Box>
                <TrendPanel key={`equipment-trend-${rigId}-${active}`} rigId={rigId} active={active} />
            </Box>
        </Box>
    );
}


















import React, { useEffect, useMemo, useState } from 'react';
import {
    Box, Paper, Typography, Stack, Chip, Button,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    TextField,
} from '@mui/material';
import { Speed, ShowChart, DeviceThermostat, Build, Tune, Timeline } from '@mui/icons-material';
import { useRigData } from '../../../context/RigDataContext';
import { api } from '../../../api';

const BG = '#071225';
const PANEL = '#263447';
const BORDER = '#344963';
const BLUE = '#29b6ff';
const GREEN = '#62cf6d';
const YELLOW = '#ffb300';
const ORANGE = '#ff9d13';
const TEXT = '#eaf3ff';
const MUTED = '#b5c5dd';
const RED = '#ff5252';

const dash = '--';
const fmt = (v, d = 1) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : dash;
};
const num = (...values) => {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
};
const firstValue = (source, paths) => {
    for (const path of paths) {
        if (source?.[path] != null && source?.[path] !== '') return source[path];
        const nested = String(path).split('.').reduce((cur, key) => (cur && cur[key] != null ? cur[key] : undefined), source);
        if (nested != null && nested !== '') return nested;
    }
    return undefined;
};
const rowTime = (row) => Number(row?.t ?? row?.timestamp) || Date.parse(row?.time || row?.name || '') || Date.now();

const EFF_CONSTANTS = {
    engineRatedKw: 800,
    htdPumpRatedLMin: 420,
    pdwPumpRatedLMin: 200,
    pumpVolEff: 0.95,
};
const EFF_RANGES = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '30m', ms: 30 * 60 * 1000 },
    { label: '1H', ms: 60 * 60 * 1000 },
    { label: '6H', ms: 6 * 60 * 60 * 1000 },
    { label: '12H', ms: 12 * 60 * 60 * 1000 },
    { label: '24H', ms: 24 * 60 * 60 * 1000 },
];
const EFF_METRICS = [
    'mudpump.pressure', 'mudpump.flow_in', 'mudpump.flow', 'htd.torque', 'htd.rpm',
    'drilling.torque', 'drilling.rpm', 'cat_engine.fuel_rate', 'cat_engine.fuel',
    'cat_engine.shaft_power', 'cat_engine.load', 'hpu.ls_margin', 'hpu.pressure',
    'hpu.flow', 'hpu.pdw_flow', 'hpu.pdw_press', 'hpu.pdw_pump_flow', 'hpu.pdw_pump_press',
    'hpu.htd_pump_2_flow', 'hpu.htd_pump_2_press', 'hpu.htd_pump_4_flow', 'hpu.htd_pump_4_press',
];

function deriveEfficiency(source = {}) {
    const pressureBar = num(firstValue(source, ['mudpump.pressure']));
    const flowLMin = num(firstValue(source, ['mudpump.flow_in', 'mudpump.flow']));
    const mudPumpKw = pressureBar > 0 && flowLMin > 0 ? (pressureBar * flowLMin) / 600 : 0;

    const torqueDaNm = num(firstValue(source, ['htd.torque', 'drilling.torque']));
    const rpm = num(firstValue(source, ['htd.rpm', 'drilling.rpm']));
    const htdKw = torqueDaNm && rpm ? ((torqueDaNm * 10) * rpm) / 9550 : 0;

    const pdwPress = num(firstValue(source, ['hpu.pressure', 'hpu.pdw_press', 'hpu.pdw_pump_press']));
    const pdwFlowRaw = num(firstValue(source, ['hpu.flow', 'hpu.pdw_flow', 'hpu.pdw_pump_flow']));
    const pdwFlowLMin = pdwFlowRaw > 0 && pdwFlowRaw <= 100 ? (pdwFlowRaw / 100) * EFF_CONSTANTS.pdwPumpRatedLMin * EFF_CONSTANTS.pumpVolEff : pdwFlowRaw;
    const pdwKw = pdwPress > 0 && pdwFlowLMin > 0 ? (pdwPress * pdwFlowLMin) / 600 : 0;

    const htdPump2FlowRaw = num(firstValue(source, ['hpu.htd_pump_2_flow']));
    const htdPump2Press = num(firstValue(source, ['hpu.htd_pump_2_press']));
    const htdPump2FlowLMin = htdPump2FlowRaw > 0 && htdPump2FlowRaw <= 100 ? (htdPump2FlowRaw / 100) * EFF_CONSTANTS.htdPumpRatedLMin * EFF_CONSTANTS.pumpVolEff : htdPump2FlowRaw;
    const htdPump2Kw = htdPump2Press > 0 && htdPump2FlowLMin > 0 ? (htdPump2Press * htdPump2FlowLMin) / 600 : 0;

    const htdPump4FlowRaw = num(firstValue(source, ['hpu.htd_pump_4_flow']));
    const htdPump4Press = num(firstValue(source, ['hpu.htd_pump_4_press']));
    const htdPump4FlowLMin = htdPump4FlowRaw > 0 && htdPump4FlowRaw <= 100 ? (htdPump4FlowRaw / 100) * EFF_CONSTANTS.htdPumpRatedLMin * EFF_CONSTANTS.pumpVolEff : htdPump4FlowRaw;
    const htdPump4Kw = htdPump4Press > 0 && htdPump4FlowLMin > 0 ? (htdPump4Press * htdPump4FlowLMin) / 600 : 0;

    const fuel = num(firstValue(source, ['cat_engine.fuel_rate', 'cat_engine.fuel']));
    const engineMeasured = num(firstValue(source, ['cat_engine.shaft_power']));
    const engineLoad = num(firstValue(source, ['cat_engine.load']));
    const enginePower = engineMeasured || (engineLoad > 0 ? (engineLoad / 100) * EFF_CONSTANTS.engineRatedKw : 0);
    const systemPower = mudPumpKw + pdwKw + htdPump2Kw + htdPump4Kw;
    const conversion = enginePower > 0 ? (systemPower / enginePower) * 100 : null;
    const lsMarginRaw = firstValue(source, ['hpu.ls_margin']);

    return {
        pressureBar, flowLMin, mudPumpKw, htdKw, pdwKw, htdPump2Kw, htdPump4Kw,
        fuel, systemPower, enginePower, conversion,
        lsMargin: lsMarginRaw == null ? null : Number(lsMarginRaw),
    };
}

function SectionTitle({ icon, title, right }) {
    return (
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={1}>{icon}<Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 22 }}>{title}</Typography></Stack>
            {right}
        </Stack>
    );
}

function KpiTile({ label, value, unit, color = BLUE, border = BORDER }) {
    return (
        <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: border, p: 2, minHeight: 104, borderRadius: 1 }}>
            <Typography sx={{ color: TEXT, textTransform: 'uppercase', letterSpacing: 1.6, fontSize: 16 }}>{label}</Typography>
            <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ mt: 1.1 }}>
                <Typography sx={{ color, fontWeight: 900, fontSize: 30, lineHeight: 1 }}>{value}</Typography>
                {unit ? <Typography sx={{ color: TEXT, fontWeight: 900 }}>{unit}</Typography> : null}
            </Stack>
        </Paper>
    );
}

function SmallMetric({ label, value }) {
    return (
        <Paper variant="outlined" sx={{ bgcolor: '#172235', borderColor: '#243751', p: 2, minHeight: 86, borderRadius: 1 }}>
            <Typography sx={{ color: TEXT, textTransform: 'uppercase', letterSpacing: 1.5 }}>{label}</Typography>
            <Typography sx={{ color: TEXT, fontWeight: 900, fontSize: 24, mt: 1 }}>{value}</Typography>
        </Paper>
    );
}

function StatusChip({ label, color }) {
    return <Chip size="small" label={label} variant="outlined" sx={{ color, borderColor: color, bgcolor: `${color}18`, fontWeight: 900, fontSize: 14 }} />;
}

function TrendSvg({ points, lines }) {
    const width = 900;
    const height = 260;
    const left = 44;
    const right = 12;
    const top = 16;
    const bottom = 30;
    const drawW = width - left - right;
    const drawH = height - top - bottom;
    const valid = (points || []).filter((p) => Number.isFinite(Number(p.timestamp)));
    const minT = Math.min(...valid.map((p) => p.timestamp), Date.now() - 60000);
    const maxT = Math.max(...valid.map((p) => p.timestamp), Date.now());
    const toX = (t) => left + ((t - minT) / ((maxT - minT) || 1)) * drawW;
    return (
        <Box sx={{ height: 290, mt: 1, bgcolor: BG, border: '1px solid rgba(41,182,255,.18)', borderRadius: 1, overflow: 'hidden' }}>
            <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none">
                {[0, 1, 2, 3, 4].map((i) => <line key={i} x1={left} x2={width - right} y1={top + (i * drawH) / 4} y2={top + (i * drawH) / 4} stroke="rgba(181,197,221,.14)" />)}
                {[0, 1, 2, 3, 4, 5].map((i) => <line key={`v-${i}`} y1={top} y2={height - bottom} x1={left + (i * drawW) / 5} x2={left + (i * drawW) / 5} stroke="rgba(181,197,221,.10)" />)}
                {lines.map((line) => {
                    const values = valid.map((p) => Number(p[line.key])).filter(Number.isFinite);
                    const max = Math.max(line.max || 0, ...values, 1);
                    const min = Math.min(line.min || 0, ...values);
                    const span = max - min || 1;
                    const pts = valid.map((p) => {
                        const value = Number(p[line.key]);
                        if (!Number.isFinite(value)) return null;
                        const x = toX(p.timestamp);
                        const y = top + drawH - ((value - min) / span) * drawH;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                    }).filter(Boolean).join(' ');
                    return pts ? <polyline key={line.key} points={pts} fill="none" stroke={line.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /> : null;
                })}
                {!valid.length && <text x={width / 2} y={height / 2} textAnchor="middle" fill={MUTED} fontSize="20" fontWeight="800">Waiting for live efficiency data...</text>}
            </svg>
        </Box>
    );
}

function EfficiencyTrend({ rigId, livePoint }) {
    const [rangeMs, setRangeMs] = useState(5 * 60 * 1000);
    const [customOpen, setCustomOpen] = useState(false);
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [points, setPoints] = useState([]);
    const [error, setError] = useState('');

    const loadHistory = async (fromMs, endMs) => {
        if (!rigId || !Number.isFinite(fromMs) || !Number.isFinite(endMs) || endMs <= fromMs) return;
        try {
            setError('');
            const result = await api.rigHistoryRange(rigId, EFF_METRICS, fromMs, endMs);
            const rows = Array.isArray(result) ? result : (result?.rows || []);
            setPoints(rows.map((row) => {
                const calc = deriveEfficiency(row);
                return { timestamp: rowTime(row), systemPower: calc.systemPower, htdKw: calc.htdKw, lsMargin: calc.lsMargin, fuel: calc.fuel };
            }).sort((a, b) => a.timestamp - b.timestamp));
        } catch (e) {
            setError(e?.response?.data?.error || 'Efficiency trend history failed');
        }
    };

    useEffect(() => {
        if (isCustom) return undefined;
        const endMs = Date.now();
        loadHistory(endMs - rangeMs, endMs);
        const id = setInterval(() => {
            const now = Date.now();
            loadHistory(now - rangeMs, now);
        }, 30000);
        return () => clearInterval(id);
    }, [isCustom, rangeMs, rigId]);

    useEffect(() => {
        if (!livePoint) return;
        setPoints((prev) => {
            const last = prev[prev.length - 1];
            if (last && livePoint.timestamp - last.timestamp < 900) return prev;
            return [...prev, livePoint]
                .filter((p) => isCustom
                    ? (!customRange.start || !customRange.end || (p.timestamp >= Date.parse(customRange.start) && p.timestamp <= Date.parse(customRange.end)))
                    : p.timestamp >= livePoint.timestamp - rangeMs)
                .slice(-2000);
        });
    }, [customRange.end, customRange.start, isCustom, livePoint, rangeMs]);

    const selectRange = (ms) => { setIsCustom(false); setCustomOpen(false); setRangeMs(ms); };
    const applyCustom = () => {
        const fromMs = Date.parse(customRange.start);
        const endMs = Date.parse(customRange.end);
        if (!Number.isFinite(fromMs) || !Number.isFinite(endMs) || endMs <= fromMs) {
            setError('Select valid custom start and end time');
            return;
        }
        setIsCustom(true);
        setCustomOpen(false);
        loadHistory(fromMs, endMs);
    };

    return (
        <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, minHeight: 390, borderRadius: 1 }}>
            <SectionTitle icon={<Timeline sx={{ color: BLUE }} />} title="Live Trend - System Hydraulic Power & LS Margin" />
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {EFF_RANGES.map((r) => <Button key={r.label} variant={!isCustom && r.ms === rangeMs ? 'contained' : 'outlined'} onClick={() => selectRange(r.ms)} sx={{ minWidth: 60, fontWeight: 900 }}>{r.label}</Button>)}
                <Button variant={isCustom ? 'contained' : 'outlined'} onClick={() => setCustomOpen((v) => !v)} sx={{ minWidth: 104, fontWeight: 900 }}>Custom</Button>
                <Button variant="outlined" onClick={() => isCustom ? applyCustom() : loadHistory(Date.now() - rangeMs, Date.now())} sx={{ fontWeight: 900 }}>RESYNC</Button>
            </Stack>
            {customOpen && (
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                    <TextField size="small" label="Start" type="datetime-local" value={customRange.start} onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))} InputLabelProps={{ shrink: true }} />
                    <TextField size="small" label="End" type="datetime-local" value={customRange.end} onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))} InputLabelProps={{ shrink: true }} />
                    <Button variant="contained" onClick={applyCustom}>Apply</Button>
                </Stack>
            )}
            {error && <Typography sx={{ color: RED, mt: 1, fontWeight: 900 }}>{error}</Typography>}
            <TrendSvg points={points} lines={[{ key: 'systemPower', color: BLUE }, { key: 'htdKw', color: GREEN }, { key: 'lsMargin', color: YELLOW }, { key: 'fuel', color: ORANGE }]} />
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {[['System kW', BLUE], ['HTD kW', GREEN], ['LS Margin', YELLOW], ['Fuel L/h', ORANGE]].map(([label, color]) => (
                    <Stack key={label} direction="row" alignItems="center" spacing={0.75}><Box sx={{ width: 18, height: 4, bgcolor: color, borderRadius: 2 }} /><Typography sx={{ color: TEXT, fontWeight: 800 }}>{label}</Typography></Stack>
                ))}
            </Stack>
        </Paper>
    );
}

export default function EfficiencyPanel({ rigId }) {
    const { data } = useRigData();
    const hpu = data?.hpu || {};
    const eng = data?.cat_engine || data?.cat || {};
    const calc = useMemo(() => deriveEfficiency(data || {}), [data]);
    const liveTrendPoint = useMemo(() => ({
        timestamp: Date.now(),
        systemPower: calc.systemPower,
        htdKw: calc.htdKw,
        lsMargin: calc.lsMargin,
        fuel: calc.fuel,
    }), [calc.fuel, calc.htdKw, calc.lsMargin, calc.systemPower]);

    const htdHydKw = calc.htdPump2Kw + calc.htdPump4Kw;
    const circuitRows = [
        { circuit: 'Mud / circulating pump', useful: dash, hydraulic: fmt(calc.mudPumpKw, 1), eff: dash, status: <StatusChip label="Computed" color={GREEN} />, note: 'Hydraulic kW = pressure(bar) x flow(L/min) / 600' },
        { circuit: 'Top-drive rotation (HTD)', useful: fmt(calc.htdKw, 1), hydraulic: fmt(htdHydKw, 1), eff: htdHydKw > 0 ? fmt((calc.htdKw / htdHydKw) * 100, 1) : dash, status: <StatusChip label="Estimated" color={YELLOW} />, note: 'Mechanical kW = torque(daN-m) x 10 x rpm / 9550' },
        { circuit: 'Pulldown / hoist (PDW)', useful: dash, hydraulic: fmt(calc.pdwKw, 1), eff: dash, status: <StatusChip label="Estimated" color={YELLOW} />, note: 'Pump % x rated L/min x volumetric efficiency, then p x Q / 600' },
        { circuit: 'Power tong / winch / cylinders', useful: dash, hydraulic: dash, eff: dash, status: <StatusChip label="Needs Instrument" color={MUTED} />, note: 'needs torque-sub / load-cell + velocity' },
    ];

    return (
        <Box sx={{ bgcolor: BG, minHeight: '100%', p: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1.2} sx={{ mb: 1 }}>
                <Speed sx={{ color: BLUE }} />
                <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 26 }}>Efficiency & Energy</Typography>
            </Stack>
            <Typography sx={{ color: TEXT, mb: 3, fontSize: 17 }}>
                Derived from live pressure/flow/torque/fuel - read-only. Estimated circuits use configured pump rated-flow; formulas are calculated from live telemetry.
            </Typography>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(5, minmax(0, 1fr))' }, gap: 2, mb: 3 }}>
                <KpiTile label="System Hydraulic Power" value={fmt(calc.systemPower, 1)} unit="kW" color={BLUE} border={BLUE} />
                <KpiTile label="Engine Shaft Power" value={calc.enginePower ? fmt(calc.enginePower, 1) : dash} unit="kW" color={TEXT} border="#d7e1ef" />
                <KpiTile label="Hydraulic Conversion" value={calc.conversion == null ? dash : fmt(calc.conversion, 1)} unit="%" color={GREEN} border={GREEN} />
                <KpiTile label="LS Margin" value={calc.lsMargin != null ? fmt(calc.lsMargin, 1) : dash} unit="bar" color={YELLOW} border={YELLOW} />
                <KpiTile label="Fuel Rate" value={calc.fuel ? fmt(calc.fuel, 1) : dash} unit="L/h" color={TEXT} border="#d7e1ef" />
            </Box>

            <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1, mb: 3 }}>
                <SectionTitle icon={<Timeline sx={{ color: BLUE }} />} title="Per-Circuit Efficiency" />
                <Typography sx={{ color: TEXT, mb: 2 }}>&quot;Estimated&quot; rows mean flow Q came from pump % x configured rated flow.</Typography>
                <TableContainer>
                    <Table size="small">
                        <TableHead><TableRow>{['Circuit', 'Useful Output (kW)', 'Hydraulic Power (kW)', 'Efficiency (%)', 'Status', 'Note'].map((h) => <TableCell key={h} sx={{ color: MUTED, fontWeight: 900, fontSize: 16 }}>{h}</TableCell>)}</TableRow></TableHead>
                        <TableBody>{circuitRows.map((r) => <TableRow key={r.circuit} sx={{ '& td': { borderColor: '#42546b', color: TEXT, fontSize: 16, fontWeight: 700 } }}><TableCell>{r.circuit}</TableCell><TableCell align="right">{r.useful}</TableCell><TableCell align="right">{r.hydraulic}</TableCell><TableCell align="right">{r.eff}</TableCell><TableCell>{r.status}</TableCell><TableCell>{r.note}</TableCell></TableRow>)}</TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1.05fr 0.75fr' }, gap: 2, mb: 3 }}>
                <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1 }}>
                    <SectionTitle icon={<ShowChart sx={{ color: BLUE }} />} title="Specific Energy (Working Day)" />
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1.5 }}>
                        <SmallMetric label="L / Joint" value={dash} />
                        <SmallMetric label="kWh / Joint" value={dash} />
                        <SmallMetric label="L / Metre" value={dash} />
                        <SmallMetric label="Fuel Today" value={dash} />
                        <SmallMetric label="Energy Today" value={dash} />
                        <SmallMetric label="Productive Share" value={dash} />
                    </Box>
                    <Typography sx={{ color: TEXT, mt: 2 }}>Working day 06:00-06:00; fills as joints/metres accrue.</Typography>
                </Paper>

                <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1 }}>
                    <SectionTitle icon={<DeviceThermostat sx={{ color: BLUE }} />} title="Heat Balance" right={<Chip label="Requires Instrumentation" sx={{ color: ORANGE, borderColor: ORANGE, fontWeight: 900 }} variant="outlined" />} />
                    <Paper sx={{ bgcolor: '#172235', p: 2, borderRadius: 1, mb: 2 }}>
                        <Typography sx={{ color: TEXT, textTransform: 'uppercase', letterSpacing: 1.4, mb: 1 }}>Method</Typography>
                        <Typography sx={{ color: TEXT, fontWeight: 900, fontFamily: 'monospace', fontSize: 18 }}>P_loss (kW) approx 0.027 x Q_cooler(l/min) x dT(C)</Typography>
                    </Paper>
                    <Typography sx={{ color: TEXT, mb: 2 }}>HPU oil temp (heat-load proxy): <Box component="span" sx={{ color: ORANGE, fontWeight: 900 }}>{hpu.oil_temp != null ? fmt(hpu.oil_temp, 1) : dash}</Box></Typography>
                    <Typography sx={{ color: TEXT, fontSize: 17 }}>requires cooler dT + flow instrumentation</Typography>
                </Paper>
            </Box>

            <EfficiencyTrend rigId={rigId} livePoint={liveTrendPoint} />

            <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1, mt: 3 }}>
                <SectionTitle icon={<Build sx={{ color: BLUE }} />} title="Instrumentation Gaps" />
                <Typography sx={{ color: TEXT, mb: 2 }}>What to add to go from estimated to exact.</Typography>
                <TableContainer>
                    <Table size="small">
                        <TableHead><TableRow>{['Add Instrument', 'Unlocks', 'Status'].map((h) => <TableCell key={h} sx={{ color: TEXT, fontWeight: 900, fontSize: 16 }}>{h}</TableCell>)}</TableRow></TableHead>
                        <TableBody>{[
                            ['Inline/clamp flow meters (l/min) on main delivery + return header', 'Exact circuit flow (HPU/HTD pump flows are % today) - exact circuit efficiency', 'recommended'],
                            ['Cooler dT (inlet/outlet temp) + cooler flow', 'Heat-balance system efficiency: P_loss = 0.027.Q.dT (Method 2)', 'required for heat-balance'],
                            ['Torque sub / motor dP+speed; cylinder load-cell + stroke; winch line-pull + drum rpm', 'Circuit efficiency for tong / cylinders / winch (only top-drive rotation is measurable now)', 'recommended'],
                        ].map((r) => <TableRow key={r[0]} sx={{ '& td': { borderColor: '#42546b', color: TEXT, fontSize: 16, fontWeight: 700 } }}><TableCell>{r[0]}</TableCell><TableCell>{r[1]}</TableCell><TableCell><StatusChip label={r[2]} color={MUTED} /></TableCell></TableRow>)}</TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1, mt: 3 }}>
                <SectionTitle icon={<Tune sx={{ color: BLUE }} />} title="Tuning Constants" right={<Button variant="outlined" startIcon={<Tune />}>Edit Constants</Button>} />
                <Typography sx={{ color: TEXT, mb: 2 }}>These drive the estimated circuit flows (pump % x rated flow).</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' }, gap: 1.5 }}>
                    <SmallMetric label="Engine Rated (kW)" value={String(EFF_CONSTANTS.engineRatedKw)} />
                    <SmallMetric label="HTD Pump Rated (l/min)" value={String(EFF_CONSTANTS.htdPumpRatedLMin)} />
                    <SmallMetric label="PDW Pump Rated (l/min)" value={String(EFF_CONSTANTS.pdwPumpRatedLMin)} />
                    <SmallMetric label="Pump Vol. Eff." value={String(EFF_CONSTANTS.pumpVolEff)} />
                    <SmallMetric label="Fuel Rate" value={`${fmt(calc.fuel, 1)} L/h`} />
                    <SmallMetric label="Engine Load" value={`${fmt(eng.load, 1)} %`} />
                </Box>
            </Paper>
        </Box>
    );
}

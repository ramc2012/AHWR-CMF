import React, { useMemo, useState } from 'react';
import { Box, Button, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import { useEffect } from 'react';
import { Anchor, Construction, Refresh, Save, Shield, Timeline } from '@mui/icons-material';
import { useRigData } from '../../../context/RigDataContext';
import EdrView from '../EdrView';
import { api } from '../../../api';

const BG = '#0b1220';
const PANEL = '#202a39';
const PANEL2 = '#293648';
const CARD = '#172235';
const BORDER = 'rgba(62,166,255,.22)';
const BLUE = '#28b8ff';
const CYAN = '#22d3ee';
const YELLOW = '#facc15';
const PURPLE = '#9b6cff';
const PINK = '#ec4899';
const RED = '#ff4545';
const GREEN = '#36df82';
const FISHING_TREND_METRICS = ['drawworks.hook_load', 'drilling.bit_depth'];
const WORKOVER_TREND_METRICS = ['pct.makeup_torque', 'htd.torque'];
const WELL_CONTROL_TREND_METRICS = ['well_control.annular_pressure', 'well_control.manifold_pressure', 'well_control.accumulator_pressure'];
const FISHING_RANGES = [
    { label: '1m', ms: 60 * 1000 },
    { label: '5m', ms: 5 * 60 * 1000 },
    { label: '10m', ms: 10 * 60 * 1000 },
    { label: '15m', ms: 15 * 60 * 1000 },
    { label: '30m', ms: 30 * 60 * 1000 },
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '12h', ms: 12 * 60 * 60 * 1000 },
];

function n(value, d = 1, fallback = '0.0') {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return num.toFixed(d);
}

function OpCard({ label, value, unit, color = BLUE, note, tall = false }) {
    return (
        <Paper sx={{ p: 1.7, minHeight: tall ? 120 : 104, bgcolor: PANEL2, borderColor: 'rgba(148,163,184,.24)', borderRadius: 1 }}>
            <Typography sx={{ color: '#c8d7ee', fontWeight: 900, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' }}>{label}</Typography>
            <Stack direction="row" alignItems="baseline" spacing={0.55} sx={{ mt: 1.4 }}>
                <Typography sx={{ color, fontSize: 34, fontWeight: 900, lineHeight: 1 }}>{value}</Typography>
                {unit && <Typography sx={{ color: '#fff', fontWeight: 900 }}>{unit}</Typography>}
            </Stack>
            <Box sx={{ height: 6, borderRadius: 4, bgcolor: 'rgba(148,163,184,.18)', mt: 1.3, overflow: 'hidden' }}>
                <Box sx={{ width: Number(value) > 0 ? '28%' : '0%', height: '100%', bgcolor: color }} />
            </Box>
            {note && <Typography sx={{ color: '#c8d7ee', fontSize: 12, mt: 1 }}>{note}</Typography>}
        </Paper>
    );
}

function MiniBox({ title, value, unit, color = BLUE, note }) {
    return (
        <Paper sx={{ p: 1.5, bgcolor: PANEL2, borderColor: 'rgba(148,163,184,.25)', borderRadius: 1, minHeight: 114 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 900, color: '#dbeafe', textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</Typography>
            <Typography sx={{ color, fontSize: 28, fontWeight: 900, mt: 1 }}>{value}<Typography component="span" sx={{ color: '#fff', fontSize: 13, ml: 0.5, fontWeight: 900 }}>{unit}</Typography></Typography>
            {note && <Typography sx={{ color: '#dbeafe', fontSize: 11, mt: 0.7 }}>{note}</Typography>}
        </Paper>
    );
}

function TrendPlaceholder({ title, legend }) {
    return (
        <Paper sx={{ p: 1.5, bgcolor: PANEL2, borderColor: 'rgba(148,163,184,.25)', borderRadius: 1, minHeight: 288 }}>
            <Typography sx={{ color: '#dbeafe', fontSize: 16, mb: 1.2 }}>{title}</Typography>
            <Box sx={{ height: 215, border: '1px dashed rgba(148,163,184,.22)', borderRadius: 1, position: 'relative', bgcolor: 'rgba(15,23,42,.28)' }}>
                <Box sx={{ position: 'absolute', inset: 16, backgroundImage: 'linear-gradient(rgba(148,163,184,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.09) 1px, transparent 1px)', backgroundSize: '100% 25%, 18% 100%' }} />
            </Box>
            {legend && <Typography align="center" sx={{ color: BLUE, mt: 1, fontWeight: 800 }}>{legend}</Typography>}
        </Paper>
    );
}

function LiveTrendCard({ title, points, lines }) {
    const width = 720;
    const height = 215;
    const pad = 16;
    const safePoints = Array.isArray(points) ? points : [];
    const gridId = `ops-grid-${title.replace(/[^a-z0-9]/gi, '')}`;
    const toPath = (key) => {
        const values = safePoints.map((p) => Number(p[key])).filter(Number.isFinite);
        if (!values.length) return '';
        const min = Math.min(...values);
        const max = Math.max(...values);
        const span = Math.max(max - min, 1);
        return safePoints.map((p, i) => {
            const value = Number(p[key]);
            if (!Number.isFinite(value)) return null;
            const x = pad + (i / Math.max(safePoints.length - 1, 1)) * (width - pad * 2);
            const y = height - pad - ((value - min) / span) * (height - pad * 2);
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }).filter(Boolean).join(' ');
    };
    return (
        <Paper sx={{ p: 1.5, bgcolor: PANEL2, borderColor: 'rgba(148,163,184,.25)', borderRadius: 1, minHeight: 288 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.2 }}>
                <Typography sx={{ color: '#dbeafe', fontSize: 16 }}>{title}</Typography>
                <Typography sx={{ color: GREEN, fontWeight: 900, fontSize: 12 }}>LIVE</Typography>
            </Stack>
            <Box sx={{ height, border: '1px solid rgba(148,163,184,.22)', borderRadius: 1, bgcolor: 'rgba(15,23,42,.28)', overflow: 'hidden' }}>
                <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none">
                    <defs>
                        <pattern id={gridId} width="120" height="54" patternUnits="userSpaceOnUse">
                            <path d="M 120 0 L 0 0 0 54" fill="none" stroke="rgba(148,163,184,.12)" strokeWidth="1" />
                        </pattern>
                    </defs>
                    <rect width={width} height={height} fill={`url(#${gridId})`} />
                    {lines.map((line) => {
                        const path = toPath(line.key);
                        return path ? <path key={line.key} d={path} fill="none" stroke={line.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null;
                    })}
                </svg>
            </Box>
            <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 1 }}>
                {lines.map((line) => <Typography key={line.key} sx={{ color: line.color, fontWeight: 800, fontSize: 12 }}>{line.label}</Typography>)}
            </Stack>
        </Paper>
    );
}

function BopGraphic() {
    const parts = ['ANNULAR', 'PIPE RAM', 'BLIND RAM', 'SHEAR RAM'];
    return (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}>
            <svg viewBox="0 0 180 360" style={{ width: 180, height: 360 }}>
                <defs>
                    <linearGradient id="bopBlue" x1="0" x2="1"><stop offset="0" stopColor="#0a1628" /><stop offset="1" stopColor="#1e3b57" /></linearGradient>
                </defs>
                <rect x="83" y="0" width="14" height="350" fill="#18324b" stroke="#22bfff" opacity="0.8" />
                {parts.map((p, i) => {
                    const y = 28 + i * 78;
                    const wide = i === 0;
                    return <g key={p}>
                        <path d={wide ? `M45 ${y} L135 ${y} L145 ${y + 48} L135 ${y + 86} L45 ${y + 86} L35 ${y + 48} Z` : `M36 ${y} h108 a7 7 0 0 1 7 7 v50 a7 7 0 0 1-7 7 H36 a7 7 0 0 1-7-7 V${y+7} a7 7 0 0 1 7-7 Z`} fill="url(#bopBlue)" stroke="#22bfff" strokeWidth="2" />
                        <rect x="62" y={y + 20} width="56" height="42" rx="4" fill="#07111f" stroke="#22bfff" strokeWidth="1.6" />
                        <text x="90" y={y + 46} fill="#fff" fontSize="10" fontWeight="800" textAnchor="middle">{p}</text>
                        {!wide && <><rect x="34" y={y + 24} width="24" height="34" rx="4" fill="#0b1b2c" stroke="#22bfff" /><rect x="122" y={y + 24} width="24" height="34" rx="4" fill="#0b1b2c" stroke="#22bfff" /></>}
                    </g>;
                })}
                <path d="M60 338 h60 l10 42 H50 Z" fill="#16324d" stroke="#22bfff" strokeWidth="2" />
            </svg>
        </Box>
    );
}

function WellControlPage({ rigId }) {
    const { data } = useRigData();
    const wc = data?.well_control || {};
    const hasWellControlData = wc.available === 1 || wc.available === true
        || wc.annular_pressure != null || wc.manifold_pressure != null || wc.accumulator_pressure != null;
    const [form, setForm] = useState({ sidpp: 500, sicp: 750, mw: 10, tvd: 10000, scr: 600, shoe: 4000, lot: 13.5 });
    const [rangeMs, setRangeMs] = useState(5 * 60 * 1000);
    const [trendPoints, setTrendPoints] = useState([]);
    const [trendError, setTrendError] = useState('');
    const [liveTick, setLiveTick] = useState(0);
    const kmw = useMemo(() => (Number(form.mw) + Number(form.sicp) / (0.052 * Number(form.tvd || 1))), [form]);
    const icp = Number(form.sidpp) + Number(form.scr);
    const fcp = Number(form.scr) * (Number(form.mw) / Math.max(kmw, 0.1));
    const maasp = (Number(form.lot) - Number(form.mw)) * 0.052 * Number(form.shoe);
    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
    const loadTrendHistory = async ({ fromMs, toMs }) => {
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
        try {
            setTrendError('');
            const result = await api.rigHistoryRange(rigId, WELL_CONTROL_TREND_METRICS, fromMs, toMs);
            const rows = Array.isArray(result) ? result : (result?.rows || []);
            const mapped = rows.map((row) => ({
                timestamp: Number(row.t ?? row.timestamp) || Date.parse(row.time || row.name || '') || Date.now(),
                annular: Number(row['well_control.annular_pressure']) || 0,
                manifold: Number(row['well_control.manifold_pressure']) || 0,
                accumulator: Number(row['well_control.accumulator_pressure']) || 0,
            })).sort((a, b) => a.timestamp - b.timestamp);
            setTrendPoints(mapped);
        } catch (e) {
            setTrendError(e?.response?.data?.error || 'Well control trend history failed');
        }
    };

    useEffect(() => {
        const toMs = Date.now();
        loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
        const refresh = setInterval(() => {
            const now = Date.now();
            loadTrendHistory({ fromMs: now - rangeMs, toMs: now });
        }, 30000);
        return () => clearInterval(refresh);
    }, [rangeMs, rigId]);

    useEffect(() => {
        const ticker = setInterval(() => setLiveTick((v) => v + 1), 1000);
        return () => clearInterval(ticker);
    }, []);

    useEffect(() => {
        const timestamp = Date.now();
        const next = {
            timestamp,
            annular: Number(wc.annular_pressure) || 0,
            manifold: Number(wc.manifold_pressure) || 0,
            accumulator: Number(wc.accumulator_pressure) || 0,
        };
        setTrendPoints((prev) => {
            const last = prev[prev.length - 1];
            if (last && timestamp - last.timestamp < 900) return prev;
            return [...prev, next].filter((p) => p.timestamp >= timestamp - rangeMs).slice(-2000);
        });
    }, [liveTick, rangeMs, wc.accumulator_pressure, wc.annular_pressure, wc.manifold_pressure]);

    const resyncTrend = () => {
        const toMs = Date.now();
        loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
    };

    return (
        <Stack spacing={2}>
            <Paper sx={{ px: 2, py: 1.35, bgcolor: hasWellControlData ? 'rgba(54,223,130,.12)' : 'rgba(255,69,69,.12)', border: `1px solid ${hasWellControlData ? GREEN : RED}`, borderRadius: 1, display: 'flex', alignItems: 'center', gap: 1.2 }}>
                <Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: hasWellControlData ? GREEN : RED, boxShadow: `0 0 12px ${hasWellControlData ? GREEN : RED}` }} />
                <Typography sx={{ color: hasWellControlData ? GREEN : RED, fontWeight: 900, fontSize: 18, letterSpacing: 1.2, textTransform: 'uppercase' }}>{hasWellControlData ? 'WELL CONTROL TELEMETRY LIVE' : 'WELL CONTROL TELEMETRY UNAVAILABLE - NO BOP DATA SOURCE'}</Typography>
            </Paper>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '32% 1fr' }, gap: 2 }}>
                <Paper sx={{ p: 2.4, bgcolor: PANEL, borderRadius: 2, minHeight: 640 }}>
                    <Box sx={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 2, alignItems: 'start' }}>
                        <BopGraphic />
                        <Box sx={{ pt: 4 }}>
                            <Typography sx={{ color: '#8fa4c4', fontSize: 16, fontWeight: 900, letterSpacing: 1.5 }}>RAM STATUS</Typography>
                            <Typography sx={{ color: RED, fontSize: 14, fontWeight: 900, mt: 2 }}>NO LIVE DATA - RAM POSITIONS UNKNOWN</Typography>
                            {['ANNULAR PREVENTER', 'PIPE RAMS', 'BLIND RAMS', 'SHEAR RAMS'].map((x) => (
                                <Typography key={x} sx={{ color: '#6f84a5', mt: 1.5 }}>
                                    <Box component="span" sx={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '2px solid #526985', mr: 1 }} />{x}
                                </Typography>
                            ))}
                            <Typography sx={{ color: '#8fa4c4', fontSize: 16, fontWeight: 900, letterSpacing: 1.5, mt: 7 }}>SYSTEM PRESSURE</Typography>
                            <Typography sx={{ color: '#8fa4c4', fontSize: 20, fontWeight: 900, mt: 2 }}>
                                <Box component="span" sx={{ display: 'inline-block', width: 12, height: 8, bgcolor: '#8fa4c4', mr: 1 }} />NO DATA
                            </Typography>
                        </Box>
                    </Box>
                    <Box sx={{ borderTop: '1px dashed rgba(148,163,184,.25)', mt: 4, pt: 2 }}>
                        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                            {FISHING_RANGES.map((x) => <Button key={x.label} size="small" variant={x.ms === rangeMs ? 'contained' : 'outlined'} onClick={() => setRangeMs(x.ms)} sx={{ minWidth: 48, fontWeight: 900 }}>{x.label.toUpperCase()}</Button>)}
                            <Button size="small" startIcon={<Refresh />} variant="outlined" onClick={resyncTrend}>RESYNC</Button>
                        </Stack>
                        <Typography sx={{ color: '#a8c0df', mt: 2 }}>BOP PRESSURES (Trend)</Typography>
                        {trendError && <Typography sx={{ color: RED, fontWeight: 800, my: 1 }}>{trendError}</Typography>}
                        <LiveTrendCard title="" points={trendPoints} lines={[
                            { key: 'annular', label: 'Annular Press', color: CYAN },
                            { key: 'manifold', label: 'Manifold Press', color: PURPLE },
                            { key: 'accumulator', label: 'Accumulator Press', color: PINK },
                        ]} />
                    </Box>
                </Paper>

                <Box>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 2, mb: 2 }}>
                        <OpCard label="Annular Pressure" value={n(wc.annular_pressure, 0, '--')} unit="PSI" color={CYAN} />
                        <OpCard label="Manifold Pressure" value={n(wc.manifold_pressure, 0, '--')} unit="PSI" color={PURPLE} />
                        <OpCard label="Accumulator Pressure" value={n(wc.accumulator_pressure, 0, '--')} unit="PSI" color={PINK} />
                    </Box>
                    <Paper sx={{ p: 3, bgcolor: PANEL, borderRadius: 2 }}>
                        <Typography sx={{ color: '#fff', fontSize: 28, fontWeight: 900, letterSpacing: 1.2, mb: 4 }}>WELL CONTROL KILL SHEET (API RP 59)</Typography>
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 4 }}>
                            <Box>
                                <Typography sx={{ color: '#a8c0df', fontSize: 18, mb: 2 }}>INPUT DATA</Typography>
                                {[
                                    ['SIDPP (psi)', 'sidpp'], ['SICP (psi)', 'sicp'], ['Original MW (ppg)', 'mw'], ['True Vertical Depth (ft)', 'tvd'], ['Pump Pressure @ SCR (psi)', 'scr'], ['Casing Shoe TVD (ft)', 'shoe'], ['Max LOT (ppg)', 'lot']
                                ].map(([label, key]) => <TextField key={key} label={label} value={form[key]} onChange={set(key)} fullWidth size="small" sx={{ mb: 2 }} />)}
                            </Box>
                            <Box>
                                <Typography sx={{ color: '#a8c0df', fontSize: 18, mb: 2 }}>CALCULATED DATA</Typography>
                                <CalcBox label="KILL MUD WEIGHT (KMW)" value={n(kmw, 2)} unit="ppg" color={RED} note={`Increase Requirement +${n(kmw - Number(form.mw), 2)} ppg`} />
                                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, my: 2 }}>
                                    <CalcBox label="ICP (Initial Circ. Press)" value={n(icp, 2)} unit="psi" color={BLUE} small />
                                    <CalcBox label="FCP (Final Circ. Press)" value={n(fcp, 2)} unit="psi" color={BLUE} small />
                                </Box>
                                <CalcBox label="MAASP (Max Allowable Annular Surface Pressure)" value={n(maasp, 2)} unit="psi" color={YELLOW} note="DO NOT EXCEED during kill operation" />
                            </Box>
                        </Box>
                        <Stack direction="row" justifyContent="flex-end" spacing={2} sx={{ mt: 3, pt: 2, borderTop: '1px solid rgba(148,163,184,.25)' }}>
                            <Button variant="outlined">PRINT / EXPORT</Button>
                            <Button variant="contained" startIcon={<Save />}>SAVE CALCULATION</Button>
                        </Stack>
                    </Paper>
                </Box>
            </Box>
        </Stack>
    );
}
function CalcBox({ label, value, unit, color, note, small }) {
    return <Paper sx={{ p: 2, bgcolor: CARD, borderLeft: `4px solid ${color}`, borderRadius: 1, minHeight: small ? 112 : 138 }}>
        <Typography sx={{ color: '#a8c0df', fontSize: 14 }}>{label}</Typography>
        <Typography sx={{ color, fontSize: small ? 30 : 42, fontWeight: 900 }}>{value} <Typography component="span" sx={{ fontSize: 20, fontWeight: 900 }}>{unit}</Typography></Typography>
        {note && <Typography sx={{ color: '#8fa4c4' }}>{note}</Typography>}
    </Paper>;
}

function FishingPage({ rigId }) {
    const { data } = useRigData();
    const dw = data?.drawworks || {};
    const dr = data?.drilling || {};
    const mp = data?.mudpump || {};
    const htd = data?.htd || {};
    const fishTop = 5150;
    const bit = Number(dr.bit_depth || 0);
    const stringWeight = 210;
    const tensileLimit = 500;
    const hookLoad = Number(dw.hook_load || 0);
    const overpull = Math.max(0, hookLoad - stringWeight);
    const overpullPct = Math.min(100, Math.max(0, (overpull / Math.max(tensileLimit - stringWeight, 1)) * 100));
    const [trendPoints, setTrendPoints] = useState([]);
    const [rangeMs, setRangeMs] = useState(12 * 60 * 60 * 1000);
    const [customOpen, setCustomOpen] = useState(false);
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [trendError, setTrendError] = useState('');
    const [liveTick, setLiveTick] = useState(0);

    const loadTrendHistory = async ({ fromMs, toMs }) => {
        if (!rigId || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
        try {
            setTrendError('');
            const result = await api.rigHistoryRange(rigId, FISHING_TREND_METRICS, fromMs, toMs);
            const historyRows = Array.isArray(result) ? result : (result?.rows || []);
            const mapped = historyRows.map((row) => {
                const timestamp = Number(row.t ?? row.timestamp) || Date.parse(row.time || row.name || '') || Date.now();
                const rowHookLoad = Number(row['drawworks.hook_load']);
                const rowBitDepth = Number(row['drilling.bit_depth']);
                const safeHookLoad = Number.isFinite(rowHookLoad) ? rowHookLoad : 0;
                return {
                    timestamp,
                    hookload: safeHookLoad,
                    depth: Number.isFinite(rowBitDepth) ? rowBitDepth : 0,
                    overpull: Math.max(0, safeHookLoad - stringWeight),
                };
            }).sort((a, b) => a.timestamp - b.timestamp);
            setTrendPoints(mapped);
        } catch (e) {
            setTrendError(e?.response?.data?.error || 'Trend history failed');
        }
    };

    useEffect(() => {
        if (isCustom) return;
        const toMs = Date.now();
        loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
        const refresh = setInterval(() => {
            const now = Date.now();
            loadTrendHistory({ fromMs: now - rangeMs, toMs: now });
        }, 30000);
        return () => clearInterval(refresh);
    }, [isCustom, rangeMs, rigId]);

    useEffect(() => {
        const ticker = setInterval(() => setLiveTick((v) => v + 1), 1000);
        return () => clearInterval(ticker);
    }, []);

    useEffect(() => {
        const timestamp = Date.now();
        const next = { timestamp, hookload: hookLoad, depth: bit, overpull };
        setTrendPoints((prev) => {
            const last = prev[prev.length - 1];
            if (last && timestamp - last.timestamp < 900) return prev;
            const merged = [...prev, next]
                .filter((p) => isCustom
                    ? (!customRange.start || !customRange.end || (p.timestamp >= Date.parse(customRange.start) && p.timestamp <= Date.parse(customRange.end)))
                    : p.timestamp >= timestamp - rangeMs)
                .slice(-2000);
            return merged;
        });
    }, [bit, customRange.end, customRange.start, hookLoad, isCustom, liveTick, overpull, rangeMs]);

    const selectRange = (ms) => {
        setIsCustom(false);
        setCustomOpen(false);
        setRangeMs(ms);
    };

    const applyCustomRange = () => {
        const fromMs = Date.parse(customRange.start);
        const toMs = Date.parse(customRange.end);
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
            setTrendError('Select valid custom start and end time');
            return;
        }
        setIsCustom(true);
        setCustomOpen(false);
        loadTrendHistory({ fromMs, toMs });
    };

    const resyncTrend = () => {
        if (isCustom) {
            applyCustomRange();
        } else {
            const toMs = Date.now();
            loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
        }
    };
    return (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '25% 1fr 24%' }, gap: 2 }}>
            <Stack spacing={2}>
                <Typography sx={{ color: YELLOW, fontWeight: 900, fontSize: 20 }}>Critical Hoisting (Primary)</Typography>
                <OpCard label="Actual Hook Load" value={n(dw.hook_load, 1)} unit="tons" color={BLUE} note="String Wt (Tare): 210 t" />
                <OpCard label="String Weight" value="210" unit="tons" color={PURPLE} note="Free / tare weight (input)" />
                <Paper sx={{ p: 2, bgcolor: PANEL2, border: `1px solid ${RED}`, borderRadius: 1 }}>
                    <Typography sx={{ color: RED, fontWeight: 900 }}>CALCULATED OVERPULL</Typography>
                    <Typography sx={{ color: RED, fontSize: 56, fontWeight: 900 }}>{n(overpull, 2)} <Typography component="span" sx={{ fontSize: 24, fontWeight: 900 }}>tons</Typography></Typography>
                    <Stack direction="row" justifyContent="space-between"><Typography>Tensile Limit Utilized</Typography><Typography sx={{ color: YELLOW }}>{n(overpullPct, 2)}%</Typography></Stack>
                    <Box sx={{ height: 8, bgcolor: 'rgba(148,163,184,.18)', borderRadius: 4, mt: 1, overflow: 'hidden' }}><Box sx={{ height: '100%', width: `${overpullPct}%`, bgcolor: overpullPct > 80 ? RED : YELLOW }} /></Box>
                </Paper>
                <Paper sx={{ p: 2, bgcolor: PANEL2 }}><Typography sx={{ mb: 1 }}>SETTINGS</Typography><Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}><TextField size="small" label="String Wt (tons)" value="210" /><TextField size="small" label="Tensile Limit" value="500" /></Box></Paper>
            </Stack>
            <Stack spacing={2}>
                <Stack direction="row" justifyContent="space-between"><Typography sx={{ color: YELLOW, fontWeight: 900, fontSize: 20 }}>Operation Analytics</Typography><Typography>{isCustom ? 'Custom range' : `Last ${FISHING_RANGES.find((r) => r.ms === rangeMs)?.label || '12h'}`}</Typography></Stack>
                <Stack spacing={1}>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {FISHING_RANGES.map((item) => <Button key={item.label} variant={!isCustom && rangeMs === item.ms ? 'contained' : 'outlined'} onClick={() => selectRange(item.ms)}>{item.label}</Button>)}
                        <Button variant={isCustom ? 'contained' : 'outlined'} onClick={() => setCustomOpen((o) => !o)}>Custom</Button>
                        <Button startIcon={<Refresh />} variant="outlined" onClick={resyncTrend}>RESYNC</Button>
                    </Stack>
                    {customOpen && (
                        <Paper sx={{ p: 1.25, bgcolor: CARD, borderColor: 'rgba(148,163,184,.25)' }} variant="outlined">
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                <TextField size="small" label="Start" type="datetime-local" value={customRange.start} onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))} InputLabelProps={{ shrink: true }} />
                                <TextField size="small" label="End" type="datetime-local" value={customRange.end} onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))} InputLabelProps={{ shrink: true }} />
                                <Button variant="contained" onClick={applyCustomRange}>Apply</Button>
                            </Stack>
                        </Paper>
                    )}
                    {trendError && <Typography sx={{ color: RED, fontWeight: 800 }}>{trendError}</Typography>}
                </Stack>
                <LiveTrendCard title="WOH vs DEPTH (Trend)" points={trendPoints} lines={[{ key: 'hookload', label: 'hookload', color: BLUE }, { key: 'depth', label: 'depth', color: YELLOW }]} />
                <LiveTrendCard title="OVERPULL HISTORY" points={trendPoints} lines={[{ key: 'overpull', label: 'overpull', color: RED }]} />
            </Stack>
            <Stack spacing={2}>
                <Typography sx={{ color: '#dbeafe', fontWeight: 900, letterSpacing: 1.5 }}>HOISTING & POSITION</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
                    <MiniBox title="Bit Depth" value={n(bit, 1)} unit="m" color={GREEN} />
                    <MiniBox title="Fish Top" value={fishTop} unit="m" color={YELLOW} note="Target (input)" />
                    <MiniBox title="Block Position" value={n(dw.block_position, 0)} unit="mm" color={CYAN} />
                    <MiniBox title="Weight On Bit" value={n(dr.wob, 1)} unit="t" color={PURPLE} note="Mill / wash-over" />
                </Box>
                <Paper sx={{ p: 1.5, bgcolor: CARD }}><Stack direction="row" justifyContent="space-between"><Typography>Distance to Fish</Typography><Typography sx={{ fontSize: 24, fontWeight: 900 }}>{n(fishTop - bit, 2)} m</Typography></Stack></Paper>
                <Typography sx={{ color: '#dbeafe', fontWeight: 900, letterSpacing: 1.5 }}>JARRING OPS</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}><MiniBox title="Up Jars" value="12" unit="UP JARS" /><MiniBox title="Down Jars" value="5" unit="DOWN JARS" color={YELLOW} /></Box>
                <Typography sx={{ color: '#dbeafe', fontWeight: 900, letterSpacing: 1.5 }}>PUMP & ROTATION</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}><MiniBox title="Pump Press" value={n(mp.pressure, 1)} unit="bar" color={PINK} /><MiniBox title="HTD RPM" value={n(htd.rpm, 0)} unit="rpm" /><MiniBox title="HTD Torque" value={n(htd.torque, 0)} unit="daN-m" color={PURPLE} /><MiniBox title="Tubing Press" value="2500" unit="psi" color={YELLOW} /></Box>
            </Stack>
        </Box>
    );
}

const WORKOVER_STRIPS = [{ title: 'LOAD & PUMP', pens: [
    { channelId: 'drawworks.hook_load', color: BLUE, min: 0, max: 500, enabled: true },
    { channelId: 'drilling.wob', color: YELLOW, min: 0, max: 100, enabled: true },
    { channelId: 'mudpump.spm', color: PINK, min: 0, max: 200, enabled: true },
] }];
const WORKOVER_CHANNELS = ['drawworks.hook_load', 'drilling.wob', 'mudpump.spm'];

function WorkoverPage({ rigId }) {
    const { data } = useRigData();
    const wh = data?.wellhead || {};
    const dw = data?.drawworks || {};
    const dr = data?.drilling || {};
    const pct = data?.pct || {};
    const mp = data?.mudpump || {};
    const htd = data?.htd || {};
    const makeupTorque = Number(pct.makeup_torque ?? htd.torque ?? 0) || 0;
    const topDriveTorque = Number(htd.torque ?? 0) || 0;
    const [trendPoints, setTrendPoints] = useState([]);
    const [rangeMs, setRangeMs] = useState(30 * 60 * 1000);
    const [customOpen, setCustomOpen] = useState(false);
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [trendError, setTrendError] = useState('');

    const loadTrendHistory = async ({ fromMs, toMs }) => {
        if (!rigId || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
        try {
            setTrendError('');
            const result = await api.rigHistoryRange(rigId, WORKOVER_TREND_METRICS, fromMs, toMs);
            const historyRows = Array.isArray(result) ? result : (result?.rows || []);
            const mapped = historyRows.map((row) => {
                const timestamp = Number(row.t ?? row.timestamp) || Date.now();
                const pctTorque = Number(row['pct.makeup_torque']);
                const htdTorque = Number(row['htd.torque']);
                return {
                    timestamp,
                    makeupTorque: Number.isFinite(pctTorque) ? pctTorque : (Number.isFinite(htdTorque) ? htdTorque : 0),
                    htdTorque: Number.isFinite(htdTorque) ? htdTorque : 0,
                };
            }).sort((a, b) => a.timestamp - b.timestamp);
            setTrendPoints(mapped);
        } catch (e) {
            setTrendError(e?.response?.data?.error || 'Workover trend history failed');
        }
    };

    useEffect(() => {
        if (isCustom) return;
        const toMs = Date.now();
        loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
    }, [isCustom, rangeMs, rigId]);

    useEffect(() => {
        const timestamp = Date.now();
        const next = { timestamp, makeupTorque, htdTorque: topDriveTorque };
        setTrendPoints((prev) => {
            const last = prev[prev.length - 1];
            if (last && timestamp - last.timestamp < 900) return prev;
            return [...prev, next]
                .filter((p) => isCustom
                    ? (!customRange.start || !customRange.end || (p.timestamp >= Date.parse(customRange.start) && p.timestamp <= Date.parse(customRange.end)))
                    : p.timestamp >= timestamp - rangeMs)
                .slice(-2000);
        });
    }, [customRange.end, customRange.start, isCustom, makeupTorque, rangeMs, topDriveTorque]);

    const selectRange = (ms) => {
        setIsCustom(false);
        setCustomOpen(false);
        setRangeMs(ms);
    };
    const applyCustomRange = () => {
        const fromMs = Date.parse(customRange.start);
        const toMs = Date.parse(customRange.end);
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
            setTrendError('Select valid custom start and end time');
            return;
        }
        setIsCustom(true);
        setCustomOpen(false);
        loadTrendHistory({ fromMs, toMs });
    };
    const resyncTrend = () => {
        if (isCustom) applyCustomRange();
        else {
            const toMs = Date.now();
            loadTrendHistory({ fromMs: toMs - rangeMs, toMs });
        }
    };

    return <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 500px' }, gap: 2, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 2, mb: 2 }}><OpCard label="Tubing" value={n(wh.tubing_pressure, 1)} unit="bar" /><OpCard label="Casing" value={n(wh.casing_pressure, 1)} unit="bar" color={YELLOW} /><OpCard label="Wellhead" value={n(wh.wellhead_pressure, 1)} unit="bar" color={PURPLE} /></Box>
            <Typography sx={{ color: '#dbeafe', fontWeight: 900, mb: 1, letterSpacing: 1.2 }}>LOAD · WEIGHT · TORQUE · PUMP</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0,1fr))', gap: 2, mb: 2 }}><OpCard label="Hook Load" value={n(dw.hook_load, 1)} unit="t" /><OpCard label="WOB" value={n(dr.wob, 1)} unit="t" /><OpCard label="Make-up Torque" value={n(pct.makeup_torque, 0)} unit="daN-m" color={PURPLE} /><OpCard label="Pump Rate" value={n(mp.spm, 0)} unit="spm" color={PINK} /><OpCard label="Pump Press" value={n(mp.pressure, 1)} unit="bar" color={GREEN} /></Box>
            <Paper sx={{ p: 2, bgcolor: PANEL2, minHeight: 510, mb: 2 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                    <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 20 }}>Make-up Torque vs Time</Typography>
                    <Button variant="contained" color="inherit">IDLE</Button>
                </Stack>
                <Stack spacing={1} sx={{ my: 1.5 }}>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        {FISHING_RANGES.map((item) => <Button key={item.label} size="small" variant={!isCustom && rangeMs === item.ms ? 'contained' : 'outlined'} onClick={() => selectRange(item.ms)}>{item.label}</Button>)}
                        <Button size="small" variant={isCustom ? 'contained' : 'outlined'} onClick={() => setCustomOpen((o) => !o)}>Custom</Button>
                        <Button size="small" startIcon={<Refresh />} variant="outlined" onClick={resyncTrend}>RESYNC</Button>
                    </Stack>
                    {customOpen && (
                        <Paper sx={{ p: 1.25, bgcolor: CARD, borderColor: 'rgba(148,163,184,.25)' }} variant="outlined">
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                <TextField size="small" label="Start" type="datetime-local" value={customRange.start} onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))} InputLabelProps={{ shrink: true }} />
                                <TextField size="small" label="End" type="datetime-local" value={customRange.end} onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))} InputLabelProps={{ shrink: true }} />
                                <Button variant="contained" onClick={applyCustomRange}>Apply</Button>
                            </Stack>
                        </Paper>
                    )}
                    {trendError && <Typography sx={{ color: RED, fontWeight: 800 }}>{trendError}</Typography>}
                </Stack>
                <LiveTrendCard title="Make-up Torque Trend" points={trendPoints} lines={[{ key: 'makeupTorque', label: 'make-up torque', color: PURPLE }, { key: 'htdTorque', label: 'HTD torque', color: BLUE }]} />
            </Paper>
            <Paper sx={{ p: 2, bgcolor: PANEL2 }}><Stack direction="row" justifyContent="space-between"><Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 20 }}>Connections</Typography><Stack direction="row" spacing={1}>{['Joint # 0','Run 0','Pass 0','Fail 0'].map((x)=><Button key={x} variant="outlined">{x}</Button>)}</Stack></Stack><Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', mt: 4, color: '#dbeafe', fontWeight: 900 }}><span>Joint #</span><span>Peak Torque</span><span>Result</span><span>Duration</span><span>Time</span><span>Activity</span></Box></Paper>
        </Box>
        <Paper sx={{ p: 1.5, bgcolor: PANEL2, width: '100%', height: 'calc(100vh - 250px)', minHeight: 650, position: { lg: 'sticky' }, top: 8, display: 'flex', flexDirection: 'column' }}>
            <Typography sx={{ color: '#dbeafe', fontWeight: 900, mb: 1 }}>EDR - LOAD & PUMP</Typography>
            <Box sx={{ flex: 1, minHeight: 0 }}>
                <EdrView mode="compact" rigId={rigId} storageKey={`crmf-ops-workover-edr-${rigId}`} defaultStrips={WORKOVER_STRIPS} channels={WORKOVER_CHANNELS} timeWindowLabel="30m" />
            </Box>
        </Paper>
    </Box>;
}

const OPS_TABS = [
    { label: 'Well Control', icon: <Shield fontSize="small" />, component: WellControlPage },
    { label: 'Fishing', icon: <Anchor fontSize="small" />, component: FishingPage },
    { label: 'Workover', icon: <Construction fontSize="small" />, component: WorkoverPage },
];

export default function OperationsPanel({ rigId, rig }) {
    const [tab, setTab] = useState(0);
    const Active = OPS_TABS[tab].component;
    return <Box sx={{ bgcolor: BG, minHeight: '100%', p: 1.25 }}>
        <Paper sx={{ mb: 1.25, borderRadius: 1, bgcolor: '#172235', borderColor: BORDER }} variant="outlined"><Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 56, '& .MuiTab-root': { minHeight: 56, textTransform: 'none', fontWeight: 900, fontSize: 16, px: 3 }, '& .MuiTabs-indicator': { height: 3 } }}>{OPS_TABS.map((item) => <Tab key={item.label} icon={item.icon} iconPosition="start" label={item.label} />)}</Tabs></Paper>
        <Active rigId={rigId} rig={rig} />
    </Box>;
}




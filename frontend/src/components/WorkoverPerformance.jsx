import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
    Grid, ToggleButton, ToggleButtonGroup, Stack, Chip, Alert,
} from '@mui/material';
import {
    ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { api } from '../api';
import { KpiCard, fmtNum, fmtAgo } from './common';
import ErrorBoundary from './ErrorBoundary';

// Fleet workover performance — industry-standard job KPIs (IADC daily-report
// style): job duration, NPT split, connection (make-up / break-out) times,
// diesel consumption per well and per month, plus the torque-turn connection
// quality benchmark and the live activity feed.

// Auto-scale: real jobs read in days/hours; compressed demo jobs stay legible.
const fmtDays = (v) => (v == null ? '—' : v >= 1 ? `${fmtNum(v, 1)} d` : v * 24 >= 1 ? `${fmtNum(v * 24, 1)} h` : `${fmtNum(v * 1440, 0)} min`);
const fmtHrs = (v) => (v == null ? '—' : v >= 1 ? `${fmtNum(v, 1)} h` : `${fmtNum(v * 60, 0)} min`);
const fmtSec = (v) => (v == null ? '—' : `${fmtNum(v, 0)} s`);
const fmtL = (v) => (v == null ? '—' : v >= 10000 ? `${fmtNum(v / 1000, 1)} kL` : `${fmtNum(v, 0)} L`);

const tooltipStyle = { background: '#0d1526', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 };

function MonthlyChart({ monthly, loading }) {
    const data = (monthly || []).map((m) => ({
        month: m.month,
        wells: m.wellsCompleted,
        avgDays: m.avgDaysPerWell != null ? Number(m.avgDaysPerWell.toFixed(2)) : null,
        nptHours: m.nptHours != null ? Number(m.nptHours.toFixed(1)) : null,
        dieselKL: m.dieselLiters != null ? Number((m.dieselLiters / 1000).toFixed(2)) : null,
    }));
    if (!data.length) {
        return <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 6 }}>{loading ? 'Loading KPIs…' : 'No monthly history yet.'}</Typography>;
    }
    return (
        <Grid container spacing={2}>
            <Grid item xs={12} lg={6}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Wells completed &amp; avg days per well</Typography>
                <Box sx={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                            <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
                            <YAxis yAxisId="wells" stroke="#64748b" fontSize={11} width={40} allowDecimals={false} />
                            <YAxis yAxisId="days" orientation="right" stroke="#64748b" fontSize={11} width={40} />
                            <Tooltip contentStyle={tooltipStyle} />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            <Bar yAxisId="wells" dataKey="wells" name="Wells completed" fill="#38bdf8" isAnimationActive={false} radius={[3, 3, 0, 0]} />
                            <Line yAxisId="days" dataKey="avgDays" name="Avg days/well" stroke="#fbbf24" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                        </ComposedChart>
                    </ResponsiveContainer>
                </Box>
            </Grid>
            <Grid item xs={12} lg={6}>
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Diesel (kL) &amp; NPT hours by month</Typography>
                <Box sx={{ height: 220 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                            <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
                            <YAxis yAxisId="kl" stroke="#64748b" fontSize={11} width={44} />
                            <YAxis yAxisId="npt" orientation="right" stroke="#64748b" fontSize={11} width={40} />
                            <Tooltip contentStyle={tooltipStyle} />
                            <Legend wrapperStyle={{ fontSize: 11 }} />
                            <Bar yAxisId="kl" dataKey="dieselKL" name="Diesel (kL)" fill="#4ade80" isAnimationActive={false} radius={[3, 3, 0, 0]} />
                            <Line yAxisId="npt" dataKey="nptHours" name="NPT (h)" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                        </ComposedChart>
                    </ResponsiveContainer>
                </Box>
            </Grid>
        </Grid>
    );
}

export default function WorkoverPerformance() {
    const nav = useNavigate();
    const [hours, setHours] = useState(24);
    const [days, setDays] = useState(30);
    const [data, setData] = useState({ connections: [], activity: [] });
    const [kpis, setKpis] = useState(null);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        api.workover(hours)
            .then((d) => { setData(d); setErr(''); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load workover data'); })
            .finally(() => setLoading(false));
    }, [hours]);

    const loadKpis = useCallback(() => {
        api.workoverKpis(days)
            .then((k) => { setKpis(k); setErr(''); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load workover KPIs'); });
    }, [days]);

    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
    useEffect(() => { loadKpis(); const t = setInterval(loadKpis, 30000); return () => clearInterval(t); }, [loadKpis]);

    const totalConn = data.connections.reduce((a, c) => a + Number(c.total || 0), 0);
    const totalFail = data.connections.reduce((a, c) => a + Number(c.fail || 0), 0);
    const fleetPass = totalConn > 0 ? Math.round(((totalConn - totalFail) / totalConn) * 100) : null;
    const f = kpis?.fleet || {};

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Workover Performance</Typography>
                <Typography variant="caption" color="text.secondary">KPI window</Typography>
                <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v) => v && setDays(v)}>
                    <ToggleButton value={7}>7d</ToggleButton>
                    <ToggleButton value={30}>30d</ToggleButton>
                    <ToggleButton value={90}>90d</ToggleButton>
                </ToggleButtonGroup>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            {/* ---- Job performance (per completed well) ---- */}
            <Typography variant="overline" color="text.secondary">Job performance — last {kpis?.windowDays ?? days} days</Typography>
            <Grid container spacing={2} mb={1.5}>
                <Grid item xs={6} md={3}><KpiCard label="Avg days per well" value={fmtDays(f.avgDaysPerWell)} color="#38bdf8" sub={`${f.wellsCompleted ?? '—'} wells completed`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Avg NPT per well" value={fmtHrs(f.avgNptHoursPerWell)} color="#ef4444" sub={f.nptPct != null ? `${fmtNum(f.nptPct, 1)}% of job time` : 'no NPT recorded'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Productive time" value={f.productivePct != null ? `${fmtNum(f.productivePct, 1)}%` : '—'} color="success.main" sub="of recorded job time" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Wells completed" value={f.wellsCompleted ?? '—'} color="#a78bfa" sub={`${f.runsCompleted ?? 0} rig runs`} /></Grid>
            </Grid>

            {/* ---- Connections & fuel ---- */}
            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Avg make-up time" value={fmtSec(f.avgMakeupSec)} color="#22d3ee" sub={`${f.makeups ?? 0} connections`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Avg break-out time" value={fmtSec(f.avgBreakoutSec)} color="#fbbf24" sub="tong break-out cycles" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Diesel per well" value={fmtL(f.dieselPerWellL)} color="#4ade80" sub={f.dieselLiters != null ? `${fmtL(f.dieselLiters)} in window` : 'no fuel telemetry'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Diesel per month" value={fmtL(f.dieselPerMonthL)} color="#4ade80" sub="fleet avg / calendar month" /></Grid>
            </Grid>

            {/* ---- Monthly trend ---- */}
            <Paper sx={{ p: 1.5, mb: 2, flex: '0 0 auto' }}>
                <Typography variant="h6" mb={1}>Monthly trend</Typography>
                <ErrorBoundary>
                    <MonthlyChart monthly={kpis?.monthly} loading={!kpis} />
                </ErrorBoundary>
            </Paper>

            {/* ---- Per-rig performance benchmark ---- */}
            <Paper sx={{ mb: 2, flex: '0 0 auto' }}>
                <Box sx={{ p: 1.5, pb: 0.5 }}>
                    <Typography variant="h6">Rig benchmark — last {kpis?.windowDays ?? days} days</Typography>
                </Box>
                <TableContainer sx={{ maxHeight: 380 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell align="right">Wells</TableCell>
                                <TableCell align="right">Avg days/well</TableCell>
                                <TableCell align="right">NPT %</TableCell>
                                <TableCell align="right">Joints</TableCell>
                                <TableCell align="right">Make-up (s)</TableCell>
                                <TableCell align="right">Break-out (s)</TableCell>
                                <TableCell align="right">Pass rate</TableCell>
                                <TableCell align="right">Diesel</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(kpis?.rigs || []).map((r) => (
                                <TableRow key={r.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${r.rigId}`)}>
                                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.rigId}</TableCell>
                                    <TableCell align="right">{r.wellsCompleted}</TableCell>
                                    <TableCell align="right">{fmtDays(r.avgDaysPerWell)}</TableCell>
                                    <TableCell align="right" sx={{ color: r.nptPct > 15 ? '#ef4444' : undefined }}>{r.nptPct != null ? `${fmtNum(r.nptPct, 1)}%` : '—'}</TableCell>
                                    <TableCell align="right">{r.joints ?? '—'}</TableCell>
                                    <TableCell align="right">{fmtSec(r.avgMakeupSec)}</TableCell>
                                    <TableCell align="right">{fmtSec(r.avgBreakoutSec)}</TableCell>
                                    <TableCell align="right" sx={{ color: r.makeupPassRate != null && r.makeupPassRate < 90 ? '#f59e0b' : undefined }}>
                                        {r.makeupPassRate != null ? `${r.makeupPassRate}%` : '—'}
                                    </TableCell>
                                    <TableCell align="right">{fmtL(r.dieselLiters)}</TableCell>
                                </TableRow>
                            ))}
                            {!(kpis?.rigs || []).length && (
                                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                    {kpis ? 'No completed runs in window.' : 'Loading KPIs…'}
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* ---- Live connection quality + activity feed ---- */}
            <Grid container spacing={2} sx={{ flex: '0 0 auto', mb: 1 }}>
                <Grid item xs={12} md={7}>
                    <Paper sx={{ display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} sx={{ p: 1.5, pb: 0.5 }}>
                            <Typography variant="h6" sx={{ flexGrow: 1 }}>Connection quality — torque-turn</Typography>
                            <Chip size="small" label={fleetPass != null ? `fleet pass ${fleetPass}%` : '—'}
                                sx={{ fontWeight: 700, color: fleetPass >= 90 ? '#4ade80' : '#f59e0b', bgcolor: 'rgba(255,255,255,0.06)' }} />
                            <ToggleButtonGroup size="small" exclusive value={hours} onChange={(_, v) => v && setHours(v)}>
                                <ToggleButton value={6}>6h</ToggleButton>
                                <ToggleButton value={24}>24h</ToggleButton>
                                <ToggleButton value={168}>7d</ToggleButton>
                            </ToggleButtonGroup>
                        </Stack>
                        <TableContainer sx={{ maxHeight: 300 }}>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Rig</TableCell>
                                        <TableCell align="right">Conns</TableCell>
                                        <TableCell align="right">Pass</TableCell>
                                        <TableCell align="right">Fail</TableCell>
                                        <TableCell>Pass rate</TableCell>
                                        <TableCell align="right">Avg peak</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {data.connections.map((c) => (
                                        <TableRow key={c.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${c.rigId}`)}>
                                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{c.rigId}</TableCell>
                                            <TableCell align="right">{c.total}</TableCell>
                                            <TableCell align="right" sx={{ color: '#4ade80' }}>{c.pass}</TableCell>
                                            <TableCell align="right" sx={{ color: c.fail > 0 ? '#ef4444' : undefined }}>{c.fail}</TableCell>
                                            <TableCell sx={{ minWidth: 120 }}>
                                                <Stack direction="row" alignItems="center" spacing={1}>
                                                    <Box sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                                        <Box sx={{ width: `${c.passRate ?? 0}%`, height: '100%', bgcolor: (c.passRate ?? 0) >= 90 ? '#4ade80' : '#f59e0b' }} />
                                                    </Box>
                                                    <Typography variant="caption">{c.passRate != null ? `${c.passRate}%` : '—'}</Typography>
                                                </Stack>
                                            </TableCell>
                                            <TableCell align="right">{fmtNum(c.avgPeak, 0)} Nm</TableCell>
                                        </TableRow>
                                    ))}
                                    {!data.connections.length && (
                                        <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                            {loading ? 'Loading connection records…' : 'No connection records in window.'}
                                        </TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>
                <Grid item xs={12} md={5}>
                    <Paper sx={{ display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="h6" sx={{ p: 1.5, pb: 0.5 }}>Activity / NPT feed</Typography>
                        <Box sx={{ maxHeight: 300, overflow: 'auto', px: 1.5, pb: 1.5 }}>
                            {data.activity.map((a, i) => (
                                <Stack key={i} direction="row" spacing={1} alignItems="center" sx={{ py: 0.4, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                    <Chip size="small" label={a.payload?.activity || a.payload?.phase || '—'} sx={{ fontWeight: 700, fontSize: 10, minWidth: 86 }} />
                                    <Typography variant="caption" sx={{ fontWeight: 700 }}>{a.name || a.rig_id}</Typography>
                                    <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>{a.payload?.job || ''}</Typography>
                                    <Typography variant="caption" color="text.secondary">{fmtAgo(a.ts)}</Typography>
                                </Stack>
                            ))}
                            {!data.activity.length && (
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 4 }}>No activity in window.</Typography>
                            )}
                        </Box>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

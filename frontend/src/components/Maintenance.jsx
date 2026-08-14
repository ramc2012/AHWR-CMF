import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Stack, Chip, ToggleButton, ToggleButtonGroup, Select, MenuItem, TextField, Alert,
} from '@mui/material';
import { Healing } from '@mui/icons-material';
import {
    ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend,
} from 'recharts';
import ErrorBoundary from './ErrorBoundary';
import { api } from '../api';
import { KpiCard, fmtNum } from './common';


// Auto-scaling durations (real fleets read in hours/days; compressed demo data stays legible).
const fmtH = (v) => (v == null ? '—' : v >= 48 ? `${fmtNum(v / 24, 1)} d` : v >= 1 ? `${fmtNum(v, 1)} h` : `${fmtNum(v * 60, 0)} min`);
const fmtPct = (v, d = 1) => (v == null ? '—' : `${fmtNum(v, d)}%`);
const chartTooltipStyle = { background: '#0d1526', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 };

export default function Maintenance() {
    const nav = useNavigate();

    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    const [daily, setDaily] = useState(null);   // rig-wise last-day log + NPT rollup
    const [kpis, setKpis] = useState(null);     // reliability KPIs (availability / MTBF / MTTR / Pareto)
    const [days, setDays] = useState(30);
    // Log browser (rig-wise / asset-wise over the accumulated CMMS history).
    const [logKind, setLogKind] = useState('maint');    // 'maint' | 'downtime'
    const [logRig, setLogRig] = useState('all');
    const [logAsset, setLogAsset] = useState('all');
    const [logQ, setLogQ] = useState('');
    const [log, setLog] = useState(null);

    const load = useCallback(() => {
        setErr('');
        api.maintenanceFleetDaily()
            .then(setDaily)
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance data'); })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

    const loadKpis = useCallback(() => {
        api.maintenanceKpis(days).then(setKpis).catch(() => {});
    }, [days]);
    useEffect(() => { loadKpis(); const t = setInterval(loadKpis, 30000); return () => clearInterval(t); }, [loadKpis]);

    // Log browser fetch — debounced so free-text search doesn't spam the API.
    useEffect(() => {
        const t = setTimeout(() => {
            api.maintenanceLog({
                kind: logKind,
                days,
                rig: logRig === 'all' ? undefined : logRig,
                asset: logAsset === 'all' ? undefined : logAsset,
                q: logQ || undefined,
            }).then(setLog).catch(() => {});
        }, 350);
        return () => clearTimeout(t);
    }, [logKind, logRig, logAsset, logQ, days]);

    const rigSort = (a, b) => a.localeCompare(b, undefined, { numeric: true });

    const kf = kpis?.fleet || {};

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Maintenance &amp; Reliability</Typography>
                <Typography variant="caption" color="text.secondary">KPI window</Typography>
                <ToggleButtonGroup size="small" exclusive value={days} onChange={(_e, v) => v && setDays(v)}>
                    <ToggleButton value={7}>7d</ToggleButton>
                    <ToggleButton value={30}>30d</ToggleButton>
                    <ToggleButton value={90}>90d</ToggleButton>
                </ToggleButtonGroup>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            {/* ---- Reliability KPIs (ISO 14224 style) ---- */}
            <Typography variant="overline" color="text.secondary">Reliability — last {kpis?.windowDays ?? days} days</Typography>
            <Grid container spacing={2} mb={1.5}>
                <Grid item xs={6} md={3}><KpiCard label="Fleet availability" value={fmtPct(kf.availabilityPct)} color={(kf.availabilityPct ?? 100) >= 97 ? 'success.main' : 'warning.main'} sub={`${kf.totalRigs ?? '—'} rigs`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="MTBF" value={fmtH(kf.mtbfHours)} color="#38bdf8" sub="mean time between failures" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="MTTR" value={fmtH(kf.mttrHours)} color="#fbbf24" sub="mean time to repair" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="NPT (downtime)" value={fmtH(kf.nptHours)} color="#ef4444" sub={`${kf.breakdowns ?? 0} breakdowns · ${kf.openDowntime ?? 0} open`} /></Grid>
            </Grid>
            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="PM compliance" value={fmtPct(kf.pmCompliancePct, 0)} sub={`${kf.pmOverdue ?? 0} overdue · ${kf.pmDueSoon ?? 0} due soon`} color={(kf.pmCompliancePct ?? 0) >= 95 ? 'success.main' : 'warning.main'} icon={<Healing fontSize="small" color="disabled" />} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Open work orders" value={kf.woOpen ?? '—'} color="#a78bfa" sub={`${kf.woBreakdown ?? 0} breakdown · ${kf.woP1 ?? 0} P1`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Calibration overdue" value={kf.instOverdue ?? '—'} color={(kf.instOverdue ?? 0) ? 'error.main' : 'success.main'} sub={`of ${kf.instTotal ?? '—'} instruments`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="CMMS reporting" value={`${kf.rigsReporting ?? 0}/${kf.totalRigs ?? 0}`} color="#38bdf8" sub="rigs with a synced snapshot" /></Grid>
            </Grid>

            {/* ---- Downtime Pareto + monthly trend ---- */}
            <Paper sx={{ p: 1.5, mb: 2, flex: '0 0 auto' }}>
                <ErrorBoundary>
                    <Grid container spacing={2}>
                        <Grid item xs={12} lg={6}>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Downtime by equipment — fleet cumulative (h)</Typography>
                            <Box sx={{ height: 220 }}>
                                {(kpis?.pareto || []).length ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={kpis.pareto.map((p2) => ({ ...p2, hours: Number(p2.hours.toFixed(1)) }))} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 40 }}>
                                            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                                            <XAxis type="number" stroke="#64748b" fontSize={11} />
                                            <YAxis type="category" dataKey="equipment" stroke="#64748b" fontSize={11} width={120} />
                                            <ChartTooltip contentStyle={chartTooltipStyle} formatter={(v, nm, pl) => [`${v} h · ${pl?.payload?.records ?? 0} records`, pl?.payload?.equipment]} />
                                            <Bar dataKey="hours" name="Hours" fill="#f59e0b" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                ) : <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 6 }}>{kpis ? 'No closed downtime in window.' : 'Loading…'}</Typography>}
                            </Box>
                        </Grid>
                        <Grid item xs={12} lg={6}>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>NPT hours &amp; breakdowns by month</Typography>
                            <Box sx={{ height: 220 }}>
                                {(kpis?.monthly || []).length ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={kpis.monthly.map((m) => ({ ...m, nptHours: Number(m.nptHours.toFixed(1)) }))} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                                            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                                            <XAxis dataKey="month" stroke="#64748b" fontSize={11} />
                                            <YAxis yAxisId="npt" stroke="#64748b" fontSize={11} width={48} />
                                            <YAxis yAxisId="bd" orientation="right" stroke="#64748b" fontSize={11} width={36} allowDecimals={false} />
                                            <ChartTooltip contentStyle={chartTooltipStyle} />
                                            <Legend wrapperStyle={{ fontSize: 11 }} />
                                            <Bar yAxisId="npt" dataKey="nptHours" name="NPT (h)" fill="#ef4444" isAnimationActive={false} radius={[3, 3, 0, 0]} />
                                            <Line yAxisId="bd" dataKey="breakdowns" name="Breakdowns" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                ) : <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', py: 6 }}>{kpis ? 'No monthly history yet.' : 'Loading…'}</Typography>}
                            </Box>
                        </Grid>
                    </Grid>
                </ErrorBoundary>
            </Paper>

            {/* ---- Per-rig reliability benchmark (worst availability first) ---- */}
            <Paper sx={{ mb: 2, flex: '0 0 auto' }}>
                <Box sx={{ p: 1.5, pb: 0.5 }}>
                    <Typography variant="h6">Rig reliability — last {kpis?.windowDays ?? days} days</Typography>
                </Box>
                <TableContainer sx={{ maxHeight: 300 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell>Availability</TableCell>
                                <TableCell align="right">NPT</TableCell>
                                <TableCell align="right">Breakdowns</TableCell>
                                <TableCell align="right">MTTR</TableCell>
                                <TableCell align="right">MTBF</TableCell>
                                <TableCell align="right">Open downtime</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(kpis?.rigs || []).map((r) => (
                                <TableRow key={r.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${encodeURIComponent(r.rigId)}`)}>
                                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.rigId}</TableCell>
                                    <TableCell sx={{ minWidth: 140 }}>
                                        <Stack direction="row" alignItems="center" spacing={1}>
                                            <Box sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                                <Box sx={{ width: `${r.availabilityPct}%`, height: '100%', bgcolor: r.availabilityPct >= 97 ? '#4ade80' : (r.availabilityPct >= 90 ? '#f59e0b' : '#ef4444') }} />
                                            </Box>
                                            <Typography variant="caption" fontWeight={700}>{fmtPct(r.availabilityPct)}</Typography>
                                        </Stack>
                                    </TableCell>
                                    <TableCell align="right">{fmtH(r.nptHours)}</TableCell>
                                    <TableCell align="right">{r.breakdowns}</TableCell>
                                    <TableCell align="right">{fmtH(r.mttrHours)}</TableCell>
                                    <TableCell align="right">{fmtH(r.mtbfHours)}</TableCell>
                                    <TableCell align="right">{r.openDowntime ? <Chip size="small" color="warning" label={r.openDowntime} sx={{ height: 18 }} /> : '—'}</TableCell>
                                </TableRow>
                            ))}
                            {!(kpis?.rigs || []).length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                    {kpis ? 'No downtime records in window — 100% availability.' : 'Loading KPIs…'}
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* ---- LOG BROWSER: rig-wise / asset-wise maintenance & downtime logs ---- */}
            <Paper sx={{ mb: 2, flex: '0 0 auto' }}>
                <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 1.5, pb: 0.5 }} flexWrap="wrap" useFlexGap>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>Log browser</Typography>
                    <ToggleButtonGroup size="small" exclusive value={logKind} onChange={(_e, v) => v && setLogKind(v)}>
                        <ToggleButton value="maint" sx={{ textTransform: 'none' }}>Maintenance log</ToggleButton>
                        <ToggleButton value="downtime" sx={{ textTransform: 'none' }}>Downtime / NPT</ToggleButton>
                        <ToggleButton value="nptfy" sx={{ textTransform: 'none' }}>Rig NPT summary (FY)</ToggleButton>
                    </ToggleButtonGroup>
                </Stack>
                {logKind !== 'nptfy' && (
                <Stack direction="row" spacing={1} sx={{ px: 1.5, pb: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
                    <Select size="small" value={logRig} onChange={(e) => setLogRig(e.target.value)} sx={{ minWidth: 150 }}>
                        <MenuItem value="all">All rigs</MenuItem>
                        {(log?.rigs || []).slice().sort(rigSort).map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                    </Select>
                    <Select size="small" value={logAsset} onChange={(e) => setLogAsset(e.target.value)} sx={{ minWidth: 170 }}>
                        <MenuItem value="all">All assets</MenuItem>
                        {(log?.assets || []).map((a) => <MenuItem key={a} value={a}>{a}</MenuItem>)}
                    </Select>
                    <TextField size="small" placeholder={logKind === 'maint' ? 'Search text / notification / by' : 'Search reason / notes'}
                        value={logQ} onChange={(e) => setLogQ(e.target.value)} sx={{ flex: 1, minWidth: 200 }} />
                    <Typography variant="caption" color="text.secondary">
                        {log ? `${log.rows.length}${log.rows.length === 500 ? '+' : ''} entries · last ${log.windowDays}d` : 'Loading…'}
                    </Typography>
                </Stack>
                )}
                <TableContainer sx={{ maxHeight: 320 }}>
                    <Table size="small" stickyHeader>
                        {logKind === 'nptfy' ? (
                            <>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Rig</TableCell>
                                        <TableCell>Last logged day</TableCell>
                                        <TableCell align="right">NPT prev. day</TableCell>
                                        <TableCell align="right">NPT FY (cum. since {daily?.financialYearStart || 'FY start'})</TableCell>
                                        <TableCell align="right">Open</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(daily?.rigs || []).map((r) => (
                                        <TableRow key={r.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${encodeURIComponent(r.rigId)}`)}>
                                            <TableCell>
                                                <Typography variant="body2" fontWeight={700} sx={{ fontFamily: 'monospace' }}>{r.rigId}</Typography>
                                                <Typography variant="caption" color="text.secondary">{r.assetUnit || r.field || '—'}</Typography>
                                            </TableCell>
                                            <TableCell>{r.logDate ? String(r.logDate).slice(0, 10) : '—'}</TableCell>
                                            <TableCell align="right">
                                                <Typography variant="body2" sx={{ fontWeight: 700, color: r.nptPrevDayMin > 0 ? 'warning.main' : 'text.secondary' }}>
                                                    {fmtNum(r.nptPrevDayMin, 0)} min
                                                </Typography>
                                            </TableCell>
                                            <TableCell align="right">
                                                <Typography variant="body2" sx={{ fontWeight: 700, color: r.nptFyMin > 0 ? 'error.main' : 'success.main' }}>
                                                    {fmtNum(r.nptFyHours, 1)} h
                                                </Typography>
                                            </TableCell>
                                            <TableCell align="right">
                                                {r.nptOpen > 0 ? <Chip size="small" color="warning" label={r.nptOpen} sx={{ height: 18 }} /> : '—'}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                    {!(daily?.rigs || []).length && (
                                        <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>No NPT history yet.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </>
                        ) : logKind === 'maint' ? (
                            <>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Time</TableCell>
                                        <TableCell>Rig</TableCell>
                                        <TableCell>Notification</TableCell>
                                        <TableCell>Asset</TableCell>
                                        <TableCell>Category</TableCell>
                                        <TableCell>Entry</TableCell>
                                        <TableCell>By / shift</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(log?.rows || []).map((l) => (
                                        <TableRow key={`${l.rigId}-${l.entryId}`} hover>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.ts ? new Date(l.ts).toLocaleString() : '—'}</TableCell>
                                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, cursor: 'pointer' }}
                                                onClick={() => nav(`/rigs/${encodeURIComponent(l.rigId)}`)}>{l.rigId}</TableCell>
                                            <TableCell>{l.notificationNo ? <Chip size="small" variant="outlined" label={l.notificationNo} sx={{ height: 18, fontSize: 10, fontFamily: 'monospace' }} /> : '—'}</TableCell>
                                            <TableCell>{l.asset || l.assetId || '—'}</TableCell>
                                            <TableCell><Typography variant="caption" color="text.secondary">{l.category || l.logType || '—'}</Typography></TableCell>
                                            <TableCell sx={{ maxWidth: 420 }}><Typography variant="caption">{l.text || '—'}</Typography></TableCell>
                                            <TableCell><Typography variant="caption" color="text.secondary">{[l.by, l.shift].filter(Boolean).join(' · ') || '—'}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                    {log && !log.rows.length && (
                                        <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No maintenance-log entries match the filters.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </>
                        ) : (
                            <>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Start</TableCell>
                                        <TableCell>Rig</TableCell>
                                        <TableCell>Asset</TableCell>
                                        <TableCell>Reason</TableCell>
                                        <TableCell align="right">Duration</TableCell>
                                        <TableCell>Notes</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(log?.rows || []).map((d2) => (
                                        <TableRow key={`${d2.rigId}-${d2.recordId}`} hover>
                                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{d2.start ? new Date(d2.start).toLocaleString() : '—'}</TableCell>
                                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, cursor: 'pointer' }}
                                                onClick={() => nav(`/rigs/${encodeURIComponent(d2.rigId)}`)}>{d2.rigId}</TableCell>
                                            <TableCell>{d2.asset || d2.assetId || '—'}</TableCell>
                                            <TableCell>{d2.reasonCode || '—'}</TableCell>
                                            <TableCell align="right">
                                                {d2.durationMin != null ? `${fmtNum(d2.durationMin, 0)} min`
                                                    : <Chip size="small" color="warning" label="OPEN" sx={{ height: 18, fontSize: 10 }} />}
                                            </TableCell>
                                            <TableCell sx={{ maxWidth: 380 }}><Typography variant="caption" color="text.secondary">{d2.notes || '—'}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                    {log && !log.rows.length && (
                                        <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>No downtime records match the filters.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </>
                        )}
                    </Table>
                </TableContainer>
            </Paper>



            {/* ---- PM COMPLIANCE BY EQUIPMENT (fleet-cumulated from CMMS snapshots) ---- */}
            <Paper sx={{ mb: 1, flex: '0 0 auto' }}>
                <Box sx={{ p: 1.5, pb: 0.5 }}>
                    <Typography variant="h6">PM compliance by equipment</Typography>
                    <Typography variant="caption" color="text.secondary">
                        every rig's latest CMMS snapshot, cumulated per equipment class · {kf.rigsReporting ?? 0}/{kf.totalRigs ?? 0} rigs reporting
                    </Typography>
                </Box>
                <TableContainer sx={{ maxHeight: 320 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Equipment</TableCell>
                                <TableCell align="right">Units</TableCell>
                                <TableCell align="right">Overdue</TableCell>
                                <TableCell align="right">Due soon</TableCell>
                                <TableCell align="right">OK</TableCell>
                                <TableCell sx={{ minWidth: 160 }}>Compliance</TableCell>
                                <TableCell align="right">Avg next due</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(kpis?.pmByEquipment || []).map((e) => (
                                <TableRow key={e.equipment} hover>
                                    <TableCell sx={{ fontWeight: 700 }}>{e.equipment}</TableCell>
                                    <TableCell align="right">{e.units}</TableCell>
                                    <TableCell align="right" sx={{ color: e.overdue ? 'error.main' : 'text.secondary', fontWeight: e.overdue ? 700 : 400 }}>{e.overdue}</TableCell>
                                    <TableCell align="right" sx={{ color: e.dueSoon ? 'warning.main' : 'text.secondary' }}>{e.dueSoon}</TableCell>
                                    <TableCell align="right" sx={{ color: 'success.main' }}>{e.ok}</TableCell>
                                    <TableCell>
                                        <Stack direction="row" alignItems="center" spacing={1}>
                                            <Box sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                                <Box sx={{ width: `${e.compliancePct ?? 0}%`, height: '100%', bgcolor: (e.compliancePct ?? 0) >= 95 ? '#4ade80' : ((e.compliancePct ?? 0) >= 85 ? '#f59e0b' : '#ef4444') }} />
                                            </Box>
                                            <Typography variant="caption" fontWeight={700}>{fmtPct(e.compliancePct, 0)}</Typography>
                                        </Stack>
                                    </TableCell>
                                    <TableCell align="right">{e.avgNextDueH != null ? fmtH(e.avgNextDueH) : '—'}</TableCell>
                                </TableRow>
                            ))}
                            {!(kpis?.pmByEquipment || []).length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                    {kpis ? 'No CMMS PM data yet.' : 'Loading…'}
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}

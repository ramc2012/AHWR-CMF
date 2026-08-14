import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Stack, Chip, ToggleButton, ToggleButtonGroup, Select, MenuItem, TextField, Button, Dialog,
    DialogTitle, DialogContent, DialogActions, IconButton, Tooltip, Alert,
} from '@mui/material';
import { Add, CheckCircle, PlayArrow, Healing } from '@mui/icons-material';
import {
    ResponsiveContainer, ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend,
} from 'recharts';
import ErrorBoundary from './ErrorBoundary';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFleet } from '../context/FleetContext';
import { KpiCard, fmtAgo, fmtNum } from './common';

const TYPES = ['PM', 'calibration', 'breakdown', 'inspection'];
const STATUSES = ['open', 'in_progress', 'done', 'overdue'];
const STATUS_COLOR = { open: 'warning', in_progress: 'info', done: 'success', overdue: 'error' };
const TYPE_COLOR = { PM: 'info', calibration: 'secondary', breakdown: 'error', inspection: 'default' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
// Auto-scaling durations (real fleets read in hours/days; compressed demo data stays legible).
const fmtH = (v) => (v == null ? '—' : v >= 48 ? `${fmtNum(v / 24, 1)} d` : v >= 1 ? `${fmtNum(v, 1)} h` : `${fmtNum(v * 60, 0)} min`);
const fmtPct = (v, d = 1) => (v == null ? '—' : `${fmtNum(v, d)}%`);
const chartTooltipStyle = { background: '#0d1526', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 };

export default function Maintenance() {
    const nav = useNavigate();
    const { can } = useAuth();
    const { fleet } = useFleet();
    const editable = can('operator');

    const [filter, setFilter] = useState('all');
    const [rows, setRows] = useState([]);
    const [summary, setSummary] = useState(null);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState({ rigId: '', type: 'PM', title: '', dueDate: '', runtimeHours: '', notes: '' });
    const [saving, setSaving] = useState(false);
    const [daily, setDaily] = useState(null);   // rig-wise last-day log + NPT rollup
    const [kpis, setKpis] = useState(null);     // reliability KPIs (availability / MTBF / MTTR / Pareto)
    const [days, setDays] = useState(30);

    const load = useCallback(() => {
        setErr('');
        const params = filter === 'all' ? undefined : { status: filter };
        Promise.all([
            api.maintenance(params),
            api.maintenanceSummary(),
            api.maintenanceFleetDaily().catch(() => null),
        ])
            .then(([list, sum, day]) => { setRows(Array.isArray(list) ? list : []); setSummary(sum); setDaily(day); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance data'); })
            .finally(() => setLoading(false));
    }, [filter]);

    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

    const loadKpis = useCallback(() => {
        api.maintenanceKpis(days).then(setKpis).catch(() => {});
    }, [days]);
    useEffect(() => { loadKpis(); const t = setInterval(loadKpis, 30000); return () => clearInterval(t); }, [loadKpis]);

    const submit = async () => {
        if (!draft.rigId || !draft.title) return;
        setSaving(true);
        try {
            await api.addMaintenance({
                rigId: draft.rigId,
                type: draft.type,
                title: draft.title,
                dueDate: draft.dueDate || null,
                runtimeHours: draft.runtimeHours === '' ? null : Number(draft.runtimeHours),
                notes: draft.notes || null,
            });
            setOpen(false);
            setDraft({ rigId: '', type: 'PM', title: '', dueDate: '', runtimeHours: '', notes: '' });
            load();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to add record');
        } finally {
            setSaving(false);
        }
    };

    const advance = async (rec, status) => {
        try {
            await api.updateMaintenance(rec.id, { status, performedAt: status === 'done' ? new Date().toISOString() : undefined });
            load();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to update record');
        }
    };

    const s = summary || {};
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
                <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
                    <ToggleButton value="all">All</ToggleButton>
                    {STATUSES.map((st) => <ToggleButton key={st} value={st} sx={{ textTransform: 'none' }}>{st.replace('_', ' ')}</ToggleButton>)}
                </ToggleButtonGroup>
                {editable && <Button variant="contained" startIcon={<Add />} onClick={() => setOpen(true)}>Add record</Button>}
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
                <Grid item xs={6} md={3}><KpiCard label="Manual records open" value={s.openCount ?? 0} sub={`${s.overdue ?? 0} overdue · ${s.breakdownCount ?? 0} breakdown`} /></Grid>
            </Grid>

            {/* ---- Downtime Pareto + monthly trend ---- */}
            <Paper sx={{ p: 1.5, mb: 2, flex: '0 0 auto' }}>
                <ErrorBoundary>
                    <Grid container spacing={2}>
                        <Grid item xs={12} lg={6}>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Downtime Pareto — by reason (h)</Typography>
                            <Box sx={{ height: 220 }}>
                                {(kpis?.pareto || []).length ? (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={kpis.pareto.map((p2) => ({ ...p2, hours: Number(p2.hours.toFixed(1)) }))} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 40 }}>
                                            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                                            <XAxis type="number" stroke="#64748b" fontSize={11} />
                                            <YAxis type="category" dataKey="reason" stroke="#64748b" fontSize={11} width={120} />
                                            <ChartTooltip contentStyle={chartTooltipStyle} formatter={(v, nm, pl) => [`${v} h · ${pl?.payload?.records ?? 0} records`, pl?.payload?.reason]} />
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

            {/* Rig-wise daily maintenance log + NPT. Sourced from rig_downtime /
                rig_maint_log, which accumulate each edge's CMMS snapshots (the
                snapshot table itself keeps only the latest, so cumulative FY NPT
                needs the history). FY = Indian financial year, 1 Apr - 31 Mar. */}
            {daily && (
                <Paper sx={{ mb: 2 }}>
                    <Stack direction="row" alignItems="baseline" spacing={1.5} sx={{ p: 2, pb: 1 }} flexWrap="wrap" useFlexGap>
                        <Typography variant="h6">Rig-wise daily maintenance log &amp; NPT</Typography>
                        <Typography variant="caption" color="text.secondary">
                            latest logged day per rig · previous-day NPT · cumulative NPT since FY start {daily.financialYearStart}
                        </Typography>
                    </Stack>
                    <TableContainer sx={{ maxHeight: 420, overflow: 'auto' }}>
                        <Table size="small" stickyHeader>
                            <TableHead>
                                <TableRow>
                                    <TableCell>Rig</TableCell>
                                    <TableCell>Log date</TableCell>
                                    <TableCell>Latest maintenance log</TableCell>
                                    <TableCell align="right">NPT prev. day</TableCell>
                                    <TableCell align="right">NPT FY (cum.)</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {daily.rigs.map((r) => (
                                    <TableRow key={r.rigId} hover
                                        sx={{ cursor: 'pointer' }}
                                        onClick={() => nav(`/rigs/${encodeURIComponent(r.rigId)}`)}>
                                        <TableCell>
                                            <Typography variant="body2" fontWeight={700}>{r.rigId}</Typography>
                                            <Typography variant="caption" color="text.secondary">{r.assetUnit || r.field || '—'}</Typography>
                                        </TableCell>
                                        <TableCell>{r.logDate ? String(r.logDate).slice(0, 10) : '—'}</TableCell>
                                        <TableCell sx={{ maxWidth: 460 }}>
                                            {r.log.length ? (
                                                <Stack spacing={0.4}>
                                                    {r.log.slice(0, 3).map((l, i) => (
                                                        <Stack key={i} direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                                                            {l.notificationNo && (
                                                                <Chip size="small" variant="outlined" label={l.notificationNo}
                                                                    sx={{ height: 18, fontSize: 10, fontFamily: 'monospace' }} />
                                                            )}
                                                            <Typography variant="caption" sx={{ fontWeight: 600 }}>{l.asset || '—'}</Typography>
                                                            <Typography variant="caption" color="text.secondary">{l.text}</Typography>
                                                        </Stack>
                                                    ))}
                                                    {r.log.length > 3 && (
                                                        <Typography variant="caption" color="text.secondary">+{r.log.length - 3} more…</Typography>
                                                    )}
                                                </Stack>
                                            ) : <Typography variant="caption" color="text.secondary">no maintenance entries</Typography>}
                                        </TableCell>
                                        <TableCell align="right">
                                            <Typography variant="body2" sx={{ fontWeight: 700, color: r.nptPrevDayMin > 0 ? 'warning.main' : 'text.secondary' }}>
                                                {fmtNum(r.nptPrevDayMin, 0)} min
                                            </Typography>
                                        </TableCell>
                                        <TableCell align="right">
                                            <Typography variant="body2" sx={{ fontWeight: 700, color: r.nptFyMin > 0 ? 'error.main' : 'success.main' }}>
                                                {fmtNum(r.nptFyHours, 1)} h
                                            </Typography>
                                            {r.nptOpen > 0 && <Chip size="small" color="warning" label={`${r.nptOpen} open`} sx={{ height: 16, fontSize: 10, ml: 0.5 }} />}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            )}

            <Grid container spacing={2} sx={{ flex: 1, minHeight: 0 }}>
                <Grid item xs={12} md={s.byRig?.length ? 8 : 12} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="h6" sx={{ p: 2, pb: 1 }}>Maintenance records</Typography>
                        <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell>Rig</TableCell><TableCell>Type</TableCell><TableCell>Title</TableCell>
                                    <TableCell>Status</TableCell><TableCell align="right">Due</TableCell>
                                    <TableCell align="right">Performed</TableCell><TableCell align="right">Runtime (h)</TableCell>
                                    {editable && <TableCell align="right">Actions</TableCell>}
                                </TableRow></TableHead>
                                <TableBody>
                                    {rows.map((r) => (
                                        <TableRow key={r.id} hover>
                                            <TableCell sx={{ cursor: 'pointer' }} onClick={() => r.rig_id && nav(`/rigs/${r.rig_id}`)}>
                                                <Typography variant="body2" fontWeight={700}>{r.rig_name || r.rig_id || '—'}</Typography>
                                                {r.rig_name && <Typography variant="caption" color="text.secondary">{r.rig_id}</Typography>}
                                            </TableCell>
                                            <TableCell><Chip size="small" variant="outlined" color={TYPE_COLOR[r.type] || 'default'} label={r.type} /></TableCell>
                                            <TableCell><Typography variant="body2">{r.title}</Typography>{r.outcome && <Typography variant="caption" color="text.secondary">{r.outcome}</Typography>}</TableCell>
                                            <TableCell><Chip size="small" color={STATUS_COLOR[r.status] || 'default'} variant={r.status === 'done' ? 'filled' : 'outlined'} label={(r.status || '').replace('_', ' ')} /></TableCell>
                                            <TableCell align="right"><Typography variant="caption" color={r.status === 'overdue' ? 'error.main' : 'text.secondary'}>{fmtDate(r.due_date)}</Typography></TableCell>
                                            <TableCell align="right"><Typography variant="caption" color="text.secondary">{r.performed_at ? fmtAgo(r.performed_at) : '—'}</Typography></TableCell>
                                            <TableCell align="right">{r.runtime_hours == null ? '—' : fmtNum(r.runtime_hours, 0)}</TableCell>
                                            {editable && (
                                                <TableCell align="right">
                                                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                                                        {r.status !== 'in_progress' && r.status !== 'done' && (
                                                            <Tooltip title="Mark in progress"><IconButton size="small" onClick={() => advance(r, 'in_progress')}><PlayArrow fontSize="small" /></IconButton></Tooltip>
                                                        )}
                                                        {r.status !== 'done' && (
                                                            <Tooltip title="Mark done"><IconButton size="small" onClick={() => advance(r, 'done')}><CheckCircle fontSize="small" color="success" /></IconButton></Tooltip>
                                                        )}
                                                    </Stack>
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    ))}
                                    {!loading && !rows.length && (
                                        <TableRow><TableCell colSpan={editable ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                                            {filter === 'all' ? 'No maintenance records.' : `No ${filter.replace('_', ' ')} records.`}
                                        </TableCell></TableRow>
                                    )}
                                    {loading && !rows.length && (
                                        <TableRow><TableCell colSpan={editable ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading maintenance records…</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>

                {!!s.byRig?.length && (
                    <Grid item xs={12} md={4} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                        <Paper sx={{ p: 2, flex: 1, minHeight: { xs: 240, md: 0 }, overflow: 'auto' }}>
                            <Typography variant="h6" gutterBottom>PM compliance by rig</Typography>
                            <Stack spacing={1.5} mt={1}>
                                {s.byRig.map((b) => {
                                    const pct = Math.max(0, Math.min(100, b.pmCompliancePct ?? 0));
                                    return (
                                        <Box key={b.rigId} sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${b.rigId}`)}>
                                            <Stack direction="row" justifyContent="space-between">
                                                <Typography variant="body2">{b.name || b.rigId}</Typography>
                                                <Typography variant="body2" fontWeight={700} color={pct >= 95 ? 'success.main' : 'warning.main'}>{pct}%</Typography>
                                            </Stack>
                                            <Box sx={{ height: 7, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.06)', mt: 0.5, overflow: 'hidden' }}>
                                                <Box sx={{ width: `${pct}%`, height: '100%', bgcolor: pct >= 95 ? 'success.main' : 'warning.main' }} />
                                            </Box>
                                            {(b.overdue || b.breakdownCount) ? (
                                                <Typography variant="caption" color="text.secondary">
                                                    {b.overdue ? `${b.overdue} overdue` : ''}{b.overdue && b.breakdownCount ? ' · ' : ''}{b.breakdownCount ? `${b.breakdownCount} breakdown` : ''}
                                                </Typography>
                                            ) : null}
                                        </Box>
                                    );
                                })}
                            </Stack>
                        </Paper>
                    </Grid>
                )}
            </Grid>

            <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>Add maintenance record</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={0.5}>
                        <Select size="small" displayEmpty value={draft.rigId} onChange={(e) => setDraft({ ...draft, rigId: e.target.value })}>
                            <MenuItem value="" disabled>Select rig…</MenuItem>
                            {(fleet || []).map((r) => <MenuItem key={r.rigId} value={r.rigId}>{r.name || r.rigId} ({r.rigId})</MenuItem>)}
                        </Select>
                        <Select size="small" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                            {TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                        </Select>
                        <TextField size="small" label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                        <TextField size="small" label="Due date" type="date" InputLabelProps={{ shrink: true }} value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
                        <TextField size="small" label="Runtime hours" type="number" value={draft.runtimeHours} onChange={(e) => setDraft({ ...draft, runtimeHours: e.target.value })} />
                        <TextField size="small" label="Notes" multiline maxRows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={submit} disabled={saving || !draft.rigId || !draft.title}>{saving ? 'Saving…' : 'Add'}</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Stack, Chip, ToggleButton, ToggleButtonGroup, Select, MenuItem, TextField, Button, Dialog,
    DialogTitle, DialogContent, DialogActions, IconButton, Tooltip, Alert,
} from '@mui/material';
import { Add, CheckCircle, PlayArrow, Healing } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useFleet } from '../context/FleetContext';
import { KpiCard, fmtAgo, fmtNum } from './common';

const TYPES = ['PM', 'calibration', 'breakdown', 'inspection'];
const STATUSES = ['open', 'in_progress', 'done', 'overdue'];
const STATUS_COLOR = { open: 'warning', in_progress: 'info', done: 'success', overdue: 'error' };
const TYPE_COLOR = { PM: 'info', calibration: 'secondary', breakdown: 'error', inspection: 'default' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

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

    const load = useCallback(() => {
        setErr('');
        const params = filter === 'all' ? undefined : { status: filter };
        Promise.all([
            api.maintenance(params),
            api.maintenanceSummary(),
        ])
            .then(([list, sum]) => { setRows(Array.isArray(list) ? list : []); setSummary(sum); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance data'); })
            .finally(() => setLoading(false));
    }, [filter]);

    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

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

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Maintenance &amp; Reliability</Typography>
                <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
                    <ToggleButton value="all">All</ToggleButton>
                    {STATUSES.map((st) => <ToggleButton key={st} value={st} sx={{ textTransform: 'none' }}>{st.replace('_', ' ')}</ToggleButton>)}
                </ToggleButtonGroup>
                {editable && <Button variant="contained" startIcon={<Add />} onClick={() => setOpen(true)}>Add record</Button>}
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="PM compliance" value={s.pmCompliancePct == null ? '—' : `${s.pmCompliancePct}%`} sub="target ≥ 95" color={(s.pmCompliancePct ?? 0) >= 95 ? 'success.main' : 'warning.main'} icon={<Healing fontSize="small" color="disabled" />} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Overdue" value={s.overdue ?? 0} color={(s.overdue ?? 0) ? 'error.main' : 'success.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Open / in-progress" value={s.openCount ?? 0} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Breakdowns" value={s.breakdownCount ?? 0} color={(s.breakdownCount ?? 0) ? 'warning.main' : 'success.main'} /></Grid>
            </Grid>

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

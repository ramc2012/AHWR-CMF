import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Stack, Chip, Select, MenuItem, TextField, Button, Divider, IconButton, Tooltip, Alert,
} from '@mui/material';
import { Add, CheckCircle } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { KpiCard, fmtAgo, fmtNum } from './common';

const SEV_COLOR = { high: 'error', medium: 'warning', low: 'info' };

export default function Governance() {
    const nav = useNavigate();
    const { can } = useAuth();
    const editable = can('operator');
    const [g, setG] = useState(null);
    const [err, setErr] = useState('');
    const [esc, setEsc] = useState({ rigId: '', title: '', severity: 'medium', owner: '' });
    const [dec, setDec] = useState({ title: '', detail: '' });

    const load = useCallback(() => {
        api.governance()
            .then((d) => { setG(d); setErr(''); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load governance workspace'); });
    }, []);
    useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

    // Mutations surface failures rather than silently dropping them.
    const guard = (fn) => async (...args) => {
        try { await fn(...args); load(); }
        catch (e) { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Action failed'); }
    };

    if (!g) {
        return err
            ? <Alert severity="error">{err} — <Box component="span" sx={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={load}>retry</Box></Alert>
            : <Typography color="text.secondary">Loading governance workspace…</Typography>;
    }
    const maxGate = Math.max(1, ...g.funnel.map((f) => f.count));

    const setGate = guard(async (rigId, gate) => { await api.updateDeployment(rigId, { gate }); });
    const addEsc = guard(async () => { if (!esc.title) return; await api.addEscalation(esc); setEsc({ rigId: '', title: '', severity: 'medium', owner: '' }); });
    const resolveEsc = guard(async (id) => { await api.updateEscalation(id, { status: 'resolved' }); });
    const addDec = guard(async () => { if (!dec.title) return; await api.addDecision(dec); setDec({ title: '', detail: '' }); });

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Governance &amp; Rollout Workspace</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Fleet size" value={g.summary.total} sub="AHWR units" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Live (Phase 2)" value={g.summary.live} color="success.main" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Avg adoption" value={`${g.summary.adoptionAvg}%`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Open escalations" value={g.summary.openEscalations} color={g.summary.openEscalations ? 'warning.main' : 'success.main'} /></Grid>
            </Grid>

            <Grid container spacing={2} sx={{ flex: 1, minHeight: 0, alignContent: 'flex-start' }}>
                {/* Stage-gate funnel */}
                <Grid item xs={12} md={5}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="h6" gutterBottom>Stage-gate funnel</Typography>
                        <Stack spacing={1.5} mt={1}>
                            {g.funnel.map((f) => (
                                <Box key={f.gate}>
                                    <Stack direction="row" justifyContent="space-between">
                                        <Typography variant="body2">{f.label}</Typography>
                                        <Typography variant="body2" fontWeight={700}>{f.count}</Typography>
                                    </Stack>
                                    <Box sx={{ height: 10, borderRadius: 5, bgcolor: 'rgba(255,255,255,0.06)', mt: 0.5, overflow: 'hidden' }}>
                                        <Box sx={{ width: `${(f.count / maxGate) * 100}%`, height: '100%', bgcolor: 'primary.main' }} />
                                    </Box>
                                </Box>
                            ))}
                        </Stack>
                    </Paper>
                </Grid>

                {/* Value realization */}
                <Grid item xs={12} md={7}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="h6" gutterBottom>Value realization (proposal §7)</Typography>
                        <TableContainer>
                            <Table size="small">
                                <TableHead><TableRow>
                                    <TableCell>KPI</TableCell><TableCell align="right">Baseline</TableCell>
                                    <TableCell align="right">Actual</TableCell><TableCell align="right">Target</TableCell>
                                    <TableCell sx={{ minWidth: 120 }}>Progress</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {g.valueMetrics.map((v) => {
                                        const span = (v.target - v.baseline) || 1;
                                        const prog = Math.max(0, Math.min(100, Math.round(((v.actual - v.baseline) / span) * 100)));
                                        return (
                                            <TableRow key={v.id}>
                                                <TableCell><Typography variant="body2">{v.kpi}</Typography><Typography variant="caption" color="text.secondary">{v.category}</Typography></TableCell>
                                                <TableCell align="right">{fmtNum(v.baseline)}{v.unit === '%' ? '%' : ''}</TableCell>
                                                <TableCell align="right"><b>{fmtNum(v.actual)}{v.unit === '%' ? '%' : ''}</b></TableCell>
                                                <TableCell align="right">{fmtNum(v.target)}{v.unit === '%' ? '%' : ''}</TableCell>
                                                <TableCell>
                                                    <Box sx={{ height: 7, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                                        <Box sx={{ width: `${prog}%`, height: '100%', bgcolor: prog >= 80 ? 'success.main' : 'info.main' }} />
                                                    </Box>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>

                {/* Rollout table */}
                <Grid item xs={12} sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
                    <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="h6" sx={{ p: 2, pb: 1 }}>Rig rollout status {editable ? '' : '(read-only)'}</Typography>
                        <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell>Rig</TableCell><TableCell>Stage-gate</TableCell><TableCell>Commissioning</TableCell>
                                    <TableCell align="center">Site ready</TableCell><TableCell align="center">Security</TableCell>
                                    <TableCell align="right">Adoption</TableCell><TableCell align="right">Wave</TableCell><TableCell>Edge ver.</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {g.rigs.map((r) => (
                                        <TableRow key={r.rig_id} hover>
                                            <TableCell onClick={() => nav(`/rigs/${r.rig_id}`)} sx={{ cursor: 'pointer' }}>
                                                <Typography variant="body2" fontWeight={700}>{r.name}</Typography>
                                                <Typography variant="caption" color="text.secondary">{r.rig_id}</Typography>
                                            </TableCell>
                                            <TableCell>
                                                {editable ? (
                                                    <Select size="small" variant="standard" value={r.gate || 'gate0'} onChange={(e) => setGate(r.rig_id, e.target.value)}>
                                                        {g.gates.map((gg) => <MenuItem key={gg.value} value={gg.value}>{gg.label}</MenuItem>)}
                                                    </Select>
                                                ) : <Chip size="small" variant="outlined" label={g.gates.find((x) => x.value === (r.gate || 'gate0'))?.label || r.gate} />}
                                            </TableCell>
                                            <TableCell><Typography variant="body2" textTransform="capitalize">{r.commissioning || '—'}</Typography></TableCell>
                                            <TableCell align="center">{r.site_ready ? <CheckCircle fontSize="small" color="success" /> : <Typography variant="caption" color="text.secondary">—</Typography>}</TableCell>
                                            <TableCell align="center">{r.security_review ? <CheckCircle fontSize="small" color="success" /> : <Typography variant="caption" color="text.secondary">—</Typography>}</TableCell>
                                            <TableCell align="right">{r.adoption_pct ?? 0}%</TableCell>
                                            <TableCell align="right">{r.wave ?? '—'}</TableCell>
                                            <TableCell><Typography variant="caption" color="text.secondary">{r.edge_version || '—'}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>

                {/* Escalation register */}
                <Grid item xs={12} md={7}>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="h6" gutterBottom>Escalation register</Typography>
                        {editable && (
                            <Stack direction="row" spacing={1} mb={1.5} flexWrap="wrap" useFlexGap>
                                <TextField size="small" label="Rig (optional)" value={esc.rigId} onChange={(e) => setEsc({ ...esc, rigId: e.target.value })} sx={{ width: 130 }} />
                                <TextField size="small" label="Issue" value={esc.title} onChange={(e) => setEsc({ ...esc, title: e.target.value })} sx={{ flexGrow: 1, minWidth: 180 }} />
                                <Select size="small" value={esc.severity} onChange={(e) => setEsc({ ...esc, severity: e.target.value })}>
                                    <MenuItem value="high">High</MenuItem><MenuItem value="medium">Medium</MenuItem><MenuItem value="low">Low</MenuItem>
                                </Select>
                                <Button variant="contained" startIcon={<Add />} onClick={addEsc}>Add</Button>
                            </Stack>
                        )}
                        <Stack spacing={1} divider={<Divider flexItem />}>
                            {g.escalations.map((e) => (
                                <Stack key={e.id} direction="row" spacing={1} alignItems="center">
                                    <Chip size="small" color={SEV_COLOR[e.severity] || 'default'} label={e.severity} variant="outlined" />
                                    <Box sx={{ flexGrow: 1 }}>
                                        <Typography variant="body2">{e.title}</Typography>
                                        <Typography variant="caption" color="text.secondary">{e.rig_name || e.rig_id || 'fleet'} · {e.owner || 'unassigned'} · opened {fmtAgo(e.opened_at)}</Typography>
                                    </Box>
                                    <Chip size="small" label={e.status} color={e.status === 'resolved' ? 'success' : e.status === 'in_progress' ? 'info' : 'warning'} variant={e.status === 'resolved' ? 'filled' : 'outlined'} />
                                    {editable && e.status !== 'resolved' && (
                                        <Tooltip title="Mark resolved"><IconButton size="small" onClick={() => resolveEsc(e.id)}><CheckCircle fontSize="small" /></IconButton></Tooltip>
                                    )}
                                </Stack>
                            ))}
                            {!g.escalations.length && <Typography variant="caption" color="text.secondary">No escalations.</Typography>}
                        </Stack>
                    </Paper>
                </Grid>

                {/* Decision log */}
                <Grid item xs={12} md={5}>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="h6" gutterBottom>Decision log</Typography>
                        {editable && (
                            <Stack spacing={1} mb={1.5}>
                                <TextField size="small" label="Decision" value={dec.title} onChange={(e) => setDec({ ...dec, title: e.target.value })} />
                                <TextField size="small" label="Detail" value={dec.detail} onChange={(e) => setDec({ ...dec, detail: e.target.value })} multiline maxRows={3} />
                                <Button variant="outlined" startIcon={<Add />} onClick={addDec} sx={{ alignSelf: 'flex-start' }}>Log decision</Button>
                            </Stack>
                        )}
                        <Stack spacing={1.2} divider={<Divider flexItem />}>
                            {g.decisions.map((d) => (
                                <Box key={d.id}>
                                    <Typography variant="body2" fontWeight={700}>{d.title}</Typography>
                                    {d.detail && <Typography variant="caption" color="text.secondary" display="block">{d.detail}</Typography>}
                                    <Typography variant="caption" color="text.secondary">{d.author || 'system'} · {fmtAgo(d.ts)}</Typography>
                                </Box>
                            ))}
                            {!g.decisions.length && <Typography variant="caption" color="text.secondary">No decisions logged.</Typography>}
                        </Stack>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

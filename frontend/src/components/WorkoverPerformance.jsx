import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Grid, ToggleButton, ToggleButtonGroup, Stack, Chip, Alert,
} from '@mui/material';
import { api } from '../api';
import { KpiCard, fmtNum, fmtAgo } from './common';

export default function WorkoverPerformance() {
    const nav = useNavigate();
    const [hours, setHours] = useState(24);
    const [data, setData] = useState({ connections: [], activity: [] });
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setErr('');
        api.workover(hours)
            .then((d) => setData(d || { connections: [], activity: [] }))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load workover performance'); })
            .finally(() => setLoading(false));
    }, [hours]);
    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

    const conns = data.connections || [];
    const totalConn = conns.reduce((s, c) => s + c.total, 0);
    const totalFail = conns.reduce((s, c) => s + c.fail, 0);
    const fleetPass = totalConn ? Math.round(((totalConn - totalFail) / totalConn) * 100) : null;

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Workover Performance</Typography>
                <ToggleButtonGroup size="small" exclusive value={hours} onChange={(_e, v) => v && setHours(v)}>
                    <ToggleButton value={6}>6h</ToggleButton>
                    <ToggleButton value={24}>24h</ToggleButton>
                    <ToggleButton value={168}>7d</ToggleButton>
                </ToggleButtonGroup>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Connections" value={totalConn} sub={`last ${hours}h`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Fleet pass rate" value={fleetPass == null ? '—' : `${fleetPass}%`} color={fleetPass >= 90 ? 'success.main' : 'warning.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Failed make-ups" value={totalFail} color={totalFail ? 'warning.main' : 'success.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Rigs with activity" value={conns.length} /></Grid>
            </Grid>

            <Grid container spacing={2} sx={{ flex: 1, minHeight: 0 }}>
                <Grid item xs={12} md={7} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="h6" sx={{ p: 2, pb: 1 }}>Connection quality — torque-turn (fleet benchmark)</Typography>
                        <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell>Rig</TableCell><TableCell align="right">Conns</TableCell>
                                    <TableCell align="right">Pass</TableCell><TableCell align="right">Fail</TableCell>
                                    <TableCell sx={{ minWidth: 130 }}>Pass rate</TableCell>
                                    <TableCell align="right">Avg peak</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {conns.map((c) => (
                                        <TableRow key={c.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${c.rigId}`)}>
                                            <TableCell><Typography variant="body2" fontWeight={700}>{c.name || c.rigId}</Typography></TableCell>
                                            <TableCell align="right">{c.total}</TableCell>
                                            <TableCell align="right">{c.pass}</TableCell>
                                            <TableCell align="right">{c.fail || 0}</TableCell>
                                            <TableCell>
                                                <Stack direction="row" alignItems="center" spacing={1}>
                                                    <Box sx={{ flex: 1, height: 7, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                                        <Box sx={{ width: `${c.passRate ?? 0}%`, height: '100%', bgcolor: (c.passRate ?? 0) >= 90 ? 'success.main' : 'warning.main' }} />
                                                    </Box>
                                                    <Typography variant="caption">{c.passRate == null ? '—' : `${c.passRate}%`}</Typography>
                                                </Stack>
                                            </TableCell>
                                            <TableCell align="right">{fmtNum(c.avgPeak, 0)} Nm</TableCell>
                                        </TableRow>
                                    ))}
                                    {!conns.length && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>{loading ? 'Loading connection records…' : 'No connection records in window.'}</TableCell></TableRow>}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>
                <Grid item xs={12} md={5} sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <Paper sx={{ p: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>
                        <Typography variant="h6" gutterBottom>Activity / NPT feed</Typography>
                        {(data.activity || []).map((a, i) => (
                            <Stack key={i} direction="row" spacing={1} alignItems="center" py={0.5} sx={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                <Chip size="small" variant="outlined" label={a.payload?.phase || 'activity'} />
                                <Box sx={{ flexGrow: 1 }}>
                                    <Typography variant="body2">{a.name || a.rig_id}</Typography>
                                    <Typography variant="caption" color="text.secondary">{a.payload?.job || ''}</Typography>
                                </Box>
                                <Typography variant="caption" color="text.secondary">{fmtAgo(a.ts)}</Typography>
                            </Stack>
                        ))}
                        {!(data.activity || []).length && <Typography variant="caption" color="text.secondary">No activity events in window.</Typography>}
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Grid, Chip, Stack, Alert,
} from '@mui/material';
import { api } from '../api';
import { KpiCard, StatusChip, HealthBar, fmtAgo } from './common';

export default function DataQuality() {
    const nav = useNavigate();
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setErr('');
        api.dataQuality()
            .then((d) => setRows(Array.isArray(d) ? d : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load data-quality view'); })
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    const reporting = rows.filter((r) => r.lastDataAt);
    const avg = reporting.length ? Math.round(reporting.reduce((s, r) => s + (r.healthScore || 0), 0) / reporting.length) : 0;
    const stale = rows.filter((r) => r.staleFlag && !r.offline).length;
    const below = rows.filter((r) => r.lastDataAt && r.healthScore < 98).length;

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Data Quality Monitor</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}
            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Avg freshness score" value={avg} sub="target ≥ 98" color={avg >= 98 ? 'success.main' : 'warning.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Reporting rigs" value={reporting.length} sub={`of ${rows.length}`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Stale (lag > 30s)" value={stale} color={stale ? 'warning.main' : 'success.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Below 98 target" value={below} color={below ? 'warning.main' : 'success.main'} /></Grid>
            </Grid>

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell sx={{ minWidth: 150 }}>Health score</TableCell>
                                <TableCell align="right">Tags present</TableCell>
                                <TableCell align="right">Sync lag</TableCell>
                                <TableCell>Flags</TableCell>
                                <TableCell align="right">Last data</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.map((r) => (
                                <TableRow key={r.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${r.rigId}`)}>
                                    <TableCell><Typography variant="body2" fontWeight={700}>{r.name}</Typography><Typography variant="caption" color="text.secondary">{r.rigId}</Typography></TableCell>
                                    <TableCell><StatusChip status={r.status} /></TableCell>
                                    <TableCell><HealthBar value={r.healthScore} /></TableCell>
                                    <TableCell align="right">
                                        <Typography variant="body2" color={r.metricCount < r.expectedMetrics ? 'warning.main' : 'text.primary'}>
                                            {r.status === 'pending' ? '—' : `${r.metricCount}/${r.expectedMetrics}`}
                                        </Typography>
                                    </TableCell>
                                    <TableCell align="right"><Typography variant="body2" color={r.staleFlag ? 'warning.main' : 'text.secondary'}>{r.syncLagSec == null ? '—' : `${r.syncLagSec}s`}</Typography></TableCell>
                                    <TableCell>
                                        <Stack direction="row" spacing={0.5}>
                                            {r.offline && <Chip size="small" color="error" variant="outlined" label="offline" />}
                                            {r.staleFlag && !r.offline && <Chip size="small" color="warning" variant="outlined" label="stale" />}
                                            {r.status !== 'pending' && r.metricCount < r.expectedMetrics && !r.offline && <Chip size="small" color="warning" variant="outlined" label="missing tags" />}
                                            {r.status === 'online' && <Chip size="small" color="success" variant="outlined" label="healthy" />}
                                            {r.status === 'pending' && <Chip size="small" variant="outlined" label="not onboarded" />}
                                        </Stack>
                                    </TableCell>
                                    <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(r.lastDataAt)}</Typography></TableCell>
                                </TableRow>
                            ))}
                            {!loading && !rows.length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No rigs reporting.</TableCell></TableRow>
                            )}
                            {loading && !rows.length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading data-quality view…</TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}

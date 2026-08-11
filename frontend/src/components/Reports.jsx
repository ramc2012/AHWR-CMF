import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import {
    Box, Paper, Typography, Grid, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Button, Stack, Chip, ToggleButton, ToggleButtonGroup, Alert,
} from '@mui/material';
import { Download } from '@mui/icons-material';
import { api } from '../api';
import { KpiCard, StatusChip, fmtAgo } from './common';

// Reporting periods (audit #29): snapshot is the live current-state view; the others
// aggregate over the trailing window on the backend.
const PERIODS = [
    { value: 'snapshot', label: 'Snapshot' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
];

export default function Reports() {
    const [period, setPeriod] = useState('snapshot');
    const [rows, setRows] = useState([]);
    const [windowInterval, setWindowInterval] = useState('');
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setErr('');
        api.report(period === 'snapshot' ? undefined : period)
            // Backend now returns { period, windowInterval, rows } for ALL periods (audit #29).
            .then((d) => {
                setRows(Array.isArray(d) ? d : (d?.rows || []));
                setWindowInterval(Array.isArray(d) ? '' : (d?.windowInterval || ''));
            })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load report'); })
            .finally(() => setLoading(false));
    }, [period]);
    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

    const download = async () => {
        try {
            // CSV export is period-aware: pass the selected period (omit for snapshot).
            const res = await axios.get('/api/reports/fleet.csv', {
                responseType: 'blob',
                params: period === 'snapshot' ? {} : { period },
            });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url; a.download = `crmf-fleet-report-${period}.csv`; a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            if (e?.response?.status !== 401) setErr('CSV export failed');
        }
    };

    // Defensive across snapshot vs period rows (finding #3): period rows carry
    // sample_buckets / alarm_events instead of last_data_at / alarm_active.
    const reporting = rows.filter((r) => r.last_data_at || r.sample_buckets > 0).length;
    const alarms = rows.reduce((s, r) => s + (r.alarm_active ?? r.alarm_events ?? 0), 0);
    const live = rows.filter((r) => r.gate === 'live').length;

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" mb={2} spacing={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Reports</Typography>
                <ToggleButtonGroup size="small" exclusive value={period} onChange={(_e, v) => v && setPeriod(v)}>
                    {PERIODS.map((p) => <ToggleButton key={p.value} value={p.value}>{p.label}</ToggleButton>)}
                </ToggleButtonGroup>
                <Button variant="contained" startIcon={<Download />} onClick={download}>Fleet report (CSV)</Button>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Fleet size" value={rows.length} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Reporting" value={reporting} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Live (Phase 2)" value={live} color="success.main" /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Active alarms" value={alarms} color={alarms ? 'warning.main' : 'success.main'} /></Grid>
            </Grid>

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Typography variant="h6" sx={{ p: 2, pb: 1 }}>
                    Consolidated fleet operations report
                    {period !== 'snapshot' && <Chip size="small" variant="outlined" label={period} sx={{ ml: 1, textTransform: 'capitalize' }} />}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ px: 2 }}>
                    {period === 'snapshot'
                        ? 'Auto-generated snapshot — DWR consolidation, adoption and data-quality (proposal §6.1 reporting).'
                        : `Consolidated ${period} report aggregated over the trailing window (proposal §6.1 reporting).`}
                    {windowInterval && (
                        <Chip size="small" variant="outlined" label={`window: ${windowInterval}`} sx={{ ml: 1 }} />
                    )}
                </Typography>
                <TableContainer sx={{ mt: 1, flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead><TableRow>
                            <TableCell>Rig</TableCell><TableCell>Status</TableCell><TableCell>Activity</TableCell>
                            <TableCell align="right">Health</TableCell><TableCell align="right">Tags</TableCell>
                            <TableCell align="right">Alarms (P1)</TableCell><TableCell>Stage-gate</TableCell>
                            <TableCell align="right">Adoption</TableCell><TableCell align="right">Last data</TableCell>
                        </TableRow></TableHead>
                        <TableBody>
                            {rows.map((r) => (
                                <TableRow key={r.rig_id} hover>
                                    <TableCell><Typography variant="body2" fontWeight={700}>{r.name}</Typography></TableCell>
                                    <TableCell><StatusChip status={r.status} /></TableCell>
                                    <TableCell><Typography variant="caption">{r.active_activity || '—'}</Typography></TableCell>
                                    <TableCell align="right">{r.health_score ?? 0}</TableCell>
                                    <TableCell align="right">{r.metric_count ?? 0}</TableCell>
                                    <TableCell align="right">{r.alarm_active ?? 0}{r.alarm_p1 ? <Chip size="small" color="error" label={`P1·${r.alarm_p1}`} sx={{ ml: 0.5 }} /> : ''}</TableCell>
                                    <TableCell><Typography variant="caption">{r.gate || '—'}</Typography></TableCell>
                                    <TableCell align="right">{r.adoption_pct ?? 0}%</TableCell>
                                    <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(r.last_data_at)}</Typography></TableCell>
                                </TableRow>
                            ))}
                            {!loading && !rows.length && (
                                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5, color: 'text.secondary' }}>No report data for this period.</TableCell></TableRow>
                            )}
                            {loading && !rows.length && (
                                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading report…</TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}

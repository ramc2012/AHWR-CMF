import React, { useEffect, useState, useCallback } from 'react';
import {
    Box, Paper, Grid, Stack, Typography, Chip, Alert, Skeleton,
    Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { useRigData } from '../../../context/RigDataContext';
import { api } from '../../../api';
import { PanelHead, freshness } from '../hmi';
import { PriorityChip, fmtAgo } from '../../common';

// =====================================================================
// RigAlarmsPanel — per-rig ALARMS view for the CRMF remote HMI mirror
// (proposal §6.1: rig drill-down mirrors the edge operator dashboard).
// Shows the live alarm summary (from the edge `_alarms` block) plus an
// alarm-event history table polled from the central events stream.
// READ-ONLY: the CRMF is monitoring-only — ESD / lockout are surfaced
// here purely for surveillance and are NEVER actuated from central.
// =====================================================================

// Top live/stale/offline strip derived from the edge _meta block.
function FreshnessStrip({ meta }) {
    const f = freshness(meta);
    return (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: f.color, boxShadow: `0 0 6px ${f.color}` }} />
            <Typography variant="caption" sx={{ color: f.color, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                {f.text}
            </Typography>
            {meta?.source && (
                <Typography variant="caption" color="text.secondary">· src {meta.source}</Typography>
            )}
        </Stack>
    );
}

// One alarm-count summary card.
function SummaryCard({ label, value, color, chip }) {
    return (
        <Paper sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                {label}
            </Typography>
            {chip || (
                <Typography variant="h4" sx={{ fontWeight: 800, color: color || 'text.primary', lineHeight: 1.1 }}>
                    {value}
                </Typography>
            )}
        </Paper>
    );
}

export default function RigAlarmsPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    const [events, setEvents] = useState([]);
    const [evErr, setEvErr] = useState('');
    const [evLoading, setEvLoading] = useState(true);

    // ---- Alarm-event history (read-only, polled every 6s) ----
    const loadEvents = useCallback(() => {
        if (!rigId) return;
        setEvErr('');
        api.rigAlarms(rigId, 100)
            .then((rows) => setEvents(Array.isArray(rows) ? rows : []))
            .catch((e) => { if (e?.response?.status !== 401) setEvErr(e?.response?.data?.error || 'Failed to load alarm history'); })
            .finally(() => setEvLoading(false));
    }, [rigId]);

    useEffect(() => {
        setEvLoading(true);
        loadEvents();
        const t = setInterval(loadEvents, 6000);
        return () => clearInterval(t);
    }, [loadEvents]);

    // ---- loading skeleton (live data may be null on first render) ----
    if (loading && !data) {
        return (
            <Box>
                <Skeleton variant="rounded" height={28} width={180} sx={{ mb: 2 }} />
                <Grid container spacing={2} sx={{ mb: 2 }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Grid item xs={6} sm={4} md key={`s${i}`}><Skeleton variant="rounded" height={92} /></Grid>
                    ))}
                </Grid>
                <Skeleton variant="rounded" height={240} />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Loading alarms…</Typography>
            </Box>
        );
    }

    const meta = data?._meta || null;
    const al = data?._alarms || {};
    const raised = al.raised || 0;
    const critical = al.critical || 0;
    const high = al.high || 0;
    const medium = al.medium || 0;
    const highest = al.highest || null;
    const rigName = meta?.name || rig?.name || rigId || 'Rig';

    return (
        <Box>
            <FreshnessStrip meta={meta} />

            {error && (
                <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>{error}</Alert>
            )}

            {/* ---- Current alarm summary ---- */}
            <PanelHead
                title={`Current alarms — ${rigName}`}
                right={
                    raised > 0
                        ? <Chip size="small" label={`${raised} active`} sx={{ bgcolor: '#ef444422', color: '#ef4444', border: '1px solid #ef444455', fontWeight: 700 }} />
                        : <Chip size="small" label="all clear" sx={{ bgcolor: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e55', fontWeight: 700 }} />
                }
            />
            <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} sm={4} md>
                    <SummaryCard label="Raised" value={raised} color={raised > 0 ? '#ef4444' : 'text.primary'} />
                </Grid>
                <Grid item xs={6} sm={4} md>
                    <SummaryCard label="Critical · P1" value={critical} color={critical > 0 ? '#ef4444' : 'text.secondary'} />
                </Grid>
                <Grid item xs={6} sm={4} md>
                    <SummaryCard label="High · P2" value={high} color={high > 0 ? '#f59e0b' : 'text.secondary'} />
                </Grid>
                <Grid item xs={6} sm={4} md>
                    <SummaryCard label="Medium · P3" value={medium} color={medium > 0 ? '#38bdf8' : 'text.secondary'} />
                </Grid>
                <Grid item xs={6} sm={4} md>
                    <SummaryCard label="Highest" chip={
                        <Box sx={{ mt: 0.5 }}><PriorityChip priority={highest} /></Box>
                    } />
                </Grid>
            </Grid>

            {/* ---- Alarm event history ---- */}
            <PanelHead
                title="Alarm event history"
                right={<Typography variant="caption" color="text.secondary">newest first · refreshes 6s</Typography>}
            />
            {evErr && <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }} onClose={() => setEvErr('')}>{evErr}</Alert>}
            <Paper sx={{ mb: 2 }}>
                <TableContainer sx={{ maxHeight: 460 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Time</TableCell>
                                <TableCell>Highest</TableCell>
                                <TableCell align="right">Active</TableCell>
                                <TableCell align="right">P1</TableCell>
                                <TableCell align="right">P2</TableCell>
                                <TableCell align="right">P3</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {events.map((ev, i) => {
                                const p1 = ev.p1 || 0;
                                return (
                                    <TableRow key={`${ev.ts}-${i}`} hover>
                                        <TableCell>
                                            <Typography variant="body2">{fmtAgo(ev.ts)}</Typography>
                                            <Typography variant="caption" color="text.secondary">
                                                {ev.ts ? new Date(ev.ts).toLocaleString() : '—'}
                                            </Typography>
                                        </TableCell>
                                        <TableCell><PriorityChip priority={ev.highest} /></TableCell>
                                        <TableCell align="right">{ev.active != null ? ev.active : '—'}</TableCell>
                                        <TableCell align="right">
                                            {p1 ? <Chip size="small" color="error" label={p1} /> : (ev.p1 != null ? 0 : '—')}
                                        </TableCell>
                                        <TableCell align="right">{ev.p2 != null ? (ev.p2 || 0) : '—'}</TableCell>
                                        <TableCell align="right">{ev.p3 != null ? (ev.p3 || 0) : '—'}</TableCell>
                                    </TableRow>
                                );
                            })}
                            {!events.length && (
                                <TableRow>
                                    <TableCell colSpan={6} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                                        {evLoading ? 'Loading alarm history…' : 'No alarm events recorded for this rig.'}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* ---- Read-only surveillance note ---- */}
            <Alert
                severity="info"
                variant="outlined"
                icon={<LockOutlinedIcon fontSize="inherit" />}
            >
                <Typography variant="body2" component="div">
                    Monitoring-only. ESD and lockout conditions are surfaced here for surveillance and audit —
                    the CRMF never actuates rig control. All alarm acknowledgement and reset is performed at the
                    rig-edge HMI; no command is ever sent from central.
                </Typography>
            </Alert>
        </Box>
    );
}

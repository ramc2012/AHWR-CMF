import React, { useEffect, useState, useCallback } from 'react';
import {
    Box, Paper, Grid, Stack, Typography, Chip, Alert, Skeleton,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
} from '@mui/material';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useRigData } from '../../../context/RigDataContext';
import { api } from '../../../api';
import { ValueTile, StatusChip, PanelHead, num, freshness } from '../hmi';
import EdrView from '../EdrView';

// Compact EDR strip config — workover-relevant pens (Hoisting + Pumps), mirrors the edge.
const EDR_STRIPS = [
    {
        title: 'Hoisting',
        pens: [
            { channelId: 'drawworks.hook_load', color: '#38bdf8', min: 0, max: 500, enabled: true },
            { channelId: 'drawworks.block_position', color: '#fbbf24', min: 0, max: 50, enabled: true },
        ],
    },
    {
        title: 'Pumps',
        pens: [
            { channelId: 'mudpump.spm', color: '#4ade80', min: 0, max: 200, enabled: true },
            { channelId: 'mudpump.pressure', color: '#f472b6', min: 0, max: 500, enabled: true },
        ],
    },
];
const EDR_CHANNELS = ['drawworks.hook_load', 'drawworks.block_position', 'mudpump.spm', 'mudpump.pressure'];

// =====================================================================
// WorkoverPanel — per-rig remote HMI mirror, WORKOVER view (proposal §6.1).
// Torque-turn make-up trend + last-connection results + connection-record
// table + activity / NPT note. READ-ONLY: monitoring only, no control.
// =====================================================================

const MAKEUP_METRIC = 'pct.makeup_torque';

// Relative "x ago" formatter for connection timestamps.
function ago(ts) {
    if (ts == null) return '—';
    const ms = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(ms)) return '—';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 0) return 'now';
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

// PASS / FAIL coloured chip for a connection result.
function ResultChip({ value }) {
    if (value == null || value === '') return <Chip size="small" variant="outlined" label="—" sx={{ color: 'text.secondary' }} />;
    const v = String(value).toUpperCase();
    const pass = v === 'PASS' || v === 'OK' || v === 'GOOD' || v === '1';
    const fail = v === 'FAIL' || v === 'BAD' || v === 'NG' || v === '0';
    const color = pass ? '#22c55e' : fail ? '#ef4444' : '#64748b';
    return <Chip size="small" label={pass ? 'PASS' : fail ? 'FAIL' : v} sx={{ bgcolor: color + '22', color, border: `1px solid ${color}55`, fontWeight: 700 }} />;
}

export default function WorkoverPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    const [series, setSeries] = useState([]);
    const [seriesErr, setSeriesErr] = useState('');
    const [conns, setConns] = useState([]);
    const [connsErr, setConnsErr] = useState('');

    // Torque-turn make-up trend (30 min window), refreshed on the slow loop.
    const loadSeries = useCallback(() => {
        if (!rigId) return;
        api.rigHistoryMulti(rigId, [MAKEUP_METRIC], 30)
            .then((d) => {
                const rows = (d?.rows || [])
                    .map((r) => ({ t: r.t, v: r[MAKEUP_METRIC] }))
                    .filter((r) => r.t != null && r.v != null);
                setSeries(rows);
                setSeriesErr('');
            })
            .catch((e) => { if (e?.response?.status !== 401) setSeriesErr(e?.response?.data?.error || 'torque-turn history unavailable'); });
    }, [rigId]);

    // Connection records — poll api.rig every 8s.
    const loadConns = useCallback(() => {
        if (!rigId) return;
        api.rig(rigId)
            .then((d) => { setConns(Array.isArray(d?.recentConnections) ? d.recentConnections : []); setConnsErr(''); })
            .catch((e) => { if (e?.response?.status !== 401) setConnsErr(e?.response?.data?.error || 'connection records unavailable'); });
    }, [rigId]);

    useEffect(() => { loadSeries(); const t = setInterval(loadSeries, 30000); return () => clearInterval(t); }, [loadSeries]);
    useEffect(() => { loadConns(); const t = setInterval(loadConns, 8000); return () => clearInterval(t); }, [loadConns]);

    const fr = freshness(data?._meta);
    const act = data?._activity || {};
    const tt = data?._torqueturn || {};
    const opMode = data?.drilling?.operation_mode;
    const ttUnit = tt.unit || 'Nm';

    return (
        <Box>
            {/* ---- Freshness strip ---- */}
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: fr.color, boxShadow: `0 0 8px ${fr.color}` }} />
                <Typography variant="caption" sx={{ color: fr.color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{fr.text}</Typography>
                <Typography variant="caption" color="text.secondary">· remote HMI mirror · workover · read-only</Typography>
            </Stack>

            {error && <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>{error}</Alert>}

            {/* ---- Compact EDR strip — mirrors the edge workover page (Hoisting + Pumps) ---- */}
            <Box sx={{ width: '100%', height: 220, mb: 2 }}>
                <EdrView
                    mode="compact"
                    rigId={rigId}
                    storageKey={`crmf-edr-workover-${rigId}`}
                    defaultStrips={EDR_STRIPS}
                    channels={EDR_CHANNELS}
                />
            </Box>

            {/* ---- Header: current activity + op-mode ---- */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={1}>
                    <Box>
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>Current activity</Typography>
                        {loading && data == null ? (
                            <Skeleton width={220} height={32} />
                        ) : (
                            <Typography variant="h6" fontWeight={800} sx={{ lineHeight: 1.2 }}>
                                {act.label || '—'}
                                {act.code != null && act.code !== '' && (
                                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>#{act.code}</Typography>
                                )}
                            </Typography>
                        )}
                        <Typography variant="body2" color="text.secondary">{act.job || rig?.field || '—'}</Typography>
                    </Box>
                    <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>Op mode</Typography>
                        <StatusChip value={opMode} map="opMode" />
                    </Stack>
                </Stack>
            </Paper>

            <Grid container spacing={2}>
                {/* ---- Torque-turn trend ---- */}
                <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 2 }}>
                        <PanelHead
                            title="Torque-turn — make-up torque (30 min)"
                            right={<Typography variant="caption" color="text.secondary">{ttUnit}</Typography>}
                        />
                        {seriesErr && <Alert severity="warning" variant="outlined" sx={{ mb: 1 }}>{seriesErr}</Alert>}
                        <Box sx={{ height: 240 }}>
                            {series.length === 0 ? (
                                <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
                                    <Typography variant="caption" color="text.secondary">{seriesErr ? 'No trend' : 'Loading torque-turn history…'}</Typography>
                                </Stack>
                            ) : (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                                        <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                                        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time"
                                            tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            stroke="#64748b" fontSize={11} />
                                        <YAxis stroke="#64748b" fontSize={11} width={56} />
                                        <Tooltip labelFormatter={(t) => new Date(t).toLocaleTimeString()}
                                            formatter={(v) => [`${num(v, 0)} ${ttUnit}`, 'Make-up']}
                                            contentStyle={{ background: '#0d1526', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
                                        <Line type="monotone" dataKey="v" stroke="#3ea6ff" dot={false} strokeWidth={2} isAnimationActive={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            )}
                        </Box>
                    </Paper>
                </Grid>

                {/* ---- Last connection result tiles ---- */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <PanelHead title="Last connection" />
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} md={12}>
                                <ValueTile label="Last peak" value={tt.lastPeak} unit={ttUnit} d={0} sx={{ width: '100%' }} />
                            </Grid>
                            <Grid item xs={6} md={12}>
                                <Paper sx={{ p: 1.5, width: '100%' }}>
                                    <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Result</Typography>
                                    <Box sx={{ mt: 0.5 }}><ResultChip value={tt.lastResult} /></Box>
                                </Paper>
                            </Grid>
                            <Grid item xs={12}>
                                <Stack direction="row" justifyContent="space-between" sx={{ px: 0.5 }}>
                                    <Typography variant="body2" color="text.secondary">Joint</Typography>
                                    <Typography variant="body2" fontWeight={700}>{tt.lastJoint ?? '—'}</Typography>
                                </Stack>
                                <Stack direction="row" justifyContent="space-between" sx={{ px: 0.5 }}>
                                    <Typography variant="body2" color="text.secondary">When</Typography>
                                    <Typography variant="body2" fontWeight={700}>{ago(tt.at)}</Typography>
                                </Stack>
                            </Grid>
                        </Grid>
                    </Paper>
                </Grid>

                {/* ---- Connection records table ---- */}
                <Grid item xs={12} md={8}>
                    <Paper>
                        <Box sx={{ p: 2, pb: 1 }}><PanelHead title="Connection records" right={<Typography variant="caption" color="text.secondary">refresh 8s</Typography>} /></Box>
                        {connsErr && <Alert severity="warning" variant="outlined" sx={{ mx: 2, mb: 1 }}>{connsErr}</Alert>}
                        <TableContainer sx={{ maxHeight: 320 }}>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Joint</TableCell>
                                        <TableCell align="right">Peak torque</TableCell>
                                        <TableCell>Result</TableCell>
                                        <TableCell align="right">When</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {conns.map((c, i) => (
                                        <TableRow key={i} hover>
                                            <TableCell><Typography variant="body2" fontWeight={700}>{c.joint ?? '—'}</Typography></TableCell>
                                            <TableCell align="right">{num(c.peak_torque, 0)} {ttUnit}</TableCell>
                                            <TableCell><ResultChip value={c.result} /></TableCell>
                                            <TableCell align="right"><Typography variant="caption" color="text.secondary">{ago(c.ts)}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                    {conns.length === 0 && (
                                        <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                                            {connsErr ? 'No records' : 'No recent connection records.'}
                                        </TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </Grid>

                {/* ---- NPT / activity note ---- */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <PanelHead title="Activity / NPT note" />
                        <Stack spacing={1}>
                            <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="body2" color="text.secondary">Phase</Typography>
                                <Chip size="small" variant="outlined" label={act.label || 'activity'} />
                            </Stack>
                            <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="body2" color="text.secondary">Job</Typography>
                                <Typography variant="body2" fontWeight={700} noWrap>{act.job || '—'}</Typography>
                            </Stack>
                            <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="body2" color="text.secondary">Op mode</Typography>
                                <StatusChip value={opMode} map="opMode" />
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                                Mirrored from the rig-edge operator dashboard. Connection results and torque-turn
                                peaks are reported by the rig; non-productive time is inferred from activity phase.
                                Monitoring only — no control from the central facility.
                            </Typography>
                        </Stack>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

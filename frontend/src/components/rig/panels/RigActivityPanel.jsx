import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Box, Paper, Stack, Typography, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, Chip, ToggleButton, ToggleButtonGroup, Tooltip, Alert, LinearProgress,
} from '@mui/material';
import { api } from '../../../api';

// Central mirror of the rig-edge Activity page. Read-only: everything here is
// reconstructed from the `activity` events the edge already syncs, so the fleet
// sees the SAME phase timeline the driller sees — not a re-derived guess.
//
// Colours match the edge operation palette so an operator moving between the two
// apps reads the same bar the same way.
const OP_COLOR = {
    RIH: '#27cfe6', POOH: '#ff9d2e', MAKE_UP: '#a9ef34', BREAK_OUT: '#ffc24b',
    CIRCULATE: '#46a6ff', SWAB: '#9a8bff', FISHING: '#b47aff', MILLING: '#f472b6',
    CDR: '#22d3ee', WASH: '#38bdf8', PERFORATION: '#fb7185',
    RIG_UP: '#23dd86', RIG_DOWN: '#23dd86', IDLE: '#7c8aa0', WAIT: '#ff4a60',
};
const colorFor = (seg) => OP_COLOR[String(seg.phase || '').toUpperCase()]
    || (seg.npt ? '#ff4a60' : seg.productive ? '#23dd86' : '#7c8aa0');

const HOUR_OPTIONS = [6, 12, 24, 72];

function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${s}s`;
}
const fmtTime = (iso) => {
    if (!iso) return '--';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '--' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function RigActivityPanel({ rigId }) {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState(null);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        if (!rigId) return;
        api.activity(rigId, hours)
            .then((d) => { setData(d); setErr(''); })
            .catch((e) => setErr(e?.response?.data?.error || 'failed to load activity'))
            .finally(() => setLoading(false));
    }, [rigId, hours]);

    useEffect(() => { setLoading(true); load(); }, [load]);
    useEffect(() => {
        const t = setInterval(load, 15000);   // same cadence as the other rig panels
        return () => clearInterval(t);
    }, [load]);

    const totals = data?.totals || { productiveSec: 0, nptSec: 0, otherSec: 0, total: 0, prodPct: 0, nptPct: 0, otherPct: 0 };
    const segments = data?.segments || [];
    const byPhase = data?.byPhase || [];
    const current = data?.current || {};

    // Width-proportional bar: each segment's share of the window.
    const bar = useMemo(() => {
        const total = segments.reduce((a, s) => a + (s.durationSec || 0), 0);
        if (!total) return [];
        return segments.map((s) => ({ ...s, pct: (s.durationSec / total) * 100 }));
    }, [segments]);

    return (
        <Box sx={{ p: 2 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h6" fontWeight={800} sx={{ flexGrow: 1 }}>Activity &amp; NPT</Typography>
                <ToggleButtonGroup size="small" exclusive value={hours} onChange={(e, v) => v && setHours(v)}>
                    {HOUR_OPTIONS.map((h) => <ToggleButton key={h} value={h} sx={{ px: 1.5 }}>{h}h</ToggleButton>)}
                </ToggleButtonGroup>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
            {loading && <LinearProgress sx={{ mb: 2 }} />}

            {/* Current phase + productive/NPT split */}
            <Stack direction="row" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Paper sx={{ p: 1.5, minWidth: 220, flex: '1 1 220px' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>CURRENT ACTIVITY</Typography>
                    <Typography variant="h6" fontWeight={800} sx={{ color: colorFor(current) }}>
                        {current.label || current.phase || '--'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        for {fmtDur(current.sinceSec)}{current.job ? ` · ${current.job}` : ''}
                    </Typography>
                </Paper>
                <Paper sx={{ p: 1.5, minWidth: 150, flex: '1 1 150px' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PRODUCTIVE</Typography>
                    <Typography variant="h6" fontWeight={800} sx={{ color: '#23dd86' }}>{totals.prodPct}%</Typography>
                    <Typography variant="caption" color="text.secondary">{fmtDur(totals.productiveSec)}</Typography>
                </Paper>
                <Paper sx={{ p: 1.5, minWidth: 150, flex: '1 1 150px' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>NPT</Typography>
                    <Typography variant="h6" fontWeight={800} sx={{ color: '#ff4a60' }}>{totals.nptPct}%</Typography>
                    <Typography variant="caption" color="text.secondary">{fmtDur(totals.nptSec)}</Typography>
                </Paper>
                <Paper sx={{ p: 1.5, minWidth: 150, flex: '1 1 150px' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>SEGMENTS</Typography>
                    <Typography variant="h6" fontWeight={800}>{segments.length}</Typography>
                    <Typography variant="caption" color="text.secondary">over {hours}h</Typography>
                </Paper>
            </Stack>

            {/* Width-proportional timeline bar (same visual language as the edge) */}
            <Paper sx={{ p: 1.5, mb: 2 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>TIMELINE</Typography>
                {bar.length ? (
                    <Box sx={{ display: 'flex', height: 26, borderRadius: 1, overflow: 'hidden', mt: 0.75 }}>
                        {bar.map((s, i) => (
                            <Tooltip key={`${s.start}-${i}`} title={`${s.label || s.phase} · ${fmtDur(s.durationSec)} · ${fmtTime(s.start)}${s.nptReason ? ` · ${s.nptReason}` : ''}`}>
                                <Box sx={{ width: `${s.pct}%`, bgcolor: colorFor(s), minWidth: s.pct > 0 ? 1 : 0 }} />
                            </Tooltip>
                        ))}
                    </Box>
                ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        No activity events received from this rig in the last {hours}h.
                    </Typography>
                )}
            </Paper>

            {/* Time by phase */}
            <Paper sx={{ mb: 2 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ p: 1.5, pb: 0.5 }}>Time by activity</Typography>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>Activity</TableCell>
                                <TableCell>Class</TableCell>
                                <TableCell align="right">Duration</TableCell>
                                <TableCell align="right">Share</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {byPhase.map((p) => (
                                <TableRow key={p.phase} hover>
                                    <TableCell>
                                        <Stack direction="row" spacing={1} alignItems="center">
                                            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: colorFor({ phase: p.phase }) }} />
                                            <Typography variant="body2" fontWeight={700}>{p.label || p.phase}</Typography>
                                        </Stack>
                                    </TableCell>
                                    <TableCell>
                                        <Chip size="small" label={p.phase === 'WAIT' ? 'NPT' : 'Productive'}
                                            sx={{ height: 20, fontWeight: 700, bgcolor: p.phase === 'WAIT' ? 'rgba(255,74,96,.15)' : 'rgba(35,221,134,.15)', color: p.phase === 'WAIT' ? '#ff4a60' : '#23dd86' }} />
                                    </TableCell>
                                    <TableCell align="right">{fmtDur(p.durationSec)}</TableCell>
                                    <TableCell align="right">{p.pct}%</TableCell>
                                </TableRow>
                            ))}
                            {!byPhase.length && (
                                <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">No data</Typography></TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Segment log (newest first) */}
            <Paper>
                <Typography variant="subtitle2" fontWeight={800} sx={{ p: 1.5, pb: 0.5 }}>Activity log</Typography>
                <TableContainer sx={{ maxHeight: 420 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Started</TableCell>
                                <TableCell>Activity</TableCell>
                                <TableCell align="right">Duration</TableCell>
                                <TableCell>NPT reason</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {[...segments].reverse().slice(0, 300).map((s, i) => (
                                <TableRow key={`${s.start}-${i}`} hover>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtTime(s.start)}</TableCell>
                                    <TableCell>
                                        <Stack direction="row" spacing={1} alignItems="center">
                                            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: colorFor(s) }} />
                                            <Typography variant="body2">{s.label || s.phase}</Typography>
                                        </Stack>
                                    </TableCell>
                                    <TableCell align="right">{fmtDur(s.durationSec)}</TableCell>
                                    <TableCell>{s.nptReason || '--'}</TableCell>
                                </TableRow>
                            ))}
                            {!segments.length && (
                                <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary">No activity segments</Typography></TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Stack, Chip, Button, Link as MLink, Alert, Grid,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Select, MenuItem, FormControl, InputLabel,
} from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { api } from '../api';
import { fmtNum } from './common';
import EdrView from './rig/EdrView';
import ErrorBoundary from './ErrorBoundary';

// Well lifecycle status palette (local — STATUS_COLOR is rig-liveness oriented).
const WELL_STATUS_COLOR = {
    active: '#22c55e',
    planned: '#64748b',
    drilling: '#38bdf8',
    completed: '#22d3ee',
    producing: '#22c55e',
    workover: '#f59e0b',
    suspended: '#f97316',
    abandoned: '#ef4444',
};

function WellStatusChip({ status }) {
    const c = WELL_STATUS_COLOR[status] || '#64748b';
    return (
        <Chip size="small" label={(status || 'unknown').toUpperCase()}
            sx={{ bgcolor: c + '22', color: c, border: `1px solid ${c}55`, fontWeight: 700, letterSpacing: 0.4 }} />
    );
}

const fmtDate = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const fmtDateOnly = (v) => {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
};

const fmtDuration = (sec) => {
    if (sec == null || Number.isNaN(Number(sec))) return '—';
    const s = Math.max(0, Math.round(Number(sec)));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
};

function HeaderField({ label, value, mono, onClick }) {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>{label}</Typography>
            {onClick
                ? <MLink component="button" type="button" onClick={onClick} sx={{ fontWeight: 700, fontFamily: mono ? 'monospace' : undefined, cursor: 'pointer' }}>{value}</MLink>
                : <Typography variant="body2" sx={{ fontWeight: 700, fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-word' }}>{value}</Typography>}
        </Box>
    );
}

export default function WellDetail() {
    const { id } = useParams();
    const nav = useNavigate();
    const [well, setWell] = useState(null);
    const [err, setErr] = useState('');
    const [selectedRunId, setSelectedRunId] = useState('');

    const load = useCallback(() => {
        setErr('');
        api.well(id)
            .then(setWell)
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load well'); });
    }, [id]);

    useEffect(() => { load(); }, [load]);

    const runs = useMemo(() => (Array.isArray(well?.runs) ? well.runs : []), [well]);

    // Default the playback selector to the active run if present, else the most recent.
    useEffect(() => {
        if (!runs.length) { setSelectedRunId(''); return; }
        setSelectedRunId((prev) => {
            if (prev && runs.some((r) => String(r.id) === String(prev))) return prev;
            const active = runs.find((r) => r.active);
            return String((active || runs[0]).id);
        });
    }, [runs]);

    const selectedRun = useMemo(() => runs.find((r) => String(r.id) === String(selectedRunId)) || null, [runs, selectedRunId]);

    // WELL-HISTORY: operations log + maintenance/NPT for the selected run.
    const [runLog, setRunLog] = useState(null);
    useEffect(() => {
        setRunLog(null);   // never show the previous run's log while the new fetch is in flight
        if (!selectedRun) return;
        let alive = true;
        api.wellRunLog(id, selectedRun.id)
            .then((d) => { if (alive) setRunLog(d); })
            .catch(() => { if (alive) setRunLog(null); });
        return () => { alive = false; };
    }, [id, selectedRun]);

    if (err) return <Alert severity="error">{err} — <MLink sx={{ cursor: 'pointer' }} onClick={() => nav('/wells')}>back to wells</MLink></Alert>;
    if (!well) return <Typography color="text.secondary">Loading {id}…</Typography>;

    const stats = well.stats || {};

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
            {/* Back + title. */}
            <Stack direction="row" alignItems="center" spacing={1.5} mb={2}>
                <Button size="small" startIcon={<ArrowBack />} onClick={() => nav('/wells')}>Wells</Button>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1, minWidth: 0 }} noWrap>{well.name}</Typography>
                <WellStatusChip status={well.status} />
            </Stack>

            {/* WELL HEADER. */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" mb={2}>
                    <Typography variant="h6" sx={{ fontFamily: 'monospace' }}>{well.uwi || well.wellId}</Typography>
                    {(well.serviceType || well.wellType) && <Chip size="small" variant="outlined" label={well.serviceType || well.wellType} />}
                    <WellStatusChip status={well.status} />
                </Stack>
                <Grid container spacing={2}>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Location" value={well.location || well.blockLease || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Country" value={well.country || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Company man" value={well.companyMan || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Toolpusher" value={well.toolpusher || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Field" value={well.field || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Asset unit" value={well.assetUnit || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Operator" value={well.operator || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Block / lease" value={well.blockLease || '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Spud date" value={fmtDateOnly(well.spudDate)} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="TD date" value={fmtDateOnly(well.tdDate)} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><HeaderField label="Total depth" value={well.totalDepth != null ? `${fmtNum(well.totalDepth, 0)} m` : '—'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}>
                        <HeaderField label="Current rig" value={well.currentRigId || '—'} mono
                            onClick={well.currentRigId ? () => nav('/rigs/' + well.currentRigId) : undefined} />
                    </Grid>
                    {(well.latitude != null || well.longitude != null) && (
                        <Grid item xs={6} sm={4} md={3}>
                            <HeaderField label="Location" value={`${well.latitude != null ? fmtNum(well.latitude, 4) : '—'}, ${well.longitude != null ? fmtNum(well.longitude, 4) : '—'}`} mono />
                        </Grid>
                    )}
                </Grid>
                {well.notes && (
                    <Box sx={{ mt: 2 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>Notes</Typography>
                        <Typography variant="body2">{well.notes}</Typography>
                    </Box>
                )}
                {well.objective && (
                    <Box sx={{ mt: 2 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>Objective</Typography>
                        <Typography variant="body2">{well.objective}</Typography>
                    </Box>
                )}
            </Paper>

            {/* RUNS TABLE. */}
            <Paper sx={{ mb: 2 }}>
                <Box sx={{ p: 1.5, pb: 0.5 }}>
                    <Stack direction="row" alignItems="baseline" spacing={1.5}>
                        <Typography variant="h6">Runs</Typography>
                        <Typography variant="caption" color="text.secondary">
                            {stats.runCount != null ? stats.runCount : runs.length} run{(stats.runCount ?? runs.length) !== 1 ? 's' : ''}
                            {stats.totalRuntimeSec != null ? ` · ${fmtDuration(stats.totalRuntimeSec)} total runtime` : ''}
                        </Typography>
                    </Stack>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead><TableRow>
                            <TableCell>Rig</TableCell>
                            <TableCell>Job</TableCell>
                            <TableCell>Service</TableCell>
                            <TableCell>Started By</TableCell>
                            <TableCell>Start</TableCell>
                            <TableCell>End</TableCell>
                            <TableCell align="right">Duration</TableCell>
                            <TableCell align="right">Depth Delta</TableCell>
                            <TableCell align="right">Joints</TableCell>
                            <TableCell align="center">State</TableCell>
                        </TableRow></TableHead>
                        <TableBody>
                            {runs.map((r) => (
                                <TableRow key={r.id} hover>
                                    <TableCell>
                                        <MLink component="button" type="button" onClick={() => nav('/rigs/' + r.rigId)} sx={{ fontFamily: 'monospace', fontWeight: 700, cursor: 'pointer' }}>{r.rigId}</MLink>
                                    </TableCell>
                                    <TableCell sx={{ fontFamily: 'monospace' }}>{r.jobNo || '—'}</TableCell>
                                    <TableCell>{r.service || '—'}</TableCell>
                                    <TableCell>{r.startedBy || '—'}</TableCell>
                                    <TableCell>{fmtDate(r.startedAt)}</TableCell>
                                    <TableCell>{r.active ? '—' : fmtDate(r.endedAt)}</TableCell>
                                    <TableCell align="right">{fmtDuration(r.durationSec)}</TableCell>
                                    <TableCell align="right">{r.depthDelta != null ? `${fmtNum(r.depthDelta, 2)} m` : '—'}</TableCell>
                                    <TableCell align="right">{r.joints ?? '—'}</TableCell>
                                    <TableCell align="center">
                                        {r.active
                                            ? <Chip size="small" label="ACTIVE" sx={{ bgcolor: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e55', fontWeight: 700 }} />
                                            : <Chip size="small" variant="outlined" label="ended" />}
                                    </TableCell>
                                </TableRow>
                            ))}
                            {!runs.length && (
                                <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>No recorded runs yet.</TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* OFFLINE EDR PLAYBACK. */}
            <Paper sx={{ p: 1.5, mb: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} flexWrap="wrap" useFlexGap mb={1.5}>
                    <Typography variant="h6">Recorded well data (offline)</Typography>
                    {runs.length > 0 && (
                        <FormControl size="small" sx={{ minWidth: 280 }}>
                            <InputLabel id="run-select-label">Run</InputLabel>
                            <Select labelId="run-select-label" label="Run" value={selectedRunId} onChange={(e) => setSelectedRunId(e.target.value)}>
                                {runs.map((r) => (
                                    <MenuItem key={r.id} value={String(r.id)}>
                                        {`${r.rigId} · ${r.jobNo || '—'} · ${fmtDate(r.startedAt)}→${r.active ? 'now' : fmtDate(r.endedAt)}`}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    )}
                </Stack>

                {!runs.length && (
                    <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No recorded runs yet.</Typography>
                )}

                {selectedRun && (
                    <Box sx={{ height: 360, minHeight: 0 }}>
                        <ErrorBoundary>
                            <EdrView
                                key={selectedRun.id}
                                rigId={selectedRun.rigId}
                                mode="full"
                                storageKey={`crmf-edr-well-${id}`}
                                window={{
                                    fromMs: Date.parse(selectedRun.startedAt),
                                    toMs: selectedRun.endedAt ? Date.parse(selectedRun.endedAt) : Date.now(),
                                    label: well.name,
                                }}
                                defaultStrips={[
                                    { title: 'Hoisting', pens: [
                                        { channelId: 'drawworks.hook_load', color: '#38bdf8', min: 0, max: 500, enabled: true },
                                        { channelId: 'drilling.rop', color: '#f472b6', min: 0, max: 80, enabled: true },
                                    ] },
                                    { title: 'Pump', pens: [
                                        { channelId: 'mudpump.spm', color: '#4ade80', min: 0, max: 200, enabled: true },
                                        { channelId: 'mudpump.pressure', color: '#fbbf24', min: 0, max: 500, enabled: true },
                                    ] },
                                ]}
                                channels={['drawworks.hook_load', 'drilling.rop', 'mudpump.spm', 'mudpump.pressure']}
                            />
                        </ErrorBoundary>
                    </Box>
                )}
            </Paper>

            {/* OPERATIONS & MAINTENANCE LOG for the selected run (well history). */}
            {selectedRun && runLog?.available && (
                <Paper sx={{ p: 1.5, mb: 1 }}>
                    <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap mb={1.5}>
                        <Typography variant="h6" sx={{ flexGrow: 1 }}>Operations &amp; maintenance log</Typography>
                        {runLog.activity?.totals && (
                            <Stack direction="row" spacing={1}>
                                <Chip size="small" label={`Productive ${runLog.activity.totals.prodPct ?? 0}%`}
                                    sx={{ bgcolor: '#22c55e22', color: '#22c55e', fontWeight: 700 }} />
                                <Chip size="small" label={`NPT ${runLog.activity.totals.nptPct ?? 0}%`}
                                    sx={{ bgcolor: '#ef444422', color: '#ef4444', fontWeight: 700 }} />
                            </Stack>
                        )}
                    </Stack>

                    {/* Per-operation time split for the run. */}
                    {Array.isArray(runLog.activity?.byPhase) && runLog.activity.byPhase.length > 0 && (
                        <Stack direction="row" spacing={1} mb={1.5} flexWrap="wrap" useFlexGap>
                            {runLog.activity.byPhase.map((pph) => (
                                <Chip key={pph.phase} size="small" variant="outlined"
                                    label={`${pph.label || pph.phase} · ${fmtDuration(pph.durationSec)} (${pph.pct}%)`} />
                            ))}
                        </Stack>
                    )}

                    <Grid container spacing={1.5}>
                        {/* Operations log — the rig's activity segments over the run window. */}
                        <Grid item xs={12} lg={6}>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Operations log</Typography>
                            <TableContainer sx={{ maxHeight: 300 }}>
                                <Table size="small" stickyHeader>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Start</TableCell>
                                            <TableCell>Operation</TableCell>
                                            <TableCell>Duration</TableCell>
                                            <TableCell>Class</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {(runLog.activity?.segments || []).slice().reverse().slice(0, 200).map((seg, i) => (
                                            <TableRow key={i} hover>
                                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(seg.start)}</TableCell>
                                                <TableCell sx={{ fontWeight: 700 }}>{seg.label || seg.phase}{seg.nptReason ? ` — ${seg.nptReason}` : ''}</TableCell>
                                                <TableCell>{fmtDuration(seg.durationSec)}</TableCell>
                                                <TableCell>
                                                    <Chip size="small" label={seg.productive ? 'PROD' : (seg.npt ? 'NPT' : 'OTHER')}
                                                        sx={{ fontWeight: 700, fontSize: 10,
                                                              bgcolor: seg.productive ? '#22c55e22' : (seg.npt ? '#ef444422' : '#64748b22'),
                                                              color: seg.productive ? '#22c55e' : (seg.npt ? '#ef4444' : '#94a3b8') }} />
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                        {!(runLog.activity?.segments || []).length && (
                                            <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No activity recorded in this run window.</TableCell></TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Grid>

                        {/* Maintenance log + downtime for the rig during the run. */}
                        <Grid item xs={12} lg={6}>
                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Maintenance log</Typography>
                            <TableContainer sx={{ maxHeight: 140, mb: 1.5 }}>
                                <Table size="small" stickyHeader>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Time</TableCell>
                                            <TableCell>Notification</TableCell>
                                            <TableCell>Asset</TableCell>
                                            <TableCell>Entry</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {(runLog.maintenance || []).map((m2) => (
                                            <TableRow key={m2.entryId} hover>
                                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(m2.ts)}</TableCell>
                                                <TableCell>{m2.notificationNo ? <Chip size="small" label={m2.notificationNo} sx={{ fontFamily: 'monospace', fontSize: 10 }} /> : '—'}</TableCell>
                                                <TableCell>{m2.asset || m2.assetId || '—'}</TableCell>
                                                <TableCell>{m2.text || '—'}</TableCell>
                                            </TableRow>
                                        ))}
                                        {!(runLog.maintenance || []).length && (
                                            <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No maintenance entries in this run window.</TableCell></TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>

                            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Downtime / NPT</Typography>
                            <TableContainer sx={{ maxHeight: 140 }}>
                                <Table size="small" stickyHeader>
                                    <TableHead>
                                        <TableRow>
                                            <TableCell>Start</TableCell>
                                            <TableCell>Duration</TableCell>
                                            <TableCell>Asset</TableCell>
                                            <TableCell>Reason</TableCell>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {(runLog.downtime || []).map((d2) => (
                                            <TableRow key={d2.recordId} hover>
                                                <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(d2.start)}</TableCell>
                                                <TableCell>{d2.durationMin != null ? `${fmtNum(d2.durationMin, 0)} min` : (d2.end ? '—' : 'OPEN')}</TableCell>
                                                <TableCell>{d2.asset || d2.assetId || '—'}</TableCell>
                                                <TableCell>{d2.reasonCode || d2.notes || '—'}</TableCell>
                                            </TableRow>
                                        ))}
                                        {!(runLog.downtime || []).length && (
                                            <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No downtime in this run window.</TableCell></TableRow>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Grid>
                    </Grid>
                </Paper>
            )}
        </Box>
    );
}

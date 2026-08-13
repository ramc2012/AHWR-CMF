import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Box, Typography, Paper, Stack, Chip, Tabs, Tab, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, Alert, CircularProgress, Tooltip,
} from '@mui/material';
import { api } from '../../../api';

// Fleet-side Maintenance view for ONE rig, rendered from the CMMS snapshot the
// rig edge ships (event `cmms.snapshot` -> table rig_cmms). The edge remains the
// system of record — this is read-only mirror, consistent with the platform's
// monitoring-only contract. Nothing here can write back to a rig.

const PM_COLOR = { overdue: '#ef4444', 'due-soon': '#f59e0b', ok: '#22c55e' };
const PM_LABEL = { overdue: 'Overdue', 'due-soon': 'Due Soon', ok: 'OK' };
const pmColor = (s) => PM_COLOR[s] || '#64748b';

const fmtTs = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—'
        : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const fmtNum = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const fmtMin = (m) => (Number.isFinite(Number(m)) ? `${Math.round(Number(m))} min` : '—');

function Kpi({ label, value, color }) {
    return (
        <Paper sx={{ px: 2, py: 1.25, minWidth: 132, textAlign: 'center', border: `1px solid ${color || '#334155'}` }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, fontSize: 10.5 }}>{label}</Typography>
            <Typography variant="h5" sx={{ color: color || 'text.primary', fontWeight: 800, lineHeight: 1.25 }}>
                {value == null ? '—' : value}
            </Typography>
        </Paper>
    );
}

// Equipment health tile — kept on ONE horizontally scrolling row so the whole
// rig is comparable at a glance (same layout rule as the edge HMI).
function AssetTile({ asset }) {
    const c = pmColor(asset.pmStatus);
    return (
        <Paper sx={{ p: 1.5, flex: '0 0 240px', minWidth: 240, borderLeft: `3px solid ${c}`, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap sx={{ fontWeight: 800 }}>{asset.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{asset.category}</Typography>
                </Box>
                <Chip size="small" label={PM_LABEL[asset.pmStatus] || asset.pmStatus || '—'}
                    sx={{ height: 20, bgcolor: `${c}22`, color: c, border: `1px solid ${c}55`, fontWeight: 700 }} />
            </Stack>
            <Stack direction="row" alignItems="baseline" spacing={1}>
                <Typography variant="h6" sx={{ color: '#38bdf8', fontWeight: 800 }}>{fmtNum(asset.hours, 0)} h</Typography>
                <Chip size="small" label={asset.source === 'measured' ? 'measured' : 'derived'}
                    sx={{ height: 17, fontSize: 10, bgcolor: asset.source === 'measured' ? '#22c55e22' : '#94a3b822', color: asset.source === 'measured' ? '#22c55e' : '#94a3b8' }} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
                next due in <span style={{ color: c, fontWeight: 700 }}>{fmtNum(asset.nextDueInHours, 0)} h</span>
            </Typography>
            {Array.isArray(asset.health) && asset.health.length > 0 && (
                <Box sx={{ pt: 0.75, mt: 'auto', borderTop: '1px solid', borderColor: 'divider' }}>
                    {asset.health.map((h, i) => (
                        <Stack key={`${h.label}-${i}`} direction="row" justifyContent="space-between">
                            <Typography variant="caption" color="text.secondary">{h.label}</Typography>
                            <Typography variant="caption" sx={{ fontWeight: 700 }}>{fmtNum(h.value, 2)}</Typography>
                        </Stack>
                    ))}
                </Box>
            )}
            {asset.openDowntime > 0 && (
                <Chip size="small" label={`${asset.openDowntime} open DT`}
                    sx={{ height: 19, alignSelf: 'flex-start', bgcolor: '#ef444422', color: '#ef4444', fontWeight: 700 }} />
            )}
        </Paper>
    );
}

const headSx = { fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'text.secondary' };

function EmptyRow({ span, children }) {
    return <TableRow><TableCell colSpan={span}><Typography variant="body2" color="text.secondary">{children}</Typography></TableCell></TableRow>;
}

export default function RigMaintenancePanel({ rigId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState('');
    const [tab, setTab] = useState(0);

    const load = useCallback(() => {
        if (!rigId) return;
        api.rigCmms(rigId)
            .then((d) => { setData(d); setErr(''); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance data'); })
            .finally(() => setLoading(false));
    }, [rigId]);

    useEffect(() => { setLoading(true); load(); }, [load]);
    useEffect(() => {
        const t = setInterval(load, 30000);   // snapshots arrive ~1/min from the edge
        return () => clearInterval(t);
    }, [load]);

    const assets = useMemo(() => (Array.isArray(data?.assets) ? data.assets : []), [data]);
    const counts = data?.counts || {};
    const wo = data?.cmmsSummary?.workOrders || {};
    const downtime = useMemo(() => (Array.isArray(data?.downtime) ? data.downtime : []), [data]);
    const logbook = useMemo(() => (Array.isArray(data?.logbook) ? data.logbook : []), [data]);
    const workOrders = useMemo(() => (Array.isArray(data?.workOrders) ? data.workOrders : []), [data]);
    const pm = useMemo(() => (Array.isArray(data?.pm) ? data.pm : []), [data]);
    const instruments = useMemo(() => (Array.isArray(data?.instruments) ? data.instruments : []), [data]);

    if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;

    // An edge that has not yet shipped a snapshot is a normal state (older edge
    // build, or a rig that just came online) — say so plainly rather than
    // rendering an empty shell that looks like a fault.
    if (!data?.available) {
        return (
            <Alert severity="info" sx={{ mt: 1 }}>
                No maintenance snapshot received from <strong>{rigId}</strong> yet. The rig edge ships its CMMS
                (asset health, PM, work orders, maintenance log, downtime, instruments) about once a minute once it is running a build that supports it.
            </Alert>
        );
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
            {err && <Alert severity="error" onClose={() => setErr('')}>{err}</Alert>}

            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                <Kpi label="PM Overdue" value={counts.overdue} color="#ef4444" />
                <Kpi label="PM Due Soon" value={counts.dueSoon} color="#f59e0b" />
                <Kpi label="Open WOs" value={wo.open} color="#38bdf8" />
                <Kpi label="Breakdowns" value={wo.breakdownOpen} color="#ef4444" />
                <Kpi label="Open Downtime" value={counts.openDowntime} color="#f97316" />
                <Kpi label="Instruments" value={data?.instrumentSummary?.total ?? instruments.length} color="#a78bfa" />
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title={`Snapshot generated ${fmtTs(data.generatedAt)} · received ${fmtTs(data.receivedAt)}`}>
                    <Chip size="small" variant="outlined" label={`edge snapshot · ${fmtTs(data.generatedAt)}`} />
                </Tooltip>
            </Stack>

            {/* SINGLE ROW of equipment health tiles (scrolls horizontally). */}
            <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>Equipment health</Typography>
                <Box sx={{
                    display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1,
                    '&::-webkit-scrollbar': { height: 8 },
                    '&::-webkit-scrollbar-thumb': { bgcolor: 'divider', borderRadius: 4 },
                }}>
                    {assets.map((a) => <AssetTile key={a.id} asset={a} />)}
                    {assets.length === 0 && <Typography variant="body2" color="text.secondary">No equipment reported.</Typography>}
                </Box>
            </Box>

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
                    sx={{ borderBottom: '1px solid', borderColor: 'divider', minHeight: 44, '& .MuiTab-root': { minHeight: 44, textTransform: 'none' } }}>
                    <Tab label={`PM schedule (${pm.length})`} />
                    <Tab label={`Work orders (${workOrders.length})`} />
                    <Tab label={`Maintenance log (${logbook.length})`} />
                    <Tab label={`NPT / downtime (${downtime.length})`} />
                    <Tab label={`Instruments (${instruments.length})`} />
                </Tabs>

                <TableContainer sx={{ flex: 1, minHeight: 0 }}>
                    {tab === 0 && (
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell sx={headSx}>Equipment</TableCell><TableCell sx={headSx}>Task</TableCell>
                                <TableCell sx={headSx} align="right">Interval (h)</TableCell>
                                <TableCell sx={headSx} align="right">Due in (h)</TableCell>
                                <TableCell sx={headSx}>Status</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {pm.map((t, i) => (
                                    <TableRow key={t.id || i} hover>
                                        <TableCell>{t.assetName || t.assetId}</TableCell>
                                        <TableCell>{t.task || t.name || '—'}</TableCell>
                                        <TableCell align="right">{fmtNum(t.intervalH, 0)}</TableCell>
                                        <TableCell align="right" sx={{ color: pmColor(t.status), fontWeight: 700 }}>{fmtNum(t.dueInHours, 0)}</TableCell>
                                        <TableCell><Chip size="small" label={PM_LABEL[t.status] || t.status || '—'} sx={{ height: 20, bgcolor: `${pmColor(t.status)}22`, color: pmColor(t.status), fontWeight: 700 }} /></TableCell>
                                    </TableRow>
                                ))}
                                {pm.length === 0 && <EmptyRow span={5}>No PM tasks reported.</EmptyRow>}
                            </TableBody>
                        </Table>
                    )}

                    {tab === 1 && (
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell sx={headSx}>WO No.</TableCell><TableCell sx={headSx}>Type</TableCell>
                                <TableCell sx={headSx}>Equipment</TableCell><TableCell sx={headSx}>Title</TableCell>
                                <TableCell sx={headSx}>Priority</TableCell><TableCell sx={headSx}>Status</TableCell>
                                <TableCell sx={headSx}>Raised</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {workOrders.map((w, i) => (
                                    <TableRow key={w.id || i} hover>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{w.woNo || w.id || '—'}</TableCell>
                                        <TableCell>{w.type || '—'}</TableCell>
                                        <TableCell>{w.assetName || w.assetId || '—'}</TableCell>
                                        <TableCell>{w.title || '—'}</TableCell>
                                        <TableCell>{w.priority || '—'}</TableCell>
                                        <TableCell><Chip size="small" label={w.status || '—'} sx={{ height: 20, fontWeight: 700 }} /></TableCell>
                                        <TableCell>{fmtTs(w.raisedAt || w.createdAt)}</TableCell>
                                    </TableRow>
                                ))}
                                {workOrders.length === 0 && <EmptyRow span={7}>No work orders reported.</EmptyRow>}
                            </TableBody>
                        </Table>
                    )}

                    {tab === 2 && (
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell sx={headSx}>When</TableCell><TableCell sx={headSx}>Shift</TableCell>
                                <TableCell sx={headSx}>Category</TableCell><TableCell sx={headSx}>Equipment</TableCell>
                                <TableCell sx={headSx}>Notification</TableCell><TableCell sx={headSx}>Entry</TableCell>
                                <TableCell sx={headSx}>By</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {logbook.map((l, i) => (
                                    <TableRow key={l.id || i} hover>
                                        <TableCell>{fmtTs(l.ts || l.date)}</TableCell>
                                        <TableCell>{l.shift || '—'}</TableCell>
                                        <TableCell>{l.category || l.logType || '—'}</TableCell>
                                        <TableCell>{l.assetId || '—'}</TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{l.notificationNo || l.workOrderNo || '—'}</TableCell>
                                        <TableCell>{l.entry || '—'}</TableCell>
                                        <TableCell>{l.by || '—'}</TableCell>
                                    </TableRow>
                                ))}
                                {logbook.length === 0 && <EmptyRow span={7}>No log entries reported.</EmptyRow>}
                            </TableBody>
                        </Table>
                    )}

                    {tab === 3 && (
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell sx={headSx}>Start</TableCell><TableCell sx={headSx}>End</TableCell>
                                <TableCell sx={headSx} align="right">Duration</TableCell>
                                <TableCell sx={headSx}>Equipment</TableCell><TableCell sx={headSx}>Reason</TableCell>
                                <TableCell sx={headSx}>Notification</TableCell><TableCell sx={headSx}>Notes</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {downtime.map((d, i) => (
                                    <TableRow key={d.id || i} hover>
                                        <TableCell>{fmtTs(d.start)}</TableCell>
                                        <TableCell>{d.end ? fmtTs(d.end) : <Chip size="small" label="OPEN" sx={{ height: 20, bgcolor: '#f9731622', color: '#f97316', fontWeight: 700 }} />}</TableCell>
                                        <TableCell align="right">{d.end ? fmtMin(d.durationMin) : '—'}</TableCell>
                                        <TableCell>{d.assetId || '—'}</TableCell>
                                        <TableCell>{d.reasonCode || '—'}</TableCell>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{d.notificationNo || '—'}</TableCell>
                                        <TableCell>{d.notes || '—'}</TableCell>
                                    </TableRow>
                                ))}
                                {downtime.length === 0 && <EmptyRow span={7}>No downtime reported.</EmptyRow>}
                            </TableBody>
                        </Table>
                    )}

                    {tab === 4 && (
                        <Table size="small" stickyHeader>
                            <TableHead><TableRow>
                                <TableCell sx={headSx}>Tag</TableCell><TableCell sx={headSx}>Instrument</TableCell>
                                <TableCell sx={headSx}>Type</TableCell><TableCell sx={headSx}>Last cal.</TableCell>
                                <TableCell sx={headSx}>Next due</TableCell><TableCell sx={headSx}>Status</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {instruments.map((n, i) => (
                                    <TableRow key={n.id || i} hover>
                                        <TableCell sx={{ fontFamily: 'monospace' }}>{n.tag || n.id || '—'}</TableCell>
                                        <TableCell>{n.name || '—'}</TableCell>
                                        <TableCell>{n.type || '—'}</TableCell>
                                        <TableCell>{fmtTs(n.lastCalDate)}</TableCell>
                                        <TableCell>{fmtTs(n.nextCalDate || n.nextDueDate)}</TableCell>
                                        <TableCell><Chip size="small" label={n.calStatus || '—'} sx={{ height: 20, fontWeight: 700 }} /></TableCell>
                                    </TableRow>
                                ))}
                                {instruments.length === 0 && <EmptyRow span={6}>No instruments reported.</EmptyRow>}
                            </TableBody>
                        </Table>
                    )}
                </TableContainer>
            </Paper>
        </Box>
    );
}

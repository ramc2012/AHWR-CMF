import React, { useMemo, useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography,
    Stack, Chip, Tabs, Tab, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, Alert,
} from '@mui/material';

// Per-asset drill-down for the fleet-side Maintenance view: click an equipment
// health tile to see that ONE asset's run-hour history, maintenance-log history
// and NPT/downtime history.
//
// Everything here is DERIVED from the CMMS snapshot the rig edge already shipped
// (rig_cmms.snapshot) — central issues no new per-asset query and, being the
// read-only mirror, can never write back to a rig. The edge's own dialog
// (frontend/src/components/Maintenance/AssetHistoryDialog.jsx) is the live
// equivalent; this one shows the last snapshot the rig sent.

const PM_COLOR = { overdue: '#ef4444', 'due-soon': '#f59e0b', ok: '#22c55e' };

const fmtTs = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '—'
        : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtNum = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const cellSx = { fontSize: 12.5, py: 0.75 };

// An asset matches a log/downtime row by id OR display name: the edge writes
// assetId on structured records, but free-text logbook entries may only name it.
function matchesAsset(row, asset) {
    if (!row || !asset) return false;
    const id = String(row.assetId || row.asset_id || '').toLowerCase();
    if (id && id === String(asset.id).toLowerCase()) return true;
    const named = String(row.asset || row.equipment || '').toLowerCase();
    if (named && named === String(asset.name).toLowerCase()) return true;
    // Last resort for free-text entries: the asset name appearing in the text.
    const text = String(row.text || row.note || row.notes || '').toLowerCase();
    return Boolean(asset.name) && text.includes(String(asset.name).toLowerCase());
}

export default function AssetHistoryDialog({ asset, snapshot, open, onClose }) {
    const [tab, setTab] = useState(0);

    // Per-day run hours for THIS asset, newest first. The snapshot's runHours is
    // [{ date, assets: { <assetId>: hours } }].
    const runRows = useMemo(() => {
        const days = Array.isArray(snapshot?.runHours) ? snapshot.runHours : [];
        return days
            .map((d) => ({ date: d.date, hours: Number(d?.assets?.[asset?.id]) }))
            .filter((r) => Number.isFinite(r.hours))
            .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    }, [snapshot, asset]);

    const maintRows = useMemo(() => {
        const log = Array.isArray(snapshot?.logbook) ? snapshot.logbook : [];
        const wos = Array.isArray(snapshot?.workOrders) ? snapshot.workOrders : [];
        return [
            ...log.filter((l) => String(l.logType || '').toUpperCase() !== 'OPERATIONS' && matchesAsset(l, asset))
                .map((l) => ({ kind: 'LOG', at: l.at || l.ts, text: l.text, by: l.by, ref: l.notificationNo || l.woNo || '—' })),
            ...wos.filter((w) => matchesAsset(w, asset))
                .map((w) => ({ kind: w.type || 'WO', at: w.raisedAt, text: w.title, by: w.assignedTo, ref: w.notificationNo || w.woNo || '—' })),
        ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    }, [snapshot, asset]);

    const nptRows = useMemo(() => {
        const dt = Array.isArray(snapshot?.downtime) ? snapshot.downtime : [];
        return dt.filter((d) => matchesAsset(d, asset))
            .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
    }, [snapshot, asset]);

    if (!asset) return null;
    const c = PM_COLOR[asset.pmStatus] || '#64748b';
    const totalRunH = runRows.reduce((s, r) => s + r.hours, 0);

    const Empty = ({ what }) => (
        <Alert severity="info" variant="outlined" sx={{ m: 2 }}>
            No {what} for {asset.name} in the rig&apos;s latest snapshot.
        </Alert>
    );

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth
            PaperProps={{ sx: { bgcolor: 'background.paper', backgroundImage: 'none' } }}>
            <DialogTitle sx={{ pb: 1 }}>
                <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>{asset.name}</Typography>
                    <Chip size="small" label={asset.category} sx={{ height: 20 }} />
                    <Chip size="small" label={`${fmtNum(asset.hours, 0)} h`}
                        sx={{ height: 20, bgcolor: '#38bdf822', color: '#38bdf8', fontWeight: 700 }} />
                    <Chip size="small" label={asset.pmStatus || '—'}
                        sx={{ height: 20, bgcolor: `${c}22`, color: c, border: `1px solid ${c}55`, fontWeight: 700 }} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                    From the rig&apos;s last CMMS snapshot{snapshot?.generatedAt ? ` · ${fmtTs(snapshot.generatedAt)}` : ''} · read-only
                </Typography>
            </DialogTitle>
            <DialogContent dividers sx={{ p: 0 }}>
                <Tabs value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
                    sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
                    <Tab label={`Run hours (${runRows.length})`} sx={{ textTransform: 'none', minHeight: 44 }} />
                    <Tab label={`Maintenance log (${maintRows.length})`} sx={{ textTransform: 'none', minHeight: 44 }} />
                    <Tab label={`NPT / downtime (${nptRows.length})`} sx={{ textTransform: 'none', minHeight: 44 }} />
                </Tabs>

                {tab === 0 && (runRows.length ? (
                    <Box>
                        <Stack direction="row" spacing={2} sx={{ px: 2, py: 1.25 }}>
                            <Typography variant="caption" color="text.secondary">
                                Total over {runRows.length} day(s):&nbsp;
                                <strong style={{ color: '#38bdf8' }}>{fmtNum(totalRunH, 1)} h</strong>
                            </Typography>
                        </Stack>
                        <TableContainer>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={cellSx}>Date</TableCell>
                                        <TableCell sx={cellSx} align="right">Hours run</TableCell>
                                        <TableCell sx={cellSx}>Utilisation</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {runRows.map((r) => (
                                        <TableRow key={r.date} hover>
                                            <TableCell sx={cellSx}>{r.date}</TableCell>
                                            <TableCell sx={cellSx} align="right"><strong>{fmtNum(r.hours, 1)}</strong></TableCell>
                                            <TableCell sx={cellSx}>
                                                <Box sx={{ width: 160, height: 8, bgcolor: '#94a3b822', borderRadius: 1 }}>
                                                    <Box sx={{ width: `${Math.min(100, (r.hours / 24) * 100)}%`, height: '100%', bgcolor: '#38bdf8', borderRadius: 1 }} />
                                                </Box>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Box>
                ) : <Empty what="run-hour history" />)}

                {tab === 1 && (maintRows.length ? (
                    <TableContainer>
                        <Table size="small" stickyHeader>
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={cellSx}>When</TableCell>
                                    <TableCell sx={cellSx}>Type</TableCell>
                                    <TableCell sx={cellSx}>Notification / WO</TableCell>
                                    <TableCell sx={cellSx}>Detail</TableCell>
                                    <TableCell sx={cellSx}>By</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {maintRows.map((m, i) => (
                                    <TableRow key={`${m.ref}-${i}`} hover>
                                        <TableCell sx={cellSx}>{fmtTs(m.at)}</TableCell>
                                        <TableCell sx={cellSx}>
                                            <Chip size="small" label={m.kind} sx={{ height: 20, fontWeight: 700 }} />
                                        </TableCell>
                                        <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }}>{m.ref}</TableCell>
                                        <TableCell sx={cellSx}>{m.text || '—'}</TableCell>
                                        <TableCell sx={cellSx}>{m.by || '—'}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                ) : <Empty what="maintenance-log history" />)}

                {tab === 2 && (nptRows.length ? (
                    <TableContainer>
                        <Table size="small" stickyHeader>
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={cellSx}>Start</TableCell>
                                    <TableCell sx={cellSx}>End</TableCell>
                                    <TableCell sx={cellSx} align="right">Duration (min)</TableCell>
                                    <TableCell sx={cellSx}>Reason</TableCell>
                                    <TableCell sx={cellSx}>Notes</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {nptRows.map((d, i) => (
                                    <TableRow key={d.id || i} hover>
                                        <TableCell sx={cellSx}>{fmtTs(d.start)}</TableCell>
                                        <TableCell sx={cellSx}>
                                            {d.end ? fmtTs(d.end)
                                                : <Chip size="small" label="OPEN" sx={{ height: 20, bgcolor: '#f9731622', color: '#f97316', fontWeight: 700 }} />}
                                        </TableCell>
                                        <TableCell sx={cellSx} align="right">{d.durationMin != null ? fmtNum(d.durationMin, 0) : '—'}</TableCell>
                                        <TableCell sx={cellSx}>{d.reasonCode || d.reason || '—'}</TableCell>
                                        <TableCell sx={cellSx}>{d.notes || '—'}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                ) : <Empty what="NPT / downtime history" />)}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Stack, Chip, TextField, InputAdornment, Select, MenuItem,
    FormControl, InputLabel, Button, Dialog, DialogTitle, DialogContent, DialogActions,
    IconButton, Tooltip, Alert,
} from '@mui/material';
import { Search, Add, DeleteOutline } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { KpiCard, fmtNum } from './common';

// Well lifecycle status palette (StatusChip's STATUS_COLOR is rig-liveness oriented and
// doesn't fit well-status, so we keep a small local map keyed by lifecycle stage).
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
const WELL_STATUSES = ['active', 'planned', 'drilling', 'completed', 'producing', 'workover', 'suspended', 'abandoned'];
const WELL_TYPES = ['production', 'injection', 'exploration', 'appraisal', 'workover'];

function WellStatusChip({ status, size = 'small' }) {
    const c = WELL_STATUS_COLOR[status] || '#64748b';
    const label = (status || 'unknown').toUpperCase();
    return (
        <Chip size={size} label={label}
            sx={{ bgcolor: c + '22', color: c, border: `1px solid ${c}55`, fontWeight: 700, letterSpacing: 0.4 }} />
    );
}

// Compact clickable well tile. Top line carries name + UWI; a row of meta chips sits below
// (type, status coloured by lifecycle, asset unit, total depth, current rig). Admin gets a
// delete control in the corner. Clicking the body opens the well detail.
function WellTile({ well, canAdmin, onOpen, onDelete }) {
    const c = WELL_STATUS_COLOR[well.status] || '#64748b';
    const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
    return (
        <Paper
            role="button"
            tabIndex={0}
            aria-label={`Open well ${well.name}`}
            onClick={onOpen}
            onKeyDown={onKeyDown}
            sx={{
                p: 1.25, height: '100%', display: 'flex', flexDirection: 'column', gap: 0.75,
                cursor: 'pointer', borderLeft: `3px solid ${c}`, bgcolor: `${c}0d`,
                transition: 'transform 120ms ease, box-shadow 120ms ease',
                '&:hover': { transform: 'translateY(-1px)', boxShadow: `0 0 0 1px ${c}55` },
                '&:focus-visible': { outline: `2px solid ${c}`, outlineOffset: 2 },
            }}
        >
            <Stack direction="row" alignItems="flex-start" spacing={1}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 800, lineHeight: 1.2 }}>{well.name}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: 'monospace', display: 'block' }}>
                        {well.uwi || '—'}
                    </Typography>
                </Box>
                {well.activeRun && <Tooltip title="Active run"><Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#22c55e', mt: 0.5, flex: '0 0 auto' }} /></Tooltip>}
                {canAdmin && (
                    <Tooltip title="Delete well">
                        <IconButton size="small" color="error"
                            onClick={(e) => { e.stopPropagation(); onDelete(); }}
                            sx={{ mt: -0.5, mr: -0.5 }}>
                            <DeleteOutline fontSize="small" />
                        </IconButton>
                    </Tooltip>
                )}
            </Stack>

            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
                {(well.serviceType || well.wellType) && <Chip size="small" variant="outlined" label={well.serviceType || well.wellType} />}
                <WellStatusChip status={well.status} />
            </Stack>

            <Stack direction="row" spacing={2} sx={{ mt: 'auto', pt: 0.5 }}>
                <MetaCol label="Asset" value={well.assetUnit || well.field || '—'} />
                <MetaCol label="TD" value={well.totalDepth != null ? `${fmtNum(well.totalDepth, 0)} m` : '—'} />
                <MetaCol label="Rig" value={well.currentRigId || '—'} mono />
            </Stack>
        </Paper>
    );
}

function MetaCol({ label, value, mono }) {
    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 }}>{label}</Typography>
            <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 700, fontFamily: mono ? 'monospace' : undefined }}>{value}</Typography>
        </Box>
    );
}

const BLANK_DRAFT = {
    wellId: '', name: '', uwi: '', wellType: 'production', status: 'planned',
    field: '', assetUnit: '', latitude: '', longitude: '', spudDate: '', totalDepth: '',
    operator: '', blockLease: '',
};

export default function Wells() {
    const nav = useNavigate();
    const { can } = useAuth();
    const canAdmin = can('admin');

    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState('');

    const [unit, setUnit] = useState('all');
    const [status, setStatus] = useState('all');
    const [type, setType] = useState('all');
    const [q, setQ] = useState('');

    const [addOpen, setAddOpen] = useState(false);
    const [draft, setDraft] = useState(BLANK_DRAFT);
    const [saving, setSaving] = useState(false);

    const load = useCallback(() => {
        setErr('');
        api.wells()
            .then((w) => setRows(Array.isArray(w) ? w : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load wells'); })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { setLoading(true); load(); }, [load]);

    const units = useMemo(() => {
        const set = new Set(rows.map((r) => r.assetUnit || r.field).filter(Boolean));
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [rows]);

    const filtered = useMemo(() => rows.filter((r) => {
        if (unit !== 'all' && (r.assetUnit || r.field) !== unit) return false;
        if (status !== 'all' && r.status !== status) return false;
        if (type !== 'all' && r.wellType !== type) return false;
        if (q && !(`${r.name} ${r.uwi || ''} ${r.wellId} ${r.assetUnit || r.field || ''} ${r.currentRigId || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
        return true;
    }), [rows, unit, status, type, q]);

    // KPI counts span the full (unfiltered) set so the row stays a stable fleet summary.
    const counts = useMemo(() => {
        const c = { total: rows.length, producing: 0, workover: 0, abandoned: 0, planned: 0 };
        rows.forEach((r) => { if (c[r.status] != null) c[r.status] += 1; });
        return c;
    }, [rows]);

    const addWell = async () => {
        if (!draft.wellId || !draft.name) return;
        setSaving(true);
        setErr('');
        // Only send filled-in fields; coerce numerics so blanks don't post empty strings.
        const body = { wellId: draft.wellId.trim(), name: draft.name.trim() };
        for (const k of ['uwi', 'wellType', 'status', 'field', 'assetUnit', 'operator', 'blockLease']) {
            if (draft[k] !== '' && draft[k] != null) body[k] = draft[k];
        }
        for (const k of ['latitude', 'longitude', 'totalDepth']) {
            if (draft[k] !== '' && draft[k] != null && !Number.isNaN(Number(draft[k]))) body[k] = Number(draft[k]);
        }
        if (draft.spudDate) body.spudDate = draft.spudDate;
        try {
            await api.addWell(body);
            setAddOpen(false);
            setDraft(BLANK_DRAFT);
            load();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to add well');
        } finally {
            setSaving(false);
        }
    };

    const deleteWell = async (well) => {
        if (!window.confirm(`Delete well "${well.name}" (${well.wellId})? This cannot be undone.`)) return;
        setErr('');
        try { await api.deleteWell(well.wellId); load(); }
        catch (e) { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to delete well'); }
    };

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2}>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Wells</Typography>
                {canAdmin && <Button variant="contained" startIcon={<Add />} onClick={() => { setDraft(BLANK_DRAFT); setAddOpen(true); }}>Add well</Button>}
            </Stack>

            {/* KPI row — fleet-wide well counts by lifecycle stage. */}
            <Stack direction="row" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <KpiCard label="Total wells" value={counts.total} />
                <KpiCard label="Producing" value={counts.producing} color={WELL_STATUS_COLOR.producing} />
                <KpiCard label="Workover" value={counts.workover} color={WELL_STATUS_COLOR.workover} />
                <KpiCard label="Planned" value={counts.planned} color={WELL_STATUS_COLOR.planned} />
                <KpiCard label="Abandoned" value={counts.abandoned} color={WELL_STATUS_COLOR.abandoned} />
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {/* Filter controls. */}
                <Box sx={{ p: 1.5, flex: '0 0 auto' }}>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <TextField size="small" placeholder="Search name / UWI / rig" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 180 }}
                            InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
                        <FormControl size="small" sx={{ minWidth: 150 }}>
                            <InputLabel id="well-unit-label">Asset unit</InputLabel>
                            <Select labelId="well-unit-label" label="Asset unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                                <MenuItem value="all">All units</MenuItem>
                                {units.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <FormControl size="small" sx={{ minWidth: 140 }}>
                            <InputLabel id="well-status-label">Status</InputLabel>
                            <Select labelId="well-status-label" label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
                                <MenuItem value="all">All statuses</MenuItem>
                                {WELL_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <FormControl size="small" sx={{ minWidth: 140 }}>
                            <InputLabel id="well-type-label">Type</InputLabel>
                            <Select labelId="well-type-label" label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                                <MenuItem value="all">All types</MenuItem>
                                {WELL_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                            </Select>
                        </FormControl>
                    </Stack>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                        {filtered.length} well{filtered.length !== 1 ? 's' : ''}{filtered.length !== rows.length ? ` of ${rows.length}` : ''}
                    </Typography>
                </Box>

                {/* Tile grid. */}
                <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1.5 }}>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 1.25, alignItems: 'stretch' }}>
                        {filtered.map((w) => (
                            <WellTile key={w.wellId} well={w} canAdmin={canAdmin}
                                onOpen={() => nav('/wells/' + encodeURIComponent(w.wellId))}
                                onDelete={() => deleteWell(w)} />
                        ))}
                    </Box>
                    {!loading && !filtered.length && (
                        <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
                            <Typography variant="body2">{rows.length ? 'No wells match the filter.' : 'No wells registered yet.'}</Typography>
                        </Box>
                    )}
                    {loading && !rows.length && (
                        <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
                            <Typography variant="body2">Loading wells…</Typography>
                        </Box>
                    )}
                </Box>
            </Paper>

            {/* Add well (admin). */}
            <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>Add well</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={0.5}>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth required label="Well ID" value={draft.wellId} onChange={(e) => setDraft({ ...draft, wellId: e.target.value })} autoComplete="off" />
                            <TextField size="small" fullWidth required label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth label="UWI" value={draft.uwi} onChange={(e) => setDraft({ ...draft, uwi: e.target.value })} />
                            <FormControl size="small" fullWidth>
                                <InputLabel id="draft-type-label">Type</InputLabel>
                                <Select labelId="draft-type-label" label="Type" value={draft.wellType} onChange={(e) => setDraft({ ...draft, wellType: e.target.value })}>
                                    {WELL_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                </Select>
                            </FormControl>
                            <FormControl size="small" fullWidth>
                                <InputLabel id="draft-status-label">Status</InputLabel>
                                <Select labelId="draft-status-label" label="Status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                                    {WELL_STATUSES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth label="Field" value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })} />
                            <TextField size="small" fullWidth label="Asset unit" value={draft.assetUnit} onChange={(e) => setDraft({ ...draft, assetUnit: e.target.value })} />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth label="Operator" value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value })} />
                            <TextField size="small" fullWidth label="Block / lease" value={draft.blockLease} onChange={(e) => setDraft({ ...draft, blockLease: e.target.value })} />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth label="Latitude" type="number" value={draft.latitude} onChange={(e) => setDraft({ ...draft, latitude: e.target.value })} />
                            <TextField size="small" fullWidth label="Longitude" type="number" value={draft.longitude} onChange={(e) => setDraft({ ...draft, longitude: e.target.value })} />
                        </Stack>
                        <Stack direction="row" spacing={2}>
                            <TextField size="small" fullWidth label="Spud date" type="date" InputLabelProps={{ shrink: true }} value={draft.spudDate} onChange={(e) => setDraft({ ...draft, spudDate: e.target.value })} />
                            <TextField size="small" fullWidth label="Total depth (m)" type="number" value={draft.totalDepth} onChange={(e) => setDraft({ ...draft, totalDepth: e.target.value })} />
                        </Stack>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAddOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={addWell} disabled={saving || !draft.wellId || !draft.name}>{saving ? 'Saving…' : 'Add well'}</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

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

// Current OPERATION on the well — what the attached rig is doing right now
// (edge activity engine codes; also streamed by the fleet sim). This is the
// primary categorisation axis of the page; lifecycle status is secondary.
const OPERATION_META = {
    RIH:        { label: 'Running in',     color: '#27cfe6' },
    POOH:       { label: 'Pulling out',    color: '#ff9d2e' },
    MAKE_UP:    { label: 'Make-up',        color: '#a9ef34' },
    BREAK_OUT:  { label: 'Break-out',      color: '#ffc24b' },
    CIRCULATE:  { label: 'Circulation',    color: '#46a6ff' },
    SWAB:       { label: 'Swabbing',       color: '#9a8bff' },
    FISHING:    { label: 'Fishing',        color: '#b47aff' },
    MILLING:    { label: 'Milling',        color: '#f472b6' },
    CDR:        { label: 'CDR',            color: '#22d3ee' },
    WASH:       { label: 'Wash / cleanout', color: '#38bdf8' },
    PERFORATION:{ label: 'Perforation',    color: '#fb7185' },
    RIG_UP:     { label: 'Rig up',         color: '#23dd86' },
    RIG_DOWN:   { label: 'Rig down',       color: '#23dd86' },
    IDLE:       { label: 'Idle',           color: '#7c8aa0' },
    WAIT:       { label: 'Waiting (NPT)',  color: '#ff4a60' },
};
// Tile order: the operations that matter most to a workover fleet first.
const OPERATION_TILES = ['RIH', 'POOH', 'MAKE_UP', 'BREAK_OUT', 'CIRCULATE', 'MILLING', 'FISHING', 'CDR', 'SWAB', 'WASH', 'PERFORATION', 'WAIT'];
const opKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function OperationChip({ op, size = 'small' }) {
    const meta = OPERATION_META[opKey(op)];
    if (!meta) return null;
    return (
        <Chip size={size} label={meta.label.toUpperCase()}
            sx={{ bgcolor: meta.color + '22', color: meta.color, border: `1px solid ${meta.color}55`, fontWeight: 700, letterSpacing: 0.4 }} />
    );
}

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
                <OperationChip op={well.currentOperation} />
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
    const [op, setOp] = useState('all');
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
        if (op !== 'all' && (op === 'none' ? !!r.currentOperation : opKey(r.currentOperation) !== op)) return false;
        if (q && !(`${r.name} ${r.uwi || ''} ${r.wellId} ${r.assetUnit || r.field || ''} ${r.currentRigId || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
        return true;
    }), [rows, unit, status, type, op, q]);

    // KPI counts span the full (unfiltered) set so the row stays a stable fleet
    // summary. PRIMARY axis: current OPERATION — what is being done on each well
    // right now (running in, pulling out, milling, CDR, ...). Wells with no rig
    // on them have no operation; they land in the OFF-JOB bucket and are
    // summarised by lifecycle in the secondary line under the tiles.
    const counts = useMemo(() => {
        const ops = {};
        let onJob = 0;
        const lifecycle = { producing: 0, workover: 0, completed: 0, planned: 0, suspended: 0, abandoned: 0 };
        rows.forEach((r) => {
            if (r.currentOperation) {
                onJob += 1;
                const k = opKey(r.currentOperation);
                ops[k] = (ops[k] || 0) + 1;
            }
            const s = r.status === 'active' || r.status === 'drilling' ? 'workover' : r.status;
            if (lifecycle[s] != null) lifecycle[s] += 1;
        });
        return { total: rows.length, onJob, offJob: rows.length - onJob, ops, lifecycle };
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

            {/* KPI row — fleet-wide counts by CURRENT OPERATION (what each rig is
                doing on its well right now). A tile shows when its operation is
                live anywhere in the fleet; clicking it filters the list. */}
            <Stack direction="row" spacing={2} mb={1} flexWrap="wrap" useFlexGap>
                <Box onClick={() => setOp('all')} sx={{ cursor: 'pointer' }}>
                    <KpiCard label="Wells on job" value={counts.onJob} color="#22c55e" />
                </Box>
                {OPERATION_TILES.filter((k) => counts.ops[k]).map((k) => (
                    <Box key={k} onClick={() => setOp(op === k ? 'all' : k)} sx={{ cursor: 'pointer', opacity: op === 'all' || op === k ? 1 : 0.5 }}>
                        <KpiCard label={OPERATION_META[k].label} value={counts.ops[k]} color={OPERATION_META[k].color} />
                    </Box>
                ))}
                {Object.keys(counts.ops).filter((k) => !OPERATION_TILES.includes(k) && !['RIG_UP', 'RIG_DOWN', 'IDLE'].includes(k)).map((k) => (
                    <Box key={k} onClick={() => setOp(op === k ? 'all' : k)} sx={{ cursor: 'pointer', opacity: op === 'all' || op === k ? 1 : 0.5 }}>
                        <KpiCard label={OPERATION_META[k]?.label || k} value={counts.ops[k]} color={OPERATION_META[k]?.color || '#7c8aa0'} />
                    </Box>
                ))}
                {(counts.ops.RIG_UP || counts.ops.RIG_DOWN || counts.ops.IDLE) ? (
                    <KpiCard label="Rig up/down · idle" value={(counts.ops.RIG_UP || 0) + (counts.ops.RIG_DOWN || 0) + (counts.ops.IDLE || 0)} color="#7c8aa0" />
                ) : null}
                <Box onClick={() => setOp(op === 'none' ? 'all' : 'none')} sx={{ cursor: 'pointer', opacity: op === 'all' || op === 'none' ? 1 : 0.5 }}>
                    <KpiCard label="Off job" value={counts.offJob} color="#64748b" />
                </Box>
            </Stack>
            {/* Secondary line — lifecycle summary of the registry. */}
            <Stack direction="row" spacing={1.5} mb={2} flexWrap="wrap" useFlexGap alignItems="center">
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: 0.5 }}>
                    LIFECYCLE · {counts.total} wells
                </Typography>
                {['producing', 'workover', 'planned', 'completed', 'suspended', 'abandoned'].map((s) => (
                    counts.lifecycle[s] ? (
                        <Typography key={s} variant="caption" sx={{ color: WELL_STATUS_COLOR[s] || 'text.secondary', fontWeight: 700 }}>
                            {counts.lifecycle[s]} {s}
                        </Typography>
                    ) : null
                ))}
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
                        <FormControl size="small" sx={{ minWidth: 160 }}>
                            <InputLabel id="well-op-label">Operation</InputLabel>
                            <Select labelId="well-op-label" label="Operation" value={op} onChange={(e) => setOp(e.target.value)}>
                                <MenuItem value="all">All operations</MenuItem>
                                {Object.keys(OPERATION_META).map((k) => (
                                    <MenuItem key={k} value={k}>{OPERATION_META[k].label}</MenuItem>
                                ))}
                                <MenuItem value="none">Off job (no rig)</MenuItem>
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

import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Stack, ToggleButton, ToggleButtonGroup, TextField,
    InputAdornment, Chip, Select, MenuItem, FormControl, InputLabel,
} from '@mui/material';
import { Search } from '@mui/icons-material';
import { useFleet } from '../context/FleetContext';
import { PriorityChip } from './common';
import { STATUS_COLOR } from '../theme';
import FleetMap from './FleetMap';

const healthColor = (v) => (v >= 80 ? STATUS_COLOR.online : v >= 50 ? STATUS_COLOR.degraded : STATUS_COLOR.offline);

// Compact clickable rig tile, coloured by status. One line carries name · activity ·
// location; a short health bar + alarm sit below. Clicking zooms briefly then opens the rig.
function RigTile({ rig, onOpen }) {
    const [zoom, setZoom] = useState(false);
    const color = STATUS_COLOR[rig.status] || STATUS_COLOR.pending;
    const location = rig.assetUnit || rig.field || '—';
    const hv = Math.max(0, Math.min(100, rig.healthScore || 0));

    const open = () => { if (zoom) return; setZoom(true); setTimeout(() => onOpen(rig.rigId), 150); };
    const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };

    return (
        <Paper
            role="button"
            tabIndex={0}
            aria-label={`Open rig ${rig.name} (${rig.rigId})`}
            onClick={open}
            onKeyDown={onKeyDown}
            title={`${rig.name} · ${rig.activeActivity || '—'} · ${location}`}
            sx={{
                px: 1, py: 0.85, height: '100%', display: 'flex', flexDirection: 'column', gap: 0.5,
                cursor: 'pointer', borderLeft: `3px solid ${color}`, bgcolor: `${color}0d`,
                transition: 'transform 150ms ease, box-shadow 150ms ease',
                transform: zoom ? 'scale(1.05)' : 'scale(1)',
                boxShadow: zoom ? `0 0 0 1px ${color}88, 0 8px 22px rgba(0,0,0,0.45)` : 'none',
                '&:hover': { transform: zoom ? 'scale(1.05)' : 'translateY(-1px)', boxShadow: `0 0 0 1px ${color}55` },
                '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: 2 },
            }}
        >
            {/* One line: rig name · activity · location. */}
            <Typography variant="body2" noWrap sx={{ lineHeight: 1.2 }}>
                <Box component="span" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color, display: 'inline-block', mr: 0.6, verticalAlign: 'middle' }} />
                <Box component="span" sx={{ fontWeight: 800 }}>{rig.name}</Box>
                <Box component="span" sx={{ color: 'text.secondary' }}> · {rig.activeActivity || '—'} · {location}</Box>
            </Typography>

            {/* Short health bar + alarm. */}
            <Stack direction="row" alignItems="center" spacing={0.75}>
                <Box sx={{ width: 56, height: 5, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden', flex: '0 0 auto' }}>
                    <Box sx={{ width: `${hv}%`, height: '100%', bgcolor: healthColor(hv) }} />
                </Box>
                <Typography variant="caption" sx={{ color: healthColor(hv), fontWeight: 700, width: 22 }}>{hv}</Typography>
                <Box sx={{ flexGrow: 1 }} />
                {rig.alarm?.highest
                    ? <PriorityChip priority={rig.alarm.highest} />
                    : <Box component="span" sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: STATUS_COLOR.online, opacity: 0.5 }} />}
            </Stack>
        </Paper>
    );
}

export default function FleetOverview() {
    const { fleet } = useFleet();
    const nav = useNavigate();
    const [filter, setFilter] = useState('all');
    const [unit, setUnit] = useState('all');
    const [q, setQ] = useState('');

    const units = useMemo(() => {
        const set = new Set(fleet.map((r) => r.assetUnit || r.field).filter(Boolean));
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [fleet]);

    const rows = useMemo(() => fleet.filter((r) => {
        if (filter !== 'all' && r.status !== filter) return false;
        if (unit !== 'all' && (r.assetUnit || r.field) !== unit) return false;
        if (q && !(`${r.name} ${r.rigId} ${r.assetUnit || r.field || ''} ${r.activeJob || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
        return true;
    }), [fleet, filter, unit, q]);

    return (
        // Full-height two-pane: interactive map (left) + rig tiles (right). The status
        // bubbles in the top app bar already carry the fleet KPIs, so no redundant cards.
        <Box sx={{ height: '100%', display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, minHeight: 0 }}>
            {/* LEFT — smaller interactive pan/zoom map; click a marker to open the rig. */}
            <Box sx={{ flex: { md: '0.85 1 0' }, minHeight: { xs: 300, md: 0 }, display: 'flex' }}>
                <FleetMap rigs={fleet} />
            </Box>

            {/* RIGHT — denser grid of compact rig tiles, filling the (now larger) pane. */}
            <Box sx={{ flex: { md: '1.7 1 0' }, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <Box sx={{ p: 1.5, flex: '0 0 auto' }}>
                        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
                            <Typography variant="h6">Fleet — {rows.length} rig{rows.length !== 1 ? 's' : ''}</Typography>
                        </Stack>
                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                            <TextField size="small" placeholder="Search rig / unit / job" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 160 }}
                                InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
                            <FormControl size="small" sx={{ minWidth: 150 }}>
                                <InputLabel id="asset-unit-label">Asset unit</InputLabel>
                                <Select labelId="asset-unit-label" label="Asset unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                                    <MenuItem value="all">All units</MenuItem>
                                    {units.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Stack>
                        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)} sx={{ mt: 1, flexWrap: 'wrap' }}>
                            <ToggleButton value="all">All</ToggleButton>
                            <ToggleButton value="online">Online</ToggleButton>
                            <ToggleButton value="degraded">Degraded</ToggleButton>
                            <ToggleButton value="offline">Offline</ToggleButton>
                            <ToggleButton value="pending">Pending</ToggleButton>
                        </ToggleButtonGroup>
                    </Box>

                    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1.5 }}>
                        {/* Container-relative grid: many compact tiles per row. */}
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 1, alignItems: 'stretch' }}>
                            {rows.map((r) => <RigTile key={r.rigId} rig={r} onOpen={(id) => nav(`/rigs/${id}`)} />)}
                        </Box>
                        {!rows.length && (
                            <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
                                <Typography variant="body2">No rigs match the filter.</Typography>
                            </Box>
                        )}
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}

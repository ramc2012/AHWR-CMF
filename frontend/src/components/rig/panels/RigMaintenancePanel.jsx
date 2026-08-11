import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
    Box, Paper, Typography, Chip, Stack, Alert, Button,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
} from '@mui/material';
import { FavoriteBorder, Build, Tune } from '@mui/icons-material';
import { api } from '../../../api';
import { useRigData } from '../../../context/RigDataContext';

const BG = '#071225';
const PANEL = '#263447';
const BORDER = '#344963';
const BLUE = '#29b6ff';
const GREEN = '#22e070';
const YELLOW = '#ffb300';
const RED = '#ff3f4b';
const TEXT = '#eaf3ff';
const MUTED = '#9fb4d1';

const fmt = (v, d = 2) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '0.00';
};

function hoursUntil(next, current) {
    return Number(next || 0) - Number(current || 0);
}

function nextDueHour(current, interval, fallbackNext) {
    const cur = Math.max(0, Number(current) || 0);
    const intv = Math.max(1, Number(interval) || 1);
    const configured = Number(fallbackNext);
    if (Number.isFinite(configured) && configured > cur) return configured;
    return Math.ceil((cur + 0.001) / intv) * intv;
}

function dueUsedPct(current, next, interval) {
    const cur = Math.max(0, Number(current) || 0);
    const nxt = Math.max(cur, Number(next) || cur);
    const intv = Math.max(1, Number(interval) || 1);
    const last = Math.max(0, nxt - intv);
    return Math.min(100, Math.max(0, ((cur - last) / intv) * 100));
}

function healthScore(dueIn, interval, downtime = 0) {
    const used = 100 - Math.min(100, Math.max(0, (Number(dueIn) / Math.max(1, Number(interval) || 1)) * 100));
    return Math.max(0, Math.min(100, 100 - used * 0.65 - Number(downtime || 0) * 12));
}

function statusFor(dueIn) {
    if (dueIn < 0) return { label: 'Overdue', color: RED };
    if (dueIn <= 50) return { label: 'Due Soon', color: YELLOW };
    return { label: 'OK', color: GREEN };
}

function SummaryTile({ label, value, color }) {
    return (
        <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: color, p: 3, minHeight: 120, display: 'grid', placeItems: 'center', borderRadius: 1 }}>
            <Box sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: MUTED, textTransform: 'uppercase', letterSpacing: 1.2, fontSize: 15 }}>{label}</Typography>
                <Typography sx={{ color, fontWeight: 900, fontSize: 42, lineHeight: 1.1 }}>{value}</Typography>
            </Box>
        </Paper>
    );
}

function HealthCard({ name, group, hours, source, dueIn, interval, metrics, tasks, downtime }) {
    const st = statusFor(dueIn);
    const health = healthScore(dueIn, interval, downtime);
    const duePct = 100 - Math.min(100, Math.max(0, (Number(dueIn) / Math.max(1, Number(interval) || 1)) * 100));
    return (
        <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, minHeight: 220, borderRadius: 1 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                <Box>
                    <Typography sx={{ color: TEXT, fontWeight: 900, fontSize: 20 }}>{name}</Typography>
                    <Typography sx={{ color: MUTED, mt: 0.5 }}>{group}</Typography>
                </Box>
                <Chip size="small" label={st.label} sx={{ color: st.color, borderColor: st.color, bgcolor: `${st.color}22`, fontWeight: 900 }} variant="outlined" />
            </Stack>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 2 }}>
                <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 24 }}>{fmt(hours)} h</Typography>
                <Chip size="small" label={source} sx={{ bgcolor: '#1b4961', color: '#a9c1dc', height: 22 }} />
                {downtime ? <Chip size="small" label={`${downtime} open DT`} sx={{ bgcolor: '#5b2a3a', color: RED, fontWeight: 900, ml: 'auto' }} /> : null}
            </Stack>
            <Typography sx={{ color: MUTED, mt: 1.5 }}>
                next due in <Box component="span" sx={{ color: st.color, fontWeight: 900 }}>{fmt(dueIn)} h</Box>
            </Typography>
            <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
                <Typography sx={{ color: MUTED }}>Health</Typography>
                <Typography sx={{ color: health < 55 ? RED : health < 75 ? YELLOW : GREEN, fontWeight: 900 }}>{fmt(health, 0)}%</Typography>
            </Stack>
            <Box sx={{ height: 8, bgcolor: 'rgba(148,163,184,.18)', borderRadius: 4, mt: 0.6, overflow: 'hidden' }}>
                <Box sx={{ height: '100%', width: `${duePct}%`, bgcolor: duePct > 90 ? RED : duePct > 75 ? YELLOW : GREEN }} />
            </Box>
            <Box sx={{ borderTop: `1px solid ${BORDER}`, mt: 2, pt: 1.3 }}>
                {metrics.map((m) => <Typography key={m} sx={{ color: MUTED, lineHeight: 1.75 }}>{m}</Typography>)}
                <Typography sx={{ color: '#6f86aa', mt: 1 }}>{tasks} PM task(s)</Typography>
            </Box>
        </Paper>
    );
}

function StatusPill({ dueIn }) {
    const st = statusFor(dueIn);
    return <Chip size="small" label={st.label} variant="outlined" sx={{ color: st.color, borderColor: st.color, bgcolor: `${st.color}18`, fontWeight: 900 }} />;
}

const BASE_SCHEDULE = [
    { task: 'Mud Pump Liners & Valves', asset: 'Mud Pump', interval: 300, current: 3620, next: 3600 },
    { task: 'Drawworks Brake Inspection', asset: 'Drawworks', interval: 200, current: 3850.1, next: 3880 },
    { task: 'Drill-Line Slip & Cut', asset: 'Drawworks', interval: 150, current: 3850.1, next: 3950 },
    { task: 'Top Drive Gearbox Oil', asset: 'Top Drive (HTD)', interval: 750, current: 0, next: 2900 },
    { task: 'HPU Hydraulic Filter', asset: 'Hydraulic Power Unit', interval: 350, current: 0, next: 3300 },
    { task: 'Engine Oil & Filter', asset: 'CAT Engine', interval: 250, current: 0, next: 4230 },
    { task: 'Engine Major Service', asset: 'CAT Engine', interval: 1000, current: 0, next: 4600 },
];

const CALIBRATION_ROWS = [
    { type: 'Depth / Block Encoder', asset: 'drawworks', value: '1500.0 m', by: 'seed', time: 'Jun 12, 05:33' },
    { type: 'Weight Indicator', asset: 'drawworks', value: '0 t tare', by: 'seed', time: 'Jun 11, 05:33' },
    { type: 'Pump Stroke Counter', asset: 'mudpump', value: '1.00 factor', by: 'seed', time: 'Jun 10, 05:33' },
];

const todayInput = () => new Date().toISOString().slice(0, 10);

export default function RigMaintenancePanel({ rigId }) {
    const { data } = useRigData();
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [msg, setMsg] = useState('');
    const [busy, setBusy] = useState(false);
    const [serviceOpen, setServiceOpen] = useState(null);
    const [calOpen, setCalOpen] = useState(false);
    const [serviceDraft, setServiceDraft] = useState({ performedAt: todayInput(), outcome: 'pass', notes: '' });
    const [calDraft, setCalDraft] = useState({ type: 'Depth / Block Encoder', asset: 'drawworks', value: '', performedAt: todayInput(), outcome: 'pass', notes: '' });

    const load = useCallback(() => {
        if (!rigId) return;
        api.maintenance({ rigId })
            .then((list) => setRows(Array.isArray(list) ? list : []))
            .catch((e) => {
                if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance records');
            });
    }, [rigId]);

    useEffect(() => {
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
    }, [load]);

    const runtimeForAsset = useCallback((asset) => {
        const key = String(asset || '').toLowerCase();
        if (key.includes('cat') || key.includes('engine')) return Number(data?.cat_engine?.run_hours || data?.cat?.run_hours || 0);
        if (key.includes('hpu') || key.includes('hydraulic')) return Number(data?.hpu?.run_hours || 0);
        if (key.includes('htd') || key.includes('top drive')) return Number(data?.htd?.run_hours || data?.topdrive?.run_hours || 0);
        if (key.includes('mud')) return Number(data?.mudpump?.run_hours || 0);
        if (key.includes('drawworks')) return Number(data?.drawworks?.run_hours || 0);
        return 0;
    }, [data]);

    const openService = (row) => {
        setServiceOpen(row);
        setServiceDraft({ performedAt: todayInput(), outcome: 'pass', notes: `${row.task} completed`, runtimeHours: fmt(row.current, 2) });
    };

    const saveService = async () => {
        if (!serviceOpen) return;
        setBusy(true); setErr(''); setMsg('');
        try {
            await api.addMaintenance({
                rigId,
                type: 'PM',
                title: serviceOpen.task,
                status: 'done',
                performedAt: serviceDraft.performedAt,
                runtimeHours: Number(serviceDraft.runtimeHours || serviceOpen.current || 0),
                outcome: serviceDraft.outcome,
                notes: serviceDraft.notes,
            });
            setMsg(`Service saved: ${serviceOpen.task}`);
            setServiceOpen(null);
            load();
        } catch (e) {
            setErr(e?.response?.data?.error || 'Failed to save service record');
        } finally {
            setBusy(false);
        }
    };

    const saveCalibration = async () => {
        setBusy(true); setErr(''); setMsg('');
        try {
            const title = `${calDraft.type} calibration`;
            await api.addMaintenance({
                rigId,
                type: 'calibration',
                title,
                status: 'done',
                performedAt: calDraft.performedAt,
                runtimeHours: runtimeForAsset(calDraft.asset),
                outcome: calDraft.outcome,
                notes: [calDraft.value ? `Value: ${calDraft.value}` : '', calDraft.notes].filter(Boolean).join(' | '),
            });
            setMsg(`Calibration saved: ${calDraft.type}`);
            setCalOpen(false);
            setCalDraft({ type: 'Depth / Block Encoder', asset: 'drawworks', value: '', performedAt: todayInput(), outcome: 'pass', notes: '' });
            load();
        } catch (e) {
            setErr(e?.response?.data?.error || 'Failed to save calibration record');
        } finally {
            setBusy(false);
        }
    };

    const derived = useMemo(() => {
        const catHours = Number(data?.cat_engine?.run_hours || data?.cat?.run_hours || 0);
        const hpuHours = Number(data?.hpu?.run_hours || 0);
        const htdHours = Number(data?.htd?.run_hours || data?.topdrive?.run_hours || 0);
        const mudHours = Number(data?.mudpump?.run_hours || 0);
        const dwHours = Number(data?.drawworks?.run_hours || 0);

        const schedule = BASE_SCHEDULE.map((r) => {
            let current = r.current;
            if (r.asset === 'CAT Engine') current = catHours;
            if (r.asset === 'Hydraulic Power Unit') current = hpuHours;
            if (r.asset === 'Top Drive (HTD)') current = htdHours;
            if (r.asset === 'Mud Pump') current = mudHours;
            if (r.asset === 'Drawworks') current = dwHours;
            const next = nextDueHour(current, r.interval, r.next);
            const dueIn = hoursUntil(next, current);
            const duePct = dueUsedPct(current, next, r.interval);
            const health = healthScore(dueIn, r.interval);
            return { ...r, current, next, dueIn, duePct, health };
        });
        const openDowntime = rows.filter((r) => r.type === 'breakdown' && r.status !== 'done').length;
        const avgHealth = schedule.length ? schedule.reduce((sum, r) => sum + r.health, 0) / schedule.length : 100;
        const calibrationRows = rows
            .filter((r) => r.type === 'calibration')
            .slice(0, 20)
            .map((r) => ({
                type: r.title || 'Calibration',
                asset: r.notes?.match(/asset: ([^|]+)/i)?.[1] || r.rig_id || rigId,
                value: r.notes?.match(/Value: ([^|]+)/i)?.[1]?.trim() || r.outcome || '--',
                by: r.created_by || r.createdBy || 'operator',
                time: r.performed_at ? new Date(r.performed_at).toLocaleString() : new Date(r.created_at || Date.now()).toLocaleString(),
            }));

        return {
            schedule,
            overdue: schedule.filter((r) => r.dueIn < 0).length || rows.filter((r) => r.status === 'overdue').length,
            dueSoon: schedule.filter((r) => r.dueIn >= 0 && r.dueIn <= 50).length,
            openDowntime,
            avgHealth,
            calibrationRows: calibrationRows.length ? calibrationRows : CALIBRATION_ROWS,
            cards: [
                { name: 'CAT Engine', group: 'Power', hours: catHours, source: catHours ? 'measured' : 'waiting', dueIn: nextDueHour(catHours, 250, 4230) - catHours, interval: 250, metrics: ['Coolant C', 'Oil bar'], tasks: 2 },
                { name: 'Hydraulic Power Unit', group: 'Hydraulics', hours: hpuHours, source: hpuHours ? 'measured' : 'waiting', dueIn: nextDueHour(hpuHours, 350, 3300) - hpuHours, interval: 350, metrics: ['Oil Temp C', 'Disch bar'], tasks: 1, downtime: openDowntime },
                { name: 'Top Drive (HTD)', group: 'Rotary', hours: htdHours, source: htdHours ? 'measured' : 'waiting', dueIn: nextDueHour(htdHours, 750, 2900) - htdHours, interval: 750, metrics: ['RPM', 'Torque'], tasks: 1 },
                { name: 'Drawworks', group: 'Hoisting', hours: dwHours, source: 'derived', dueIn: nextDueHour(dwHours, 200, 3880) - dwHours, interval: 200, metrics: ['Hook Load t', 'Rope wear'], tasks: 2 },
                { name: 'Mud Pump', group: 'Circulating', hours: mudHours, source: 'derived', dueIn: nextDueHour(mudHours, 300, 3600) - mudHours, interval: 300, metrics: ['SPM', 'Pressure bar'], tasks: 1 },
            ],
        };
    }, [data, rows]);

    return (
        <Box sx={{ bgcolor: BG, minHeight: '100%', p: 2 }}>
            <Stack direction="row" alignItems="center" spacing={1.2} sx={{ mb: 3 }}>
                <FavoriteBorder sx={{ color: BLUE }} />
                <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 26 }}>Maintenance & Asset Health</Typography>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}
            {msg && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMsg('')}>{msg}</Alert>}

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2, mb: 3 }}>
                <SummaryTile label="Overdue" value={derived.overdue} color={RED} />
                <SummaryTile label="Due Soon" value={derived.dueSoon} color={YELLOW} />
                <SummaryTile label="Avg Health" value={`${fmt(derived.avgHealth, 0)}%`} color={BLUE} />
            </Box>

            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                <FavoriteBorder sx={{ color: BLUE }} />
                <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 22 }}>Asset Health</Typography>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(4, minmax(0, 1fr))' }, gap: 2, mb: 3 }}>
                {derived.cards.map((card) => <HealthCard key={card.name} {...card} />)}
            </Box>

            <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1, mb: 2 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
                    <Build sx={{ color: BLUE }} />
                    <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 22 }}>Preventive Maintenance Schedule</Typography>
                </Stack>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                {['Task', 'Asset', 'Interval', 'Current', 'Next', 'Due Used', 'Due In', 'Status', 'Action'].map((h) => (
                                    <TableCell key={h} sx={{ color: MUTED, fontWeight: 900, fontSize: 16 }}>{h}</TableCell>
                                ))}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {derived.schedule.map((r) => {
                                const st = statusFor(r.dueIn);
                                return (
                                    <TableRow key={r.task} hover sx={{ '& td': { borderColor: '#1d2c3f', color: TEXT, fontSize: 16, fontWeight: 700 } }}>
                                        <TableCell>{r.task}</TableCell>
                                        <TableCell>{r.asset}</TableCell>
                                        <TableCell>{fmt(r.interval)} h</TableCell>
                                        <TableCell>{fmt(r.current)} h</TableCell>
                                        <TableCell>{fmt(r.next)} h</TableCell>
                                        <TableCell>{fmt(r.duePct, 0)}%</TableCell>
                                        <TableCell sx={{ color: `${st.color} !important` }}>{fmt(r.dueIn)} h</TableCell>
                                        <TableCell><StatusPill dueIn={r.dueIn} /></TableCell>
                                        <TableCell align="right"><Button size="small" variant="outlined" startIcon={<Build />} onClick={() => openService(r)}>Service</Button></TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            <Paper variant="outlined" sx={{ bgcolor: PANEL, borderColor: BORDER, p: 2, borderRadius: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <Tune sx={{ color: BLUE }} />
                        <Typography sx={{ color: BLUE, fontWeight: 900, fontSize: 22 }}>Calibration History</Typography>
                    </Stack>
                    <Button size="small" variant="outlined" onClick={() => setCalOpen(true)}>Add Calibration</Button>
                </Stack>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                {['Type', 'Asset', 'Value', 'By', 'Time'].map((h) => <TableCell key={h} sx={{ color: MUTED, fontWeight: 900, fontSize: 16 }}>{h}</TableCell>)}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {derived.calibrationRows.map((r) => (
                                <TableRow key={r.type} sx={{ '& td': { borderColor: '#1d2c3f', color: TEXT, fontSize: 16, fontWeight: 700 } }}>
                                    <TableCell>{r.type}</TableCell>
                                    <TableCell>{r.asset}</TableCell>
                                    <TableCell>{r.value}</TableCell>
                                    <TableCell>{r.by}</TableCell>
                                    <TableCell>{r.time}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            <Dialog open={Boolean(serviceOpen)} onClose={() => setServiceOpen(null)} maxWidth="sm" fullWidth>
                <DialogTitle>Service Record</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField label="Task" value={serviceOpen?.task || ''} InputProps={{ readOnly: true }} />
                        <TextField label="Performed Date" type="date" value={serviceDraft.performedAt} onChange={(e) => setServiceDraft((d) => ({ ...d, performedAt: e.target.value }))} InputLabelProps={{ shrink: true }} />
                        <TextField label="Runtime Hours" value={serviceDraft.runtimeHours || ''} onChange={(e) => setServiceDraft((d) => ({ ...d, runtimeHours: e.target.value }))} />
                        <TextField select label="Outcome" value={serviceDraft.outcome} onChange={(e) => setServiceDraft((d) => ({ ...d, outcome: e.target.value }))}>
                            {['pass', 'fail', 'monitor'].map((v) => <MenuItem key={v} value={v}>{v.toUpperCase()}</MenuItem>)}
                        </TextField>
                        <TextField label="Notes" multiline minRows={3} value={serviceDraft.notes} onChange={(e) => setServiceDraft((d) => ({ ...d, notes: e.target.value }))} />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setServiceOpen(null)}>Cancel</Button>
                    <Button variant="contained" disabled={busy} onClick={saveService}>Save Service</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={calOpen} onClose={() => setCalOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Add Calibration</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} sx={{ mt: 1 }}>
                        <TextField select label="Calibration Type" value={calDraft.type} onChange={(e) => setCalDraft((d) => ({ ...d, type: e.target.value }))}>
                            {['Depth / Block Encoder', 'Weight Indicator', 'Pump Stroke Counter', 'Torque Sensor', 'Pressure Sensor'].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                        </TextField>
                        <TextField select label="Asset" value={calDraft.asset} onChange={(e) => setCalDraft((d) => ({ ...d, asset: e.target.value }))}>
                            {['drawworks', 'mudpump', 'htd', 'hpu', 'CAT Engine'].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                        </TextField>
                        <TextField label="Calibration Value" value={calDraft.value} onChange={(e) => setCalDraft((d) => ({ ...d, value: e.target.value }))} placeholder="e.g. 0 t tare / 1.00 factor" />
                        <TextField label="Performed Date" type="date" value={calDraft.performedAt} onChange={(e) => setCalDraft((d) => ({ ...d, performedAt: e.target.value }))} InputLabelProps={{ shrink: true }} />
                        <TextField select label="Outcome" value={calDraft.outcome} onChange={(e) => setCalDraft((d) => ({ ...d, outcome: e.target.value }))}>
                            {['pass', 'fail', 'monitor'].map((v) => <MenuItem key={v} value={v}>{v.toUpperCase()}</MenuItem>)}
                        </TextField>
                        <TextField label="Notes" multiline minRows={3} value={calDraft.notes} onChange={(e) => setCalDraft((d) => ({ ...d, notes: e.target.value }))} />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCalOpen(false)}>Cancel</Button>
                    <Button variant="contained" disabled={busy || !calDraft.value.trim()} onClick={saveCalibration}>Save Calibration</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

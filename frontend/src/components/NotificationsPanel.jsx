import React, { useEffect, useState, useCallback } from 'react';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, Grid,
    Stack, Chip, Select, MenuItem, TextField, Button, Switch, IconButton, Tooltip, Alert,
} from '@mui/material';
import { Add, Send, Delete } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { PriorityChip, fmtAgo } from './common';

// Alarm-notification config + dispatch log (proposal §6.1 escalation). Channels are
// admin-editable; everyone with portal access sees the recent dispatch log.
export default function NotificationsPanel() {
    const { can } = useAuth();
    const admin = can('admin');
    const [channels, setChannels] = useState([]);
    const [log, setLog] = useState([]);
    const [form, setForm] = useState({ type: 'webhook', target: '', min_severity: 'P1' });
    const [msg, setMsg] = useState('');

    const load = useCallback(() => {
        api.notifyChannels().then((d) => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
        api.notifications(50).then((d) => setLog(Array.isArray(d) ? d : [])).catch(() => {});
    }, []);
    useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

    const add = async () => {
        if (!form.target) return;
        try { await api.addNotifyChannel(form); setForm({ type: 'webhook', target: '', min_severity: 'P1' }); setMsg(''); load(); }
        catch (e) { setMsg(e?.response?.data?.error || 'Failed to add channel'); }
    };
    const toggle = async (c) => { await api.updateNotifyChannel(c.id, { enabled: !c.enabled }); load(); };
    const test = async (c) => {
        try { const r = await api.testNotifyChannel(c.id); setMsg(r.ok ? `Test sent to ${c.target}` : `Test failed: ${r.error}`); load(); }
        catch (e) { setMsg(e?.response?.data?.error || 'Test failed'); }
    };
    const remove = async (c) => { await api.deleteNotifyChannel(c.id); load(); };

    const sevColor = { P1: 'error', P2: 'warning', P3: 'info' };

    return (
        <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid item xs={12} md={6}>
                <Paper sx={{ p: 2, height: '100%' }}>
                    <Typography variant="h6" gutterBottom>Notification channels</Typography>
                    <Typography variant="caption" color="text.secondary">
                        Outbound webhook/email alerts on P1 (ESD/lockout/well-control) and escalations. Monitoring-only — alerts about received data; nothing is sent to a rig.
                    </Typography>
                    {msg && <Alert severity="info" sx={{ my: 1 }} onClose={() => setMsg('')}>{msg}</Alert>}
                    {admin && (
                        <Stack direction="row" spacing={1} my={1.5} flexWrap="wrap" useFlexGap>
                            <Select size="small" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                                <MenuItem value="webhook">webhook</MenuItem>
                                <MenuItem value="email">email</MenuItem>
                            </Select>
                            <TextField size="small" sx={{ flexGrow: 1, minWidth: 180 }}
                                placeholder={form.type === 'email' ? 'alerts@ongc.local' : 'https://hooks.example/…'}
                                value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                            <Select size="small" value={form.min_severity} onChange={(e) => setForm({ ...form, min_severity: e.target.value })}>
                                <MenuItem value="P1">≥ P1</MenuItem><MenuItem value="P2">≥ P2</MenuItem><MenuItem value="P3">≥ P3</MenuItem>
                            </Select>
                            <Button variant="contained" startIcon={<Add />} onClick={add}>Add</Button>
                        </Stack>
                    )}
                    <Table size="small">
                        <TableHead><TableRow>
                            <TableCell>Type</TableCell><TableCell>Target</TableCell><TableCell>Min</TableCell>
                            <TableCell align="center">On</TableCell>{admin && <TableCell align="right">Actions</TableCell>}
                        </TableRow></TableHead>
                        <TableBody>
                            {channels.map((c) => (
                                <TableRow key={c.id}>
                                    <TableCell><Chip size="small" variant="outlined" label={c.type} /></TableCell>
                                    <TableCell><Typography variant="caption" sx={{ wordBreak: 'break-all' }}>{c.target}</Typography></TableCell>
                                    <TableCell><PriorityChip priority={c.min_severity} /></TableCell>
                                    <TableCell align="center">
                                        <Switch size="small" checked={!!c.enabled} disabled={!admin} onChange={() => toggle(c)} />
                                    </TableCell>
                                    {admin && <TableCell align="right">
                                        <Tooltip title="Send test"><IconButton size="small" onClick={() => test(c)}><Send fontSize="small" /></IconButton></Tooltip>
                                        <Tooltip title="Delete"><IconButton size="small" onClick={() => remove(c)}><Delete fontSize="small" /></IconButton></Tooltip>
                                    </TableCell>}
                                </TableRow>
                            ))}
                            {!channels.length && <TableRow><TableCell colSpan={admin ? 5 : 4} sx={{ color: 'text.secondary' }}>No channels configured.</TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </Paper>
            </Grid>
            <Grid item xs={12} md={6}>
                <Paper sx={{ p: 2, height: '100%', maxHeight: 420, overflow: 'auto' }}>
                    <Typography variant="h6" gutterBottom>Recent notifications</Typography>
                    <Table size="small">
                        <TableHead><TableRow>
                            <TableCell>When</TableCell><TableCell>Rig</TableCell><TableCell>Sev</TableCell>
                            <TableCell>Kind</TableCell><TableCell>Channel</TableCell><TableCell>Status</TableCell>
                        </TableRow></TableHead>
                        <TableBody>
                            {log.map((n) => (
                                <TableRow key={n.id}>
                                    <TableCell><Typography variant="caption" color="text.secondary">{fmtAgo(n.ts)}</Typography></TableCell>
                                    <TableCell><Typography variant="caption">{n.rig_id}</Typography></TableCell>
                                    <TableCell><Chip size="small" color={sevColor[n.severity] || 'default'} variant="outlined" label={n.severity} /></TableCell>
                                    <TableCell><Typography variant="caption">{n.kind}</Typography></TableCell>
                                    <TableCell><Typography variant="caption">{n.channel_type}</Typography></TableCell>
                                    <TableCell><Chip size="small" color={n.status === 'sent' ? 'success' : 'error'} variant="outlined" label={n.status} /></TableCell>
                                </TableRow>
                            ))}
                            {!log.length && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary' }}>No notifications dispatched yet.</TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </Paper>
            </Grid>
        </Grid>
    );
}

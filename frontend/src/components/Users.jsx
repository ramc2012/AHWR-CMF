import React, { useEffect, useState, useCallback } from 'react';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Stack, Chip, Select, MenuItem, TextField, Button, Dialog, DialogTitle, DialogContent,
    DialogActions, IconButton, Tooltip, Alert, Switch,
} from '@mui/material';
import { Add, DeleteOutline, LockReset } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

const ROLES = ['admin', 'operator', 'viewer'];
const ROLE_COLOR = { admin: 'secondary', operator: 'info', viewer: 'default' };

export default function Users() {
    const { user } = useAuth();
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    const [addOpen, setAddOpen] = useState(false);
    const [draft, setDraft] = useState({ username: '', password: '', display: '', role: 'viewer' });
    const [saving, setSaving] = useState(false);
    const [pwTarget, setPwTarget] = useState(null);
    const [pwValue, setPwValue] = useState('');

    const load = useCallback(() => {
        setErr('');
        api.users()
            .then((u) => setRows(Array.isArray(u) ? u : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load users'); })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { setLoading(true); load(); }, [load]);

    const act = async (fn) => {
        setErr('');
        try { await fn(); load(); }
        catch (e) { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Action failed'); }
    };

    const addUser = async () => {
        if (!draft.username || !draft.password) return;
        setSaving(true);
        try {
            await api.addUser(draft);
            setAddOpen(false);
            setDraft({ username: '', password: '', display: '', role: 'viewer' });
            load();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to add user');
        } finally {
            setSaving(false);
        }
    };

    const resetPw = async () => {
        if (!pwTarget || !pwValue) return;
        await act(() => api.updateUser(pwTarget.username, { password: pwValue }));
        setPwTarget(null);
        setPwValue('');
    };

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2}>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>User &amp; Access Management</Typography>
                <Button variant="contained" startIcon={<Add />} onClick={() => setAddOpen(true)}>Add user</Button>
            </Stack>

            <Alert severity="info" sx={{ mb: 2 }}>
                Local accounts and RBAC for the CRMF portal. Roles: <b>admin</b> (full + user management),
                <b> operator</b> (governance / maintenance edits), <b>viewer</b> (read-only). Monitoring-only — no rig control.
            </Alert>
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead><TableRow>
                            <TableCell>Username</TableCell><TableCell>Display name</TableCell>
                            <TableCell>Role</TableCell><TableCell align="center">Enabled</TableCell>
                            <TableCell align="right">Actions</TableCell>
                        </TableRow></TableHead>
                        <TableBody>
                            {rows.map((u) => {
                                const isSelf = u.username === user?.username;
                                return (
                                    <TableRow key={u.username} hover>
                                        <TableCell>
                                            <Typography variant="body2" fontWeight={700} fontFamily="monospace">{u.username}</Typography>
                                            {isSelf && <Chip size="small" variant="outlined" label="you" sx={{ ml: 1 }} />}
                                        </TableCell>
                                        <TableCell>{u.display || '—'}</TableCell>
                                        <TableCell>
                                            <Select size="small" variant="standard" value={u.role} disabled={isSelf}
                                                onChange={(e) => act(() => api.updateUser(u.username, { role: e.target.value }))}
                                                renderValue={(v) => <Chip size="small" color={ROLE_COLOR[v] || 'default'} variant="outlined" label={v} />}>
                                                {ROLES.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                                            </Select>
                                        </TableCell>
                                        <TableCell align="center">
                                            <Tooltip title={isSelf ? 'You cannot disable your own account' : (u.disabled ? 'Disabled — enable' : 'Enabled — disable')}>
                                                <span>
                                                    <Switch size="small" checked={!u.disabled} disabled={isSelf}
                                                        onChange={(e) => act(() => api.updateUser(u.username, { disabled: !e.target.checked }))} />
                                                </span>
                                            </Tooltip>
                                        </TableCell>
                                        <TableCell align="right">
                                            <Tooltip title="Reset password"><IconButton size="small" onClick={() => { setPwTarget(u); setPwValue(''); }}><LockReset fontSize="small" /></IconButton></Tooltip>
                                            <Tooltip title={isSelf ? 'You cannot delete your own account' : 'Delete user'}>
                                                <span>
                                                    <IconButton size="small" disabled={isSelf} color="error"
                                                        onClick={() => { if (window.confirm(`Delete user "${u.username}"?`)) act(() => api.deleteUser(u.username)); }}>
                                                        <DeleteOutline fontSize="small" />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {!loading && !rows.length && (
                                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>No users.</TableCell></TableRow>
                            )}
                            {loading && !rows.length && (
                                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading users…</TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Add user */}
            <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="xs">
                <DialogTitle>Add user</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={0.5}>
                        <TextField size="small" label="Username" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} autoComplete="off" />
                        <TextField size="small" label="Display name" value={draft.display} onChange={(e) => setDraft({ ...draft, display: e.target.value })} />
                        <TextField size="small" label="Password" type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} autoComplete="new-password" />
                        <Select size="small" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                            {ROLES.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                        </Select>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAddOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={addUser} disabled={saving || !draft.username || !draft.password}>{saving ? 'Saving…' : 'Add'}</Button>
                </DialogActions>
            </Dialog>

            {/* Reset password */}
            <Dialog open={!!pwTarget} onClose={() => setPwTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Reset password — {pwTarget?.username}</DialogTitle>
                <DialogContent>
                    <TextField size="small" fullWidth label="New password" type="password" sx={{ mt: 1 }}
                        value={pwValue} onChange={(e) => setPwValue(e.target.value)} autoComplete="new-password" />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPwTarget(null)}>Cancel</Button>
                    <Button variant="contained" onClick={resetPw} disabled={!pwValue}>Reset</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

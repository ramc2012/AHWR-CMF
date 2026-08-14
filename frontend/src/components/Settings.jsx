import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
    Box, Paper, Typography, Stack, Grid, Table, TableBody, TableCell, TableHead, TableRow,
    TableContainer, TextField, Button, Dialog, DialogTitle, DialogContent, DialogActions,
    IconButton, Tooltip, Alert, InputAdornment, Divider, Chip, Switch, FormControlLabel, MenuItem,
} from '@mui/material';
import { Add, DeleteOutline, Save, FiberManualRecord, VpnKey, Autorenew, ContentCopy, Cable, PowerSettingsNew } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { fmtAgo } from './common';


const ROLE_COLOR = { admin: '#7c4dff', operator: '#38bdf8', viewer: '#64748b' };

const emptyRig = { rigId: '', name: '', assetUnit: '', field: '', latitude: '', longitude: '', deviceToken: '' };

// System-settings field metadata — label, suffix, and what each setting controls.
const SETTING_FIELDS = [
    { key: 'retention_days', label: 'Storage retention', adorn: 'days', help: 'How long telemetry history is kept before TimescaleDB drops old chunks.' },
    { key: 'update_rate_sec', label: 'Update rate', adorn: 'sec', help: 'Target cadence at which edge sites push samples to the central facility.' },
    { key: 'offline_sec', label: 'Offline threshold', adorn: 'sec', help: 'Seconds without a sync before a rig is marked offline on the fleet view.' },
    { key: 'central_latency_target', label: 'Central latency target', adorn: 'sec', help: 'Target end-to-end edge→central ingest latency used for SLA health.' },
];

const ETP_SETTING_KEYS = [
    'etp20_enabled', 'etp20_endpoint', 'etp20_dataspace', 'etp20_auth_type', 'etp20_username',
    'etp20_password', 'etp20_bearer_token', 'etp20_witsml_version', 'etp20_timeout_sec',
    'etp20_reconnect_sec', 'etp20_ssl_verify', 'etp20_read_only',
    'etp20_server_enabled', 'etp20_server_path', 'etp20_server_token',
];

// Active Directory (Windows domain login) — authentication modes, mirrored from
// the edge Settings panel so both apps behave identically.
const LDAP_MODES = [
    { value: 'local', label: 'Local only', help: 'Only accounts created in this portal can sign in.' },
    { value: 'ldap', label: 'Domain (Active Directory) only', help: 'Only Windows-domain accounts can sign in — make sure an AD group maps to admin first.' },
    { value: 'both', label: 'Local + Domain', help: 'Local accounts are tried first (break-glass admin), then the domain.' },
];
const LDAP_ROLES = ['viewer', 'operator', 'admin'];
const LDAP_EMPTY = {
    mode: 'local', url: '', bindDN: '', searchBase: '', searchFilter: '', domain: '',
    defaultRole: 'viewer', roleAdmin: '', roleOperator: '', roleViewer: '',
    startTLS: false, rejectUnauthorized: true,
};

export default function Settings() {
    const { can } = useAuth();
    const isAdmin = can('admin');

    // ---- Fleet configuration ----------------------------------------------------
    const [rigs, setRigs] = useState([]);
    const [rigsLoading, setRigsLoading] = useState(true);
    const [addOpen, setAddOpen] = useState(false);
    const [draft, setDraft] = useState(emptyRig);
    const [savingRig, setSavingRig] = useState(false);
    const [delTarget, setDelTarget] = useState(null);

    // ---- Per-rig device token (edge sync credential) ----------------------------
    // reveal: { rig, token } shown once after create/rotate. rotateTarget: rig pending confirm.
    const [reveal, setReveal] = useState(null);
    const [rotateTarget, setRotateTarget] = useState(null);
    const [rotating, setRotating] = useState(false);
    const [copied, setCopied] = useState(false);

    // ---- System settings --------------------------------------------------------
    const [settings, setSettings] = useState(null);
    const [settingsDraft, setSettingsDraft] = useState({});
    const [savingSettings, setSavingSettings] = useState(false);
    const [settingsMsg, setSettingsMsg] = useState('');
    const [etpStatus, setEtpStatus] = useState(null);
    const [etpBusy, setEtpBusy] = useState(false);
    const [networkUrls, setNetworkUrls] = useState(null);
    const [urlCopied, setUrlCopied] = useState('');

    // ---- Active Directory (Windows domain login) ---------------------------------
    const [ldapCfg, setLdapCfg] = useState(null);          // last server copy (carries hasBindPassword / ldapEnabled)
    const [ldapDraft, setLdapDraft] = useState(LDAP_EMPTY);
    const [ldapPassword, setLdapPassword] = useState('');  // write-only: never pre-filled, sent only when typed
    const [ldapSaving, setLdapSaving] = useState(false);
    const [ldapTesting, setLdapTesting] = useState(false);
    const [ldapTest, setLdapTest] = useState(null);        // { ok, message } from the connectivity probe
    const [ldapMsg, setLdapMsg] = useState('');

    // ---- Presence ---------------------------------------------------------------
    const [presence, setPresence] = useState([]);

    const [err, setErr] = useState('');

    const loadRigs = useCallback(() => {
        api.rigsConfig()
            .then((d) => setRigs(Array.isArray(d) ? d : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load rigs'); })
            .finally(() => setRigsLoading(false));
    }, []);

    const loadNetworkUrls = useCallback(() => {
        api.networkUrls()
            .then((d) => setNetworkUrls(d || null))
            .catch(() => setNetworkUrls(null));
    }, []);

    const loadSettings = useCallback(() => {
        api.settings()
            .then((s) => { setSettings(s); setSettingsDraft(s || {}); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load settings'); });
    }, []);

    const loadPresence = useCallback(() => {
        api.presence()
            .then((p) => setPresence(Array.isArray(p) ? p : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load presence'); });
    }, []);

    const loadEtpStatus = useCallback(() => {
        api.etp20Status()
            .then(setEtpStatus)
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load ETP 2.0 status'); });
    }, []);

    // Fold a fresh server copy of the LDAP config into chip state + editable draft.
    const applyLdap = useCallback((c) => {
        setLdapCfg(c || null);
        setLdapDraft({
            mode: c?.mode || 'local', url: c?.url || '', bindDN: c?.bindDN || '',
            searchBase: c?.searchBase || '', searchFilter: c?.searchFilter || '', domain: c?.domain || '',
            defaultRole: c?.defaultRole || 'viewer',
            roleAdmin: c?.roleAdmin || '', roleOperator: c?.roleOperator || '', roleViewer: c?.roleViewer || '',
            startTLS: !!c?.startTLS, rejectUnauthorized: c?.rejectUnauthorized !== false,
        });
    }, []);

    const loadLdap = useCallback(() => {
        api.ldapConfig()
            .then(applyLdap)
            .catch((e) => {
                const s = e?.response?.status;
                if (s !== 401 && s !== 403) setErr(e?.response?.data?.error || 'Failed to load Active Directory settings');
            });
    }, [applyLdap]);

    useEffect(() => {
        loadRigs(); loadSettings(); loadEtpStatus(); loadNetworkUrls();
        if (isAdmin) loadLdap(); // GET /api/settings/ldap is admin-only
    }, [loadRigs, loadSettings, loadEtpStatus, loadNetworkUrls, loadLdap, isAdmin]);

    useEffect(() => {
        const t = setInterval(() => loadEtpStatus(), 2000);
        return () => clearInterval(t);
    }, [loadEtpStatus]);

    // Presence: ping our own liveness, then poll the roster every ~10s.
    const presenceRef = useRef(loadPresence);
    presenceRef.current = loadPresence;
    useEffect(() => {
        api.pingPresence().catch(() => {});
        presenceRef.current();
        const t = setInterval(() => { presenceRef.current(); }, 10000);
        return () => clearInterval(t);
    }, []);

    const addRig = async () => {
        if (!draft.rigId || !draft.name) return;
        setSavingRig(true); setErr('');
        try {
            const created = await api.addRig({
                rigId: draft.rigId.trim(),
                name: draft.name.trim(),
            });
            setAddOpen(false);
            setDraft(emptyRig);
            loadRigs();
            // The device_token is the per-rig edge sync credential, returned exactly once.
            if (created?.device_token) {
                setReveal({ rig: { rig_id: created.rig_id || draft.rigId.trim(), name: created.name || draft.name.trim() }, token: created.device_token });
            }
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to add rig');
        } finally {
            setSavingRig(false);
        }
    };

    // Rotate the per-rig device token (invalidates the old one on the edge). Reveals the
    // fresh token once in the same copyable dialog. Admin-only, confirm-gated.
    const rotateRig = async () => {
        if (!rotateTarget) return;
        setRotating(true); setErr('');
        try {
            const res = await api.rotateRigToken(rotateTarget.rig_id);
            setRotateTarget(null);
            loadRigs();
            if (res?.device_token) setReveal({ rig: rotateTarget, token: res.device_token });
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to rotate token');
            setRotateTarget(null);
        } finally {
            setRotating(false);
        }
    };

    const copyUrl = async (key, value) => {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setUrlCopied(key);
            setTimeout(() => setUrlCopied(''), 2000);
        } catch { /* keep URL selectable if clipboard is unavailable */ }
    };

    const copyToken = async () => {
        if (!reveal?.token) return;
        try {
            await navigator.clipboard.writeText(reveal.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable — the token is selectable in the field */ }
    };

    const deleteRig = async () => {
        if (!delTarget) return;
        setErr('');
        try {
            await api.deleteRig(delTarget.rig_id);
            setDelTarget(null);
            loadRigs();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to delete rig');
            setDelTarget(null);
        }
    };

    const saveSettings = async () => {
        setSavingSettings(true); setErr(''); setSettingsMsg('');
        try {
            // Send only changed numeric fields.
            const patch = {};
            for (const f of SETTING_FIELDS) {
                const v = settingsDraft[f.key];
                if (v !== '' && v != null && Number(v) !== Number(settings?.[f.key])) patch[f.key] = Number(v);
            }
            for (const key of ETP_SETTING_KEYS) {
                const v = settingsDraft[key];
                if (JSON.stringify(v ?? '') !== JSON.stringify(settings?.[key] ?? '')) patch[key] = v;
            }
            if (!Object.keys(patch).length) { setSettingsMsg('No changes to save.'); return; }
            const updated = await api.setSettings(patch);
            setSettings(updated); setSettingsDraft(updated || {});
            setSettingsMsg('Settings saved.');
            loadEtpStatus();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to save settings');
        } finally {
            setSavingSettings(false);
        }
    };

    const etpAction = async (action) => {
        setEtpBusy(true); setErr(''); setSettingsMsg('');
        try {
            let res;
            if (action === 'test') res = await api.etp20Test(settingsDraft);
            if (action === 'connect') res = await api.etp20Connect();
            if (action === 'disconnect') res = await api.etp20Disconnect();
            setSettingsMsg(res?.message || `ETP 2.0 ${action} completed.`);
            loadEtpStatus();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || `ETP 2.0 ${action} failed`);
        } finally {
            setEtpBusy(false);
        }
    };

    const saveLdap = async () => {
        setLdapSaving(true); setErr(''); setLdapMsg(''); setLdapTest(null);
        try {
            const patch = { ...ldapDraft };
            // Write-only bind password: send only when the admin typed a new one (empty = keep).
            if (ldapPassword.trim()) patch.bindPassword = ldapPassword;
            const updated = await api.saveLdapConfig(patch); // PUT returns the fresh safe config
            applyLdap(updated);
            setLdapPassword('');
            setLdapMsg('Active Directory settings saved.');
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to save Active Directory settings');
        } finally {
            setLdapSaving(false);
        }
    };

    const testLdapConnection = async () => {
        setLdapTesting(true); setErr(''); setLdapMsg(''); setLdapTest(null);
        try {
            const res = await api.testLdap();
            setLdapTest(res || { ok: false, message: 'No response from server' });
        } catch (e) {
            if (e?.response?.status !== 401) setLdapTest({ ok: false, message: e?.response?.data?.error || 'Connection test failed' });
        } finally {
            setLdapTesting(false);
        }
    };
    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Settings</Typography>
            {!isAdmin && (
                <Alert severity="info" sx={{ mb: 2 }}>
                    Read-only view. Sign in as an <b>admin</b> to manage the fleet registry and system settings.
                    Monitoring-only — the central facility never writes to a rig.
                </Alert>
            )}
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
                <Stack spacing={2}>

                    {/* 1) FLEET CONFIGURATION ------------------------------------------------ */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">Fleet configuration</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Rig master registry. Adding a rig registers it for edge sync; deleting cascades its telemetry. Audit-logged.
                                </Typography>
                            </Box>
                            {isAdmin && <Button variant="contained" startIcon={<Add />} onClick={() => { setDraft(emptyRig); setAddOpen(true); }}>Add rig</Button>}
                        </Stack>
                        <TableContainer sx={{ maxHeight: 360, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell>Rig ID</TableCell><TableCell>Name</TableCell><TableCell>Asset unit</TableCell>
                                    <TableCell>Field</TableCell><TableCell align="right">Latitude</TableCell>
                                    <TableCell align="right">Longitude</TableCell><TableCell align="center">Token</TableCell>
                                    {isAdmin && <TableCell align="right">Actions</TableCell>}
                                </TableRow></TableHead>
                                <TableBody>
                                    {rigs.map((r) => (
                                        <TableRow key={r.rig_id} hover>
                                            <TableCell><Typography variant="caption" fontFamily="monospace">{r.rig_id}</Typography></TableCell>
                                            <TableCell><Typography variant="body2" fontWeight={700}>{r.name}</Typography></TableCell>
                                            <TableCell>{r.assetUnit || '—'}</TableCell>
                                            <TableCell>{r.field || '—'}</TableCell>
                                            <TableCell align="right">{r.latitude?.toFixed?.(4) ?? '—'}</TableCell>
                                            <TableCell align="right">{r.longitude?.toFixed?.(4) ?? '—'}</TableCell>
                                            <TableCell align="center">
                                                {r.hasToken
                                                    ? <Chip size="small" variant="outlined" color="success" icon={<VpnKey sx={{ fontSize: 14 }} />} label="set" />
                                                    : <Chip size="small" variant="outlined" label="none" />}
                                            </TableCell>
                                            {isAdmin && (
                                                <TableCell align="right">
                                                    <Tooltip title="Rotate device token (invalidates the old edge credential)">
                                                        <IconButton size="small" onClick={() => setRotateTarget(r)}>
                                                            <Autorenew fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                    <Tooltip title="Delete rig (cascade)">
                                                        <IconButton size="small" color="error" onClick={() => setDelTarget(r)}>
                                                            <DeleteOutline fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    ))}
                                    {!rigsLoading && !rigs.length && (
                                        <TableRow><TableCell colSpan={isAdmin ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No rigs configured.</TableCell></TableRow>
                                    )}
                                    {rigsLoading && !rigs.length && (
                                        <TableRow><TableCell colSpan={isAdmin ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading rigs…</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>

                    {/* 2) SYSTEM SETTINGS --------------------------------------------------- */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">System settings</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Global ingest &amp; retention parameters. Saving applies retention and offline thresholds fleet-wide. Audit-logged.
                                </Typography>
                            </Box>
                            {isAdmin && (
                                <Button variant="contained" startIcon={<Save />} onClick={saveSettings}
                                    disabled={savingSettings || !settings}>{savingSettings ? 'Saving…' : 'Save'}</Button>
                            )}
                        </Stack>
                        {settingsMsg && <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setSettingsMsg('')}>{settingsMsg}</Alert>}
                        <Grid container spacing={2}>
                            {SETTING_FIELDS.map((f) => (
                                <Grid item xs={12} sm={6} md={3} key={f.key}>
                                    <TextField
                                        size="small" fullWidth type="number" label={f.label}
                                        value={settingsDraft[f.key] ?? ''}
                                        disabled={!isAdmin || !settings}
                                        onChange={(e) => setSettingsDraft({ ...settingsDraft, [f.key]: e.target.value })}
                                        helperText={f.help}
                                        InputProps={{ endAdornment: <InputAdornment position="end">{f.adorn}</InputAdornment> }}
                                    />
                                </Grid>
                            ))}
                        </Grid>
                        {!settings && <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5 }}>Loading settings…</Typography>}
                    </Paper>


                    {/* 3) ENERGISTICS ETP 2.0 ------------------------------------------------ */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <Cable color="primary" />
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">Energistics ETP 2.0</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Read-only outbound connector to an Energistics Transfer Protocol 2.0 server. Enable, save, then test/connect.
                                </Typography>
                            </Box>
                            <Chip size="small" color={etpStatus?.state === 'connected' ? 'success' : etpStatus?.state === 'error' ? 'error' : 'default'} label={(etpStatus?.state || 'disabled').toUpperCase()} />
                            {isAdmin && (
                                <Stack direction="row" spacing={1}>
                                    <Button variant="outlined" startIcon={<Cable />} disabled={etpBusy || !settingsDraft.etp20_endpoint} onClick={() => etpAction('test')}>Test</Button>
                                    <Button variant="contained" startIcon={<PowerSettingsNew />} disabled={etpBusy || !settingsDraft.etp20_enabled || !settingsDraft.etp20_endpoint} onClick={() => etpAction('connect')}>Connect</Button>
                                    <Button variant="outlined" color="warning" disabled={etpBusy} onClick={() => etpAction('disconnect')}>Disconnect</Button>
                                </Stack>
                            )}
                        </Stack>
                        {etpStatus?.lastError && <Alert severity="warning" sx={{ mb: 1.5 }}>{etpStatus.lastError}</Alert>}
                        <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, bgcolor: 'rgba(15,23,42,0.45)' }}>
                            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', lg: 'center' }}>
                                <Box sx={{ flexGrow: 1 }}>
                                    <Typography variant="subtitle2" fontWeight={800}>Current central URLs</Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        Auto-detected from this central server. Use these after central IP changes.
                                    </Typography>
                                </Box>
                                <TextField size="small" label="Portal URL" value={networkUrls?.webUrl || ''} InputProps={{ readOnly: true }} sx={{ minWidth: 260 }} />
                                <Button variant="outlined" startIcon={<ContentCopy />} disabled={!networkUrls?.webUrl} onClick={() => copyUrl('web', networkUrls?.webUrl)}>{urlCopied === 'web' ? 'Copied' : 'Copy'}</Button>
                                <TextField size="small" label="Edge HTTP URL" value={networkUrls?.ingestUrl || ''} InputProps={{ readOnly: true }} sx={{ minWidth: 260 }} />
                                <Button variant="outlined" startIcon={<ContentCopy />} disabled={!networkUrls?.ingestUrl} onClick={() => copyUrl('ingest', networkUrls?.ingestUrl)}>{urlCopied === 'ingest' ? 'Copied' : 'Copy'}</Button>
                                <TextField size="small" label="Edge ETP URL" value={networkUrls?.etpUrl || ''} InputProps={{ readOnly: true }} sx={{ minWidth: 300 }} />
                                <Button variant="contained" startIcon={<ContentCopy />} disabled={!networkUrls?.etpUrl} onClick={() => copyUrl('etp', networkUrls?.etpUrl)}>{urlCopied === 'etp' ? 'Copied' : 'Copy'}</Button>
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                                Token for Edge rigs: {networkUrls?.token || 'AHWR-ETP-2026'}
                            </Typography>
                        </Paper>
                        <Grid container spacing={2}>
                            <Grid item xs={12} md={3}>
                                <FormControlLabel
                                    control={<Switch checked={!!settingsDraft.etp20_enabled} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_enabled: e.target.checked })} />}
                                    label="Enable ETP 2.0"
                                />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <FormControlLabel
                                    control={<Switch checked={settingsDraft.etp20_read_only !== false} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_read_only: e.target.checked })} />}
                                    label="Read only"
                                />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <FormControlLabel
                                    control={<Switch checked={settingsDraft.etp20_ssl_verify !== false} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_ssl_verify: e.target.checked })} />}
                                    label="Verify TLS"
                                />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth type="number" label="Reconnect" value={settingsDraft.etp20_reconnect_sec ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_reconnect_sec: e.target.value })} InputProps={{ endAdornment: <InputAdornment position="end">sec</InputAdornment> }} />
                            </Grid>
                            <Grid item xs={12} md={6}>
                                <TextField size="small" fullWidth label="ETP WebSocket URL" placeholder="wss://server.example.com/etp" value={settingsDraft.etp20_endpoint ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_endpoint: e.target.value })} helperText="Use ws:// or wss:// URL supplied by the ETP server." />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth label="Dataspace" value={settingsDraft.etp20_dataspace ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_dataspace: e.target.value })} />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth label="WITSML/EML version" value={settingsDraft.etp20_witsml_version ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_witsml_version: e.target.value })} />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField select size="small" fullWidth label="Auth type" value={settingsDraft.etp20_auth_type ?? 'none'} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_auth_type: e.target.value })}>
                                    <MenuItem value="none">None</MenuItem>
                                    <MenuItem value="basic">Basic</MenuItem>
                                    <MenuItem value="bearer">Bearer</MenuItem>
                                </TextField>
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth label="User name" value={settingsDraft.etp20_username ?? ''} disabled={!isAdmin || !settings || settingsDraft.etp20_auth_type !== 'basic'} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_username: e.target.value })} />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth type="password" label="Password" value={settingsDraft.etp20_password ?? ''} disabled={!isAdmin || !settings || settingsDraft.etp20_auth_type !== 'basic'} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_password: e.target.value })} />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth type="number" label="Timeout" value={settingsDraft.etp20_timeout_sec ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_timeout_sec: e.target.value })} InputProps={{ endAdornment: <InputAdornment position="end">sec</InputAdornment> }} />
                            </Grid>
                            <Grid item xs={12}>
                                <TextField size="small" fullWidth type="password" label="Bearer token" value={settingsDraft.etp20_bearer_token ?? ''} disabled={!isAdmin || !settings || settingsDraft.etp20_auth_type !== 'bearer'} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_bearer_token: e.target.value })} helperText="Bearer-token transport may require a reverse proxy that injects Authorization headers for strict ETP servers." />
                            </Grid>
                            <Grid item xs={12}><Divider sx={{ my: 0.5 }} /></Grid>
                            <Grid item xs={12} md={3}>
                                <FormControlLabel
                                    control={<Switch checked={!!settingsDraft.etp20_server_enabled} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_server_enabled: e.target.checked })} />}
                                    label="Enable built-in ETP server"
                                />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField size="small" fullWidth label="Server path" value={settingsDraft.etp20_server_path ?? '/etp'} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_server_path: e.target.value })} helperText="Default: /etp" />
                            </Grid>
                            <Grid item xs={12} md={6}>
                                <TextField size="small" fullWidth type="password" label="Server bearer token (optional)" value={settingsDraft.etp20_server_token ?? ''} disabled={!isAdmin || !settings} onChange={(e) => setSettingsDraft({ ...settingsDraft, etp20_server_token: e.target.value })} helperText="If set, clients must connect with Authorization: Bearer token or ?token=..." />
                            </Grid>
                        </Grid>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5 }}>
                            Central outbound client: {etpStatus?.client?.state || etpStatus?.state || 'disabled'} | Built-in server: {etpStatus?.server?.state || 'disabled'} at {etpStatus?.server?.path || '/etp'} | Connected ETP clients: {etpStatus?.server?.clientCount ?? 0} | Last ETP ingest: {etpStatus?.server?.lastIngestRig || '--'} / {etpStatus?.server?.lastIngestPoints ?? 0} points
                        </Typography>
                    </Paper>

                    {/* 4) ACTIVE DIRECTORY (WINDOWS DOMAIN LOGIN) --------------------------- */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <VpnKey color="primary" />
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">Active Directory (Windows domain login)</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Sign in with Windows-domain accounts; AD security groups map to portal roles.
                                    Environment variables stay the defaults — values saved here override them live. Audit-logged.
                                </Typography>
                            </Box>
                            <Chip
                                size="small"
                                color={ldapCfg?.ldapEnabled ? 'success' : 'default'}
                                label={ldapCfg?.ldapEnabled ? `Domain login ACTIVE (${ldapCfg.mode})` : 'Domain login inactive'}
                            />
                            {isAdmin && (
                                <Stack direction="row" spacing={1}>
                                    <Button variant="outlined" startIcon={<Cable />} disabled={ldapTesting || !ldapCfg} onClick={testLdapConnection}>
                                        {ldapTesting ? 'Testing…' : 'Test connection'}
                                    </Button>
                                    <Button variant="contained" startIcon={<Save />} disabled={ldapSaving || !ldapCfg} onClick={saveLdap}>
                                        {ldapSaving ? 'Saving…' : 'Save'}
                                    </Button>
                                </Stack>
                            )}
                        </Stack>
                        {ldapMsg && <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setLdapMsg('')}>{ldapMsg}</Alert>}
                        {ldapTest && <Alert severity={ldapTest.ok ? 'success' : 'error'} sx={{ mb: 1.5 }} onClose={() => setLdapTest(null)}>{ldapTest.message}</Alert>}
                        {!isAdmin ? (
                            <Typography variant="caption" color="text.secondary">
                                Administrator access required to view or change domain-login settings.
                            </Typography>
                        ) : (
                            <>
                                <Grid container spacing={2}>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            select size="small" fullWidth label="Authentication mode"
                                            value={ldapDraft.mode} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, mode: e.target.value })}
                                            SelectProps={{ renderValue: (v) => (LDAP_MODES.find((m) => m.value === v)?.label || v) }}
                                            helperText={(LDAP_MODES.find((m) => m.value === ldapDraft.mode) || LDAP_MODES[0]).help}
                                        >
                                            {LDAP_MODES.map((m) => (
                                                <MenuItem key={m.value} value={m.value}>
                                                    <Box>
                                                        <Typography variant="body2">{m.label}</Typography>
                                                        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'normal', display: 'block' }}>{m.help}</Typography>
                                                    </Box>
                                                </MenuItem>
                                            ))}
                                        </TextField>
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            size="small" fullWidth label="Domain (UPN suffix)" placeholder="corp.example.com"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.domain} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, domain: e.target.value })}
                                            helperText="Used to build user@domain logins from bare usernames."
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            select size="small" fullWidth label="Default role"
                                            value={ldapDraft.defaultRole} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, defaultRole: e.target.value })}
                                            helperText="Role for domain users who match no group mapping below."
                                        >
                                            {LDAP_ROLES.map((r) => <MenuItem key={r} value={r} sx={{ textTransform: 'capitalize' }}>{r}</MenuItem>)}
                                        </TextField>
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            size="small" fullWidth label="LDAP URL" placeholder="ldap://dc.corp.example.com:389 or ldaps://dc:636"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.url} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, url: e.target.value })}
                                            helperText="Domain Controller address. Use ldaps:// (or StartTLS) in production."
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            size="small" fullWidth label="Search base" placeholder="DC=corp,DC=example,DC=com"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.searchBase} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, searchBase: e.target.value })}
                                            helperText="Directory subtree searched for user entries."
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            size="small" fullWidth label="Bind DN (service account)"
                                            placeholder="CN=svc-crmf,OU=Service Accounts,DC=corp,DC=example,DC=com"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.bindDN} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, bindDN: e.target.value })}
                                            helperText="Leave blank for direct user@domain bind (no service account)."
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={6}>
                                        <TextField
                                            size="small" fullWidth type="password" label="Bind password" autoComplete="new-password"
                                            placeholder={ldapCfg?.hasBindPassword ? 'unchanged — leave blank to keep' : ''}
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapPassword} disabled={!ldapCfg}
                                            onChange={(e) => setLdapPassword(e.target.value)}
                                            helperText="Write-only: never displayed. Only sent when you type a new one."
                                        />
                                    </Grid>
                                    <Grid item xs={12}>
                                        <TextField
                                            size="small" fullWidth label="Search filter"
                                            placeholder="(|(sAMAccountName={username})(userPrincipalName={username}))"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.searchFilter} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, searchFilter: e.target.value })}
                                            helperText={'{username} is replaced with the login name (LDAP-escaped).'}
                                        />
                                    </Grid>
                                    <Grid item xs={12}>
                                        <Typography variant="subtitle2" fontWeight={800}>Group → role mapping</Typography>
                                        <Typography variant="caption" color="text.secondary">
                                            Comma-separated AD security-group names (CN or full DN). First match wins: admin, then operator, then viewer.
                                        </Typography>
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            size="small" fullWidth label="Admin groups" placeholder="CRMF-Admins, Domain Admins"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.roleAdmin} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, roleAdmin: e.target.value })}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            size="small" fullWidth label="Operator groups" placeholder="CRMF-Operators"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.roleOperator} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, roleOperator: e.target.value })}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <TextField
                                            size="small" fullWidth label="Viewer groups" placeholder="CRMF-Viewers"
                                            InputLabelProps={{ shrink: true }}
                                            value={ldapDraft.roleViewer} disabled={!ldapCfg}
                                            onChange={(e) => setLdapDraft({ ...ldapDraft, roleViewer: e.target.value })}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={4}>
                                        <FormControlLabel
                                            control={<Switch checked={ldapDraft.startTLS} disabled={!ldapCfg}
                                                onChange={(e) => setLdapDraft({ ...ldapDraft, startTLS: e.target.checked })} />}
                                            label="StartTLS (upgrade ldap:// to TLS)"
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={8}>
                                        <FormControlLabel
                                            control={<Switch checked={ldapDraft.rejectUnauthorized} disabled={!ldapCfg}
                                                onChange={(e) => setLdapDraft({ ...ldapDraft, rejectUnauthorized: e.target.checked })} />}
                                            label="Validate TLS certificate"
                                        />
                                        {!ldapDraft.rejectUnauthorized && (
                                            <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
                                                Warning: certificate validation is OFF — the connection can be intercepted. Use only for lab / self-signed Domain Controllers.
                                            </Typography>
                                        )}
                                    </Grid>
                                </Grid>
                                <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5 }}>
                                    Test connection uses the last saved settings — Save first if you changed anything.
                                    It binds the service account (or reads the root DSE anonymously) without attempting a user login.
                                </Typography>
                            </>
                        )}
                    </Paper>

                    {/* 5) USER LIVENESS ----------------------------------------------------- */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Box mb={1}>
                            <Typography variant="h6">Signed-in users</Typography>
                            <Typography variant="caption" color="text.secondary">
                                Live presence across the portal. Refreshes every 10 seconds.
                            </Typography>
                        </Box>
                        <Divider sx={{ mb: 1 }} />
                        <TableContainer sx={{ maxHeight: 320, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell align="center">Status</TableCell>
                                    <TableCell>User</TableCell><TableCell>Role</TableCell>
                                    <TableCell>Source</TableCell><TableCell align="right">Last seen</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {presence.map((u) => (
                                        <TableRow key={u.username} hover>
                                            <TableCell align="center">
                                                <Tooltip title={u.online ? 'Online' : 'Offline'}>
                                                    <FiberManualRecord sx={{ fontSize: 12, color: u.online ? '#22c55e' : '#64748b' }} />
                                                </Tooltip>
                                            </TableCell>
                                            <TableCell>
                                                <Typography variant="body2" fontWeight={700}>{u.display || u.username}</Typography>
                                                <Typography variant="caption" color="text.secondary" fontFamily="monospace">{u.username}</Typography>
                                            </TableCell>
                                            <TableCell>
                                                <Typography variant="caption" sx={{ color: ROLE_COLOR[u.role] || 'text.secondary', fontWeight: 700, textTransform: 'uppercase' }}>{u.role || '—'}</Typography>
                                            </TableCell>
                                            <TableCell>{u.source || '—'}</TableCell>
                                            <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(u.lastSeen)}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                    {!presence.length && (
                                        <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>No active sessions.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>

                </Stack>
            </Box>

            {/* Add rig dialog */}
            <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>Add rig</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} mt={0}>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth label="Rig ID" value={draft.rigId} autoComplete="off"
                                helperText="Must match the Device ID configured on the rig's edge app."
                                onChange={(e) => setDraft({ ...draft, rigId: e.target.value })} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth label="Name" value={draft.name}
                                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        </Grid>
                        <Grid item xs={12}>
                            <Alert severity="info" sx={{ mt: 0.5 }}>
                                A unique device token is generated automatically on save and shown once,
                                together with the sync settings to enter on the edge app. Asset unit,
                                field and coordinates sync from the rig's own edge configuration.
                            </Alert>
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAddOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={addRig} disabled={savingRig || !draft.rigId || !draft.name}>{savingRig ? 'Saving…' : 'Add'}</Button>
                </DialogActions>
            </Dialog>

            {/* Delete rig confirm */}
            <Dialog open={!!delTarget} onClose={() => setDelTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Delete rig</DialogTitle>
                <DialogContent>
                    <Typography variant="body2">
                        Delete rig <b>{delTarget?.name}</b> (<code>{delTarget?.rig_id}</code>)? This cascades and removes all of its
                        stored telemetry. This cannot be undone.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDelTarget(null)}>Cancel</Button>
                    <Button variant="contained" color="error" onClick={deleteRig}>Delete</Button>
                </DialogActions>
            </Dialog>

            {/* Rotate token confirm */}
            <Dialog open={!!rotateTarget} onClose={() => !rotating && setRotateTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Rotate device token</DialogTitle>
                <DialogContent>
                    <Typography variant="body2">
                        Generate a new device token for <b>{rotateTarget?.name}</b> (<code>{rotateTarget?.rig_id}</code>)?
                        This <b>invalidates the current token</b>; the rig's edge node will stop syncing until
                        the new token is set as <code>DEVICE_TOKEN</code> on it. The new token is shown only once.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRotateTarget(null)} disabled={rotating}>Cancel</Button>
                    <Button variant="contained" color="warning" onClick={rotateRig} disabled={rotating}>
                        {rotating ? 'Rotating…' : 'Rotate token'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Device token reveal (shown once after create or rotate) */}
            <Dialog open={!!reveal} onClose={() => { setReveal(null); setCopied(false); }} fullWidth maxWidth="sm">
                <DialogTitle>Edge sync credentials — save them now</DialogTitle>
                <DialogContent>
                    <Alert severity="warning" sx={{ mb: 2 }}>
                        Sync credentials for <b>{reveal?.rig?.name}</b> (<code>{reveal?.rig?.rig_id}</code>).
                        The token is shown <b>only once</b>. Enter these three values in the rig's
                        edge app under <b>Edge Sync → configuration</b> (they map to Central URL,
                        Device ID and Device token).
                    </Alert>
                    <TextField
                        size="small" fullWidth label="Central URL (edge → central ingest)"
                        value={networkUrls?.ingestUrl || ''} sx={{ mb: 1.5 }}
                        InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                        onFocus={(e) => e.target.select()}
                    />
                    <TextField
                        size="small" fullWidth label="Device ID"
                        value={reveal?.rig?.rig_id || ''} sx={{ mb: 1.5 }}
                        InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                        onFocus={(e) => e.target.select()}
                    />
                    <TextField
                        size="small" fullWidth label="Device token" value={reveal?.token || ''}
                        InputProps={{
                            readOnly: true,
                            sx: { fontFamily: 'monospace' },
                            endAdornment: (
                                <InputAdornment position="end">
                                    <Tooltip title={copied ? 'Copied' : 'Copy to clipboard'}>
                                        <IconButton size="small" onClick={copyToken}>
                                            <ContentCopy fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </InputAdornment>
                            ),
                        }}
                        onFocus={(e) => e.target.select()}
                    />
                </DialogContent>
                <DialogActions>
                    <Button startIcon={<ContentCopy />} onClick={copyToken}>{copied ? 'Copied' : 'Copy'}</Button>
                    <Button variant="contained" onClick={() => { setReveal(null); setCopied(false); }}>Done</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}







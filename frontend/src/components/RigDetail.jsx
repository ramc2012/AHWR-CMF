import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Grid, Paper, Typography, Stack, Button, Link as MLink, Alert,
    Tabs, Tab, IconButton, Tooltip, Divider, Menu, MenuItem, ListItemIcon,
    Dialog, DialogTitle, DialogContent, DialogActions, TextField, Chip,
} from '@mui/material';
import { ArrowBack, ExpandMore, ExpandLess, Refresh, Palette, Logout, VolumeOff, VolumeUp, GridView, ShowChart, Storage, Speed, Assignment, Timeline, NotificationsNone, Description, Healing, Settings, ChatBubbleOutline, Send } from '@mui/icons-material';
import { api, phaseColor } from '../api';
import { socket } from '../socket';
import { StatusChip, HealthBar, PriorityChip, fmtAgo, fmtNum } from './common';
import { RigDataProvider, useRigData } from '../context/RigDataContext';
import EdrView from './rig/EdrView';
import ErrorBoundary from './ErrorBoundary';
import EquipmentPanel from './rig/panels/EquipmentPanel';
import TrendsPanel from './rig/panels/TrendsPanel';
import EfficiencyPanel from './rig/panels/EfficiencyPanel';
import OperationsPanel from './rig/panels/OperationsPanel';
import RigAlarmsPanel from './rig/panels/RigAlarmsPanel';
import RigReportPanel from './rig/panels/RigReportPanel';
import RigMaintenancePanel from './rig/panels/RigMaintenancePanel';
import CentralRigConsoleOverview from './rig/CentralRigConsoleOverview';
import RigActivityPanel from './rig/panels/RigActivityPanel';

// Per-rig AHWR-50-TWIN style pages. These pages stay inside the central rig route;
// the fleet dashboard and other central modules keep their CRMF shell.
const HMI_TABS = [
    { key: 'overview', label: 'Overview', el: CentralRigConsoleOverview },
    { key: 'edr', label: 'EDR', el: TrendsPanel },
    { key: 'equipment', label: 'Equipment', el: EquipmentPanel },
    { key: 'efficiency', label: 'Efficiency', el: EfficiencyPanel },
    { key: 'activity', label: 'Activity', el: RigActivityPanel },
    { key: 'operations', label: 'Operations', el: OperationsPanel },
    { key: 'alarms', label: 'Alarms', el: RigAlarmsPanel },
    { key: 'reports', label: 'Reports & Logs', el: RigReportPanel },
    { key: 'maintenance', label: 'Maintenance', el: RigMaintenancePanel },
];
const HMI_MENU_META = {
    overview: { menuLabel: 'Rig Overview', icon: <GridView fontSize="small" /> },
    edr: { menuLabel: 'EDR', icon: <ShowChart fontSize="small" /> },
    equipment: { menuLabel: 'Equipment', icon: <Storage fontSize="small" /> },
    efficiency: { menuLabel: 'Efficiency', icon: <Speed fontSize="small" /> },
    activity: { menuLabel: 'Activity', icon: <Timeline fontSize="small" /> },
    operations: { menuLabel: 'Operations', icon: <Assignment fontSize="small" /> },
    alarms: { menuLabel: 'Alarms', icon: <NotificationsNone fontSize="small" /> },
    reports: { menuLabel: 'Reports', icon: <Description fontSize="small" /> },
    maintenance: { menuLabel: 'Maintenance', icon: <Healing fontSize="small" /> },
    settings: { menuLabel: 'Settings', icon: <Settings fontSize="small" /> },
};
const MESSAGE_TYPES = ['General', 'Instruction', 'Warning', 'Safety', 'Maintenance', 'Sensor Check', 'ETP / Network'];
const THEME_OPTIONS = [
    { key: 'dark', label: 'Dark Blue', color: 'primary.main' },
    { key: 'contrast', label: 'High Contrast', color: 'warning.main' },
    { key: 'green', label: 'Green Night', color: 'success.main' },
    { key: 'purple', label: 'Purple Night', color: 'secondary.main' },
];

function RigMessageButton({ rig }) {
    const [open, setOpen] = useState(false);
    const [messageType, setMessageType] = useState(() => localStorage.getItem(`crmf-message-type-${rig?.rigId || 'rig'}`) || 'General');
    const [text, setText] = useState('');
    const [rows, setRows] = useState([]);
    const [error, setError] = useState('');
    const [sending, setSending] = useState(false);
    const load = useCallback(() => {
        if (!rig?.rigId) return;
        api.rigMessages(rig.rigId, 50).then(setRows).catch((e) => setError(e?.response?.data?.error || 'failed to load messages'));
    }, [rig?.rigId]);
    useEffect(() => {
        if (!open) return undefined;
        load();
        const onUpdate = (row) => {
            if (row?.targetRigId === rig?.rigId) setRows((prev) => [row, ...prev.filter((m) => m.messageId !== row.messageId)].slice(0, 50));
        };
        socket.on('rig_message_update', onUpdate);
        return () => socket.off('rig_message_update', onUpdate);
    }, [open, load, rig?.rigId]);
    const chooseType = (type) => {
        setMessageType(type);
        localStorage.setItem(`crmf-message-type-${rig?.rigId || 'rig'}`, type);
    };
    const sendMessage = async () => {
        setSending(true); setError('');
        try {
            const row = await api.sendRigMessage(rig.rigId, { messageType, messageText: text });
            setRows((prev) => [row, ...prev.filter((m) => m.messageId !== row.messageId)]);
            setText('');
        } catch (e) {
            setError(e?.response?.data?.error || 'send failed');
        } finally {
            setSending(false);
        }
    };
    const retry = async (messageId) => {
        try {
            const row = await api.retryRigMessage(rig.rigId, messageId);
            setRows((prev) => [row, ...prev.filter((m) => m.messageId !== row.messageId)]);
        } catch (e) {
            setError(e?.response?.data?.error || 'retry failed');
        }
    };
    return (
        <>
            <Button
                variant="outlined"
                startIcon={<ChatBubbleOutline fontSize="small" />}
                onClick={() => setOpen(true)}
                sx={{ minWidth: 190, borderColor: 'rgba(56,189,248,.42)', color: '#38bdf8', fontWeight: 900, bgcolor: 'rgba(15,23,42,.58)', '&:hover': { borderColor: '#38bdf8', bgcolor: 'rgba(56,189,248,.10)' } }}
            >
                Central Message Centre
            </Button>
            <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { bgcolor: '#172235', color: 'white', border: '1px solid rgba(56,189,248,.25)' } }}>
                <DialogTitle sx={{ fontWeight: 900, color: 'primary.main' }}>Central Control Room Message - {rig?.rigId}</DialogTitle>
                <DialogContent>
                    {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
                        {MESSAGE_TYPES.map((type) => (
                            <Chip key={type} label={type} onClick={() => chooseType(type)} color={type === messageType ? 'primary' : 'default'} variant={type === messageType ? 'filled' : 'outlined'} />
                        ))}
                    </Stack>
                    <TextField
                        fullWidth multiline minRows={3} value={text}
                        onChange={(e) => setText(e.target.value.slice(0, 1000))}
                        placeholder="Type message for this rig only..."
                        helperText={`${text.length}/1000 characters`}
                    />
                    <Typography variant="subtitle2" fontWeight={900} sx={{ mt: 2, mb: 1 }}>Message History</Typography>
                    <Stack spacing={1} sx={{ maxHeight: 260, overflow: 'auto' }}>
                        {rows.length ? rows.map((m) => (
                            <Paper key={m.messageId} variant="outlined" sx={{ p: 1.25, bgcolor: 'rgba(15,23,42,.72)' }}>
                                <Stack direction="row" justifyContent="space-between" spacing={1}>
                                    <Typography fontWeight={900}>{m.messageType} · {m.messageText}</Typography>
                                    <Chip size="small" label={m.status} color={m.status === 'acknowledged' ? 'success' : m.status === 'failed' ? 'error' : 'info'} />
                                </Stack>
                                <Typography variant="caption" color="text.secondary">
                                    Sent {m.sentAt ? new Date(m.sentAt).toLocaleString() : '--'} by {m.senderDisplay || m.senderUsername}
                                    {m.acknowledgedAt ? ` · Ack ${new Date(m.acknowledgedAt).toLocaleString()} by ${m.acknowledgedBy || 'edge'}` : ''}
                                </Typography>
                                {m.status === 'failed' && <Button size="small" onClick={() => retry(m.messageId)}>Retry</Button>}
                            </Paper>
                        )) : <Typography color="text.secondary">No messages yet.</Typography>}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpen(false)}>Close</Button>
                    <Button variant="contained" startIcon={<Send />} disabled={sending || !text.trim()} onClick={sendMessage}>Send Message</Button>
                </DialogActions>
            </Dialog>
        </>
    );
}

function findMetric(rig, metric, fallbackLabel) {
    const keyMetrics = rig?.keyMetrics || [];
    return keyMetrics.find((k) => k.metric === metric) || keyMetrics.find((k) => k.label === fallbackLabel) || null;
}
const headerMaps = {
    opMode: { 1: 'DRILLING', 2: 'TRIP IN', 3: 'TRIP OUT', 4: 'CASING' },
    acs: { 0: 'UNKNOWN', 1: 'ON', 2: 'OFF', 3: 'DISABLE' },
};
function headerLabel(mapName, value, fallback = 'UNKNOWN') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = headerMaps[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}


function OnlineRigSelector() {
    const navigate = useNavigate();
    const [anchor, setAnchor] = useState(null);
    const [onlineRigs, setOnlineRigs] = useState([]);
    const loadOnline = useCallback(() => {
        api.fleet()
            .then((rows) => setOnlineRigs((rows || []).filter((r) => r.status === 'online')))
            .catch(() => setOnlineRigs([]));
    }, []);
    useEffect(() => {
        loadOnline();
        const id = setInterval(loadOnline, 5000);
        return () => clearInterval(id);
    }, [loadOnline]);
    const close = () => setAnchor(null);
    const openRig = (rigId) => {
        close();
        if (rigId) navigate(`/rigs/${rigId}`);
    };
    const count = onlineRigs.length;
    return (
        <Box sx={{ minWidth: 220, display: 'flex', alignItems: 'center' }}>
            <Button
                variant="outlined"
                onClick={(e) => { loadOnline(); setAnchor(e.currentTarget); }}
                endIcon={<ExpandMore />}
                sx={{
                    minWidth: 190,
                    justifyContent: 'space-between',
                    borderColor: 'rgba(34,197,94,.48)',
                    color: '#22c55e',
                    fontWeight: 900,
                    bgcolor: 'rgba(15,23,42,.55)',
                    '&:hover': { borderColor: '#22c55e', bgcolor: 'rgba(34,197,94,.10)' },
                }}
            >
                {count} ONLINE RIG{count === 1 ? '' : 'S'}
            </Button>
            <Menu
                anchorEl={anchor}
                open={!!anchor}
                onClose={close}
                PaperProps={{ sx: { mt: 0.75, minWidth: 260, bgcolor: '#334155', border: '1px solid rgba(34,197,94,.28)' } }}
            >
                {onlineRigs.length ? onlineRigs.map((r) => (
                    <MenuItem key={r.rigId} onClick={() => openRig(r.rigId)} sx={{ py: 1.05, fontWeight: 800 }}>
                        <Stack sx={{ width: '100%' }}>
                            <Typography fontWeight={900} color="success.main">{r.rigId}</Typography>
                            <Typography variant="caption" color="text.secondary">{r.activeJob || 'no job'} - lag {r.syncLagSec == null ? '--' : `${r.syncLagSec}s`}</Typography>
                        </Stack>
                    </MenuItem>
                )) : (
                    <MenuItem disabled sx={{ py: 1.2 }}>No online rigs</MenuItem>
                )}
            </Menu>
        </Box>
    );
}
function EdgeTwinTopBar({ rig, onBack, showKpiToggle, kpiOpen, onToggleKpis }) {
    const opMode = findMetric(rig, 'drilling.operation_mode', 'OP.MODE');
    const acs = findMetric(rig, 'acs.status', 'ACS');
    const holeDepth = findMetric(rig, 'drilling.hole_depth', 'HOLE DEPTH');
    const bitDepth = findMetric(rig, 'drilling.bit_depth', 'BIT DEPTH');
    const title = 'Asset Monitoring Centre';
    const [themeMode, setThemeMode] = useState(() => localStorage.getItem('crmf_theme_mode') || 'dark');
    const [themeAnchor, setThemeAnchor] = useState(null);
    const [muted, setMuted] = useState(() => localStorage.getItem('crmf_sound_muted') === '1');

    useEffect(() => {
        const safeMode = THEME_OPTIONS.some((item) => item.key === themeMode) ? themeMode : 'dark';
        if (safeMode !== themeMode) {
            setThemeMode(safeMode);
            localStorage.setItem('crmf_theme_mode', safeMode);
        }
        document.documentElement.dataset.crmfTheme = safeMode;
    }, [themeMode]);

    const chooseTheme = (next) => {
        setThemeMode(next);
        localStorage.setItem('crmf_theme_mode', next);
        document.documentElement.dataset.crmfTheme = next;
        setThemeAnchor(null);
    };

    const toggleMute = () => {
        const next = !muted;
        setMuted(next);
        localStorage.setItem('crmf_sound_muted', next ? '1' : '0');
        window.__CRMF_SOUND_MUTED = next;
        window.dispatchEvent(new CustomEvent('crmf-sound-muted-change', { detail: { muted: next } }));
    };

    return (
        <Paper sx={{ mb: 1, px: 2, py: 1.1, borderRadius: 1, bgcolor: '#172235', borderColor: 'rgba(62,166,255,0.18)' }}>
            <Stack direction="row" spacing={1.25} alignItems="stretch" flexWrap="wrap" useFlexGap>
                <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 220, mr: 1 }}>
                    <Button startIcon={<ArrowBack />} onClick={onBack} variant="outlined" size="small" sx={{ minWidth: 92 }}>Fleet</Button>
                    <Box>
                        <Typography variant="h6" fontWeight={900} sx={{ color: 'primary.main', lineHeight: 1, letterSpacing: 0 }} noWrap>
                            {title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" fontWeight={700}>{rig?.rigId || 'AHWR RIG'}</Typography>
                    </Box>
                </Stack>
                <RigMessageButton rig={rig} />
                <Box sx={{ flexGrow: 1 }} />
                <Stack direction="row" spacing={0.75} alignItems="center">
                    <OnlineRigSelector />
                    {showKpiToggle && (
                        <Tooltip title="Toggle KPI strip">
                            <IconButton size="small" onClick={onToggleKpis} sx={{ color: 'primary.main' }}>
                                {kpiOpen ? <ExpandLess /> : <ExpandMore />}
                            </IconButton>
                        </Tooltip>
                    )}
                    <Tooltip title="Refresh"><IconButton size="small" onClick={() => window.location.reload()}><Refresh fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Theme options">
                        <IconButton size="small" onClick={(event) => setThemeAnchor(event.currentTarget)} sx={{ color: THEME_OPTIONS.find((item) => item.key === themeMode)?.color || 'primary.main', border: '1px solid', borderColor: 'rgba(62,166,255,.35)' }}>
                            <Palette fontSize="small" />
                        </IconButton>
                    </Tooltip>
                    <Menu anchorEl={themeAnchor} open={Boolean(themeAnchor)} onClose={() => setThemeAnchor(null)} PaperProps={{ sx: { minWidth: 190 } }}>
                        {THEME_OPTIONS.map((item) => (
                            <MenuItem key={item.key} selected={themeMode === item.key} onClick={() => chooseTheme(item.key)}>
                                <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: item.color, mr: 1.2 }} />
                                {item.label}
                            </MenuItem>
                        ))}
                    </Menu>
                    <Tooltip title={muted ? 'Sound muted - click to unmute' : 'Sound on - click to mute'}>
                        <IconButton size="small" onClick={toggleMute} sx={{ color: muted ? 'text.secondary' : 'success.main', border: '1px solid', borderColor: muted ? 'rgba(148,163,184,.35)' : 'rgba(34,197,94,.45)' }}>
                            {muted ? <VolumeOff fontSize="small" /> : <VolumeUp fontSize="small" />}
                        </IconButton>
                    </Tooltip>
                    <Tooltip title="Back to fleet"><IconButton size="small" onClick={onBack} sx={{ color: 'error.main' }}><Logout fontSize="small" /></IconButton></Tooltip>
                </Stack>
            </Stack>
        </Paper>
    );
}

function RigPageMenu({ tab, onTabChange }) {
    const [anchor, setAnchor] = useState(null);
    const active = HMI_TABS[tab] || HMI_TABS[0];
    const meta = HMI_MENU_META[active.key] || { menuLabel: active.label, icon: <GridView fontSize="small" /> };
    const close = () => setAnchor(null);
    const choose = (index) => {
        onTabChange(index);
        close();
    };
    return (
        <Box>
            <Button
                variant="contained"
                onClick={(e) => setAnchor(e.currentTarget)}
                startIcon={meta.icon}
                endIcon={<ExpandLess sx={{ transform: anchor ? 'none' : 'rotate(180deg)' }} />}
                sx={{ minHeight: 48, minWidth: 220, justifyContent: 'flex-start', bgcolor: '#24364d', color: '#fff', fontWeight: 900, '&:hover': { bgcolor: '#2d415a' } }}
            >
                {meta.menuLabel}
            </Button>
            <Menu
                anchorEl={anchor}
                open={!!anchor}
                onClose={close}
                PaperProps={{ sx: { mt: 0.75, minWidth: 270, bgcolor: '#334155', border: '1px solid rgba(62,166,255,0.22)' } }}
            >
                {HMI_TABS.map((item, index) => {
                    const itemMeta = HMI_MENU_META[item.key] || { menuLabel: item.label, icon: <GridView fontSize="small" /> };
                    return (
                        <MenuItem key={item.key} selected={index === tab} onClick={() => choose(index)} sx={{ py: 1.15, gap: 1.25, fontWeight: 800, '&.Mui-selected': { bgcolor: 'rgba(56,189,248,0.18)', color: 'primary.main' } }}>
                            <ListItemIcon sx={{ minWidth: 32, color: index === tab ? 'primary.main' : 'text.secondary' }}>{itemMeta.icon}</ListItemIcon>
                            {itemMeta.menuLabel}
                        </MenuItem>
                    );
                })}
            </Menu>
        </Box>
    );
}

function RigStatusRow({ rig, tab, onTabChange }) {
    const { data: live } = useRigData();
    const opMode = findMetric(rig, 'drilling.operation_mode', 'OP.MODE');
    const acs = findMetric(rig, 'acs.status', 'ACS');
    const holeDepth = findMetric(rig, 'drilling.hole_depth', 'HOLE DEPTH');
    const bitDepth = findMetric(rig, 'drilling.bit_depth', 'BIT DEPTH');
    const liveBitDepth = live?.drilling?.bit_depth;
    const wellName = live?.well?.name || live?.wellName || live?.well_name || live?._activity?.wellName || live?._activity?.job || rig?.activeJob || 'no job';
    return (
        <Paper sx={{ px: 1.5, py: 0.75, mb: 1, borderRadius: 1, bgcolor: '#172235', borderColor: 'rgba(62,166,255,0.18)' }} variant="outlined">
            <Stack direction="row" spacing={1} alignItems="stretch" flexWrap={{ xs: 'wrap', lg: 'nowrap' }} useFlexGap>
                <RigPageMenu tab={tab} onTabChange={onTabChange} />
                <TwinKpi label="OP.MODE" value={opMode ? headerLabel('opMode', opMode.value) : 'IDLE'} />
                <TwinKpi label="ACS" value={acs ? headerLabel('acs', acs.value) : 'UNKNOWN'} />
                <TwinKpi label="HOLE DEPTH" value={holeDepth ? fmtNum(holeDepth.value, 2) : '--'} unit={holeDepth?.unit || 'm'} accent="success.main" sx={{ minWidth: 170 }} />
                <TwinKpi label="BIT DEPTH" value={bitDepth?.value != null ? fmtNum(bitDepth.value, 2) : (liveBitDepth != null ? fmtNum(liveBitDepth, 2) : '--')} unit={bitDepth?.unit || 'm'} accent="primary.main" sx={{ minWidth: 170 }} />
                <Paper variant="outlined" sx={{ px: 2.25, py: 0.55, minWidth: 430, flex: '1 1 430px', borderRadius: 1, bgcolor: 'rgba(15,23,42,0.72)', display: 'grid', alignContent: 'center' }}>
                    <Stack direction="row" alignItems="center" spacing={3}>
                        <Box sx={{ minWidth: 165 }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={900}>RIG</Typography>
                            <Typography variant="subtitle1" fontWeight={900} color="primary.main" lineHeight={1.15}>{rig?.rigId}</Typography>
                        </Box>
                        <Divider orientation="vertical" flexItem />
                        <Box sx={{ minWidth: 190 }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={900}>WELL</Typography>
                            <Typography variant="subtitle1" fontWeight={900} color="success.main" lineHeight={1.15}>{wellName}</Typography>
                        </Box>
                    </Stack>
                </Paper>
                <Box sx={{ flexGrow: 1 }} />
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ px: 1 }}>
                    <StatusChip status={rig?.status} size="small" />
                </Stack>
            </Stack>
        </Paper>
    );
}

function TwinKpi({ label, value, unit, accent = 'primary.main', sx }) {
    return (
        <Paper variant="outlined" sx={{ px: 1.75, py: 0.75, minWidth: 145, borderRadius: 1, textAlign: 'center', bgcolor: 'rgba(15,23,42,0.72)', display: 'grid', alignContent: 'center', ...sx }}>
            <Typography variant="caption" color="text.secondary" fontWeight={900} lineHeight={1} sx={{ display: 'block' }}>{label}</Typography>
            <Typography variant="subtitle1" fontWeight={900} lineHeight={1.15} sx={{ color: accent }} noWrap>
                {value} {unit && <Typography component="span" variant="caption" color="text.secondary">{unit}</Typography>}
            </Typography>
        </Paper>
    );
}

export default function RigDetail() {
    const { id } = useParams();
    const nav = useNavigate();
    const [rig, setRig] = useState(null);
    const [err, setErr] = useState('');
    const [metric, setMetric] = useState('drawworks.hook_load');  // KPI-strip highlight selection
    const [tab, setTab] = useState(0);   // AHWR-50-TWIN style rig pages
    const [kpiOpen, setKpiOpen] = useState(false);  // KPI strip on HMI tabs (default hidden)

    const load = useCallback(() => {
        api.rig(id).then(setRig).catch((e) => setErr(e?.response?.data?.error || 'failed to load rig'));
    }, [id]);

    useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    // Reflect live deltas for this rig immediately.
    useEffect(() => {
        const onUpdate = (row) => { if (row.rigId === id) setRig((r) => (r ? { ...r, ...row } : r)); };
        socket.on('fleet_update', onUpdate);
        return () => socket.off('fleet_update', onUpdate);
    }, [id]);

    if (err) return <Alert severity="error">{err} Ã¢â‚¬â€ <MLink sx={{ cursor: 'pointer' }} onClick={() => nav('/')}>back to fleet</MLink></Alert>;
    if (!rig) return <Typography color="text.secondary">Loading {id}Ã¢â‚¬Â¦</Typography>;

    // The Overview tab renders its own KPI row, so the shared collapsible strip is only
    // for the HMI tabs (toggled via the "KPIs" button); never auto-shown on Overview.
    const showKpis = tab > 0 && kpiOpen;
    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ flex: '0 0 auto' }}>
                <EdgeTwinTopBar rig={rig} onBack={() => nav('/')} showKpiToggle={tab > 0} kpiOpen={kpiOpen} onToggleKpis={() => setKpiOpen((o) => !o)} />
                <RigStatusRow rig={rig} tab={tab} onTabChange={setTab} />

                {showKpis && (
                    <Grid container spacing={1} mb={0.5}>
                        {rig.keyMetrics?.map((k) => (
                            <Grid item xs={4} sm={3} md={2} key={k.metric}>
                                <Paper sx={{ p: 1, cursor: 'pointer', borderColor: metric === k.metric ? 'primary.main' : undefined }} onClick={() => setMetric(k.metric)}>
                                    <Typography variant="caption" color="text.secondary" noWrap>{k.label}</Typography>
                                    <Typography variant="subtitle1" fontWeight={800} lineHeight={1.2}>{fmtNum(k.value)} <Typography component="span" variant="caption" color="text.secondary">{k.unit}</Typography></Typography>
                                </Paper>
                            </Grid>
                        ))}
                    </Grid>
                )}
            </Box>

            {/* Tab content fills the remaining viewport height; tall panels scroll
                within, while the EDR (height:100%) fills exactly. A single
                RigDataProvider feeds both the Overview (live equipment/efficiency)
                and the HMI mirror panels. */}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <RigDataProvider rigId={id}>
                <ErrorBoundary key={HMI_TABS[tab].key} label="This panel">
                    {React.createElement(HMI_TABS[tab].el, {
                        rigId: id,
                        rig,
                        onTabChange: (key) => {
                            const nextTab = HMI_TABS.findIndex((item) => item.key === key);
                            if (nextTab >= 0) setTab(nextTab);
                        },
                    })}
                </ErrorBoundary>
            </RigDataProvider>
            </Box>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Overview Ã¢â‚¬â€ operator dashboard mirror of the edge app.
// ---------------------------------------------------------------------------

const fmtDur = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
};
const fmtMins = (sec) => `${Math.round((Number(sec) || 0) / 60)}m`;

const pctMaps = {
    sequence: { 0: 'OFF', 1: 'MAKE-UP', 2: 'BREAK-OUT', 3: 'RESET', 4: 'FAULT' },
    operationMode: { 0: 'UNKNOWN', 1: 'NORMAL', 2: 'MANUAL' },
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    dollyWorkPark: { 0: 'NONE', 1: 'OUT PARK. POS', 2: 'MOVE WORK', 3: 'MOVE PARK', 4: 'IN PARK', 5: 'FAULT', 6: 'IN WORK' },
    clamp: { 0: 'NONE', 1: 'OPENING', 2: 'CLOSING', 3: 'IS OPEN', 4: 'IS CLOSE', 5: 'FAULT' },
    dollyUpDown: { 0: 'NO CMD ACTIVE', 1: 'MOVE UP', 2: 'MOVE DOWN' },
    spinnerRotation: { 0: 'NO CMD ACTIVE', 1: 'FULLY UP', 2: 'FULLY DOWN', 3: 'MAKE-UP', 4: 'BREAK-OUT', 10: 'SPINNER NOT MOUNTED' },
    spinnerGripper: { 0: 'NONE', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT', 10: 'SPINNER NOT MOUNTED' },
    spinnerFloating: { 0: 'OFF', 1: 'ON', 10: 'SPINNER NOT MOUNTED' },
};
function pctLabel(mapName, value, fallback = 'UNKNOWN') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = pctMaps[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}
const catMaps = {
    status: { '-1': 'UNKNOWN', 0: 'READY', 1: 'IN PROGRESS', 2: 'STATUS DONE', 3: 'EMERGENCY NOT OK', 4: 'NOT READY', 5: 'FAULT', 6: 'RUNNING + FAULT', 7: 'STOP FORCED' },
    sourceCmd: { 0: 'NONE', 1: 'LOCAL', 2: 'REMOTE', 3: 'MANUAL', 4: 'AUTO', 5: 'DCC', 6: '---' },
};
function catLabel(mapName, value, fallback = 'UNKNOWN') {
    if (value == null || value === '') return fallback;
    const key = String(Number(value));
    const map = catMaps[mapName] || {};
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return String(value);
}

// Map an equipment status code to a coarse chip ({label, color}) for the
// compact status grid. Codes follow the edge enums (0=off/idle, 2=on/run, etc.).
const htdMaps = {
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    workMode: { 0: 'UNKNOWN', 1: 'DRILL', 2: 'SPIN', 3: 'TORQUE' },
    opMode: { 0: 'UNKNOWN', 1: 'DOLLY', 2: 'LINK' },
    rotation: { 0: 'STAND STILL', 1: 'ROTATION FWD', 2: 'ROTATION BWD', 3: 'NEUTRAL' },
    lube: { 0: 'OFF', 1: 'CMD RUN', 2: 'RUNNING', 3: 'FAULT' },
    gearSelection: { '-1': 'FAULT', 0: 'UNKNOWN', 1: 'GEAR 1', 2: 'GEAR 2', 3: 'GEAR 3', 4: 'GEAR 4', 5: 'GEAR 1 REGENERATIVE', 6: 'GEAR 2 REGENERATIVE', 7: 'GEAR 3 REGENERATIVE', 8: 'GEAR 4 REGENERATIVE' },
    brake: { 0: 'UNKNOWN', 1: 'CLOSING', 2: 'CLOSED', 3: 'OPENING', 4: 'OPEN', 5: 'FAULT' },
    elevator: { 0: 'UNKNOWN', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT' },
    ibop: { 0: 'UNKNOWN', 1: 'OPENING', 2: 'CLOSING', 3: 'OPEN', 4: 'CLOSE', 5: 'FAULT' },
    linkRotation: { 0: 'UNKNOWN', 1: 'UNLOCKING', 2: 'UNLOCKED', 3: 'ROT. FWD', 4: 'ROT. BWD', 5: 'LOCKING', 6: 'LOCKED', 7: 'FAULT' },
    linkTilt: { 0: 'NONE', 1: 'FLOAT ON', 2: 'VERTICAL', 3: 'FLOAT OFF', 4: 'EXTEND', 5: 'RETRACT', 6: 'FAULT' },
    suspension: { 0: 'NONE', 1: 'IN PUSH', 2: 'IN PULL' },
    tilt: { 1: 'TILTING IN', 2: 'TILT IN', 3: 'TILTING OUT', 4: 'TILT OUT', 5: 'HALF WAY', 6: 'STAND STILL' },
    inclinationStatus: { 1: 'INCLINATION IN IN PROGRESS', 2: 'INCLINATION IN', 3: 'INCLINATION OUT IN PROGRESS', 4: 'INCLINATED OUT', 5: 'HALF WAY', 6: 'STAND STILL', 7: 'TILTED IN', 8: 'TILTED OUT' },
};
function htdLabel(mapName, value, fallback = 'UNKNOWN') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = htdMaps[mapName] || {};
    if (Number.isFinite(n)) {
        if (Object.prototype.hasOwnProperty.call(map, n)) return map[n];
        if (Object.prototype.hasOwnProperty.call(map, String(n))) return map[String(n)];
    }
    return String(value);
}
const hpuMaps = {
    status: { 0: 'OFF', 1: 'ON in IDLE', 2: 'ON' },
    opMode: { 0: 'UNKNOWN', 1: 'DRILLING', 2: 'RIGUP' },
    oilTemp: { 0: 'TEMP. OK', 1: 'TEMP. LOW', 2: 'TEMP. HIGH', 3: 'TEMP. HIGH-HIGH' },
    oilLevel: { 0: 'LEVEL OK', 1: 'LEVEL LOW', 2: 'LEVEL LOW-LOW', 3: 'LEVEL HIGH', 4: 'LEVEL HIGH-HIGH' },
    filter: { 0: 'CLOGGED', 1: 'OK' },
    pump: { 0: 'NOT READY', 1: 'READY', 2: 'ENABLE' },
};
function hpuLabel(mapName, value, fallback = 'UNKNOWN') {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    const map = hpuMaps[mapName] || {};
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(map, n)) return map[n];
    return String(value);
}
function equipChip(value) {
    if (value == null) return { label: 'Ã¢â‚¬â€', color: 'default' };
    const n = Number(value);
    if (Number.isNaN(n)) return { label: String(value), color: 'default' };
    if (n <= 0) return { label: 'OFF', color: 'default' };
    if (n === 1) return { label: 'IDLE', color: 'info' };
    if (n === 2) return { label: 'RUN', color: 'success' };
    return { label: 'FAULT', color: 'error' };  // 3+ -> fault/error states across the edge enums
}

function EquipChip({ label, value }) {
    const c = equipChip(value);
    return (
        <Stack direction="row" spacing={0.75} alignItems="center"
            sx={{ px: 1, py: 0.5, borderRadius: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
                bgcolor: c.color === 'default' ? 'text.disabled' : `${c.color}.main` }} />
            <Typography variant="caption" fontWeight={700} noWrap>{label}</Typography>
                <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" noWrap>{c.label}</Typography>
        </Stack>
    );
}

const EDR_STRIPS = [
    { title: 'Hoisting', pens: [
        { channelId: 'drawworks.hook_load', color: '#38bdf8', min: 0, max: 500, enabled: true },
        { channelId: 'drilling.rop', color: '#f472b6', min: 0, max: 80, enabled: true },
    ] },
    { title: 'Pump', pens: [
        { channelId: 'mudpump.spm', color: '#4ade80', min: 0, max: 200, enabled: true },
        { channelId: 'mudpump.pressure', color: '#fbbf24', min: 0, max: 500, enabled: true },
    ] },
];
const EDR_CHANNELS = ['drawworks.hook_load', 'drilling.rop', 'mudpump.spm', 'mudpump.pressure'];

function OverviewTab({ rigId, rig }) {
    const { data: live } = useRigData();
    const dw = live?.drawworks || {};
    const dr = live?.drilling || {};
    const mp = live?.mudpump || {};
    const hpu = live?.hpu || {};
    const htd = live?.htd || {};
    const pct = live?.pct || {};
    const eng = live?.cat_engine || {};
    const acs = live?.acs || {};
    const cwk = live?.cwk || {};

        const [overviewTrends, setOverviewTrends] = useState({ woh: [], htd: [], catRpm: [], catLoad: [] });

    useEffect(() => {
        let alive = true;
        const load = async () => {
            try {
                                const [wohRows, htdRows, catRpmRows, catLoadRows] = await Promise.all([
                    api.history(rigId, 'drawworks.hook_load', 60),
                    api.history(rigId, 'htd.rpm', 60),
                    api.history(rigId, 'cat_engine.rpm', 60),
                    api.history(rigId, 'cat_engine.load', 60),
                ]);
                if (alive) setOverviewTrends({ woh: wohRows || [], htd: htdRows || [], catRpm: catRpmRows || [], catLoad: catLoadRows || [] });
            } catch (e) {
                if (alive) setOverviewTrends({ woh: [], htd: [], catRpm: [], catLoad: [] });
            }
        };
        load();
        const id = setInterval(load, 15000);
        return () => { alive = false; clearInterval(id); };
    }, [rigId]);
const hookLoad = dw.hook_load ?? 0;
    const wob = dr.wob ?? 0;
    const htdRpm = htd.rpm ?? dr.rpm ?? 0;
    const torque = htd.torque ?? dr.torque ?? 0;
    const spp = (Number(mp.pressure) || 0) * 14.5038;
    const spm = mp.spm ?? 0;
    const blockPosition = dw.block_position ?? dr.bit_depth ?? 0;
    const activity = live?._activity || {};

    return (
        <Box sx={{ bgcolor: '#0b1220', minHeight: '100%', p: 1.25, overflowX: 'hidden', overflowY: 'auto' }}>
            <Box sx={{
                width: '100%',
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', xl: '150px minmax(980px, 1.35fr) minmax(560px, .8fr)' },
                gap: 1.2,
                alignItems: 'stretch',
            }}>
                <TwinPanel sx={{ minHeight: 690, display: 'flex', flexDirection: 'column', p: 1.2, bgcolor: '#1b2940' }}>
                    <Typography sx={{ color: '#8797b0', fontSize: 11, fontWeight: 900, letterSpacing: 2, mb: 1.4 }}>STRING & ACTIVITY</Typography>
                    <Box sx={{ border: '1px solid #33445f', borderRadius: 1, p: 1.2, mb: 1 }}>
                        <Typography sx={{ color: '#8797b0', fontSize: 9, fontWeight: 900 }}>CURRENT ACTIVITY</Typography>
                        <Typography sx={{ color: '#fff', fontSize: 19, fontWeight: 900 }}>{activity.label || rig?.activeActivity || 'IDLE'}</Typography>
                        <Typography sx={{ color: '#8797b0', fontSize: 8, fontWeight: 800 }}>auto</Typography>
                    </Box>
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.8, mb: 1 }}>
                        <TwinTinyMetric label="STRING" value={dr.bit_depth ?? 0} unit="m" color="#ff9d2e" />
                        <TwinTinyMetric label="TOTAL" value={dr.hole_depth ?? 0} unit="m" color="#f4f8ff" />
                    </Box>
                    <TwinStringDepth bitDepth={dr.bit_depth ?? 0} holeDepth={dr.hole_depth ?? 0} sx={{ flex: 1, minHeight: 360 }} />
                    <Box sx={{ border: '1px solid #33445f', borderRadius: 1, p: 1.1, mt: 1 }}>
                        <Typography sx={{ color: '#8797b0', fontSize: 9, fontWeight: 900, mb: 0.7 }}>CONNECTIONS</Typography>
                        <Stack direction="row" justifyContent="space-between">
                            <Typography sx={{ color: '#8797b0', fontSize: 9, fontWeight: 900 }}>TORQUE TURN</Typography>
                            <Typography sx={{ color: '#ffc24b', fontSize: 9, fontWeight: 900 }}>LAST MAKE-UP</Typography>
                        </Stack>
                        <Stack direction="row" justifyContent="space-between" mt={0.3}>
                            <Typography sx={{ color: '#fff', fontSize: 12, fontWeight: 900 }}>IDLE</Typography>
                            <Typography sx={{ color: '#23dd86', fontSize: 12, fontWeight: 900 }}>{fmtNum(pct.last_makeup_torque ?? 0, 0)} daN-m</Typography>
                        </Stack>
                    </Box>
                </TwinPanel>

                <TwinPanel sx={{ minHeight: 690, p: 1.2, bgcolor: '#1b2940' }}>
                    <Typography sx={{ color: '#8797b0', fontSize: 12, fontWeight: 900, letterSpacing: 2, mb: 1.2 }}>WORKOVER RIG & EQUIPMENT</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: '160px minmax(520px, 1fr) 160px', gap: 1.2, alignItems: 'stretch', height: 'calc(100% - 28px)' }}>
                        <Stack spacing={1.1} justifyContent="space-between">
                            <TwinEquipCard title="CAT ENG" status={catLabel('status', eng.status)} statusColor="#23dd86" rows={[
                                ['LOAD', `${fmtNum(eng.load ?? 0, 0)} %`, '#46a6ff'],
                                ['RPM', `${fmtNum(eng.rpm ?? 0, 0)}`, '#46a6ff'],
                                ['COOLANT', `${fmtNum(eng.coolant_temp ?? 0, 0)} degC`, '#46a6ff'],
                                ['OIL PRESS', `${fmtNum(eng.oil_pressure ?? 0, 1)} bar`, '#ff9d2e'],
                            ]} />
                            <TwinEquipCard title="HPU" status={hpuLabel('status', hpu.status)} statusColor="#ffc24b" rows={[
                                ['DISCHARGE', `${fmtNum(hpu.discharge_pressure ?? hpu.dis_press ?? hpu.pressure ?? 0, 0)} bar`, '#23dd86'],
                                ['OIL TEMP', `${fmtNum(hpu.oil_temp ?? hpu.temperature ?? 0, 1)} degC`, '#23dd86'],
                                ['OIL LEVEL', `${fmtNum(hpu.oil_level ?? 0, 0)} %`, '#23dd86'],
                                ['FILTERS', hpu.filter_status != null ? hpuLabel('filter', hpu.filter_status) : '7/8', '#23dd86'],
                            ]} />
                            <TwinEquipCard title="HTD" status={htdLabel('status', htd.status)} statusColor="#27cfe6" rows={[
                                ['RPM', `${fmtNum(htdRpm, 0)}`, '#9a8bff'],
                                ['TORQUE', `${fmtNum(torque, 0)} daN-m`, '#9a8bff'],
                                ['GEAR', htdLabel('gearSelection', htd.gear_selection ?? htd.gear_status), '#9a8bff'],
                                ['ELEVATOR', htdLabel('elevator', htd.elevator_status), '#9a8bff'],
                            ]} />
                            <TwinEquipCard title="PCT" status={pctLabel('status', pct.status)} statusColor="#8797b0" rows={[
                                ['MAKE-UP', `${fmtNum(pct.makeup_torque ?? 0, 0)} daN-m`, '#27cfe6'],
                                ['LAST', `${fmtNum(pct.last_makeup_torque ?? 0, 0)} daN-m`, '#27cfe6'],
                                ['DOLLY', pctLabel('dollyWorkPark', pct.dolly_status, 'IN PARK'), '#27cfe6'],
                                ['UP CLAMP', `${fmtNum(pct.clamp_up_pressure ?? 0, 1)} bar`, '#27cfe6'],
                            ]} />
                        </Stack>
                        <TwinWorkoverMast blockPosition={blockPosition} pct={pct} htd={htd} cwk={cwk} live={!!live} />
                        <Stack spacing={1.1} justifyContent="space-between">
                            <TwinEquipCard title="ACS" status={headerLabel('acs', acs.status, '---')} statusColor="#8797b0" danger rows={[
                                ['CROWNSAVER', `${fmtNum(acs.crownsaver ?? 0, 0)}mm`, '#ff4a60'],
                                ['FLOORSAVER', `${fmtNum(acs.floorsaver ?? 0, 0)}mm`, '#ff4a60'],
                                ['BOTTOMSAVER', `${fmtNum(acs.bottomsaver ?? 0, 0)}mm`, '#ff4a60'],
                                ['BLOCK POS', `${fmtNum(blockPosition, 0)}mm`, '#ff4a60'],
                            ]} />
                            <TwinEquipCard title="CIRC PUMP" status={Number(spm) > 0 ? 'PUMPING' : 'STOPPED'} statusColor={Number(spm) > 0 ? '#23dd86' : '#64748b'} rows={[
                                ['PRESS', `${fmtNum(spp, 0)} psi`, '#a9ef34'],
                                ['RATE', `${fmtNum(spm, 0)} spm`, '#a9ef34'],
                                ['TRIP TANK', `${fmtNum(live?.fluid?.trip_tank ?? 0, 1)} m3`, '#a9ef34'],
                                ['GAIN/LOSS', `${fmtNum(live?.fluid?.tank_gain_loss ?? 0, 0)} m3`, '#a9ef34'],
                            ]} />
                            <TwinEquipCard title="CATWALK" status={Number(cwk.status) === 1 ? 'PARKED' : '---'} statusColor={Number(cwk.status) === 1 ? '#23dd86' : '#64748b'} rows={[
                                ['CARRIER', cwk.carrier_status != null ? String(cwk.carrier_status) : '---', '#ffc24b'],
                                ['CLAMP', cwk.clamp_status != null ? String(cwk.clamp_status) : '---', '#f4f8ff'],
                                ['CLAMP P', `${fmtNum(cwk.clamp_pressure ?? 0, 0)} bar`, '#ffc24b'],
                                ['CLAMP F', `${fmtNum(cwk.clamp_force ?? 0, 0)} daN`, '#ffc24b'],
                            ]} />
                            <TwinEquipCard title="WELL CONTROL" status={live?.well_control?.available ? 'OK' : 'NO BOP SOURCE'} statusColor={live?.well_control?.available ? '#23dd86' : '#ff4a60'} danger rows={[
                                ['TUBING P', `${fmtNum(live?.wellhead?.tubing_pressure ?? 0, 0)} bar`, '#f4f8ff'],
                                ['CASING P', `${fmtNum(live?.wellhead?.casing_pressure ?? 0, 0)} bar`, '#f4f8ff'],
                                ['ACCUM', `${fmtNum(live?.well_control?.accumulator_pressure ?? 0, 0)} psi`, '#f4f8ff'],
                                ['ANNULAR', `${fmtNum(live?.well_control?.annular_pressure ?? 0, 0)} psi`, '#f4f8ff'],
                            ]} />
                        </Stack>
                    </Box>
                </TwinPanel>

                <TwinPanel sx={{ minHeight: 690, p: 1.1, display: 'flex', flexDirection: 'column', bgcolor: '#1b2940' }}>
                    <Typography sx={{ color: '#8797b0', fontSize: 12, fontWeight: 900, letterSpacing: 2, mb: 1.2 }}>PRIMARY INSTRUMENTS</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.0, minHeight: 260 }}>
                        <Box sx={{ minHeight: 230, display: 'flex', flexDirection: 'column' }}>
                            <TwinGauge label="HOOK LOAD" value={hookLoad} unit="t" subLabel="WOB" subValue={wob} subUnit="t" max={100} majorStep={20} minorStep={4} color="#23dd86" />
                        </Box>
                        <Box sx={{ minHeight: 230, display: 'flex', flexDirection: 'column' }}>
                            <TwinGauge label="HTD" value={htdRpm} unit="rpm" subLabel="TORQUE" subValue={torque} subUnit="daN-m" subDecimals={0} max={180} majorStep={36} minorStep={6} color="#23dd86" />
                        </Box>
                        <Box sx={{ minHeight: 230, display: 'flex', flexDirection: 'column' }}>
                            <TwinGauge label="SPP" value={spp} unit="psi" decimals={0} subLabel="RATE" subValue={spm} subUnit="spm" max={3000} majorStep={600} minorStep={100} color="#23dd86" />
                        </Box>
                    </Box>
                    <Box sx={{ flex: 1, mt: 1.2, border: '1px solid rgba(62,166,255,.18)', borderRadius: 1, p: 1, bgcolor: '#07111e' }}>
                        <Typography sx={{ color: '#f4f8ff', fontSize: 12, fontWeight: 900, letterSpacing: 2, mb: 1 }}>LAST 12H TRENDS</Typography>
                        <TrendStrip color="#ff9d2e" points={overviewTrends.woh} max={100} label="HOOK LOAD" compact />
                        <TrendStrip color="#27cfe6" points={overviewTrends.htd} max={200} label="HTD RPM" compact />
                        <TrendStrip color="#ffc24b" points={overviewTrends.catLoad} max={100} label="GENSET LOAD" compact />
                    </Box>
                </TwinPanel>
            </Box>

            <Box sx={{
                mt: 1.0,
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: '17% minmax(0, 36%) minmax(0, 47%)' },
                gap: 1.0,
                alignItems: 'stretch',
                minHeight: 345,
            }}>
                <TwinPanel sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', p: 1.25 }}>
                    <PanelTitle title="CAT ENGINE" status={catLabel('status', eng.status)} />
                    <EngineIcon />
                    <EngineStat value={eng.rpm ?? 0} unit="RPM" color="#16b8ff" max={2200} points={overviewTrends.catRpm} sx={{ minHeight: 98 }} />
                    <Box sx={{ flexGrow: 1 }} />
                    <EngineStat label="LOAD" value={eng.load ?? 0} unit="%" color="#38f58a" max={100} points={overviewTrends.catLoad} sx={{ minHeight: 98 }} />
                </TwinPanel>

                <Stack spacing={1.0} sx={{ height: '100%', minHeight: 0 }}>
                    <TwinPanel sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <PanelTitle title="PCT" status={pctLabel('status', pct.status)} color="#a855f7" />
                        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 0.65 }}>
                            <ParamBox label="SEQUENCE" value={pctLabel('sequence', pct.sequence, 'OFF')} fill />
                            <ParamBox label="MAKE-UP TORQUE" value={pct.makeup_torque ?? 0} unit="daN*m" fill />
                            <ParamBox label="SPINNER MU TORQUE" value={pct.spinner_torque ?? 0} unit="daN*m" fill />
                            <ParamBox label="DOLLY STATUS" value={pctLabel('dollyWorkPark', pct.dolly_status, 'NONE')} fill />
                            <ParamBox label="LOW CLAMP STATUS" value={pctLabel('clamp', pct.clamp_low_status, 'NONE')} fill />
                            <ParamBox label="UPPER CLAMP STATUS" value={pctLabel('clamp', pct.clamp_up_status ?? pct.clamp_upper_status, 'NONE')} fill />
                        </Box>
                    </TwinPanel>

                    <TwinPanel sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <PanelTitle title="HTD" status={htdLabel('status', htd.status)} color="#38f58a" />
                        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 0.65 }}>
                            <ParamBox label="WORK MODE" value={htdLabel('workMode', htd.work_mode)} fill />
                            <ParamBox label="GEAR SELECTION" value={htdLabel('gearSelection', htd.gear_selection ?? htd.gear_status)} fill />
                            <ParamBox label="BRAKE" value={htdLabel('brake', htd.brake ?? htd.brake_status)} fill />
                            <ParamBox label="IBOP / ELEVATOR" value={`${htdLabel('ibop', htd.ibop_status)} / ${htdLabel('elevator', htd.elevator_status)}`} small fill />
                            <ParamBox label="ROTATION" value={htdLabel('rotation', htd.rotation ?? htd.rotation_status)} fill />
                            <ParamBox label="V-SPEED" value={htd.v_speed ?? 0} unit="mm/sec" fill />
                        </Box>
                    </TwinPanel>
                </Stack>

                <TwinPanel sx={{ height: '100%', minHeight: 345, display: 'flex', flexDirection: 'column' }}>
                    <PanelTitle title="HPU (HYDRAULIC POWER UNIT)" status={hpuLabel('status', hpu.status)} />
                    <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1.42fr 1fr' }, gap: 1.0, alignItems: 'stretch' }}>
                        <Box sx={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto repeat(3, minmax(0, 1fr))', gap: 0.65 }}>
                            <SubHead sx={{ mb: 0 }}>HYDRAULIC PUMPS</SubHead>
                            <ParamGroup title="PUMP-3 PDW" status={hpuLabel('pump', hpu.pdw_pump_status ?? hpu.pump_3_status, 'NOT READY')} warn>
                                <InlineParam label="FLOW SP" value={hpu.flow_sp ?? hpu.pdw_flow_sp ?? 0} unit="%" />
                                <InlineParam label="PRESS SP" value={hpu.press_sp ?? hpu.pdw_press_sp ?? 0} unit="bar" />
                                <InlineParam label="FLOW" value={hpu.flow ?? hpu.pdw_flow ?? 0} unit="%" />
                                <InlineParam label="PRESS" value={hpu.pressure ?? hpu.pdw_press ?? 0} unit="bar" />
                            </ParamGroup>
                            <ParamGroup title="HTD PUMP-2" status={hpuLabel('pump', hpu.htd_pump_2_status ?? hpu.htd_pump1_status, 'NOT READY')} warn>
                                <InlineParam label="FLOW SP" value={hpu.htd_pump_2_flow_sp ?? 0} unit="%" />
                                <InlineParam label="PRESS SP" value={hpu.htd_pump_2_press_sp ?? 0} unit="bar" />
                                <InlineParam label="FLOW" value={hpu.htd_pump_2_flow ?? 0} unit="%" />
                                <InlineParam label="PRESS" value={hpu.htd_pump_2_press ?? 0} unit="bar" />
                            </ParamGroup>
                            <ParamGroup title="HTD PUMP-4" status={hpuLabel('pump', hpu.htd_pump_4_status ?? hpu.htd_pump2_status ?? hpu.htd_pump4_status, 'NOT READY')} warn>
                                <InlineParam label="FLOW SP" value={hpu.htd_pump_4_flow_sp ?? 0} unit="%" />
                                <InlineParam label="PRESS SP" value={hpu.htd_pump_4_press_sp ?? 0} unit="bar" />
                                <InlineParam label="FLOW" value={hpu.htd_pump_4_flow ?? 0} unit="%" />
                                <InlineParam label="PRESS" value={hpu.htd_pump_4_press ?? 0} unit="bar" />
                            </ParamGroup>
                        </Box>
                        <Box sx={{ minHeight: 0, display: 'grid', gridTemplateRows: 'auto repeat(4, minmax(0, 1fr))', gap: 0.65 }}>
                            <SubHead sx={{ mb: 0 }}>OTHER PARAMETERS</SubHead>
                            <WideParamBox label="DIS PRESS" value={hpu.discharge_pressure ?? hpu.dis_press ?? hpu.pressure ?? 0} unit="bar" />
                            <WideParamBox label="AUX PRESS" value={hpu.aux_pressure ?? hpu.aux_press ?? 0} unit="bar" />
                            <WideParamBox label="OIL TEMP" value={hpu.oil_temp ?? hpu.temperature ?? 0} unit="degC" />
                            <WideParamBox label="OIL LEVEL" value={hpu.oil_level ?? 0} unit="%" />
                        </Box>
                    </Box>
                </TwinPanel>
            </Box>
        </Box>
    );
}
function TwinTinyMetric({ label, value, unit, color }) {
    return (
        <Box sx={{ bgcolor: '#07111e', border: '1px solid rgba(62,166,255,.18)', borderRadius: 0.75, px: 0.75, py: 0.65, minHeight: 48, display: 'grid', alignContent: 'center' }}>
            <Typography sx={{ color: '#8797b0', fontSize: 8, fontWeight: 900, lineHeight: 1 }}>{label}</Typography>
            <Typography sx={{ color, fontSize: 16, fontWeight: 900, lineHeight: 1.15 }}>{fmtNum(value, 0)}<Typography component="span" sx={{ color: '#b8c6dc', fontSize: 10, ml: 0.4 }}>{unit}</Typography></Typography>
        </Box>
    );
}

function TwinStringDepth({ bitDepth, holeDepth, sx }) {
    const bit = Math.max(0, Number(bitDepth) || 0);
    const total = Math.max(bit, Number(holeDepth) || 0, 1);
    const pct = Math.max(8, Math.min(92, (bit / total) * 88));
    return (
        <Box sx={{ height: 345, border: '1px solid #33445f', borderRadius: 1, position: 'relative', overflow: 'hidden', bgcolor: '#172236', ...sx }}>
            <Box sx={{ position: 'absolute', inset: 0, backgroundImage: 'repeating-linear-gradient(0deg, transparent 0 86px, rgba(148,163,184,.08) 87px)' }} />
            <Box sx={{ position: 'absolute', top: 18, bottom: 22, left: '44%', width: 2, bgcolor: '#46a6ff', opacity: 0.75 }} />
            <Box sx={{ position: 'absolute', top: 18, bottom: 22, left: '57%', width: 2, bgcolor: '#46a6ff', opacity: 0.75 }} />
            <Box sx={{ position: 'absolute', left: 11, right: 11, top: `${pct}%`, height: 3, bgcolor: '#ff9d2e' }} />
            <Box sx={{ position: 'absolute', top: `calc(${pct}% - 4px)`, right: 8, width: 10, height: 10, borderRadius: '50%', bgcolor: '#ff9d2e', boxShadow: '0 0 8px #ff9d2e' }} />
            <Typography sx={{ position: 'absolute', top: 13, left: 11, color: '#8797b0', fontSize: 8, fontWeight: 900 }}>SURFACE 0m</Typography>
            {[0.25, 0.5, 0.75].map((line) => (
                <Typography key={line} sx={{ position: 'absolute', top: `calc(${line * 100}% - 7px)`, right: 5, color: '#8797b0', fontSize: 8, fontWeight: 700 }}>{fmtNum(total * line, 0)}m</Typography>
            ))}
            <Typography sx={{ position: 'absolute', top: `calc(${pct}% - 13px)`, left: 11, color: '#ff9d2e', fontSize: 9, fontWeight: 900 }}>PIPE {fmtNum(bit, 0)}m</Typography>
        </Box>
    );
}

function TwinEquipCard({ title, status, statusColor = '#8797b0', rows = [], danger }) {
    return (
        <Box sx={{
            border: '1px solid rgba(62,166,255,.24)',
            borderLeft: `4px solid ${danger ? '#ff4a60' : statusColor}`,
            borderRadius: 1,
            bgcolor: '#07111e',
            p: 1,
            minHeight: 118,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
        }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" mb={0.5}>
                <Typography sx={{ color: '#f4f8ff', fontSize: 14, fontWeight: 900, lineHeight: 1 }}>{title}</Typography>
                <Stack direction="row" alignItems="center" spacing={0.45}>
                    <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: statusColor }} />
                    <Typography sx={{ color: statusColor, fontSize: 9, fontWeight: 900 }}>{status}</Typography>
                </Stack>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.55 }}>
                {rows.map(([label, value, color]) => (
                    <Box key={label} sx={{ minWidth: 0 }}>
                        <Typography sx={{ color: '#b8c6dc', fontSize: 8, fontWeight: 900, lineHeight: 1.2 }}>{label}</Typography>
                        <Typography sx={{ color: color || '#f4f8ff', fontSize: 12, fontWeight: 900, lineHeight: 1.2 }} noWrap>{value}</Typography>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

function TwinWorkoverMast({ blockPosition, pct, htd, cwk, live }) {
    const numeric = Math.max(0, Number(blockPosition) || 0);
    const y = 320 - Math.min(1, numeric / 15000) * 230;
    const dolly = pctLabel('dollyWorkPark', pct?.dolly_status, 'NO DATA');
    const elevator = htdLabel('elevator', htd?.elevator_status, 'NO DATA');
    return (
        <Box sx={{ minHeight: 620, position: 'relative', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
            <svg viewBox="0 0 390 540" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <defs>
                    <filter id="twinMastGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                </defs>
                <polygon points="195,54 116,453 274,453" fill="#0f172a" opacity="0.18" stroke="#46a6ff" strokeWidth="1.2" strokeDasharray="9 9" />
                <text x="160" y="74" textAnchor="end" fill="#8797b0" fontSize="11" fontWeight="900">CROWN</text>
                <rect x="170" y="42" width="50" height="20" rx="4" fill="#33445f" stroke="#8797b0" strokeWidth="2" />
                <circle cx="184" cy="52" r="5" fill="#8797b0" />
                <circle cx="207" cy="52" r="5" fill="#8797b0" />
                <line x1="185" y1="62" x2="130" y2="430" stroke="#33445f" strokeWidth="5" />
                <line x1="205" y1="62" x2="260" y2="430" stroke="#33445f" strokeWidth="5" />
                <line x1="195" y1="62" x2="195" y2="430" stroke="#1f2937" strokeWidth="6" />
                <line x1="184" y1="56" x2="184" y2={y - 45} stroke="#22ff66" strokeWidth="2" />
                <line x1="207" y1="56" x2="207" y2={y - 45} stroke="#22ff66" strokeWidth="2" />
                <line x1="150" y1="120" x2="60" y2="470" stroke="#33445f" strokeDasharray="8 8" opacity="0.55" />
                <line x1="240" y1="120" x2="330" y2="470" stroke="#33445f" strokeDasharray="8 8" opacity="0.55" />
                <text x="260" y="256" fill="#8797b0" fontSize="13" fontWeight="900">TELESCOPING</text>
                <rect x="170" y={y} width="50" height="18" rx="3" fill="#475569" stroke="#b8c6dc" strokeWidth="2" />
                <rect x="164" y={y - 45} width="62" height="32" rx="4" fill="#0b2738" stroke="#27cfe6" strokeWidth="3" filter="url(#twinMastGlow)" />
                <text x="195" y={y - 24} textAnchor="middle" fill="#27cfe6" fontSize="12" fontWeight="900">HTD</text>
                <rect x="158" y={y - 5} width="74" height="22" rx="5" fill="#111827" stroke="#ffc24b" strokeWidth="3" />
                <text x="195" y={y + 10} textAnchor="middle" fill="#ffc24b" fontSize="10" fontWeight="900">ELEVATOR</text>
                <text x="142" y={y + 5} textAnchor="end" fill="#ff9d2e" fontSize="11" fontWeight="900">{fmtNum(numeric, 0)} mm</text>
                <rect x="125" y="360" width="140" height="20" rx="4" fill="#33445f" stroke="#8797b0" strokeWidth="2" />
                <rect x="120" y="430" width="150" height="18" rx="3" fill="#33445f" />
                <line x1="95" y1="448" x2="310" y2="448" stroke="#33445f" strokeWidth="4" />
                <path d="M65 440 L120 417 L145 417 L145 440 Z" fill="none" stroke="#8797b0" strokeWidth="4" />
                <rect x="92" y="421" width="48" height="9" rx="2" fill="#263956" stroke="#8797b0" strokeWidth="2" />
                <text x="112" y="414" fill="#8797b0" fontSize="9" fontWeight="900">CARRIER</text>
                <text x="116" y="445" fill="#8797b0" fontSize="8" fontWeight="900">SLIDE</text>
                <rect x="255" y="360" width="62" height="24" rx="4" fill="#111827" stroke="#ffc24b" strokeWidth="4" filter="url(#twinMastGlow)" />
                <text x="286" y="376" textAnchor="middle" fill="#ffc24b" fontSize="11" fontWeight="900">PCT</text>
                <rect x="150" y="395" width="82" height="24" rx="3" fill="#111827" stroke="#ffc24b" />
                <text x="191" y="411" textAnchor="middle" fill="#ffc24b" fontSize="11" fontWeight="900">{dolly}</text>
                <rect x="158" y="377" width="74" height="28" rx="4" fill="#263956" stroke="#8797b0" strokeWidth="3" />
                <text x="195" y="390" textAnchor="middle" fill="#8797b0" fontSize="8" fontWeight="900">ELEVATOR</text>
                <text x="195" y="401" textAnchor="middle" fill="#8797b0" fontSize="8" fontWeight="900">{elevator}</text>
                <line x1="195" y1={y + 17} x2="195" y2="430" stroke="#27cfe6" strokeWidth="5" opacity={live ? 0.75 : 0.25} strokeDasharray="8 7" />
                <text x="195" y="416" textAnchor="middle" fill="#27cfe6" opacity="0.35" fontSize="13" fontWeight="900">NO DATA</text>
                <text x="195" y="505" textAnchor="middle" fill="#8797b0" fontSize="10" fontWeight="900" letterSpacing="2">WORKOVER MAST - ACS ENVELOPE</text>
                <text x="70" y="456" fill="#8797b0" fontSize="9" fontWeight="900">CATWALK {cwk?.status != null ? cwk.status : '--'}</text>
            </svg>
        </Box>
    );
}

function TwinPanel({ children, sx }) {
    return <Paper sx={{ p: 1.0, borderRadius: 1.5, bgcolor: '#111827', borderColor: 'rgba(62,166,255,0.24)', overflow: 'hidden', ...sx }}>{children}</Paper>;
}

function TwinGauge({ label, value = 0, unit, decimals, subLabel, subValue, subUnit, subDecimals, min = 0, max = 100, majorStep = 20, minorStep = 4, color = '#38BDF8', compactSub = false }) {
    const cx = 150;
    const cy = 150;
    const r = 135;
    const startAngle = 225;
    const totalSweep = 270;
    const clamped = Math.min(max, Math.max(min, Number(value) || 0));
    const valToAngle = (v) => startAngle - (((v - min) / ((max - min) || 1)) * totalSweep);
    const toXY = (deg, radius) => {
        const rad = (deg * Math.PI) / 180;
        return { x: cx + Math.cos(rad) * radius, y: cy - Math.sin(rad) * radius };
    };

    const majors = [];
    const minors = [];
    for (let t = min; t <= max; t += minorStep) {
        const angle = valToAngle(t);
        const isMajor = (t - min) % majorStep === 0;
        const p1 = toXY(angle, r);
        const p2 = toXY(angle, isMajor ? r - 12 : r - 6);
        if (isMajor) majors.push({ value: t, angle, p1, p2 });
        else minors.push({ angle, p1, p2 });
        if (majors.length + minors.length > 220) break;
    }

    const needleAngle = valToAngle(clamped);
    const tip = toXY(needleAngle, r - 35);
    const b1 = toXY(needleAngle + 90, 4);
    const b2 = toXY(needleAngle - 90, 4);
    const valueText = fmtNum(clamped, decimals ?? (Number.isInteger(clamped) ? 0 : 1));
    const subNumeric = Number(subValue);
    const subText = Number.isFinite(subNumeric) ? fmtNum(subNumeric, subDecimals ?? (Number.isInteger(subNumeric) ? 0 : 2)) : (subValue ?? '--');

    return (
        <Box sx={{ height: { xs: 320, lg: 'auto' }, flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', pt: 0.5, pb: 0 }}>
            <svg viewBox="0 0 300 340" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ maxHeight: '100%', transform: 'translateY(12px) scale(0.99)', transformOrigin: 'center center' }}>
                <circle cx={cx} cy={cy} r={r + 5} fill="#0b131e" stroke="#1e293b" strokeWidth="2" opacity="0.6" />
                {minors.map((t, i) => (
                    <line key={`min-${i}`} x1={t.p1.x} y1={t.p1.y} x2={t.p2.x} y2={t.p2.y} stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" />
                ))}
                {majors.map((t, i) => (
                    <g key={`maj-${i}`}>
                        <line x1={t.p1.x} y1={t.p1.y} x2={t.p2.x} y2={t.p2.y} stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
                        <text x={toXY(t.angle, r - 26).x} y={toXY(t.angle, r - 26).y} textAnchor="middle" dominantBaseline="central" fill="#9ca3af" fontSize="16" fontWeight="bold" fontFamily="monospace">
                            {t.value === min ? '' : t.value}
                        </text>
                    </g>
                ))}
                <path d="M252 57 A135 135 0 0 1 252 243" fill="none" stroke="#fbbf24" strokeWidth="4" />
                <path d="M252 243 A135 135 0 0 1 217 277" fill="none" stroke="#ef4444" strokeWidth="4" />
                <text x={cx} y={cy - 48} textAnchor="middle" fill={color} fontSize="22" fontWeight="bold" letterSpacing="1">{label}</text>
                <text x={cx} y={cy + 36} textAnchor="middle" dominantBaseline="middle" fill="#ffffff" fontSize="54" fontWeight="bold" fontFamily="Arial, sans-serif">{valueText}</text>
                <text x={cx} y={cy + 68} textAnchor="middle" fill="#9ca3af" fontSize="18" fontWeight="500">{unit}</text>
                <line x1={cx - 54} y1={cy + 86} x2={cx + 54} y2={cy + 86} stroke="#334155" strokeWidth="1.5" />
                <text x={cx} y={cy + 108} textAnchor="middle" fill="#bef264" fontSize="34" fontWeight="bold" fontFamily="Arial, sans-serif">{subText}</text>
                <text x={cx} y={cy + 130} textAnchor="middle" fill="#9ca3af" fontSize="14" fontWeight="700">
                    {subLabel} {subUnit ? `(${subUnit})` : ''}
                </text>
                <polygon points={`${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`} fill={color} />
                <circle cx={cx} cy={cy} r="6" fill="#111319" stroke="#ffffff" strokeWidth="1.5" />
            </svg>
        </Box>
    );
}

function AcsDerrick({ blockHeight, crownSaver, floorSaver }) {
    const numericHeight = Math.max(0, Number(blockHeight) || 0);
    const travel = Math.max(0, Math.min(1, numericHeight / 13000));
    const counterY = 350 - travel * 265;
    const crownLimit = Number(crownSaver);
    const floorLimit = Number(floorSaver);
    const crownOn = Number.isFinite(crownLimit) && crownLimit > 0 && numericHeight >= crownLimit;
    const floorOn = Number.isFinite(floorLimit) && numericHeight <= floorLimit;
    return (
        <Box sx={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', overflow: 'visible', mt: -1.0, mx: -0.2 }}>
            <svg viewBox="28 0 180 430" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ maxWidth: 460, transform: 'scaleX(1.48) scaleY(1.08)', transformOrigin: 'center center' }}>
                <defs>
                    <filter id="acsGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="6" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                    <filter id="counterGlow" x="-30%" y="-30%" width="160%" height="160%">
                        <feGaussianBlur stdDeviation="4" result="blur" />
                        <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                </defs>

                <polygon points="55,376 180,376 160,56 75,56" fill="#111827" stroke="#334155" strokeWidth="4" />
                <polygon points="75,56 160,56 164,124 71,124" fill="#ef4444" opacity="0.92" />
                <polygon points="71,124 164,124 168,168 67,168" fill="#f59e0b" opacity="0.96" />
                <line x1="69" y1="244" x2="166" y2="244" stroke="#334155" strokeWidth="2" />
                <line x1="64" y1="330" x2="171" y2="330" stroke="#334155" strokeWidth="2" />
                <polygon points="59,350 176,350 181,376 54,376" fill="#f59e0b" />

                <rect x="73" y="41" width="90" height="14" rx="4" fill="#475569" stroke="#64748b" strokeWidth="2" />
                <circle cx="94" cy="50" r="4" fill="#cbd5e1" />
                <circle cx="145" cy="50" r="4" fill="#cbd5e1" />
                <line x1="94" y1="49" x2="94" y2="376" stroke="#0b1220" strokeWidth="4" />
                <line x1="145" y1="49" x2="145" y2="376" stroke="#0b1220" strokeWidth="4" />

                {crownOn && (
                    <g filter="url(#acsGlow)">
                        <rect x="44" y="76" width="148" height="42" rx="7" fill="#ef4444" />
                        <text x="118" y="103" textAnchor="middle" fill="#ffffff" fontSize="16" fontWeight="900">CROWN SAVER ON</text>
                    </g>
                )}
                {floorOn && (
                    <g filter="url(#acsGlow)">
                        <rect x="44" y="292" width="148" height="42" rx="7" fill="#ef4444" />
                        <text x="118" y="319" textAnchor="middle" fill="#ffffff" fontSize="16" fontWeight="900">FLOOR SAVER ON</text>
                    </g>
                )}

                <g filter="url(#counterGlow)" transform={`translate(0 ${counterY - 345})`}>
                    <rect x="68" y="340" width="100" height="60" rx="8" fill="#062033" stroke="#f59e0b" strokeWidth="5" />
                    <rect x="76" y="348" width="84" height="44" rx="5" fill="none" stroke="#22b8ff" strokeWidth="2.5" />
                    <text x="118" y="382" textAnchor="middle" fill="#e0f2fe" fontSize="34" fontWeight="900">{String(Math.round(numericHeight))}</text>
                </g>
            </svg>
        </Box>
    );
}
function TrendStrip({ color, compact, points = [], max, label }) {
    const height = compact ? 58 : 76;
    const width = 320;
    const values = (points || []).map((p) => Number(p.value)).filter(Number.isFinite);
    const high = Math.max(Number(max) || 0, ...values, 1);
    const low = Math.min(0, ...values);
    const span = high - low || 1;
    const line = values.map((v, i) => {
        const x = values.length <= 1 ? 0 : (i / (values.length - 1)) * width;
        const y = height - 14 - ((v - low) / span) * (height - 24);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const area = line ? `0,${height - 6} ${line} ${width},${height - 6}` : '';
    return (
        <Box sx={{ position: 'relative', height, mt: 1, border: '1px solid rgba(62,166,255,.2)', borderRadius: 1, overflow: 'hidden', background: `linear-gradient(180deg, transparent 55%, ${color}16), repeating-linear-gradient(0deg, transparent 0 23px, rgba(148,163,184,.08) 24px), #07111e` }}>
            {label && <Typography variant="caption" sx={{ position: 'absolute', top: 4, left: 8, color: 'text.secondary', fontWeight: 900, zIndex: 1 }}>{label}</Typography>}
            <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
                {area && <polygon points={area} fill={color} opacity="0.16" />}
                {line && <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
            </svg>
        </Box>
    );
}

function PanelTitle({ title, status, color = 'primary.main' }) {
    return <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}><Typography fontWeight={900} color={color}>{title}</Typography><Button size="small" variant="outlined" sx={{ py: 0, minWidth: 90, fontWeight: 900 }}>{status}</Button></Stack>;
}

function StatusBar({ label, value }) {
    return <Box sx={{ mt: 0.5, bgcolor: '#065f46', color: '#d1fae5', border: '1px solid #10b981', borderRadius: 1, px: 2, py: 1, display: 'flex', justifyContent: 'space-between', fontWeight: 900, letterSpacing: 3 }}>{label}<span>{value}</span></Box>;
}

function MiniReadout({ label, value, unit }) {
    return (
        <Box sx={{ bgcolor: '#06111f', border: '1px solid rgba(62,166,255,.18)', borderRadius: 0.75, px: 0.75, py: 0.55, textAlign: 'center', minHeight: 42, display: 'grid', alignContent: 'center' }}>
            <Typography variant="caption" color="#facc15" fontWeight={900} sx={{ fontSize: 11, lineHeight: 1.1, display: 'block', whiteSpace: 'nowrap' }}>{label}</Typography>
            <Typography fontSize={23} lineHeight={1.15} fontWeight={900}>{fmtNum(value, 0)} <Typography component="span" variant="caption" color="text.secondary" fontWeight={900}>{unit}</Typography></Typography>
        </Box>
    );
}
function EngineIcon() {
    return (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 0.75 }}>
            <svg width="74" height="44" viewBox="0 0 74 44" fill="none" aria-hidden="true">
                <path d="M22 17h30l7 8v12H15V25l7-8Z" stroke="#16b8ff" strokeWidth="3" />
                <path d="M29 17v-7h16v7" stroke="#16b8ff" strokeWidth="3" />
                <path d="M10 29H3M71 29h-7M31 37v6M48 37v6" stroke="#16b8ff" strokeWidth="3" />
            </svg>
        </Box>
    );
}

function EngineStat({ label, value, unit, color, max = 100, points = [], sx }) {
    const numeric = Number(value) || 0;
    const historyValues = (points || []).map((p) => Number(p.value)).filter(Number.isFinite);
    const values = historyValues.length ? [...historyValues.slice(-120), numeric] : [numeric];
    const width = 260;
    const height = 74;
    const high = Math.max(Number(max) || 0, ...values, 1);
    const low = Math.min(0, ...values);
    const span = high - low || 1;
    const line = values.map((v, i) => {
        const x = values.length <= 1 ? 0 : (i / (values.length - 1)) * width;
        const y = height - 8 - ((v - low) / span) * (height - 16);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const area = line ? `0,${height - 4} ${line} ${width},${height - 4}` : '';
    return (
        <Box sx={{
            position: 'relative', overflow: 'hidden', textAlign: 'center', bgcolor: '#07111e',
            border: '1px solid rgba(62,166,255,.24)', borderRadius: 1, minHeight: 110,
            display: 'grid', gridTemplateRows: '44% 56%', px: 1,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent 0 23px, rgba(148,163,184,.07) 24px)',
            ...sx
        }}>
            {label && <Typography sx={{ position: 'absolute', top: 10, left: 14, zIndex: 2, color, fontWeight: 900, fontSize: 18, letterSpacing: 0.5 }}>{label}</Typography>}
            <Box sx={{ position: 'relative', zIndex: 1, display: 'grid', placeItems: 'end center', pb: 0.1 }}>
                <Typography sx={{ fontSize: label ? 34 : 36, lineHeight: 1, fontWeight: 900, color }}>
                    {fmtNum(numeric, 0)} <Typography component="span" fontSize={15} fontWeight={900} color="#eaf3ff">{unit}</Typography>
                </Typography>
            </Box>
            <Box sx={{ position: 'relative', mx: 0.75, mb: 0.7, borderTop: '1px solid rgba(148,163,184,.10)' }}>
                {line && (
                    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
                        <polygon points={area} fill={color} opacity="0.16" />
                        <polyline points={line} fill="none" stroke={color} strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                )}
            </Box>
        </Box>
    );
}
function BigNumber({ value, unit, color }) {
    return <Box sx={{ textAlign: 'center', bgcolor: '#07111e', border: '1px solid rgba(62,166,255,.18)', borderRadius: 1, py: 1.5 }}><Typography fontSize={40} fontWeight={900} color={color}>{fmtNum(value, 0)} <Typography component="span" fontSize={15} fontWeight={900}>{unit}</Typography></Typography></Box>;
}

function SubHead({ children, sx }) {
    return <Typography sx={{ border: '1px solid rgba(148,163,184,.2)', borderRadius: 0.75, px: 1.0, py: 0.55, color: '#94a3b8', fontWeight: 900, mb: 1, fontSize: 16, letterSpacing: 0.6, ...sx }}>{children}</Typography>;
}

function ParamBox({ label, value, unit, warn, small, fill }) {
    const isNum = typeof value === 'number';
    return <Box sx={{ bgcolor: '#07111e', border: '1px solid rgba(62,166,255,.18)', borderRadius: 0.75, p: 0.75, mb: fill ? 0 : 0.5, minHeight: fill ? 0 : 56, height: fill ? '100%' : 'auto', display: 'grid', alignContent: 'center' }}><Typography variant="caption" fontWeight={900} sx={{ lineHeight: 1.1 }}>{label}</Typography><Typography fontWeight={900} sx={{ color: warn ? '#facc15' : '#38f58a', fontSize: small ? 12 : 15, lineHeight: 1.2 }} noWrap>{isNum ? fmtNum(value, 2) : value} <Typography component="span" variant="caption" color="text.secondary">{unit}</Typography></Typography></Box>;
}

function WideParamBox({ label, value, unit, sx }) {
    return (
        <Box sx={{ bgcolor: '#07111e', border: '1px solid rgba(62,166,255,.18)', borderRadius: 0.75, px: 1.0, py: 0.7, mb: 0, minHeight: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.25, ...sx }}>
            <Typography fontWeight={900}>{label}</Typography>
            <Typography fontWeight={900} sx={{ color: '#38f58a', fontSize: 18, whiteSpace: 'nowrap' }}>{fmtNum(value, 2)} {unit}</Typography>
        </Box>
    );
}
function ParamGroup({ title, status, warn, children, sx }) {
    return (
        <Box sx={{ bgcolor: '#07111e', border: '1px solid rgba(62,166,255,.18)', borderRadius: 0.75, p: 0.75, mb: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', ...sx }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={0.5}>
                <Typography fontWeight={900} color="text.secondary" sx={{ fontSize: 16 }}>{title}</Typography>
                <Typography fontWeight={900} sx={{ color: warn ? '#facc15' : '#38f58a', fontSize: 14 }}>{status}</Typography>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
                {children}
            </Box>
        </Box>
    );
}

function InlineParam({ label, value, unit }) {
    return (
        <Typography fontWeight={900} sx={{ fontSize: 14, lineHeight: 1.35 }}>
            {label}: <Typography component="span" fontWeight={900} color="#38f58a">{fmtNum(value, 2)} {unit}</Typography>
        </Typography>
    );
}
const KPI_COLORS = ['#38bdf8', '#4ade80', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee'];

function EffRow({ label, value, color }) {
    return (
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <Typography variant="body2" fontWeight={800} sx={color ? { color } : undefined}>{value}</Typography>
        </Stack>
    );
}











































































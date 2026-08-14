import React, { useState, useCallback, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
    Box, Drawer, AppBar, Toolbar, Typography, List, ListItemButton, ListItemIcon, ListItemText,
    Divider, Chip, IconButton, Menu, MenuItem, Avatar, Tooltip, Stack, Alert,
} from '@mui/material';
import {
    GridView, NotificationsActive, FactCheck, Construction, AccountTree,
    Description, Storage, Logout, Circle, Warning, Healing, ManageAccounts,
    MenuOpen, Menu as MenuIcon, ShieldOutlined, Tune, People, Water,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { FleetProvider, useFleet } from '../context/FleetContext';
import { disconnectSocket } from '../socket';
import { api } from '../api';
import ErrorBoundary from './ErrorBoundary';
import { OngcBlockLogo } from './Brand/OngcBrand';

const DRAWER = 248;          // expanded width
const DRAWER_MINI = 72;      // collapsed (icon-only) width

// `role` (optional) gates a nav item: only shown when can(role) is true.
const NAV = [
    // Ordered by operator priority: situational awareness -> safety -> operations
    // -> asset health -> data integrity -> reporting -> administration.
    { to: '/', label: 'Fleet Overview', icon: <GridView /> },
    { to: '/alarms', label: 'Alarm Command Centre', icon: <NotificationsActive /> },
    { to: '/wells', label: 'Wells', icon: <Water /> },
    { to: '/workover', label: 'Workover Performance', icon: <Construction /> },
    { to: '/maintenance', label: 'Maintenance & Reliability', icon: <Healing /> },
    { to: '/data-quality', label: 'Data Quality', icon: <FactCheck /> },
    { to: '/reports', label: 'Reports', icon: <Description /> },
    { to: '/registry', label: 'Config Registry', icon: <Storage /> },
    { to: '/users', label: 'User Access', icon: <ManageAccounts />, role: 'admin' },
    { to: '/settings', label: 'Settings', icon: <Tune />, role: 'admin' },
];

// User-liveness: best-effort heartbeat (~30s) keeping this user's session fresh,
// plus a poll (~15s) of who else is online. Errors are swallowed — presence is
// non-critical and self-heals on the next tick.
function usePresence() {
    const [onlineCount, setOnlineCount] = useState(0);
    useEffect(() => {
        let alive = true;
        const ping = () => { api.pingPresence().catch(() => {}); };
        const refresh = () => {
            api.presence()
                .then((rows) => { if (alive) setOnlineCount((rows || []).filter((u) => u.online).length); })
                .catch(() => {});
        };
        ping(); refresh();
        const pingTimer = setInterval(ping, 30000);
        const pollTimer = setInterval(refresh, 15000);
        return () => { alive = false; clearInterval(pingTimer); clearInterval(pollTimer); };
    }, []);
    return onlineCount;
}

function TopBar({ width, collapsed, onToggle }) {
    const { summary, connected } = useFleet();
    const { user, logout } = useAuth();
    const nav = useNavigate();
    const [anchor, setAnchor] = useState(null);
    const onlineUsers = usePresence();

    const doLogout = () => { disconnectSocket(); logout(); nav('/login'); };
    const s = summary || {};

    return (
        <AppBar position="fixed" sx={{ width: `calc(100% - ${width}px)`, ml: `${width}px`, bgcolor: 'background.paper', borderBottom: '1px solid rgba(255,255,255,0.06)', transition: 'width .2s, margin .2s' }} elevation={0}>
            <Toolbar sx={{ gap: 2 }}>
                <Tooltip title={collapsed ? 'Expand menu' : 'Collapse menu'}>
                    <IconButton onClick={onToggle} edge="start" size="small" sx={{ color: 'text.secondary' }}>
                        {collapsed ? <MenuIcon /> : <MenuOpen />}
                    </IconButton>
                </Tooltip>
                <Typography variant="subtitle1" fontWeight={700} sx={{ flexShrink: 0 }}>Asset Monitoring Centre</Typography>
                <Stack direction="row" spacing={1} sx={{ flexGrow: 1 }} flexWrap="wrap" useFlexGap>
                    <Chip size="small" color="success" variant="outlined" label={`${s.online ?? 0} online`} />
                    <Chip size="small" color="warning" variant="outlined" label={`${s.degraded ?? 0} degraded`} />
                    <Chip size="small" color="error" variant="outlined" label={`${s.offline ?? 0} offline`} />
                    <Chip size="small" variant="outlined" label={`${s.rigsReporting ?? 0}/${s.total ?? 0} reporting`} />
                    <Chip size="small" variant="outlined" label={`avg health ${s.avgHealth ?? 0}`} />
                </Stack>
                <Tooltip title={`${onlineUsers} user${onlineUsers === 1 ? '' : 's'} online`}>
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                        <People fontSize="small" />
                        <Typography variant="body2" fontWeight={700}>{onlineUsers}</Typography>
                    </Stack>
                </Tooltip>
                <Tooltip title={connected ? 'Live link up' : 'Reconnecting…'}>
                    <Circle sx={{ fontSize: 12, color: connected ? 'success.main' : 'error.main' }} />
                </Tooltip>
                <IconButton onClick={(e) => setAnchor(e.currentTarget)} size="small">
                    <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                        {(user?.display || user?.username || '?').slice(0, 1).toUpperCase()}
                    </Avatar>
                </IconButton>
                <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
                    <MenuItem disabled>
                        <Box>
                            <Typography variant="body2" fontWeight={700}>{user?.display || user?.username}</Typography>
                            <Typography variant="caption" color="text.secondary">role: {user?.role}</Typography>
                        </Box>
                    </MenuItem>
                    <Divider />
                    <MenuItem onClick={doLogout}><Logout fontSize="small" sx={{ mr: 1 }} /> Sign out</MenuItem>
                </Menu>
            </Toolbar>
        </AppBar>
    );
}

// Read-only fleet alarm strip (proposal §6.1 alarm command centre; project rule:
// ESD/lockout are surfaced as alarms here — the CRMF never actuates anything).
function AlarmStrip() {
    const { summary } = useFleet();
    const nav = useNavigate();
    if (!summary || (summary.alarmsP1 ?? 0) === 0) return null;
    return (
        <Box onClick={() => nav('/alarms')} sx={{
            cursor: 'pointer', bgcolor: 'error.main', color: '#fff', px: 3, py: 0.75,
            display: 'flex', alignItems: 'center', gap: 1, fontWeight: 700,
            animation: 'crmfpulse 1.6s ease-in-out infinite',
            '@keyframes crmfpulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.78 } },
        }}>
            <Warning fontSize="small" />
            <Typography variant="body2" fontWeight={700}>
                {summary.alarmsP1} priority-1 (ESD / lockout / well-control) alarm{summary.alarmsP1 > 1 ? 's' : ''} active across the fleet — read-only
            </Typography>
        </Box>
    );
}

// Surfaces a non-401 fleet-load failure (audit #25) so an operator sees an explicit
// banner rather than a silently-empty/stale console. Self-heals via FleetContext polling.
function FleetErrorBanner() {
    const { error } = useFleet();
    if (!error) return null;
    return (
        <Box sx={{ px: 3, pt: 2 }}>
            <Alert severity="warning">Live fleet data unavailable — {error}. Retrying automatically.</Alert>
        </Box>
    );
}

function NavDrawer({ width, collapsed }) {
    const nav = useNavigate();
    const loc = useLocation();
    const { can } = useAuth();
    const isActive = (to) => to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to);
    const items = NAV.filter((n) => !n.role || can(n.role));
    return (
        <Drawer variant="permanent" sx={{ width, flexShrink: 0, whiteSpace: 'nowrap', boxSizing: 'border-box',
            '& .MuiDrawer-paper': { width, boxSizing: 'border-box', bgcolor: '#0d1526', borderRight: '1px solid rgba(255,255,255,0.06)', overflowX: 'hidden', transition: 'width .2s' } }}>
            <Toolbar sx={{ py: 1, px: collapsed ? 0 : 2, gap: 1.25, justifyContent: collapsed ? 'center' : 'flex-start' }}>
                <OngcBlockLogo size={collapsed ? 34 : 40} />
                {!collapsed && (
                    <Box>
                        <Typography variant="h6" fontWeight={900} letterSpacing={1} lineHeight={1.2}>CRMF</Typography>
                        <Typography variant="caption" color="text.secondary">ONGC · AHWR Fleet</Typography>
                    </Box>
                )}
            </Toolbar>
            {/* 70-years anniversary tagline (expanded sidebar only) */}
            {!collapsed && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, pb: 1.25 }}>
                    <Box
                        component="img"
                        src="/brand/ongc-70.png"
                        alt="70"
                        sx={{ height: 24, width: 'auto', filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.4))' }}
                    />
                    <Typography
                        noWrap
                        sx={{ color: 'text.secondary', fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: 'italic', fontSize: 12 }}
                    >
                        years in Energy Exploration
                    </Typography>
                </Box>
            )}
            <Divider />
            <List sx={{ px: 1 }}>
                {items.map((n) => {
                    const active = isActive(n.to);
                    const btn = (
                        <ListItemButton key={n.to} selected={active} onClick={() => nav(n.to)}
                            sx={{ borderRadius: 2, mb: 0.5, justifyContent: collapsed ? 'center' : 'flex-start',
                                px: collapsed ? 1 : 2, '&.Mui-selected': { bgcolor: 'rgba(62,166,255,0.15)' } }}>
                            <ListItemIcon sx={{ minWidth: 0, mr: collapsed ? 0 : 1.5, justifyContent: 'center', color: active ? 'primary.main' : 'text.secondary' }}>{n.icon}</ListItemIcon>
                            {!collapsed && <ListItemText primary={n.label} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 700 : 500 }} />}
                        </ListItemButton>
                    );
                    return collapsed ? <Tooltip key={n.to} title={n.label} placement="right">{btn}</Tooltip> : btn;
                })}
            </List>
            <Box sx={{ mt: 'auto', p: collapsed ? 1 : 2 }}>
                {collapsed ? (
                    <Tooltip title="Monitoring-only · read-only · no write path to any rig PLC" placement="right">
                        <Box sx={{ display: 'flex', justifyContent: 'center', color: 'info.main' }}><ShieldOutlined fontSize="small" /></Box>
                    </Tooltip>
                ) : (
                    <>
                        <Chip size="small" color="info" variant="outlined" label="Monitoring-only · read-only" sx={{ width: '100%' }} />
                        <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                            No write path to any rig PLC.
                        </Typography>
                    </>
                )}
            </Box>
        </Drawer>
    );
}

export default function Layout() {
    // Key the boundary on the route so navigating to a different view clears a
    // previously-caught error (a fresh panel gets a fresh boundary).
    const loc = useLocation();
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem('crmf_nav_collapsed') === '1');
    const toggle = useCallback(() => setCollapsed((c) => {
        const next = !c; localStorage.setItem('crmf_nav_collapsed', next ? '1' : '0'); return next;
    }), []);
    const width = collapsed ? DRAWER_MINI : DRAWER;

    const isRigRoute = loc.pathname.startsWith('/rigs/');

    if (isRigRoute) {
        return (
            <FleetProvider>
                <Box sx={{ height: '100vh', overflow: 'hidden', bgcolor: 'background.default' }}>
                    <ErrorBoundary key={loc.pathname} label="This rig page">
                        <Outlet />
                    </ErrorBoundary>
                </Box>
            </FleetProvider>
        );
    }

    return (
        <FleetProvider>
            {/* App shell: fixed sidebar + header, the content region fills the remaining
                viewport height and scrolls internally so pages can fill the real estate. */}
            <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
                <NavDrawer width={width} collapsed={collapsed} />
                <Box sx={{ flexGrow: 1, width: `calc(100% - ${width}px)`, transition: 'width .2s', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    <TopBar width={width} collapsed={collapsed} onToggle={toggle} />
                    <Toolbar />
                    <AlarmStrip />
                    <FleetErrorBanner />
                    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: { xs: 1.5, sm: 2, md: 3 } }}>
                        <ErrorBoundary key={loc.pathname} label="This panel">
                            <Outlet />
                        </ErrorBoundary>
                    </Box>
                </Box>
            </Box>
        </FleetProvider>
    );
}

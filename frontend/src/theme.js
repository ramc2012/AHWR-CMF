import { createTheme } from '@mui/material/styles';

// Ops-centre dark theme for the monitoring video wall + workstations (proposal §5.4).
const theme = createTheme({
    palette: {
        mode: 'dark',
        primary: { main: '#3ea6ff' },
        secondary: { main: '#7c4dff' },
        background: { default: '#0b1220', paper: '#121b2e' },
        success: { main: '#22c55e' },
        warning: { main: '#f59e0b' },
        error: { main: '#ef4444' },
        info: { main: '#38bdf8' },
        divider: 'rgba(255,255,255,0.08)',
    },
    shape: { borderRadius: 10 },
    typography: {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        h6: { fontWeight: 700, letterSpacing: 0.2 },
        subtitle2: { fontWeight: 600 },
    },
    components: {
        MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.06)' } } },
        MuiCard: { styleOverrides: { root: { backgroundImage: 'none' } } },
        MuiTableCell: { styleOverrides: { root: { borderColor: 'rgba(255,255,255,0.06)' } } },
        MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    },
});

// Shared status colour map used across the portal.
export const STATUS_COLOR = {
    online: '#22c55e',
    degraded: '#f59e0b',
    stale: '#f97316',
    offline: '#ef4444',
    pending: '#64748b',
};

export default theme;

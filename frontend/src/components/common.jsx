import React from 'react';
import { Chip, Paper, Box, Typography } from '@mui/material';
import { STATUS_COLOR } from '../theme';

export const fmtNum = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));

export function fmtAgo(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

export function StatusChip({ status, size = 'small' }) {
    const color = STATUS_COLOR[status] || '#64748b';
    const label = (status || 'unknown').toUpperCase();
    return (
        <Chip size={size} label={label}
            sx={{ bgcolor: color + '22', color, border: `1px solid ${color}55`, fontWeight: 700, letterSpacing: 0.4 }} />
    );
}

export function PriorityChip({ priority }) {
    if (!priority) return <Chip size="small" label="—" variant="outlined" />;
    const map = { P1: '#ef4444', P2: '#f59e0b', P3: '#38bdf8' };
    const c = map[priority] || '#64748b';
    return <Chip size="small" label={priority} sx={{ bgcolor: c + '22', color: c, border: `1px solid ${c}55`, fontWeight: 700 }} />;
}

export function KpiCard({ label, value, sub, color, icon }) {
    return (
        <Paper sx={{ p: 2, flex: 1, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
                {icon}
            </Box>
            <Typography variant="h4" sx={{ fontWeight: 800, color: color || 'text.primary', lineHeight: 1.1 }}>{value}</Typography>
            {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
        </Paper>
    );
}

export function HealthBar({ value }) {
    const v = Math.max(0, Math.min(100, value || 0));
    const c = v >= 80 ? STATUS_COLOR.online : v >= 50 ? STATUS_COLOR.degraded : STATUS_COLOR.offline;
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 120 }}>
            <Box sx={{ flex: 1, height: 8, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <Box sx={{ width: `${v}%`, height: '100%', bgcolor: c }} />
            </Box>
            <Typography variant="caption" sx={{ width: 32, textAlign: 'right', color: c, fontWeight: 700 }}>{v}</Typography>
        </Box>
    );
}

export function SectionTitle({ children, action }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, mt: 1 }}>
            <Typography variant="h6">{children}</Typography>
            {action}
        </Box>
    );
}

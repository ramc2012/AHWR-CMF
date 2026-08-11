import React from 'react';
import {
    Box, Paper, Grid, Stack, Typography, Chip, Button, Alert, Divider, Skeleton,
    Table, TableBody, TableCell, TableRow,
} from '@mui/material';
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined';
import { useRigData } from '../../../context/RigDataContext';
import { PanelHead, num, freshness } from '../hmi';

// =====================================================================
// RigReportPanel — per-rig DAILY REPORT (proposal §6.1 rig drill-down).
// READ-ONLY snapshot that mirrors the rig-edge Reports header + summary.
// The only "action" is window.print() (a client-side print/save of the
// rendered snapshot — NOT a server write, no control commands anywhere).
// =====================================================================

// Top freshness strip so the operator can see live/stale/offline at a glance.
function FreshnessStrip({ meta }) {
    const f = freshness(meta);
    return (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: f.color, boxShadow: `0 0 6px ${f.color}` }} />
            <Typography variant="caption" sx={{ color: f.color, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                {f.text}
            </Typography>
            {meta?.source && (
                <Typography variant="caption" color="text.secondary">· src {meta.source}</Typography>
            )}
        </Stack>
    );
}

// A labelled field for the report header card.
function HeaderField({ label, children }) {
    return (
        <Grid item xs={6} sm={4} md={2}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }} display="block" noWrap>
                {label}
            </Typography>
            <Box sx={{ mt: 0.3 }}>{children}</Box>
        </Grid>
    );
}

// A grouped block of readings rendered as a compact key/value table.
function SnapshotGroup({ title, rows }) {
    return (
        <Grid item xs={12} sm={6} md={4}>
            <Paper variant="outlined" sx={{ p: 1.5, height: '100%' }}>
                <Typography variant="caption" sx={{ color: 'primary.light', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    {title}
                </Typography>
                <Divider sx={{ my: 0.75 }} />
                <Table size="small" sx={{ '& td': { border: 0, py: 0.35, px: 0 } }}>
                    <TableBody>
                        {rows.map((r) => (
                            <TableRow key={r.label}>
                                <TableCell sx={{ color: 'text.secondary' }}>
                                    <Typography variant="body2" color="text.secondary">{r.label}</Typography>
                                </TableCell>
                                <TableCell align="right">
                                    <Typography variant="body2" fontWeight={700} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {r.value}
                                        {r.unit != null && r.value !== '—' && (
                                            <Typography component="span" variant="caption" color="text.secondary"> {r.unit}</Typography>
                                        )}
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </Paper>
        </Grid>
    );
}

export default function RigReportPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    if (error) {
        return <Alert severity="error" variant="outlined" sx={{ my: 1 }}>{String(error)}</Alert>;
    }

    if (loading && !data) {
        return (
            <Box sx={{ py: 1 }}>
                <Typography variant="caption" color="text.secondary">Loading report…</Typography>
                <Skeleton variant="rounded" height={110} sx={{ mt: 1 }} />
                <Skeleton variant="rounded" height={220} sx={{ mt: 2 }} />
            </Box>
        );
    }

    const meta = data?._meta || {};
    const activity = data?._activity || {};
    const dw = data?.drawworks || {};
    const dr = data?.drilling || {};
    const htd = data?.htd || {};
    const pct = data?.pct || {};
    const hpu = data?.hpu || {};
    const wh = data?.wellhead || {};
    const wc = data?.well_control || {};
    const eng = data?.cat_engine || {};
    const mp = data?.mudpump || {};
    const fl = data?.fluid || {};

    const rigName = meta.name || rig?.name || rigId || '—';
    const field = meta.field || rig?.field || '—';
    const activityLabel = activity.label || activity.job || '—';
    const generated = new Date().toLocaleString();

    // Grouped current-operating snapshot (read-only, mirrors edge Reports summary).
    const groups = [
        {
            title: 'Hoisting',
            rows: [
                { label: 'Hook load', value: num(dw.hook_load, 1), unit: 't' },
                { label: 'Block position', value: num(dw.block_position, 1), unit: 'ft' },
                { label: 'Hole depth', value: num(dr.hole_depth, 1), unit: 'm' },
                { label: 'Bit depth', value: num(dr.bit_depth, 1), unit: 'm' },
            ],
        },
        {
            title: 'Rotary',
            rows: [
                { label: 'HTD RPM', value: num(htd.rpm, 0), unit: 'rpm' },
                { label: 'HTD torque', value: num(htd.torque, 0), unit: 'Nm' },
                { label: 'Last make-up torque', value: num(pct.last_makeup_torque, 0), unit: 'Nm' },
            ],
        },
        {
            title: 'Hydraulics',
            rows: [
                { label: 'HPU discharge', value: num(hpu.discharge_pressure, 0), unit: 'bar' },
                { label: 'HPU oil temp', value: num(hpu.oil_temp, 0), unit: '°C' },
            ],
        },
        {
            title: 'Well',
            rows: [
                { label: 'Tubing pressure', value: num(wh.tubing_pressure, 1), unit: 'bar' },
                { label: 'Casing pressure', value: num(wh.casing_pressure, 1), unit: 'bar' },
                { label: 'Accumulator', value: num(wc.accumulator_pressure, 0), unit: 'psi' },
            ],
        },
        {
            title: 'Engine',
            rows: [
                { label: 'Load', value: num(eng.load, 0), unit: '%' },
                { label: 'Run hours', value: num(eng.run_hours, 1), unit: 'h' },
            ],
        },
        {
            title: 'Fluids',
            rows: [
                { label: 'Mud pump pressure', value: num(mp.pressure, 1), unit: 'bar' },
                { label: 'Total tank volume', value: num(fl.total_tank_volume, 1), unit: 'm³' },
                { label: 'Tank gain/loss', value: num(fl.tank_gain_loss, 2), unit: 'm³' },
            ],
        },
    ];

    return (
        <Box>
            <FreshnessStrip meta={meta} />

            <PanelHead
                title="Daily report"
                right={
                    <Button
                        size="small"
                        variant="outlined"
                        startIcon={<PrintOutlinedIcon fontSize="small" />}
                        onClick={() => window.print()}
                    >
                        Print / Save
                    </Button>
                }
            />

            {/* Report header card */}
            <Paper sx={{ p: 2, mb: 2 }}>
                <Grid container spacing={2} alignItems="flex-start">
                    <HeaderField label="Rig">
                        <Typography variant="subtitle2" fontWeight={800}>{rigName}</Typography>
                        {rigId && <Typography variant="caption" color="text.secondary">{rigId}</Typography>}
                    </HeaderField>
                    <HeaderField label="Field">
                        <Typography variant="subtitle2" fontWeight={700}>{field}</Typography>
                    </HeaderField>
                    <HeaderField label="Activity">
                        <Typography variant="subtitle2" fontWeight={700} noWrap>{activityLabel}</Typography>
                        {activity.job && activity.label && activity.job !== activity.label && (
                            <Typography variant="caption" color="text.secondary" noWrap display="block">{activity.job}</Typography>
                        )}
                    </HeaderField>
                    <HeaderField label="Status">
                        {meta.status != null
                            ? <Chip size="small" label={String(meta.status)} variant="outlined" sx={{ textTransform: 'capitalize', fontWeight: 700 }} />
                            : <Typography variant="subtitle2">—</Typography>}
                    </HeaderField>
                    <HeaderField label="Data quality">
                        <Typography
                            variant="subtitle2"
                            fontWeight={800}
                            sx={{ color: meta.health_score == null ? 'text.primary' : meta.health_score >= 80 ? 'success.main' : meta.health_score >= 50 ? 'warning.main' : 'error.main' }}
                        >
                            {meta.health_score != null ? `${num(meta.health_score, 0)}%` : '—'}
                        </Typography>
                    </HeaderField>
                    <HeaderField label="Generated">
                        <Typography variant="subtitle2" fontWeight={700}>{generated}</Typography>
                    </HeaderField>
                </Grid>
            </Paper>

            {/* Current operating snapshot */}
            <Box>
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Current operating snapshot</Typography>
                <Grid container spacing={2}>
                    {groups.map((g) => <SnapshotGroup key={g.title} title={g.title} rows={g.rows} />)}
                </Grid>
            </Box>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
                Read-only snapshot · monitoring only — mirrors the rig-edge Reports view (proposal §6.1). No control actions.
            </Typography>
        </Box>
    );
}

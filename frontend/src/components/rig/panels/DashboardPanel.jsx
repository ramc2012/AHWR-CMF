import React from 'react';
import { Box, Grid, Paper, Typography, Stack, Chip, Skeleton, Alert, Divider } from '@mui/material';
import { useRigData } from '../../../context/RigDataContext';
import {
    ValueTile, StatusChip, MiniGauge, PanelHead, freshness,
} from '../hmi';

// =====================================================================
// DashboardPanel — main operator dashboard for the CRMF per-rig remote
// HMI mirror (proposal §6.1: rig drill-down mirrors the edge RigOverview
// headline view). READ-ONLY: monitoring/visualisation only, no controls.
// =====================================================================

// Small live/stale/offline chip derived from the edge _meta block.
function FreshnessChip({ meta }) {
    const f = freshness(meta);
    return (
        <Chip
            size="small"
            label={f.text}
            sx={{ bgcolor: f.color + '22', color: f.color, border: `1px solid ${f.color}55`, fontWeight: 700, letterSpacing: 0.3 }}
        />
    );
}

// One status cell in the compact equipment band.
function BandChip({ label, value, map }) {
    return (
        <Stack spacing={0.4} alignItems="flex-start">
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
            <StatusChip value={value} map={map} />
        </Stack>
    );
}

export default function DashboardPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    // ---- loading skeleton (data may be null on first render) ----
    if (loading && !data) {
        return (
            <Box>
                <Skeleton variant="rounded" height={56} sx={{ mb: 2 }} />
                <Grid container spacing={2}>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Grid item xs={6} sm={4} md={2} key={`g${i}`}><Skeleton variant="rounded" height={110} /></Grid>
                    ))}
                </Grid>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Loading live telemetry…</Typography>
            </Box>
        );
    }

    const dw = data?.drawworks || {};
    const dr = data?.drilling || {};
    const mp = data?.mudpump || {};
    const fl = data?.fluid || {};
    const wh = data?.wellhead || {};
    const wc = data?.well_control || {};
    const hpu = data?.hpu || {};
    const htd = data?.htd || {};
    const pct = data?.pct || {};
    const eng = data?.cat_engine || {};
    const acs = data?.acs || {};
    const cwk = data?.cwk || {};
    const sfy = data?.safety || {};
    const act = data?._activity || {};
    const meta = data?._meta || null;

    const rigName = meta?.name || rig?.name || rigId || 'Rig';

    return (
        <Box>
            {error && (
                <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>{error}</Alert>
            )}

            {/* ---- Top strip: rig / activity / op-mode / freshness ---- */}
            <Paper sx={{ p: 1.5, mb: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'flex-start', md: 'center' }} justifyContent="space-between" spacing={1}>
                    <Box>
                        <Typography variant="h6" fontWeight={800} sx={{ lineHeight: 1.2 }}>{rigName}</Typography>
                        <Typography variant="body2" color="text.secondary">
                            {act.label || '—'}{act.job ? ` · ${act.job}` : ''}
                        </Typography>
                    </Box>
                    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                        <Stack spacing={0.3} alignItems="flex-end">
                            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Op mode</Typography>
                            <StatusChip value={dr.operation_mode} map="opMode" />
                        </Stack>
                        <FreshnessChip meta={meta} />
                    </Stack>
                </Stack>
            </Paper>

            {/* ---- Headline gauges ---- */}
            <PanelHead title="Drilling parameters" />
            <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Hookload" value={dw.hook_load} unit="t" min={0} max={200} d={0} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="WOB" value={dr.wob} unit="t" min={0} max={40} d={1} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="String RPM" value={dr.rpm} min={0} max={200} d={0} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Torque" value={dr.torque} unit="Nm" min={0} max={15000} d={0} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Standpipe" value={mp.pressure} unit="bar" min={0} max={350} d={0} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="ROP" value={dr.rop} unit="m/h" min={0} max={40} d={1} /></Grid>
            </Grid>

            {/* ---- Key value tiles ---- */}
            <PanelHead title="Hole &amp; circulation" />
            <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Block position" value={dw.block_position} unit="ft" d={1} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Hole depth" value={dr.hole_depth} unit="m" d={1} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Bit depth" value={dr.bit_depth} unit="m" d={1} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Flow in" value={mp.flow_in} unit="lpm" d={0} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="SPM" value={mp.spm} unit="" d={0} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Tank gain/loss" value={fl.tank_gain_loss} unit="m³" d={2} warn={(n) => n > 2} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Tubing pressure" value={wh.tubing_pressure} unit="bar" d={0} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Accumulator" value={wc.accumulator_pressure} unit="psi" d={0} /></Grid>
            </Grid>

            {/* ---- Compact equipment / safety status band ---- */}
            <Paper sx={{ p: 1.5 }}>
                <PanelHead title="Equipment &amp; safety" />
                <Grid container spacing={2} rowSpacing={1.5}>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="HPU" value={hpu.status} map="onoff" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="HTD" value={htd.status} map="onoff" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="PCT seq" value={pct.sequence} map="pctSeq" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="Engine" value={eng.status} map="engine" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="ACS" value={acs.status} map="acs" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="CWK" value={cwk.status} map="cwkParked" /></Grid>
                </Grid>
                <Divider sx={{ my: 1.5 }} />
                <Stack direction="row" spacing={2} flexWrap="wrap" rowGap={1}>
                    <BandChip label="ESD" value={sfy.esd_active ? 1 : 0} map="bool" />
                    <BandChip label="Lockout" value={sfy.lockout_active ? 1 : 0} map="bool" />
                </Stack>
            </Paper>
        </Box>
    );
}

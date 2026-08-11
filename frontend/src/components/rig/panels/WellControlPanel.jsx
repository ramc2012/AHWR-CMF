import React from 'react';
import { Box, Paper, Grid, Stack, Typography, Chip, Alert, Skeleton, Divider } from '@mui/material';
import { useRigData } from '../../../context/RigDataContext';
import { ValueTile, StatusRow, PanelHead, num, freshness } from '../hmi';

// =====================================================================
// CRMF per-rig remote HMI mirror — WELL CONTROL (proposal §6.1)
// Mirrors the rig-edge BOPStack + wellhead operator view. READ-ONLY:
// no kill-sheet inputs, no control actions — a static pressure readout only.
// =====================================================================

// BOP element colouring: closed (sealed) = green, open = blue, otherwise grey.
const COL = { closed: '#22c55e', open: '#3ea6ff', idle: '#3a4252' };
const TXT = { closed: '#dffbe8', open: '#dbeeff', idle: '#9aa4b2' };

function bopState(open, close) {
    if (Number(close) === 1) return 'closed';
    if (Number(open) === 1) return 'open';
    return 'idle';
}
const stateLabel = { closed: 'CLOSED', open: 'OPEN', idle: '—' };

// One stacked BOP element rendered as an SVG <g> at a vertical offset.
function BopElement({ y, label, state }) {
    const fill = COL[state], stroke = TXT[state];
    return (
        <g transform={`translate(0 ${y})`}>
            <rect x="26" y="0" width="148" height="40" rx="6"
                fill={fill + '26'} stroke={fill} strokeWidth="2" />
            {/* central bore */}
            <rect x="92" y="-6" width="16" height="52" fill="#0b0f17" stroke="#1f2733" strokeWidth="1.5" />
            <text x="100" y="18" textAnchor="middle" fontSize="11.5" fontWeight="700" fill={stroke}>{label}</text>
            <text x="100" y="32" textAnchor="middle" fontSize="10" fontWeight="700"
                fill={state === 'idle' ? '#64748b' : fill}>{stateLabel[state]}</text>
        </g>
    );
}

function BopStack({ wc }) {
    const elements = [
        { key: 'annular', label: 'ANNULAR', state: bopState(wc.annular_open, wc.annular_close) },
        { key: 'pipe', label: 'PIPE RAM', state: bopState(wc.pipe_ram_open, wc.pipe_ram_close) },
        { key: 'blind', label: 'BLIND RAM', state: bopState(wc.blind_ram_open, wc.blind_ram_close) },
        // shear ram only reports an open signal in the edge contract → treat as activated/idle
        { key: 'shear', label: 'SHEAR RAM', state: Number(wc.shear_ram_open) === 1 ? 'open' : 'idle' },
    ];
    const gap = 52, top = 16, H = top + elements.length * gap + 24;
    return (
        <svg viewBox={`0 0 200 ${H}`} style={{ width: '100%', maxWidth: 230 }}>
            {/* riser stub above + wellhead flange below */}
            <rect x="92" y="0" width="16" height="16" fill="#0b0f17" stroke="#1f2733" strokeWidth="1.5" />
            {elements.map((e, i) => (
                <BopElement key={e.key} y={top + i * gap} label={e.label} state={e.state} />
            ))}
            <rect x="60" y={top + elements.length * gap} width="80" height="14" rx="2"
                fill="#161c26" stroke="#2a3340" strokeWidth="1.5" />
            <text x="100" y={top + elements.length * gap + 11} textAnchor="middle" fontSize="9"
                fontWeight="700" fill="#64748b">WELLHEAD</text>
        </svg>
    );
}

// Static kill-sheet style readout row.
function KillRow({ label, value, unit }) {
    return (
        <Stack direction="row" justifyContent="space-between" sx={{ py: 0.35 }}>
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <Typography variant="body2" fontWeight={700} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {value} <Typography component="span" variant="caption" color="text.secondary">{unit}</Typography>
            </Typography>
        </Stack>
    );
}

export default function WellControlPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    const fr = freshness(data?._meta);

    // Freshness strip — always shown so the operator sees live/stale/offline.
    const FreshStrip = (
        <Chip size="small" label={fr.text}
            sx={{ bgcolor: fr.color + '22', color: fr.color, border: `1px solid ${fr.color}55`, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }} />
    );

    if (loading && !data) {
        return (
            <Box>
                <PanelHead title="Well Control" right={FreshStrip} />
                <Skeleton variant="rounded" height={260} sx={{ mb: 2 }} />
                <Skeleton variant="rounded" height={120} />
            </Box>
        );
    }

    const wc = data?.well_control || {};
    const wh = data?.wellhead || {};
    const available = !!(wc.available === 1 || wc.available === true);

    return (
        <Box>
            <PanelHead title="Well Control" right={FreshStrip} />

            {error && <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>{error}</Alert>}

            {!available && (
                <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
                    Well-control data unavailable for this rig
                </Alert>
            )}

            <Grid container spacing={2}>
                {/* ---- BOP stack diagram ---- */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>BOP Stack</Typography>
                        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                            <BopStack wc={wc} />
                        </Box>
                        <Stack direction="row" spacing={1.5} justifyContent="center" sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                            <LegendDot color={COL.closed} label="Closed" />
                            <LegendDot color={COL.open} label="Open" />
                            <LegendDot color={COL.idle} label="Idle" />
                        </Stack>
                    </Paper>
                </Grid>

                {/* ---- Accumulator / control pressures ---- */}
                <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>Control Pressures</Typography>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Accumulator" value={wc.accumulator_pressure} unit="psi" d={0}
                                    warn={(n) => n < 2500} />
                            </Grid>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Annular" value={wc.annular_pressure} unit="psi" d={0} />
                            </Grid>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Manifold" value={wc.manifold_pressure} unit="psi" d={0} />
                            </Grid>
                        </Grid>

                        <Divider sx={{ my: 2 }} />

                        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1.5 }}>Wellhead Pressures</Typography>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Tubing" value={wh.tubing_pressure} unit="bar" d={1} />
                            </Grid>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Casing" value={wh.casing_pressure} unit="bar" d={1} />
                            </Grid>
                            <Grid item xs={6} sm={4}>
                                <ValueTile label="Wellhead" value={wh.wellhead_pressure} unit="bar" d={1} />
                            </Grid>
                        </Grid>
                    </Paper>
                </Grid>

                {/* ---- Ram status table ---- */}
                <Grid item xs={12} md={7}>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Ram &amp; Annular Status</Typography>
                        <Grid container columnSpacing={3}>
                            <Grid item xs={12} sm={6}>
                                <StatusRow label="Annular — Open" value={wc.annular_open} map="ramOpen" />
                                <StatusRow label="Annular — Close" value={wc.annular_close} map="ramClose" />
                                <StatusRow label="Pipe Ram — Open" value={wc.pipe_ram_open} map="ramOpen" />
                                <StatusRow label="Pipe Ram — Close" value={wc.pipe_ram_close} map="ramClose" />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <StatusRow label="Blind Ram — Open" value={wc.blind_ram_open} map="ramOpen" />
                                <StatusRow label="Blind Ram — Close" value={wc.blind_ram_close} map="ramClose" />
                                <StatusRow label="Shear Ram — Open" value={wc.shear_ram_open} map="ramOpen" />
                            </Grid>
                        </Grid>
                    </Paper>
                </Grid>

                {/* ---- Static kill-sheet readout (READ-ONLY, no inputs) ---- */}
                <Grid item xs={12} md={5}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                            <Typography variant="subtitle2" fontWeight={700}>Kill Sheet (read-only)</Typography>
                            <Chip size="small" variant="outlined" label="MONITOR" sx={{ color: 'text.secondary', letterSpacing: 0.4 }} />
                        </Stack>
                        <KillRow label="Accumulator" value={num(wc.accumulator_pressure, 0)} unit="psi" />
                        <KillRow label="Annular" value={num(wc.annular_pressure, 0)} unit="psi" />
                        <KillRow label="Manifold" value={num(wc.manifold_pressure, 0)} unit="psi" />
                        <Divider sx={{ my: 0.75 }} />
                        <KillRow label="Tubing" value={num(wh.tubing_pressure, 1)} unit="bar" />
                        <KillRow label="Casing" value={num(wh.casing_pressure, 1)} unit="bar" />
                        <KillRow label="Wellhead" value={num(wh.wellhead_pressure, 1)} unit="bar" />
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

function LegendDot({ color, label }) {
    return (
        <Stack direction="row" spacing={0.6} alignItems="center">
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: color + '40', border: `1.5px solid ${color}` }} />
            <Typography variant="caption" color="text.secondary">{label}</Typography>
        </Stack>
    );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    ListItemText,
    ListSubheader,
    MenuItem,
    Paper,
    Select,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip as MuiTooltip,
    Typography,
    useTheme
} from '@mui/material';
import {
    ChevronsDown,
    ChevronsUp,
    Clock,
    Gauge,
    Minus,
    Plus,
    Radio,
    Ruler,
    Settings,
    SlidersHorizontal,
    Trash2,
    Download
} from 'lucide-react';
// CENTRAL PORT of the edge EDR (proposal Â§6.1 rig drill-down): identical hand-rolled
// SVG strip-chart recorder, with the data layer swapped to the central per-rig sources
// â€” api.rigHistoryMulti (history seed) + useRigData (live point ingestion). READ-ONLY.
import { api } from '../../api';
import { useRigData } from '../../context/RigDataContext';
import edrCatalog from '../../edrMetrics.json';

/*
 * EdrView â€” reusable, self-contained strip-chart Electronic Drilling Recorder.
 *
 * Rendering is a hand-rolled SVG strip renderer (no recharts) so we control the
 * strip look exactly: shared vertical index axis (time OR depth), multiple pens
 * per strip each on its OWN horizontal [min,max] scale + color, light gridlines,
 * a thin current-value marker, and a FIXED-HEIGHT bottom "variables" block whose
 * content adaptively compacts so every strip's block is the same height and the
 * blocks line up on a shared baseline regardless of pen count.
 *
 * Data plumbing reuses the shared authenticated axios (/api/history seed +
 * /api/rig/latest) and the shared socket (`rig_data`) â€” no new instances.
 */

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

const METRIC_OPTIONS = edrCatalog.categories.flatMap(category => (
    category.fields.map(field => ({
        id: `${category.id}.${field.id}`,
        label: field.label,
        unit: field.unit || '',
        precision: field.precision ?? 1,
        defaultMin: field.defaultMin ?? 0,
        defaultMax: field.defaultMax ?? 1,
        categoryId: category.id,
        categoryLabel: category.label
    }))
));
const METRIC_LOOKUP = new Map(METRIC_OPTIONS.map(o => [o.id, o]));
const ALL_METRIC_IDS = METRIC_OPTIONS.map(o => o.id);

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PEN_COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];
const MAX_PENS = 3;
const MAX_READOUTS = 6;
const DEPTH_INDEX_METRIC = 'drilling.hole_depth';
const DEPTH_BIN_M = 0.5;

// Always-on left-band depth readouts (full mode only).
const HOLE_DEPTH_METRIC = 'drilling.hole_depth';
const BIT_DEPTH_METRIC = 'drilling.bit_depth';

const channelLabel = (id) => METRIC_LOOKUP.get(id)?.label || id.replace(/[._]/g, ' ');
const channelUnit = (id) => METRIC_LOOKUP.get(id)?.unit || '';
const channelPrecision = (id) => METRIC_LOOKUP.get(id)?.precision ?? 1;
const channelCategory = (id) => METRIC_LOOKUP.get(id)?.categoryLabel || '';

const fmtValue = (value, precision) => {
    if (!Number.isFinite(Number(value))) return '--';
    return Number(value).toFixed(precision);
};

// Trim trailing zeros for compact scale text (0â€¦500 not 0.0â€¦500.0).
const fmtScale = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    return String(Math.round(n * 100) / 100);
};

// ---------------------------------------------------------------------------
// Time window presets
// ---------------------------------------------------------------------------

const TIME_WINDOWS = [
    { label: '1m', ms: 1 * 60 * 1000, range: '-1m' },
    { label: '5m', ms: 5 * 60 * 1000, range: '-5m' },
    { label: '15m', ms: 15 * 60 * 1000, range: '-15m' },
    { label: '30m', ms: 30 * 60 * 1000, range: '-30m' },
    { label: '1H', ms: 60 * 60 * 1000, range: '-1h' },
    { label: '2H', ms: 2 * 60 * 60 * 1000, range: '-2h' },
    { label: '4H', ms: 4 * 60 * 60 * 1000, range: '-4h' },
    { label: '6H', ms: 6 * 60 * 60 * 1000, range: '-6h' },
    { label: '12H', ms: 12 * 60 * 60 * 1000, range: '-12h' },
    { label: '24H', ms: 24 * 60 * 60 * 1000, range: '-24h' }
];
const DAY_MS = 24 * 60 * 60 * 1000;
const DEPTH_SPANS = [
    { label: '25m', m: 25 },
    { label: '50m', m: 50 },
    { label: '100m', m: 100 },
    { label: '250m', m: 250 },
    { label: '500m', m: 500 }
];
const HISTORY_CACHE = new Map();
const HISTORY_CACHE_LIMIT = 40;

function cacheKeyFor(rigId, channels, modeKey) {
    return `${rigId || ''}|${modeKey}|${(channels || []).slice().sort().join(',')}`;
}

function setHistoryCache(key, samples) {
    if (!key || !Array.isArray(samples)) return;
    HISTORY_CACHE.set(key, samples);
    while (HISTORY_CACHE.size > HISTORY_CACHE_LIMIT) {
        HISTORY_CACHE.delete(HISTORY_CACHE.keys().next().value);
    }
}

const pad2 = (value) => String(value).padStart(2, '0');

const toDateTimeLocalValue = (ms) => {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const parseDateTimeLocalValue = (value) => {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
};

const formatAxisTime = (ms, showDate = false) => {
    const opts = showDate
        ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    return new Date(ms).toLocaleString([], opts);
};

const formatAxisDate = (ms) => new Date(ms).toLocaleDateString([], {
    month: '2-digit', day: '2-digit'
});

const formatAxisClock = (ms, includeSeconds = false) => new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    hour12: false
});

const shouldShowDateOnAxis = (fromMs, toMs) => {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return false;
    return (toMs - fromMs) >= DAY_MS || new Date(fromMs).toDateString() !== new Date(toMs).toDateString();
};

// ---------------------------------------------------------------------------
// Config normalization / persistence
// ---------------------------------------------------------------------------

const normalizePen = (pen, fallbackColorIndex) => {
    const src = pen && typeof pen === 'object' ? pen : {};
    const channelId = METRIC_LOOKUP.has(src.channelId) ? src.channelId : ALL_METRIC_IDS[0];
    const meta = METRIC_LOOKUP.get(channelId);
    let min = Number.isFinite(Number(src.min)) ? Number(src.min) : (meta?.defaultMin ?? 0);
    let max = Number.isFinite(Number(src.max)) ? Number(src.max) : (meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;
    return {
        channelId,
        min,
        max,
        color: COLOR_RE.test(src.color || '') ? src.color : PEN_COLORS[fallbackColorIndex % PEN_COLORS.length],
        enabled: src.enabled !== false
    };
};

const normalizeStrips = (strips) => {
    if (!Array.isArray(strips)) return [];
    return strips.map((strip, si) => ({
        title: typeof strip?.title === 'string' && strip.title ? strip.title : `Track ${si + 1}`,
        pens: (Array.isArray(strip?.pens) ? strip.pens : [])
            .slice(0, MAX_PENS)
            .map((pen, pi) => normalizePen(pen, si + pi))
    }));
};

// Keep only known channels, dedupe, cap to MAX_READOUTS.
const normalizeReadouts = (ids) => {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const out = [];
    ids.forEach(id => {
        if (METRIC_LOOKUP.has(id) && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    });
    return out.slice(0, MAX_READOUTS);
};

const loadPersisted = (storageKey, defaultStrips, defaultReadouts) => {
    const fallback = {
        strips: normalizeStrips(defaultStrips),
        indexMode: 'time',
        readouts: normalizeReadouts(defaultReadouts),
        timeWinIdx: null,
        depthSpanIdx: null,
        customWindow: null
    };
    if (!storageKey) return fallback;
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const strips = normalizeStrips(parsed?.strips);
        // Only adopt a persisted readout list if the key has one saved; otherwise
        // fall back to the prop default (covers first run after this feature ships).
        const readouts = Array.isArray(parsed?.readouts)
            ? normalizeReadouts(parsed.readouts)
            : fallback.readouts;
        const timeWinIdx = Number.isInteger(parsed?.timeWinIdx) && parsed.timeWinIdx >= 0 && parsed.timeWinIdx < TIME_WINDOWS.length
            ? parsed.timeWinIdx
            : null;
        const depthSpanIdx = Number.isInteger(parsed?.depthSpanIdx) && parsed.depthSpanIdx >= 0 && parsed.depthSpanIdx < DEPTH_SPANS.length
            ? parsed.depthSpanIdx
            : null;
        const customFrom = Number(parsed?.customWindow?.fromMs);
        const customTo = Number(parsed?.customWindow?.toMs);
        const customWindow = Number.isFinite(customFrom) && Number.isFinite(customTo) && customTo > customFrom
            ? { fromMs: customFrom, toMs: customTo, label: parsed?.customWindow?.label || 'Custom range' }
            : null;
        return {
            strips: strips.length ? strips : fallback.strips,
            indexMode: parsed?.indexMode === 'depth' ? 'depth' : 'time',
            readouts,
            timeWinIdx,
            depthSpanIdx,
            customWindow
        };
    } catch (e) {
        return fallback;
    }
};

// ---------------------------------------------------------------------------
// Channel select (grouped by category)
// ---------------------------------------------------------------------------

function ChannelSelect({ value, onChange, channels, sx }) {
    const allowed = channels && channels.length
        ? new Set(channels)
        : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);
    return (
        <Select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            size="small"
            MenuProps={{ PaperProps: { sx: { maxHeight: 360 } } }}
            sx={sx}
        >
            {groups.flatMap(({ cat, fields }) => [
                <ListSubheader key={`h-${cat.id}`} sx={{ fontWeight: 800, lineHeight: '30px', fontSize: '0.72rem', letterSpacing: 0.4 }}>
                    {cat.label.toUpperCase()}
                </ListSubheader>,
                ...fields.map(f => (
                    <MenuItem key={`${cat.id}.${f.id}`} value={`${cat.id}.${f.id}`} sx={{ fontSize: '0.82rem' }}>
                        {f.label}{f.unit ? ` (${f.unit})` : ''}
                    </MenuItem>
                ))
            ])}
        </Select>
    );
}

// ---------------------------------------------------------------------------
// Readouts config (multi-select from the catalog, grouped by category)
// ---------------------------------------------------------------------------

function ReadoutsConfig({ value, onChange, channels, surface, border, text, subText, accent }) {
    const allowed = channels && channels.length ? new Set(channels) : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);

    const handleChange = (e) => {
        const next = typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value;
        onChange(normalizeReadouts(next));
    };

    return (
        <FormControl size="small">
            <Select
                multiple
                displayEmpty
                value={value}
                onChange={handleChange}
                MenuProps={{ PaperProps: { sx: { maxHeight: 380, bgcolor: surface, color: text } } }}
                IconComponent={() => null}
                renderValue={() => (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, color: subText }}>
                        <SlidersHorizontal size={15} />
                        <Box component="span" sx={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                            Readouts
                        </Box>
                    </Box>
                )}
                sx={{
                    color: text,
                    bgcolor: surface,
                    '& .MuiSelect-select': { py: 0.45, pl: 1, pr: '10px !important' },
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: border },
                    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: accent }
                }}
            >
                <ListSubheader sx={{ bgcolor: surface, color: subText, fontWeight: 800, fontSize: '0.66rem', lineHeight: '26px', letterSpacing: 0.4 }}>
                    PICK READOUTS ({value.length}/{MAX_READOUTS})
                </ListSubheader>
                {groups.flatMap(({ cat, fields }) => [
                    <ListSubheader key={`h-${cat.id}`} sx={{ bgcolor: surface, fontWeight: 800, lineHeight: '28px', fontSize: '0.7rem', letterSpacing: 0.4, color: subText }}>
                        {cat.label.toUpperCase()}
                    </ListSubheader>,
                    ...fields.map(f => {
                        const id = `${cat.id}.${f.id}`;
                        const checked = value.includes(id);
                        const atCap = !checked && value.length >= MAX_READOUTS;
                        return (
                            <MenuItem key={id} value={id} disabled={atCap} sx={{ py: 0.25, fontSize: '0.82rem' }}>
                                <Checkbox size="small" checked={checked} sx={{ p: 0.5, mr: 0.5, color: subText, '&.Mui-checked': { color: accent } }} />
                                <ListItemText
                                    primary={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
                                    primaryTypographyProps={{ sx: { fontSize: '0.82rem' } }}
                                />
                            </MenuItem>
                        );
                    })
                ])}
            </Select>
        </FormControl>
    );
}

// ---------------------------------------------------------------------------
// Big numeric readout tile (top row + left depth band share this look)
// ---------------------------------------------------------------------------

function ReadoutTile({ id, value, surface, border, text, subText, accent, valueColor, valueSize = '1.45rem', minWidth = 120, showCategory = true }) {
    return (
        <Paper
            elevation={0}
            sx={{
                flex: '1 1 0',
                minWidth,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1.5,
                px: 1.25,
                py: 0.5,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 0.1,
                position: 'relative',
                overflow: 'hidden'
            }}
        >
            <Box sx={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, bgcolor: accent, opacity: 0.85 }} />
            <Typography sx={{ color: subText, fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {channelLabel(id)}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
                <Typography sx={{ color: valueColor || text, fontSize: valueSize, fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtValue(value, channelPrecision(id))}
                </Typography>
                <Typography sx={{ color: subText, fontSize: '0.72rem', fontWeight: 700 }}>{channelUnit(id)}</Typography>
            </Box>
            {showCategory && (
                <Typography sx={{ color: subText, fontSize: '0.54rem', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {channelCategory(id)}
                </Typography>
            )}
        </Paper>
    );
}

// ---------------------------------------------------------------------------
// Vertical scroll rail (up/down) â€” placed on BOTH left and right edges
// ---------------------------------------------------------------------------

function ScrollRail({ onUp, onDown, onHoldUp, onHoldDown, onHoldStop, upTip, downTip, downDisabled, text, border, top, bottom }) {
    const btnSx = {
        color: text,
        border: `1px solid ${border}`,
        borderRadius: 1,
        p: 0.35
    };
    // Press-and-hold: start a repeating scroll on pointer-down, stop on up/leave.
    // The onClick still fires for a quick tap = exactly one step.
    const holdProps = (onHold) => ({
        onPointerDown: (e) => { if (e.button === 0) onHold?.(); },
        onPointerUp: onHoldStop,
        onPointerLeave: onHoldStop,
        onPointerCancel: onHoldStop
    });
    return (
        <Box
            sx={{
                flex: '0 0 auto',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                alignItems: 'center',
                mt: `${top}px`,
                mb: `${bottom}px`
            }}
        >
            <MuiTooltip title={upTip} placement="left">
                <span><IconButton size="small" onClick={onUp} {...holdProps(onHoldUp)} sx={btnSx}><ChevronsUp size={16} /></IconButton></span>
            </MuiTooltip>
            <MuiTooltip title={downTip} placement="left">
                <span><IconButton size="small" onClick={onDown} disabled={downDisabled} {...(downDisabled ? {} : holdProps(onHoldDown))} sx={btnSx}><ChevronsDown size={16} /></IconButton></span>
            </MuiTooltip>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// SVG strip chart
// ---------------------------------------------------------------------------

function StripChart({ strip, samples, indexMode, indexDomain, showDateLabels = false, accentColor, gridColor, axisTextColor, surface, border, subText, textColor, cursorFrac, onCursorFracChange }) {
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 240, h: 260 });
    // Hovered cursor position, in fractional [0..1] of chart height (null = no hover).
    // We keep only this lightweight state and recompute the tooltip contents on
    // render â€” updates are throttled via requestAnimationFrame in the move handler.
    const rafRef = useRef(0);
    const pendingFracRef = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: Math.max(40, cr.width), h: Math.max(40, cr.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Flush any scheduled rAF on unmount.
    useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

    const enabledPens = strip.pens.filter(p => p.enabled);
    const { w, h } = size;
    const padX = 6;
    const innerW = Math.max(1, w - padX * 2);

    // Vertical gridlines (5 columns).
    const vLines = [0.25, 0.5, 0.75].map(f => padX + f * innerW);
    // Horizontal gridlines map to the shared index domain.
    const [d0, d1] = indexDomain;
    const span = d1 - d0 || 1;
    const chartShowDateLabels = indexMode === 'time' && (showDateLabels || shouldShowDateOnAxis(d0, d1));
    const yFor = (idx) => ((idx - d0) / span) * h;

    const hTickCount = Math.max(2, Math.min(8, Math.round(h / 48)));
    const hLines = Array.from({ length: hTickCount + 1 }, (_, i) => (i / hTickCount));

    // --- Hover crosshair / tooltip plumbing ---
    // Pointer Y -> fraction of height, scheduled on rAF so mousemove can't thrash.
    const handleMove = (e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect.height) return;
        const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        pendingFracRef.current = frac;
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            onCursorFracChange?.(pendingFracRef.current);
        });
    };
    const handleLeave = () => {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
        pendingFracRef.current = null;
        onCursorFracChange?.(null);
    };

    // Index value under the cursor (timestamp in time mode, depth in depth mode).
    const cursorIndex = cursorFrac == null ? null : d0 + cursorFrac * span;

    // Nearest sample to the cursor index (linear scan â€” samples are sorted by
    // timestamp/depth; cheap for the ~window-sized buffers we hold).
    const nearestSample = useMemo(() => {
        if (cursorIndex == null || !samples.length) return null;
        const key = indexMode === 'depth' ? 'depth' : 'timestamp';
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < samples.length; i += 1) {
            const iv = samples[i][key];
            if (!Number.isFinite(iv)) continue;
            const dist = Math.abs(iv - cursorIndex);
            if (dist < bestDist) { bestDist = dist; best = samples[i]; }
        }
        return best;
    }, [cursorIndex, samples, indexMode]);

    const fmtIndex = (v) => (
        indexMode === 'depth'
            ? `${fmtScale(v)} m`
            : formatAxisTime(v, chartShowDateLabels)
    );

    // Tooltip box geometry - clamp inside the strip and show this panel's selected pens.
    const showTooltip = cursorFrac != null && enabledPens.length > 0;
    const tooltipNearBottom = Number(cursorFrac) > 0.7;
    const tipRows = showTooltip
        ? enabledPens.map(pen => ({
            color: pen.color,
            name: channelLabel(pen.channelId),
            unit: channelUnit(pen.channelId),
            value: fmtValue(nearestSample?.values?.[pen.channelId], channelPrecision(pen.channelId))
        }))
        : [];

    const buildPath = (pen) => {
        const range = pen.max - pen.min || 1;
        let dStr = '';
        let started = false;
        for (let i = 0; i < samples.length; i += 1) {
            const s = samples[i];
            const raw = s.values[pen.channelId];
            const idx = indexMode === 'depth' ? s.depth : s.timestamp;
            if (!Number.isFinite(Number(raw)) || !Number.isFinite(Number(idx))) {
                started = false; // break the line over gaps
                continue;
            }
            const clamped = Math.max(pen.min, Math.min(pen.max, Number(raw)));
            const x = padX + ((clamped - pen.min) / range) * innerW;
            const y = yFor(idx);
            dStr += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
            started = true;
        }
        return dStr;
    };

    // Current value position for the thin marker (latest sample with a value).
    const markerFor = (pen) => {
        for (let i = samples.length - 1; i >= 0; i -= 1) {
            const raw = samples[i].values[pen.channelId];
            if (Number.isFinite(Number(raw))) {
                const range = pen.max - pen.min || 1;
                const clamped = Math.max(pen.min, Math.min(pen.max, Number(raw)));
                return padX + ((clamped - pen.min) / range) * innerW;
            }
        }
        return null;
    };

    return (
        <Box
            ref={ref}
            onPointerEnter={handleMove}
            onPointerMove={handleMove}
            onMouseMove={handleMove}
            onPointerLeave={handleLeave}
            sx={{ position: 'relative', width: '100%', height: '100%', zIndex: showTooltip ? 1000 : 1 }}
        >
            <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                {/* horizontal index gridlines */}
                {hLines.map((f, i) => (
                    <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* vertical scale gridlines */}
                {vLines.map((x, i) => (
                    <line key={`v${i}`} x1={x} x2={x} y1={0} y2={h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* pens */}
                {enabledPens.map((pen, i) => (
                    <path
                        key={`p${i}`}
                        d={buildPath(pen)}
                        fill="none"
                        stroke={pen.color}
                        strokeWidth={1.6}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                {/* thin current-value markers */}
                {enabledPens.map((pen, i) => {
                    const mx = markerFor(pen);
                    if (mx == null) return null;
                    return (
                        <line
                            key={`m${i}`}
                            x1={mx}
                            x2={mx}
                            y1={0}
                            y2={h}
                            stroke={pen.color}
                            strokeWidth={0.75}
                            strokeDasharray="2 3"
                            opacity={0.5}
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}
                {/* hover crosshair (thin horizontal cursor line at the hovered index) */}
                {cursorFrac != null && (
                    <line
                        x1={0}
                        x2={w}
                        y1={cursorFrac * h}
                        y2={cursorFrac * h}
                        stroke={accentColor}
                        strokeWidth={1}
                        opacity={0.85}
                        pointerEvents="none"
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* hover tooltip â€” index value + per-pen color/name/value at nearest sample */}
            {showTooltip && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: cursorFrac > 0.5 ? 4 : 'auto',
                        right: cursorFrac > 0.5 ? 'auto' : 4,
                        // Near the bottom, anchor tooltip above the cursor so chart lines
                        // do not run behind the popup text/value list.
                        top: tooltipNearBottom ? 'auto' : `${Math.max(2, Math.min(68, cursorFrac * 100 + 4))}%`,
                        bottom: tooltipNearBottom ? `${Math.max(6, Math.min(28, (1 - cursorFrac) * 100 + 5))}%` : 'auto',
                        zIndex: 5000,
                        pointerEvents: 'none',
                        bgcolor: surface,
                        border: `1px solid ${border}`,
                        borderRadius: 1,
                        boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
                        px: 0.85,
                        py: 0.6,
                        maxWidth: '96%',
                        minWidth: 150
                    }}
                >
                    <Typography sx={{ color: subText, fontSize: '0.6rem', fontWeight: 800, letterSpacing: 0.3, mb: 0.35, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtIndex(cursorIndex)}
                    </Typography>
                    {tipRows.map((r, i) => (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, lineHeight: 1.25 }}>
                            <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color, flex: '0 0 auto' }} />
                            <Typography component="span" sx={{ color: textColor, fontSize: '0.62rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>
                                {r.name}
                            </Typography>
                            <Typography component="span" sx={{ color: r.color, fontSize: '0.66rem', fontWeight: 900, ml: 'auto', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                {r.value}{r.unit ? <Box component="span" sx={{ color: subText, fontSize: '0.85em', fontWeight: 700, ml: 0.25 }}>{r.unit}</Box> : null}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
            {enabledPens.length === 0 && (
                <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                    <Typography sx={{ color: axisTextColor, fontSize: '0.7rem', opacity: 0.6 }}>No pens</Typography>
                </Box>
            )}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Fixed-height bottom "variables" block â€” the critical requirement.
//
// Always exactly BOTTOM_H tall. Content adapts to pen count so 1 pen is
// comfortable and 3 pens still fit the SAME height. Compaction order as the
// per-row height shrinks: (1) smaller font, (2) drop minâ€¦max scale, (3) drop
// NAME (keep unit), (4) keep only the color-coded VALUE.
// ---------------------------------------------------------------------------

function StripVariables({ strip, latest, compact, surface, border, subText }) {
    const BOTTOM_H = compact ? 64 : 96;
    const enabledPens = strip.pens.filter(p => p.enabled);
    const n = Math.max(1, enabledPens.length);
    const rowH = BOTTOM_H / Math.max(n, compact ? 2 : 1); // reserve at least 2 slots in compact

    // Compaction thresholds keyed off available per-row height.
    const fontValue = rowH >= 40 ? '1.15rem' : rowH >= 30 ? '0.98rem' : rowH >= 22 ? '0.86rem' : '0.78rem';
    const fontMeta = rowH >= 30 ? '0.62rem' : '0.58rem';
    const showScale = rowH >= 30;     // (2) drop scale first
    const showName = rowH >= 24;      // (3) then name (keep unit)

    return (
        <Box
            sx={{
                flex: `0 0 ${BOTTOM_H}px`,
                height: BOTTOM_H,
                mt: 0.5,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1,
                px: 0.75,
                py: 0.5,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-evenly',
                overflow: 'hidden'
            }}
        >
            {enabledPens.length === 0 ? (
                <Typography sx={{ color: subText, fontSize: '0.7rem', textAlign: 'center', alignSelf: 'center' }}>-</Typography>
            ) : enabledPens.map((pen, i) => {
                const unit = channelUnit(pen.channelId);
                const value = latest?.[pen.channelId];
                // Full-detail tooltip so a compacted row (unit-only / value-only) is
                // still identifiable on hover: Name (unit) - min...max - current value.
                const tipTitle = `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''} - ${fmtScale(pen.min)}...${fmtScale(pen.max)} - ${fmtValue(value, channelPrecision(pen.channelId))}${unit ? ` ${unit}` : ''}`;
                return (
                    <MuiTooltip key={i} title={tipTitle} placement="top" arrow>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.6,
                            minWidth: 0,
                            lineHeight: 1.05,
                            cursor: 'default'
                        }}
                    >
                        <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: pen.color, flex: '0 0 auto' }} />
                        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <Typography
                                component="div"
                                sx={{
                                    color: subText,
                                    fontSize: fontMeta,
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    letterSpacing: 0.2,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                            >
                                {/* compaction (3): drop NAME, keep unit */}
                                {showName
                                    ? `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''}`
                                    : (unit || channelLabel(pen.channelId))}
                                {/* compaction (2): drop min...max scale first */}
                                {showScale && (
                                    <Box component="span" sx={{ opacity: 0.7, ml: 0.5 }}>
                                        - {fmtScale(pen.min)}...{fmtScale(pen.max)}
                                    </Box>
                                )}
                            </Typography>
                        </Box>
                        <Typography
                            sx={{
                                color: pen.color,
                                fontSize: fontValue,
                                fontWeight: 900,
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                                flex: '0 0 auto'
                            }}
                        >
                            {fmtValue(value, channelPrecision(pen.channelId))}
                            {/* compaction (4): when name+unit are dropped from the meta line, keep unit beside the value */}
                            {!showName && unit ? (
                                <Box component="span" sx={{ fontSize: '0.6em', ml: 0.3, color: subText, fontWeight: 700 }}>{unit}</Box>
                            ) : null}
                        </Typography>
                    </Box>
                    </MuiTooltip>
                );
            })}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Per-strip config dialog
// ---------------------------------------------------------------------------

function StripConfigDialog({ open, onClose, strip, stripIndex, onSave, channels, surface, border, text, subText }) {
    const [draft, setDraft] = useState(strip);
    useEffect(() => { if (open) setDraft(JSON.parse(JSON.stringify(strip))); }, [open, strip]);

    const updatePen = (pi, patch) => {
        setDraft(prev => ({
            ...prev,
            pens: prev.pens.map((p, i) => (i === pi ? { ...p, ...patch } : p))
        }));
    };
    const onChannel = (pi, channelId) => {
        const meta = METRIC_LOOKUP.get(channelId);
        updatePen(pi, {
            channelId,
            min: meta?.defaultMin ?? 0,
            max: meta?.defaultMax ?? 1
        });
    };
    const addPen = () => {
        setDraft(prev => ({
            ...prev,
            pens: [...prev.pens, normalizePen({ channelId: (channels && channels[0]) || ALL_METRIC_IDS[0] }, prev.pens.length)]
        }));
    };
    const removePen = (pi) => {
        setDraft(prev => ({ ...prev, pens: prev.pens.filter((_, i) => i !== pi) }));
    };

    const fieldSx = { '& .MuiInputBase-root': { color: text }, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { bgcolor: surface, color: text, border: `1px solid ${border}` } }}>
            <DialogTitle sx={{ fontWeight: 900, borderBottom: `1px solid ${border}`, fontSize: '1rem' }}>
                Configure "{strip.title}"
            </DialogTitle>
            <DialogContent dividers sx={{ borderColor: border }}>
                <TextField
                    label="Track title"
                    value={draft.title}
                    onChange={(e) => setDraft(prev => ({ ...prev, title: e.target.value }))}
                    size="small"
                    fullWidth
                    sx={{ ...fieldSx, mb: 2 }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    {draft.pens.map((pen, pi) => (
                        <Paper key={pi} sx={{ p: 1.25, bgcolor: 'transparent', border: `1px solid ${border}`, borderRadius: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                <IconButton
                                    size="small"
                                    onClick={() => updatePen(pi, { enabled: !pen.enabled })}
                                    sx={{ color: pen.enabled ? pen.color : subText }}
                                    title={pen.enabled ? 'Pen on' : 'Pen off'}
                                >
                                    <Box sx={{ width: 14, height: 14, borderRadius: '3px', bgcolor: pen.enabled ? pen.color : 'transparent', border: `2px solid ${pen.color}` }} />
                                </IconButton>
                                <FormControl size="small" fullWidth>
                                    <ChannelSelect
                                        value={pen.channelId}
                                        onChange={(v) => onChannel(pi, v)}
                                        channels={channels}
                                        sx={{ color: text, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } }}
                                    />
                                </FormControl>
                                <IconButton size="small" onClick={() => removePen(pi)} sx={{ color: subText }} title="Remove pen">
                                    <Trash2 size={16} />
                                </IconButton>
                            </Box>
                            <Grid container spacing={1}>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Min" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.min}
                                        onChange={(e) => updatePen(pi, { min: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Max" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.max}
                                        onChange={(e) => updatePen(pi, { max: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Color" type="color" size="small" fullWidth
                                        sx={{ ...fieldSx, '& input': { height: 23, p: '4px' } }}
                                        value={COLOR_RE.test(pen.color) ? pen.color : '#38bdf8'}
                                        onChange={(e) => updatePen(pi, { color: e.target.value })}
                                    />
                                </Grid>
                            </Grid>
                        </Paper>
                    ))}
                </Box>
                <Button
                    startIcon={<Plus size={16} />}
                    onClick={addPen}
                    disabled={draft.pens.length >= MAX_PENS}
                    sx={{ mt: 1.5, color: text, borderColor: border }}
                    variant="outlined"
                    size="small"
                >
                    Add pen ({draft.pens.length}/{MAX_PENS})
                </Button>
            </DialogContent>
            <DialogActions sx={{ borderTop: `1px solid ${border}`, p: 1.5 }}>
                <Button onClick={onClose} sx={{ color: subText }}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={() => { onSave(stripIndex, normalizeStrips([draft])[0]); onClose(); }}
                >
                    Apply
                </Button>
            </DialogActions>
        </Dialog>
    );
}

function CustomRangeDialog({ open, onClose, onApply, initialFromMs, initialToMs, surface, border, text, subText }) {
    const now = Date.now();
    const [fromValue, setFromValue] = useState(() => toDateTimeLocalValue(initialFromMs || now - 60 * 60 * 1000));
    const [toValue, setToValue] = useState(() => toDateTimeLocalValue(initialToMs || now));
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        const fallbackNow = Date.now();
        setFromValue(toDateTimeLocalValue(initialFromMs || fallbackNow - 60 * 60 * 1000));
        setToValue(toDateTimeLocalValue(initialToMs || fallbackNow));
        setError('');
        // Only reset fields when the dialog opens. The parent live clock re-renders every
        // second, and including initialToMs here makes the "To" picker jump while selecting.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const apply = () => {
        const fromMs = parseDateTimeLocalValue(fromValue);
        const toMs = parseDateTimeLocalValue(toValue);
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
            setError('Please select valid from and to date/time.');
            return;
        }
        if (toMs <= fromMs) {
            setError('To time must be after from time.');
            return;
        }
        const label = `${formatAxisTime(fromMs, true)} - ${formatAxisTime(toMs, true)}`;
        onApply({ fromMs, toMs, label });
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { bgcolor: surface, color: text, border: `1px solid ${border}` } }}>
            <DialogTitle sx={{ fontWeight: 900, borderBottom: `1px solid ${border}`, fontSize: '1rem' }}>
                Custom EDR Time Range
            </DialogTitle>
            <DialogContent dividers sx={{ borderColor: border, pt: 2 }}>
                <TextField
                    fullWidth
                    label="From"
                    type="datetime-local"
                    value={fromValue}
                    onChange={(e) => setFromValue(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    sx={{ mb: 2 }}
                />
                <TextField
                    fullWidth
                    label="To"
                    type="datetime-local"
                    value={toValue}
                    onChange={(e) => setToValue(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                />
                {error && <Typography sx={{ color: '#f87171', fontSize: '0.8rem', fontWeight: 800, mt: 1.5 }}>{error}</Typography>}
                <Typography sx={{ color: subText, fontSize: '0.76rem', mt: 1.5 }}>
                    History loads from the Central Server database for the selected time.
                </Typography>
            </DialogContent>
            <DialogActions sx={{ borderTop: `1px solid ${border}`, p: 1.5 }}>
                <Button onClick={onClose} sx={{ color: subText, fontWeight: 800 }}>Cancel</Button>
                <Button variant="contained" onClick={apply} sx={{ fontWeight: 900 }}>Apply Range</Button>
            </DialogActions>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// EdrView main
// ---------------------------------------------------------------------------

export default function EdrView({
    rigId,
    mode = 'full',
    storageKey,
    defaultStrips = [],
    rightReadouts = [],
    channels = null,
    window: replayWindow = null,
    hideToolbar = false,
    timeWindowLabel = null,
    syncTimeWindowLabel = false
}) {
    const theme = useTheme();
    const isCompact = mode === 'compact';
    const initial = useMemo(() => loadPersisted(storageKey, defaultStrips, rightReadouts), [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const [customWindow, setCustomWindow] = useState(initial.customWindow);
    const [customOpen, setCustomOpen] = useState(false);
    // OFFLINE REPLAY mode: when a fixed window {fromMs,toMs,label} is supplied we seed
    // from a FIXED RANGE (api.rigHistoryRange) instead of the rolling history, do NOT
    // ingest live updates, and pin the index domain to [fromMs,toMs] (an EDR replaying a
    // PAST well run). When null, behaviour is EXACTLY the live path as before.
    const activeWindow = replayWindow || customWindow;
    const offline = !!(activeWindow && Number.isFinite(Number(activeWindow.fromMs)) && Number.isFinite(Number(activeWindow.toMs)));
    const winFromMs = offline ? Number(activeWindow.fromMs) : null;
    const winToMs = offline ? Number(activeWindow.toMs) : null;
    const winLabel = activeWindow?.label;
    // Central live payload (edge `rig_data` shape) for this rig â€” polled by RigDataProvider.
    const { data: liveData } = useRigData();

    // Theme-derived tokens (work across all 4 themes).
    const isDark = theme.palette.mode === 'dark';
    const panelBg = theme.palette.background.paper;
    const chartBg = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.04)';
    const border = isDark ? 'rgba(148,163,184,0.28)' : 'rgba(15,23,42,0.18)';
    const gridColor = isDark ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.12)';
    const text = theme.palette.text.primary;
    const subText = theme.palette.text.secondary || (isDark ? '#94a3b8' : '#475569');
    const accent = theme.palette.primary.main;

    const [strips, setStrips] = useState(initial.strips);
    const [indexMode, setIndexMode] = useState(initial.indexMode);
    // Configurable TOP readouts (full mode). Defaults to the rightReadouts prop.
    const [readouts, setReadouts] = useState(initial.readouts);

    const hasSavedTimeWindow = initial.timeWinIdx != null;
    const [timeWinIdx, setTimeWinIdx] = useState(() => {
        if (initial.timeWinIdx != null) return initial.timeWinIdx;
        const requested = TIME_WINDOWS.findIndex((w) => w.label.toLowerCase() === String(timeWindowLabel || '').toLowerCase());
        if (requested >= 0) return requested;
        if (isCompact) return TIME_WINDOWS.findIndex((w) => w.label === '5m');
        return TIME_WINDOWS.findIndex((w) => w.label === '12H');
    });
    const [depthSpanIdx, setDepthSpanIdx] = useState(() => initial.depthSpanIdx ?? 2);
    const [scrollOffset, setScrollOffset] = useState(0); // ms back in time, or m up in depth
    const [configStrip, setConfigStrip] = useState(null);
    const [sharedCursorFrac, setSharedCursorFrac] = useState(null);
    const [liveNowMs, setLiveNowMs] = useState(() => Date.now());

    const [data, setData] = useState([]); // [{ timestamp, depth, values:{channelId:value} }]
    const dragRef = useRef(null);

    useEffect(() => {
        if (!timeWindowLabel || (!syncTimeWindowLabel && hasSavedTimeWindow)) return;
        const idx = TIME_WINDOWS.findIndex((w) => w.label.toLowerCase() === String(timeWindowLabel).toLowerCase());
        if (idx >= 0) {
            setIndexMode('time');
            setTimeWinIdx(idx);
            if (!replayWindow) setCustomWindow(null);
            setScrollOffset(0);
        }
    }, [timeWindowLabel, syncTimeWindowLabel, hasSavedTimeWindow, replayWindow]);

    // Persist strip config + index mode + readout selection (same storageKey).
    useEffect(() => {
        if (!storageKey) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify({ strips, indexMode, readouts, timeWinIdx, depthSpanIdx, customWindow }));
        } catch (e) { /* best effort */ }
    }, [storageKey, strips, indexMode, readouts, timeWinIdx, depthSpanIdx, customWindow]);

    // Set of channels we need to fetch (all pens + readouts + depth band).
    const neededChannels = useMemo(() => {
        const set = new Set([HOLE_DEPTH_METRIC, BIT_DEPTH_METRIC]);
        strips.forEach(s => s.pens.forEach(p => set.add(p.channelId)));
        if (!isCompact) readouts.forEach(id => set.add(id));
        return Array.from(set);
    }, [strips, readouts, isCompact]);

    const presetTimeWindowMs = TIME_WINDOWS[timeWinIdx]?.ms ?? TIME_WINDOWS[0].ms;
    const timeWindowMs = offline && Number.isFinite(winFromMs) && Number.isFinite(winToMs)
        ? Math.max(60 * 1000, winToMs - winFromMs)
        : presetTimeWindowMs;
    const timeRange = TIME_WINDOWS[timeWinIdx]?.range ?? '-15m';
    const historyWindowMs = useMemo(() => {
        if (offline || indexMode !== 'time') return timeWindowMs;
        return Math.max(timeWindowMs, scrollOffset + timeWindowMs);
    }, [offline, indexMode, scrollOffset, timeWindowMs]);
    const historyMinutes = useMemo(() => Math.max(1, Math.ceil(historyWindowMs / 60000) + 1), [historyWindowMs]);

    // ---- History seed ----
    // Shared row->sample mapper for both the rolling (live) and fixed-range (offline) seeds.
    const rowsToSamples = useCallback((rows) => (
        (Array.isArray(rows) ? rows : []).map(row => {
            const values = {};
            neededChannels.forEach(id => { values[id] = row[id]; });
            return {
                timestamp: Number(row.t),
                depth: Number(row[DEPTH_INDEX_METRIC] ?? row['drilling.bit_depth']),
                values
            };
        }).filter(r => Number.isFinite(r.timestamp))
    ), [neededChannels]);

    const historyReq = useRef(0);
    const historyModeKey = offline ? `range:${winFromMs}-${winToMs}` : `minutes:${historyMinutes}`;
    const historyCacheKey = useMemo(() => cacheKeyFor(rigId, neededChannels, historyModeKey), [rigId, neededChannels, historyModeKey]);
    const fetchHistory = useCallback(async () => {
        if (!rigId) return;
        const reqId = ++historyReq.current;
        const cached = HISTORY_CACHE.get(historyCacheKey);
        if (cached?.length) {
            setData(cached);
        }
        try {
            // Central history is per-rig + bucketed; rows are [{ t:epochms, "<metric>":v }].
            // OFFLINE: seed from the FIXED [fromMs,toMs] range (range mode); LIVE: rolling minutes.
            const maxPoints = 240;
            const res = offline
                ? await api.rigHistoryRange(rigId, neededChannels, winFromMs, winToMs, maxPoints)
                : await api.rigHistoryMulti(rigId, neededChannels, historyMinutes, maxPoints);
            if (reqId !== historyReq.current) return;
            const samples = rowsToSamples(res?.rows);
            setHistoryCache(historyCacheKey, samples);
            setData(samples);
        } catch (err) {
            if (reqId !== historyReq.current) return;
            console.error('EdrView: failed to load history', err);
        }
    }, [rowsToSamples, neededChannels, historyMinutes, rigId, offline, winFromMs, winToMs, historyCacheKey]);

    // ---- Live point ingestion (shared socket) ----
    const ingest = useCallback((payload) => {
        const tsStr = payload?._meta?.ts;
        const ts = tsStr ? new Date(tsStr).getTime() : Date.now();
        const values = {};
        Object.keys(payload || {}).forEach(measurement => {
            const block = payload[measurement];
            if (block && typeof block === 'object') {
                Object.keys(block).forEach(field => {
                    values[`${measurement}.${field}`] = block[field];
                });
            }
        });
        const depth = Number(values[DEPTH_INDEX_METRIC] ?? values['drilling.bit_depth']);
        setData(prev => {
            const point = { timestamp: ts, depth, values };
            const merged = [...prev, point];
            const bySecond = new Map();
            merged.forEach(p => {
                const key = Math.floor((p.timestamp || 0) / 1000);
                bySecond.set(key, p); // keep latest within a second
            });
            const sorted = Array.from(bySecond.values()).sort((a, b) => a.timestamp - b.timestamp);
            // Cap buffer to the largest time window + headroom for scrolling.
            const cutoff = ts - (TIME_WINDOWS[TIME_WINDOWS.length - 1].ms * 1.5);
            return sorted.filter(p => (p.timestamp || 0) >= cutoff);
        });
    }, []);

    // History seed whenever the metric set / time window changes.
    useEffect(() => {
        const cached = HISTORY_CACHE.get(historyCacheKey);
        if (cached?.length) setData(cached);
        fetchHistory();
    }, [fetchHistory, historyCacheKey]);

    // Keep the live EDR time axis moving even when telemetry is stale or missing.
    useEffect(() => {
        if (offline || indexMode !== 'time') return undefined;
        const tick = () => setLiveNowMs(Date.now());
        tick();
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [offline, indexMode]);

    // Live point ingestion: the central RigDataProvider polls /api/rigs/:id/live (the
    // edge `rig_data` nested shape with _meta.ts), so feed each new payload to ingest().
    // OFFLINE replay: skip entirely so the fixed-range seed is never polluted by live points.
    useEffect(() => {
        if (offline) return;
        if (liveData && Object.keys(liveData).length) ingest(liveData);
    }, [offline, liveData, ingest]);

    // Reset scroll when switching index modes/windows, or when the OFFLINE replay range
    // changes (snap back to the recorded END so a new range starts at its latest data).
    useEffect(() => { setScrollOffset(0); }, [indexMode, timeWinIdx, depthSpanIdx, offline, winFromMs, winToMs]);

    // ---- Compute index domain + samples for the SVG ----
    const sorted = data; // already time-sorted

    const maxDepth = useMemo(() => sorted.reduce((m, p) => (
        Number.isFinite(p.depth) ? Math.max(m, p.depth) : m
    ), 0), [sorted]);

    const { indexDomain, samples } = useMemo(() => {
        if (indexMode === 'depth') {
            // Bin samples into depth buckets; keep last sample per bin.
            const bins = new Map();
            sorted.forEach(p => {
                if (!Number.isFinite(p.depth)) return;
                const key = Math.round(p.depth / DEPTH_BIN_M);
                bins.set(key, { depth: key * DEPTH_BIN_M, timestamp: p.timestamp, values: p.values });
            });
            const binned = Array.from(bins.values()).sort((a, b) => a.depth - b.depth);
            const span = DEPTH_SPANS[depthSpanIdx]?.m ?? 100;
            // Bottom of window = deepest minus scroll; depth increases downward.
            const bottom = Math.max(span, maxDepth - scrollOffset);
            const top = bottom - span;
            return { indexDomain: [top, bottom], samples: binned };
        }
        // Time mode: newest at the BOTTOM.
        // OFFLINE replay anchors the bottom of the visible window to the recorded end
        // (toMs) so scrollOffset walks back inside the FIXED [fromMs,toMs] range; clamp
        // so the window can't run past the recorded start. LIVE anchors to the actual
        // PC/browser clock so the axis keeps showing current time even if data is stale.
        const anchor = offline ? winToMs : liveNowMs;
        let bottom = anchor - scrollOffset;
        if (offline) {
            // Don't scroll the top edge before the recorded start.
            const minBottom = winFromMs + timeWindowMs;
            if (bottom < minBottom) bottom = minBottom;
            if (bottom > winToMs) bottom = winToMs;
        }
        const top = bottom - timeWindowMs;
        return { indexDomain: [top, bottom], samples: sorted };
    }, [indexMode, sorted, depthSpanIdx, maxDepth, scrollOffset, timeWindowMs, offline, winFromMs, winToMs, liveNowMs]);

    const latestValues = useMemo(() => (sorted.length ? sorted[sorted.length - 1].values : {}), [sorted]);

    // ---- Index axis ticks ----
    const axisTicks = useMemo(() => {
        const [a, b] = indexDomain;
        const count = 6;
        const showDateLabels = indexMode === 'time' && (offline || shouldShowDateOnAxis(a, b));
        return Array.from({ length: count + 1 }, (_, i) => {
            const frac = i / count;
            const v = a + frac * (b - a);
            if (indexMode === 'depth') return { frac, label: `${Math.round(v)}` };
            return {
                frac,
                label: showDateLabels ? formatAxisClock(v) : formatAxisClock(v, true),
                dateLabel: showDateLabels ? formatAxisDate(v) : ''
            };
        });
    }, [indexDomain, indexMode, offline]);

    // ---- Scroll handlers ----
    // One "page" of the visible window; a single rail click moves a half-window.
    const windowLen = indexMode === 'depth'
        ? (DEPTH_SPANS[depthSpanIdx]?.m ?? 100)
        : timeWindowMs;
    const scrollStep = windowLen * 0.5;            // single rail click = half window
    // Smaller increments for continuous (wheel / press-and-hold) scrolling so the
    // motion is smooth rather than jumpy.
    const wheelStep = windowLen * 0.12;            // per wheel notch
    const holdStep = windowLen * 0.06;             // per rAF tick while a button is held

    // Clamp helper: offset can never go below 0 â€” that is the live edge (or, offline,
    // the recorded END at toMs), so we never scroll into the future. OFFLINE also caps
    // the MAX offset at the recorded START so you can't scroll past the recorded ends.
    const maxOffset = useMemo(() => {
        if (!offline) return Infinity;
        if (indexMode === 'depth') return Infinity; // depth bounds itself via maxDepth
        // Walking the bottom edge from toMs back to (fromMs + window) â€” the earliest the
        // window can sit while still fully inside the recorded range.
        return Math.max(0, (winToMs - winFromMs) - timeWindowMs);
    }, [offline, indexMode, winFromMs, winToMs, timeWindowMs]);
    const clampOffset = useCallback((next) => Math.min(maxOffset, Math.max(0, next)), [maxOffset]);

    const scrollByAmount = useCallback((delta) => {
        // delta > 0 = back into history (older/shallower); < 0 = toward live.
        setScrollOffset(o => clampOffset(o + delta));
    }, [clampOffset]);

    const scrollBack = useCallback(() => scrollByAmount(scrollStep), [scrollByAmount, scrollStep]);   // older / shallower
    const scrollFwd = useCallback(() => scrollByAmount(-scrollStep), [scrollByAmount, scrollStep]);    // newer / deeper
    const stepWindowBack = useCallback(() => scrollByAmount(windowLen), [scrollByAmount, windowLen]);
    const stepWindowFwd = useCallback(() => scrollByAmount(-windowLen), [scrollByAmount, windowLen]);

    // --- Mouse-wheel continuous scroll (non-passive so we can preventDefault) ---
    const stripAreaRef = useRef(null);
    const wheelStepRef = useRef(wheelStep);
    wheelStepRef.current = wheelStep;
    useEffect(() => {
        const el = stripAreaRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            // Block the page from scrolling while the pointer is over the strips.
            e.preventDefault();
            // wheel up (deltaY < 0) => back into history; wheel down => toward live.
            const dir = e.deltaY < 0 ? 1 : -1;
            setScrollOffset(o => clampOffset(o + dir * wheelStepRef.current));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [clampOffset]);

    // --- Press-and-hold continuous scroll on the rail buttons ---
    // While held, repeat a small step each animation frame; a plain click still
    // performs exactly one half-window step (handled by the rail's onClick).
    const holdRafRef = useRef(0);
    const heldMovedRef = useRef(false); // did the hold actually scroll continuously?
    const holdStepRef = useRef(holdStep);
    holdStepRef.current = holdStep;
    const startHold = useCallback((dir) => {
        if (holdRafRef.current) return;
        heldMovedRef.current = false;
        let frames = 0;
        const tick = () => {
            frames += 1;
            // brief grace period so a quick click is handled solely by onClick
            if (frames > 12) {
                heldMovedRef.current = true;
                setScrollOffset(o => clampOffset(o + dir * holdStepRef.current));
            }
            holdRafRef.current = requestAnimationFrame(tick);
        };
        holdRafRef.current = requestAnimationFrame(tick);
    }, [clampOffset]);
    const stopHold = useCallback(() => {
        if (holdRafRef.current) { cancelAnimationFrame(holdRafRef.current); holdRafRef.current = 0; }
    }, []);
    useEffect(() => () => { if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current); }, []);

    // Rail click = one step, BUT swallow the click that ends a press-and-hold so
    // releasing after a continuous scroll doesn't tack on an extra half-window jump.
    const clickBack = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollBack();
    }, [scrollBack]);
    const clickFwd = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollFwd();
    }, [scrollFwd]);

    // Drag on the axis to scroll.
    const onAxisPointerDown = (e) => {
        dragRef.current = { y: e.clientY, offset: scrollOffset };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onAxisPointerMove = (e) => {
        if (!dragRef.current) return;
        const dy = e.clientY - dragRef.current.y;
        const el = e.currentTarget;
        const pxH = el.clientHeight || 1;
        const [a, b] = indexDomain;
        const perPx = (b - a) / pxH;
        // dragging DOWN reveals older data (increase offset)
        const next = dragRef.current.offset + dy * perPx;
        setScrollOffset(clampOffset(next));
    };
    const onAxisPointerUp = () => { dragRef.current = null; };

    const updateStrip = useCallback((index, nextStrip) => {
        setStrips(prev => prev.map((s, i) => (i === index ? nextStrip : s)));
    }, []);

    // "At the bottom edge" â€” the live edge when live, or the recorded END (toMs) offline.
    const liveAtBottom = scrollOffset <= (indexMode === 'depth' ? 0.01 : 1000);
    const jumpToLive = useCallback(() => setScrollOffset(0), []);

    // OFFLINE chip label: caller-supplied label, else the recorded fromâ†’to date range.
    const offlineLabel = useMemo(() => {
        if (!offline) return '';
        if (winLabel) return winLabel;
        const fmt = (ms) => new Date(ms).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });
        return `${fmt(winFromMs)} - ${fmt(winToMs)}`;
    }, [offline, winLabel, winFromMs, winToMs]);

    // ---------------- Render ----------------

    const axisWidth = isCompact ? 44 : 56;
    const bottomH = isCompact ? 64 : 96;          // fixed variables-block height
    const headerH = isCompact ? 22 : 26;          // per-strip header row height
    // Top/bottom offsets so the index axis, scroll rails and left depth band line
    // up with the chart area: top offset = strip header height, bottom = variables block.
    const railTop = headerH + 4;
    const railBottom = bottomH + 4;
    const showLeftDepth = !isCompact;
    const showTopReadouts = !isCompact && readouts.length > 0;

    const holeDepthVal = latestValues?.[HOLE_DEPTH_METRIC];
    const bitDepthVal = latestValues?.[BIT_DEPTH_METRIC];

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, px: isCompact ? 0 : 1 }}>
            {/* Toolbar */}
            {!hideToolbar && (
                <Box sx={{ mb: 1.25 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, flexWrap: 'wrap' }}>
                        <ToggleButtonGroup
                            size="small"
                            exclusive
                            value={indexMode}
                            onChange={(_, v) => v && setIndexMode(v)}
                            sx={{
                                '& .MuiToggleButton-root': { color: subText, borderColor: border, px: 1.1, py: 0.5, textTransform: 'none', fontWeight: 900, fontSize: '0.9rem' },
                                '& .Mui-selected': { color: `${accent} !important`, bgcolor: `${accent}22 !important` }
                            }}
                        >
                            <ToggleButton value="time"><Clock size={16} style={{ marginRight: 6 }} /> Time</ToggleButton>
                            <ToggleButton value="depth"><Ruler size={16} style={{ marginRight: 6 }} /> Depth</ToggleButton>
                        </ToggleButtonGroup>

                        {!isCompact && (
                            <>
                                <MuiTooltip title={indexMode === 'depth' ? 'Move deeper by selected depth range' : 'Increase time / move newer by selected range'}>
                                    <span>
                                        <IconButton size="small" onClick={stepWindowFwd} disabled={liveAtBottom} sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 0.75, width: 36, height: 36 }}><Plus size={17} /></IconButton>
                                    </span>
                                </MuiTooltip>
                                <MuiTooltip title={indexMode === 'depth' ? 'Move shallower by selected depth range' : 'Decrease time / move older by selected range'}>
                                    <IconButton size="small" onClick={stepWindowBack} sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 0.75, width: 36, height: 36 }}><Minus size={17} /></IconButton>
                                </MuiTooltip>
                            </>
                        )}

                        <Box sx={{ display: 'flex', gap: 0.45, alignItems: 'center', flexWrap: 'wrap' }}>
                            {(indexMode === 'time' ? TIME_WINDOWS : DEPTH_SPANS).map((opt, i) => {
                                const active = indexMode === 'time' ? (!customWindow && i === timeWinIdx) : i === depthSpanIdx;
                                return (
                                    <Button
                                        key={opt.label}
                                        size="small"
                                        onClick={() => {
                                            if (indexMode === 'time') {
                                                setCustomWindow(null);
                                                setTimeWinIdx(i);
                                                setScrollOffset(0);
                                            } else {
                                                setDepthSpanIdx(i);
                                            }
                                        }}
                                        sx={{
                                            minWidth: isCompact ? 36 : 43,
                                            height: isCompact ? 31 : 38,
                                            px: 0.75,
                                            textTransform: 'none',
                                            fontWeight: 900,
                                            fontSize: isCompact ? '0.8rem' : '0.95rem',
                                            color: active ? theme.palette.getContrastText(accent) : subText,
                                            bgcolor: active ? accent : 'transparent',
                                            border: `1px solid ${border}`,
                                            borderRadius: 0.75,
                                            '&:hover': { bgcolor: active ? accent : `${accent}18` }
                                        }}
                                    >
                                        {opt.label}
                                    </Button>
                                );
                            })}
                        </Box>

                        <>
                            <Button
                                size="small"
                                variant={customWindow ? 'contained' : 'outlined'}
                                startIcon={<Clock size={16} />}
                                onClick={() => {
                                    setIndexMode('time');
                                    setCustomOpen(true);
                                }}
                                sx={{ height: 38, textTransform: 'none', fontWeight: 900, color: customWindow ? theme.palette.getContrastText(accent) : text, borderColor: border }}
                            >
                                Custom
                            </Button>
                        </>

                        <Box sx={{ flex: 1 }} />

                        {offline ? (
                            <MuiTooltip title={replayWindow ? 'Offline replay - fixed recorded range' : 'Custom history range'}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 1, py: 0.45, borderRadius: 1, border: `1px solid ${border}`, bgcolor: `${accent}14` }}>
                                    <Clock size={13} color={accent} />
                                    <Typography sx={{ color: accent, fontSize: '0.72rem', fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase' }}>{replayWindow ? 'OFFLINE' : 'HISTORY'}</Typography>
                                    <Typography sx={{ color: subText, fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>- {offlineLabel}</Typography>
                                </Box>
                            </MuiTooltip>
                        ) : liveAtBottom ? (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                                <Radio size={13} color="#22c55e" />
                                <Typography sx={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 900, letterSpacing: 0.5 }}>LIVE</Typography>
                            </Box>
                        ) : (
                            <MuiTooltip title="Jump to live">
                                <Button size="small" onClick={jumpToLive} startIcon={<Radio size={13} />} sx={{ textTransform: 'none', fontWeight: 900, py: 0.4, px: 1, color: subText, border: `1px solid ${border}`, '&:hover': { color: '#22c55e', borderColor: '#22c55e' } }}>
                                    {indexMode === 'depth' ? `${Math.round(indexDomain[0])}-${Math.round(indexDomain[1])} m - live` : 'Scrolled back - live'}
                                </Button>
                            </MuiTooltip>
                        )}

                        {!isCompact && (
                            <Button size="small" variant="outlined" startIcon={<Download size={16} />} sx={{ height: 38, color: text, borderColor: border, textTransform: 'none', fontWeight: 900 }}>
                                Export
                            </Button>
                        )}
                    </Box>
                </Box>
            )}

            {/* Top band (full mode): left depth spacer + configurable readout row. */}
            {showTopReadouts && (
                <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, mb: 1.1 }}>
                    {showLeftDepth && <Box sx={{ flex: '0 0 225px' }} />}
                    <Box sx={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, readouts.length)}, minmax(0, 1fr))`, gap: 0.75 }}>
                        {readouts.map((id) => (
                            <ReadoutTile
                                key={id}
                                id={id}
                                value={latestValues?.[id]}
                                surface={panelBg}
                                border={border}
                                text={text}
                                subText={subText}
                                accent={accent}
                                minWidth={0}
                                valueSize="1.15rem"
                            />
                        ))}
                    </Box>
                    <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
                        <ReadoutsConfig
                            value={readouts}
                            onChange={setReadouts}
                            channels={channels}
                            surface={panelBg}
                            border={border}
                            text={text}
                            subText={subText}
                            accent={accent}
                        />
                    </Box>
                </Box>
            )}
            {/* When no readouts selected, still expose the config control (full mode). */}
            {!isCompact && readouts.length === 0 && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
                    <ReadoutsConfig
                        value={readouts}
                        onChange={setReadouts}
                        channels={channels}
                        surface={panelBg}
                        border={border}
                        text={text}
                        subText={subText}
                        accent={accent}
                    />
                </Box>
            )}
            {/* Strip area */}
            <Box ref={stripAreaRef} sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 0.75 }}>
                {/* Left depth / index column (full mode): time/depth axis with hole + bit depth below. */}
                {showLeftDepth && (
                    <Box sx={{ flex: '0 0 190px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                        <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.55, mb: '4px', pl: 0.4 }}>
                            <Gauge size={16} color={subText} />
                            <Typography sx={{ color: text, fontSize: '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                                {indexMode === 'depth' ? 'Depth' : 'Depth'}
                            </Typography>
                        </Box>
                        <Box
                            onPointerDown={onAxisPointerDown}
                            onPointerMove={onAxisPointerMove}
                            onPointerUp={onAxisPointerUp}
                            onPointerLeave={onAxisPointerUp}
                            sx={{
                                flex: '1 1 auto',
                                minHeight: 0,
                                bgcolor: chartBg,
                                border: `1px solid ${border}`,
                                borderRadius: 1,
                                position: 'relative',
                                cursor: 'ns-resize',
                                userSelect: 'none',
                                touchAction: 'none',
                                overflow: 'hidden'
                            }}
                        >
                            <Typography sx={{ position: 'absolute', top: 6, left: 0, right: 0, textAlign: 'center', fontSize: '0.64rem', fontWeight: 900, color: text, textTransform: 'uppercase' }}>
                                {indexMode === 'depth' ? 'm' : 'time'}
                            </Typography>
                            {axisTicks.map((t, i) => (
                                <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `calc(22px + ${t.frac * 100}% * 0.88)`, transform: 'translateY(-50%)', px: 0.25 }}>
                                    {t.dateLabel && (
                                        <Typography sx={{ fontSize: '0.54rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: 1.05 }}>
                                            {t.dateLabel}
                                        </Typography>
                                    )}
                                    <Typography sx={{ fontSize: '0.62rem', color: text, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: 1.05 }}>
                                        {t.label}
                                    </Typography>
                                </Box>
                            ))}
                        </Box>
                        <Box sx={{ height: bottomH, mt: 0.75, bgcolor: panelBg, border: `1px solid ${border}`, borderRadius: 1, px: 1, py: 0.8, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0.8 }}>
                            <Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: '#22d3ee' }} />
                                    <Typography sx={{ color: text, fontSize: '0.66rem', fontWeight: 900, textTransform: 'uppercase' }}>Hole Depth</Typography>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, pl: 1.6, mt: 0.35 }}>
                                    <Typography sx={{ color: text, fontSize: '0.82rem', fontWeight: 900 }}>{fmtValue(holeDepthVal, channelPrecision(HOLE_DEPTH_METRIC))}</Typography>
                                    <Typography sx={{ color: text, fontSize: '0.66rem', fontWeight: 900 }}>{channelUnit(HOLE_DEPTH_METRIC)}</Typography>
                                </Box>
                            </Box>
                            <Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: '#fbbf24' }} />
                                    <Typography sx={{ color: text, fontSize: '0.66rem', fontWeight: 900, textTransform: 'uppercase' }}>Bit Depth</Typography>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, pl: 1.6, mt: 0.35 }}>
                                    <Typography sx={{ color: text, fontSize: '0.82rem', fontWeight: 900 }}>{fmtValue(bitDepthVal, channelPrecision(BIT_DEPTH_METRIC))}</Typography>
                                    <Typography sx={{ color: text, fontSize: '0.66rem', fontWeight: 900 }}>{channelUnit(BIT_DEPTH_METRIC)}</Typography>
                                </Box>
                            </Box>
                        </Box>
                    </Box>
                )}
                {/* LEFT scroll rail */}
                <ScrollRail
                    onUp={clickBack}
                    onDown={clickFwd}
                    onHoldUp={() => startHold(1)}
                    onHoldDown={() => startHold(-1)}
                    onHoldStop={stopHold}
                    upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                    downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                    downDisabled={liveAtBottom}
                    text={text}
                    border={border}
                    top={railTop}
                    bottom={railBottom}
                />

                {/* Shared index axis */}
                {isCompact && (
                <Box
                    onPointerDown={onAxisPointerDown}
                    onPointerMove={onAxisPointerMove}
                    onPointerUp={onAxisPointerUp}
                    onPointerLeave={onAxisPointerUp}
                    sx={{
                        flex: `0 0 ${axisWidth}px`,
                        bgcolor: panelBg,
                        border: `1px solid ${border}`,
                        borderRadius: 1,
                        position: 'relative',
                        cursor: 'ns-resize',
                        userSelect: 'none',
                        touchAction: 'none',
                        // align with the chart area: skip the strip header at the top
                        // and the fixed variables block at the bottom.
                        mt: `${railTop}px`,
                        mb: `${railBottom}px`
                    }}
                >
                    <Typography sx={{ position: 'absolute', top: 4, left: 0, right: 0, textAlign: 'center', fontSize: '0.6rem', fontWeight: 800, color: subText, textTransform: 'uppercase' }}>
                        {indexMode === 'depth' ? 'm' : 'time'}
                    </Typography>
                    {axisTicks.map((t, i) => (
                        <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `calc(22px + ${t.frac * 100}% * 0.88)`, transform: 'translateY(-50%)', px: 0.25 }}>
                            {t.dateLabel && (
                                <Typography sx={{ fontSize: isCompact ? '0.48rem' : '0.52rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: 1.05 }}>
                                    {t.dateLabel}
                                </Typography>
                            )}
                            <Typography sx={{ fontSize: isCompact ? '0.55rem' : '0.62rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', lineHeight: 1.05 }}>
                                {t.label}
                            </Typography>
                        </Box>
                    ))}
                </Box>
                )}

                {/* Strips */}
                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 0.75 }}>
                    {strips.map((strip, si) => (
                        <Box key={si} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            {/* header */}
                            <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.5, mb: '4px' }}>
                                <Typography sx={{ flex: 1, minWidth: 0, color: text, fontSize: isCompact ? '0.66rem' : '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {strip.title}
                                </Typography>
                                <IconButton size="small" onClick={() => setConfigStrip(si)} sx={{ color: subText, p: 0.25 }} title="Configure track">
                                    <Settings size={isCompact ? 13 : 15} />
                                </IconButton>
                            </Box>
                            {/* chart */}
                            <Box sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: chartBg, border: `1px solid ${border}`, borderRadius: 1, overflow: 'visible', position: 'relative' }}>
                                <StripChart
                                    strip={strip}
                                    samples={samples}
                                    indexMode={indexMode}
                                    indexDomain={indexDomain}
                                    showDateLabels={offline}
                                    accentColor={accent}
                                    gridColor={gridColor}
                                    axisTextColor={subText}
                                    surface={panelBg}
                                    border={border}
                                    subText={subText}
                                    textColor={text}
                                    cursorFrac={sharedCursorFrac}
                                    onCursorFracChange={setSharedCursorFrac}
                                />
                            </Box>
                            {/* fixed-height variables block */}
                            <StripVariables
                                strip={strip}
                                latest={latestValues}
                                compact={isCompact}
                                surface={panelBg}
                                border={border}
                                subText={subText}
                            />
                        </Box>
                    ))}
                </Box>

                {/* RIGHT scroll rail (mirror of the left) â€” full mode only; compact keeps a single control. */}
                {!isCompact && (
                    <ScrollRail
                        onUp={clickBack}
                        onDown={clickFwd}
                        onHoldUp={() => startHold(1)}
                        onHoldDown={() => startHold(-1)}
                        onHoldStop={stopHold}
                        upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                        downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                        downDisabled={liveAtBottom}
                        text={text}
                        border={border}
                        top={railTop}
                        bottom={railBottom}
                    />
                )}
            </Box>

            {/* Per-strip config dialog */}
            {configStrip != null && (
                <StripConfigDialog
                    open={configStrip != null}
                    onClose={() => setConfigStrip(null)}
                    strip={strips[configStrip]}
                    stripIndex={configStrip}
                    onSave={updateStrip}
                    channels={channels}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                />
            )}
            {customOpen && (
                <CustomRangeDialog
                    open={customOpen}
                    onClose={() => setCustomOpen(false)}
                    onApply={(nextWindow) => {
                        setCustomWindow(nextWindow);
                        setIndexMode('time');
                        setScrollOffset(0);
                        setCustomOpen(false);
                    }}
                    initialFromMs={winFromMs || Date.now() - presetTimeWindowMs}
                    initialToMs={winToMs || Date.now()}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                />
            )}
        </Box>
    );
}




















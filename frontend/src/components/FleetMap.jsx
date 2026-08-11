import React from 'react';
import { Box, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { STATUS_COLOR } from '../theme';

// Interactive pan/zoom fleet map (Leaflet) over India — pan-ONGC. Each rig is a
// status-coloured marker; clicking it opens the rig drill-down.
//
// Tiles default to CARTO dark (matches the ops theme). DATA RESIDENCY: a production
// ONGC deployment (zero internet egress) should point VITE_MAP_TILE_URL at an
// INTERNAL/offline tile server; the map, markers and pan/zoom work regardless of
// whether the basemap tiles load.
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL
    || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = import.meta.env.VITE_MAP_TILE_ATTR
    || '&copy; OpenStreetMap contributors &copy; CARTO';

export default function FleetMap({ rigs = [] }) {
    const nav = useNavigate();
    const pts = rigs.filter((r) => Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)));

    return (
        <Paper sx={{ height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
            {/* Title overlay (top-right so it never collides with the Leaflet zoom control). */}
            <Box sx={{ position: 'absolute', top: 8, right: 8, zIndex: 500, pointerEvents: 'none',
                bgcolor: 'rgba(11,18,32,0.72)', px: 1, py: 0.4, borderRadius: 1, border: '1px solid rgba(255,255,255,0.08)' }}>
                <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.5, color: 'text.secondary' }}>
                    FLEET MAP · PAN-ONGC
                </Typography>
            </Box>

            <MapContainer
                center={[22.5, 80]}
                zoom={5}
                minZoom={3}
                scrollWheelZoom
                worldCopyJump
                style={{ height: '100%', width: '100%', background: '#0b1220' }}
            >
                <TileLayer url={TILE_URL} attribution={TILE_ATTR} subdomains="abcd" />
                {pts.map((r) => {
                    const color = STATUS_COLOR[r.status] || STATUS_COLOR.pending;
                    return (
                        <CircleMarker
                            key={r.rigId}
                            center={[Number(r.latitude), Number(r.longitude)]}
                            radius={7}
                            pathOptions={{ color: '#0b1220', weight: 1.5, fillColor: color, fillOpacity: 0.95 }}
                            eventHandlers={{ click: () => nav(`/rigs/${r.rigId}`) }}
                        >
                            <Tooltip direction="top" offset={[0, -6]}>
                                <strong>{r.name}</strong> · {r.assetUnit || r.field || '—'}<br />
                                {String(r.status || '').toUpperCase()}
                                {r.alarm?.p1 ? ' · P1' : ''}{r.activeActivity ? ` · ${r.activeActivity}` : ''}
                            </Tooltip>
                        </CircleMarker>
                    );
                })}
            </MapContainer>

            {/* Status legend overlay. */}
            <Box sx={{ position: 'absolute', bottom: 8, left: 8, zIndex: 500,
                bgcolor: 'rgba(11,18,32,0.78)', px: 1, py: 0.5, borderRadius: 1, border: '1px solid rgba(255,255,255,0.08)' }}>
                <Stack direction="row" spacing={1.2} flexWrap="wrap" useFlexGap>
                    {Object.entries(STATUS_COLOR).map(([k, c]) => (
                        <Stack key={k} direction="row" spacing={0.5} alignItems="center">
                            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: c }} />
                            <Typography variant="caption" color="text.secondary" textTransform="capitalize">{k}</Typography>
                        </Stack>
                    ))}
                </Stack>
            </Box>
        </Paper>
    );
}

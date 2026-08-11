import React from 'react';
import { Box } from '@mui/material';
import EdrView from '../EdrView';

// Trends / EDR tab - the full edge Electronic Drilling Recorder (hand-rolled SVG
// multi-pen strip charts, Time/Depth index, scrollback, configurable pens + readouts),
// ported into the CRMF and fed by the central per-rig data. READ-ONLY.
//
// Default driller tracks + top readouts mirror the edge EdrDashboard defaults
// (channelId = `category.field`, catalog units/min/max from edrMetrics.json).

const DEFAULT_STRIPS = [
    {
        title: 'Hookload / WOB',
        pens: [
            { channelId: 'drilling.wob', color: '#38bdf8', min: 0, max: 100, enabled: true },
            { channelId: 'drawworks.hook_load', color: '#fbbf24', min: 0, max: 500, enabled: true },
            { channelId: 'drawworks.block_position', color: '#4ade80', min: 0, max: 50, enabled: true },
        ],
    },
    {
        title: 'Rotary',
        pens: [
            { channelId: 'drilling.rpm', color: '#a78bfa', min: 0, max: 250, enabled: true },
            { channelId: 'drilling.rop', color: '#f472b6', min: 0, max: 80, enabled: true },
            { channelId: 'drilling.torque', color: '#22d3ee', min: 0, max: 20000, enabled: true },
        ],
    },
    {
        title: 'Pump',
        pens: [
            { channelId: 'mudpump.spm', color: '#fb7185', min: 0, max: 200, enabled: true },
            { channelId: 'mudpump.pressure', color: '#38bdf8', min: 0, max: 500, enabled: true },
            { channelId: 'mudpump.flow_in', color: '#f97316', min: 0, max: 3000, enabled: true },
        ],
    },
    {
        title: 'Mud Volumes',
        pens: [
            { channelId: 'fluid.total_tank_volume', color: '#4ade80', min: 0, max: 500, enabled: true },
            { channelId: 'fluid.tank_gain_loss', color: '#fbbf24', min: -50, max: 50, enabled: true },
            { channelId: 'fluid.trip_tank', color: '#a78bfa', min: 0, max: 50, enabled: true },
        ],
    },
];

const TOP_READOUTS = ['mudpump.pressure', 'mudpump.spm', 'drilling.rop', 'drawworks.hook_load'];

export default function TrendsPanel({ rigId }) {
    return (
        <Box sx={{ height: '100%', minHeight: 460, display: 'flex', flexDirection: 'column' }}>
            <EdrView
                rigId={rigId}
                mode="full"
                storageKey={`crmf-edr-${rigId}`}
                defaultStrips={DEFAULT_STRIPS}
                rightReadouts={TOP_READOUTS}
            />
        </Box>
    );
}

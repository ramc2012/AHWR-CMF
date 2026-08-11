'use strict';
// Prometheus metrics for the CRMF backend (default ON; gated by METRICS_ENABLED).
// MONITORING-ONLY platform: these are observability counters for the ingest path
// and fleet rollup — nothing here writes back to any rig/PLC.
//
// This module must be no-op-safe: requiring it never throws, and every helper
// swallows its own errors so a metrics hiccup can never break the request path.
const client = require('prom-client');

const PREFIX = 'crmf_';

// One process-wide registry. Default Node/process metrics are collected once.
const registry = new client.Registry();
registry.setDefaultLabels({ service: 'crmf-backend' });

try {
    client.collectDefaultMetrics({ register: registry, prefix: PREFIX });
} catch { /* default metrics already collected / unavailable — ignore */ }

// --- Ingest counters/histogram (proposal §6.3 ingestion) ----------------------
const ingestBatches = new client.Counter({
    name: 'crmf_ingest_batches_total',
    help: 'Total store-and-forward batches accepted from rig-edge agents.',
    registers: [registry],
});
const ingestPoints = new client.Counter({
    name: 'crmf_ingest_points_total',
    help: 'Total telemetry points written from ingest batches.',
    registers: [registry],
});
const ingestEvents = new client.Counter({
    name: 'crmf_ingest_events_total',
    help: 'Total events (alarm/connection/activity) written from ingest batches.',
    registers: [registry],
});
const ingestErrors = new client.Counter({
    name: 'crmf_ingest_errors_total',
    help: 'Total ingest requests that failed (bad payload, auth, or server error).',
    registers: [registry],
});
const ingestDuration = new client.Histogram({
    name: 'crmf_ingest_duration_seconds',
    help: 'Wall-clock time to process an ingest batch, in seconds.',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

// --- Fleet rollup gauges (proposal §6.1 fleet overview) -----------------------
const fleetRigs = new client.Gauge({
    name: 'crmf_fleet_rigs',
    help: 'Number of rigs by status (online/degraded/stale/offline/pending).',
    labelNames: ['status'],
    registers: [registry],
});
const fleetAlarmsActive = new client.Gauge({
    name: 'crmf_fleet_alarms_active',
    help: 'Total active alarms across the fleet.',
    registers: [registry],
});

// Record the outcome of one ingest request. `durationSec` is wall-clock seconds.
// Pass ok:false to count the request as an error. Always safe to call.
function observeIngest({ ok, durationSec, points = 0, events = 0 } = {}) {
    try {
        ingestBatches.inc();
        if (typeof durationSec === 'number' && Number.isFinite(durationSec)) {
            ingestDuration.observe(durationSec);
        }
        if (ok) {
            if (points) ingestPoints.inc(points);
            if (events) ingestEvents.inc(events);
        } else {
            ingestErrors.inc();
        }
    } catch { /* never let metrics break ingest */ }
}

// Count an ingest error without a full observation (e.g. early bad-gzip/bad-json
// rejection where we still want the error reflected). Safe to call.
function incIngestError() {
    try { ingestErrors.inc(); } catch { /* ignore */ }
}

const FLEET_STATUSES = ['online', 'degraded', 'stale', 'offline', 'pending'];

// Mirror a fleet summary (from fleet.getFleetSummary()) into the gauges. Safe to
// call with a partial/undefined summary.
function setFleetGauges(summary) {
    if (!summary) return;
    try {
        for (const status of FLEET_STATUSES) {
            fleetRigs.set({ status }, Number(summary[status]) || 0);
        }
        fleetAlarmsActive.set(Number(summary.alarmsActive) || 0);
    } catch { /* ignore */ }
}

module.exports = {
    registry,
    observeIngest,
    incIngestError,
    setFleetGauges,
};

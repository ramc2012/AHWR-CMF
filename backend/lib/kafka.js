'use strict';
// Optional Kafka fan-out for ingested telemetry/events (proposal §6.3 store-and-forward
// onward streaming). DEFAULT OFF: when KAFKA_ENABLED !== 'true' every function is a
// no-op and kafkajs is NEVER require()'d, so the docker-compose MVP runs unchanged.
//
// MONITORING-ONLY: this only PUBLISHES copies of data already received from rigs;
// it never consumes or writes anything back toward a rig/PLC.
//
// Nothing here ever throws into the request path — publish failures are caught and
// counted via lib/metrics (incIngestError) so ingest acks are never blocked.
const fs = require('fs');
const metrics = require('./metrics');

const ENABLED = process.env.KAFKA_ENABLED === 'true';
const BROKERS = (process.env.KAFKA_BROKERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const TELEMETRY_TOPIC = process.env.KAFKA_TELEMETRY_TOPIC || 'telemetry.ingest';
const EVENTS_TOPIC_PREFIX = process.env.KAFKA_EVENTS_TOPIC_PREFIX || 'events.';

let producer = null;     // lazily-built kafkajs producer
let connecting = null;   // in-flight connect promise (de-dupes concurrent starts)
let ready = false;

// Resolve the TLS config (audit #19). When KAFKA_SSL_CA points at a CA bundle
// (the Strimzi self-signed cluster CA), trust it explicitly with
// rejectUnauthorized:true — kafkajs ssl:true alone validates only against Node's
// public CA bundle, which lacks the Strimzi CA and fails the handshake. Falls
// back to a bare boolean when no CA file is configured.
function sslOptions() {
    const caPath = process.env.KAFKA_SSL_CA;
    if (caPath) {
        try {
            const ca = fs.readFileSync(caPath, 'utf8');
            return { ca: [ca], rejectUnauthorized: true };
        } catch (e) {
            console.error(`[kafka] failed to read KAFKA_SSL_CA at ${caPath}:`, e.message);
            // Fall through to boolean SSL rather than silently disabling TLS.
        }
    }
    return process.env.KAFKA_SSL === 'true';
}

// Build SASL/SSL options from env. SASL is only configured when a mechanism +
// username are present; SSL is on when KAFKA_SSL === 'true' (or a CA is given).
function clientOptions() {
    const opts = {
        clientId: process.env.KAFKA_CLIENT_ID || 'crmf-backend',
        brokers: BROKERS,
        ssl: sslOptions(),
        retry: { retries: 3 },
    };
    const mechanism = (process.env.KAFKA_SASL_MECHANISM || '').toLowerCase();
    const username = process.env.KAFKA_SASL_USERNAME;
    const password = process.env.KAFKA_SASL_PASSWORD;
    if (mechanism && username) {
        opts.sasl = { mechanism, username, password: password || '' };
    }
    return opts;
}

// Connect the producer. No-op (resolves) unless enabled and brokers are set.
// Safe to call during boot; failures are logged and swallowed.
async function start() {
    if (!ENABLED) return;
    if (!BROKERS.length) {
        console.warn('[kafka] KAFKA_ENABLED=true but KAFKA_BROKERS is empty — staying disabled');
        return;
    }
    if (ready || connecting) return connecting || undefined;
    connecting = (async () => {
        try {
            const { Kafka } = require('kafkajs'); // only required when enabled
            const kafka = new Kafka(clientOptions());
            producer = kafka.producer({ allowAutoTopicCreation: false });
            await producer.connect();
            ready = true;
            console.log(`[kafka] producer connected to ${BROKERS.join(',')}`);
        } catch (e) {
            ready = false;
            producer = null;
            console.error('[kafka] connect failed:', e.message);
        } finally {
            connecting = null;
        }
    })();
    return connecting;
}

async function send(topic, messages) {
    if (!ENABLED || !producer || !ready) return;
    try {
        await producer.send({ topic, messages });
    } catch (e) {
        // Never propagate into the ingest request path; count + log instead.
        metrics.incIngestError();
        console.error(`[kafka] publish to ${topic} failed:`, e.message);
    }
}

// Publish a whole ingested batch (telemetry channels) keyed by rig id. No-op
// unless enabled. Never throws.
async function publishBatch(rigId, batch) {
    if (!ENABLED || !ready || !rigId || !batch) return;
    const value = JSON.stringify({
        rigId,
        seq: batch.seq ?? null,
        schemaVersion: batch.schemaVersion ?? null,
        createdAt: batch.createdAt ?? null,
        channels: Array.isArray(batch.channels) ? batch.channels : [],
    });
    await send(TELEMETRY_TOPIC, [{ key: rigId, value }]);
}

// Publish a single event to topic "events.<type>" (e.g. events.alarm). No-op
// unless enabled. Never throws.
async function publishEvent(rigId, event) {
    if (!ENABLED || !ready || !rigId || !event || !event.type) return;
    const topic = EVENTS_TOPIC_PREFIX + String(event.type);
    const value = JSON.stringify({
        rigId,
        ts: event.ts ?? null,
        type: event.type,
        payload: event.payload ?? {},
    });
    await send(topic, [{ key: rigId, value }]);
}

// Graceful shutdown helper (best effort).
async function stop() {
    if (!producer) return;
    try { await producer.disconnect(); } catch { /* ignore */ }
    producer = null;
    ready = false;
}

module.exports = {
    start,
    stop,
    publishBatch,
    publishEvent,
    get enabled() { return ENABLED; },
};

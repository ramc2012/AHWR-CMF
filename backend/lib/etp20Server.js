'use strict';
// Built-in read-only ETP 2.0 server endpoint for external clients.
//
// Endpoint: ws://<central-host>:6000/etp (or wss:// behind TLS proxy)
// Subprotocol: energistics-tp
//
// This implements an app-side ETP transport and a pragmatic JSON command surface
// for integration testing and read-only telemetry exchange. It deliberately does
// not expose any write/control method back to rigs or PLCs.
const WebSocket = require('ws');
const fleet = require('./fleet');
const rigview = require('./rigview');
const { ingestBatch } = require('./ingest');
const { safeEqual } = require('./secrets');

let wss = null;
let config = {};
let attachedServer = null;
let upgradeHandler = null;
const clients = new Set();
const AHWR_FALLBACK_CHANNELS = new Map(Object.entries({
    1: 'mudpump.pressure',
    2: 'drawworks.block_position',
    3: 'drilling.wob',
    4: 'drawworks.hook_load',
    5: 'mudpump.spm',
    6: 'drilling.bit_depth',
    7: 'drilling.hole_depth',
}));
let status = {
    enabled: false,
    path: '/etp',
    state: 'disabled',
    clientCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    ingestCount: 0,
    ingestRejectedCount: 0,
    lastClientAt: null,
    lastMessageAt: null,
    lastIngestAt: null,
    lastIngestRig: null,
    lastIngestPoints: 0,
    lastMessageSummary: '',
    lastNoIngestReason: '',
    lastRowsPreview: '',
    lastIngestMetrics: [],
    lastError: '',
    protocol: 'ETP 2.0',
    subprotocol: 'energistics-tp',
};

function normalizePath(p) {
    const s = String(p || '/etp').trim();
    if (!s || s[0] !== '/') return '/etp';
    return s.slice(0, 80);
}

function publicConfig(c = config) {
    return {
        enabled: Boolean(c.etp20_server_enabled),
        path: normalizePath(c.etp20_server_path),
        tokenRequired: Boolean(c.etp20_server_token),
        readOnly: true,
    };
}

function setStatus(patch) {
    status = { ...status, ...patch, ...publicConfig(), clientCount: clients.size };
}

function requestUrl(req) {
    return new URL(req.url || '/', 'http://localhost');
}

function tokenFrom(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    const urlToken = requestUrl(req).searchParams.get('token');
    return urlToken || req.headers['x-device-token'] || req.headers['x-etp-token'] || req.headers['x-api-key'] || '';
}

function send(ws, messageType, body = {}) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ protocol: 'ETP', version: '2.0', messageType, ...body }));
}

function sendEnvelope(ws, protocol, messageType, body = {}, correlationId = 0) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
        header: { protocol, messageType, correlationId, messageId: Date.now(), messageFlags: 0 },
        body,
    }));
}

function arrayFrom(...candidates) {
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
        if (Array.isArray(c?.data)) return c.data;
        if (Array.isArray(c?.items)) return c.items;
        if (Array.isArray(c?.values)) return c.values;
        if (Array.isArray(c?.channels)) return c.channels;
        if (Array.isArray(c?.channelMetadata)) return c.channelMetadata;
        if (Array.isArray(c?.channelValues)) return c.channelValues;
    }
    return [];
}

function rememberMetadata(ws, body = {}) {
    const list = arrayFrom(body.channels, body.channelMetadata, body.metadata, body.data, body.channelData, body.channelValues);
    if (!Array.isArray(list)) return;
    ws.etpChannelMap = ws.etpChannelMap || new Map();
    for (const item of list) {
        const id = item.channelId ?? item.id ?? item.channelUri ?? item.uri ?? item.channel?.id ?? item.channel?.channelId;
        const name = item.metric || item.mnemonic || item.name || item.channelName || item.uri || item.channelUri || item.channel?.uri || item.channel?.name;
        if (id != null && name) ws.etpChannelMap.set(String(id), String(name));
    }
}

function valueFrom(item) {
    let v = item;
    for (let i = 0; i < 8; i += 1) {
        if (!v || typeof v !== 'object') return v;
        if (v.value != null) { v = v.value; continue; }
        if (v.dataValue != null) { v = v.dataValue; continue; }
        if (v.item != null) { v = v.item; continue; }
        if (v.valueItem != null) { v = v.valueItem; continue; }
        if (v.dataItem != null) { v = v.dataItem; continue; }
        if (v.scalar != null) { v = v.scalar; continue; }
        if (v.double != null) { v = v.double; continue; }
        if (v.float != null) { v = v.float; continue; }
        if (v.long != null) { v = v.long; continue; }
        if (v.integer != null) { v = v.integer; continue; }
        if (v.string != null) { v = v.string; continue; }
        if (v.text != null) { v = v.text; continue; }
        return null;
    }
    return null;
}

function normalizeMetricName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    if (raw.includes('.') && !raw.includes(' ')) return raw;
    const compact = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const aliases = {
        BPOS: 'drawworks.block_position',
        HKLD: 'drawworks.hook_load',
        WOB: 'drilling.wob',
        DMEA: 'drilling.hole_depth',
        SPPA: 'mudpump.pressure',
        DRAWWORKS_ROPE_WEAR: 'drawworks.rope_wear',
        AHWR_PDW_ACT_PRESSURE: 'hpu.pdw_pump_press',
        AHWR_PDW_CALIBARTION_STATUS_0_UNKNONE_1_ON_2_OFF_3_DISABLE: 'acs.calibration_status',
        AHWR_HTD_RPM_REQ: 'htd.rpm_req',
        AHWR_HTD_RPM_COMMAND: 'htd.rpm_cmd',
        AHWR_HTD_TORQUE_REQ: 'htd.torque_req',
        AHWR_HTD_TORQUE_COMMAND: 'htd.torque_cmd',
        AHWR_HTD_WORKING_HOURS: 'htd.working_hours',
        AHWR_HTD_WORKING_MINUTES: 'htd.working_minutes',
        AHWR_HTD_SUSPENSSION_STATUS_0_NONE_1_IN_PUSH_2_IN_PULL: 'htd.suspension',
        AHWR_HPU_WARM_UP_0_OFF_1_ON: 'hpu.warm_up',
        AHWR_HPU_COOLING1_0_OFF_1_ON: 'hpu.cooling_1',
        AHWR_ACS_OFFSET_OVERALL_IN_MM: 'acs.offset_overall',
        AHWR_CWK_CARRIER_ANGLE: 'cwk.carrier_angle',
        AHWR_CWK_KICKERS_SX_1_1_EXTEND_2_RETRACT_3_FAULT: 'cwk.kickers_sx',
        AHWR_PCT_CLAMP_LOW_0_NONE_1_OPENING_2_CLOSING_3_IS_OPEN_4_IS_CLO: 'pct.clamp_low_status',
    };
    if (aliases[compact]) return aliases[compact];
    const groups = [
        ['CAT_ENGINE_', 'cat_engine.'],
        ['WELL_CONTROL_', 'wellcontrol.'],
        ['WELLHEAD_', 'wellhead.'],
        ['DRAWWORKS_', 'drawworks.'],
        ['DRILLING_', 'drilling.'],
        ['MUDPUMP_', 'mudpump.'],
        ['FLUID_', 'fluid.'],
        ['SAFETY_', 'safety.'],
        ['HPU_', 'hpu.'],
        ['HTD_', 'htd.'],
        ['PCT_', 'pct.'],
        ['ACS_', 'acs.'],
        ['CWK_', 'cwk.'],
        ['AHWR_HPU_', 'hpu.'],
        ['AHWR_HTD_', 'htd.'],
        ['AHWR_PCT_', 'pct.'],
        ['AHWR_ACS_', 'acs.'],
        ['AHWR_CWK_', 'cwk.'],
    ];
    for (const [prefix, group] of groups) {
        if (compact.startsWith(prefix)) return group + compact.slice(prefix.length).toLowerCase();
    }
    if (compact.startsWith('AHWR_PCT_3D_DIAG_')) return 'pct.diag_' + compact.slice('AHWR_PCT_3D_DIAG_'.length).toLowerCase();
    return raw;
}
function metricFrom(ws, item) {
    const direct = item.metric || item.mnemonic || item.name || item.channelName || item.uri || item.channelUri;
    if (direct) return normalizeMetricName(direct);
    const id = item.channelId ?? item.id;
    if (id != null && ws.etpChannelMap?.has(String(id))) return normalizeMetricName(ws.etpChannelMap.get(String(id)));
    if (id != null && AHWR_FALLBACK_CHANNELS.has(String(id))) return AHWR_FALLBACK_CHANNELS.get(String(id));
    if (id != null) return 'etp.channel_' + id;
    return null;
}

function rigIdFromText(v) {
    const m = String(v || '').match(/AHWR-50-(?:III|VI|3|6)/i);
    if (!m) return '';
    const s = m[0].toUpperCase();
    if (s.endsWith('-III')) return 'AHWR-50-3';
    if (s.endsWith('-VI')) return 'AHWR-50-6';
    return s;
}

function rigIdFromMessage(ws, body = {}, msg = {}) {
    const direct = body.deviceId || body.rigId || msg.deviceId || msg.rigId || ws.etpDeviceId;
    if (direct) return normalizeMetricName(direct);
    const candidates = [
        body.clientInstanceId, body.applicationName, body.applicationVersion, body.dataspace,
        msg.clientInstanceId, msg.applicationName, msg.dataspace,
    ];
    for (const c of candidates) {
        const rig = rigIdFromText(c);
        if (rig) return rig;
    }
    const rows = arrayFrom(body.data, body.channelData, body.channelValues, body.dataItems, msg.data, msg.channelData, msg.channelValues);
    for (const row of rows) {
        const rig = rigIdFromText(metricFrom(ws, row) || row?.path || row?.uri || row?.channelUri || row?.name || '');
        if (rig) return rig;
    }
    return '';
}

function cleanText(v) {
    if (v == null || typeof v === 'object') return '';
    const s = String(v).trim();
    return s && s !== '--' ? s : '';
}

function isWellKey(key) {
    const s = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return ['well', 'wellid', 'wellname', 'wellbore', 'wellborename', 'job', 'jobname', 'activejob', 'currentwell', 'currentwellname'].includes(s)
        || s.endsWith('wellname')
        || s.endsWith('wellid')
        || s.endsWith('wellbore')
        || s.endsWith('wellborename')
        || s.endsWith('jobname')
        || s.includes('wellname')
        || s.includes('currentwell')
        || s.includes('activejob');
}

function pickWellName(ws, ...sources) {
    const keys = [
        'wellName', 'well_name', 'well.name', 'well', 'wellId', 'well_id',
        'currentWell', 'current_well', 'currentWellName', 'current_well_name',
        'wellboreName', 'wellbore_name', 'wellbore.name',
        'jobName', 'job_name', 'job.name', 'job', 'activeJob', 'active_job',
    ];
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        for (const key of keys) {
            const v = src[key];
            const text = cleanText(v);
            if (text) return text;
            if (v && typeof v === 'object') {
                const nested = pickWellName(ws, v);
                if (nested) return nested;
            }
        }
        const values = src.values;
        if (values && typeof values === 'object') {
            for (const key of keys) {
                const text = cleanText(values[key]);
                if (text) return text;
            }
        }
        for (const prop of ['data', 'channelData', 'channelValues', 'dataItems']) {
            if (!Array.isArray(src[prop])) continue;
            for (const row of src[prop]) {
                if (!row || typeof row !== 'object') continue;
                const direct = pickWellName(ws, row, row.values);
                if (direct) return direct;
                const metric = metricFrom(ws, row);
                if (isWellKey(metric)) {
                    const text = cleanText(valueFrom(row));
                    if (text) return text;
                }
            }
        }
        if (Array.isArray(src.channels)) {
            for (const ch of src.channels) {
                const v = pickWellName(ws, ch, ch?.values);
                if (v) return v;
            }
        }
    }
    return '';
}

function pickWellPayload(...sources) {
    const keys = ['well', 'activeWell', 'active_well', 'currentWell', 'current_well', 'wellManagement', 'well_management', 'wellRun', 'well_run'];
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        for (const key of keys) {
            const value = src[key];
            if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
        }
        const directName = src.wellName || src.well_name || src.currentWellName || src.current_well_name || src.name;
        if (directName && (src.service || src.serviceType || src.field || src.operator || src.startedAt || src.started_at)) return { ...src };
        if (src.values && typeof src.values === 'object') {
            const nested = pickWellPayload(src.values);
            if (nested) return nested;
        }
    }
    return null;
}

function eventListWithWellName(ws, body = {}, msg = {}) {
    const events = Array.isArray(body.events) ? [...body.events] : (Array.isArray(msg.events) ? [...msg.events] : []);
    const wellPayload = pickWellPayload(body, msg, msg.body, body.batch, msg.batch) || {};
    const wellName = pickWellName(ws, body, msg, msg.body, body.batch, msg.batch);
    if (wellName) {
        const ts = body.ts || msg.ts || new Date().toISOString();
        const alreadyStarted = events.some((ev) => ev && ev.type === 'well.started');
        events.push({ ts, type: 'activity', payload: { label: 'ACTIVE WELL', job: wellName, wellName, ...wellPayload } });
        if (!alreadyStarted) {
            events.push({ ts, type: 'well.started', payload: { wellId: wellName, name: wellName, status: 'active', ...wellPayload } });
        }
    }
    return events;
}
function summarizeMessage(msg) {
    const body = msg.body || msg || {};
    const header = msg.header || {};
    const rows = arrayFrom(body.data, body.channelData, body.channelValues, body.dataItems, msg.data, msg.channelData, msg.channelValues);
    return [
        header.protocol != null ? `p${header.protocol}` : '',
        header.messageType != null ? `mt${header.messageType}` : '',
        msg.messageType || msg.type || '',
        body.deviceId || body.rigId || msg.deviceId || msg.rigId || '',
        rows.length ? `rows:${rows.length}` : '',
        Array.isArray(body.channels) ? `channels:${body.channels.length}` : '',
        body.values ? 'values' : '',
    ].filter(Boolean).join(' ');
}
function normalizeBatch(ws, msg) {
    const body = msg.body || msg;
    const batch = body.batch || msg.batch;
    if (batch && (batch.deviceId || batch.rigId) && Array.isArray(batch.channels)) {
        return { ...batch, deviceId: batch.deviceId || batch.rigId, events: eventListWithWellName(ws, batch, msg) };
    }

    const rigId = rigIdFromMessage(ws, body, msg);
    if (!rigId) { setStatus({ lastNoIngestReason: 'no deviceId/rigId in last ETP message' }); return null; }

    if (Array.isArray(body.channels)) {
        return {
            seq: body.seq ?? msg.seq ?? Date.now(),
            deviceId: rigId,
            schemaVersion: body.schemaVersion || msg.schemaVersion || 'etp20-json',
            createdAt: body.createdAt || msg.createdAt || new Date().toISOString(),
            channels: body.channels,
            events: eventListWithWellName(ws, body, msg),
        };
    }

    const values = body.values || msg.values;
    if (values && typeof values === 'object') {
        return {
            seq: body.seq ?? msg.seq ?? Date.now(),
            deviceId: rigId,
            schemaVersion: body.schemaVersion || msg.schemaVersion || 'etp20-json',
            createdAt: body.createdAt || msg.createdAt || new Date().toISOString(),
            channels: [{ ts: body.ts || msg.ts || new Date().toISOString(), values }],
            events: eventListWithWellName(ws, body, msg),
        };
    }

    const rows = arrayFrom(body.data, body.channelData, body.channelValues, body.dataItems, msg.data, msg.channelData, msg.channelValues);
    if (!Array.isArray(rows) || !rows.length) { setStatus({ lastNoIngestReason: 'no channel rows in last ETP message' }); return null; }
    const byTs = new Map();
    for (const item of rows) {
        if (!item || typeof item !== 'object') continue;
        const metric = metricFrom(ws, item);
        if (!metric) continue;
        const n = Number(valueFrom(item));
        if (!Number.isFinite(n)) continue;
        const indexTs = Array.isArray(item.indexes) && item.indexes.length ? Number(item.indexes[0]) : null;
        const ts = item.ts || item.time || item.timestamp || (Number.isFinite(indexTs) ? new Date(indexTs).toISOString() : null) || body.ts || msg.ts || new Date().toISOString();
        if (!byTs.has(ts)) byTs.set(ts, {});
        byTs.get(ts)[metric] = n;
    }
    const channels = Array.from(byTs.entries()).map(([ts, vals]) => ({ ts, values: vals }));
    if (!channels.length) { setStatus({ lastNoIngestReason: 'no numeric mapped rows (' + rows.length + ' rows received)', lastRowsPreview: JSON.stringify(rows.slice(0, 8)).slice(0, 1800) }); return null; }
    return {
        seq: body.seq ?? msg.seq ?? Date.now(),
        deviceId: rigId,
        schemaVersion: body.schemaVersion || msg.schemaVersion || 'etp20-channelstreaming',
        createdAt: body.createdAt || msg.createdAt || new Date().toISOString(),
        channels,
        events: eventListWithWellName(ws, body, msg),
    };
}

async function ingestEtpMessage(ws, msg) {
    const batch = normalizeBatch(ws, msg);
    if (!batch) return false;
    // Pass through the token the CLIENT actually presented on the WS upgrade.
    // Previously this substituted the server's own INGEST_TOKEN, which made
    // ingest.authorize() short-circuit to true for every batch — any client that
    // cleared the upgrade gate could then write telemetry as ANY rigId, including
    // rigs with their own provisioned device_token. Per-rig credentials only mean
    // something if the presented token is the one that gets checked.
    const effectiveToken = ws.etpToken || '';
    const result = await ingestBatch({ rigId: batch.deviceId, token: effectiveToken, schemaVersion: batch.schemaVersion }, batch);
    if (!result.ok) {
        status.ingestRejectedCount += 1;
        setStatus({ lastError: `ETP ingest rejected for ${batch.deviceId || 'unknown'}: ${result.error || result.code}` });
        send(ws, 'IngestRejected', { rigId: batch.deviceId, error: result.error || 'rejected' });
        return true;
    }
    status.ingestCount += 1;
    const metrics = [];
    for (const snap of batch.channels || []) {
        for (const metric of Object.keys(snap.values || {})) {
            if (!metrics.includes(metric)) metrics.push(metric);
        }
    }
    setStatus({
        lastIngestAt: new Date().toISOString(),
        lastIngestRig: result.rigId,
        lastIngestPoints: result.points || 0,
        lastIngestMetrics: metrics.slice(0, 240),
        lastError: '',
    });
    send(ws, 'IngestAck', { rigId: result.rigId, seq: result.seq, receivedPoints: result.points || 0 });
    return true;
}

async function handleMessage(ws, raw) {
    setStatus({ lastMessageAt: new Date().toISOString(), lastError: '' });
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, 'ProtocolException', { error: 'JSON message expected by this ETP server adapter' }); return; }

    setStatus({ lastMessageSummary: summarizeMessage(msg) });
    const messageRigId = rigIdFromMessage(ws, msg.body || msg, msg);
    if (messageRigId) ws.etpDeviceId = messageRigId;

    if (msg.header && Number(msg.header.protocol) === 1 && Number(msg.header.messageType) === 1) {
        rememberMetadata(ws, msg.body || {});
        return;
    }
    rememberMetadata(ws, msg.body || msg || {});

    if (await ingestEtpMessage(ws, msg)) return;

    // Compatibility with the AHWR edge ETP publisher. It sends a compact ETP-style
    // envelope: Core/RequestSession = protocol 0, messageType 1. Reply with
    // Core/OpenSession = protocol 0, messageType 2 so the edge starts streaming.
    if (msg.header && Number(msg.header.protocol) === 0 && Number(msg.header.messageType) === 1) {
        sendEnvelope(ws, 0, 2, {
            applicationName: 'AHWR Digital Twin Central',
            applicationVersion: '1.0.0',
            sessionId: 'central-etp-session',
            supportedProtocols: [{ protocol: 1, protocolVersion: { major: 1, minor: 1 }, role: 'consumer' }],
            supportedFormats: ['application/x-etp-message+json'],
        }, Number(msg.header.messageId || 0));
        return;
    }
    if (msg.header && Number(msg.header.protocol) === 1) {
        const mt = Number(msg.header.messageType);
        if (mt === 1) { rememberMetadata(ws, msg.body || {}); return; }
        if ([2, 3, 4].includes(mt)) { await ingestEtpMessage(ws, msg); return; }
    }

    const type = String(msg.messageType || msg.type || '').toLowerCase();
    try {
        if (!type || type === 'requestsession') {
            send(ws, 'OpenSession', {
                applicationName: 'AHWR Digital Twin Central',
                applicationVersion: '1.0.0',
                supportedProtocols: ['Core', 'Discovery', 'Store', 'StoreNotification', 'ChannelStreaming'],
                readOnly: true,
            });
            return;
        }
        if (type === 'ping') { send(ws, 'Pong', { t: Date.now() }); return; }
        if (type === 'getcapabilities') {
            send(ws, 'Capabilities', {
                endpoint: publicConfig().path,
                readOnly: true,
                commands: ['GetCapabilities', 'GetRigs', 'GetFleet', 'GetRigLive', 'SubscribeRigLive'],
            });
            return;
        }
        if (type === 'getrigs' || type === 'getfleet') {
            send(ws, 'Fleet', { rigs: await fleet.getFleet() });
            return;
        }
        if (type === 'getriglive' || type === 'getrig') {
            const rigId = msg.rigId || msg.uri || msg.objectId;
            if (!rigId) { send(ws, 'ProtocolException', { error: 'rigId is required' }); return; }
            send(ws, 'RigLive', { rigId, data: await rigview.reconstruct(rigId) });
            return;
        }
        if (type === 'subscriberiglive') {
            const rigId = msg.rigId || msg.uri || msg.objectId || '*';
            ws.etpSubscriptions = ws.etpSubscriptions || new Set();
            ws.etpSubscriptions.add(rigId);
            send(ws, 'SubscriptionAck', { rigId });
            return;
        }
        send(ws, 'ProtocolException', { error: `Unsupported messageType: ${msg.messageType || msg.type || 'unknown'}` });
    } catch (e) {
        setStatus({ lastError: e.message });
        send(ws, 'ProtocolException', { error: e.message });
    }
}

function attach(server, nextConfig = {}) {
    config = { ...(nextConfig || {}) };
    if (wss) {
        try { wss.close(); } catch { /* ignore */ }
        clients.clear();
        wss = null;
    }
    if (attachedServer && upgradeHandler) {
        try { attachedServer.off('upgrade', upgradeHandler); } catch { /* ignore */ }
    }
    attachedServer = null;
    upgradeHandler = null;
    if (!config.etp20_server_enabled) {
        setStatus({ state: 'disabled' });
        return getStatus();
    }

    const path = normalizePath(config.etp20_server_path);
    wss = new WebSocket.Server({ noServer: true });
    upgradeHandler = (req, socket, head) => {
        try {
            const url = requestUrl(req);
            if (url.pathname !== path && url.pathname !== '/') return;
            // No baked-in default: a published fallback token is equivalent to an
            // open endpoint. Fail closed when nothing is configured.
            const expected = String(config.etp20_server_token || process.env.INGEST_TOKEN || '');
            const token = tokenFrom(req);
            if (!expected || !token || !safeEqual(token, expected)) {
                status.rejectedCount += 1;
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                // Record exactly what the client presented — ingestEtpMessage
                // forwards this to ingest.authorize(), so it must not be
                // back-filled with a server-side secret.
                ws.etpToken = token;
                ws.etpDeviceId = url.searchParams.get('deviceId') || url.searchParams.get('rigId') || req.headers['x-device-id'] || req.headers['x-rig-id'] || '';
                if (url.pathname === '/') setStatus({ lastMessageSummary: 'Accepted ETP client on / alias; preferred path is /etp' });
                wss.emit('connection', ws, req);
            });
        } catch (e) {
            setStatus({ lastError: e.message });
            try { socket.destroy(); } catch { /* ignore */ }
        }
    };
    server.on('upgrade', upgradeHandler);
    attachedServer = server;

    wss.on('connection', (ws) => {
        clients.add(ws);
        status.acceptedCount += 1;
        setStatus({ state: 'listening', lastClientAt: new Date().toISOString(), lastError: '' });
        send(ws, 'ServerReady', { endpoint: path, readOnly: true });
        ws.on('message', (raw) => handleMessage(ws, raw));
        ws.on('close', () => { clients.delete(ws); setStatus({ state: config.etp20_server_enabled ? 'listening' : 'disabled' }); });
        ws.on('error', (e) => setStatus({ lastError: e.message }));
    });
    setStatus({ state: 'listening', lastError: '' });
    return getStatus();
}

function broadcastRigLive(rigId, data) {
    for (const ws of clients) {
        const subs = ws.etpSubscriptions;
        if (!subs || (!subs.has('*') && !subs.has(rigId))) continue;
        send(ws, 'RigLiveUpdate', { rigId, data });
    }
}

function getStatus() {
    return { ...status, ...publicConfig(), clientCount: clients.size };
}

module.exports = { attach, getStatus, broadcastRigLive };

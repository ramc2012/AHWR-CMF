'use strict';
// Energistics Transfer Protocol 2.0 connector service.
//
// This module owns the central app's ETP transport lifecycle. It opens a
// monitoring-only WebSocket session to an ETP-capable server, keeps status for
// the Settings page, supports explicit connect/disconnect/test calls, and emits
// a conservative JSON RequestSession if the server accepts JSON framing. Many
// production ETP servers use Energistics Avro binary message framing; those
// object-specific Protocol handlers can be added here without touching UI/API.
const { URL } = require('url');
const WebSocket = require('ws');

const DEFAULT_STATUS = {
    enabled: false,
    configured: false,
    state: 'disabled', // disabled | disconnected | connecting | connected | error
    endpoint: '',
    dataspace: '',
    readOnly: true,
    authType: 'none',
    sslVerify: true,
    lastConnectAt: null,
    lastDisconnectAt: null,
    lastError: '',
    lastMessageAt: null,
    reconnects: 0,
    protocol: 'ETP 2.0',
    subprotocol: 'energistics-tp',
};

let config = null;
let ws = null;
let status = { ...DEFAULT_STATUS };
let reconnectTimer = null;
let manualDisconnect = false;
let pingTimer = null;

function publicConfig(c = config) {
    return {
        enabled: Boolean(c?.etp20_enabled),
        configured: Boolean(c?.etp20_endpoint),
        endpoint: c?.etp20_endpoint || '',
        dataspace: c?.etp20_dataspace || '',
        readOnly: c?.etp20_read_only !== false,
        authType: c?.etp20_auth_type || 'none',
        sslVerify: c?.etp20_ssl_verify !== false,
    };
}

function setStatus(patch) {
    status = { ...status, ...patch, ...publicConfig() };
}

function closeSocket() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
    }
}

function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
}

function buildEndpoint(c) {
    const raw = String(c?.etp20_endpoint || '').trim();
    if (!raw) throw new Error('ETP 2.0 endpoint is required');
    const u = new URL(raw);
    if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('ETP 2.0 endpoint must start with ws:// or wss://');
    if (c.etp20_auth_type === 'basic' && c.etp20_username) {
        u.username = encodeURIComponent(c.etp20_username);
        u.password = encodeURIComponent(c.etp20_password || '');
    }
    return u.toString();
}

function socketOptions(c) {
    const headers = {};
    if (c.etp20_auth_type === 'bearer' && c.etp20_bearer_token) {
        headers.Authorization = `Bearer ${c.etp20_bearer_token}`;
    }
    return {
        protocol: 'energistics-tp',
        handshakeTimeout: Math.max(1, Number(c.etp20_timeout_sec) || 15) * 1000,
        rejectUnauthorized: c.etp20_ssl_verify !== false,
        headers,
    };
}

function requestSessionMessage(c) {
    return JSON.stringify({
        protocol: 'ETP',
        version: '2.0',
        messageType: 'RequestSession',
        applicationName: 'AHWR Digital Twin Central',
        applicationVersion: '1.0.0',
        requestedProtocols: [
            'Core',
            'Discovery',
            'Store',
            'StoreNotification',
            'DataArray',
            'ChannelStreaming',
        ],
        supportedObjects: [
            `eml${String(c.etp20_witsml_version || '2.1').replace('.', '')}`,
            `witsml${String(c.etp20_witsml_version || '2.1').replace('.', '')}`,
        ],
        dataspace: c.etp20_dataspace || undefined,
        readOnly: c.etp20_read_only !== false,
    });
}

function scheduleReconnect() {
    clearReconnect();
    if (manualDisconnect || !config?.etp20_enabled) return;
    const delay = Math.max(1, Number(config.etp20_reconnect_sec) || 5) * 1000;
    reconnectTimer = setTimeout(() => {
        setStatus({ reconnects: status.reconnects + 1 });
        connect().catch(() => {});
    }, delay);
}

async function configure(nextConfig) {
    config = { ...(nextConfig || {}) };
    setStatus({ state: config.etp20_enabled ? 'disconnected' : 'disabled', lastError: '' });
    if (!config.etp20_enabled) {
        manualDisconnect = true;
        clearReconnect();
        closeSocket();
        return getStatus();
    }
    manualDisconnect = false;
    if (config.etp20_endpoint) connect().catch(() => {});
    return getStatus();
}

async function connect(overrideConfig) {
    if (overrideConfig) config = { ...(overrideConfig || {}) };
    if (!config?.etp20_enabled) throw new Error('ETP 2.0 is disabled');
    const endpoint = buildEndpoint(config);
    if (typeof WebSocket === 'undefined') throw new Error('Node WebSocket runtime is unavailable');

    manualDisconnect = false;
    clearReconnect();
    closeSocket();
    setStatus({ state: 'connecting', lastError: '' });

    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutMs = Math.max(1, Number(config.etp20_timeout_sec) || 15) * 1000;
        const timeout = setTimeout(() => {
            const err = new Error('ETP 2.0 connection timed out');
            setStatus({ state: 'error', lastError: err.message });
            closeSocket();
            if (!settled) { settled = true; reject(err); }
            scheduleReconnect();
        }, timeoutMs);

        try {
            ws = new WebSocket(endpoint, 'energistics-tp', socketOptions(config));
        } catch (e) {
            clearTimeout(timeout);
            setStatus({ state: 'error', lastError: e.message });
            scheduleReconnect();
            reject(e);
            return;
        }

        ws.addEventListener('open', () => {
            clearTimeout(timeout);
            setStatus({ state: 'connected', lastConnectAt: new Date().toISOString(), lastError: '' });
            try { ws.send(requestSessionMessage(config)); } catch { /* binary-only ETP servers may ignore JSON */ }
            pingTimer = setInterval(() => {
                try {
                    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ protocol: 'ETP', messageType: 'Ping', t: Date.now() }));
                } catch { /* ignore */ }
            }, 30_000);
            if (!settled) { settled = true; resolve(getStatus()); }
        });

        ws.addEventListener('message', () => setStatus({ lastMessageAt: new Date().toISOString() }));
        ws.addEventListener('error', (ev) => {
            const msg = ev?.message || ev?.error?.message || 'ETP 2.0 socket error';
            setStatus({ state: 'error', lastError: msg });
            if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(msg)); }
        });
        ws.addEventListener('close', () => {
            clearTimeout(timeout);
            const wasManual = manualDisconnect;
            closeSocket();
            setStatus({ state: wasManual || !config?.etp20_enabled ? 'disconnected' : 'error', lastDisconnectAt: new Date().toISOString() });
            if (!settled) { settled = true; resolve(getStatus()); }
            if (!wasManual) scheduleReconnect();
        });
    });
}

async function disconnect() {
    manualDisconnect = true;
    clearReconnect();
    closeSocket();
    setStatus({ state: 'disconnected', lastDisconnectAt: new Date().toISOString() });
    return getStatus();
}

async function test(testConfig) {
    const previous = config;
    const previousWs = ws;
    const testCfg = { ...(previous || {}), ...(testConfig || {}), etp20_enabled: true };
    const endpoint = buildEndpoint(testCfg);
    if (typeof WebSocket === 'undefined') throw new Error('Node WebSocket runtime is unavailable');
    return new Promise((resolve, reject) => {
        let sock;
        const timeout = setTimeout(() => {
            try { sock?.close(); } catch { /* ignore */ }
            reject(new Error('ETP 2.0 test timed out'));
        }, Math.max(1, Number(testCfg.etp20_timeout_sec) || 15) * 1000);
        try { sock = new WebSocket(endpoint, 'energistics-tp', socketOptions(testCfg)); }
        catch (e) { clearTimeout(timeout); reject(e); return; }
        sock.addEventListener('open', () => {
            clearTimeout(timeout);
            try { sock.send(requestSessionMessage(testCfg)); } catch { /* ignore */ }
            setTimeout(() => { try { sock.close(); } catch { /* ignore */ } }, 250);
            resolve({ ok: true, endpoint: testCfg.etp20_endpoint, message: 'ETP 2.0 WebSocket opened successfully.' });
        });
        sock.addEventListener('error', (ev) => {
            clearTimeout(timeout);
            reject(new Error(ev?.message || ev?.error?.message || 'ETP 2.0 test failed'));
        });
        // Preserve active service globals.
        ws = previousWs;
        config = previous;
    });
}

function getStatus() {
    return { ...status, ...publicConfig() };
}

module.exports = { configure, connect, disconnect, test, getStatus };



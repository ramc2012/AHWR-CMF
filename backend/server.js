'use strict';
// =====================================================================
// CRMF — Centralised Rig Monitoring Facility — backend
// Ingestion endpoint (edge store-and-forward) + fleet portal API + live updates.
//
// MONITORING-ONLY: telemetry/control remains read-only. The only outbound rig
// path is an operator message notification to the Edge UI; it never writes PLC.
//
// API VERSIONING (audit #30): the fleet API is mounted at BOTH /api (the
// existing, unversioned default — kept working) and /api/v1 (the versioned alias
// external integrators should target). Both prefixes share the exact same
// handlers; bump to /api/v2 alongside /api when a breaking change lands.
// =====================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const { waitForDb, query, pool } = require('./lib/db');
const { seedAll } = require('./lib/seed');
const auth = require('./lib/auth');
const ldap = require('./lib/ldap');
const fleet = require('./lib/fleet');
const gov = require('./lib/governance');
const maint = require('./lib/maintenance');
const users = require('./lib/users');
const audit = require('./lib/audit');
const { ingestBatch } = require('./lib/ingest');
const { TAGS } = require('./lib/tags');
const metrics = require('./lib/metrics');
const kafka = require('./lib/kafka');
const notify = require('./lib/notify');
const rigview = require('./lib/rigview');
const wells = require('./lib/wells');
const activity = require('./lib/activity');
const settings = require('./lib/settings');
const etp20 = require('./lib/etp20');
const etp20Server = require('./lib/etp20Server');
const presence = require('./lib/presence');
const messages = require('./lib/messages');

const PORT = Number(process.env.PORT || 6000);
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false'; // default ON
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';           // optional bearer guard (#15)
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 10_000);

// --------------------------------------------------------------------
// CORS allowlist (audit #16): default CLOSED. Only origins in CORS_ORIGIN
// (comma-separated) are allowed. In dev (NODE_ENV !== 'production') a missing
// CORS_ORIGIN falls back to reflecting localhost origins only — never '|| true'.
// --------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production';
const CORS_ALLOWLIST = (process.env.CORS_ORIGIN || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
    // Non-browser clients (no Origin header) are always allowed (e.g. the edge,
    // curl, server-to-server). The allowlist only constrains browser origins.
    if (!origin) return true;
    if (CORS_ALLOWLIST.length) return CORS_ALLOWLIST.includes(origin);
    if (!IS_PROD) return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return false; // prod with no allowlist => closed
}

function localIpv4Addresses() {
    const out = [];
    for (const entries of Object.values(os.networkInterfaces() || {})) {
        for (const net of entries || []) {
            if (net && net.family === 'IPv4' && !net.internal) out.push(net.address);
        }
    }
    return [...new Set(out)];
}

function preferredHostFromRequest(req) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().split(':')[0];
    if (host && !['localhost', '127.0.0.1', '::1'].includes(host)) return host;
    return localIpv4Addresses()[0] || host || 'localhost';
}
const corsOptions = {
    origin(origin, cb) {
        if (isAllowedOrigin(origin)) return cb(null, true);
        return cb(null, false); // deny without throwing (no CORS headers added)
    },
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors(corsOptions));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin(origin, cb) { cb(null, isAllowedOrigin(origin)); },
    },
});
io.use(auth.socketAuth);
io.on('connection', (socket) => {
    if (socket.clientType === 'edge' && socket.edgeRigId) {
        const rigRoom = `edge:${socket.edgeRigId}`;
        socket.join(rigRoom);
        console.log(`[messages] edge connected: ${socket.edgeRigId}`);
        messages.pendingForRig(socket.edgeRigId)
            .then((rows) => { if (rows.length) socket.emit('central_messages:batch', rows); })
            .catch((e) => console.warn('[messages] pending delivery failed:', e.message));

        // Both handlers reply through the optional Socket.IO ack callback so the
        // edge learns whether its update actually landed. Without it the edge can
        // only guess from socket.connected, which stays true for up to a ping
        // timeout after the link drops — so an ack emitted into that window is
        // silently lost, and the edge can never tell. The callback is optional:
        // older edges that emit without one still work unchanged.
        socket.on('edge_message_delivered', async (payload = {}, cb) => {
            try {
                const row = await messages.markDelivered(payload.messageId, socket.edgeRigId);
                if (row) io.emit('rig_message_update', row);
                if (typeof cb === 'function') cb({ ok: Boolean(row), messageId: payload.messageId, status: row && row.status });
            } catch (e) {
                console.warn('[messages] delivery ack failed:', e.message);
                if (typeof cb === 'function') cb({ ok: false, error: e.message });
            }
        });

        socket.on('edge_message_ack', async (payload = {}, cb) => {
            try {
                const row = await messages.acknowledge(payload.messageId, socket.edgeRigId, payload.acknowledgedBy);
                if (row) io.emit('rig_message_update', row);
                if (typeof cb === 'function') cb({ ok: Boolean(row), messageId: payload.messageId, status: row && row.status });
            } catch (e) {
                console.warn('[messages] acknowledge failed:', e.message);
                if (typeof cb === 'function') cb({ ok: false, error: e.message });
            }
        });
        return;
    }
    fleet.getFleetSummary().then((s) => socket.emit('fleet_summary', s)).catch(() => {});
});

function emitRigMessage(row) {
    if (!row) return;
    io.to(`edge:${row.targetRigId}`).emit('central_message', row);
    io.emit('rig_message_update', row);
}

// --------------------------------------------------------------------
// INGEST — accepts gzipped store-and-forward batches from the edge sync agent.
// Body is read raw (optionally gzip) and parsed here; same contract as the edge
// publisher in backend/lib/sync.js. Generous limit + lenient rate limit (rigs only).
// --------------------------------------------------------------------
const ingestLimiter = rateLimit({ windowMs: 60_000, max: 6000, standardHeaders: true, legacyHeaders: false });

// body-parser auto-inflates Content-Encoding: gzip (the edge sets it). The magic-byte
// fallback covers any client whose body still arrives gzipped.
app.post('/ingest', ingestLimiter, express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const elapsedSec = () => Number(process.hrtime.bigint() - startedAt) / 1e9;
    try {
        let buf = req.body;
        if (Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            try { buf = zlib.gunzipSync(buf); } catch { metrics.observeIngest({ ok: false, durationSec: elapsedSec() }); return res.status(400).json({ error: 'bad gzip' }); }
        }
        let batch;
        try { batch = JSON.parse(buf.toString('utf8')); } catch { metrics.observeIngest({ ok: false, durationSec: elapsedSec() }); return res.status(400).json({ error: 'bad json' }); }

        const rigId = batch.deviceId || req.headers['x-device-id'] || null;
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        const schemaVersion = req.headers['x-schema-version'] || batch.schemaVersion;

        const result = await ingestBatch({ rigId, token, schemaVersion }, batch);
        if (!result.ok) {
            metrics.observeIngest({ ok: false, durationSec: elapsedSec() });
            // Never echo raw PG errors to the untrusted caller (audit #11); log
            // full detail server-side. result.error is already a generic message.
            if (result.code === 500 && result.detail) {
                console.error('[ingest] server error:', result.detail);
            }
            return res.status(result.code || 400).json({ error: result.error });
        }

        metrics.observeIngest({ ok: true, durationSec: elapsedSec(), points: result.points, events: result.events });

        // Well-run tracking now happens INSIDE the ingest transaction
        // (ingest.js -> wells.trackRunInTxn, under the rigs row lock). The
        // fire-and-forget wells.trackRun(...) that used to run here locked
        // wells/well_runs in the opposite order to the ingest transaction and
        // overlapped it for the same rig — the primary 40P01 deadlock — and its
        // detached view of active_job could flip-flop runs between wells.

        // Fan out to Kafka (no-op unless KAFKA_ENABLED; never throws into this path).
        kafka.publishBatch(result.rigId, batch);
        if (Array.isArray(batch.events)) {
            for (const ev of batch.events) kafka.publishEvent(result.rigId, ev);
        }

        // Push a live fleet delta to portal clients (best effort), and dispatch any
        // rising-edge alarm notification (webhook/email; no-op unless NOTIFY_ENABLED).
        fleet.getFleetRow(result.rigId).then((row) => {
            if (row) io.emit('fleet_update', row);
            rigview.reconstruct(result.rigId).then((live) => {
                if (live) {
                    io.emit('rig_live', { rigId: result.rigId, data: live });
                    etp20Server.broadcastRigLive(result.rigId, live);
                }
            }).catch(() => {});
            if (result.alarmTransition) {
                notify.maybeNotify(result.rigId, result.alarmTransition,
                    { name: row && row.name, field: row && row.field });
            }
        }).catch(() => {
            if (result.alarmTransition) notify.maybeNotify(result.rigId, result.alarmTransition, {});
        });
        if (Array.isArray(batch.events) && batch.events.some((e) => e && e.type === 'alarm')) {
            io.emit('alarm_update', { rigId: result.rigId });
        }

        // receivedPoints is what the database ACTUALLY stored (insert rowCount),
        // not what the batch carried — reporting attempted-as-stored hid silent
        // loss. The attempted count rides alongside for the edge's accounting.
        res.json({ ack: true, seq: result.seq, receivedPoints: result.points, receivedPointsAttempted: result.pointsAttempted, receivedEvents: result.events, duplicate: result.duplicate || undefined });
    } catch (e) {
        metrics.observeIngest({ ok: false, durationSec: elapsedSec() });
        console.error('[ingest] unexpected error:', e.message);
        res.status(500).json({ error: 'ingest failed' });
    }
});

// --------------------------------------------------------------------
// Metrics (Prometheus) — default ON; disable with METRICS_ENABLED=false.
// Guarded by METRICS_TOKEN when set (audit #15): a configured token is required
// as a bearer; with no token configured it stays open (document: scrape
// internally in K8s via a ServiceMonitor, never on the public ingress).
// --------------------------------------------------------------------
if (METRICS_ENABLED) {
    app.get('/metrics', async (req, res) => {
        if (METRICS_TOKEN) {
            const hdr = req.headers.authorization || '';
            const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
            if (tok !== METRICS_TOKEN) return res.status(401).end('unauthorized');
        }
        try {
            res.setHeader('Content-Type', metrics.registry.contentType);
            res.end(await metrics.registry.metrics());
        } catch (e) {
            res.status(500).end(e.message);
        }
    });
}

// --------------------------------------------------------------------
// Health / liveness split (audit #10)
//   /livez  -> process liveness, NO DB call (Kubernetes livenessProbe)
//   /healthz-> readiness, SELECT 1   (Kubernetes readinessProbe)
// --------------------------------------------------------------------
app.get('/livez', (_req, res) => res.json({ ok: true }));
app.get('/healthz', async (_req, res) => {
    try { await query('SELECT 1'); res.json({ ok: true, service: 'crmf-backend' }); }
    catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// --------------------------------------------------------------------
// OpenAPI document (audit #30) — auth-exempt, served from the static file.
// --------------------------------------------------------------------
let OPENAPI_DOC = null;
try {
    OPENAPI_DOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'openapi.json'), 'utf8'));
} catch (e) {
    console.error('[openapi] failed to load openapi.json:', e.message);
}
const serveOpenapi = (_req, res) => {
    if (!OPENAPI_DOC) return res.status(500).json({ error: 'openapi document unavailable' });
    res.json(OPENAPI_DOC);
};
app.get('/api/openapi.json', serveOpenapi);
app.get('/api/v1/openapi.json', serveOpenapi);

// --------------------------------------------------------------------
// Auth (proposal §6.5)
// --------------------------------------------------------------------
const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false });
// Stricter, dedicated limiter on login (audit #13): cap brute-force attempts.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

const jsonBody = express.json({ limit: '1mb' });

// Build the shared API router. Mounted at both /api and /api/v1 (audit #30).
function buildApiRouter() {
    const r = express.Router();
    r.use(apiLimiter, jsonBody);

    // ----- Auth (auth-exempt: login + me handle their own auth) -----
    // Tells the login UI which providers are available (local / LDAP / both).
    r.get('/auth/info', (_req, res) => res.json(ldap.info()));
    r.post('/auth/login', loginLimiter, async (req, res) => {
        const { username, password } = req.body || {};
        const result = await auth.login(username, password);
        if (!result) {
            // Audit failed logins (audit #14). Log the attempt; never the password.
            await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                [username || 'unknown', 'login.failed', 'portal', { ip: req.ip }]).catch(() => {});
            console.warn(`[auth] failed login for "${username || 'unknown'}" from ${req.ip}`);
            return res.status(401).json({ error: 'invalid credentials' });
        }
        await query('INSERT INTO audit_log (actor, action, target) VALUES ($1,$2,$3)',
            [username, 'login', 'portal']).catch(() => {});
        res.json(result);
    });
    r.get('/auth/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

    // ----- Everything below requires auth -----
    r.use(auth.requireAuth);

    // User liveness (proposal §6.5): every authed request refreshes the caller's
    // session row. Fire-and-forget — presence is best-effort and never blocks or
    // fails the request (touch swallows its own errors).
    r.use((req, _res, next) => { presence.touch(req.user, req.ip); next(); });

    // wrap honours e.status (audit #24) instead of always 500.
    const wrap = (fn) => async (req, res) => {
        try { res.json(await fn(req)); }
        catch (e) {
            const status = e.status || 500;
            if (status >= 500) console.error('[api] error:', e.message);
            res.status(status).json({ error: e.message });
        }
    };

    // A unique, unguessable per-rig ingest credential. 256 bits of CSPRNG output:
    // these are bearer tokens for telemetry writes, so they must not be derived
    // from the rig id or shared across the fleet.
    const newDeviceToken = () => crypto.randomBytes(32).toString('hex');

    // requireRole that also audits 403 denials (audit #14).
    const requireRoleAudited = (min) => (req, res, next) => {
        if (!req.user || !auth.roleMeets(req.user.role, min)) {
            query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                [req.user?.username || 'unknown', 'rbac.denied', `${req.method} ${req.originalUrl}`, { required: min }]).catch(() => {});
            return res.status(403).json({ error: 'forbidden' });
        }
        next();
    };

    // ----- Fleet -----
    r.get('/fleet', wrap(() => fleet.getFleet()));
    r.get('/fleet/summary', wrap(() => fleet.getFleetSummary()));
    r.get('/rigs/:id', wrap(async (req) => {
        const rig = await fleet.getRig(req.params.id);
        if (!rig) throw Object.assign(new Error('rig not found'), { status: 404 });
        return rig;
    }));
    r.get('/rigs/:id/history', wrap((req) =>
        fleet.getHistory(req.params.id, req.query.metric, req.query.minutes)));
    // Per-rig remote HMI mirror (proposal §6.1 rig drill-down): edge-shape live
    // payload, multi-metric history strips, and per-rig alarm history. Read-only.
    r.get('/rigs/:id/live', wrap(async (req) => {
        const v = await rigview.reconstruct(req.params.id);
        if (!v) throw Object.assign(new Error('rig not found'), { status: 404 });
        return v;
    }));
    // history-multi: trailing-window (minutes) OR explicit range (from/to epoch ms,
    // for OFFLINE EDR past-run replay). Range wins when both from & to are present.
    r.get('/rigs/:id/history-multi', wrap((req) => {
        const fromMs = Number(req.query.from);
        const toMs = Number(req.query.to);
        if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
            return rigview.multiHistory(req.params.id, req.query.metrics, { fromMs, toMs, maxPoints: req.query.maxPoints });
        }
        return rigview.multiHistory(req.params.id, req.query.metrics, { minutes: req.query.minutes, maxPoints: req.query.maxPoints });
    }));
    r.get('/rigs/:id/alarms', wrap((req) =>
        rigview.rigAlarms(req.params.id, req.query.limit)));
    // Per-rig ACTIVITY timeline (proposal §6.1 — mirrors the edge ActivityPage):
    // reconstructs the day's phase segments + productive/NPT split for the
    // width-proportional activity bar. Read-only, default 24h window.
    r.get('/rigs/:id/activity', wrap((req) =>
        activity.getActivity(req.params.id, Number(req.query.hours) || 24)));
    // CMMS mirror for one rig (asset health, PM, work orders, maintenance log,
    // downtime/NPT, instruments, run hours) as last snapshotted by that edge.
    r.get('/rigs/:id/cmms', wrap(async (req) => {
        const { rows } = await query(
            'SELECT snapshot, generated_at, received_at FROM rig_cmms WHERE rig_id = $1',
            [req.params.id]);
        if (!rows.length) return { available: false, rigId: req.params.id };
        return {
            available: true, rigId: req.params.id,
            generatedAt: rows[0].generated_at, receivedAt: rows[0].received_at,
            ...(rows[0].snapshot || {}),
        };
    }));
    r.get('/rigs/:id/messages', wrap((req) => messages.list(req.params.id, req.query.limit)));
    // Fleet-wide message feed for the Fleet Overview message centre (authenticated
    // like every /api route; listAll caps the limit at 500 server-side).
    r.get('/messages', wrap((req) => messages.listAll(req.query.limit)));
    r.post('/rigs/:id/messages', requireRoleAudited('operator'), wrap(async (req) => {
        const row = await messages.create(req.params.id, req.body, req.user);
        emitRigMessage(row);
        return row;
    }));
    r.post('/rigs/:id/messages/:messageId/retry', requireRoleAudited('operator'), wrap(async (req) => {
        const row = await messages.retry(req.params.messageId, req.params.id);
        emitRigMessage(row);
        return row;
    }));
    r.get('/alarms', wrap((req) => fleet.getAlarms({ priority: req.query.priority })));
    r.get('/data-quality', wrap(() => fleet.getDataQuality()));
    r.get('/workover', wrap((req) => gov.getWorkover({ hours: req.query.hours })));

    // ----- Well management (WITSML-inspired; proposal §6.1 well drill-down) -----
    // A WELL is a first-class lifecycle entity; a WELL_RUN links telemetry to a
    // well over a time window so per-well stored data (incl. PAST runs for offline
    // EDR replay) is queryable by well. List/detail/runs are auth; CRUD is admin +
    // audited. MONITORING-ONLY: nothing here writes to a rig/PLC.
    r.get('/wells', wrap((req) => wells.getWells({
        assetUnit: req.query.assetUnit, status: req.query.status, q: req.query.q })));
    r.get('/wells/:id', wrap((req) => wells.getWell(req.params.id)));
    r.get('/wells/:id/runs', wrap((req) => wells.getRuns(req.params.id)));
    r.post('/wells', requireRoleAudited('admin'),
        wrap((req) => wells.addWell(req.body, req.user.username)));
    r.patch('/wells/:id', requireRoleAudited('admin'),
        wrap((req) => wells.updateWell(req.params.id, req.body, req.user.username)));
    r.delete('/wells/:id', requireRoleAudited('admin'),
        wrap((req) => wells.deleteWell(req.params.id, req.user.username)));

    // ----- Rig registry CRUD (proposal §6.2 rig master, admin-only, audited) -----
    // MONITORING-ONLY: this manages the central rig REGISTRY (who we expect data
    // from); it never writes to a rig/PLC. A new rig starts at stage-gate 'gate0'
    // with status 'pending' until its edge first reports in.
    r.post('/rigs', requireRoleAudited('admin'), wrap(async (req) => {
        const b = req.body || {};
        const rigId = String(b.rigId || '').trim();
        const name = String(b.name || '').trim();
        if (!rigId || !/^[A-Za-z0-9._-]{2,64}$/.test(rigId)) {
            throw Object.assign(new Error('rigId is required (2-64 chars: letters, digits, . _ -)'), { status: 400 });
        }
        if (!name || name.length > 120) {
            throw Object.assign(new Error('name is required (1-120 chars)'), { status: 400 });
        }
        const lat = b.latitude == null || b.latitude === '' ? null : Number(b.latitude);
        const lon = b.longitude == null || b.longitude === '' ? null : Number(b.longitude);
        if (lat != null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
            throw Object.assign(new Error('latitude must be between -90 and 90'), { status: 400 });
        }
        if (lon != null && (!Number.isFinite(lon) || lon < -180 || lon > 180)) {
            throw Object.assign(new Error('longitude must be between -180 and 180'), { status: 400 });
        }
        const dup = await query('SELECT 1 FROM rigs WHERE rig_id = $1', [rigId]);
        if (dup.rows.length) throw Object.assign(new Error('rig already exists'), { status: 409 });
        // Issue a UNIQUE per-rig credential. A single fleet-wide token means one
        // leaked rig node can impersonate any of the other 49 and inject telemetry
        // under their identity; per-rig tokens keep a compromise contained to one
        // rig and make rotation meaningful. Unprovisioned rigs can still onboard
        // against the fleet-wide INGEST_TOKEN fallback in ingest.authorize().
        const deviceToken = newDeviceToken();
        await query(
            `INSERT INTO rigs (rig_id, name, section, asset_unit, field, latitude, longitude, device_token, status, schema_version)
             VALUES ($1,$2,'Workover Services',$3,$4,$5,$6,$7,'pending','1.0')`,
            [rigId, name, b.assetUnit || null, b.field || null, lat, lon, deviceToken]);
        // Start its rollout at gate0 so it shows up in the governance workspace.
        await query(
            `INSERT INTO deployment_status (rig_id, gate, commissioning)
             VALUES ($1,'gate0','planned') ON CONFLICT (rig_id) DO NOTHING`, [rigId]);
        await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
            [req.user.username, 'rig.create', rigId, { name, assetUnit: b.assetUnit || null, field: b.field || null }]).catch(() => {});

        // Reveal the device token ONCE to the creating admin so it can be set as
        // DEVICE_TOKEN on the rig's edge node. It is not exposed again by the API.
        return { ...(await fleet.getRig(rigId)), device_token: deviceToken };
    }));
    r.delete('/rigs/:id', requireRoleAudited('admin'), wrap(async (req) => {
        const rigId = req.params.id;
        const { rowCount } = await query('DELETE FROM rigs WHERE rig_id = $1', [rigId]);
        if (!rowCount) throw Object.assign(new Error('rig not found'), { status: 404 });
        await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
            [req.user.username, 'rig.delete', rigId, {}]).catch(() => {});
        return { ok: true };
    }));
    // Issue a NEW random credential for one rig. Admin-only + audited. Previously
    // this re-applied the same fleet-wide constant, so "rotate" invalidated nothing
    // and gave false assurance after a suspected leak.
    r.post('/rigs/:id/rotate-token', requireRoleAudited('admin'), wrap(async (req) => {
        const rigId = req.params.id;
        const deviceToken = newDeviceToken();
        const { rowCount } = await query('UPDATE rigs SET device_token = $1 WHERE rig_id = $2', [deviceToken, rigId]);
        if (!rowCount) throw Object.assign(new Error('rig not found'), { status: 404 });
        await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
            [req.user.username, 'rig.rotate_token', rigId, { rotated: true }]).catch(() => {});
        // Shown once; the edge node must be updated with this DEVICE_TOKEN.
        return { device_token: deviceToken };
    }));

    r.get('/network/urls', wrap((req) => {
        const host = process.env.CENTRAL_HOST || preferredHostFromRequest(req);
        const webPort = process.env.FRONTEND_PORT || '8090';
        const ingestPort = process.env.INGEST_PORT || String(PORT);
        const urls = {
            host,
            addresses: localIpv4Addresses(),
            webUrl: `http://${host}:${webPort}`,
            ingestUrl: `http://${host}:${ingestPort}`,
            etpUrl: `ws://${host}:${ingestPort}/etp`,
        };
        // The fleet-wide ingest token is a write credential for the whole fleet:
        // anyone holding it can inject telemetry as any rig. This route is only
        // behind requireAuth, so it previously handed that secret to every signed-in
        // VIEWER. Admins only, and per-rig tokens are preferred over this anyway.
        if (auth.roleMeets(req.user && req.user.role, 'admin') && process.env.INGEST_TOKEN) {
            urls.token = process.env.INGEST_TOKEN;
            urls.etpUrlWithToken =
                `ws://${host}:${ingestPort}/etp?token=${encodeURIComponent(process.env.INGEST_TOKEN)}`;
        }
        return urls;
    }));
    // ----- Platform settings (proposal section 6.5) - read (auth), write (admin, audited) -----
    r.get('/settings', wrap(() => settings.getSettings()));
    r.patch('/settings', requireRoleAudited('admin'),
        wrap(async (req) => {
            const updated = await settings.setSettings(req.body, req.user.username);
            if (Object.keys(req.body || {}).some((k) => k.startsWith('etp20_'))) {
                const full = await settings.getSettings({ revealSecrets: true });
                await etp20.configure(full);
                etp20Server.attach(server, full);
            }
            return updated;
        }));

    // ----- Energistics Transfer Protocol 2.0 connector -------------------------
    r.get('/integrations/etp20/status', wrap(() => ({ client: etp20.getStatus(), server: etp20Server.getStatus() })));
    r.get('/integrations/etp20/server/status', wrap(() => etp20Server.getStatus()));
    r.post('/integrations/etp20/connect', requireRoleAudited('admin'), wrap(async () => {
        const full = await settings.getSettings({ revealSecrets: true });
        return etp20.connect(full);
    }));
    r.post('/integrations/etp20/disconnect', requireRoleAudited('admin'), wrap(() => etp20.disconnect()));
    r.post('/integrations/etp20/test', requireRoleAudited('admin'), wrap(async (req) => {
        const full = await settings.getSettings({ revealSecrets: true });
        return etp20.test({ ...full, ...(req.body || {}) });
    }));

    // ----- User presence / liveness (proposal §6.5) -----
    r.get('/presence', wrap(() => presence.list()));
    r.post('/presence/ping', wrap(async (req) => { await presence.touch(req.user, req.ip); return { ok: true }; }));

    // ----- Governance & rollout workspace -----
    r.get('/governance', wrap(() => gov.getGovernance()));
    r.patch('/governance/deployment/:rigId', requireRoleAudited('operator'),
        wrap((req) => gov.updateDeployment(req.params.rigId, req.body, req.user.username)));
    r.post('/governance/escalations', requireRoleAudited('operator'),
        wrap((req) => gov.addEscalation(req.body, req.user.username)));
    r.patch('/governance/escalations/:id', requireRoleAudited('operator'),
        wrap((req) => gov.updateEscalation(req.params.id, req.body, req.user.username)));
    r.post('/governance/decisions', requireRoleAudited('operator'),
        wrap((req) => gov.addDecision(req.body, req.user.username)));

    // ----- Maintenance & Reliability (audit #7) -----
    r.get('/maintenance', wrap((req) =>
        maint.listMaintenance({ rigId: req.query.rigId, status: req.query.status })));
    r.get('/maintenance/summary', wrap(() => maint.maintenanceSummary()));

    // Rig-wise daily maintenance/NPT rollup for the Maintenance & Reliability page.
    // - log:        maintenance-log entries for the most recent day that HAS entries
    // - nptPrevDay: NPT minutes for the previous calendar day
    // - nptFy:      cumulative NPT minutes for the Indian financial year (1 Apr - 31 Mar)
    // Sourced from rig_downtime / rig_maint_log, which accumulate the point-in-time
    // CMMS snapshots each edge ships (rig_cmms holds only the latest).
    r.get('/maintenance/fleet-daily', wrap(async (req) => {
        const tz = String(req.query.tz || 'Asia/Kolkata');
        const { rows } = await query(
            `WITH fy AS (
                 SELECT CASE WHEN EXTRACT(MONTH FROM now() AT TIME ZONE $1) >= 4
                             THEN make_date(EXTRACT(YEAR  FROM now() AT TIME ZONE $1)::int, 4, 1)
                             ELSE make_date(EXTRACT(YEAR  FROM now() AT TIME ZONE $1)::int - 1, 4, 1)
                        END AS start_date
             ),
             npt AS (
                 SELECT d.rig_id,
                        COALESCE(SUM(d.duration_min) FILTER (
                            WHERE (d.start_ts AT TIME ZONE $1)::date = ((now() AT TIME ZONE $1)::date - 1)), 0) AS npt_prev_day_min,
                        COALESCE(SUM(d.duration_min) FILTER (
                            WHERE (d.start_ts AT TIME ZONE $1)::date >= (SELECT start_date FROM fy)), 0) AS npt_fy_min,
                        COUNT(*) FILTER (WHERE d.end_ts IS NULL) AS npt_open
                   FROM rig_downtime d GROUP BY d.rig_id
             ),
             lastday AS (
                 SELECT rig_id, MAX((at_ts AT TIME ZONE $1)::date) AS d
                   FROM rig_maint_log WHERE at_ts IS NOT NULL GROUP BY rig_id
             )
             SELECT r.rig_id, r.name, r.status, r.asset_unit, r.field,
                    COALESCE(n.npt_prev_day_min, 0) AS npt_prev_day_min,
                    COALESCE(n.npt_fy_min, 0)       AS npt_fy_min,
                    COALESCE(n.npt_open, 0)         AS npt_open,
                    ld.d                            AS log_date,
                    COALESCE((
                        SELECT json_agg(json_build_object(
                                   'at', m.at_ts, 'asset', COALESCE(m.asset, m.asset_id),
                                   'text', m.text, 'by', m.by_who, 'shift', m.shift,
                                   'notificationNo', m.notification_no, 'category', m.category)
                                 ORDER BY m.at_ts DESC)
                          FROM rig_maint_log m
                         WHERE m.rig_id = r.rig_id
                           AND COALESCE(m.log_type, '') <> 'OPERATIONS'
                           AND (m.at_ts AT TIME ZONE $1)::date = ld.d
                    ), '[]'::json) AS log
               FROM rigs r
               LEFT JOIN npt     n  ON n.rig_id  = r.rig_id
               LEFT JOIN lastday ld ON ld.rig_id = r.rig_id
              ORDER BY r.rig_id`, [tz]);
        const fmt = (v) => Number(Number(v || 0).toFixed(1));
        return {
            timezone: tz,
            financialYearStart: new Date().getMonth() + 1 >= 4
                ? `${new Date().getFullYear()}-04-01`
                : `${new Date().getFullYear() - 1}-04-01`,
            rigs: rows.map((r) => ({
                rigId: r.rig_id, name: r.name, status: r.status,
                assetUnit: r.asset_unit, field: r.field,
                logDate: r.log_date, log: r.log || [],
                nptPrevDayMin: fmt(r.npt_prev_day_min),
                nptFyMin: fmt(r.npt_fy_min),
                nptFyHours: fmt(Number(r.npt_fy_min || 0) / 60),
                nptOpen: Number(r.npt_open || 0),
            })),
        };
    }));
    r.post('/maintenance', requireRoleAudited('operator'),
        wrap((req) => maint.addMaintenance(req.body, req.user.username)));
    r.patch('/maintenance/:id', requireRoleAudited('operator'),
        wrap((req) => maint.updateMaintenance(req.params.id, req.body, req.user.username)));

    // ----- User & Access Management (audit #8, admin-only) -----
    r.get('/users', requireRoleAudited('admin'), wrap(() => users.listUsers()));
    r.post('/users', requireRoleAudited('admin'),
        wrap((req) => users.createUser(req.body, req.user.username)));
    r.patch('/users/:username', requireRoleAudited('admin'),
        wrap((req) => users.updateUser(req.params.username, req.body, req.user.username)));
    r.delete('/users/:username', requireRoleAudited('admin'),
        wrap((req) => users.deleteUser(req.params.username, req.user.username)));

    // ----- Audit trail (audit #2, admin-only, paginated) -----
    r.get('/audit', requireRoleAudited('admin'), wrap((req) =>
        audit.listAudit({
            limit: req.query.limit, offset: req.query.offset,
            action: req.query.action, actor: req.query.actor,
        })));

    // ----- Alarm notifications (webhook/email; proposal §6.1 escalation) -----
    r.get('/notifications', wrap((req) => notify.getNotifications(req.query.limit)));
    r.get('/notifications/channels', wrap(() => notify.getChannels()));
    r.post('/notifications/channels', requireRoleAudited('admin'),
        wrap((req) => notify.addChannel(req.body, req.user.username)));
    r.patch('/notifications/channels/:id', requireRoleAudited('admin'),
        wrap((req) => notify.updateChannel(req.params.id, req.body, req.user.username)));
    r.delete('/notifications/channels/:id', requireRoleAudited('admin'),
        wrap((req) => notify.deleteChannel(req.params.id, req.user.username)));
    r.post('/notifications/channels/:id/test', requireRoleAudited('admin'),
        wrap((req) => notify.sendTest(req.params.id, req.user.username)));

    // ----- Config registry (proposal §6.1) -----
    r.get('/config/tags', wrap(() => TAGS));
    r.get('/config/rigs', wrap(async () => (await query(
        `SELECT rig_id, name, section, asset_unit AS "assetUnit", field, latitude, longitude,
                commissioned_at, schema_version, (device_token IS NOT NULL) AS "hasToken"
         FROM rigs ORDER BY rig_id`)).rows));

    // ----- Reporting (proposal §6.1) — JSON (period-aware, audit #29) + CSV -----
    r.get('/reports/fleet', wrap((req) => gov.getFleetReportPeriod(req.query.period)));
    r.get('/reports/fleet.csv', async (req, res) => {
        try {
            // Period-aware export (audit #29 / finding #3): match the JSON report's window
            // instead of always emitting the snapshot. Columns are derived from the row
            // shape since snapshot vs daily/weekly/monthly rows carry different fields.
            const { period, rows } = await gov.getFleetReportPeriod(req.query.period);
            const cols = rows.length ? Object.keys(rows[0]) : ['rig_id'];
            const csv = [cols.join(',')].concat(rows.map((row) => cols.map((c) => {
                const v = row[c] == null ? '' : String(row[c]).replace(/"/g, '""');
                return /[",\n]/.test(v) ? `"${v}"` : v;
            }).join(','))).join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="crmf-fleet-report-${period || 'snapshot'}.csv"`);
            res.send(csv);
        } catch (e) { console.error('[reports] csv error:', e.message); res.status(500).json({ error: 'report failed' }); }
    });

    return r;
}

// Mount the same router at the unversioned default and the versioned alias.
app.use('/api/v1', buildApiRouter());
app.use('/api', buildApiRouter());

// --------------------------------------------------------------------
// Boot + graceful shutdown (audit #9)
// --------------------------------------------------------------------
let summaryTimer = null;
let sweepTimer = null;
let shuttingDown = false;

async function main() {
    await waitForDb();
    await seedAll();
    // Seed platform settings defaults (retention/update-rate/offline/latency) and
    // sync the live offline threshold from whatever is persisted (proposal §6.5).
    await settings.seedDefaults();
    const fullSettings = await settings.getSettings({ revealSecrets: true });
    await etp20.configure(fullSettings).catch((e) => console.warn('[etp20] startup skipped:', e.message));
    etp20Server.attach(server, fullSettings);

    // Offline sweeper: flip rigs to offline once their data ages out, push deltas.
    sweepTimer = setInterval(async () => {
        try {
            const flipped = await fleet.sweepOffline();
            for (const id of flipped) {
                const row = await fleet.getFleetRow(id);
                if (row) io.emit('fleet_update', row);
            }
            if (flipped.length) io.emit('fleet_summary', await fleet.getFleetSummary());
        } catch (e) { /* ignore */ }
    }, 15_000);

    // Periodic summary heartbeat so KPI cards stay live even on a quiet fleet.
    // Also mirror the summary into the Prometheus fleet gauges.
    summaryTimer = setInterval(async () => {
        try {
            const summary = await fleet.getFleetSummary();
            io.emit('fleet_summary', summary);
            metrics.setFleetGauges(summary);
        } catch { /* ignore */ }
    }, 10_000);

    // Bring up the optional Kafka producer (no-op unless KAFKA_ENABLED=true).
    await kafka.start().catch((e) => console.error('[kafka] start error:', e.message));

    server.listen(PORT, () => console.log(`CRMF backend listening on :${PORT} (monitoring-only)`));
}

// Graceful shutdown (audit #9): stop timers, drain HTTP, close sockets, flush
// Kafka, end the pg pool, then exit. Bounded by a drain timeout.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, draining…`);

    if (sweepTimer) clearInterval(sweepTimer);
    if (summaryTimer) clearInterval(summaryTimer);

    const drainTimer = setTimeout(() => {
        console.error('[shutdown] drain timeout exceeded, forcing exit');
        process.exit(1);
    }, SHUTDOWN_DRAIN_MS);
    drainTimer.unref();

    try {
        await new Promise((resolve) => server.close(resolve)); // stop accepting new connections
        try { io.close(); } catch { /* ignore */ }
        await kafka.stop().catch(() => {});
        await pool.end().catch(() => {});
        clearTimeout(drainTimer);
        console.log('[shutdown] clean exit');
        process.exit(0);
    } catch (e) {
        console.error('[shutdown] error during drain:', e.message);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

main().catch((e) => { console.error('CRMF backend failed to start:', e); process.exit(1); });




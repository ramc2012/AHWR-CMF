'use strict';
// Alarm notification dispatcher (proposal §6.1 alarm command centre — escalation;
// closes the "alarm notifications (email/SMS/webhook)" fleet gap).
//
// Fires OUTBOUND alerts when a rig's alarm state crosses a rising edge (a new P1,
// a clear->active transition, or an escalation), to configured channels:
//   - webhook  : POST JSON to a URL (Slack/Teams/PagerDuty/enterprise/SMS-gateway)
//   - email    : SMTP via nodemailer (lazy-required; only when SMTP_* is configured)
//
// MONITORING-ONLY: this only SENDS alerts about data already received from rigs; it
// never sends anything toward a rig/PLC. Dispatch is fire-and-forget and never
// throws into the ingest path. Default OFF (NOTIFY_ENABLED!=='true').
const http = require('http');
const https = require('https');
const { query } = require('./db');

const ENABLED = process.env.NOTIFY_ENABLED === 'true';
const RANK = { P3: 1, P2: 2, P1: 3 };
const MIN_RANK = RANK[(process.env.NOTIFY_MIN_SEVERITY || 'P1').toUpperCase()] || RANK.P1;
const COOLDOWN_SEC = Number(process.env.NOTIFY_COOLDOWN_SEC || 300);

const lastSentMs = new Map();   // `${rigId}|${severity}` -> epoch ms (cooldown)
let mailer = null, mailerTried = false;

// Lazy SMTP transport (only built when email is actually used + configured).
function getMailer() {
    if (mailer || mailerTried) return mailer;
    mailerTried = true;
    if (!process.env.SMTP_HOST) return null;
    try {
        const nodemailer = require('nodemailer'); // optional dep; only loaded on demand
        mailer = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
        });
    } catch (e) {
        console.error('[notify] email disabled — nodemailer/SMTP unavailable:', e.message);
        mailer = null;
    }
    return mailer;
}

// Decide whether a transition warrants a notification, and at what severity/kind.
// Returns { severity, kind } or null.
function classify(prev, next) {
    const p = prev || {}, n = next || {};
    const nextRank = RANK[n.highest] || 0;
    const prevRank = RANK[p.highest] || 0;
    if (!n.active || nextRank === 0) return null;                 // cleared / no active alarm
    if ((n.p1 || 0) > (p.p1 || 0)) return { severity: 'P1', kind: 'raised' };   // new P1 (ESD/lockout/well-control)
    if ((p.active || 0) === 0 && (n.active || 0) > 0) return { severity: n.highest, kind: 'raised' };
    if (nextRank > prevRank) return { severity: n.highest, kind: 'escalated' };  // P2 -> P1 etc.
    return null;
}

function postWebhook(url, body) {
    return new Promise((resolve) => {
        let u; try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const data = Buffer.from(JSON.stringify(body));
        const req = lib.request(u, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
            timeout: 6000,
        }, (res) => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }); });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.end(data);
    });
}

async function sendEmail(to, subject, text) {
    const m = getMailer();
    if (!m) return { ok: false, error: 'smtp not configured' };
    try {
        await m.sendMail({ from: process.env.SMTP_FROM || 'crmf@ongc.local', to, subject, text });
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

async function logNotification(row) {
    try {
        await query(
            `INSERT INTO notifications (rig_id, severity, kind, channel_type, channel_target, status, error, payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [row.rigId, row.severity, row.kind, row.channelType, row.channelTarget, row.status, row.error || null, row.payload || {}]);
    } catch { /* never block on the audit/log path */ }
}

async function enabledChannelsFor(rank) {
    const { rows } = await query(
        `SELECT type, name, target, min_severity FROM notification_channels WHERE enabled = true`);
    return rows.filter((c) => (RANK[c.min_severity] || RANK.P1) <= rank);
}

async function dispatch(channel, payload) {
    if (channel.type === 'webhook') return postWebhook(channel.target, payload);
    if (channel.type === 'email') {
        const subj = `[CRMF ${payload.severity}] ${payload.name}: alarm ${payload.kind}`;
        const text = `Rig ${payload.name} (${payload.rigId}) — ${payload.severity} ${payload.kind}.\n` +
            `Active alarms: ${payload.active} (P1: ${payload.p1}). Field: ${payload.field || '—'}. At ${payload.ts}.`;
        return sendEmail(channel.target, subj, text);
    }
    return { ok: false, error: 'unknown channel type' };
}

// Main entry — called post-commit by the caller with the ingest alarm transition.
// Non-blocking and never throws.
async function maybeNotify(rigId, transition, meta = {}) {
    if (!ENABLED || !transition) return;
    const cls = classify(transition.prev, transition.next);
    if (!cls) return;
    const rank = RANK[cls.severity] || 0;
    if (rank < MIN_RANK) return;

    const key = `${rigId}|${cls.severity}`;
    const now = Date.now();
    const last = lastSentMs.get(key) || 0;
    if (now - last < COOLDOWN_SEC * 1000) return;   // throttle repeats
    lastSentMs.set(key, now);

    try {
        const channels = await enabledChannelsFor(rank);
        if (!channels.length) return;
        const payload = {
            rigId, name: meta.name || rigId, field: meta.field || null,
            severity: cls.severity, kind: cls.kind,
            active: transition.next.active, p1: transition.next.p1,
            highest: transition.next.highest, ts: new Date(now).toISOString(),
            message: `${meta.name || rigId}: ${cls.severity} alarm ${cls.kind}`,
        };
        for (const ch of channels) {
            const r = await dispatch(ch, payload);
            await logNotification({
                rigId, severity: cls.severity, kind: cls.kind,
                channelType: ch.type, channelTarget: ch.target,
                status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || `HTTP ${r.status}`),
                payload,
            });
            await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
                ['notify', 'notification.dispatch', rigId,
                 { severity: cls.severity, kind: cls.kind, channel: ch.type, ok: r.ok }]).catch(() => {});
        }
    } catch (e) {
        console.error('[notify] dispatch error:', e.message);
    }
}

// ----- admin/API surface -----
async function getChannels() {
    const { rows } = await query('SELECT * FROM notification_channels ORDER BY id');
    return rows;
}
async function addChannel({ type, name, target, min_severity = 'P1', enabled = true }, actor) {
    if (!['webhook', 'email'].includes(type)) throw Object.assign(new Error('type must be webhook|email'), { status: 400 });
    if (!target) throw Object.assign(new Error('target required'), { status: 400 });
    const sev = RANK[String(min_severity).toUpperCase()] ? String(min_severity).toUpperCase() : 'P1';
    const { rows } = await query(
        `INSERT INTO notification_channels (type, name, target, min_severity, enabled)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [type, name || type, target, sev, enabled !== false]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'notification.channel.add', String(rows[0].id), { type, target }]).catch(() => {});
    return rows[0];
}
async function updateChannel(id, patch, actor) {
    const allow = ['name', 'target', 'min_severity', 'enabled'];
    const sets = [], vals = [id];
    for (const k of allow) if (k in (patch || {})) { sets.push(`${k} = $${vals.length + 1}`); vals.push(patch[k]); }
    if (!sets.length) return null;
    await query(`UPDATE notification_channels SET ${sets.join(', ')} WHERE id = $1`, vals);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'notification.channel.update', String(id), patch]).catch(() => {});
    const { rows } = await query('SELECT * FROM notification_channels WHERE id = $1', [id]);
    return rows[0];
}
async function deleteChannel(id, actor) {
    await query('DELETE FROM notification_channels WHERE id = $1', [id]);
    await query('INSERT INTO audit_log (actor, action, target) VALUES ($1,$2,$3)',
        [actor || 'system', 'notification.channel.delete', String(id)]).catch(() => {});
    return { ok: true };
}
async function getNotifications(limit = 100) {
    const { rows } = await query(
        'SELECT * FROM notifications ORDER BY ts DESC LIMIT $1', [Math.min(Number(limit) || 100, 500)]);
    return rows;
}
// Fire a synthetic test notification through one channel (admin-triggered).
async function sendTest(channelId, actor) {
    const { rows } = await query('SELECT * FROM notification_channels WHERE id = $1', [channelId]);
    const ch = rows[0];
    if (!ch) throw Object.assign(new Error('channel not found'), { status: 404 });
    const payload = {
        rigId: 'TEST', name: 'CRMF self-test', field: 'Ankleshwar', severity: 'P1', kind: 'test',
        active: 1, p1: 1, highest: 'P1', ts: new Date().toISOString(), message: 'CRMF notification self-test',
    };
    const r = await dispatch(ch, payload);
    await logNotification({ rigId: 'TEST', severity: 'P1', kind: 'test', channelType: ch.type,
        channelTarget: ch.target, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : (r.error || `HTTP ${r.status}`), payload });
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'notification.test', String(channelId), { ok: r.ok }]).catch(() => {});
    return { ok: r.ok, error: r.ok ? null : (r.error || `HTTP ${r.status}`) };
}

module.exports = {
    maybeNotify, getChannels, addChannel, updateChannel, deleteChannel,
    getNotifications, sendTest, get enabled() { return ENABLED; },
};

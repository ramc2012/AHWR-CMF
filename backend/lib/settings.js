'use strict';
// Configurable platform settings (proposal §6.5): storage retention, telemetry
// update rate, offline threshold, central latency target, and external integration
// connector configuration. Persisted in app_settings (key/value JSONB), falling back
// to compiled defaults. Mutations are admin-only at the route layer, audit-logged
// here, and APPLIED live where possible.
const { query } = require('./db');
const fleet = require('./fleet');

const DEFAULTS = {
    retention_days: 1825,
    update_rate_sec: 5,
    offline_sec: 120,
    central_latency_target: 30,

    etp20_enabled: false,
    etp20_endpoint: '',
    etp20_dataspace: '',
    etp20_auth_type: 'none',
    etp20_username: '',
    etp20_password: '',
    etp20_bearer_token: '',
    etp20_witsml_version: '2.1',
    etp20_timeout_sec: 15,
    etp20_reconnect_sec: 5,
    etp20_ssl_verify: true,
    etp20_read_only: true,
    etp20_server_enabled: true,
    etp20_server_path: '/etp',
    // No baked-in default: a published token would leave the ETP endpoint
    // effectively open. Empty + no INGEST_TOKEN => the upgrade gate fails
    // closed (per-rig device tokens still work; see etp20Server).
    etp20_server_token: process.env.INGEST_TOKEN || '',
};
const BOUNDS = {
    retention_days: [1, 36500],
    update_rate_sec: [1, 3600],
    offline_sec: [10, 86400],
    central_latency_target: [1, 3600],
    etp20_timeout_sec: [1, 300],
    etp20_reconnect_sec: [1, 3600],
};
const STRING_LIMITS = {
    etp20_endpoint: 512,
    etp20_dataspace: 128,
    etp20_auth_type: 32,
    etp20_username: 128,
    etp20_password: 256,
    etp20_bearer_token: 2048,
    etp20_witsml_version: 16,
    etp20_server_path: 80,
    etp20_server_token: 256,
};const BOOL_KEYS = new Set(['etp20_enabled', 'etp20_ssl_verify', 'etp20_read_only', 'etp20_server_enabled']);
const AUTH_TYPES = new Set(['none', 'basic', 'bearer']);
const KEY = 'platform';

function clampInt(name, v, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    const [lo, hi] = BOUNDS[name];
    return Math.min(Math.max(n, lo), hi);
}

function normalizeSetting(name, value, fallback) {
    if (Object.prototype.hasOwnProperty.call(BOUNDS, name)) return clampInt(name, value, fallback);
    if (BOOL_KEYS.has(name)) return Boolean(value);
    if (Object.prototype.hasOwnProperty.call(STRING_LIMITS, name)) {
        const trimmed = String(value ?? '').trim().slice(0, STRING_LIMITS[name]);
        if (name === 'etp20_auth_type') return AUTH_TYPES.has(trimmed) ? trimmed : fallback;
        return trimmed;
    }
    return fallback;
}

function redactSensitive(out) {
    return {
        ...out,
        etp20_password: out.etp20_password ? '********' : '',
        etp20_bearer_token: out.etp20_bearer_token ? '********' : '',
        etp20_server_token: out.etp20_server_token ? '********' : '',
    };
}

async function getSettings({ revealSecrets = false } = {}) {
    let stored = {};
    try {
        const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
        if (rows[0] && rows[0].value && typeof rows[0].value === 'object') stored = rows[0].value;
    } catch { /* DB not ready -> defaults */ }
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (stored[k] != null) out[k] = normalizeSetting(k, stored[k], DEFAULTS[k]);
    }
    return revealSecrets ? out : redactSensitive(out);
}

async function applyRetention(days) {
    const interval = `${days} days`;
    for (const tbl of ['telemetry', 'events', 'connections']) {
        try {
            await query('SELECT remove_retention_policy($1, if_not_exists => true)', [tbl]);
            await query('SELECT add_retention_policy($1, ($2)::interval, if_not_exists => false)', [tbl, interval]);
        } catch (e) {
            console.warn(`[settings] retention policy on ${tbl} not applied: ${e.message}`);
        }
    }
}

async function setSettings(patch, actor) {
    const p = patch || {};
    const current = await getSettings({ revealSecrets: true });
    const next = { ...current };
    const changed = {};

    for (const k of Object.keys(DEFAULTS)) {
        if (k in p && p[k] != null) {
            // Masked secrets from the UI mean keep the current secret unchanged.
            if ((k === 'etp20_password' || k === 'etp20_bearer_token' || k === 'etp20_server_token') && String(p[k]) === '********') continue;
            const v = normalizeSetting(k, p[k], current[k]);
            if (JSON.stringify(v) !== JSON.stringify(current[k])) changed[k] = k.includes('password') || k.includes('token') ? '********' : v;
            next[k] = v;
        }
    }

    await query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [KEY, JSON.stringify(next), actor || 'system']);

    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'settings.update', KEY, changed]).catch(() => {});

    if ('retention_days' in changed) await applyRetention(next.retention_days);
    if ('offline_sec' in changed && typeof fleet.setOfflineSec === 'function') fleet.setOfflineSec(next.offline_sec);

    return redactSensitive(next);
}

async function seedDefaults() {
    try {
        await query(
            `INSERT INTO app_settings (key, value, updated_by)
             VALUES ($1, $2::jsonb, 'system')
             ON CONFLICT (key) DO NOTHING`,
            [KEY, JSON.stringify(DEFAULTS)]);
        // Backfill ONLY keys that are absent from the stored row (added in
        // later versions). The previous unconditional merge force-overwrote
        // etp20_server_token with the env/hardcoded value at EVERY boot,
        // silently clobbering an admin-set token.
        await query(
            `UPDATE app_settings
                SET value = $2::jsonb || value, updated_by = updated_by, updated_at = updated_at
              WHERE key = $1 AND NOT value ?& $3::text[]`,
            [KEY, JSON.stringify({
                etp20_server_enabled: true,
                etp20_server_path: '/etp',
                etp20_server_token: process.env.INGEST_TOKEN || '',
            }), ['etp20_server_enabled', 'etp20_server_path', 'etp20_server_token']]);
        const s = await getSettings({ revealSecrets: true });
        if (typeof fleet.setOfflineSec === 'function') fleet.setOfflineSec(s.offline_sec);
    } catch (e) {
        console.warn('[settings] seedDefaults skipped:', e.message);
    }
}

module.exports = { DEFAULTS, getSettings, setSettings, seedDefaults, applyRetention };





'use strict';
// Authentication + RBAC for the fleet portal (proposal §6.5).
// Local accounts (bcrypt) with a break-glass admin; ONGC AD/SSO (Keycloak) federates
// on top in production. Roles: admin | operator | viewer.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { safeEqual } = require('./secrets');
const { query } = require('./db');
const { verifyOidc } = require('./oidc');
const ldap = require('./ldap');

// Fail-fast on a weak/placeholder signing secret (audit #13): an unset or
// well-known secret lets anyone forge an admin HS256 token (full RBAC bypass).
// Any secret that still looks like a template placeholder is rejected, not just
// the one literal — .env.example ships `change-me-long-random-jwt-secret`, which
// the old exact-match guard let straight through.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || /change[-_ ]?me/i.test(JWT_SECRET) || JWT_SECRET.length < 32) {
    throw new Error(
        'JWT_SECRET is unset, still a placeholder, or shorter than 32 chars — ' +
        'refusing to start. Generate one with `openssl rand -hex 32` (see .env.example).');
}
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const OIDC_ENABLED = process.env.OIDC_ENABLED === 'true';
// AUTH_MODE lives in ldap._cfg so the Settings panel can change it at runtime;
// read it per-login instead of freezing the env value at module load.
const authMode = () => ldap.getMode();
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

// Issue a signed portal JWT for an authenticated principal (local or directory).
function issueToken(user) {
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return { token, user };
}

// Local bcrypt authentication against the users table (existing behaviour).
// Returns the {token,user} envelope on success, null otherwise.
async function loginLocal(username, password) {
    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const u = rows[0];
    if (!u) return null;
    // Reject disabled accounts (audit #8) — column added by the SCHEMA agent.
    if (u.disabled === true) return null;
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return null;
    const user = { username: u.username, display: u.display || u.username, role: u.role, source: u.source };
    return issueToken(user);
}

// Windows-domain (LDAP/Active Directory) authentication. Maps AD groups -> role
// inside lib/ldap.js. A directory user is NOT required to exist in the local
// users table — the JWT carries the identity. If a matching local row exists and
// is disabled, the account is rejected (lets an admin block a directory user).
async function loginLdap(username, password) {
    if (!ldap.ldapEnabled()) return null;
    let dir;
    try { dir = await ldap.authenticate(username, password); }
    catch { return null; } // bad domain credentials / unreachable DC
    // Honour a local disable flag for a same-named account (account block).
    const { rows } = await query(
        'SELECT COALESCE(disabled, false) AS disabled FROM users WHERE username = $1', [dir.username]);
    if (rows[0] && rows[0].disabled === true) return null;
    const user = { username: dir.username, display: dir.displayName || dir.username, role: dir.role, source: 'ldap' };
    return issueToken(user);
}

// Mode-aware login (proposal §6.5; ports the edge AUTH_MODE behaviour):
//   local -> local accounts only (existing)
//   ldap  -> Windows-domain accounts only
//   both  -> try local first (break-glass admin), then the directory
async function login(username, password) {
    if (!username || !password) return null;

    if (authMode() === 'local' || authMode() === 'both') {
        const local = await loginLocal(username, password);
        if (local) return local;
        if (authMode() === 'local') return null;
    }
    if (authMode() === 'ldap' || authMode() === 'both') {
        return loginLdap(username, password);
    }
    return null;
}

function verify(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Auth middleware. Tries the local JWT first (existing behaviour); when
// OIDC_ENABLED, falls back to verifying a Keycloak bearer token. Async-safe.
function requireAuth(req, res, next) {
    (async () => {
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'unauthorized' });

        let user = verify(token);
        if (!user && OIDC_ENABLED) user = await verifyOidc(token);
        if (!user) return res.status(401).json({ error: 'unauthorized' });

        req.user = user;
        next();
    })().catch(() => res.status(401).json({ error: 'unauthorized' }));
}

function requireRole(min) {
    return (req, res, next) => {
        if (!req.user || (ROLE_RANK[req.user.role] || 0) < (ROLE_RANK[min] || 99)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        next();
    };
}

// True when the user's role meets/exceeds the required minimum, mirroring
// requireRole's defaults (unknown user role => 0, unknown minimum => 99) so
// callers can build their own audited RBAC checks. (audit #14)
function roleMeets(userRole, min) {
    return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[min] || 99);
}

// Socket.IO handshake auth.
// - Portal browsers use the normal JWT.
// - Rig edge servers use { edge:true, deviceId, token } with the same read-only
//   device credential as ingest. This is for operator messages only; no PLC path.
function socketAuth(socket, next) {
    (async () => {
        const auth = socket.handshake.auth || {};
        if (auth.edge) {
            const deviceId = String(auth.deviceId || '').trim();
            const token = String(auth.token || '').trim();
            if (!deviceId || !token) return next(new Error('unauthorized'));
            const { rows } = await query('SELECT device_token FROM rigs WHERE rig_id = $1', [deviceId]);
            // A provisioned per-rig token is AUTHORITATIVE. The fleet-wide
            // INGEST_TOKEN must not also unlock a rig that has its own credential,
            // otherwise per-rig provisioning buys no isolation across 50 rigs and
            // one leaked shared secret impersonates the whole fleet. The shared
            // token is only a fallback for rigs not yet provisioned; when neither
            // is configured we fail closed rather than trusting a baked-in default.
            const perRig = rows[0] && rows[0].device_token ? String(rows[0].device_token) : '';
            const expected = perRig || String(process.env.INGEST_TOKEN || '');
            if (!expected || !safeEqual(token, expected)) return next(new Error('unauthorized'));
            socket.edgeRigId = deviceId;
            socket.clientType = 'edge';
            return next();
        }
        const token = auth.token;
        const user = token && verify(token);
        if (!user) return next(new Error('unauthorized'));
        socket.user = user;
        socket.clientType = 'portal';
        next();
    })().catch(() => next(new Error('unauthorized')));
}

const hash = (pw) => bcrypt.hashSync(pw, 10);

module.exports = { login, verify, requireAuth, requireRole, roleMeets, socketAuth, hash };

'use strict';
// Authentication + RBAC for the fleet portal (proposal §6.5).
// Local accounts (bcrypt) with a break-glass admin; ONGC AD/SSO (Keycloak) federates
// on top in production. Roles: admin | operator | viewer.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { verifyOidc } = require('./oidc');
const ldap = require('./ldap');

// Fail-fast on a weak/placeholder signing secret (audit #13): an unset or
// well-known secret lets anyone forge an admin HS256 token (full RBAC bypass).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-me-in-production') {
    throw new Error(
        'JWT_SECRET is unset or uses the insecure placeholder — refusing to start. ' +
        'Set a strong, unique JWT_SECRET (see .env.example).');
}
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const OIDC_ENABLED = process.env.OIDC_ENABLED === 'true';
const AUTH_MODE = (process.env.AUTH_MODE || 'local').toLowerCase();   // local | ldap | both
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

    if (AUTH_MODE === 'local' || AUTH_MODE === 'both') {
        const local = await loginLocal(username, password);
        if (local) return local;
        if (AUTH_MODE === 'local') return null;
    }
    if (AUTH_MODE === 'ldap' || AUTH_MODE === 'both') {
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
            const shared = process.env.INGEST_TOKEN || 'AHWR-ETP-2026';
            const { rows } = await query('SELECT device_token FROM rigs WHERE rig_id = $1', [deviceId]);
            const expected = rows[0]?.device_token || shared;
            if (token !== shared && token !== expected) return next(new Error('unauthorized'));
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

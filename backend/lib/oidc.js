'use strict';
// Keycloak / OIDC bearer-token verification for the fleet portal (proposal §6.5:
// "ONGC AD/SSO federates on top in production"). DEFAULT OFF: when
// OIDC_ENABLED !== 'true' verifyOidc() always returns null and "jose" is NEVER
// require()'d, so the docker-compose MVP keeps using local JWTs unchanged.
//
// Lazy: the JWKS remote key set is built on first use, from OIDC_JWKS_URI.
const ENABLED = process.env.OIDC_ENABLED === 'true';
const JWKS_URI = process.env.OIDC_JWKS_URI || '';
const ISSUER = process.env.OIDC_ISSUER || '';
const AUDIENCE = process.env.OIDC_AUDIENCE || '';

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

let jose = null;       // lazily-required module
let jwks = null;       // lazily-built remote key set
let buildFailed = false;

// Build (once) the createRemoteJWKSet from OIDC_JWKS_URI. Returns the key set or
// null if it cannot be built. Only touches "jose" when OIDC is enabled.
function getJwks() {
    if (jwks || buildFailed) return jwks;
    if (!JWKS_URI) { buildFailed = true; return null; }
    try {
        if (!jose) jose = require('jose'); // only required when enabled
        jwks = jose.createRemoteJWKSet(new URL(JWKS_URI));
    } catch (e) {
        buildFailed = true;
        jwks = null;
        console.error('[oidc] failed to build JWKS from', JWKS_URI, '-', e.message);
    }
    return jwks;
}

// Map Keycloak realm roles (and AD groups surfaced as claims) to an app role.
// Highest privilege wins. Returns 'admin' | 'operator' | 'viewer' (default viewer).
function mapRole(claims) {
    const names = new Set();
    const push = (v) => {
        if (!v) return;
        if (Array.isArray(v)) v.forEach((x) => x && names.add(String(x).toLowerCase()));
        else names.add(String(v).toLowerCase());
    };
    // Keycloak realm + client roles.
    push(claims?.realm_access?.roles);
    if (claims?.resource_access && typeof claims.resource_access === 'object') {
        for (const r of Object.values(claims.resource_access)) push(r?.roles);
    }
    // AD groups federated through Keycloak (common claim names).
    push(claims?.groups);
    push(claims?.roles);

    // Normalise AD-style group DNs/paths (e.g. "/CRMF-Operators") to a bare token.
    const has = (role) => {
        for (const n of names) {
            if (n === role || n.endsWith('-' + role) || n.endsWith('/' + role) ||
                n.endsWith('_' + role) || n.includes('crmf-' + role)) return true;
        }
        return false;
    };

    let best = 'viewer';
    for (const candidate of ['operator', 'admin']) {
        if (has(candidate) && (ROLE_RANK[candidate] > ROLE_RANK[best])) best = candidate;
    }
    return best;
}

// Verify a Keycloak bearer token. Returns the app user
// { username, display, role, source:'ad' } on success, or null on any failure or
// when OIDC is disabled. Never throws.
async function verifyOidc(token) {
    if (!ENABLED || !token) return null;
    const keyset = getJwks();
    if (!keyset) return null;
    try {
        if (!jose) jose = require('jose');
        const opts = {};
        if (ISSUER) opts.issuer = ISSUER;
        if (AUDIENCE) opts.audience = AUDIENCE;
        const { payload } = await jose.jwtVerify(token, keyset, opts);

        const username = payload.preferred_username || payload.email ||
            payload.sub || 'oidc-user';
        const display = payload.name || payload.preferred_username || username;
        const role = mapRole(payload);
        return { username, display, role, source: 'ad' };
    } catch {
        return null;
    }
}

module.exports = {
    verifyOidc,
    mapRole, // exported for testability
    get enabled() { return ENABLED; },
};

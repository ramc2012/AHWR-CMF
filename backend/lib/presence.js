'use strict';
// User liveness / presence (proposal §6.5): who is currently signed in to the
// portal. Every authenticated API request touches the caller's session row
// (last_seen = now); the presence list flags a user "online" when their last
// activity is within ONLINE_SEC. Persisted in user_sessions (username PK).
const { query } = require('./db');

const ONLINE_SEC = 90;          // online if last_seen within this window
const LIST_WINDOW_SEC = 86400;  // only surface sessions seen in the last day

// Upsert the caller's session. Cheap and fire-and-forget from the auth middleware,
// so it must never throw into the request path — callers ignore the returned promise.
async function touch(user, ip) {
    if (!user || !user.username) return;
    try {
        await query(
            `INSERT INTO user_sessions (username, display, role, source, last_seen, ip)
             VALUES ($1, $2, $3, $4, now(), $5)
             ON CONFLICT (username) DO UPDATE
               SET display = EXCLUDED.display, role = EXCLUDED.role,
                   source = EXCLUDED.source, last_seen = now(), ip = EXCLUDED.ip`,
            [user.username, user.display || user.username, user.role || null,
             user.source || 'local', ip || null]);
    } catch { /* presence is best-effort; never disturb the request */ }
}

// Recent sessions, most-recently-active first, with a live online flag.
async function list() {
    const { rows } = await query(
        `SELECT username, display, role, source, last_seen, ip,
                (last_seen > now() - ($1 || ' seconds')::interval) AS online
         FROM user_sessions
         WHERE last_seen > now() - ($2 || ' seconds')::interval
         ORDER BY last_seen DESC`,
        [ONLINE_SEC, LIST_WINDOW_SEC]);
    return rows.map((r) => ({
        username: r.username,
        display: r.display || r.username,
        role: r.role,
        source: r.source,
        lastSeen: r.last_seen,
        online: r.online === true,
    }));
}

module.exports = { touch, list, ONLINE_SEC };

'use strict';
// User & Access Management (proposal §6.1, audit #8). Admin-only CRUD over local
// portal accounts. Passwords are bcrypt-hashed; hashes are NEVER returned. The
// users.disabled column is added by the SCHEMA agent; auth.login rejects disabled
// accounts. All mutations are audit-logged by the route layer's wrappers, plus an
// explicit audit row here for the sensitive change set.
const { query } = require('./db');
const { hash } = require('./auth');

const ROLES = ['admin', 'operator', 'viewer'];

// GET /api/users — no password hashes.
async function listUsers() {
    const { rows } = await query(
        `SELECT username, display, role, source,
                COALESCE(disabled, false) AS disabled, created_at
         FROM users ORDER BY username`);
    return rows;
}

async function getUser(username) {
    const { rows } = await query(
        `SELECT username, display, role, source,
                COALESCE(disabled, false) AS disabled, created_at
         FROM users WHERE username = $1`, [username]);
    return rows[0] || null;
}

async function countAdmins() {
    const { rows } = await query(
        `SELECT count(*)::int AS c FROM users
         WHERE role = 'admin' AND COALESCE(disabled, false) = false`);
    return rows[0].c;
}

// POST /api/users {username, password, display, role}
async function createUser({ username, password, display, role }, actor) {
    if (!username || !String(username).trim()) {
        throw Object.assign(new Error('username is required'), { status: 400 });
    }
    if (!password || String(password).length < 8) {
        throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
    }
    const r = ROLES.includes(role) ? role : 'viewer';
    const exists = await getUser(username);
    if (exists) throw Object.assign(new Error('user already exists'), { status: 409 });
    await query(
        `INSERT INTO users (username, password, display, role, source)
         VALUES ($1,$2,$3,$4,'local')`,
        [username, hash(password), display || username, r]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'user.create', username, { role: r }]).catch(() => {});
    return getUser(username);
}

// PATCH /api/users/:username {role?, disabled?, password?}
async function updateUser(username, patch, actor) {
    const u = await getUser(username);
    if (!u) throw Object.assign(new Error('user not found'), { status: 404 });
    const p = patch || {};
    const sets = [], vals = [username], detail = {};

    if ('role' in p) {
        if (!ROLES.includes(p.role)) throw Object.assign(new Error('invalid role'), { status: 400 });
        // Refuse to demote the last active admin.
        if (u.role === 'admin' && p.role !== 'admin' && (await countAdmins()) <= 1) {
            throw Object.assign(new Error('cannot demote the last admin'), { status: 409 });
        }
        sets.push(`role = $${vals.length + 1}`); vals.push(p.role); detail.role = p.role;
    }
    if ('disabled' in p) {
        const dis = !!p.disabled;
        // Refuse to disable the last active admin (or self-lockout of last admin).
        if (dis && u.role === 'admin' && !u.disabled && (await countAdmins()) <= 1) {
            throw Object.assign(new Error('cannot disable the last admin'), { status: 409 });
        }
        if (dis && actor && actor === username) {
            throw Object.assign(new Error('cannot disable your own account'), { status: 409 });
        }
        sets.push(`disabled = $${vals.length + 1}`); vals.push(dis); detail.disabled = dis;
    }
    if ('password' in p && p.password) {
        if (String(p.password).length < 8) {
            throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
        }
        sets.push(`password = $${vals.length + 1}`); vals.push(hash(p.password)); detail.password = 'reset';
    }
    if (!sets.length) throw Object.assign(new Error('no updatable fields'), { status: 400 });

    await query(`UPDATE users SET ${sets.join(', ')} WHERE username = $1`, vals);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'user.update', username, detail]).catch(() => {});
    return getUser(username);
}

// DELETE /api/users/:username — refuse deleting self or the last admin.
async function deleteUser(username, actor) {
    const u = await getUser(username);
    if (!u) throw Object.assign(new Error('user not found'), { status: 404 });
    if (actor && actor === username) {
        throw Object.assign(new Error('cannot delete your own account'), { status: 409 });
    }
    if (u.role === 'admin' && (await countAdmins()) <= 1) {
        throw Object.assign(new Error('cannot delete the last admin'), { status: 409 });
    }
    await query('DELETE FROM users WHERE username = $1', [username]);
    await query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)',
        [actor || 'system', 'user.delete', username, {}]).catch(() => {});
    return { deleted: username };
}

module.exports = { ROLES, listUsers, getUser, createUser, updateUser, deleteUser };

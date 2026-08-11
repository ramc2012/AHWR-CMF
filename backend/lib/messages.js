'use strict';
const crypto = require('crypto');
const { query } = require('./db');

const MAX_MESSAGE_LENGTH = Number(process.env.RIG_MESSAGE_MAX_LENGTH || 1000);
const TYPES = new Set(['General', 'Instruction', 'Warning', 'Safety', 'Maintenance', 'Sensor Check', 'ETP / Network']);

function cleanText(value) {
    const text = String(value || '').replace(/[^\S\r\n\t]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (!text) throw Object.assign(new Error('message text is required'), { status: 400 });
    if (text.length > MAX_MESSAGE_LENGTH) throw Object.assign(new Error(`message must be ${MAX_MESSAGE_LENGTH} characters or less`), { status: 400 });
    return text;
}

function cleanType(value) {
    const type = String(value || 'General').trim();
    return TYPES.has(type) ? type : 'General';
}

const publicCols = `
    message_id AS "messageId", target_rig_id AS "targetRigId", target_rig_name AS "targetRigName",
    message_type AS "messageType", message_text AS "messageText", sender_username AS "senderUsername",
    sender_display AS "senderDisplay", sent_at AS "sentAt", status, delivered_at AS "deliveredAt",
    acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy", failed_at AS "failedAt",
    failure_reason AS "failureReason", retry_count AS "retryCount", updated_at AS "updatedAt"
`;

async function getRig(rigId) {
    const { rows } = await query('SELECT rig_id, name FROM rigs WHERE rig_id = $1', [rigId]);
    if (!rows[0]) throw Object.assign(new Error('rig not found'), { status: 404 });
    return rows[0];
}

async function list(rigId, limit = 100) {
    await getRig(rigId);
    const n = Math.min(Math.max(Number(limit) || 100, 1), 250);
    return (await query(`SELECT ${publicCols} FROM rig_messages WHERE target_rig_id = $1 ORDER BY sent_at DESC LIMIT $2`, [rigId, n])).rows;
}

async function create(rigId, body, user) {
    const rig = await getRig(rigId);
    const message = {
        messageId: `msg_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`,
        targetRigId: rig.rig_id,
        targetRigName: rig.name || rig.rig_id,
        messageType: cleanType(body?.messageType),
        messageText: cleanText(body?.messageText ?? body?.text),
        senderUsername: user?.username || 'unknown',
        senderDisplay: user?.display || user?.username || 'unknown',
    };
    const { rows } = await query(
        `INSERT INTO rig_messages
            (message_id, target_rig_id, target_rig_name, message_type, message_text, sender_username, sender_display)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${publicCols}`,
        [message.messageId, message.targetRigId, message.targetRigName, message.messageType, message.messageText, message.senderUsername, message.senderDisplay]);
    return rows[0];
}

async function pendingForRig(rigId) {
    return (await query(
        `SELECT ${publicCols} FROM rig_messages
         WHERE target_rig_id = $1 AND status IN ('sent','failed')
         ORDER BY sent_at ASC LIMIT 100`,
        [rigId])).rows;
}

async function markDelivered(messageId, rigId) {
    const { rows } = await query(
        `UPDATE rig_messages
         SET status = CASE WHEN status = 'acknowledged' THEN status ELSE 'delivered' END,
             delivered_at = COALESCE(delivered_at, now()), updated_at = now(), failure_reason = NULL
         WHERE message_id = $1 AND target_rig_id = $2
         RETURNING ${publicCols}`,
        [messageId, rigId]);
    return rows[0] || null;
}

async function acknowledge(messageId, rigId, acknowledgedBy) {
    const { rows } = await query(
        `UPDATE rig_messages
         SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $3,
             delivered_at = COALESCE(delivered_at, now()), updated_at = now(), failure_reason = NULL
         WHERE message_id = $1 AND target_rig_id = $2
         RETURNING ${publicCols}`,
        [messageId, rigId, String(acknowledgedBy || 'edge')]);
    return rows[0] || null;
}

async function retry(messageId, rigId) {
    const { rows } = await query(
        `UPDATE rig_messages
         SET status = 'sent', retry_count = retry_count + 1, failed_at = NULL, failure_reason = NULL, updated_at = now()
         WHERE message_id = $1 AND target_rig_id = $2 AND status <> 'acknowledged'
         RETURNING ${publicCols}`,
        [messageId, rigId]);
    if (!rows[0]) throw Object.assign(new Error('message not found or already acknowledged'), { status: 404 });
    return rows[0];
}

module.exports = { list, create, pendingForRig, markDelivered, acknowledge, retry };

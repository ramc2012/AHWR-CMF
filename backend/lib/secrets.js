'use strict';
// Shared secret-comparison helper.
//
// Device/ingest tokens are compared on every batch and every WS upgrade across a
// 50-rig fleet, so the comparison must not leak the expected value through
// response timing. Hashing both sides first makes the comparison
// length-independent (crypto.timingSafeEqual throws on unequal-length buffers)
// without revealing the token length either.
const crypto = require('crypto');

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
    const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual };

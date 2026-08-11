'use strict';
// Edge <-> central wire-contract test.
//
// The rig-edge sync agent flattens its live rig object to "<measurement>.<field>"
// (edge backend/lib/sync.js flatten()) and POSTs those keys to /ingest verbatim.
// Central's tag dictionary (lib/tags.js) must therefore agree with that key set
// EXACTLY, or two silent failures follow:
//
//   * a metric the edge sends but the dictionary lacks  -> stored in `telemetry`
//     but invisible in the config registry and the rig UI groups;
//   * a metric the dictionary marks `expected` but no edge sends -> counts against
//     every rig's data-completeness score forever.
//
// Both happened before consolidation: the dictionary declared the BOP group as
// `wellcontrol.*` while every real edge emits `well_control.*`, and the bundled
// fleet-sim emitted the dictionary's spelling, so demos looked healthy.
//
// fixtures/edge-rig-latest.json is a real capture from GET /api/rig/latest on a
// running edge twin. Re-capture it when the edge adds or renames a measurement.
//
// Run:  node backend/test/wire-contract.test.cjs

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { TAGS, EXPECTED_METRICS, canonicalMetric, WIRE_ALIASES } = require('../lib/tags');

// Metrics the dictionary marks `expected` that a mock/unmapped rig legitimately
// does not send. Keep this list empty unless there is a documented reason.
const EXPECTED_ABSENCE_ALLOWED = new Set([]);

// Mirrors edge backend/lib/sync.js flatten(): numeric fields of every
// non-underscore measurement. Booleans coerce to 1/0 exactly as Number() does.
function flattenLikeEdge(rigData) {
    const out = {};
    for (const [meas, fields] of Object.entries(rigData || {})) {
        if (meas.startsWith('_') || !fields || typeof fields !== 'object') continue;
        for (const [f, v] of Object.entries(fields)) {
            const n = Number(v);
            if (Number.isFinite(n)) out[`${meas}.${f}`] = n;
        }
    }
    return out;
}

const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'edge-rig-latest.json'), 'utf8'));
const emitted = new Set(Object.keys(flattenLikeEdge(fixture)));
const dict = new Set(TAGS.map((t) => t.metric));

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`); }
}

console.log(`wire contract: ${emitted.size} emitted metrics vs ${dict.size} dictionary tags`);

check('dictionary has no duplicate metrics', () => {
    const all = TAGS.map((t) => t.metric);
    const dupes = [...new Set(all.filter((m, i) => all.indexOf(m) !== i))];
    assert.deepStrictEqual(dupes, [], `duplicated: ${dupes.join(', ')}`);
});

check('every metric the edge emits is in the dictionary', () => {
    const unmapped = [...emitted].filter((m) => !dict.has(m)).sort();
    assert.deepStrictEqual(unmapped, [],
        `${unmapped.length} emitted metric(s) missing from lib/tags.js:\n       ${unmapped.join('\n       ')}`);
});

check('every `expected` metric is actually emitted by a real edge', () => {
    const missing = EXPECTED_METRICS
        .filter((m) => !emitted.has(m) && !EXPECTED_ABSENCE_ALLOWED.has(m)).sort();
    assert.deepStrictEqual(missing, [],
        `${missing.length} expected metric(s) no edge sends (permanent completeness penalty):\n       ${missing.join('\n       ')}`);
});

check('BOP uses the canonical well_control.* namespace', () => {
    const wrong = TAGS.map((t) => t.metric).filter((m) => m.startsWith('wellcontrol.'));
    assert.deepStrictEqual(wrong, [],
        `dictionary still uses the pre-consolidation spelling: ${wrong.join(', ')}`);
});

check('aliases resolve to metrics that exist in the dictionary', () => {
    for (const [from, to] of Object.entries(WIRE_ALIASES)) {
        assert.ok(dict.has(to), `alias ${from} -> ${to}, but ${to} is not a dictionary tag`);
        assert.ok(!dict.has(from), `alias source ${from} must not also be a dictionary tag`);
        assert.strictEqual(canonicalMetric(from), to);
    }
});

check('canonicalMetric is identity for canonical names', () => {
    for (const m of dict) assert.strictEqual(canonicalMetric(m), m, `${m} was rewritten`);
});

check('every tag has label, unit key, group and boolean flags', () => {
    for (const t of TAGS) {
        assert.ok(t.label, `${t.metric}: missing label`);
        assert.ok(typeof t.unit === 'string', `${t.metric}: unit must be a string`);
        assert.ok(t.group, `${t.metric}: missing group`);
        assert.strictEqual(typeof t.expected, 'boolean', `${t.metric}: expected must be boolean`);
        assert.strictEqual(typeof t.key, 'boolean', `${t.metric}: key must be boolean`);
    }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nwire contract OK');
process.exit(failures ? 1 : 0);

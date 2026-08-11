'use strict';
// Minimal WEBHOOK SINK for local demo only — stands in for an enterprise webhook
// receiver (Slack/Teams/PagerDuty/SMS-gateway). Accepts the CRMF notification
// POSTs, counts them, and exposes the most recent ones at GET /received so the
// alarm-notification path is demonstrable end-to-end. NOT part of the platform.
const http = require('http');

const PORT = Number(process.env.PORT || 9020);
const recent = [];
const totals = { received: 0, startedAt: new Date().toISOString() };

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/hook') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            let body = null;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep raw */ }
            totals.received += 1;
            recent.unshift({ at: new Date().toISOString(), body });
            if (recent.length > 100) recent.length = 100;
            console.log(`NOTIFY-SINK received #${totals.received}: ${body ? `${body.severity} ${body.kind} ${body.name}` : 'unparsed'}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    } else if (req.method === 'GET' && req.url === '/received') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...totals, recent }));
    } else if (req.url === '/health' || req.url === '/') {
        res.writeHead(200); res.end('ok');
    } else {
        res.writeHead(404); res.end('not found');
    }
});
server.listen(PORT, () => console.log(`NOTIFY-SINK (demo webhook receiver) listening on ${PORT}`));

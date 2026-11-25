#!/usr/bin/env node
'use strict';
// Tiny dependency-free load probe: node tools/loadtest.js [requests] [concurrency]
const fs = require('node:fs');
const path = require('node:path');

const TOTAL = Number(process.argv[2] || 200);
const CONC = Number(process.argv[3] || 40);
const PORT = Number(process.env.PORT || 20129);
const HOST = process.env.HOST || '127.0.0.1';
let token = '';
try { token = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'state.json'), 'utf8')).token; } catch {}

const latencies = [];
let done = 0, errors = 0, next = 0;
const t0 = Date.now();
function worker() {
  while (next < TOTAL) {
    const i = next++;
    const url = i % 2 === 0 ? '/health' : '/v1/models';
    const start = Date.now();
    fetch(`http://${HOST}:${PORT}${url}`, { headers: token && url === '/v1/models' ? { Authorization: 'Bearer ' + token } : {} })
      .then((r) => { if (r.status >= 500) errors++; return r.arrayBuffer(); })
      .catch(() => errors++)
      .finally(() => {
        latencies.push(Date.now() - start);
        if (++done === TOTAL) report();
        else worker();
      });
    return;
  }
}
function report() {
  const a = latencies.sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  console.log(JSON.stringify({ requests: TOTAL, concurrency: CONC, seconds: ((Date.now() - t0) / 1000).toFixed(2), errors, p50: q(0.5), p95: q(0.95), p99: q(0.99) }, null, 2));
}
for (let i = 0; i < Math.min(CONC, TOTAL); i++) worker();

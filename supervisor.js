#!/usr/bin/env node
'use strict';
// Process supervisor for Logic Router.
// Restarts the server after a crash, a hang, or an unhealthy health probe.
// Zero dependencies. Use `node supervisor.js` (the default `npm start`).

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = process.env.CHILD || path.join(__dirname, 'server.js');
const PORT = Number(process.env.PORT || 20129);
const HOST = process.env.HEALTH_HOST || '127.0.0.1';
const CHECK_MS = Number(process.env.SUPERVISOR_CHECK_MS || 5000);
const CHECK_TIMEOUT = 3000;
const UNHEALTHY_LIMIT = 2;
const MAX_BACKOFF = 30000;
const STABLE_MS = 60000;

let child = null;
let backoff = 500;
let startedAt = 0;
let restarts = 0;
let windowStart = Date.now();
let unhealthy = 0;
let stopping = false;
let checkTimer = null;
let killTimer = null;
let restartPending = false;

function log(msg) { console.log('[supervisor] ' + new Date().toISOString().slice(11, 19) + ' ' + msg); }

function healthCheck() {
  if (stopping || !child || child.exitCode != null) return;
  const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: CHECK_TIMEOUT }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    res.on('end', () => {
      if (res.statusCode === 200 && body.includes('"ok":true')) {
        if (unhealthy) log('health recovered');
        unhealthy = 0;
        if (Date.now() - startedAt > STABLE_MS) backoff = 500;
      } else {
        unhealthy++;
        log('unhealthy response ' + res.statusCode + ' (' + unhealthy + '/' + UNHEALTHY_LIMIT + ')');
        if (unhealthy >= UNHEALTHY_LIMIT) restart('health check failed');
      }
    });
  });
  req.on('timeout', () => { req.destroy(); unhealthy++; log('health probe timeout (' + unhealthy + '/' + UNHEALTHY_LIMIT + ')'); if (unhealthy >= UNHEALTHY_LIMIT) restart('health probe timeout'); });
  req.on('error', (e) => { if (e.code !== 'ECONNRESET') { unhealthy++; log('health probe error: ' + e.message + ' (' + unhealthy + '/' + UNHEALTHY_LIMIT + ')'); if (unhealthy >= UNHEALTHY_LIMIT) restart('health probe error'); } });
}

function start() {
  if (stopping) return;
  unhealthy = 0;
  startedAt = Date.now();
  const proc = spawn(process.execPath, [SERVER], {
    cwd: __dirname,
    env: { ...process.env, SUPERVISED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  proc.stdout.on('data', (d) => process.stdout.write('[router] ' + d));
  proc.stderr.on('data', (d) => process.stderr.write('[router] ' + d));
  proc.on('exit', (code, signal) => {
    if (stopping || child !== proc) return;
    restart('exited code=' + code + (signal ? ' signal=' + signal : ''));
  });
  log('server started pid=' + proc.pid);
}

function restart(reason) {
  if (stopping || restartPending) return;
  restartPending = true;
  restarts++;
  if (Date.now() - windowStart > 10 * 60 * 1000) { restarts = 1; windowStart = Date.now(); }
  log(reason + ' — restarting (restart ' + restarts + ')');
  const delay = restarts > 10 ? Math.max(backoff, 60000) : backoff;
  backoff = Math.min(MAX_BACKOFF, backoff * 2);
  const old = child;
  child = null;
  const scheduleStart = () => {
    restartPending = false;
    killTimer = null;
    setTimeout(start, delay).unref();
  };
  if (old && old.exitCode == null && old.signalCode == null) {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(killTimer); scheduleStart(); };
    old.once('exit', finish);
    killTimer = setTimeout(() => { try { old.kill('SIGKILL'); } catch {} }, 3000);
    try { old.kill('SIGTERM'); } catch {}
    setTimeout(finish, 4000).unref();
  } else scheduleStart();
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(checkTimer);
  log('shutting down');
  if (child && child.exitCode == null) {
    try { child.kill(signal || 'SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 4000).unref();
  } else process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('uncaughtException', (e) => log('uncaught: ' + e.message));

start();
checkTimer = setInterval(healthCheck, CHECK_MS);
setTimeout(healthCheck, 1500).unref();

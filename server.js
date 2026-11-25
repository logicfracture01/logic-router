#!/usr/bin/env node
'use strict';
// Logic Router — minimal local LLM router with load control and self-healing.
// Zero npm dependencies. Free-tier providers only. Keys stay on your device.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const PORT = Number(process.env.PORT || 20129);
const HOST = process.env.HOST || '127.0.0.1';

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
const CFG = {
  maxInflight: intEnv('MAX_INFLIGHT', 64, 4, 512),
  maxQueue: intEnv('MAX_QUEUE', 256, 0, 4096),
  queueTimeout: intEnv('QUEUE_TIMEOUT_MS', 30000, 1000, 300000),
  upstreamTimeout: intEnv('UPSTREAM_TIMEOUT_MS', 120000, 5000, 600000),
  streamIdle: intEnv('STREAM_IDLE_MS', 30000, 5000, 300000),
  keyInflight: intEnv('KEY_INFLIGHT', 4, 1, 64),
  retries: intEnv('MAX_RETRIES', 1, 0, 3),
  bodyLimit: intEnv('BODY_LIMIT', 2 * 1024 * 1024, 16384, 32 * 1024 * 1024),
  breakerThreshold: intEnv('BREAKER_THRESHOLD', 3, 1, 20),
  breakerBase: intEnv('BREAKER_BASE_MS', 15000, 1000, 3600000),
  breakerMax: intEnv('BREAKER_MAX_MS', 1800000, 10000, 86400000),
  healthInterval: intEnv('HEALTH_INTERVAL_MS', 10000, 1000, 300000),
};
const jitter = (ms) => Math.floor(Math.random() * ms);

// ---------------------------------------------------------------------------
// Provider catalog (standing free tiers only — no one-time credits)
// ---------------------------------------------------------------------------
const PROVIDERS = {
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', rpm: 30, rpd: 1000, models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'], keyHint: 'console.groq.com/keys' },
  gemini: { name: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', rpm: 15, rpd: 1000, models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'], keyHint: 'aistudio.google.com/apikey' },
  openrouter: { name: 'OpenRouter :free', baseUrl: 'https://openrouter.ai/api/v1', rpm: 20, rpd: 50, models: ['openrouter/free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'inclusionai/ling-3.2-flash:free'], keyHint: 'openrouter.ai/keys' },
  tokenharbor: { name: 'Token Harbor', baseUrl: 'https://tokenharbor.ai/v1', rpm: 60, rph: 1800, models: ['deepseek-v4.1-flash:free', 'mimo-v2.6-flash:free'], keyHint: 'tokenharbor.ai' },
  opentyphoon: { name: 'OpenTyphoon', baseUrl: 'https://api.opentyphoon.ai/v1', rpm: 200, models: ['typhoon-v2.5-30b-a3b-instruct'], keyHint: 'playground.opentyphoon.ai/api-key' },
  requesty: { name: 'Requesty', baseUrl: 'https://router.requesty.ai/v1', rpm: 20, rpd: 200, models: ['google/gemma-4-31b-it', 'mistral/leanstral-1-5', 'novita/ling-3.1-flash'], keyHint: 'requesty.ai' },
  meganova: { name: 'MegaNova AI', baseUrl: 'https://api.meganova.ai/v1', rpm: 60, rpd: 50, models: ['meganova-ai/manta-mini-1.0', 'meganova-ai/manta-flash-1.0'], keyHint: 'meganova.ai' },
  kilo: { name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway', rph: 200, models: ['kilo-auto/free', 'openrouter/free'], keyHint: 'kilo.ai/gateway' },
  freeinference: { name: 'FreeInference', baseUrl: 'https://freeinference.org/v1', models: ['glm-5.3-flash', 'deepseek-v4-flash', 'minimax-m3', 'qwen3.6-35b'], keyHint: 'freeinference.org' },
  radeon: { name: 'AMD Radeon Cloud', baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', rpm: 30, models: ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-27B'], keyHint: 'developer.amd.com.cn (China site)' },
};
const ALIASES = { auto: null, free: 'openrouter/free', fast: 'openai/gpt-oss-120b', smart: 'gemini-3.8-flash', coder: 'mimo-v2.6-flash:free' };

// ---------------------------------------------------------------------------
// State — atomic writes + corruption recovery
// ---------------------------------------------------------------------------
function freshState() { return { token: crypto.randomBytes(18).toString('base64url'), keys: [], log: [] }; }
function freshCounters() {
  const n = Date.now();
  return { minStamp: Math.floor(n / 60000), min: 0, hourStamp: Math.floor(n / 3600000), hour: 0, dayStamp: new Date(n).toISOString().slice(0, 10), day: 0 };
}
function freshBreaker() { return { state: 'closed', fails: 0, openUntil: 0, probes: 0 }; }

let state = freshState();
try {
  if (fs.existsSync(STATE_FILE)) {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    state = { ...freshState(), ...saved };
  }
} catch (e) {
  console.error('[logic-router] state corrupted, starting fresh:', e.message);
  try { fs.renameSync(STATE_FILE, STATE_FILE + '.corrupt-' + Date.now()); } catch {}
  state = freshState();
}
if (!Array.isArray(state.keys)) state.keys = [];
if (!Array.isArray(state.log)) state.log = [];
for (const k of state.keys) {
  if (!k.requests) k.requests = freshCounters();
  if (!k.cb) k.cb = freshBreaker();
  if (k.cooldownUntil == null) k.cooldownUntil = 0;
  if (k.fails == null) k.fails = 0;
  if (k.enabled == null) k.enabled = true;
  k.inflight = 0;
}

let saveTimer = null;
function persistNow() {
  clearTimeout(saveTimer);
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[logic-router] state save failed:', e.message); }
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 200); }
function addLog(entry) { state.log.unshift({ t: new Date().toISOString(), ...entry }); if (state.log.length > 80) state.log.length = 80; persist(); }

const sysLog = [];
function slog(kind, msg) {
  sysLog.unshift({ t: new Date().toISOString(), kind, msg: String(msg) });
  if (sysLog.length > 120) sysLog.length = 120;
  console.log('[logic-router] ' + kind + ': ' + msg);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
const metrics = { started: Date.now(), requests: 0, ok: 0, failed: 0, shed: 0, queueTimeouts: 0, upstreamTimeouts: 0, retries: 0, latencies: [], providers: {} };
function recordLatency(ms) { metrics.latencies.push(ms); if (metrics.latencies.length > 2000) metrics.latencies.shift(); }
function providerStat(name) { return metrics.providers[name] || (metrics.providers[name] = { ok: 0, fail: 0 }); }
function percentile(p) {
  if (!metrics.latencies.length) return 0;
  const a = [...metrics.latencies].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

// ---------------------------------------------------------------------------
// Bounded concurrency queue with adaptive limit and load shedding
// ---------------------------------------------------------------------------
let inflight = 0;
let dynamicLimit = CFG.maxInflight;
const waiters = [];
const effectiveLimit = () => Math.min(CFG.maxInflight, dynamicLimit);

function pump() {
  while (inflight < effectiveLimit() && waiters.length) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    inflight++;
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      inflight--;
      pump();
    });
  }
}
function acquireSlot() {
  if (inflight < effectiveLimit()) {
    inflight++;
    let released = false;
    return Promise.resolve(() => { if (released) return; released = true; inflight--; pump(); });
  }
  if (waiters.length >= CFG.maxQueue) {
    metrics.shed++;
    const e = new Error('server overloaded'); e.code = 'OVERLOAD'; return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    const w = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        metrics.queueTimeouts++;
        reject(Object.assign(new Error('request waited too long'), { code: 'QUEUE_TIMEOUT' }));
      }, CFG.queueTimeout),
    };
    waiters.push(w);
  });
}
function adapt(success) {
  if (success) dynamicLimit = Math.min(CFG.maxInflight, dynamicLimit + 1);
  else dynamicLimit = Math.max(Math.max(4, Math.ceil(CFG.maxInflight * 0.25)), Math.floor(dynamicLimit * 0.8));
}

// ---------------------------------------------------------------------------
// Key health: rolling counters, concurrency cap, circuit breaker
// ---------------------------------------------------------------------------
function resolveProvider(k) {
  if (PROVIDERS[k.provider]) return PROVIDERS[k.provider];
  if (k.provider === 'custom' && k.label) {
    const base = /^https?:\/\//.test(k.label) ? k.label : 'https://' + k.label;
    return { name: 'Custom', baseUrl: base.replace(/\/$/, ''), models: [] };
  }
  return null;
}

function keyUsable(k, p, now) {
  if (!k.enabled || !k.key || k.inflight >= CFG.keyInflight) return false;
  const cb = k.cb || (k.cb = freshBreaker());
  if (cb.state === 'open') {
    if (now < cb.openUntil) return false;
    cb.state = 'half'; cb.probes = 0;
  } else if (cb.state === 'half' && cb.probes >= 1) return false;
  if (k.cooldownUntil > now) return false;
  const r = k.requests;
  const minStamp = Math.floor(now / 60000), hourStamp = Math.floor(now / 3600000), dayStamp = new Date(now).toISOString().slice(0, 10);
  if (r.minStamp !== minStamp) { r.minStamp = minStamp; r.min = 0; }
  if (r.hourStamp !== hourStamp) { r.hourStamp = hourStamp; r.hour = 0; }
  if (r.dayStamp !== dayStamp) { r.dayStamp = dayStamp; r.day = 0; }
  if (r.min >= (p.rpm || Infinity)) return false;
  if (r.hour >= (p.rph || (p.rpm ? p.rpm * 60 : Infinity))) return false;
  if (r.day >= (p.rpd || Infinity)) return false;
  return true;
}

function breakerFailure(k, delayMs) {
  const cb = k.cb;
  cb.fails++;
  const open = cb.state === 'half' || cb.fails >= CFG.breakerThreshold;
  if (open) {
    cb.state = 'open';
    const exp = CFG.breakerBase * Math.pow(2, Math.min(cb.fails - 1, 6));
    cb.openUntil = Date.now() + Math.max(delayMs || 0, Math.min(exp, CFG.breakerMax)) + jitter(1000);
    k.cooldownUntil = cb.openUntil;
  }
  k.fails++;
  k.lastError = new Date().toISOString();
}
function breakerSuccess(k) {
  k.cb.state = 'closed'; k.cb.fails = 0; k.cb.openUntil = 0; k.cb.probes = 0;
  k.cooldownUntil = 0; k.fails = 0;
}
function parseRetryAfter(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 30000;
  const n = Number(h);
  return Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(h) - Date.now()) || 30000;
}

function candidatesFor(model) {
  const alias = ALIASES[model];
  const target = alias === undefined ? model : alias;
  const now = Date.now();
  const out = [];
  for (const k of state.keys) {
    const p = resolveProvider(k);
    if (!p || !keyUsable(k, p, now)) continue;
    if (target && p.models.length && !p.models.includes(target)) continue;
    if (k.cb && k.cb.state === 'half') k.cb.probes++;
    out.push({ key: k, provider: p, model: target || p.models[0] || 'gpt-4o-mini' });
  }
  out.sort((a, b) => {
    const sa = a.key.cb.state === 'half' ? -1 : 0;
    const sb = b.key.cb.state === 'half' ? -1 : 0;
    if (sa !== sb) return sa - sb;
    if (a.key.fails !== b.key.fails) return a.key.fails - b.key.fails;
    const pa = a.provider.rpd ? 1 - a.key.requests.day / a.provider.rpd : 1;
    const pb = b.provider.rpd ? 1 - b.key.requests.day / b.provider.rpd : 1;
    return pb - pa;
  });
  return out;
}

async function waitForCandidate(model, timeout) {
  const deadline = Date.now() + Math.min(timeout, 10000);
  for (;;) {
    const ready = candidatesFor(model);
    if (ready.length) return ready;
    if (Date.now() >= deadline) return [];
    await sleep(50 + jitter(50));
  }
}

async function callUpstream(c, body, stream) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + c.key.key };
  if (c.provider.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'http://' + HOST + ':' + PORT;
    headers['X-Title'] = 'Logic Router';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.upstreamTimeout);
  try {
    const res = await fetch(c.provider.baseUrl + '/chat/completions', {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ ...body, model: c.model, ...(stream ? { stream: true } : {}) }),
    });
    return { res, controller, clear: () => clearTimeout(timer) };
  } catch (e) { clearTimeout(timer); throw e; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function json(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}
function text(res, code, body, type) {
  const buf = Buffer.from(body);
  res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { const e = new Error('body too large'); e.code = 'TOO_LARGE'; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authorized(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() === state.token;
}
const UI_FILE = path.join(ROOT, 'public', 'index.html');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const startedAt = Date.now();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;
  try {
    // Unauthenticated liveness probe for the supervisor.
    if (p === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, pid: process.pid, uptime: Math.floor((Date.now() - startedAt) / 1000),
        inflight, queue: waiters.length, limit: effectiveLimit(),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        keys: state.keys.filter((k) => k.enabled).length,
        openBreakers: state.keys.filter((k) => k.cb && k.cb.state === 'open').length,
      });
    }
    if (p === '/' || p === '/index.html') {
      if (!fs.existsSync(UI_FILE)) return text(res, 500, 'UI file missing');
      return text(res, 200, fs.readFileSync(UI_FILE, 'utf8').replace('__TOKEN__', state.token), 'text/html; charset=utf-8');
    }
    if (p === '/manifest.webmanifest') {
      const mf = path.join(ROOT, 'public', 'manifest.webmanifest');
      return fs.existsSync(mf) ? text(res, 200, fs.readFileSync(mf, 'utf8'), 'application/manifest+json') : json(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (p === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          endpoint: `http://${HOST}:${PORT}/v1`, token: state.token,
          keys: state.keys.map((k) => ({
            id: k.id, provider: k.provider, label: k.label || '', enabled: k.enabled,
            masked: k.key.slice(0, 4) + '…' + k.key.slice(-4),
            rpm: k.requests.min, rpd: k.requests.day, fails: k.fails,
            cooling: Math.max(0, Math.max(k.cooldownUntil, k.cb ? k.cb.openUntil : 0) - Date.now()),
            breaker: k.cb ? k.cb.state : 'closed', inflight: k.inflight, lastError: k.lastError || null,
          })),
          log: state.log.slice(0, 40), system: sysLog.slice(0, 30),
          load: { inflight, queue: waiters.length, limit: effectiveLimit(), shed: metrics.shed, queueTimeouts: metrics.queueTimeouts },
          catalog: Object.fromEntries(Object.entries(PROVIDERS).map(([id, v]) => [id, { name: v.name, rpm: v.rpm || null, rpd: v.rpd || null, models: v.models, keyHint: v.keyHint }])),
        });
      }
      if (p === '/api/metrics' && req.method === 'GET') {
        return json(res, 200, {
          uptime: Math.floor((Date.now() - metrics.started) / 1000),
          requests: metrics.requests, ok: metrics.ok, failed: metrics.failed, shed: metrics.shed,
          queueTimeouts: metrics.queueTimeouts, upstreamTimeouts: metrics.upstreamTimeouts,
          retries: metrics.retries, inflight, queue: waiters.length, limit: effectiveLimit(),
          latency: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
          providers: metrics.providers, system: sysLog.slice(0, 30),
        });
      }
      if (p === '/api/keys' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 65536));
        if (!PROVIDERS[b.provider] && b.provider !== 'custom') return json(res, 400, { error: 'unknown provider' });
        if (!b.key || typeof b.key !== 'string' || b.key.length > 4096) return json(res, 400, { error: 'valid key required' });
        if (state.keys.length >= 256) return json(res, 400, { error: 'key limit reached' });
        const k = { id: crypto.randomUUID().slice(0, 8), provider: b.provider, key: b.key.trim(), label: String(b.label || '').slice(0, 120), enabled: true, cooldownUntil: 0, fails: 0, requests: freshCounters(), cb: freshBreaker(), lastError: null, inflight: 0 };
        state.keys.push(k); persistNow(); addLog({ kind: 'key-added', provider: k.provider, id: k.id });
        return json(res, 200, { ok: true, id: k.id });
      }
      const km = p.match(/^\/api\/keys\/([a-z0-9-]+)$/);
      if (km) {
        const k = state.keys.find((x) => x.id === km[1]);
        if (!k) return json(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') { state.keys = state.keys.filter((x) => x !== k); persistNow(); return json(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const b = JSON.parse(await readBody(req, 65536));
          if (typeof b.enabled === 'boolean') k.enabled = b.enabled;
          if (b.cooldownUntil === 0) { k.cooldownUntil = 0; k.cb = freshBreaker(); }
          persistNow(); return json(res, 200, { ok: true });
        }
      }
      if (p === '/api/token' && req.method === 'POST') {
        state.token = crypto.randomBytes(18).toString('base64url');
        persistNow(); return json(res, 200, { ok: true, token: state.token });
      }
      return json(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/v1/')) {
      if (!authorized(req)) return json(res, 401, { error: { message: 'unauthorized', type: 'auth_error' } });
      if (p === '/v1/models' && req.method === 'GET') {
        const ids = new Set();
        for (const k of state.keys) { const pr = resolveProvider(k); if (pr) pr.models.forEach((m) => ids.add(m)); }
        Object.keys(ALIASES).forEach((id) => ids.add(id));
        return json(res, 200, { object: 'list', data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'logic-router' })) });
      }

      if (p === '/v1/chat/completions' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req, CFG.bodyLimit)); }
        catch (e) { return json(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: { message: e.code === 'TOO_LARGE' ? 'request body too large' : 'invalid JSON' } }); }
        if (!body || !Array.isArray(body.messages)) return json(res, 400, { error: { message: 'messages must be an array' } });

        let release;
        try { release = await acquireSlot(); }
        catch (e) {
          const overloaded = e.code === 'OVERLOAD' || e.code === 'QUEUE_TIMEOUT';
          res.setHeader('Retry-After', e.code === 'OVERLOAD' ? '2' : '1');
          return json(res, 503, { error: { message: e.message, type: e.code === 'OVERLOAD' ? 'overloaded' : 'queue_timeout' } });
        }
        const t0 = Date.now();
        metrics.requests++;
        const wantStream = !!body.stream;
        const payload = { ...body };
        delete payload.model; delete payload._droidrush; delete payload._keyId;
        const errors = [];
        try {
          const candidates = await waitForCandidate(typeof body.model === 'string' ? body.model : 'auto', CFG.queueTimeout);
          if (!candidates.length) {
            return json(res, 503, { error: { message: 'no available free provider/key. Add a key or wait for cooldown.', type: 'no_provider' } });
          }
          for (const c of candidates) {
            for (let attempt = 0; attempt <= CFG.retries; attempt++) {
              c.key.inflight++;
              let call;
              try { call = await callUpstream(c, payload, wantStream); }
              catch (e) {
                c.key.inflight--;
                const timeout = e.name === 'AbortError';
                if (timeout) metrics.upstreamTimeouts++;
                breakerFailure(c.key, timeout ? 10000 : 3000);
                providerStat(c.provider.name).fail++;
                errors.push(c.provider.name + ': ' + (timeout ? 'upstream timeout' : e.message));
                if (!timeout && attempt < CFG.retries) { metrics.retries++; await sleep(150 + jitter(300)); continue; }
                break;
              }
              try {
                const up = call.res;
                if (!up.ok) {
                  const detail = await up.text().catch(() => '');
                  const status = up.status;
                  const retryable = status === 429 || status >= 500;
                  const delay = parseRetryAfter(up);
                  breakerFailure(c.key, retryable ? delay : 5000);
                  providerStat(c.provider.name).fail++;
                  errors.push(`${c.provider.name} HTTP ${status}: ${detail.slice(0, 160)}`);
                  addLog({ kind: 'fail', provider: c.provider.name, model: c.model, status });
                  if (retryable && status >= 500 && attempt < CFG.retries) { metrics.retries++; await sleep(200 + jitter(400)); continue; }
                  break;
                }
                c.key.requests.min++; c.key.requests.hour++; c.key.requests.day++;
                breakerSuccess(c.key);
                providerStat(c.provider.name).ok++;
                addLog({ kind: 'ok', provider: c.provider.name, model: c.model, stream: wantStream });

                if (wantStream) {
                  call.clear();
                  res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-logic-router-provider': c.provider.name });
                  const reader = up.body.getReader();
                  let idle = setTimeout(() => { call.controller.abort(); slog('stream-idle', c.provider.name + ' stalled'); }, CFG.streamIdle);
                  const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => call.controller.abort(), CFG.streamIdle); };
                  try {
                    for (;;) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      resetIdle();
                      res.write(Buffer.from(value));
                    }
                  } catch (e) {
                    metrics.upstreamTimeouts++;
                    if (!res.writableEnded) res.write('data: {"error":{"message":"upstream stream interrupted"}}\n\ndata: [DONE]\n\n');
                  } finally {
                    clearTimeout(idle); reader.releaseLock(); res.end();
                  }
                  metrics.ok++; adapt(true);
                  return;
                }
                const result = await up.json();
                if (!result.usage) result.usage = {};
                result.usage.provider = c.provider.name;
                metrics.ok++; adapt(true);
                return json(res, 200, result);
              } finally {
                c.key.inflight--;
                call.clear();
              }
            }
          }
          metrics.failed++; adapt(false);
          return json(res, 502, { error: { message: 'all providers failed', type: 'upstream_error', details: errors } });
        } finally {
          recordLatency(Date.now() - t0);
          release();
        }
      }
      return json(res, 404, { error: { message: 'not found' } });
    }
    return text(res, 404, 'Logic Router: not found');
  } catch (e) {
    slog('request-error', e && e.message ? e.message : String(e));
    if (!res.headersSent) json(res, 500, { error: { message: e.message || 'internal error' } });
    else res.end();
  }
});

server.requestTimeout = CFG.upstreamTimeout + 10000;
server.headersTimeout = 20000;
server.keepAliveTimeout = 5000;
server.maxConnections = CFG.maxInflight + CFG.maxQueue + 128;

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.removeListener('error', reject); resolve(); });
  });
}
listen().then(() => {
  console.log(`Logic Router ready → http://${HOST}:${PORT}`);
  console.log(`UI: http://${HOST}:${PORT}/   Health: http://${HOST}:${PORT}/health`);
  console.log(`Limits: ${CFG.maxInflight} in flight, ${CFG.maxQueue} queued, ${CFG.keyInflight} per key`);
  console.log(`Local token: ${state.token}`);
}).catch((e) => { slog('listen-failed', e.message); process.exit(1); });

// Periodic maintenance: reset stale counters, log health, detect event-loop stalls.
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const drift = now - lastTick - CFG.healthInterval;
  lastTick = now;
  if (drift > 2000) slog('event-loop-stall', drift + 'ms behind schedule');
  for (const k of state.keys) {
    if (k.cb && k.cb.state === 'open' && now >= k.cb.openUntil) { k.cb.state = 'half'; k.cb.probes = 0; }
    if (k.cb && k.cb.state === 'half') k.cb.probes = 0;
  }
  if (process.memoryUsage().heapUsed > 512 * 1024 * 1024) slog('memory-high', 'heap above 512 MB');
}, CFG.healthInterval).unref();

// In-process recovery: survive unexpected exceptions without dropping the listener.
let healing = false;
async function selfHeal(reason) {
  if (healing) return;
  healing = true;
  slog('self-heal', reason);
  persistNow();
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(() => r()));
    await listen();
    slog('self-heal', 'listener restored');
  } catch (e) {
    slog('self-heal-failed', e.message);
    process.exit(1);
  } finally { healing = false; }
}
process.on('uncaughtException', (e) => { slog('uncaught', e.stack || e.message); selfHeal('uncaught exception'); });
process.on('unhandledRejection', (e) => slog('unhandled-rejection', (e && e.message) || String(e)));

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  persistNow();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

#!/usr/bin/env node
'use strict';
// Logic Router — minimal local LLM router with load control and self-healing.
// Zero npm dependencies. Free-tier providers only. Keys stay on your device.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
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
// Response cache, in-flight coalescing, usage accounting, runtime config
// ---------------------------------------------------------------------------
let CACHE_ENABLED = process.env.CACHE !== '0';
let CACHE_TTL = intEnv('CACHE_TTL_MS', 600000, 1000, 86400000);
let CACHE_MAX = intEnv('CACHE_MAX', 500, 1, 20000);
let CACHE_ENTRY_MAX = intEnv('CACHE_ENTRY_MAX', 524288, 1024, 8388608);
const ACCESS_LOG = process.env.ACCESS_LOG || ''; // optional JSONL access log

const cache = new Map();          // key -> entry (insertion order = LRU)
const inflightByKey = new Map();  // key -> shared promise for identical calls
const cacheStats = { hits: 0, misses: 0, coalesced: 0, stale: 0, stored: 0, evicted: 0, expired: 0, bytes: 0, savedTokens: 0 };

const USAGE_RATES = { // approximate list-price USD per 1M tokens, for "value saved" estimates only
  groq: { in: 0.5, out: 0.8 }, gemini: { in: 0.3, out: 1.2 }, openrouter: { in: 0.4, out: 1.5 },
  tokenharbor: { in: 0.3, out: 1.2 }, opentyphoon: { in: 0.2, out: 0.6 }, requesty: { in: 0.3, out: 1 },
  meganova: { in: 0.3, out: 1 }, kilo: { in: 0.3, out: 1 }, freeinference: { in: 0.3, out: 1 },
  radeon: { in: 0.3, out: 1 }, custom: { in: 0, out: 0 },
};
const PAID_RATE_IN = Number(process.env.PAID_RATE_IN || 2);   // USD per 1M input tokens (estimate only)
const PAID_RATE_OUT = Number(process.env.PAID_RATE_OUT || 8);  // USD per 1M output tokens (estimate only)
function freshUsage() { return { days: {}, providers: {}, users: {} }; }
function freshUserUsage() { return { days: {}, providers: {}, paid: { requests: 0, tokensIn: 0, tokensOut: 0, estCost: 0 } }; }
const today = () => new Date().toISOString().slice(0, 10);
function usageBucket(store) {
  const d = today();
  return store.days[d] || (store.days[d] = { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, estSaved: 0, cached: 0 });
}
function userUsage(id) {
  if (!state.usage) state.usage = freshUsage();
  if (!state.usage.users) state.usage.users = {};
  return state.usage.users[id] || (state.usage.users[id] = freshUserUsage());
}
function bumpUsage(store, provider, ok, tin, tout, saved) {
  const d = usageBucket(store);
  d.requests++; if (ok) d.ok++; else d.fail++;
  d.tokensIn += tin; d.tokensOut += tout; d.estSaved += saved;
  const pp = store.providers[provider] || (store.providers[provider] = { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, estSaved: 0 });
  pp.requests++; if (ok) pp.ok++; else pp.fail++;
  pp.tokensIn += tin; pp.tokensOut += tout; pp.estSaved += saved;
  const keys = Object.keys(store.days).sort();
  while (keys.length > 30) delete store.days[keys.shift()];
}
function recordUsage(actorId, provider, ok, usage, paid) {
  if (!state.usage) state.usage = freshUsage();
  const tin = Math.max(0, Number(usage && usage.prompt_tokens) || 0);
  const tout = Math.max(0, Number(usage && usage.completion_tokens) || 0);
  const rate = USAGE_RATES[provider] || USAGE_RATES.custom;
  const saved = (tin * rate.in + tout * rate.out) / 1e6;
  bumpUsage(state.usage, provider, ok, tin, tout, saved);
  const uu = userUsage(actorId);
  bumpUsage(uu, provider, ok, tin, tout, saved);
  if (paid) {
    uu.paid.requests++; uu.paid.tokensIn += tin; uu.paid.tokensOut += tout;
    uu.paid.estCost += (tin * PAID_RATE_IN + tout * PAID_RATE_OUT) / 1e6;
  }
  persist();
}
function recordCacheHit(entry, actorId, paid) {
  if (!state.usage) state.usage = freshUsage();
  usageBucket(state.usage).cached++;
  const rate = USAGE_RATES[entry.provider] || USAGE_RATES.custom;
  usageBucket(state.usage).estSaved += ((entry.tokensIn || 0) * rate.in + (entry.tokensOut || 0) * rate.out) / 1e6;
  const uu = userUsage(actorId);
  usageBucket(uu).cached++;
  if (paid) {
    uu.paid.requests++;
    uu.paid.tokensIn += entry.tokensIn || 0; uu.paid.tokensOut += entry.tokensOut || 0;
    uu.paid.estCost += ((entry.tokensIn || 0) * PAID_RATE_IN + (entry.tokensOut || 0) * PAID_RATE_OUT) / 1e6;
  }
  persist();
}
function cacheKey(model, body) {
  const material = JSON.stringify({ model, messages: body.messages, temperature: body.temperature, top_p: body.top_p, max_tokens: body.max_tokens, tools: body.tools, response_format: body.response_format });
  return crypto.createHash('sha256').update(material).digest('hex');
}
function cacheGet(key, actorId, paid) {
  const e = cache.get(key);
  if (!e) { cacheStats.misses++; return null; }
  if (Date.now() - e.stored > CACHE_TTL) {
    // Keep the entry: a later stale fallback may still serve it when upstreams fail.
    cacheStats.expired++; cacheStats.misses++;
    return null;
  }
  e.hits++;
  cacheStats.hits++;
  cache.delete(key); cache.set(key, e);
  cacheStats.savedTokens += (e.tokensIn || 0) + (e.tokensOut || 0);
  recordCacheHit(e, actorId, paid);
  return e;
}
function cacheGetStale(key) {
  const e = cache.get(key);
  if (!e || Date.now() - e.stored > CACHE_TTL * 3) return null;
  return e;
}
function cacheSet(key, value, meta) {
  if (!CACHE_ENABLED) return;
  const buf = Buffer.from(JSON.stringify(value));
  if (buf.length > CACHE_ENTRY_MAX) return;
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    const old = cache.get(oldest);
    cache.delete(oldest); cacheStats.bytes -= old.size; cacheStats.evicted++;
  }
  cache.set(key, { value, stored: Date.now(), hits: 0, size: buf.length, model: meta.model, provider: meta.provider, tokensIn: meta.tokensIn || 0, tokensOut: meta.tokensOut || 0 });
  cacheStats.bytes += buf.length; cacheStats.stored++;
}
function cacheSnapshot() {
  const entries = [...cache.entries()].slice(0, 25).map(([key, e]) => ({
    key: key.slice(0, 8), model: e.model, provider: e.provider,
    age: Date.now() - e.stored, hits: e.hits, size: e.size, tokensIn: e.tokensIn, tokensOut: e.tokensOut,
  }));
  return {
    enabled: CACHE_ENABLED, ttl: CACHE_TTL, max: CACHE_MAX, entries: cache.size,
    hits: cacheStats.hits, misses: cacheStats.misses, coalesced: cacheStats.coalesced,
    stale: cacheStats.stale, stored: cacheStats.stored, evicted: cacheStats.evicted,
    expired: cacheStats.expired, bytes: cacheStats.bytes, savedTokens: cacheStats.savedTokens,
    hitRate: cacheStats.hits + cacheStats.misses ? Math.round(cacheStats.hits / (cacheStats.hits + cacheStats.misses) * 1000) / 10 : 0,
    entriesPreview: entries,
  };
}
function accessLog(entry) {
  if (!ACCESS_LOG) return;
  try {
    const file = path.isAbsolute(ACCESS_LOG) ? ACCESS_LOG : path.join(ROOT, ACCESS_LOG);
    const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line);
  } catch {}
}

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
function freshState() { return { token: crypto.randomBytes(18).toString('base64url'), users: [], keys: [], log: [], usage: freshUsage() }; }
function freshUserCounters() { const n = Date.now(); return { minStamp: Math.floor(n / 60000), min: 0, dayStamp: new Date(n).toISOString().slice(0, 10), day: 0 }; }
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
if (!Array.isArray(state.users)) state.users = [];
if (!Array.isArray(state.log)) state.log = [];
if (!state.usage || typeof state.usage !== 'object') state.usage = freshUsage();
if (!state.usage.days) state.usage.days = {};
if (!state.usage.providers) state.usage.providers = {};
if (!state.usage.users) state.usage.users = {};
for (const u of state.users) {
  if (!u.counters) u.counters = freshUserCounters();
  if (u.rpmLimit == null) u.rpmLimit = 60;
  if (u.rpdLimit == null) u.rpdLimit = 2000;
  if (u.enabled == null) u.enabled = true;
}
for (const k of state.keys) {
  if (!k.requests) k.requests = freshCounters();
  if (!k.cb) k.cb = freshBreaker();
  if (k.cooldownUntil == null) k.cooldownUntil = 0;
  if (k.fails == null) k.fails = 0;
  if (k.enabled == null) k.enabled = true;
  if (!k.ownerId) k.ownerId = 'admin';
  if (!k.tier) k.tier = 'free';
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

function keyUsable(k, p, now, possible) {
  if (!k.enabled || !k.key) return false;
  if (!possible && k.inflight >= CFG.keyInflight) return false;
  const cb = k.cb || (k.cb = freshBreaker());
  if (cb.state === 'open') {
    if (now < cb.openUntil) return false;
    if (!possible) { cb.state = 'half'; cb.probes = 0; }
  } else if (!possible && cb.state === 'half' && cb.probes >= 1) return false;
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

// Local, zero-call task classifier. Scores are relative preferences, not facts.
const CAPS = {
  groq: { code: 0.8, reason: 0.6, vision: 0.2, cheap: 0.7, general: 0.8, speed: 1 },
  gemini: { code: 0.85, reason: 0.95, vision: 0.9, cheap: 0.6, general: 0.9, speed: 0.6 },
  openrouter: { code: 0.7, reason: 0.75, vision: 0.7, cheap: 0.6, general: 0.75, speed: 0.5 },
  tokenharbor: { code: 0.75, reason: 0.8, vision: 0.3, cheap: 0.7, general: 0.75, speed: 0.7 },
  opentyphoon: { code: 0.5, reason: 0.5, vision: 0.2, cheap: 0.8, general: 0.6, speed: 0.8 },
  requesty: { code: 0.7, reason: 0.7, vision: 0.5, cheap: 0.7, general: 0.7, speed: 0.6 },
  meganova: { code: 0.65, reason: 0.6, vision: 0.3, cheap: 0.7, general: 0.7, speed: 0.7 },
  kilo: { code: 0.7, reason: 0.7, vision: 0.6, cheap: 0.7, general: 0.7, speed: 0.6 },
  freeinference: { code: 0.9, reason: 0.9, vision: 0.3, cheap: 0.6, general: 0.8, speed: 0.6 },
  radeon: { code: 0.85, reason: 0.8, vision: 0.5, cheap: 0.6, general: 0.8, speed: 0.7 },
  custom: { code: 0.5, reason: 0.5, vision: 0.5, cheap: 0.5, general: 0.5, speed: 0.7 },
};
function taskOf(messages) {
  const text = (messages || []).map((m) => {
    if (Array.isArray(m.content)) return m.content.map((p) => p && p.type === 'text' ? (p.text || '') : '[image]').join(' ');
    return typeof m.content === 'string' ? m.content : '';
  }).join(' ').toLowerCase();
  if (/\[image\]|image_url|data:image|ocr|screenshot|vision/.test(text)) return 'vision';
  if (/```|\b(code|bug|function|refactor|compile|regex|python|javascript|typescript|typescript|git|stack trace|unit test|debug)\b/.test(text)) return 'code';
  if (/\b(why|prove|reason|analyze|trade-?off|architecture|deep|step by step|derive|compare|evaluate)\b/.test(text)) return 'reason';
  if (/\b(summarize|translate|rewrite|extract|list|short|brief| classify|tweet)\b/.test(text)) return 'cheap';
  return 'general';
}
function taskScore(c, task) {
  const caps = CAPS[c.key.provider] || CAPS.custom;
  let s = (caps[task] || 0.5) * 2 + (caps.general || 0.5) * 0.3;
  if (c.key.cb && c.key.cb.state === 'half') s -= 0.4;
  s -= Math.min(0.4, c.key.fails * 0.1);
  s -= Math.min(0.3, (c.key.requests.day / Math.max(1, c.provider.rpd || 1000)) * 0.3);
  return s;
}
function candidatesFor(model, task) {
  const alias = ALIASES[model];
  const target = alias === undefined ? model : alias;
  const tier = model === 'paid' ? 'paid' : 'free';
  const now = Date.now();
  const out = [];
  for (const k of state.keys) {
    if (k.tier !== tier) continue;
    const p = resolveProvider(k);
    if (!p || !keyUsable(k, p, now)) continue;
    if (target && p.models.length && !p.models.includes(target)) continue;
    if (k.cb && k.cb.state === 'half') k.cb.probes++;
    out.push({ key: k, provider: p, model: target || p.models[0] || 'gpt-4o-mini' });
  }
  out.sort((a, b) => {
    if (task && target == null) {
      const d = taskScore(b, task) - taskScore(a, task);
      if (Math.abs(d) > 0.01) return d;
    }
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

async function waitForCandidate(model, task, timeout) {
  const alias = ALIASES[model];
  const target = alias === undefined ? model : alias;
  const tier = model === 'paid' ? 'paid' : 'free';
  const deadline = Date.now() + Math.min(timeout, 10000);
  for (;;) {
    const ready = candidatesFor(model, task);
    if (ready.length) return ready;
    const now = Date.now();
    const possible = state.keys.some((k) => {
      if (k.tier !== tier) return false;
      const p = resolveProvider(k);
      if (!p || !keyUsable(k, p, now, true)) return false;
      return !target || !p.models.length || p.models.includes(target);
    });
    if (!possible || now >= deadline) return [];
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
    let size = 0, tooLarge = false; const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return; // keep draining so we can answer 413 cleanly
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!tooLarge) reject(e); });
  });
}
function tokenOf(req) { return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); }
function authOf(req) {
  const t = tokenOf(req);
  if (!t) return null;
  if (t === state.token) return { admin: true, id: 'admin', user: null };
  const u = state.users.find((x) => x.token === t && x.enabled !== false);
  return u ? { admin: false, id: u.id, user: u } : null;
}
function quotaCheck(auth) {
  if (auth.admin) return null;
  const u = auth.user, r = u.counters;
  const now = Date.now();
  const minStamp = Math.floor(now / 60000), dayStamp = new Date(now).toISOString().slice(0, 10);
  if (r.minStamp !== minStamp) { r.minStamp = minStamp; r.min = 0; }
  if (r.dayStamp !== dayStamp) { r.dayStamp = dayStamp; r.day = 0; }
  const rpm = Math.max(1, Number(u.rpmLimit) || 60), rpd = Math.max(1, Number(u.rpdLimit) || 2000);
  if (r.min >= rpm) return { retry: 60, type: 'user_rpm_exceeded' };
  if (r.day >= rpd) return { retry: Math.max(60, 86400 - Math.floor((now % 86400000) / 1000)), type: 'user_rpd_exceeded' };
  r.min++; r.day++;
  persist();
  return null;
}
function keyView(k, admin) {
  return {
    id: k.id, ownerId: k.ownerId || 'admin', tier: k.tier || 'free', provider: k.provider,
    label: k.label || '', enabled: k.enabled,
    masked: String(k.key).slice(0, 4) + '…' + String(k.key).slice(-4),
    rpm: k.requests.min, rpd: k.requests.day, fails: k.fails,
    cooling: Math.max(0, Math.max(k.cooldownUntil, k.cb ? k.cb.openUntil : 0) - Date.now()),
    breaker: k.cb ? k.cb.state : 'closed', lastError: k.lastError || null,
  };
}
function userView(u, includeToken) {
  const out = { id: u.id, name: u.name, rpmLimit: u.rpmLimit, rpdLimit: u.rpdLimit, enabled: u.enabled !== false, created: u.created, usedMin: u.counters.min || 0, usedDay: u.counters.day || 0, keys: state.keys.filter((k) => k.ownerId === u.id).length };
  if (includeToken) out.token = u.token;
  return out;
}
const UI_FILE = path.join(ROOT, 'public', 'index.html');

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const startedAt = Date.now();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const p = url.pathname;
  const rid = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64) || crypto.randomUUID().slice(0, 12);
  res.setHeader('x-request-id', rid);
  try {
    // Unauthenticated liveness probe for the supervisor.
    if (p === '/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true, pid: process.pid, uptime: Math.floor((Date.now() - startedAt) / 1000),
        inflight, queue: waiters.length, limit: effectiveLimit(),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        keys: state.keys.filter((k) => k.enabled).length,
        openBreakers: state.keys.filter((k) => k.cb && k.cb.state === 'open').length,
        cache: { enabled: CACHE_ENABLED, entries: cache.size, hitRate: cacheSnapshot().hitRate },
        requestsToday: (state.usage.days[today()] || {}).requests || 0,
      });
    }
    if (p === '/' || p === '/index.html') {
      if (!fs.existsSync(UI_FILE)) return text(res, 500, 'UI file missing');
      return text(res, 200, fs.readFileSync(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (p === '/manifest.webmanifest') {
      const mf = path.join(ROOT, 'public', 'manifest.webmanifest');
      return fs.existsSync(mf) ? text(res, 200, fs.readFileSync(mf, 'utf8'), 'application/manifest+json') : json(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/api/')) {
      const auth = authOf(req);
      if (!auth) return json(res, 401, { error: 'unauthorized' });
      const mine = (k) => auth.admin || k.ownerId === auth.id;
      if (p === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          endpoint: `http://${HOST}:${PORT}/v1`,
          identity: { id: auth.id, admin: auth.admin, name: auth.admin ? 'admin' : auth.user.name },
          quota: auth.admin ? null : { rpmLimit: auth.user.rpmLimit, rpdLimit: auth.user.rpdLimit, usedMin: auth.user.counters.min, usedDay: auth.user.counters.day },
          keys: state.keys.filter(mine).map((k) => keyView(k, auth.admin)),
          users: auth.admin ? state.users.map((u) => userView(u, true)) : undefined,
          log: state.log.filter((l) => auth.admin || !l.ownerId || l.ownerId === auth.id).slice(0, 40),
          system: auth.admin ? sysLog.slice(0, 30) : undefined,
          load: { inflight, queue: waiters.length, limit: effectiveLimit(), shed: metrics.shed, queueTimeouts: metrics.queueTimeouts },
          catalog: Object.fromEntries(Object.entries(PROVIDERS).map(([id, v]) => [id, { name: v.name, rpm: v.rpm || null, rpd: v.rpd || null, models: v.models, keyHint: v.keyHint }])),
        });
      }
      if (p === '/api/metrics' && req.method === 'GET') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        return json(res, 200, {
          uptime: Math.floor((Date.now() - metrics.started) / 1000),
          requests: metrics.requests, ok: metrics.ok, failed: metrics.failed, shed: metrics.shed,
          queueTimeouts: metrics.queueTimeouts, upstreamTimeouts: metrics.upstreamTimeouts,
          retries: metrics.retries, inflight, queue: waiters.length, limit: effectiveLimit(),
          latency: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
          providers: metrics.providers, cache: cacheSnapshot(), usageToday: state.usage.days[today()] || null,
          system: sysLog.slice(0, 30),
        });
      }
      if (p === '/api/cache' && req.method === 'GET') return json(res, 200, cacheSnapshot());
      if (p === '/api/cache/clear' && req.method === 'POST') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        cache.clear(); cacheStats.bytes = 0; cacheStats.stored = 0; cacheStats.hits = 0; cacheStats.misses = 0; cacheStats.savedTokens = 0;
        slog('cache-cleared', 'manual');
        return json(res, 200, { ok: true });
      }
      if (p === '/api/usage' && req.method === 'GET') {
        const store = auth.admin ? state.usage : userUsage(auth.id);
        const days = Object.entries(store.days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7).map(([day, v]) => ({ day, ...v }));
        const totals = days.reduce((a, d) => { for (const k of ['requests', 'ok', 'fail', 'tokensIn', 'tokensOut', 'estSaved', 'cached']) a[k] += d[k] || 0; return a; }, { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, estSaved: 0, cached: 0 });
        return json(res, 200, {
          scope: auth.id, days, providers: store.providers, totals,
          quota: auth.admin ? null : { rpmLimit: auth.user.rpmLimit, rpdLimit: auth.user.rpdLimit, usedMin: auth.user.counters.min, usedDay: auth.user.counters.day },
          users: auth.admin ? state.users.map((u) => ({ id: u.id, name: u.name, paid: userUsage(u.id).paid, usedDay: u.counters.day })) : undefined,
          note: 'estSaved uses approximate list-price rates, not billed amounts.',
        });
      }
      if (p === '/api/billing' && req.method === 'GET') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        return json(res, 200, {
          rates: { in: PAID_RATE_IN, out: PAID_RATE_OUT, unit: 'USD per 1M tokens (estimate)' },
          users: state.users.map((u) => ({ id: u.id, name: u.name, ...userUsage(u.id).paid })),
          total: state.users.reduce((a, u) => { const p = userUsage(u.id).paid; a.requests += p.requests; a.tokensIn += p.tokensIn; a.tokensOut += p.tokensOut; a.estCost += p.estCost; return a; }, { requests: 0, tokensIn: 0, tokensOut: 0, estCost: 0 }),
        });
      }
      if (p === '/api/config' && req.method === 'GET') {
        return json(res, 200, { cacheEnabled: CACHE_ENABLED, cacheTtl: CACHE_TTL, cacheMax: CACHE_MAX, maxInflight: CFG.maxInflight, maxQueue: CFG.maxQueue, keyInflight: CFG.keyInflight, retries: CFG.retries, breakerThreshold: CFG.breakerThreshold, upstreamTimeout: CFG.upstreamTimeout });
      }
      if (p === '/api/config' && req.method === 'PATCH') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        let b;
        try { b = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        if (!b || typeof b !== 'object' || Array.isArray(b)) return json(res, 400, { error: 'object required' });
        const num = (v, fallback, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; };
        if (typeof b.cacheEnabled === 'boolean') CACHE_ENABLED = b.cacheEnabled;
        if (b.cacheTtl != null) CACHE_TTL = num(b.cacheTtl, CACHE_TTL, 1000, 86400000);
        if (b.cacheMax != null) CACHE_MAX = num(b.cacheMax, CACHE_MAX, 1, 20000);
        if (b.maxInflight != null) CFG.maxInflight = num(b.maxInflight, CFG.maxInflight, 4, 512);
        if (b.keyInflight != null) CFG.keyInflight = num(b.keyInflight, CFG.keyInflight, 1, 64);
        if (b.retries != null) CFG.retries = num(b.retries, CFG.retries, 0, 3);
        if (b.breakerThreshold != null) CFG.breakerThreshold = num(b.breakerThreshold, CFG.breakerThreshold, 1, 20);
        dynamicLimit = Math.min(dynamicLimit, CFG.maxInflight);
        slog('config-updated', JSON.stringify(b));
        return json(res, 200, { ok: true });
      }
      if (p === '/api/users' && req.method === 'GET') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        return json(res, 200, { users: state.users.map((u) => userView(u, true)) });
      }
      if (p === '/api/users' && req.method === 'POST') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        let b; try { b = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        const name = String(b.name || '').trim().slice(0, 40);
        if (!name) return json(res, 400, { error: 'name required' });
        if (state.users.length >= 200) return json(res, 400, { error: 'user limit reached' });
        const num = (v, f, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : f; };
        const u = { id: crypto.randomUUID().slice(0, 8), name, token: crypto.randomBytes(18).toString('base64url'), rpmLimit: num(b.rpmLimit, 60, 1, 10000), rpdLimit: num(b.rpdLimit, 2000, 1, 1000000), enabled: true, created: new Date().toISOString(), counters: freshUserCounters() };
        state.users.push(u); persistNow(); addLog({ kind: 'user-added', name: u.name, id: u.id });
        return json(res, 200, { ok: true, user: userView(u, true) });
      }
      const um = p.match(/^\/api\/users\/([a-z0-9-]+)(\/token)?$/);
      if (um) {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        const u = state.users.find((x) => x.id === um[1]);
        if (!u) return json(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') {
          state.users = state.users.filter((x) => x !== u);
          state.keys = state.keys.filter((k) => k.ownerId !== u.id);
          delete state.usage.users[u.id];
          persistNow(); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && um[2]) {
          u.token = crypto.randomBytes(18).toString('base64url');
          persistNow(); return json(res, 200, { ok: true, token: u.token });
        }
        if (req.method === 'PATCH') {
          const b = JSON.parse(await readBody(req, 65536));
          const num = (v, f, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : f; };
          if (b.rpmLimit != null) u.rpmLimit = num(b.rpmLimit, u.rpmLimit, 1, 10000);
          if (b.rpdLimit != null) u.rpdLimit = num(b.rpdLimit, u.rpdLimit, 1, 1000000);
          if (typeof b.enabled === 'boolean') u.enabled = b.enabled;
          if (b.name) u.name = String(b.name).trim().slice(0, 40) || u.name;
          persistNow(); return json(res, 200, { ok: true, user: userView(u, true) });
        }
      }
      if (p === '/api/keys' && req.method === 'POST') {
        let b; try { b = JSON.parse(await readBody(req, 65536)); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        if (!PROVIDERS[b.provider] && b.provider !== 'custom') return json(res, 400, { error: 'unknown provider' });
        if (!b.key || typeof b.key !== 'string' || b.key.length > 4096) return json(res, 400, { error: 'valid key required' });
        if (state.keys.length >= 1000) return json(res, 400, { error: 'key limit reached' });
        const tier = auth.admin && b.tier === 'paid' ? 'paid' : 'free';
        const k = { id: crypto.randomUUID().slice(0, 8), ownerId: auth.admin ? (b.ownerId || 'admin') : auth.id, tier, provider: b.provider, key: b.key.trim(), label: String(b.label || '').slice(0, 120), enabled: true, cooldownUntil: 0, fails: 0, requests: freshCounters(), cb: freshBreaker(), lastError: null, inflight: 0 };
        state.keys.push(k); persistNow(); addLog({ kind: 'key-added', provider: k.provider, id: k.id, ownerId: k.ownerId });
        return json(res, 200, { ok: true, id: k.id });
      }
      const km = p.match(/^\/api\/keys\/([a-z0-9-]+)$/);
      if (km) {
        const k = state.keys.find((x) => x.id === km[1]);
        if (!k || !mine(k)) return json(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') { state.keys = state.keys.filter((x) => x !== k); persistNow(); return json(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const b = JSON.parse(await readBody(req, 65536));
          if (typeof b.enabled === 'boolean') k.enabled = b.enabled;
          if (b.cooldownUntil === 0) { k.cooldownUntil = 0; k.cb = freshBreaker(); }
          persistNow(); return json(res, 200, { ok: true });
        }
      }
      if (p === '/api/token' && req.method === 'POST') {
        if (!auth.admin) return json(res, 403, { error: 'admin only' });
        state.token = crypto.randomBytes(18).toString('base64url');
        persistNow(); return json(res, 200, { ok: true, token: state.token });
      }
      return json(res, 404, { error: 'not found' });
    }

    if (p.startsWith('/v1/')) {
      const auth = authOf(req);
      if (!auth) return json(res, 401, { error: { message: 'unauthorized', type: 'auth_error' } });
      if (p === '/v1/models' && req.method === 'GET') {
        const ids = auth.admin ? new Set(['auto', 'paid']) : new Set(['auto', 'paid']);
        if (auth.admin) {
          for (const k of state.keys) { const pr = resolveProvider(k); if (pr) pr.models.forEach((m) => ids.add(m)); }
          Object.keys(ALIASES).forEach((id) => ids.add(id));
        }
        return json(res, 200, { object: 'list', data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'logic-router', description: id === 'paid' ? 'owner-paid route, usage logged' : id === 'auto' ? 'smart free pool' : undefined })) });
      }

      if (p === '/v1/chat/completions' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req, CFG.bodyLimit)); }
        catch (e) { return json(res, e.code === 'TOO_LARGE' ? 413 : 400, { error: { message: e.code === 'TOO_LARGE' ? 'request body too large' : 'invalid JSON' } }); }
        if (!body || !Array.isArray(body.messages)) return json(res, 400, { error: { message: 'messages must be an array' } });

        const requested = typeof body.model === 'string' ? body.model : 'auto';
        if (!auth.admin && requested !== 'auto' && requested !== 'paid') {
          return json(res, 403, { error: { message: 'only auto and paid models are available', type: 'model_forbidden' } });
        }
        const q = quotaCheck(auth);
        if (q) {
          res.setHeader('Retry-After', String(q.retry));
          return json(res, 429, { error: { message: 'quota exceeded', type: q.type } });
        }
        const paid = requested === 'paid';
        const task = requested === 'auto' ? taskOf(body.messages) : null;
        res.setHeader('x-logic-router-task', task || 'exact');
        const wantStream = !!body.stream;
        const noCache = body.cache === false || (body.cache_control && body.cache_control.type === 'no-cache');
        delete body.cache; delete body.cache_control;
        const ckey = cacheKey(requested, body);
        const cacheable = CACHE_ENABLED && !wantStream && !noCache;

        if (cacheable) {
          const hit = cacheGet(ckey, auth.id, paid);
          if (hit) {
            metrics.requests++; metrics.ok++; recordLatency(0);
            res.setHeader('x-logic-router-cache', 'HIT');
            accessLog({ rid, ownerId: auth.id, status: 200, cache: 'HIT', model: requested });
            return json(res, 200, hit.value);
          }
          const pending = inflightByKey.get(ckey);
          if (pending) {
            const shared = await pending.promise;
            if (shared) {
              metrics.requests++; metrics.ok++; cacheStats.coalesced++;
              res.setHeader('x-logic-router-cache', 'COALESCED');
              accessLog({ rid, ownerId: auth.id, status: 200, cache: 'COALESCED', model: requested });
              return json(res, 200, shared);
            }
          }
        }

        let shared = null;
        if (cacheable) {
          shared = { resolve: null, promise: null };
          shared.promise = new Promise((r) => { shared.resolve = r; });
          inflightByKey.set(ckey, shared);
        }
        let release;
        try { release = await acquireSlot(); }
        catch (e) {
          if (shared) { inflightByKey.delete(ckey); shared.resolve(null); }
          const overloaded = e.code === 'OVERLOAD' || e.code === 'QUEUE_TIMEOUT';
          res.setHeader('Retry-After', e.code === 'OVERLOAD' ? '2' : '1');
          return json(res, 503, { error: { message: e.message, type: e.code === 'OVERLOAD' ? 'overloaded' : 'queue_timeout' } });
        }
        const t0 = Date.now();
        metrics.requests++;
        const payload = { ...body };
        delete payload.model; delete payload._droidrush; delete payload._keyId;
        const errors = [];
        try {
          const candidates = await waitForCandidate(requested, task, CFG.queueTimeout);
          if (!candidates.length) {
            if (cacheable) {
              const stale = cacheGetStale(ckey);
              if (stale) {
                cacheStats.stale++;
                res.setHeader('x-logic-router-cache', 'STALE');
                accessLog({ rid, ownerId: auth.id, status: 200, cache: 'STALE', model: requested });
                if (shared) shared.resolve(stale.value);
                return json(res, 200, stale.value);
              }
            }
            return json(res, 503, { error: { message: paid ? 'no paid route configured. Ask the admin to add a paid key.' : 'no available free provider/key. Add a key or wait for cooldown.', type: paid ? 'no_paid_route' : 'no_provider' } });
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
                recordUsage(auth.id, c.provider.name, false, null, paid);
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
                  recordUsage(auth.id, c.provider.name, false, null, paid);
                  errors.push(`${c.provider.name} HTTP ${status}: ${detail.slice(0, 160)}`);
                  addLog({ kind: 'fail', provider: c.provider.name, model: c.model, status, rid, ownerId: auth.id, task });
                  if (retryable && status >= 500 && attempt < CFG.retries) { metrics.retries++; await sleep(200 + jitter(400)); continue; }
                  break;
                }
                c.key.requests.min++; c.key.requests.hour++; c.key.requests.day++;
                breakerSuccess(c.key);
                providerStat(c.provider.name).ok++;
                addLog({ kind: 'ok', provider: c.provider.name, model: c.model, stream: wantStream, rid, ownerId: auth.id, task });

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
                  recordUsage(auth.id, c.provider.name, true, null, paid);
                  accessLog({ rid, ownerId: auth.id, status: 200, provider: c.provider.name, model: c.model, stream: true, ms: Date.now() - t0 });
                  metrics.ok++; adapt(true);
                  return;
                }
                const result = await up.json();
                const tin = Math.max(0, Number(result.usage && result.usage.prompt_tokens) || 0);
                const tout = Math.max(0, Number(result.usage && result.usage.completion_tokens) || 0);
                if (!result.usage) result.usage = {};
                result.usage.provider = c.provider.name;
                cacheSet(ckey, result, { model: c.model, provider: c.provider.name, tokensIn: tin, tokensOut: tout });
                recordUsage(auth.id, c.provider.name, true, result.usage, paid);
                accessLog({ rid, ownerId: auth.id, status: 200, provider: c.provider.name, model: c.model, ms: Date.now() - t0, tokensIn: tin, tokensOut: tout });
                if (shared) shared.resolve(result);
                metrics.ok++; adapt(true);
                return json(res, 200, result);
              } finally {
                c.key.inflight--;
                call.clear();
              }
            }
          }
          if (cacheable) {
            const stale = cacheGetStale(ckey);
            if (stale) {
              cacheStats.stale++;
              res.setHeader('x-logic-router-cache', 'STALE');
              if (shared) shared.resolve(stale.value);
              return json(res, 200, stale.value);
            }
          }
          if (shared) shared.resolve(null);
          metrics.failed++; adapt(false);
          accessLog({ rid, ownerId: auth.id, status: 502, errors: errors.length, ms: Date.now() - t0 });
          return json(res, 502, { error: { message: 'all providers failed', type: 'upstream_error', details: errors } });
        } finally {
          if (shared && inflightByKey.get(ckey) === shared) { inflightByKey.delete(ckey); shared.resolve(null); }
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

#!/usr/bin/env node
'use strict';
// Logic Router — a minimal local LLM router for Android/Termux.
// Zero npm dependencies. Free-tier providers only. Keys stay on your device.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const PORT = Number(process.env.PORT || 20129);
const HOST = process.env.HOST || '127.0.0.1'; // never expose publicly

// ---------------------------------------------------------------------------
// Provider catalog (free tiers only, no one-time credits, checked 2026-11-23)
// ---------------------------------------------------------------------------
const PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000,
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile'],
    keyHint: 'console.groq.com/keys',
  },
  gemini: {
    name: 'Google AI Studio',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    rpm: 15, rpd: 1000,
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'],
    keyHint: 'aistudio.google.com/apikey',
  },
  openrouter: {
    name: 'OpenRouter :free',
    baseUrl: 'https://openrouter.ai/api/v1',
    rpm: 20, rpd: 50, // 1000 after $10 lifetime credit
    models: ['openrouter/free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'inclusionai/ling-3.2-flash:free'],
    keyHint: 'openrouter.ai/keys',
  },
  tokenharbor: {
    name: 'Token Harbor',
    baseUrl: 'https://tokenharbor.ai/v1',
    rpm: 60, rph: 1800, // rolling 7-day value allowance
    models: ['deepseek-v4.1-flash:free', 'mimo-v2.6-flash:free'],
    keyHint: 'tokenharbor.ai',
  },
  opentyphoon: {
    name: 'OpenTyphoon',
    baseUrl: 'https://api.opentyphoon.ai/v1',
    rpm: 200, // 5 req/s, no daily cap published
    models: ['typhoon-v2.5-30b-a3b-instruct'],
    keyHint: 'playground.opentyphoon.ai/api-key',
  },
  requesty: {
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    rpm: 20, rpd: 200,
    models: ['google/gemma-4-31b-it', 'mistral/leanstral-1-5', 'novita/ling-3.1-flash', 'nvidia/nemotron-3-ultra-550b-a55b'],
    keyHint: 'requesty.ai',
  },
  meganova: {
    name: 'MegaNova AI',
    baseUrl: 'https://api.meganova.ai/v1',
    rpm: 60, rpd: 50, // per model; varies 20-200 RPM / 50-500 RPD
    models: ['meganova-ai/manta-mini-1.0', 'meganova-ai/manta-flash-1.0', 'mistralai/Mistral-Small-3.2-24B-Instruct-2506'],
    keyHint: 'meganova.ai',
  },
  kilo: {
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    rph: 200, // per IP, anonymous allowed
    models: ['kilo-auto/free', 'openrouter/free', 'nvidia/nemotron-3-ultra-550b-a55b:free'],
    keyHint: 'kilo.ai/gateway',
  },
  freeinference: {
    name: 'FreeInference (Harvard)',
    baseUrl: 'https://freeinference.org/v1',
    models: ['glm-5.3-flash', 'deepseek-v4-flash', 'minimax-m3', 'qwen3.6-35b'],
    keyHint: 'freeinference.org',
  },
  radeon: {
    name: 'AMD Radeon Cloud',
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    rpm: 30, // per key; 20/min per account, 120/min per IP
    models: ['DeepSeek-V4.1-Flash', 'GLM-5.3-Flash', 'Qwen3.8-Flash-Next', 'MiMo-V2.6-Flash'],
    keyHint: 'developer.amd.com.cn/radeon/tokenfactory (China site)',
  },
};

const MODEL_ALIASES = {
  'auto': null,
  'free': 'openrouter/free',
  'fast': 'openai/gpt-oss-120b',
  'smart': 'gemini-3.8-flash',
  'coder': 'mimo-v2.6-flash:free',
};

// ---------------------------------------------------------------------------
// State: { token, keys: [{id, provider, key, label, enabled, cooldownUntil,
//   requests:{min,hour,day,dayStamp,minStamp,hourStamp}, fails, lastError}], log: [] }
// ---------------------------------------------------------------------------
function freshState() {
  return { token: crypto.randomBytes(18).toString('base64url'), keys: [], log: [] };
}
let state = freshState();
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...freshState(), ...saved };
    if (!Array.isArray(state.keys)) state.keys = [];
    if (!Array.isArray(state.log)) state.log = [];
  }
} catch (e) {
  console.error('[logic-router] state load failed:', e.message);
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error('[logic-router] state save failed:', e.message);
    }
  }, 150);
}

function newKeyCounters() {
  const now = Date.now();
  return {
    minStamp: Math.floor(now / 60000), min: 0,
    hourStamp: Math.floor(now / 3600000), hour: 0,
    dayStamp: new Date().toISOString().slice(0, 10), day: 0,
    rpm: 0, rph: 0, tpm: 0, tpd: 0,
  };
}
for (const k of state.keys) {
  if (!k.requests) k.requests = newKeyCounters();
  if (k.cooldownUntil == null) k.cooldownUntil = 0;
  if (k.fails == null) k.fails = 0;
  if (k.enabled == null) k.enabled = true;
}

function addLog(entry) {
  state.log.unshift({ t: new Date().toISOString(), ...entry });
  if (state.log.length > 80) state.log.length = 80;
  persist();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function providerOf(id) { return PROVIDERS[id] || null; }

function keyUsable(k, provider, now) {
  if (!k.enabled || !k.key) return false;
  if (k.cooldownUntil > now) return false;
  const r = k.requests || {};
  const minStamp = Math.floor(now / 60000);
  const hourStamp = Math.floor(now / 3600000);
  const dayStamp = new Date(now).toISOString().slice(0, 10);
  if (r.minStamp !== minStamp) { r.minStamp = minStamp; r.min = 0; r.rpm = 0; }
  if (r.hourStamp !== hourStamp) { r.hourStamp = hourStamp; r.hour = 0; r.rph = 0; }
  if (r.dayStamp !== dayStamp) { r.dayStamp = dayStamp; r.day = 0; r.tpd = 0; }
  const capRpm = provider.rpm || Infinity;
  const capRph = provider.rph || (provider.rpm ? provider.rpm * 60 : Infinity);
  const capRpd = provider.rpd || Infinity;
  if (r.min >= capRpm) return false;
  if (r.hour >= capRph) return false;
  if (r.day >= capRpd) return false;
  return true;
}

function bumpKey(k, ok) {
  const r = k.requests;
  r.min++; r.hour++; r.day++;
  if (!ok) k.fails++;
}

function cooldown(k, ms) {
  k.cooldownUntil = Date.now() + Math.max(1000, Math.min(ms || 60000, 6 * 3600000));
  k.lastError = new Date().toISOString();
}

function parseRetryAfter(res) {
  const h = res.headers.get('retry-after');
  if (!h) return 60000;
  const n = Number(h);
  return Number.isFinite(n) ? n * 1000 : (Date.parse(h) - Date.now()) || 60000;
}

function stripCustomFields(body) {
  const out = { ...body };
  delete out._logic-router;
  delete out._keyId;
  return out;
}

function pickCandidates(requestedModel) {
  const alias = MODEL_ALIASES[requestedModel];
  const target = alias === undefined ? requestedModel : alias;
  const ready = [];
  for (const k of state.keys) {
    let p = providerOf(k.provider);
    if (k.provider === 'custom' && k.label) {
      const base = /^https?:\/\//.test(k.label) ? k.label : 'https://' + k.label;
      p = { name: 'Custom', baseUrl: base.replace(/\/$/, ''), models: [] };
    }
    if (!p) continue;
    if (!keyUsable(k, p, Date.now())) continue;
    if (target && p.models.length && !p.models.includes(target)) continue;
    ready.push({ key: k, provider: p, model: target || p.models[0] || 'gpt-4o-mini' });
  }
  // Prefer keys with fewest failures, then most remaining daily quota.
  ready.sort((a, b) => {
    if (a.key.fails !== b.key.fails) return a.key.fails - b.key.fails;
    const pa = a.provider.rpd ? 1 - (a.key.requests.day / a.provider.rpd) : 1;
    const pb = b.provider.rpd ? 1 - (b.key.requests.day / b.provider.rpd) : 1;
    return pb - pa;
  });
  return ready;
}

async function callUpstream(candidate, body, wantStream) {
  const headers = {
    'content-type': 'application/json',
    'authorization': 'Bearer ' + candidate.key.key,
  };
  if (candidate.provider.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'http://localhost:' + PORT;
    headers['X-Title'] = 'Logic Router';
  }
  const payload = { ...body, model: candidate.model };
  if (wantStream) payload.stream = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let upstream;
  try {
    upstream = await fetch(candidate.provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  return upstream;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function json(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}
function text(res, code, body, type) {
  const buf = Buffer.from(body);
  res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function authorized(req) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  return token === state.token;
}

const UI_FILE = path.join(ROOT, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const pathname = url.pathname;
  try {
    // ---- public UI ----
    if (pathname === '/' || pathname === '/index.html') {
      if (!fs.existsSync(UI_FILE)) return text(res, 500, 'UI file missing');
      const html = fs.readFileSync(UI_FILE, 'utf8').replace('__TOKEN__', state.token);
      return text(res, 200, html, 'text/html; charset=utf-8');
    }
    if (pathname === '/manifest.webmanifest') {
      const mf = path.join(ROOT, 'public', 'manifest.webmanifest');
      if (!fs.existsSync(mf)) return json(res, 404, { error: 'not found' });
      return text(res, 200, fs.readFileSync(mf, 'utf8'), 'application/manifest+json');
    }

    // ---- local dashboard API (token protected) ----
    if (pathname.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
      if (pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, {
          endpoint: `http://${HOST}:${PORT}/v1`,
          token: state.token,
          keys: state.keys.map((k) => ({
            id: k.id, provider: k.provider, label: k.label || '', enabled: k.enabled,
            masked: k.key.slice(0, 4) + '…' + k.key.slice(-4),
            rpm: k.requests.min, rpd: k.requests.day, fails: k.fails,
            cooling: Math.max(0, k.cooldownUntil - Date.now()),
            lastError: k.lastError || null,
          })),
          log: state.log.slice(0, 40),
          catalog: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, {
            name: p.name, rpm: p.rpm || null, rpd: p.rpd || null, models: p.models, keyHint: p.keyHint,
          }])),
        });
      }
      if (pathname === '/api/keys' && req.method === 'POST') {
        const b = JSON.parse(await readBody(req));
        if (!PROVIDERS[b.provider] && b.provider !== 'custom') return json(res, 400, { error: 'unknown provider' });
        if (!b.key || typeof b.key !== 'string') return json(res, 400, { error: 'key required' });
        const k = {
          id: crypto.randomUUID().slice(0, 8), provider: b.provider, key: b.key.trim(),
          label: String(b.label || '').slice(0, 40), enabled: true,
          cooldownUntil: 0, fails: 0, requests: newKeyCounters(), lastError: null,
        };
        state.keys.push(k);
        persist();
        addLog({ kind: 'key-added', provider: k.provider, id: k.id });
        return json(res, 200, { ok: true, id: k.id });
      }
      const keyMatch = pathname.match(/^\/api\/keys\/([a-z0-9-]+)$/);
      if (keyMatch) {
        const k = state.keys.find((x) => x.id === keyMatch[1]);
        if (!k) return json(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') {
          state.keys = state.keys.filter((x) => x.id !== k.id);
          persist();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'PATCH') {
          const b = JSON.parse(await readBody(req));
          if (typeof b.enabled === 'boolean') k.enabled = b.enabled;
          if (b.cooldownUntil === 0) k.cooldownUntil = 0;
          persist();
          return json(res, 200, { ok: true });
        }
      }
      if (pathname === '/api/token' && req.method === 'POST') {
        state.token = crypto.randomBytes(18).toString('base64url');
        persist();
        return json(res, 200, { ok: true, token: state.token });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- OpenAI-compatible API ----
    if (pathname.startsWith('/v1/')) {
      if (!authorized(req)) return json(res, 401, { error: { message: 'unauthorized', type: 'auth_error' } });

      if (pathname === '/v1/models' && req.method === 'GET') {
        const ids = new Set();
        for (const k of state.keys) {
          const p = providerOf(k.provider);
          if (p) p.models.forEach((m) => ids.add(m));
        }
        Object.keys(MODEL_ALIASES).forEach((m) => ids.add(m));
        return json(res, 200, {
          object: 'list',
          data: [...ids].map((id) => ({ id, object: 'model', owned_by: 'logic-router' })),
        });
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: { message: 'invalid JSON' } }); }
        if (!body || !Array.isArray(body.messages)) {
          return json(res, 400, { error: { message: 'messages must be an array' } });
        }
        const requested = typeof body.model === 'string' ? body.model : 'auto';
        const wantStream = !!body.stream;
        const cleanBody = stripCustomFields(body);
        delete cleanBody.model;
        const candidates = pickCandidates(requested);
        if (!candidates.length) {
          return json(res, 503, { error: { message: 'no available free provider/key. Add a key in the web UI, or wait for cooldown to reset.', type: 'no_provider' } });
        }
        const errors = [];
        for (const c of candidates) {
          let upstream;
          try {
            upstream = await callUpstream(c, cleanBody, wantStream);
          } catch (e) {
            cooldown(c.key, 30000);
            errors.push(`${c.provider.name}: ${e.message}`);
            continue;
          }
          if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '');
            const status = upstream.status;
            const delay = status === 429 ? parseRetryAfter(upstream) : status >= 500 ? 60000 : 5000;
            cooldown(c.key, delay);
            bumpKey(c.key, false);
            errors.push(`${c.provider.name} HTTP ${status}: ${detail.slice(0, 160)}`);
            addLog({ kind: 'fail', provider: c.provider.name, model: c.model, status });
            if (status === 401 || status === 403) continue; // bad key, try next
            continue;
          }
          bumpKey(c.key, true);
          addLog({ kind: 'ok', provider: c.provider.name, model: c.model, stream: wantStream });

          if (wantStream) {
            res.writeHead(200, {
              'content-type': upstream.headers.get('content-type') || 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-logic-router-provider': c.provider.name,
            });
            const reader = upstream.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
              res.end();
            }
            return;
          }
          const payload = await upstream.json();
          if (!payload.usage) payload.usage = {};
          payload.usage.provider = c.provider.name;
          return json(res, 200, payload);
        }
        return json(res, 502, { error: { message: 'all providers failed', type: 'upstream_error', details: errors } });
      }

      return json(res, 404, { error: { message: 'not found' } });
    }

    return text(res, 404, 'Logic Router: not found');
  } catch (e) {
    console.error('[logic-router] request error:', e);
    if (!res.headersSent) json(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Logic Router ready → http://${HOST}:${PORT}`);
  console.log(`UI: http://${HOST}:${PORT}/   API: http://${HOST}:${PORT}/v1`);
  console.log(`Local token: ${state.token}`);
  console.log(`Keys stored: ${state.keys.length}   State: ${STATE_FILE}`);
});

function shutdown() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 }); } catch {}
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

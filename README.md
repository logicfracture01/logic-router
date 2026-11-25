# Logic Router

A minimal, dependency-free local router for free LLM API tiers. Built for Android/Termux. One OpenAI-compatible endpoint, a small web dashboard, automatic failover, bounded concurrency, circuit breakers, and a supervisor that restarts crashes.

No gradients, no sample data, no trial credits. Keys stay on the device.

## Run

```sh
pkg install -y nodejs
git clone https://github.com/logicfracture01/logic-router.git
cd logic-router
npm start
```

`npm start` runs `supervisor.js`, which starts the server, probes `/health` every 5 seconds, and restarts it after a crash, hang, or repeated failed probes. Use `npm run serve` for the bare server without supervision.

Open `http://127.0.0.1:20129/`. The local token is printed in the terminal and shown in the dashboard. The server binds to `127.0.0.1` only.

## Load and recovery behavior

- **Bounded concurrency:** at most `MAX_INFLIGHT` (64) upstream calls run at once; up to `MAX_QUEUE` (256) wait in a FIFO queue. Excess requests get `503` with `Retry-After` instead of exhausting memory.
- **Adaptive limit:** the effective concurrency shrinks on upstream failures and recovers on successes.
- **Per-key cap:** no single key exceeds `KEY_INFLIGHT` (4) concurrent requests.
- **Circuit breaker:** after `BREAKER_THRESHOLD` (3) failures a key is opened with exponential backoff and jitter; one half-open probe tests recovery. `Retry-After` from the provider is honored.
- **Timeouts:** upstream calls abort after `UPSTREAM_TIMEOUT_MS` (120s), queued requests after `QUEUE_TIMEOUT_MS` (30s), and stalled streams are cut after `STREAM_IDLE_MS` (30s).
- **Retries:** transient network errors and HTTP 5xx retry up to `MAX_RETRIES` (1) with jitter before rotating to the next key.
- **State safety:** state is written atomically via temp file + rename; a corrupt state file is quarantined and a fresh one is created.
- **Self-healing:** uncaught exceptions close and re-open the listener in-process. The supervisor provides the outer crash-restart loop with exponential backoff (up to 30s, 60s after 10 restarts in 10 minutes).
- **Observability:** `GET /health` (no auth) for supervision; `GET /api/metrics` (auth) for counters, latency percentiles, per-provider stats, and system events.

Tune via environment variables, for example:

```sh
MAX_INFLIGHT=128 MAX_QUEUE=512 KEY_INFLIGHT=8 npm start
```

Quick load probe (writes nothing):

```sh
node tools/loadtest.js 400 60
```

## Teammates and shared capacity

The pool is shared, the keys are private. Every teammate gets their own bearer token and two models.

- **Roles:** the admin token is printed at startup. Admin creates users in the **Admin** tab (or `POST /api/users`), sets each user's `rpmLimit` / `rpdLimit`, and can rotate or revoke their tokens. Only the admin can see the user list, `/api/metrics`, `/api/config` and `/api/billing`.
- **Privacy:** a user can fully manage only their own keys (add, pause, remove, clear cooldown). `/api/status` returns only their keys, with masked values — key strings are never exposed by any API. Cross-user key operations return `404`; admin endpoints return `403`.
- **Shared free pool:** all keys with tier `free` form one pool. Requests from any user can use any healthy free key, so combined capacity is the sum of everyone's contributions. Each user is capped by their own RPM/RPD quota (e.g. friend1 60 RPM, teammate97 150 RPM).
- **Exact-per-key safety:** per-key RPM/RPD caps from the provider catalog are still enforced, so a key is never driven past its published free tier.
- **Two models per user:** `auto` routes to the free pool; `paid` routes only to keys the admin tagged `paid`, and every paid request is logged per user in `/api/billing` (requests, tokens, estimated cost) for later settlement. Non-admin users get `403` if they request any other model ID.
- **Smart local routing:** `auto` classifies the prompt locally (code, reasoning, vision, bulk/cheap, general) and ranks available free keys by capability for that task, then by health and remaining quota. Classification is returned in `x-logic-router-task`. No extra API call is made and prompts are not sent anywhere for classification.
- **Quota errors:** exceeding a personal quota returns `429` with `Retry-After`, counted separately from provider rate limits.

Each teammate connects with:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:20129/v1
export OPENAI_API_KEY=<their token>
```

## Cache and usage monitoring

- **Response cache:** identical non-streaming requests are cached in memory (default 10 min TTL, 500 entries, 512 KB per entry). Cache hits return instantly with `x-logic-router-cache: HIT`. Set `"cache": false` or `"cache_control": {"type": "no-cache"}` in a request to bypass it.
- **Single-flight:** concurrent identical requests share one upstream call (`COALESCED`).
- **Stale fallback:** if every provider fails, a recently expired cached response is returned with `STALE` instead of an error.
- **Monitor:** the **Cache** tab shows hit rate, entries, saved requests/tokens, TTL controls and a preview of cached entries. `/api/cache`, `/api/cache/clear` expose the same data.
- **Usage:** requests, tokens and estimated list-price value are recorded per provider and per day (30 days retained). The **Usage** tab shows 7-day bars and a provider table. `/api/usage` returns the raw counters. Estimates are clearly labeled, not billed amounts.
- **Request IDs:** every response carries `x-request-id`; pass your own via the same header. IDs appear in logs.
- **Runtime config:** `/api/config` GET/PATCH tunes cache, concurrency, retries and breaker threshold without a restart. Environment variables `CACHE=0`, `CACHE_TTL_MS`, `CACHE_MAX`, `CACHE_ENTRY_MAX` and `ACCESS_LOG=logs/access.jsonl` set defaults and optional JSONL access logging.

## Setup

In the **Keys** tab, add a key for any provider, then use `auto` as the model in your client or in **Chat**.

| Provider | Free limits | Get a key |
|---|---|---|
| Groq | 30 RPM / 1,000 RPD | console.groq.com/keys |
| Google AI Studio | 15 RPM / 1,000 RPD | aistudio.google.com/apikey |
| OpenRouter `:free` | 20 RPM / 50 RPD | openrouter.ai/keys |
| Token Harbor | 60 RPM, rolling 7-day allowance | tokenharbor.ai |
| OpenTyphoon | 200 RPM, no daily cap published | playground.opentyphoon.ai/api-key |
| Requesty | 20 RPM / 200 RPD | requesty.ai |
| MegaNova AI | 20–200 RPM / 50–500 RPD | meganova.ai |
| Kilo Gateway | 200 req/hour/IP | kilo.ai/gateway |
| FreeInference | dynamic | freeinference.org |
| AMD Radeon Cloud | 30 RPM/key, daily points | developer.amd.com.cn (China site) |

Any other OpenAI-compatible endpoint can be added as **Custom URL** with `baseUrl|key`.

## Client configuration

```sh
export OPENAI_BASE_URL=http://127.0.0.1:20129/v1
export OPENAI_API_KEY=<token from the dashboard>
```

```sh
curl http://127.0.0.1:20129/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

Model IDs: `auto`, aliases `fast` / `smart` / `coder` / `free`, or an exact free model ID. Streaming is supported.

## Files

- `server.js` — server, provider catalog, routing, queue, breakers, metrics.
- `supervisor.js` — health probes and crash/hang restarts.
- `public/index.html` — single-file dashboard.
- `tools/loadtest.js` — dependency-free load probe.
- `state.json` — runtime state (gitignored, mode 0600).

Zero npm dependencies, under 60 KB of source.

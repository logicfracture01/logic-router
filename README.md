# Logic Router

A minimal, dependency-free local router for free LLM API tiers. Built for Android/Termux. One OpenAI-compatible endpoint, a small web dashboard, automatic failover on 429/5xx, and no hosted intermediary.

No gradients, no sample data, no trial credits. Keys stay on the device.

## Run

```sh
pkg install -y nodejs
git clone https://github.com/logicfracture01/logic-router.git
cd logic-router
node server.js
```

Open `http://127.0.0.1:20129/`. The local token is printed in the terminal and shown in the dashboard. The server binds to `127.0.0.1` only.

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

## Behavior

- A 429 puts the key in cooldown using the upstream `Retry-After`; the next key takes over.
- Per-key RPM/RPD counters are tracked against published free-tier caps.
- 401/403 keys are skipped immediately and reported in the activity log.
- State is stored in `state.json` (mode 0600, gitignored).

## Files

- `server.js` — HTTP server, provider catalog, routing, cooldowns, `/v1` API.
- `public/index.html` — single-file dashboard.
- `public/manifest.webmanifest` — installable PWA metadata.

Total source is under 50 KB with zero npm dependencies.

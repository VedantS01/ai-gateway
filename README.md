# ai-gateway

One Cloudflare Worker (free plan) that fronts every static AI project.
**Deployed: <https://ai-gateway.draftsmith.workers.dev>** (see
`gateway-url.txt`; `./gateway deploy` refreshes both).
Static pages do everything except hold a shared secret; this gateway
holds the API keys. Adding a project to it is a config entry, not a new
deployment.

## Why this stack (decision record, 2026-07)

**The problem.** GitHub Pages is static-only, and no GitHub free service
substitutes for a backend:

- **Actions** is async CI — it cannot answer a web request, triggering it
  needs an authenticated token (itself a secret you can't ship to the
  browser), and using it as an API backend is outside its terms of use.
- **Codespaces** is a dev box: auth-gated forwarded ports, stops when
  idle, burns the 120 free core-hours.
- **GitHub Models** (the one real GitHub inference service) retired
  2026-07-30.
- A build-time Actions secret is worthless for Pages: it would be baked
  into public JS.

**The two workable patterns for a static site:**

1. **BYOK, no backend at all** — call the provider straight from the
   browser with a key the visitor pastes (stored in localStorage). Works
   whenever the provider serves CORS: verified for Gemini's
   OpenAI-compat endpoint (`generativelanguage.googleapis.com/v1beta/openai`)
   and OpenRouter. Perfect for your own use of your own key; useless for
   anonymous visitors.
2. **A tiny key-holding proxy** — the only piece that needs a server.
   Cloudflare Workers free plan: 100k requests/day, no card, no cold
   starts, no idle spin-down. The rest of the 2026 free-hosting
   landscape is thin (HF Spaces Gradio/Docker paid, Fly/Railway gone,
   Render free spins down 15 min idle, Cloud Run wants a card).

**The systematic shape.** One gateway Worker for all projects instead of
a worker per project. Frontends stay wherever they are (GitHub Pages is
fine); compute-heavy engines run in-browser via Pyodide/WASM (the
draftsmith pattern); only model calls cross the network.

## Deploy (once)

```sh
npm i -g wrangler          # or use npx
npx wrangler login
npx wrangler secret put KEY_GEMINI   # paste the Gemini API key
npx wrangler deploy
```

The Worker lands at `https://ai-gateway.<account>.workers.dev`.

## Add a project (each time)

1. Add an entry to `PROJECTS` in `wrangler.toml` (origins, apiBase,
   pinned model, which key secret).
2. If it uses a new provider account: `npx wrangler secret put KEY_<X>`.
3. `npx wrangler deploy`.

The project's frontend then:

```js
// probe the pinned model (optional, for labeling)
const { model } = await (await fetch(GATEWAY + "/v1/myproject")).json();
// chat
const res = await fetch(GATEWAY + "/v1/myproject", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "system", content: sys },
                                    { role: "user", content: msg }] }),
});
const data = await res.json(); // standard OpenAI chat.completions shape
```

Routes are drop-in compatible with draftsmith's original per-project
demo proxy: point `DEMO_PROXY_URL` at
`https://ai-gateway.<account>.workers.dev/v1/draftsmith` and the old
worker can be deleted.

## Abuse posture

Per project: origin allowlist, model pinned server-side, only `messages`
forwarded (no client-chosen params), request-size cap. Keep gateway keys
billing-free (free-tier keys) so the provider's own rate limits are the
spend ceiling. Optionally add one Cloudflare WAF rate-limiting rule
(free plan includes it) in front of `/v1/*`.

## Roadmap: agentic engineering

The gateway stays the credential boundary; agent sophistication grows
around it in stages:

1. **Loop in the browser** (works today, zero infra): tools and engine
   run client-side (Pyodide/WASM/JS), each model turn goes through the
   gateway. draftsmith's propose→validate→repair loop already works this
   way.
2. **SSE streaming passthrough**: stream `chat/completions` chunks
   through the Worker for responsive UIs.
3. **Loop in the Worker**: move trusted loops server-side — plain JS,
   provider calls are subrequests, CPU-time limits don't count await
   time. Per-session state in Workers KV (free tier) if needed.
4. **Heavy/Python agents**: when a loop truly needs Python or long
   wall-clock, use Modal (monthly free credits) or Cloud Run (free tier,
   card required) — keep the gateway in front so keys never move.

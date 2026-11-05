/* ai-gateway — one Cloudflare Worker (free plan) fronting every static
 * AI project and every app demo.
 *
 * A static page (GitHub Pages, Cloudflare Pages) and a phone app can do
 * everything except hold a shared secret. This gateway holds the API
 * keys and forwards chat requests to each project's pinned
 * OpenAI-compatible endpoint. Adding a project = one entry in PROJECTS
 * (wrangler.toml) + a provider key secret + `npx wrangler deploy`.
 *
 * Page routes (drop-in compatible with draftsmith's demo proxy):
 *   GET  /v1/<project>   → { model }   config probe, no secret exposed
 *   POST /v1/<project>   → forwards { messages } to the provider
 *
 * App routes (projects with a `credits` block; each install is a device
 * with a credits balance kept in D1, see migrations/):
 *   POST /v1/<project>/register   X-App-Key → { token, credits, dailyCap }
 *   GET  /v1/<project>/me         Bearer    → balance and today's use
 *   POST /v1/<project>/chat       Bearer    → OpenAI chat.completions with
 *        messages, tools, tool_choice, response_format, temperature,
 *        max_tokens passed through; the model pinned; one credit per call
 *   POST /v1/<project>/grant      X-Admin-Key → top up a device (for
 *        support now, in-app purchase receipts later)
 *
 * Abuse posture: pages have an origin allowlist; apps have an app key,
 * a free grant per device, a daily cap per device and a registration cap
 * per IP per day. The model is pinned server-side everywhere and only
 * known request fields are forwarded. Providers are tried in order, so a
 * rate-limited or down provider falls through to the next. Keep gateway
 * keys billing-free so the providers' own limits are the spend ceiling.
 */

const DEFAULT_MAX_BODY_BYTES = 80_000;
const DEFAULT_CREDITS = { free: 300, dailyCap: 60, registrationsPerIpPerDay: 5 };
const COST_PER_CALL = 1;
/** Request fields an app may set; everything else (model above all) is ours. */
const CHAT_FIELDS = ["messages", "tools", "tool_choice", "response_format", "temperature",
  "max_tokens", "top_p", "seed", "stop"];

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

const json = (obj, status, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });

/** `code` is the machine-readable reason apps switch on. */
const jsonError = (message, status, headers = {}, code) =>
  json({ error: { message, ...(code ? { code } : {}) } }, status, headers);

const utcDay = (now) => now.toISOString().slice(0, 10);

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const sha256 = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** The provider chain: `providers` in order, else the single top-level one. */
const providersOf = (project) =>
  project.providers?.length
    ? project.providers
    : [{ apiBase: project.apiBase, model: project.model, keySecret: project.keySecret }];

/**
 * POST the payload to each provider in turn until one answers with
 * something other than a rate limit or a server error. Returns the last
 * answer with `exhausted: true` when none did.
 */
async function callUpstream(env, providers, payload) {
  let last = { status: 500, body: JSON.stringify({ error: { message: "no provider configured" } }) };
  for (const provider of providers) {
    const key = env[provider.keySecret];
    if (!key) {
      last = { status: 500, body: JSON.stringify({ error: { message: `secret ${provider.keySecret} not set` } }), model: provider.model };
      continue;
    }
    let upstream;
    try {
      upstream = await fetch(`${provider.apiBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...payload, model: provider.model }),
      });
    } catch (error) {
      last = { status: 502, body: JSON.stringify({ error: { message: `${provider.model}: ${error.message}` } }), model: provider.model };
      continue;
    }
    const body = await upstream.text();
    last = { status: upstream.status, body, model: provider.model };
    // Rate limits and outages fall through; so does Gemini refusing the edge
    // location this request happened to run from ("User location is not
    // supported"), which the next provider doesn't care about.
    const unserved = upstream.status === 429 || upstream.status >= 500 ||
      (upstream.status === 400 && /location is not supported/i.test(body));
    if (!unserved) return last;
  }
  return { ...last, exhausted: true };
}

/** The provider's own words, from `{error:{message}}`, Gemini's `[{error}]`, or raw text. */
function upstreamDetail(body) {
  try {
    const parsed = JSON.parse(body);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    const message = typeof error === "string" ? error : error?.message;
    if (message) return String(message).slice(0, 500);
  } catch { /* not JSON */ }
  return String(body || "").slice(0, 300);
}

async function readJsonBody(request, cap) {
  const raw = await request.text();
  if (raw.length > cap) return { error: jsonError("request too large", 413) };
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { error: jsonError("body must be JSON", 400) };
  }
}

/* ---------- page routes (unchanged behaviour) ---------- */

async function pageRoute(request, env, project) {
  const origin = request.headers.get("Origin") || "";
  const origins = project.origins || [];
  const originOk = origins.length === 0 || origins.includes(origin);
  const corsHeaders = originOk ? cors(origin) : {};

  if (request.method === "OPTIONS")
    return new Response(null, { status: originOk ? 204 : 403, headers: corsHeaders });
  if (!originOk) return jsonError("origin not allowed", 403);
  const [provider] = providersOf(project);
  if (request.method === "GET") return json({ model: provider.model || "" }, 200, corsHeaders);
  if (request.method !== "POST") return jsonError("POST only", 405, corsHeaders);

  const { body, error } = await readJsonBody(request, project.maxBodyBytes || DEFAULT_MAX_BODY_BYTES);
  if (error) return error;
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    return jsonError("body must contain a messages array", 400, corsHeaders);

  const upstream = await callUpstream(env, providersOf(project), { messages });
  return new Response(upstream.body, {
    status: upstream.exhausted && upstream.status < 500 ? 503 : upstream.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ---------- app routes (credits ledger) ---------- */

async function appRoute(request, env, name, project, action) {
  if (!env.LEDGER) return jsonError("gateway misconfigured: no LEDGER database bound", 500);
  const cfg = { ...DEFAULT_CREDITS, ...project.credits };
  const now = new Date();
  const today = utcDay(now);
  const stamp = now.toISOString();
  const [provider] = providersOf(project);

  if (action === "register") {
    if (request.method !== "POST") return jsonError("POST only", 405);
    if (project.appKeySecret) {
      const expected = env[project.appKeySecret];
      if (!expected) return jsonError(`gateway misconfigured: secret ${project.appKeySecret} not set`, 500);
      if (request.headers.get("X-App-Key") !== expected) return jsonError("bad app key", 401, {}, "auth");
    }
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ipHash = (await sha256(`${ip}|${env.IP_SALT || ""}`)).slice(0, 32);
    const { count } = await env.LEDGER
      .prepare("SELECT COUNT(*) AS count FROM devices WHERE project = ?1 AND ip_hash = ?2 AND created_at >= ?3")
      .bind(name, ipHash, today)
      .first();
    if (count >= cfg.registrationsPerIpPerDay)
      return jsonError("too many new devices from this network today", 429, {}, "registrations");
    const token = randomToken();
    await env.LEDGER
      .prepare("INSERT INTO devices (token, project, credits, granted, ip_hash, created_at, last_seen) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?5)")
      .bind(token, name, cfg.free, ipHash, stamp)
      .run();
    return json({ token, credits: cfg.free, dailyCap: cfg.dailyCap, costPerCall: COST_PER_CALL, model: provider.model }, 201);
  }

  if (action === "models") {
    // Which models each provider serves right now (free tiers retire models
    // without notice). App key, not a device token: it is operational, not
    // something a phone asks.
    if (!project.appKeySecret || request.headers.get("X-App-Key") !== env[project.appKeySecret])
      return jsonError("bad app key", 401, {}, "auth");
    const listing = {};
    for (const p of providersOf(project)) {
      const key = env[p.keySecret];
      if (!key) { listing[p.model] = "secret not set"; continue; }
      try {
        const res = await fetch(`${p.apiBase}/models`, { headers: { Authorization: `Bearer ${key}` } });
        const body = await res.json();
        listing[p.model] = res.ok
          ? (body.data || body.models || []).map((m) => m.id || m.name).sort()
          : `${res.status}: ${upstreamDetail(JSON.stringify(body))}`;
      } catch (error) {
        listing[p.model] = `fetch failed: ${error.message}`;
      }
    }
    return json(listing, 200);
  }

  if (action === "grant") {
    if (request.method !== "POST") return jsonError("POST only", 405);
    if (!env.ADMIN_KEY || request.headers.get("X-Admin-Key") !== env.ADMIN_KEY)
      return jsonError("bad admin key", 401, {}, "auth");
    const { body, error } = await readJsonBody(request, 4_000);
    if (error) return error;
    const credits = Number(body?.credits);
    if (typeof body?.token !== "string" || !Number.isInteger(credits) || credits <= 0)
      return jsonError("body must have token and a positive integer credits", 400);
    const updated = await env.LEDGER
      .prepare("UPDATE devices SET credits = credits + ?1, granted = granted + ?1 WHERE token = ?2 AND project = ?3 RETURNING credits")
      .bind(credits, body.token, name)
      .first();
    if (!updated) return jsonError("no such device", 404);
    await env.LEDGER
      .prepare("INSERT INTO grants (id, token, credits, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(randomToken(), body.token, credits, String(body.source || "admin"), stamp)
      .run();
    return json({ credits: updated.credits }, 200);
  }

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return jsonError("missing bearer token; register first", 401, {}, "auth");

  if (action === "me") {
    if (request.method !== "GET") return jsonError("GET only", 405);
    const device = await env.LEDGER
      .prepare("SELECT credits, granted, spent, day, day_used FROM devices WHERE token = ?1 AND project = ?2")
      .bind(token, name)
      .first();
    if (!device) return jsonError("unknown device; register again", 401, {}, "auth");
    const dailyUsed = device.day === today ? device.day_used : 0;
    return json({
      credits: device.credits,
      granted: device.granted,
      spent: device.spent,
      dailyCap: cfg.dailyCap,
      dailyUsed,
      dailyRemaining: Math.max(0, cfg.dailyCap - dailyUsed),
      costPerCall: COST_PER_CALL,
      model: provider.model,
    }, 200);
  }

  if (action === "chat") {
    if (request.method !== "POST") return jsonError("POST only", 405);
    const { body, error } = await readJsonBody(request, project.maxBodyBytes || DEFAULT_MAX_BODY_BYTES);
    if (error) return error;
    if (!Array.isArray(body?.messages) || body.messages.length === 0)
      return jsonError("body must contain a messages array", 400);
    const payload = {};
    for (const field of CHAT_FIELDS) if (body[field] !== undefined) payload[field] = body[field];
    payload.stream = false;

    // Charge first, atomically; refund if no provider answers.
    const charged = await env.LEDGER
      .prepare(
        "UPDATE devices SET credits = credits - ?5, spent = spent + ?5, " +
          "day_used = CASE WHEN day = ?1 THEN day_used + ?5 ELSE ?5 END, day = ?1, last_seen = ?2 " +
          "WHERE token = ?3 AND project = ?4 AND credits >= ?5 AND (day != ?1 OR day_used + ?5 <= ?6) " +
          "RETURNING credits, day_used"
      )
      .bind(today, stamp, token, name, COST_PER_CALL, cfg.dailyCap)
      .first();
    if (!charged) {
      const device = await env.LEDGER
        .prepare("SELECT credits, day, day_used FROM devices WHERE token = ?1 AND project = ?2")
        .bind(token, name)
        .first();
      if (!device) return jsonError("unknown device; register again", 401, {}, "auth");
      if (device.credits < COST_PER_CALL) return jsonError("no credits left", 402, {}, "credits");
      return jsonError("daily limit reached; try tomorrow", 429, {}, "daily");
    }

    const upstream = await callUpstream(env, providersOf(project), payload);
    const headers = {
      "Content-Type": "application/json",
      "X-Credits-Remaining": String(charged.credits),
      "X-Daily-Remaining": String(Math.max(0, cfg.dailyCap - charged.day_used)),
      "X-Model": upstream.model || "",
    };
    if (upstream.exhausted) {
      await env.LEDGER
        .prepare("UPDATE devices SET credits = credits + ?1, spent = spent - ?1, day_used = MAX(0, day_used - ?1) WHERE token = ?2")
        .bind(COST_PER_CALL, token)
        .run();
      headers["X-Credits-Remaining"] = String(charged.credits + COST_PER_CALL);
      return jsonError(
        `no model answered (${upstream.model || "?"} ${upstream.status}: ${upstreamDetail(upstream.body)})`,
        503, headers, "upstream");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return jsonError("no such route", 404);
}

export default {
  async fetch(request, env) {
    let projects;
    try {
      projects = JSON.parse(env.PROJECTS || "{}");
    } catch {
      return jsonError("gateway misconfigured: PROJECTS is not valid JSON", 500);
    }

    const match = new URL(request.url).pathname.match(/^\/v1\/([\w-]+)(?:\/(register|me|chat|grant|models))?\/?$/);
    if (!match) return jsonError("no such route; expected /v1/<project>[/register|me|chat]", 404);
    const [, name, action] = match;
    const project = projects[name];
    if (!project) return jsonError(`unknown project "${name}"`, 404);

    if (action) {
      if (!project.credits) return jsonError(`project "${name}" has no credits ledger`, 404);
      return appRoute(request, env, name, project, action);
    }
    if (project.credits) return jsonError("app project: use /register, /me and /chat", 404);
    return pageRoute(request, env, project);
  },
};

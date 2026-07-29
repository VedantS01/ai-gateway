/* ai-gateway — one Cloudflare Worker (free plan) fronting every static
 * AI project.
 *
 * A static page (GitHub Pages, Cloudflare Pages) can do everything
 * except hold a shared secret. This gateway holds the API keys and
 * forwards chat requests to each project's pinned OpenAI-compatible
 * endpoint. Adding a project = one entry in PROJECTS (wrangler.toml)
 * + a provider key secret + `npx wrangler deploy`.
 *
 * Routes (drop-in compatible with draftsmith's demo proxy):
 *   GET  /v1/<project>   → { model }   config probe, no secret exposed
 *   POST /v1/<project>   → forwards { messages } to the provider
 *
 * Abuse posture per project: origin allowlist, model pinned server-side,
 * only `messages` forwarded (no client-chosen params), body size cap.
 * Keep gateway keys billing-free so the provider's own rate limits are
 * the spend ceiling; optionally add a Cloudflare WAF rate-limit rule.
 */

const DEFAULT_MAX_BODY_BYTES = 80_000;

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

const jsonError = (message, status, headers = {}) =>
  json({ error: { message } }, status, headers);

export default {
  async fetch(request, env) {
    let projects;
    try {
      projects = JSON.parse(env.PROJECTS || "{}");
    } catch {
      return jsonError("gateway misconfigured: PROJECTS is not valid JSON", 500);
    }

    const match = new URL(request.url).pathname.match(/^\/v1\/([\w-]+)\/?$/);
    if (!match) return jsonError("no such route; expected /v1/<project>", 404);
    const project = projects[match[1]];
    if (!project) return jsonError(`unknown project "${match[1]}"`, 404);

    const origin = request.headers.get("Origin") || "";
    const origins = project.origins || [];
    const originOk = origins.length === 0 || origins.includes(origin);
    const corsHeaders = originOk ? cors(origin) : {};

    if (request.method === "OPTIONS")
      return new Response(null, { status: originOk ? 204 : 403, headers: corsHeaders });
    if (!originOk) return jsonError("origin not allowed", 403);
    if (request.method === "GET")
      return json({ model: project.model || "" }, 200, corsHeaders);
    if (request.method !== "POST") return jsonError("POST only", 405, corsHeaders);

    const key = env[project.keySecret];
    if (!key)
      return jsonError(
        `gateway misconfigured: secret ${project.keySecret} not set`,
        500,
        corsHeaders
      );

    const raw = await request.text();
    const cap = project.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
    if (raw.length > cap) return jsonError("request too large", 413, corsHeaders);
    let messages;
    try {
      ({ messages } = JSON.parse(raw));
    } catch {
      return jsonError("body must be JSON", 400, corsHeaders);
    }
    if (!Array.isArray(messages) || messages.length === 0)
      return jsonError("body must contain a messages array", 400, corsHeaders);

    const upstream = await fetch(`${project.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: project.model, messages }),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
};

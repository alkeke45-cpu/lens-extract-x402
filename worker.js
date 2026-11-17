// LensExtract — Cloudflare Worker variant (same x402 logic as server.mjs).
// Deploy: wrangler deploy worker.js --name lens-extract  (free workers.dev subdomain, no card)
// Protocol: x402 v2 PRIMARY, x402 v1 accepted (dual-stack, migrated 2026-11-08 —
// see MIGRATION-V2.md in the repo). 402 advertisement is v2-canonical
// (PAYMENT-REQUIRED header, CAIP-2 network, `amount`); payment acceptance
// honors PAYMENT-SIGNATURE (v2) and legacy X-PAYMENT (v1), each verified and
// settled against the facilitator with its own x402Version.
// Env vars (optional): PAY_TO_ADDRESS, PRICE_ATOMIC, FACILITATOR_URL, NETWORK, NETWORK_CAIP2
import { Hono } from "hono";
import { stacksPaymentMiddleware } from "@aibtc/x402-stacks-agents/hono";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DESCRIPTION = "Extract clean readable markdown/text from any public web page URL.";
const CAIP2_BY_V1 = { base: "eip155:8453", "base-sepolia": "eip155:84532" };
const caip2 = (env) => env.NETWORK_CAIP2 || CAIP2_BY_V1[env.NETWORK || "base"] || env.NETWORK || "eip155:8453";
const payTo = (env) => env.PAY_TO_ADDRESS || "0x8488E45d428a3B2BC7116c8657b8FF23Cd042ef6";
const price = (env) => env.PRICE_ATOMIC || "1000";

function reqsV1(env, resource) {
  return {
    scheme: "exact", network: env.NETWORK || "base",
    maxAmountRequired: price(env),
    resource, description: DESCRIPTION,
    mimeType: "application/json",
    payTo: payTo(env),
    maxTimeoutSeconds: 60, asset: USDC_BASE,
    outputSchema: { input: { type: "http", method: "POST", bodyType: "json", bodyFields: { url: { type: "string", required: true }, maxChars: { type: "number", required: false } } }, output: { type: "object" } },
    extra: { name: "USD Coin", version: "2" },
  };
}
function reqsV2(env) {
  return {
    scheme: "exact", network: caip2(env),
    amount: price(env),
    asset: USDC_BASE,
    payTo: payTo(env),
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
}
function requiredBodyV2(env, resource, error) {
  return {
    x402Version: 2, error,
    resource: { url: resource, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [reqsV2(env)],
    extensions: { bazaar: bazaarExtension() },
  };
}
// --- Discovery documents (added 2026-11-08, wave 5) ---
// x402scan canonical discovery = OpenAPI 3.1 at /openapi.json with
// x-payment-info + 402 response per paid operation (x402scan.com/discovery/spec).
// The 402 body also declares a CDP Bazaar extension (info + schema); CDP only
// indexes after a settlement through the CDP Facilitator, but any Bazaar-aware
// facilitator then has the metadata to catalog this route.
function bazaarExtension() {
  const input = { type: "http", method: "POST", bodyType: "json", body: { url: "https://example.com/article", maxChars: 20000 } };
  const output = { type: "json", example: { url: "https://example.com/article", finalUrl: "https://example.com/article", title: "Example", markdown: "# Example\n\nClean article text.", text: "Example Clean article text.", wordCount: 4, truncated: false } };
  return {
    info: { input, output },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: {
        input: { type: "object", properties: { type: { const: "http" }, method: { enum: ["POST"] }, bodyType: { enum: ["json"] }, body: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] } }, required: ["type", "method", "bodyType", "body"] },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}
function openApiDoc(origin) {
  return {
    openapi: "3.1.0",
    info: { title: "LensExtract", version: "1.0.0", description: "Extract clean readable markdown/text from any public web page URL.", "x-guidance": "Use POST /v1/extract to extract clean markdown from a public web page. Send a JSON body with a 'url' field (required) and optional 'maxChars'. Payment is x402 v2: $0.001 USDC on Base per call; call without payment to receive the 402 payment requirements in the PAYMENT-REQUIRED header, then retry with a PAYMENT-SIGNATURE header. (Legacy x402 v1 X-PAYMENT headers are also accepted.)", contact: { email: "alkeke45@gmail.com" } },
    servers: [{ url: origin }],
    paths: { "/v1/extract": { post: {
      operationId: "extract", summary: "Extract - Clean markdown/text extraction from a web page URL", tags: ["Data"],
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { url: { type: "string", description: "Public http(s) page URL to extract" }, maxChars: { type: "number", description: "Max characters of markdown returned (default 20000, cap 50000)" } }, required: ["url"] } } } },
      responses: {
        "200": { description: "Successful response", content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, finalUrl: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, text: { type: "string" }, wordCount: { type: "number" }, truncated: { type: "boolean" } }, required: ["url", "markdown"] } } } },
        "402": { description: "Payment Required" },
      },
    } } },
  };
}
// --- Kinetic Dune /ask (added 2026-11-16, AIBTC bounty mwc3szq53cae05deebce) ---
// Ported from the AIBTC template templates/cf-agent-stacks-x402 (src/server.ts):
// the SAME stacksPaymentMiddleware from @aibtc/x402-stacks-agents/hono gates
// GET /ask — unpaid calls get the template's x402 v2 402 (Stacks mainnet sBTC,
// PRICE sats to PAY_TO); paid calls are verified + settled by the gate against
// the AIBTC relay facilitator BEFORE the answer runs (settle: "before-run").
// Answer engine: Workers AI (env.AI) when bound; otherwise a free keyless LLM
// upstream (text.pollinations.ai) so a paid call still returns a genuine,
// dynamic model answer. LensExtract routes below are untouched.
const ASK_PAY_TO = "SP2DG4JE87V54X7JRJB5M99XM03Y1BJDDQ42C1GS4";
const ASK_PROMPT_DEFAULT = "You are Kinetic Dune, a precise tutor for Bitcoin and Stacks. Explain concepts, Clarity smart-contract code, and transaction mechanics in plain language, flag risks and common mistakes, and keep answers clear and concise.";
const ASK_MODEL_DEFAULT = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
async function askAnswer(env, question) {
  const system = env.AGENT_PROMPT || ASK_PROMPT_DEFAULT;
  if (env.AI) {
    try {
      const r = await env.AI.run(env.AI_MODEL || ASK_MODEL_DEFAULT, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: question },
        ],
        max_tokens: 512,
      });
      if (r && typeof r.response === "string" && r.response) return r.response;
    } catch { /* Workers AI unavailable — fall through to the keyless upstream */ }
  }
  const prompt = `${system}\n\nQuestion: ${question}\n\nAnswer:`;
  const r = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`, { headers: { "user-agent": "KineticDune/1.0 (+x402 service)" } });
  if (!r.ok) throw new Error(`fallback LLM upstream returned HTTP ${r.status}`);
  return (await r.text()).trim();
}
let askApp = null;
function getAskApp(env) {
  if (askApp) return askApp;
  const payment = {
    network: env.STACKS_NETWORK || "mainnet",
    recipient: env.PAY_TO || ASK_PAY_TO,
    token: env.TOKEN || "sBTC",
    settle: "before-run",
  };
  const app = new Hono();
  app.use(stacksPaymentMiddleware({ "GET /ask": { price: Number(env.PRICE || 10), description: "Ask this agent a question" } }, payment));
  app.get("/ask", async (c) => c.json({ answer: await askAnswer(c.env, c.req.query("question") ?? "") }));
  askApp = app;
  return app;
}

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });
const dec = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
function htmlToMarkdown(html) {
  let h = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const t = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? dec(t[1].trim()) : "";
  h = h.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n").replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n").replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n").replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)").replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1").replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  return { title, markdown: dec(h).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim() };
}

// --- Authenticated HTTP relay (added 2026-11-17, Phase 13; upgraded Phase 16) ---
// POST /v1/relay — lets our own tooling reach public data APIs that block
// this VM's datacenter egress IP, fetching instead from Cloudflare's edge.
// Auth: the caller presents the relay token in the X-Relay-Auth header; only
// its SHA-256 hex is configured on the Worker (env.RELAY_AUTH_SHA256, in
// wrangler.toml [vars]) — the plaintext token lives solely in a local
// 600-mode secret file and is never committed (this repo is public).
// Body: {"url": "https://...", "method": "GET|POST", "headers": {...},
//        "body": "...", "body_base64": "...", "region": "weur|eeur|apac|wnam|enam",
//        "follow_redirects": bool (default true)}
// Returns: {"ok": bool, "status": int, "final_url": str, "colo": str|null,
//           "headers": {...}, "body_base64": str (<= 2 MB of body bytes),
//           "content_type": str|null, "worker_colo": str|null,
//           "region"?: str, "region_fallback"?: true, "region_error"?: str,
//           "truncated"?: true, "body": legacy text body (textual types only)}
// Colo semantics (precise): "worker_colo" is request.cf.colo of the INBOUND
// request to this Worker — the colo that served the relay call itself.
// "colo" is parsed from the cf-ray header of the OUTBOUND target response
// (present only when the target itself sits behind Cloudflare); it is the
// target response's colo, NOT proof of where our fetch executed.
// Region routing: when a valid region is given and the REGIONAL_RELAY
// Durable Object binding exists, the fetch spec is POSTed to a Durable
// Object obtained with { locationHint: region }. A locationHint is a HINT
// to the platform about where to place the object — it is NOT a guarantee
// that the outbound fetch egresses from that region. On ANY failure the
// handler falls back to a direct fetch from the Worker and reports
// "region_fallback": true with the error message.
const RELAY_MAX_BYTES = 2 * 1024 * 1024; // 2 MB response-body cap (Phase 16)
const RELAY_LEGACY_BODY_CHARS = 200000; // legacy text "body" field cap
const RELAY_REGIONS = ["weur", "eeur", "apac", "wnam", "enam"];
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Performs one relay fetch per the spec and returns the result envelope
// (without "ok"). Shared by the direct Worker path and the RegionalRelay
// Durable Object, so both execute byte-identical fetch logic.
async function performRelayFetch(spec) {
  const headers = {};
  if (spec.headers && typeof spec.headers === "object") {
    for (const [k, v] of Object.entries(spec.headers)) {
      if (typeof v === "string" && !/^(host|content-length)$/i.test(k)) headers[k] = v;
    }
  }
  if (!headers["user-agent"]) headers["user-agent"] = "LensExtract-Relay/1.0 (+x402 service)";
  const init = { method: spec.method, headers, redirect: spec.follow_redirects === false ? "manual" : "follow" };
  if (spec.method === "POST") {
    if (typeof spec.body_base64 === "string" && spec.body_base64) init.body = base64ToBytes(spec.body_base64);
    else if (typeof spec.body === "string") init.body = spec.body;
  }
  const r = await fetch(spec.url, init);
  const buf = await r.arrayBuffer();
  const truncated = buf.byteLength > RELAY_MAX_BYTES;
  const slice = truncated ? buf.slice(0, RELAY_MAX_BYTES) : buf;
  const outHeaders = {};
  r.headers.forEach((v, k) => { outHeaders[k] = v; });
  let colo = null;
  const ray = r.headers.get("cf-ray");
  if (ray && ray.includes("-")) colo = ray.split("-").pop();
  const result = {
    status: r.status,
    final_url: r.url,
    colo,
    headers: outHeaders,
    body_base64: arrayBufferToBase64(slice),
    content_type: r.headers.get("content-type") || null,
  };
  if (truncated) result.truncated = true;
  return result;
}
// RegionalRelay Durable Object (Phase 16): receives a relay fetch spec over
// POST and performs the fetch from inside the Durable Object. The handler
// obtains the stub with { locationHint: region } so the platform places the
// object near the requested region; per the note above, the hint is not a
// guarantee of the fetch's egress location.
export class RegionalRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    let spec;
    try { spec = await request.json(); } catch { return json({ ok: false, error: "body must be JSON" }, 400); }
    if (!spec || typeof spec.url !== "string" || !/^https:\/\//i.test(spec.url)) return json({ ok: false, error: "url must be an https URL" }, 400);
    try {
      const result = await performRelayFetch(spec);
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: `relay fetch failed: ${e.message}` }, 502);
    }
  }
}
async function handleRelay(request, env) {
  const expected = env.RELAY_AUTH_SHA256;
  if (!expected) return json({ error: "relay not configured" }, 500);
  const presentedHash = await sha256Hex(request.headers.get("x-relay-auth") || "");
  if (!timingSafeEqualStr(presentedHash, String(expected).toLowerCase())) return json({ error: "unauthorized" }, 401);
  let input;
  try { input = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); }
  const target = input && input.url;
  if (typeof target !== "string" || !/^https:\/\//i.test(target)) return json({ error: "url must be an https URL" }, 400);
  const method = String(input.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return json({ error: "method must be GET or POST" }, 400);
  const spec = {
    url: target,
    method,
    headers: input.headers && typeof input.headers === "object" ? input.headers : {},
    body: typeof input.body === "string" ? input.body : undefined,
    body_base64: typeof input.body_base64 === "string" ? input.body_base64 : undefined,
    follow_redirects: input.follow_redirects !== false,
  };
  const workerColo = request.cf && request.cf.colo ? request.cf.colo : null;
  const region = typeof input.region === "string" ? input.region.toLowerCase() : null;
  let result = null;
  let regionFallback = false;
  let regionError = null;
  if (region && RELAY_REGIONS.includes(region)) {
    if (env.REGIONAL_RELAY) {
      try {
        const stub = env.REGIONAL_RELAY.get(env.REGIONAL_RELAY.idFromName(`relay-${region}`), { locationHint: region });
        const doResp = await stub.fetch("https://regional-relay.internal/fetch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(spec),
        });
        const doJson = await doResp.json().catch(() => null);
        if (!doResp.ok || !doJson || doJson.ok !== true) {
          throw new Error((doJson && doJson.error) || `RegionalRelay returned HTTP ${doResp.status}`);
        }
        result = doJson;
      } catch (e) {
        regionFallback = true;
        regionError = e.message;
      }
    } else {
      regionFallback = true;
      regionError = "REGIONAL_RELAY binding not available";
    }
  }
  if (!result) {
    try {
      result = { ok: true, ...(await performRelayFetch(spec)) };
    } catch (e) {
      return json({ ok: false, error: `relay fetch failed: ${e.message}` }, 502);
    }
  }
  const out = { ...result, worker_colo: workerColo };
  if (region) {
    out.region = region;
    if (regionFallback) {
      out.region_fallback = true;
      out.region_error = regionError;
    }
  }
  // Legacy text "body" for Phase 13/14 consumers, textual content only.
  if (typeof out.body_base64 === "string" && (!out.content_type || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|image\/svg)/i.test(out.content_type))) {
    try {
      const bytes = base64ToBytes(out.body_base64);
      out.body = new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, RELAY_LEGACY_BODY_CHARS);
    } catch { /* leave body unset on decode failure */ }
  }
  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/relay") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return handleRelay(request, env);
    }
    if (url.pathname === "/ask") return getAskApp(env).fetch(request, env, ctx);
    const FAC = (env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");
    if (url.pathname === "/health") return json({ ok: true, service: "lens-extract", version: "1.0.0" });
    if (url.pathname === "/openapi.json") return json(openApiDoc(url.origin));
    if (url.pathname === "/" || url.pathname === "/.well-known/x402" || url.pathname === "/.well-known/x402.json") {
      return json({ name: "LensExtract", x402Version: 2, endpoints: [{ method: "POST", path: "/v1/extract", price: "$0.001", network: caip2(env), asset: USDC_BASE, payTo: payTo(env) }], legacy: "x402 v1 payments (X-PAYMENT header, network \"base\") are also accepted." });
    }
    if (url.pathname === "/v1/extract" && (request.method === "POST" || request.method === "GET")) {
      let input = {};
      if (request.method === "POST") { try { input = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); } }
      else input = { url: url.searchParams.get("url"), maxChars: Number(url.searchParams.get("maxChars") || 20000) };
      const resource = `${url.origin}/v1/extract`;
      const need = (error) => {
        const body = requiredBodyV2(env, resource, error);
        return json(body, 402, { "payment-required": btoa(JSON.stringify(body)) });
      };
      if (!input.url || !/^https?:\/\//i.test(input.url)) return need("PAYMENT-SIGNATURE header is required; body must include a valid http(s) url");
      const callFac = async (p, body) => { const r = await fetch(`${FAC}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), text: "" }; };
      const verifyAndSettle = async (version, payload, requirements) => {
        const body = { x402Version: version, paymentPayload: payload, paymentRequirements: requirements };
        const v = await callFac("/verify", body).catch((e) => ({ json: null, err: e.message }));
        if (!v.json || v.json.isValid !== true) return { ok: false, reason: `facilitator rejected payment: ${JSON.stringify(v.json || v.err).slice(0, 300)}` };
        const s = await callFac("/settle", body).catch((e) => ({ json: null, err: e.message }));
        if (!s.json || s.json.success !== true) return { ok: false, reason: `facilitator settle failed: ${JSON.stringify(s.json || s.err).slice(0, 300)}` };
        return { ok: true, version, payer: v.json.payer || payload?.payload?.authorization?.from || null, transaction: s.json.transaction || null };
      };
      const sigHeader = request.headers.get("payment-signature");
      const xpHeader = request.headers.get("x-payment");
      if (!sigHeader && !xpHeader) return need("PAYMENT-SIGNATURE header is required");
      let verdict;
      if (sigHeader) {
        let payload; try { payload = JSON.parse(atob(sigHeader)); } catch { return need("PAYMENT-SIGNATURE header is not valid base64 JSON"); }
        if (payload.x402Version === 2) verdict = await verifyAndSettle(2, payload, reqsV2(env));
        else if (payload.x402Version === 1) verdict = await verifyAndSettle(1, payload, reqsV1(env, resource));
        else return need(`unsupported x402Version in PAYMENT-SIGNATURE payload: ${payload.x402Version}`);
      } else {
        let payload; try { payload = JSON.parse(atob(xpHeader)); } catch { return need("X-PAYMENT header is not valid base64 JSON"); }
        verdict = await verifyAndSettle(1, payload, reqsV1(env, resource));
      }
      if (!verdict.ok) return need(verdict.reason);
      const maxChars = Math.min(Number(input.maxChars) || 20000, 50000);
      const r = await fetch(input.url, { headers: { "user-agent": "LensExtract/1.0 (+x402 service)" }, redirect: "follow" });
      if (!r.ok) return json({ error: `upstream returned HTTP ${r.status}` }, 502);
      const raw = await r.text();
      const { title, markdown } = htmlToMarkdown(raw);
      const clipped = markdown.slice(0, maxChars);
      const receiptHeaders = verdict.version === 2
        ? { "payment-response": btoa(JSON.stringify({ success: true, transaction: verdict.transaction, network: caip2(env), payer: verdict.payer })) }
        : { "x-payment-response": btoa(JSON.stringify({ success: true, network: env.NETWORK || "base", payer: verdict.payer })) };
      return json({ url: input.url, finalUrl: r.url, title, markdown: clipped, text: clipped, wordCount: clipped.split(/\s+/).filter(Boolean).length, truncated: markdown.length > maxChars }, 200, receiptHeaders);
    }
    return json({ error: "not found" }, 404);
  },
};

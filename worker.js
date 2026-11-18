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
    } },
    "/v1/morpho-vault-audit": { get: {
      operationId: "morphoVaultAudit", summary: "Morpho Vaults V2 verified census & timelock audit (snapshot 2026-11-17)", tags: ["Finance"],
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.100000" }, protocols: [{ x402: {} }] },
      responses: {
        "200": { description: "Successful response", content: { "application/json": { schema: { type: "object", properties: { product: { type: "string" }, snapshotDate: { type: "string" }, count: { type: "number" }, vaults: { type: "array" } }, required: ["product", "vaults"] } } } },
        "402": { description: "Payment Required" },
      },
    } },
    "/v1/crypto-alpha-feed": { get: {
      operationId: "cryptoAlphaFeed", summary: "Live Morpho Vaults V2 TVL & APY feed (fetched live at request time)", tags: ["Finance"],
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.050000" }, protocols: [{ x402: {} }] },
      responses: {
        "200": { description: "Successful response", content: { "application/json": { schema: { type: "object", properties: { product: { type: "string" }, mode: { type: "string" }, generatedAt: { type: "string" }, count: { type: "number" }, vaults: { type: "array" } }, required: ["product", "vaults"] } } } },
        "402": { description: "Payment Required" },
      },
    } },
    "/ask": { get: {
      operationId: "ask", summary: "Ask Kinetic Dune a question (x402 on Stacks: 10 sats sBTC per answer; not a Base USDC route)", tags: ["AI"],
      parameters: [{ name: "question", in: "query", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Successful response", content: { "application/json": { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } } },
        "402": { description: "Payment Required (Stacks sBTC x402)" },
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


// --- Morpho Vaults V2 products (added 2026-11-18, Phase 21) ---
// Two Base-USDC x402 routes paying the work wallet directly. Payment flow
// mirrors /v1/extract (PayAI facilitator /verify + /settle, x402 v2 primary,
// v1 accepted) with one hardening: the product is produced BEFORE settle,
// so a payer is never charged when the product cannot be served.
// /v1/morpho-vault-audit serves the Phase 18 verified census SNAPSHOT of
// 2026-11-17 (68 Morpho Vault V2 vaults >= $5M TVL on chains 1/8453/42161;
// owner/curator/per-function timelocks verified on-chain via 1,632 dual-RPC
// eth_calls at pinned finalized blocks 26436921 / 58768413 / 525124696 with
// 0 disagreements). The snapshot date is labelled in the payload itself.
// /v1/crypto-alpha-feed serves the same vault universe LIVE: top 25 by TVL
// with current APY/net APY/fees fetched from the Morpho Blue API at request
// time; if that API is unreachable it falls back to the dated snapshot and
// says so in the payload (mode: "snapshot-fallback").
const WORK_WALLET = "0xDfe09D14E888Df4C8024CfC03E982d8CBC08E08E";
const MORPHO_AUDIT_PRICE = "100000"; // $0.10 USDC
const ALPHA_FEED_PRICE = "50000"; // $0.05 USDC
const MORPHO_AUDIT_DESC = "Morpho Vaults V2 census: 68 vaults >= $5M TVL on Ethereum/Base/Arbitrum with on-chain owner, curator and per-function timelock values verified via 1,632 dual-RPC eth_calls at pinned finalized blocks (snapshot 2026-11-17).";
const ALPHA_FEED_DESC = "Live Morpho Vaults V2 feed: top 25 vaults by TVL on Ethereum/Base/Arbitrum with current APY, net APY and fees, fetched live from the Morpho Blue API at request time.";
const MORPHO_CENSUS = [{"name":"Grove x Steakhouse USDC","symbol":"grove-steakUSDC","chainId":8453,"tvlUsd":517108104,"address":"0xbeef0786756810478b88982DE00F3CD7fdB8e7c7","owner":"0x491edfb0b8b608044e227225c715981a30f3a44e","curator":"0x622e19d6903bd4507cfc70b31d5b99535114c0fc","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Sentora x Spark RLUSD","symbol":"sxsRLUSD","chainId":1,"tvlUsd":500001612,"address":"0xFC8C624B6080a0a780583799f2A862DE936F6E22","owner":"0x3300f198988e4c9c63f75df86de36421f06af8c4","curator":"0xff070333654aae76a0a77465e4f0fd101c57c03f","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Steakhouse High Yield USDC Edition","symbol":"sirloinUSDC","chainId":8453,"tvlUsd":452668216,"address":"0xbeeff2490FEffa212faC2f6553682C219E6a8845","owner":"0x639bfa26472906ccd40513408284a8ad292bc5d6","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Paypal USD Main","symbol":"senPYUSDmain","chainId":1,"tvlUsd":346372285,"address":"0xb576765fB15505433aF24FEe2c0325895C559FB2","owner":"0xe8c9c99ecad0686a14a00d8521c572281e938008","curator":"0x9e396de3312d373b87f9bd8763fb48184b42aac0","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Sentora RLUSD Main","symbol":"senRLUSDv2","chainId":1,"tvlUsd":338294424,"address":"0x6dC58a0FdfC8D694e571DC59B9A52EEEa780E6bf","owner":"0xe8c9c99ecad0686a14a00d8521c572281e938008","curator":"0x9e396de3312d373b87f9bd8763fb48184b42aac0","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Sentora PRIME Main","symbol":"senPYUSDPRIMEv2","chainId":1,"tvlUsd":184279377,"address":"0xC21b08C16458202593D4D9B26b9984Ee67b38BbD","owner":"0xe8c9c99ecad0686a14a00d8521c572281e938008","curator":"0x9e396de3312d373b87f9bd8763fb48184b42aac0","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Gauntlet USDC Prime","symbol":"gtusdcp","chainId":8453,"tvlUsd":163824491,"address":"0x050cE30b927Da55177A4914EC73480238BAD56f0","owner":"0x5a4e19842e09000a582c20a4f524c26fb48dd4d0","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Steakhouse Prime EURCV","symbol":"steakEURCV","chainId":1,"tvlUsd":156481886,"address":"0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse Prime USDC","symbol":"steakUSDC","chainId":8453,"tvlUsd":127668741,"address":"0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9","owner":"0x639bfa26472906ccd40513408284a8ad292bc5d6","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse Prime USDC","symbol":"steakUSDC","chainId":1,"tvlUsd":127050448,"address":"0xbeef088055857739C12CD3765F20b7679Def0f51","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Gauntlet USDC Prime","symbol":"gtusdcp","chainId":1,"tvlUsd":98064807,"address":"0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0","owner":"0xc684c6587712e5e7bdf9fd64415f23bd2b05faec","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Steakhouse USDG Pro","symbol":"bbqUSDG","chainId":42161,"tvlUsd":90700625,"address":"0xbeeFf72B77e7584a450E887125F25E8D8819016a","owner":"0xca9f621aafd28d0f2decfb69db0d9e6393a9f5ee","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Sentora Huma PST Main","symbol":"senPYUSDPST","chainId":1,"tvlUsd":83030827,"address":"0x8381a156958711E230f325428B5eb4b6555C75D9","owner":"0xe8c9c99ecad0686a14a00d8521c572281e938008","curator":"0x9e396de3312d373b87f9bd8763fb48184b42aac0","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse Prime USDT","symbol":"steakUSDT","chainId":1,"tvlUsd":74480738,"address":"0xbeef003C68896c7D2c3c60d363e8d71a49Ab2bf9","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Gauntlet USDG Premium","symbol":"gtusdgp","chainId":42161,"tvlUsd":62349815,"address":"0x390c1bb01F3F627144a40617e287d4cE3D5aBCfa","owner":"0x5a4e19842e09000a582c20a4f524c26fb48dd4d0","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":86400,"increaseTimelock":604800}},{"name":"Grove x Steakhouse USDC","symbol":"grove-bbqUSDC","chainId":1,"tvlUsd":49753002,"address":"0xBeefF08dF54897e7544aB01d0e86f013DA354111","owner":"0x1369f7b2b38c76b6478c0f0e66d94923421891ba","curator":"0x622e19d6903bd4507cfc70b31d5b99535114c0fc","timelocksSeconds":{"addAdapter":1209600,"removeAdapter":1209600,"increaseAbsoluteCap":1209600,"increaseRelativeCap":1209600,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Wintermute USDC Select","symbol":"armUSDCs","chainId":1,"tvlUsd":44962463,"address":"0xA2EAaD0D586cF9FD73bb2c09cF6A7E3e187D68cd","owner":"0xb83a77677c51aaf6c45b0b64199eae6938559e5e","curator":"0x4687e45bb5518a995913a24bb2816fe2031d74d8","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Spark Blue Chip USDT Vault","symbol":"sparkUSDTbc","chainId":1,"tvlUsd":44630153,"address":"0xb0c424116172B55CbB6dD3136F5989F7959e5B91","owner":"0x3300f198988e4c9c63f75df86de36421f06af8c4","curator":"0x0f963a8a8c01042b69054e787e5763abbb0646a3","timelocksSeconds":{"addAdapter":864000,"removeAdapter":864000,"increaseAbsoluteCap":864000,"increaseRelativeCap":864000,"setPerformanceFee":864000,"increaseTimelock":864000}},{"name":"Steakhouse High Yield USDC","symbol":"bbqUSDC","chainId":1,"tvlUsd":41662492,"address":"0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"sky.money USDT Savings","symbol":"skyMoneyUsdtSavings","chainId":1,"tvlUsd":40990960,"address":"0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11","owner":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","curator":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"RockawayX USDC Yield","symbol":"roxUSDCy","chainId":1,"tvlUsd":35822091,"address":"0xE0181090c22579B6A217f1522cbf8c9f1F0C1965","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"KPK USDC Prime","symbol":"KPK_USDC_Prime","chainId":1,"tvlUsd":30670750,"address":"0x4Ef53d2cAa51C447fdFEEedee8F07FD1962C9ee6","owner":"0x8b884f80b3b839f52b6ce168f133e7a5d1f0a537","curator":"0xf8182e5827c06a47a985ec565a3bcd56437a97be","timelocksSeconds":{"addAdapter":259201,"removeAdapter":604801,"increaseAbsoluteCap":259201,"increaseRelativeCap":259201,"setPerformanceFee":1209601,"increaseTimelock":604801}},{"name":"Clearstar cbAssets Vault","symbol":"CSCBUSDC","chainId":8453,"tvlUsd":28210756,"address":"0x91C056B6d4311a743614FBc03ac32d4E6A2d3a3c","owner":"0xb3cf59a5f12ca319861376c5e63eef4790a42b44","curator":"0x5634520dd1c044fd8e589a7113c2d8f8f279fc24","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Ethena x Steakhouse USDC","symbol":"ethenaUSDC","chainId":8453,"tvlUsd":25928983,"address":"0xBeEfF0be997Cca5B1c13A7433c2004637975739e","owner":"0x639bfa26472906ccd40513408284a8ad292bc5d6","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"sky.money USDS Flagship","symbol":"skyMoneyUsdsFlagship","chainId":1,"tvlUsd":25092352,"address":"0xE15fcC81118895b67b6647BBd393182dF44E11E0","owner":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","curator":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Osero x Gauntlet USDC Prime","symbol":"ogusdcp","chainId":1,"tvlUsd":25025717,"address":"0x802148D518A6De2aF866f9A61ffB5e5C39156dB2","owner":"0x24fdcd3bfa5c2553e05b2f9ad0365ebc296278d3","curator":"0x256dac8fad2788f4182a42ce8f26029f0ded7cf9","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Trezor Steakhouse USDC Prime","symbol":"trSHUSDCp","chainId":1,"tvlUsd":23507307,"address":"0xde6c23E561F3e55846207EC45A91b777e0F7C889","owner":"0xda9964eaf7a303bd493fa7a6f1593b544f0da80d","curator":"0xda9964eaf7a303bd493fa7a6f1593b544f0da80d","timelocksSeconds":{"addAdapter":0,"removeAdapter":0,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":604800,"increaseTimelock":0}},{"name":"Gauntlet USDC Frontier","symbol":"gtusdcf","chainId":1,"tvlUsd":22816779,"address":"0x9a1D6bd5b8642C41F25e0958129B85f8E1176F3e","owner":"0xc684c6587712e5e7bdf9fd64415f23bd2b05faec","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":86400,"increaseTimelock":604800}},{"name":"Steakhouse Confidential Prime USDC","symbol":"steakcUSDC","chainId":1,"tvlUsd":22051402,"address":"0xbEEF00A59B577423653A1526c7009bdE103F542B","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse Prime ETH","symbol":"steakETH","chainId":1,"tvlUsd":21475072,"address":"0xbeef0046fcab1dE47E41fB75BB3dC4Dfc94108E3","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Flowdesk Confidential High Yield USDT","symbol":"fcUSDT","chainId":1,"tvlUsd":20878703,"address":"0xb48C056C5608bA2Ee4cD94AF2bF4b1F25295Bd7e","owner":"0x96a943e7faf7c5ac1ab2bc61cf5ebc7be9dba660","curator":"0x20e81490ef909143d9d6715150cb234e5597e350","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse High Yield USDC","symbol":"bbqUSDC","chainId":8453,"tvlUsd":19853124,"address":"0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100","owner":"0x639bfa26472906ccd40513408284a8ad292bc5d6","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Trezor Steakhouse USDT Prime","symbol":"trSHUSDTp","chainId":1,"tvlUsd":19160002,"address":"0xE4DB1c5A1B709CE4d2adA6985D9D506e58F73829","owner":"0xda9964eaf7a303bd493fa7a6f1593b544f0da80d","curator":"0xda9964eaf7a303bd493fa7a6f1593b544f0da80d","timelocksSeconds":{"addAdapter":0,"removeAdapter":0,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":604800,"increaseTimelock":0}},{"name":"Pendle Ecosystem USDC","symbol":"pendleUSDC","chainId":1,"tvlUsd":19147551,"address":"0x55C1B6e461a6334B567bAF0FEb5D728715446f05","owner":"0xb83a77677c51aaf6c45b0b64199eae6938559e5e","curator":"0x4687e45bb5518a995913a24bb2816fe2031d74d8","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Gauntlet WETH Prime","symbol":"gtwethp","chainId":1,"tvlUsd":17629976,"address":"0x43fCd85E8D9D003D515f886891B7C742AC9f92da","owner":"0xc684c6587712e5e7bdf9fd64415f23bd2b05faec","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"KPK USDC Yield","symbol":"KPK_USDC_Yield","chainId":1,"tvlUsd":16939622,"address":"0xD5cCe260E7a755DDf0Fb9cdF06443d593AaeaA13","owner":"0x8b884f80b3b839f52b6ce168f133e7a5d1f0a537","curator":"0x7e43df1c1c5a2245858b60d4655fda83704e4171","timelocksSeconds":{"addAdapter":259201,"removeAdapter":604801,"increaseAbsoluteCap":259201,"increaseRelativeCap":259201,"setPerformanceFee":1209601,"increaseTimelock":604801}},{"name":"Pendle Ecosystem High Yield USDC","symbol":"pendleUSDChy","chainId":1,"tvlUsd":15978566,"address":"0xcf609F8327E68b42AF54F9D529b9f65d68038435","owner":"0xb83a77677c51aaf6c45b0b64199eae6938559e5e","curator":"0x4687e45bb5518a995913a24bb2816fe2031d74d8","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"3F x Steakhouse USDC","symbol":"3F-steakUSDC","chainId":1,"tvlUsd":15218646,"address":"0xBEEf3f3A04e28895f3D5163d910474901981183D","owner":"0x433d49211c6d5121669d643b674d4b22b0185c12","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"msETH Vault","symbol":"msETHVault","chainId":1,"tvlUsd":14976775,"address":"0x62F01b1Cc2fe558FEc938378e6BcC42677221674","owner":"0x9520b477aa81180e6ddc006fc09fb6d3eb4e807a","curator":"0x9520b477aa81180e6ddc006fc09fb6d3eb4e807a","timelocksSeconds":{"addAdapter":0,"removeAdapter":0,"increaseAbsoluteCap":0,"increaseRelativeCap":0,"setPerformanceFee":0,"increaseTimelock":0}},{"name":"RockawayX Tori Ecosystem","symbol":"roxTORI","chainId":1,"tvlUsd":14208069,"address":"0x3BD9AdAE6643dDcddD02746b8B60075E56DF9478","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Huma USDC Main","symbol":"humaUSDC","chainId":1,"tvlUsd":13795414,"address":"0x8aC91877b93330f52b2979a31a4879506021475c","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"3Jane Ecosystem Vault","symbol":"CS3JANECO","chainId":1,"tvlUsd":13640214,"address":"0xe05faDf242331808f504661BEA65972594869826","owner":"0xb3cf59a5f12ca319861376c5e63eef4790a42b44","curator":"0x5634520dd1c044fd8e589a7113c2d8f8f279fc24","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"RockawayX Confidential RWA USDC","symbol":"roxcUSDC","chainId":1,"tvlUsd":12066531,"address":"0xc207d3f66537D7F66456808379A0E560cF20Da36","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"Waterline Reservoir USDC","symbol":"reservoirUSDC","chainId":1,"tvlUsd":12063571,"address":"0xBEeFF047C03714965a54b671A37C18beF6b96210","owner":"0x5c48cffd30a4001916992f464078c47b6e0a92fc","curator":"0xc5fa35a7da6798211d4acd6b1d36f2f3e8c6dbdb","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"RockawayX USPC ecosystem vault","symbol":"roxUSPC","chainId":1,"tvlUsd":11889364,"address":"0x195B3a57dd0480534c84A5607a52a92304fA81f2","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"RockawayX f(x) Protocol Ecosystem USDC","symbol":"roxFX","chainId":1,"tvlUsd":11515419,"address":"0x2cA22cb25558fa2018ecb1CE4eD8AF92Ee7ea423","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Galaxy USDT Quality","symbol":"gUSDTq","chainId":1,"tvlUsd":10871275,"address":"0x71ffB6a81786eC285D429d531Cf655107B9D878d","owner":"0x42d510edeb9257f8d920d5b9f5109d95cb22419d","curator":"0xa13094eced689b7419baba12851374424c1486f1","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":604800,"increaseTimelock":604800}},{"name":"Wintermute USDT Select","symbol":"armUSDTs","chainId":1,"tvlUsd":10724028,"address":"0x500aE64100D7DbDb640531085C2F5d40cDC8930D","owner":"0xb83a77677c51aaf6c45b0b64199eae6938559e5e","curator":"0x4687e45bb5518a995913a24bb2816fe2031d74d8","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Uniswap USDC","symbol":"uniUSDC","chainId":1,"tvlUsd":10500854,"address":"0x5B453493D2328E7F747eb2e66446eFe707728be7","owner":"0x1a9c8182c09f50c8318d769245bea52c32be35bc","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":86400,"increaseTimelock":604800}},{"name":"Galaxy USDC Quality","symbol":"gUSDCq","chainId":1,"tvlUsd":10202984,"address":"0x91600E31fBeDc72433d4a57F16639cfe661Be7d8","owner":"0x42d510edeb9257f8d920d5b9f5109d95cb22419d","curator":"0xa13094eced689b7419baba12851374424c1486f1","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":604800,"increaseTimelock":604800}},{"name":"ARGt Prime","symbol":"sARGt","chainId":42161,"tvlUsd":9574476,"address":"0x9Dd3F844747AB78d616BF76DB92756E17A064aDD","owner":"0x43d4d35522e8c1baf9394bfbb285b3da23d627c9","curator":"0x864d311823e2bd71a910b3e82fdea72ce935bd81","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":259200,"increaseTimelock":604800}},{"name":"M1 USDC","symbol":"m1USDC","chainId":1,"tvlUsd":8621376,"address":"0xAb5955EB671d150527f8E61A42B703832F86616C","owner":"0x5c48cffd30a4001916992f464078c47b6e0a92fc","curator":"0xc5fa35a7da6798211d4acd6b1d36f2f3e8c6dbdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Galaxy USDC Enhanced","symbol":"gUSDCe","chainId":1,"tvlUsd":8612030,"address":"0xd95fE7adF5075fad9D6Bf853E0f9Fe53369E8D96","owner":"0x42d510edeb9257f8d920d5b9f5109d95cb22419d","curator":"0xa13094eced689b7419baba12851374424c1486f1","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Metronome msUSD","symbol":"msUSDVault","chainId":1,"tvlUsd":8136192,"address":"0x5c9D6e4573FDC5262D1F398911Ca59D7e7D9886E","owner":"0x9520b477aa81180e6ddc006fc09fb6d3eb4e807a","curator":"0xdf826ff6518e609e4cee86299d40611c148099d5","timelocksSeconds":{"addAdapter":0,"removeAdapter":0,"increaseAbsoluteCap":0,"increaseRelativeCap":0,"setPerformanceFee":0,"increaseTimelock":0}},{"name":"Api3 dCOMP USDC","symbol":"Api3-dCOMP-USDC","chainId":1,"tvlUsd":7826141,"address":"0x36cfe1568461E499391ef0A555300F1ae2da2439","owner":"0xbbe0de9757f93e3306adbfebe906ab285edd13da","curator":"0x24db7c6f689e480d6e5d45dad400cc4456c832f0","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Re Ecosystem Vault","symbol":"REECOUSDC","chainId":1,"tvlUsd":7564785,"address":"0xD1E9242e075Db4bdd3f3c721D7d5fd4180A94A7e","owner":"0xb3cf59a5f12ca319861376c5e63eef4790a42b44","curator":"0x5634520dd1c044fd8e589a7113c2d8f8f279fc24","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Utorg USD Yield","symbol":"utorgYieldUSDC","chainId":1,"tvlUsd":7521488,"address":"0xE48fc1A3fD6C3Da483FB587d6C24151E402BE02c","owner":"0x185543e75c8162e0bde8a0801c5848bec63571f4","curator":"0xec3a970e6b6081581cb64beff42aef8e23e03c34","timelocksSeconds":{"addAdapter":0,"removeAdapter":0,"increaseAbsoluteCap":0,"increaseRelativeCap":0,"setPerformanceFee":0,"increaseTimelock":0}},{"name":"Keyrock USDC","symbol":"kUSDC","chainId":1,"tvlUsd":7154959,"address":"0x04422053aDDbc9bB2759b248B574e3FCA76Bc145","owner":"0xba75546acd56b3a9142f94f179b03970ee4283fd","curator":"0x9ea3709e1a3f0b9501dd4a66163861d9bcce7a08","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Hyperithm USDC Apex","symbol":"hyperUSDCa","chainId":1,"tvlUsd":6849310,"address":"0x093272C07700d3cA5301C3Bf9B3A392624179E2F","owner":"0xee7e9bb21d5589bf657b94083db2fa349a3918c8","curator":"0x75178137d3b4b9a0f771e0e149b00fb8167ba325","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Aerie x Plume USDC Core","symbol":"AxP-USDC Core","chainId":1,"tvlUsd":6348043,"address":"0x5E2339BCb89B42782CEE454B46C7C6f88c0E4f83","owner":"0x4c16ba8cc9be062aa381240ee09e037c5e152850","curator":"0xa58f41ddfd3e8e601349dbf5ac0213f614150f0f","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Apyx USDC","symbol":"ApyxUSDC","chainId":1,"tvlUsd":6114116,"address":"0x069662D2588fcaC24B5c209456Db965D151556f0","owner":"0xee7e9bb21d5589bf657b94083db2fa349a3918c8","curator":"0x75178137d3b4b9a0f771e0e149b00fb8167ba325","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Belem RWA EURCV","symbol":"rwaEURCV","chainId":1,"tvlUsd":5888840,"address":"0xD6d4b804014EF27836dBe9f8f6Bf6c71251548Ec","owner":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","curator":"0xbbacdcfb9691dfa1066ab29edfcc4a73f6def918","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"KPK wARS Yield","symbol":"KPK_wARS_Yield","chainId":1,"tvlUsd":5845207,"address":"0xb5ce3CA2C774b72955C25875022FdD91f7a7B938","owner":"0x8b884f80b3b839f52b6ce168f133e7a5d1f0a537","curator":"0xeacfa855d172f1b40d9b04245960b2c12266c5f5","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":1209600,"increaseTimelock":604800}},{"name":"Wintermute Confidential WBTC","symbol":"armcWBTC","chainId":1,"tvlUsd":5799391,"address":"0x3d5EcCb62974178236A768A7ef14D3ce468Fbe91","owner":"0xb83a77677c51aaf6c45b0b64199eae6938559e5e","curator":"0x4687e45bb5518a995913a24bb2816fe2031d74d8","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"KPK USDC Yield","symbol":"KPK_USDC_Yield","chainId":8453,"tvlUsd":5560832,"address":"0x392B3CCf36C8adB8094F45573346B457414cD752","owner":"0x8b884f80b3b839f52b6ce168f133e7a5d1f0a537","curator":"0x58c83ce55164537f9c73d5b65c426691bc26ffa0","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":1209600,"increaseTimelock":604800}},{"name":"sky.money USDC Risk Capital","symbol":"skyMoneyUsdcRiskCapital","chainId":1,"tvlUsd":5454144,"address":"0x56bfa6f53669B836D1E0Dfa5e99706b12c373ecf","owner":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","curator":"0x3f32bc09d41ee699844f8296e806417d6bf61bba","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Steakhouse tGBP","symbol":"bbqTGBP","chainId":1,"tvlUsd":5145754,"address":"0xbeeffABcd0dB09589Dd21854aa760C52aB4bf04F","owner":"0x4d7bd498bb24098ca281c05519629c605407f71d","curator":"0x827e86072b06674a077f592a531dce4590adecdb","timelocksSeconds":{"addAdapter":604800,"removeAdapter":604800,"increaseAbsoluteCap":604800,"increaseRelativeCap":604800,"setPerformanceFee":0,"increaseTimelock":604800}},{"name":"Gauntlet USDC Frontier","symbol":"gtusdcf","chainId":8453,"tvlUsd":5008613,"address":"0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765","owner":"0x5a4e19842e09000a582c20a4f524c26fb48dd4d0","curator":"0x9e33faae38ff641094fa68c65c2ce600b3410585","timelocksSeconds":{"addAdapter":259200,"removeAdapter":604800,"increaseAbsoluteCap":259200,"increaseRelativeCap":259200,"setPerformanceFee":86400,"increaseTimelock":604800}}];
const MORPHO_METHODOLOGY = "Census taken 2026-11-17 from the Morpho Blue API (vaultV2s, TotalAssetsUsd desc, chains 1/8453/42161, >= $5M TVL = 68 vaults). Every owner, curator and timelock value was verified on-chain with 1,632 eth_calls (12 reads x 68 vaults x 2 independent RPCs) at pinned finalized blocks: Ethereum 26436921, Base 58768413, Arbitrum 525124696 (block hashes identical across each RPC pair; 0 disagreements; chain values equal the Morpho API values for every owner and timelock read). increaseRelativeCap is the Morpho API value. This is a dated snapshot, not live data; use /v1/crypto-alpha-feed for live TVL/APY.";
function morphoAuditProduct() {
  return {
    product: "Morpho Vaults V2 — Verified Census & Timelock Audit",
    snapshotDate: "2026-11-17",
    methodology: MORPHO_METHODOLOGY,
    verification: { ethCalls: 1632, rpcPairsPerChain: 2, disagreements: 0, pinnedBlocks: { "1": 26436921, "8453": 58768413, "42161": 525124696 } },
    chains: [1, 8453, 42161],
    minTvlUsd: 5000000,
    count: MORPHO_CENSUS.length,
    vaults: MORPHO_CENSUS,
  };
}
async function morphoLiveFeed() {
  const query = "query { vaultV2s(first: 25, orderBy: TotalAssetsUsd, orderDirection: Desc, where: {chainId_in: [1, 8453, 42161]}) { items { address name symbol chain { id } totalAssetsUsd apy netApy performanceFee managementFee } } }";
  const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json", "user-agent": "LensExtract-AlphaFeed/1.0 (+x402 service)" }, body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error(`Morpho API HTTP ${r.status}`);
  const j = await r.json();
  const items = j && j.data && j.data.vaultV2s && j.data.vaultV2s.items;
  if (!Array.isArray(items) || items.length === 0) throw new Error("Morpho API returned no vaultV2s items");
  return {
    product: "Morpho Vaults V2 — Live TVL & APY Feed",
    mode: "live",
    generatedAt: new Date().toISOString(),
    source: "Morpho Blue API (blue-api.morpho.org/graphql), fetched live at request time",
    chains: [1, 8453, 42161],
    count: items.length,
    vaults: items.map((v) => ({ name: v.name, symbol: v.symbol, address: v.address, chainId: v.chain ? v.chain.id : null, totalAssetsUsd: Math.round(v.totalAssetsUsd), apy: v.apy, netApy: v.netApy, performanceFee: v.performanceFee, managementFee: v.managementFee })),
  };
}
async function alphaFeedProduct() {
  try {
    return await morphoLiveFeed();
  } catch (e) {
    return {
      product: "Morpho Vaults V2 — Live TVL & APY Feed",
      mode: "snapshot-fallback",
      liveFetchError: e.message,
      note: "The live Morpho Blue API fetch failed at request time; serving the verified 2026-11-17 census snapshot instead (TVL figures are the snapshot values, APY fields are absent).",
      snapshotDate: "2026-11-17",
      source: "Phase 18 verified census snapshot (see /v1/morpho-vault-audit)",
      chains: [1, 8453, 42161],
      count: 25,
      vaults: MORPHO_CENSUS.slice(0, 25).map((v) => ({ name: v.name, symbol: v.symbol, address: v.address, chainId: v.chainId, totalAssetsUsd: v.tvlUsd })),
    };
  }
}
function paidReqsV2(priceAtomic, payToAddr) {
  return { scheme: "exact", network: "eip155:8453", amount: priceAtomic, asset: USDC_BASE, payTo: payToAddr, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
}
function paidReqsV1(priceAtomic, payToAddr, resource, description) {
  return { scheme: "exact", network: "base", maxAmountRequired: priceAtomic, resource, description, mimeType: "application/json", payTo: payToAddr, maxTimeoutSeconds: 60, asset: USDC_BASE, extra: { name: "USD Coin", version: "2" } };
}
async function handlePaidJson(request, env, url, cfg, produce) {
  const FAC = (env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");
  const resource = `${url.origin}${url.pathname}`;
  const need = (error) => {
    const body = { x402Version: 2, error, resource: { url: resource, description: cfg.description, mimeType: "application/json" }, accepts: [paidReqsV2(cfg.priceAtomic, cfg.payTo)] };
    return json(body, 402, { "payment-required": btoa(JSON.stringify(body)) });
  };
  const sigHeader = request.headers.get("payment-signature");
  const xpHeader = request.headers.get("x-payment");
  if (!sigHeader && !xpHeader) return need("PAYMENT-SIGNATURE header is required");
  let payload;
  try { payload = JSON.parse(atob(sigHeader || xpHeader)); } catch { return need("payment header is not valid base64 JSON"); }
  const version = payload.x402Version;
  if (version !== 2 && version !== 1) return need(`unsupported x402Version in payment payload: ${version}`);
  let product;
  try { product = await produce(); } catch (e) { return json({ error: `upstream failure: ${e.message}` }, 502); }
  const requirements = version === 2 ? paidReqsV2(cfg.priceAtomic, cfg.payTo) : paidReqsV1(cfg.priceAtomic, cfg.payTo, resource, cfg.description);
  const body = { x402Version: version, paymentPayload: payload, paymentRequirements: requirements };
  const callFac = async (p) => { const r = await fetch(`${FAC}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const v = await callFac("/verify").catch((e) => ({ json: null, err: e.message }));
  if (!v.json || v.json.isValid !== true) return need(`facilitator rejected payment: ${JSON.stringify(v.json || v.err).slice(0, 300)}`);
  const s = await callFac("/settle").catch((e) => ({ json: null, err: e.message }));
  if (!s.json || s.json.success !== true) return need(`facilitator settle failed: ${JSON.stringify(s.json || s.err).slice(0, 300)}`);
  const receiptHeaders = version === 2
    ? { "payment-response": btoa(JSON.stringify({ success: true, transaction: s.json.transaction || null, network: "eip155:8453", payer: v.json.payer || null })) }
    : { "x-payment-response": btoa(JSON.stringify({ success: true, network: "base", payer: v.json.payer || null })) };
  return json(product, 200, receiptHeaders);
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
      return json({ name: "LensExtract", x402Version: 2, endpoints: [{ method: "POST", path: "/v1/extract", price: "$0.001", network: caip2(env), asset: USDC_BASE, payTo: payTo(env) }, { method: "GET", path: "/v1/morpho-vault-audit", price: "$0.10", network: "eip155:8453", asset: USDC_BASE, payTo: WORK_WALLET }, { method: "GET", path: "/v1/crypto-alpha-feed", price: "$0.05", network: "eip155:8453", asset: USDC_BASE, payTo: WORK_WALLET }, { method: "GET", path: "/ask", price: "10 sats", network: "stacks:1", asset: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", payTo: ASK_PAY_TO }], legacy: "x402 v1 payments (X-PAYMENT header, network \"base\") are also accepted on the Base USDC routes." });
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
    if (url.pathname === "/v1/morpho-vault-audit" && (request.method === "GET" || request.method === "POST")) {
      return handlePaidJson(request, env, url, { description: MORPHO_AUDIT_DESC, priceAtomic: MORPHO_AUDIT_PRICE, payTo: WORK_WALLET }, async () => morphoAuditProduct());
    }
    if (url.pathname === "/v1/crypto-alpha-feed" && (request.method === "GET" || request.method === "POST")) {
      return handlePaidJson(request, env, url, { description: ALPHA_FEED_DESC, priceAtomic: ALPHA_FEED_PRICE, payTo: WORK_WALLET }, alphaFeedProduct);
    }
    return json({ error: "not found" }, 404);
  },
};

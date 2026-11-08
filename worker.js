// LensExtract — Cloudflare Worker variant (same x402 logic as server.mjs).
// Deploy: wrangler deploy worker.js --name lens-extract  (free workers.dev subdomain, no card)
// Env vars (optional): PAY_TO_ADDRESS, PRICE_ATOMIC, FACILITATOR_URL, NETWORK
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function reqs(env, resource) {
  return {
    scheme: "exact", network: env.NETWORK || "base",
    maxAmountRequired: env.PRICE_ATOMIC || "1000",
    resource, description: "Extract clean readable markdown/text from any public web page URL.",
    mimeType: "application/json",
    payTo: env.PAY_TO_ADDRESS || "0x8488E45d428a3B2BC7116c8657b8FF23Cd042ef6",
    maxTimeoutSeconds: 60, asset: USDC_BASE,
    outputSchema: { input: { type: "http", method: "POST", bodyType: "json", bodyFields: { url: { type: "string", required: true }, maxChars: { type: "number", required: false } } }, output: { type: "object" } },
    extra: { name: "USD Coin", version: "2" },
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
    info: { title: "LensExtract", version: "1.0.0", description: "Extract clean readable markdown/text from any public web page URL.", "x-guidance": "Use POST /v1/extract to extract clean markdown from a public web page. Send a JSON body with a 'url' field (required) and optional 'maxChars'. Payment is x402: $0.001 USDC on Base per call; call without payment to receive the 402 payment requirements, then retry with an X-PAYMENT header.", contact: { email: "alkeke45@gmail.com" } },
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
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });
const dec = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
function htmlToMarkdown(html) {
  let h = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const t = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? dec(t[1].trim()) : "";
  h = h.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n").replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n").replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n").replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)").replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1").replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  return { title, markdown: dec(h).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const FAC = (env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");
    if (url.pathname === "/health") return json({ ok: true, service: "lens-extract", version: "1.0.0" });
    if (url.pathname === "/openapi.json") return json(openApiDoc(url.origin));
    if (url.pathname === "/" || url.pathname === "/.well-known/x402" || url.pathname === "/.well-known/x402.json") {
      return json({ name: "LensExtract", x402Version: 1, endpoints: [{ method: "POST", path: "/v1/extract", price: "$0.001", network: env.NETWORK || "base", asset: USDC_BASE, payTo: env.PAY_TO_ADDRESS || "0x8488E45d428a3B2BC7116c8657b8FF23Cd042ef6" }] });
    }
    if (url.pathname === "/v1/extract" && (request.method === "POST" || request.method === "GET")) {
      let input = {};
      if (request.method === "POST") { try { input = await request.json(); } catch { return json({ error: "body must be JSON" }, 400); } }
      else input = { url: url.searchParams.get("url"), maxChars: Number(url.searchParams.get("maxChars") || 20000) };
      const resource = `${url.origin}/v1/extract`;
      const requirements = reqs(env, resource);
      const need = (error) => json({ x402Version: 1, accepts: [requirements], error, extensions: { bazaar: bazaarExtension() } }, 402);
      if (!input.url || !/^https?:\/\//i.test(input.url)) return need("X-PAYMENT header is required; body must include a valid http(s) url");
      const xp = request.headers.get("x-payment");
      if (!xp) return need("X-PAYMENT header is required");
      let payload; try { payload = JSON.parse(atob(xp)); } catch { return need("X-PAYMENT header is not valid base64 JSON"); }
      const body = { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements };
      const call = async (p) => { const r = await fetch(`${FAC}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null), text: "" }; };
      const v = await call("/verify").catch((e) => ({ json: null, err: e.message }));
      if (!v.json || v.json.isValid !== true) return need(`facilitator rejected payment: ${JSON.stringify(v.json || v.err).slice(0, 300)}`);
      const s = await call("/settle").catch((e) => ({ json: null, err: e.message }));
      if (!s.json || s.json.success !== true) return need(`facilitator settle failed: ${JSON.stringify(s.json || s.err).slice(0, 300)}`);
      const maxChars = Math.min(Number(input.maxChars) || 20000, 50000);
      const r = await fetch(input.url, { headers: { "user-agent": "LensExtract/1.0 (+x402 service)" }, redirect: "follow" });
      if (!r.ok) return json({ error: `upstream returned HTTP ${r.status}` }, 502);
      const raw = await r.text();
      const { title, markdown } = htmlToMarkdown(raw);
      const clipped = markdown.slice(0, maxChars);
      return json({ url: input.url, finalUrl: r.url, title, markdown: clipped, text: clipped, wordCount: clipped.split(/\s+/).filter(Boolean).length, truncated: markdown.length > maxChars }, 200, { "x-payment-response": btoa(JSON.stringify({ success: true, network: env.NETWORK || "base", payer: v.json.payer || null })) });
    }
    return json({ error: "not found" }, 404);
  },
};

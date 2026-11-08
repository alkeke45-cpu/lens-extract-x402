// LensExtract — x402-paid URL -> clean markdown extraction API
// Zero-dependency Node >=18 server implementing the x402 (HTTP 402) protocol v1.
//
// Flow:
//   1. Client calls POST /v1/extract without X-PAYMENT  -> 402 + payment requirements (Base mainnet USDC).
//   2. Client pays via its wallet, retries with X-PAYMENT header (base64 payment payload).
//   3. Server forwards payload to the facilitator /verify (and /settle on success).
//      Only a facilitator-verified payment unlocks the extraction. No payment, no service.
//
// Config via env: PORT, PAY_TO_ADDRESS, PRICE_ATOMIC (default 1000 = $0.001),
// FACILITATOR_URL (default https://facilitator.payai.network — the free public
// facilitator whose /supported lists x402 v1 "exact" on Base mainnet; the
// x402.org facilitator covers only testnets for v1, and Coinbase CDP's
// mainnet facilitator needs CDP API keys), NETWORK (default "base").

import http from "node:http";

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS || "0x8488E45d428a3B2BC7116c8657b8FF23Cd042ef6";
const PRICE_ATOMIC = process.env.PRICE_ATOMIC || "1000"; // $0.001 in USDC atomic units (6 decimals)
const NETWORK = process.env.NETWORK || "base";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR_URL = (process.env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");
const RESOURCE_BASE = process.env.RESOURCE_BASE || ""; // public base URL when known (tunnel/deploy)

function paymentRequirements(resourcePath) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE_ATOMIC,
    resource: `${RESOURCE_BASE}${resourcePath}`,
    description: "Extract clean readable markdown/text from any public web page URL. Returns title, markdown, plain text and word count.",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE,
    outputSchema: {
      input: { type: "http", method: "POST", bodyType: "json", bodyFields: { url: { type: "string", required: true, description: "Public http(s) page URL to extract" }, maxChars: { type: "number", required: false, description: "Max characters of markdown returned (default 20000, cap 50000)" } } },
      output: { type: "object", properties: { url: { type: "string" }, finalUrl: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, text: { type: "string" }, wordCount: { type: "number" }, truncated: { type: "boolean" } } },
    },
    extra: { name: "USD Coin", version: "2" },
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function paymentRequiredBody(resourcePath, error) {
  return { x402Version: 1, accepts: [paymentRequirements(resourcePath)], error };
}

async function facilitator(path, payload) {
  const r = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: r.status, json, text };
}

// Verify (and settle) an X-PAYMENT header with the facilitator.
// Returns { ok:true } only when the facilitator confirms a valid, settled payment.
async function verifyPayment(xPaymentHeader, resourcePath) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT header is not valid base64 JSON" };
  }
  const requirements = paymentRequirements(resourcePath);
  const body = { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements };
  let v;
  try {
    v = await facilitator("/verify", body);
  } catch (e) {
    return { ok: false, reason: `facilitator verify unreachable: ${e.message}` };
  }
  if (!v.json || v.json.isValid !== true) {
    return { ok: false, reason: `facilitator rejected payment: ${v.text.slice(0, 300)}` };
  }
  try {
    const s = await facilitator("/settle", body);
    if (!s.json || s.json.success !== true) {
      return { ok: false, reason: `facilitator settle failed: ${s.text.slice(0, 300)}` };
    }
  } catch (e) {
    return { ok: false, reason: `facilitator settle unreachable: ${e.message}` };
  }
  return { ok: true, payer: v.json.payer || payload?.payload?.authorization?.from || null };
}

// --- Extraction: fetch a URL and convert HTML to clean markdown-ish text ---
export function htmlToMarkdown(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
  h = h
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n# $1\n\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n## $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n### $1\n\n")
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n#### $1\n\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  h = decodeEntities(h)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title, markdown: h };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

async function extract(url, maxChars = 20000) {
  const r = await fetch(url, {
    headers: { "user-agent": "LensExtract/1.0 (+x402 service)", accept: "text/html,text/plain" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`upstream returned HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  const raw = await r.text();
  if (ct.includes("text/html") || raw.trimStart().startsWith("<")) {
    const { title, markdown } = htmlToMarkdown(raw);
    const clipped = markdown.slice(0, maxChars);
    return { url, finalUrl: r.url, title, markdown: clipped, text: clipped.replace(/[#*\-[\]()]/g, "").trim(), wordCount: clipped.split(/\s+/).filter(Boolean).length, truncated: markdown.length > maxChars };
  }
  const clipped = raw.slice(0, maxChars);
  return { url, finalUrl: r.url, title: "", markdown: clipped, text: clipped, wordCount: clipped.split(/\s+/).filter(Boolean).length, truncated: raw.length > maxChars };
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/health") return sendJson(res, 200, { ok: true, service: "lens-extract", version: "1.0.0" });

    if (u.pathname === "/" || u.pathname === "/.well-known/x402") {
      return sendJson(res, 200, {
        name: "LensExtract",
        description: "Pay-per-call URL-to-clean-markdown extraction for AI agents, priced in micro-USDC via x402.",
        x402Version: 1,
        endpoints: [{ method: "POST", path: "/v1/extract", price: `$${Number(PRICE_ATOMIC) / 1e6}`, network: NETWORK, asset: USDC_BASE, payTo: PAY_TO, body: { url: "https://example.com/article", maxChars: 20000 } }],
      });
    }

    if (u.pathname === "/v1/extract" && (req.method === "POST" || req.method === "GET")) {
      let input = {};
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) { try { input = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "body must be JSON" }); } }
      } else {
        input = { url: u.searchParams.get("url"), maxChars: Number(u.searchParams.get("maxChars") || 20000) };
      }
      const target = input.url;
      if (!target || !/^https?:\/\//i.test(target)) {
        // Still payment-gated: return requirements so agents learn the price, with the input error noted.
        return sendJson(res, 402, paymentRequiredBody("/v1/extract", "X-PAYMENT header is required; body must include a valid http(s) url"));
      }
      const xPayment = req.headers["x-payment"];
      if (!xPayment) return sendJson(res, 402, paymentRequiredBody("/v1/extract", "X-PAYMENT header is required"));
      const verdict = await verifyPayment(xPayment, "/v1/extract");
      if (!verdict.ok) return sendJson(res, 402, paymentRequiredBody("/v1/extract", verdict.reason));
      const out = await extract(target, Math.min(Number(input.maxChars) || 20000, 50000));
      res.setHeader("x-payment-response", Buffer.from(JSON.stringify({ success: true, network: NETWORK, payer: verdict.payer })).toString("base64"));
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 502, { error: `extraction failed: ${e.message}` });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`LensExtract listening on :${PORT} | payTo=${PAY_TO} price=${PRICE_ATOMIC} atomic USDC on ${NETWORK} | facilitator=${FACILITATOR_URL}`));
}
export default server;

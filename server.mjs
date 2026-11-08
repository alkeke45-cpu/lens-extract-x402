// LensExtract — x402-paid URL -> clean markdown extraction API
// Zero-dependency Node >=18 server implementing the x402 (HTTP 402) protocol.
//
// Protocol: x402 v2 PRIMARY, x402 v1 accepted (dual-stack, migrated 2026-11-08 —
// see MIGRATION-V2.md). v2 is not wire-compatible with v1 (spec has no compat
// provision), so compatibility lives in the payment-ACCEPTANCE path, the way the
// official SDK servers do it (`payment-signature` || `x-payment`):
//   - 402 advertisement is v2-canonical: base64 PaymentRequired JSON in the
//     PAYMENT-REQUIRED response header, same JSON as the body. accepts[] entries
//     use CAIP-2 network ids (eip155:8453) and the `amount` field.
//   - Clients pay with PAYMENT-SIGNATURE (v2) or legacy X-PAYMENT (v1); each is
//     verified/settled against the facilitator with its own x402Version.
//   - Success receipts: PAYMENT-RESPONSE header (v2) / X-PAYMENT-RESPONSE (v1).
//
// Flow:
//   1. Client calls POST /v1/extract without a payment header -> 402 + requirements.
//   2. Client signs an EIP-3009 authorization, retries with the payment header.
//   3. Server forwards payload to the facilitator /verify (and /settle on success).
//      Only a facilitator-verified payment unlocks the extraction. No payment, no service.
//
// Config via env: PORT, PAY_TO_ADDRESS, PRICE_ATOMIC (default 1000 = $0.001),
// FACILITATOR_URL (default https://facilitator.payai.network — the free public
// facilitator whose /supported lists x402 v1 "exact" on Base mainnet AND
// x402 v2 "exact" on eip155:8453, no API key; the x402.org facilitator covers
// only testnets, and Coinbase CDP's mainnet facilitator needs CDP API keys),
// NETWORK (default "base", the v1 name), NETWORK_CAIP2 (default derived).

import http from "node:http";

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS || "0x8488E45d428a3B2BC7116c8657b8FF23Cd042ef6";
const PRICE_ATOMIC = process.env.PRICE_ATOMIC || "1000"; // $0.001 in USDC atomic units (6 decimals)
const NETWORK = process.env.NETWORK || "base"; // x402 v1 network name
const CAIP2_BY_V1 = { base: "eip155:8453", "base-sepolia": "eip155:84532" };
const NETWORK_CAIP2 = process.env.NETWORK_CAIP2 || CAIP2_BY_V1[NETWORK] || NETWORK; // x402 v2 CAIP-2 id
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR_URL = (process.env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/$/, "");
const RESOURCE_BASE = process.env.RESOURCE_BASE || ""; // public base URL when known (tunnel/deploy)
const DESCRIPTION = "Extract clean readable markdown/text from any public web page URL. Returns title, markdown, plain text and word count.";

// --- x402 v1 requirements (legacy clients) ---
function paymentRequirements(resourcePath) {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE_ATOMIC,
    resource: `${RESOURCE_BASE}${resourcePath}`,
    description: DESCRIPTION,
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

// --- x402 v2 requirements ---
// v2 moves resource/description/mimeType out of the accepts entry into a
// separate ResourceInfo object, renames maxAmountRequired -> amount, and
// identifies networks by CAIP-2 id.
function resourceInfo(resourcePath) {
  return { url: `${RESOURCE_BASE}${resourcePath}`, description: DESCRIPTION, mimeType: "application/json" };
}

function paymentRequirementsV2() {
  return {
    scheme: "exact",
    network: NETWORK_CAIP2,
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
}

function paymentRequiredBodyV2(resourcePath, error) {
  return { x402Version: 2, error, resource: resourceInfo(resourcePath), accepts: [paymentRequirementsV2()], extensions: { bazaar: bazaarExtension() } };
}

// --- Discovery documents (added 2026-11-08, wave 5) ---
// x402scan's canonical discovery format is an OpenAPI 3.1 doc at /openapi.json
// whose paid operations carry x-payment-info + a 402 response (see
// https://www.x402scan.com/discovery/spec). The 402 body also declares a
// CDP Bazaar extension (info + schema) so any Bazaar-aware facilitator that
// ever settles a call has the metadata to catalog; CDP itself only indexes
// after a settlement through the CDP Facilitator.
function bazaarExtension() {
  const input = { type: "http", method: "POST", bodyType: "json", body: { url: "https://example.com/article", maxChars: 20000 } };
  const output = { type: "json", example: { url: "https://example.com/article", finalUrl: "https://example.com/article", title: "Example", markdown: "# Example\n\nClean article text.", text: "Example Clean article text.", wordCount: 4, truncated: false } };
  return {
    info: { input, output },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { const: "http" }, method: { enum: ["POST"] }, bodyType: { enum: ["json"] },
            body: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] },
          },
          required: ["type", "method", "bodyType", "body"],
        },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  };
}

function openApiDoc(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: "LensExtract",
      version: "1.0.0",
      description: "Extract clean readable markdown/text from any public web page URL.",
      "x-guidance": "Use POST /v1/extract to extract clean markdown from a public web page. Send a JSON body with a 'url' field (required) and optional 'maxChars'. Payment is x402 v2: $0.001 USDC on Base per call; call without payment to receive the 402 payment requirements in the PAYMENT-REQUIRED header, then retry with a PAYMENT-SIGNATURE header. (Legacy x402 v1 X-PAYMENT headers are also accepted.)",
      contact: { email: "alkeke45@gmail.com" },
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/extract": {
        post: {
          operationId: "extract",
          summary: "Extract - Clean markdown/text extraction from a web page URL",
          tags: ["Data"],
          "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { url: { type: "string", description: "Public http(s) page URL to extract" }, maxChars: { type: "number", description: "Max characters of markdown returned (default 20000, cap 50000)" } }, required: ["url"] } } } },
          responses: {
            "200": { description: "Successful response", content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" }, finalUrl: { type: "string" }, title: { type: "string" }, markdown: { type: "string" }, text: { type: "string" }, wordCount: { type: "number" }, truncated: { type: "boolean" } }, required: ["url", "markdown"] } } } },
            "402": { description: "Payment Required" },
          },
        },
      },
    },
  };
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

// Every 402 this server sends is the v2 advertisement: PAYMENT-REQUIRED header
// (base64 PaymentRequired) + the same JSON as the body.
function send402(res, resourcePath, error) {
  const body = paymentRequiredBodyV2(resourcePath, error);
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  return sendJson(res, 402, body, { "payment-required": header });
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

function decodePaymentHeader(header, label) {
  try {
    return { payload: JSON.parse(Buffer.from(header, "base64").toString("utf8")) };
  } catch {
    return { error: `${label} header is not valid base64 JSON` };
  }
}

// Verify (and settle) a v1 X-PAYMENT header with the facilitator.
async function verifyPaymentV1(xPaymentHeader, resourcePath) {
  const { payload, error } = decodePaymentHeader(xPaymentHeader, "X-PAYMENT");
  if (error) return { ok: false, reason: error };
  const body = { x402Version: 1, paymentPayload: payload, paymentRequirements: paymentRequirements(resourcePath) };
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
    return { ok: true, version: 1, payer: v.json.payer || payload?.payload?.authorization?.from || null, transaction: s.json.transaction || null };
  } catch (e) {
    return { ok: false, reason: `facilitator settle unreachable: ${e.message}` };
  }
}

// Verify (and settle) a v2 PAYMENT-SIGNATURE header with the facilitator.
// The facilitator pins the protocol version by the body's x402Version; the
// paymentRequirements we send are our own canonical v2 accepts entry.
async function verifyPaymentV2(paymentSignatureHeader) {
  const { payload, error } = decodePaymentHeader(paymentSignatureHeader, "PAYMENT-SIGNATURE");
  if (error) return { ok: false, reason: error };
  if (payload.x402Version === 1) return verifyPaymentV1(paymentSignatureHeader, "/v1/extract"); // mislabelled legacy payload
  if (payload.x402Version !== 2) return { ok: false, reason: `unsupported x402Version in PAYMENT-SIGNATURE payload: ${payload.x402Version}` };
  const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: paymentRequirementsV2() };
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
    return { ok: true, version: 2, payer: v.json.payer || payload?.payload?.authorization?.from || null, transaction: s.json.transaction || null };
  } catch (e) {
    return { ok: false, reason: `facilitator settle unreachable: ${e.message}` };
  }
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

    if (u.pathname === "/openapi.json") {
      const origin = RESOURCE_BASE || `http://${req.headers.host || "localhost"}`;
      return sendJson(res, 200, openApiDoc(origin.replace(/\/$/, "")));
    }

    if (u.pathname === "/" || u.pathname === "/.well-known/x402" || u.pathname === "/.well-known/x402.json") {
      return sendJson(res, 200, {
        name: "LensExtract",
        description: "Pay-per-call URL-to-clean-markdown extraction for AI agents, priced in micro-USDC via x402.",
        x402Version: 2,
        endpoints: [{ method: "POST", path: "/v1/extract", price: `$${Number(PRICE_ATOMIC) / 1e6}`, network: NETWORK_CAIP2, asset: USDC_BASE, payTo: PAY_TO, body: { url: "https://example.com/article", maxChars: 20000 } }],
        legacy: "x402 v1 payments (X-PAYMENT header, network \"base\") are also accepted.",
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
        return send402(res, "/v1/extract", "PAYMENT-SIGNATURE header is required; body must include a valid http(s) url");
      }
      const paymentSignature = req.headers["payment-signature"];
      const xPayment = req.headers["x-payment"];
      if (!paymentSignature && !xPayment) return send402(res, "/v1/extract", "PAYMENT-SIGNATURE header is required");
      const verdict = paymentSignature ? await verifyPaymentV2(paymentSignature) : await verifyPaymentV1(xPayment, "/v1/extract");
      if (!verdict.ok) return send402(res, "/v1/extract", verdict.reason);
      const out = await extract(target, Math.min(Number(input.maxChars) || 20000, 50000));
      if (verdict.version === 2) {
        const receipt = { success: true, transaction: verdict.transaction, network: NETWORK_CAIP2, payer: verdict.payer };
        res.setHeader("payment-response", Buffer.from(JSON.stringify(receipt)).toString("base64"));
      } else {
        res.setHeader("x-payment-response", Buffer.from(JSON.stringify({ success: true, network: NETWORK, payer: verdict.payer })).toString("base64"));
      }
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 502, { error: `extraction failed: ${e.message}` });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`LensExtract listening on :${PORT} | payTo=${PAY_TO} price=${PRICE_ATOMIC} atomic USDC on ${NETWORK}/${NETWORK_CAIP2} | facilitator=${FACILITATOR_URL}`));
}
export default server;

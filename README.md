# LensExtract — x402-paid URL → clean markdown extraction API

A pay-per-call micro-service for AI agents, priced at **$0.001 per call** in USDC on
**Base mainnet** via the [x402 protocol](https://www.x402.org/) (HTTP 402).

## What it does
`POST /v1/extract` with `{"url": "https://…", "maxChars": 20000}` returns the page's
title, clean markdown, plain text and word count — the clean-web-content primitive
agents otherwise build (and pay data vendors) for themselves.

## Payment flow
1. Call without payment → `402` with x402 v1 payment requirements
   (`scheme: exact`, `network: base`, asset = Base USDC
   `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `maxAmountRequired: 1000` = $0.001,
   `payTo` = the service wallet).
2. Retry with an `X-PAYMENT` header (EIP-3009 signed authorization, base64 payload).
3. The server verifies **and settles** through the free public PayAI facilitator
   (`https://facilitator.payai.network`, whose `/supported` lists x402 v1 `exact`
   on Base mainnet). No valid payment → no service, ever (fail-closed).

Free endpoints: `GET /health`, `GET /.well-known/x402` (discovery document).

## Run it
- Node: `node server.mjs` (zero dependencies, Node ≥ 18). Env: `PORT`,
  `PAY_TO_ADDRESS`, `PRICE_ATOMIC`, `FACILITATOR_URL`, `NETWORK`, `RESOURCE_BASE`.
- Vercel: this repo deploys as-is (`vercel.json` → `api/index.js`).
- Cloudflare Workers: `wrangler deploy worker.js --name lens-extract`.
- Tests: `node test.mjs` — boots the server and asserts the full 402 handshake,
  including a real facilitator rejection of a forged payment signature.

## Status (2026-11-08)
Built and fully self-tested locally. Settlement path verified against the live
PayAI facilitator (forged signature → `invalid_exact_evm_signature`). Public
hosting from the build host is impossible (egress-only VM behind an HTTP proxy —
see campaign notes), so a one-time free-tier deploy (Vercel or Cloudflare,
GitHub sign-in, no card/KYC) is the only remaining step before Bazaar listing.

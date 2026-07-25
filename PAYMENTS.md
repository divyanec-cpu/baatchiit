# Payments — plan

Written 2026-07-24; updated 2026-07-25 after the Claude Design redesign
settled the open decisions. **Now implemented**: usage metering (1 deciminute
per successful exchange, tracked in `user:<phone>.deciminutes` via
`api/_lib.js`; 15 welcome minutes on signup), wallet + top-up + success
screens, pack list (₹99/60 min, ₹249/180 min, ₹599/500 min), and a
`paymentsEnabled` server flag — the Pay button stays disabled until
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are set. **Still to build**:
`api/payment.js` (create-order + verified webhook) and the checkout.js
integration, per the architecture below. One-time top-ups won (option B),
as recommended.

## Provider: Razorpay

The obvious choice for an India-first product: UPI + cards + netbanking in one
checkout, works fine from a TWA/PWA, and its Standard Checkout is a single
`<script>` tag — which fits this no-framework, single-file app. Test mode
works before KYC finishes (live mode needs completed KYC — start that early,
it can take days).

## What's being sold (decide before building)

Option A — **subscription**: free tier with N translations/day, paid tier
unlimited (₹99/month-ish). Razorpay Subscriptions handles recurring UPI
mandates. More moving parts (plan objects, mandate states, cancellations).

Option B — **one-time top-ups**: buy a pack of translation minutes/uses
(₹49 for 500-ish). One `orders` API call + one webhook. Far simpler; no
recurring-mandate edge cases; matches how the market-stall audience pays for
recharges. **Recommended starting point.**

Either way the unit being metered is a pipeline call, so usage counting has to
land first (see Build order).

## Architecture (mirrors the auth pattern)

- `api/payment.js` — one action-based function, like `api/auth.js`:
  - `create-order`: requires a logged-in session token → `POST
    https://api.razorpay.com/v1/orders` (amount, currency INR, receipt =
    phone) → returns `order_id` + key id for checkout.
  - `webhook`: Razorpay calls this on `payment.captured`. Verify the
    `X-Razorpay-Signature` HMAC-SHA256 against `RAZORPAY_WEBHOOK_SECRET`
    **before trusting anything in the body**; then credit the user in Redis.
    Idempotent: store processed `payment_id`s (`payment:<id>` SETNX) so a
    replayed webhook can't double-credit.
- Client (index.html): a "Plan" section inside the existing Account drawer —
  not a separate page. Logged-in user taps "Buy" → `create-order` → open
  Razorpay Checkout (`checkout.js`) → on success the webhook (not the client
  callback) is the source of truth; the drawer polls `me` until the plan
  flips. Client callback is display-only.
- Redis keys: extend `user:<phone>` with `{plan, credits, planUpdatedAt}`;
  `usage:<phone>:<yyyymmdd>` counters with 48h TTL for the free-tier meter.
- Env vars: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

## Gating (ties into "login optional")

`api/pipeline.js` gains a soft meter: if a session token is present, count
usage against the user; anonymous usage counts against a device id the client
generates. Over the free limit → 402 response → client opens the Account
drawer on the plan section. Login stays optional right up until someone hits
the limit, which preserves the zero-friction market-stall flow.

## Build order

1. Usage metering in `api/pipeline.js` + counters in Redis (invisible, no UX).
2. Razorpay account + KYC + webhook secret; keys into Vercel env.
3. `api/payment.js` (create-order + verified webhook).
4. Plan section in the Account drawer + checkout.js.
5. Test-mode end-to-end (Razorpay test UPI ids), then live.

## Open decisions for Divya

- A or B above (recommend B), price points, and free-tier size.
- Business entity/bank account for Razorpay KYC.
- Whether anonymous users get a free tier at all, or metering starts only
  when logged in.

# Kount Payments Fraud (v2)

OpenShop can screen every card payment with Kount Payments Fraud v2 (Sandbox).
Screening is **off** until `KOUNT_CLIENT_ID` and `KOUNT_API_KEY` are both set
(Worker env or Admin → Developer settings). With screening off, checkout works
exactly as before.

Guidance used: the Kount Payments Fraud v2 integration guide, the Sandbox
Commerce OpenAPI document (API 2.0.0), and the maintainer policy published by
the Kount Developer MCP server. Where they disagree, see [Discrepancies](#discrepancies).

## Flow (post-authorization)

Hosted Stripe Checkout gives the merchant no hook before card authorization,
so OpenShop evaluates **after authorization and before capture**:

```
Storefront (any page)          Worker                         Kount / Stripe
──────────────────────          ──────                         ──────────────
DDC starts, session ID  ─────▶ POST /api/create-*-checkout-session
in sessionStorage               capture_method=manual,
                                saves device session + IP ──▶ Stripe Checkout (authorize only)
                                                               │
                         ◀───── POST /api/webhooks/stripe ◀────┘ checkout.session.completed
                                persist evaluation intent
                                Evaluate Order (riskInquiry=true) ──▶ Kount
                                persist decision (Kount or fallback)
                                APPROVE → capture, fulfillment allowed, PATCH CAPTURED
                                DECLINE → cancel auth, PATCH CANCELED
                                REVIEW  → capture, fulfillment BLOCKED, PATCH CAPTURED
                         ◀───── POST /api/webhooks/kount (reviewer, signed)
                                APPROVE → release fulfillment (no second capture)
                                DECLINE → idempotent Stripe refund → refund.updated
                                          → PATCH REFUNDED / REFUND_FAILED
```

Failed checkout attempts (`payment_intent.payment_failed`) are reported as
data-only orders: issuer decline → `REFUSED`/`DECLINED`; Radar block (before
issuer authorization) → `REFUSED`/`UNKNOWN`.

## Code map

| Path | Role |
|------|------|
| `src/config/kount.js` | Setting definitions, defaults, central validation, Sandbox endpoints |
| `src/lib/kountWebhook.js` | RSA-PSS signature + freshness verification, exact ping match |
| `src/lib/kountDdc.js` | Browser device data collection (Kount Web Client SDK) |
| `src/services/KountClient.js` | OAuth token cache, p-retry backoff with jitter, deadline, Retry-After |
| `src/services/KountService.js` | Payload mapping, decision parsing, attributed fallback, reporting calls |
| `src/services/FraudOrderStore.js` | KV state per order, durable report queue, deferred events |
| `src/services/FraudCheckoutService.js` | Lifecycle orchestration and scheduled recovery |
| `src/routes/public/webhooks.js` | `/api/webhooks/stripe`, `/api/webhooks/kount` |
| `src/worker.js` (`scheduled`) | Cron recovery entry point |

## Setup (Sandbox)

1. Set the settings below in **Admin → Developer settings → Fraud screening (Kount)**
   or as Worker env vars / secrets.
2. Copy the **Kount webhook URL** shown (display-only) on that screen into the
   Kount portal, and paste the portal's webhook public key into
   `KOUNT_WEBHOOK_PUBLIC_KEY`.
3. Copy the **Stripe webhook URL** into Stripe → Developers → Webhooks, subscribe
   to the listed events, and set its signing secret as `STRIPE_WEBHOOK_SECRET`.
4. Deploy. The site toml carries `[triggers] crons = ["*/5 * * * *"]` for the
   recovery job; the settings screen shows when it last ran.

| Setting | Secret | Default | Used for |
|---------|--------|---------|----------|
| `KOUNT_CLIENT_ID` | no | — | Auth (with API key) and browser device collection |
| `KOUNT_API_KEY` | **yes** | — | Token request (`Basic <key>`) |
| `KOUNT_MAX_RETRIES` | no | `2` | Extra attempts after the first (0–3) for every Kount call |
| `KOUNT_FALLBACK_DECISION` | no | `APPROVE` | Applied only when Evaluate Order ends with no usable decision |
| `KOUNT_WEBHOOK_PUBLIC_KEY` | no | — | PEM key for webhook signature verification |
| `KOUNT_CHANNEL` | no | `OPENSHOP_WEB` | Order `channel` |
| `KOUNT_DDC_ENVIRONMENT` | no | `TEST` | Web SDK environment (`TEST` → tst.kaptcha.com, `PROD` → ssl.kaptcha.com) |
| `STRIPE_WEBHOOK_SECRET` | **yes** | — | Stripe webhook signature |

Precedence is Developer Settings (KV) first, then env, resolved per request, so
a saved value applies to the next operation without a redeploy. Both paths use
`validateKountSetting`/`parseKountConfig`: an invalid value is rejected with a
clear error (UI save returns 400 and saves nothing; an invalid env value makes
checkout return 503) rather than silently reverting to a default.

## Decisions, fallback and fulfillment

- **REVIEW** is a valid Kount decision and never triggers the fallback.
- The fallback applies only to Evaluate Order when retries end with no usable
  decision (transport failure, 4xx/5xx, missing or unrecognized decision,
  malformed body). It is stored as `decisionSource: "fallback"` with
  `fallbackReason` and attempt count, shown as "local fallback, not a Kount
  decision" in Fulfillment. With the default `APPROVE`, orders keep flowing
  during a Kount or configuration outage — watch the logs for
  `[Kount] evaluation fallback`.
- The decision is persisted **before** any payment side effect. Duplicate
  Stripe deliveries resume from it; they never re-evaluate.
- Fulfillment is enforced on the server: `POST /api/admin/analytics/orders/:id/fulfill`
  returns **409** while a screened order is held. It is allowed only after
  APPROVE with confirmed capture, or a verified reviewer approval after
  confirmed capture.
- Capture failure leaves the order `capture_failed` (unresolved, never paid).
  Transient Stripe failures return 500 so Stripe redelivers.
- A reviewer decline refunds through Stripe with an idempotency key and no
  `fraudulent` reason (that would feed Radar and block later test purchases).
  `REFUNDED`/`REFUND_FAILED` is reported only after Stripe confirms.

## Payment data mapping

Hosted Checkout never exposes the PAN, so KHASH is not possible. Per the
payment policy, OpenShop sends Stripe's card `fingerprint` as `paymentToken`
with `type: "TOKEN"` — it is stable for the same card within one Stripe
account and mode. `last4`, brand and expiry are included; BIN is not exposed
by Stripe and is never inferred. CVC and AVS come from the charge's card
checks (AVS letters only for definite pass/fail combinations).

## Retries

All Kount calls go through `KountClient` (p-retry): exponential backoff with
jitter, `KOUNT_MAX_RETRIES` extra attempts, a 4 s attempt timeout and a 9 s
total budget covering token, request and sleeps. Network errors, timeouts,
408, 429 and 5xx retry; a Commerce 401 invalidates the cached token and
refreshes inside the same budget; token 4xx and other 4xx do not retry.
`Retry-After` is honored and, if it would overrun the budget, the call stops.
A POST that timed out after sending is flagged `possibleDuplicate` (Kount has
no lookup by `merchantOrderId`, so it cannot be reconciled automatically).

## Webhooks

`POST /api/webhooks/kount` verifies `X-Event-Signature` with RSA-PSS/SHA-256
(salt 32) over `X-Event-Timestamp` + the original body bytes, using exactly the
configured key. Freshness window: 45 minutes past, 5 minutes future skew
(inclusive). Logs are summary-only: reason code, header presence, body length
and SHA-256 prefix, key fingerprint — never raw bodies or signatures.

| Delivery | Result |
|----------|--------|
| Unsigned `{"eventType":"Webhook.TestPing"}` (exact) | 200 no-op |
| Unsigned anything else (incl. `Order.TestPingInjected`) | 401 |
| Signed, no key configured | 503 (route still exists) |
| Bad signature / malformed key / bad encoding | 401 with distinct reason |
| Correct signature, too old / too far in future | 401 `expired` / `future_timestamp_rejected` |
| Verified reviewer status change for unknown order | stored as deferred; recovery applies it later |
| Duplicate event ID | 200 `duplicate` |

Expected business payload (from the k360pf sample; verify against a live
Sandbox delivery): `eventType`, `kountOrderId`, `merchantOrderId`,
`fieldName: "status"`, `oldValue`, `newValue`.

`POST /api/webhooks/stripe` verifies `Stripe-Signature` with
`STRIPE_WEBHOOK_SECRET` (Web Crypto) and handles
`checkout.session.completed`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `refund.created`, `refund.updated`, `refund.failed`.
If screening is turned off while a held (uncaptured) payment exists, the
webhook returns 503 rather than capturing it unscreened.

## Recovery

The cron job (`scheduled` in `src/worker.js`) runs without any buyer request:

- retries pending Kount status PATCHes in order (CAPTURED before REFUNDED),
  with exponential backoff up to 12 attempts, then marks them `rejected` for
  an operator;
- applies deferred reviewer events once their order exists;
- retries failed refund requests and failed data-only reports;
- writes `fraud:recovery:last-run` (shown in Developer settings).

## Known limitations

- **No atomic claim.** Workers KV has no compare-and-swap, so the evaluation
  claim is best-effort. Payment effects are idempotent via Stripe keys, but two
  simultaneous deliveries could each send an Evaluate Order. Tracked as TD-005.
- An evaluation whose owner died after claiming becomes `unknown` and needs an
  operator (check Kount and Stripe); it is not re-sent.
- Fallback decisions after a failed evaluation leave no Kount order, so their
  status updates are recorded as `not_applicable`.
- Dashboard revenue still counts uncaptured/declined sessions (TD-006).
- Not verified against live Sandbox deliveries yet: webhook payload shape,
  Sandbox acceptance of the `TOKEN` fingerprint, and device attachment on the
  evaluated order.

## Discrepancies

| Topic | Sources | Choice |
|-------|---------|--------|
| Token host | Commerce OpenAPI says `login.kount.com`; guide says `login-uat.equifax.com/as/token` | Sandbox endpoint `https://login-uat.equifax.com/as/token` |
| `riskInquiry` shape | Schema: object; reference examples: array | Accept both; record `responseShapeConflict` |
| Date-time fields | Schema pattern rejects its own RFC 3339 examples | `creationDateTime` omitted |
| Item `quantity` | Declared integer; example is a string | Integer |
| Decision spelling | Guide prose uses `DECLINED` in places; schema enum is `DECLINE` | Only `APPROVE`/`DECLINE`/`REVIEW` accepted; others → fallback |
| Device session uniqueness | Guide: unique ≥30 days; schema: not enforced | Fresh ID per browser session |

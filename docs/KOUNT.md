# Kount Payments Fraud (v2)

OpenShop can screen orders with Kount Payments Fraud v2. Screening is off
until it is configured, and checkout works as before until then.

The integration targets the **Kount Sandbox** by default:

- Token URL: `https://login-uat.equifax.com/as/token`
- API base: `https://api-sandbox.kount.com`

## How it works

OpenShop sends buyers to **hosted Stripe Checkout**, which gives the merchant no
hook before authorization. So the integration is **post-authorization**: the
card is authorized, evaluated, and only then captured or released.

```
Storefront (any page) ──► Kount DDC (device session ID, one per browser session)
        │
        ▼ checkout (kountSessionId)
POST /api/create-*-checkout-session
   capture_method=manual, metadata {openshop_order_id, kount_hold}
   KV kount:checkout:{orderId} = {deviceSessionId, userIp}
        │
        ▼ buyer pays on Stripe (authorization only)
Stripe ──► POST /api/stripe-webhook  (signature verified)
   checkout.session.completed
     1. evaluate: POST /commerce/v2/orders?riskInquiry=true  (authResult APPROVED)
     2. persist decision (Kount, or attributed fallback) BEFORE any side effect
     3. APPROVE → capture   DECLINE → cancel authorization   REVIEW → hold
     4. queue PATCH /commerce/v2/orders/{orderId}  (CAPTURED / CANCELED)
   payment_intent.payment_failed → data-only POST (riskInquiry=false), REFUSED
   payment_intent.canceled       → EXPIRED / CANCELED update
```

| Kount decision | Payment | Fulfillment | Buyer sees (success page) |
|---|---|---|---|
| (not yet evaluated) | authorized | blocked | "Processing your order" |
| APPROVE | captured | allowed | "Order confirmed" |
| DECLINE | authorization released | blocked | "We could not complete your order" |
| REVIEW | authorized, not captured | blocked | "Order received" (being reviewed) |
| Reviewer approves | captured | allowed | "Order confirmed" |
| Reviewer declines | authorization released | blocked | "We could not complete your order" |

Fulfillment is enforced on the server: `POST /api/admin/analytics/orders/:id/fulfill`
returns **409** for a held order until it is approved and captured.

**REVIEW orders** are handled in **Admin → Fulfillment**: open the order and
choose *Approve & capture* or *Decline & release*. The reviewer decision is sent
to Kount with the transaction status. Stripe authorizations expire after about
7 days. An expired authorization cannot be captured: it is recorded as
`expired`, reported as `EXPIRED`, and the approve action is refused.

### Failed attempts

A refused authorization on a held checkout is reported as a data-only order
(`riskInquiry=false`), with no risk decision:

- Issuer decline → `transactionStatus: REFUSED`, `authResult: DECLINED`, `declineCode` from the network
- Stripe Radar block (happens before the issuer) → `REFUSED`, `authResult: UNKNOWN`

Each charge is reported once. A redelivered event resumes an unconfirmed
report instead of sending a duplicate.

## Device data collection

`src/lib/kountDdc.js` loads `@kount/kount-web-client-sdk` on **every storefront
entry**, including deep links. Buyers can reach hosted Stripe Checkout from any
page, so collection cannot wait for a checkout page. Behaviour:

- One fresh 32-hex session ID per browser session (`sessionStorage`), kept across navigation.
- Checkout waits up to 1.5 s for `collect-end`, then proceeds either way.
- Collection runs only when `/api/kount/config` reports `enabled` (credentials and webhook secret set).
- CSP allows `tst.kaptcha.com` and `ssl.kaptcha.com` for `script-src`, `connect-src` and `frame-src`.

To check collection in a real browser, compare the device session ID that
the browser used (`getKountCollectionState()`) with the `deviceSessionId` that
was sent, and look for `device.id` in the evaluation response.

## Configuration

Every setting can be set as a Worker env var / secret, or in
**Admin → Developer Settings → Fraud screening (Kount)**. Settings saved in the
UI take precedence over env and apply from the next request. Clearing a field
falls back to env. Both paths use the same validation (`src/config/kount.js`),
and an invalid value is refused rather than silently replaced.

| Setting | Secret | Default | Notes |
|---|---|---|---|
| `KOUNT_CLIENT_ID` | no | — | Also used by browser DDC |
| `KOUNT_API_KEY` | **yes** | — | Raw portal API key, sent as `Basic <key>` to the token endpoint |
| `STRIPE_WEBHOOK_SECRET` | **yes** | — | Required. Without it checkouts are **not** held, because nothing would capture them |
| `KOUNT_MAX_RETRIES` | no | `2` | 0–3 extra attempts after the first, for every Kount API call |
| `KOUNT_FALLBACK_DECISION` | no | `APPROVE` | `APPROVE` or `DECLINE`; used only when evaluation ends without a usable decision |
| `KOUNT_CHANNEL` | no | — | Sent as `channel` when set |
| `KOUNT_SHIPPING_METHOD` | no | — | `STANDARD`, `EXPRESS`, `SAME_DAY`, `NEXT_DAY` or `SECOND_DAY`. Sent as `fulfillment[].shipping.method`; omitted when blank |
| `KOUNT_DDC_ENVIRONMENT` | no | `TEST` | `TEST` or `PROD` collector |
| `KOUNT_TOKEN_URL` | no | Sandbox | https only |
| `KOUNT_API_BASE_URL` | no | Sandbox | https only |

Kount settings are **not** writable by the store agent. A prompt must not be
able to change fraud policy.

### Stripe webhook

Create an endpoint at `https://<site>/api/stripe-webhook` subscribed to:

- `checkout.session.completed`
- `payment_intent.payment_failed`
- `payment_intent.canceled`

Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

### Cron trigger

Pending Kount status updates and data-only reports are retried by the Worker's
`scheduled` handler, so recovery does not wait for another webhook. Add this to
`wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

## Retries, deadline and fallback

`src/services/KountClient.js` runs every call (token, evaluate, data-only, update)
under one [p-retry](https://github.com/sindresorhus/p-retry) loop:

- Exponential backoff with jitter (250 ms → 2 s), `KOUNT_MAX_RETRIES` extra attempts.
- 4 s per attempt and a 12 s total deadline that covers token refreshes and sleeps.
  The token fetch runs inside the attempt, so retries are never nested.
- Retried: network errors, timeouts, 408, 429, 5xx. A Commerce 401 invalidates the
  cached token and refreshes it within the same budget.
- Not retried: other 4xx, and rejected token credentials.
- `Retry-After` is honoured. If the wait would pass the deadline, the call stops
  rather than retrying early.
- Tokens are cached per credential until 60 s before `expires_in`, and concurrent
  refreshes are merged into one request.

**Fallback.** If evaluation ends without a usable decision (retries exhausted,
permanent rejection, missing, unknown or malformed decision), the
`KOUNT_FALLBACK_DECISION` is applied and saved as `decisionSource: "fallback"`,
together with `fallbackReason`, the attempt count and the correlation ID. It is
never labelled as a Kount decision. REVIEW is a valid Kount decision and never
triggers the fallback. Errors from token, data-only and update calls never turn
into approvals. Fallback use is logged and shown on the order in Fulfillment.

> An `APPROVE` fallback lets orders through while Kount is unreachable or
> misconfigured (for example bad credentials). Watch for `[Kount] fallback` log lines.

**Duplicate risk.** If a POST times out after it was sent, Kount may already
have created the order. A replay is marked `possibleDuplicate`. Kount
idempotency and lookup by `merchantOrderId` are not assumed.

## Reporting recovery

Status updates and data-only reports are durable jobs (`kount:job:{id}`) with
these states:

| State | Meaning |
|---|---|
| `pending` | Queued, not yet confirmed. Retried with backoff (1 min doubling, capped at 6 h) |
| `unknown` | A POST may have been accepted. Replayed with `possibleDuplicate` |
| `confirmed` | Kount acknowledged |
| `rejected` | Permanent rejection (4xx, bad credentials, or no Kount order for a fallback decision). Needs repair |
| `escalated` | 12 attempts used up. Needs an operator |

Payment effects (capture or cancel) are never repeated while reporting is
being recovered. `GET /api/admin/kount/status` lists jobs that still need work.
`POST /api/admin/kount/jobs/:id/retry` re-queues one after the cause is fixed.

## Data sent to Kount

Only data that Stripe actually exposes is sent: items, totals in minor units,
billing and shipping person, card brand, last4, expiry, CVC/AVS results, the
authorization code and charge ID, the buyer's IPv4 address and the device
session ID.

**Payment token.** Stripe never exposes the card number. The card is
identified by Stripe's `card.fingerprint`, which is stable for the same card
within the Stripe account. It is sent as `payment.type: "TOKEN"` with
`paymentToken: <fingerprint>`, which the Kount schema documents for
post-authorization calls where the processor returns a token instead of card
data. This applies to both evaluations and refused-attempt reports. Because the
type is `TOKEN`, Kount no longer sees whether the card is credit or debit. A
fingerprint is specific to one Stripe account, so it links orders within this
store but not with the same card seen at other merchants. If a charge has no
fingerprint, the type falls back to `CREDIT_CARD` or `DEBIT_CARD` with no token.
Confirm with Kount that `TOKEN` + Stripe fingerprint is treated as intended for
your account.

The card **BIN** is not exposed by Stripe and is omitted rather than derived.

**Shipping method.** OpenShop checkout offers no shipping options, so there is
no per-order method. `fulfillment[].shipping.method` comes from the store-wide
`KOUNT_SHIPPING_METHOD` and is omitted when that is blank. If Stripe shipping
rates are added to checkout later, a chosen rate whose metadata has
`kount_shipping_method` set to a valid Kount method takes precedence. Rates
without that tag fall back to the store-wide setting.
Timestamps are omitted because the published schema's date-time pattern
rejects its own RFC 3339 examples.

## Known gaps and documented conflicts

- **Kount webhooks** (decision changes made in the Kount portal) are not
  consumed. Reviewers decide in OpenShop. `KOUNT_WEBHOOK_PUBLIC_KEY` is not used yet.
- **Refunds** after capture are not driven by Kount. REVIEW orders are never
  captured before a reviewer decides, so a declined review only needs the
  authorization released.
- **Concurrency:** KV is not transactional. Simultaneous deliveries of the same
  event could race. Stripe usually delivers sequentially, and capture and cancel
  use idempotency keys.
- **Device session reuse** (unresolved upstream): the guide asks for uniqueness
  for 30 days, while the schema does not enforce it. OpenShop uses one ID per
  browser session, so several orders in one session share it.
- **Response shape:** `order.riskInquiry` may be an object (schema) or an array
  (reference examples). Both are accepted, and the array shape is flagged as
  `shapeConflict`.
- **Live verification:** payloads pass the Kount v2 schema validator, and
  behaviour is covered by mocked-transport tests. A Sandbox run with real
  credentials, a signed Stripe test webhook and a deployed browser bundle is
  still needed.

## Code map

| Path | Role |
|---|---|
| `src/config/kount.js` | Settings, defaults, validation |
| `src/lib/kountPayload.js` | Stripe → Kount mapping, response parsing (pure) |
| `src/lib/kountDdc.js` | Browser device data collection |
| `src/services/KountClient.js` | Token cache, retry policy, fallback |
| `src/services/KountOrderService.js` | Decision record, capture/cancel/review, reporting jobs, cron |
| `src/routes/public/stripeWebhook.js` | Signed Stripe webhook |
| `src/routes/public/kount.js` | `GET /api/kount/config` for DDC |
| `src/routes/admin/kount.js` | Status, review, job retry |
| `src/components/admin/KountOrderStatus.jsx` | Fulfillment badge and review panel |
| `tests/unit/kount/`, `tests/integration/kount.test.js` | Tests |

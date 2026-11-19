# Kount Payments Fraud (v2)

OpenShop can screen orders with Kount Payments Fraud v2. Screening is off
until it is configured, and checkout works as before until then.

One setting, `KOUNT_ENVIRONMENT`, selects the Kount environment. It sets the
token server, the API host and the device-collection environment together, so
they can't point at different environments:

| `KOUNT_ENVIRONMENT` | Token URL | API host | Device collector |
|---|---|---|---|
| `SANDBOX` (default) | `https://login-uat.equifax.com/as/token` | `https://api-sandbox.kount.com` | `TEST` (`tst.kaptcha.com`) |
| `PRODUCTION` | `https://login.equifax.com/as/token` | `https://api.kount.com` | `PROD` (`ssl.kaptcha.com`) |

Endpoints are taken from the Payments Fraud v2.0 Integration Guide. Sandbox and
Production use separate credentials, so change the client ID and API key
together with the environment.

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
| REVIEW | authorized, not captured | **On hold** | "Order received" (being reviewed) |
| Kount reviewer approves (webhook) | captured | allowed | "Order confirmed" |
| Kount reviewer declines (webhook) | authorization released | blocked | "We could not complete your order" |

Fulfillment is enforced on the server: `POST /api/admin/analytics/orders/:id/fulfill`
returns **409** for a held order until it is approved and captured.

### Review hold

When Kount returns **REVIEW**, the order is put **On hold**
(`hold: { status: "on_hold", reason: "kount_review", since }` on the order
record):

- It can't be fulfilled. The fulfill endpoint returns 409 ("on hold for Kount
  review") whatever other state the order is in. This also covers the store
  agent, which uses the same endpoint.
- **Admin → Fulfillment** shows it with an **On hold** pill under its own **On
  hold** filter, and leaves it out of **Open**.
- The card stays authorized and isn't captured.

**The hold is released only by Kount.** A reviewer decides in the Kount portal,
and the signed [Kount webhook](#kount-webhook) is processed. OpenShop has no
button or endpoint to approve or decline a review. When the decision arrives,
the hold is released first (`status: "released", releasedBy: "kount", outcome`),
then APPROVE captures and DECLINE releases the authorization. The transaction
status is reported to Kount; the decision isn't sent back, because it came from
Kount.

- **Requires `KOUNT_WEBHOOK_PUBLIC_KEY`.** Without it the webhook can't verify
  deliveries, so held orders stay on hold. A warning is logged whenever an
  order goes on hold while the key is missing.
- **Repeated decisions are safe.** A conflicting later decision is refused
  (`already_resolved`). Repeating the same decision completes a capture or
  release that failed the first time.
- **Expired authorizations:** Stripe authorizations expire after about 7 days.
  If one expires before Kount decides, the hold is released with outcome
  `authorization_expired`, the payment is recorded as `expired` and reported as
  `EXPIRED`, and the order can no longer be captured.

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
| `KOUNT_ENVIRONMENT` | no | `SANDBOX` | `SANDBOX` or `PRODUCTION` (a dropdown in Developer Settings); see the table above |
| `KOUNT_CLIENT_ID` | no | — | Also used by browser DDC |
| `KOUNT_API_KEY` | **yes** | — | Raw portal API key, sent as `Basic <key>` to the token endpoint |
| `STRIPE_WEBHOOK_SECRET` | **yes** | — | Required. Without it checkouts are **not** held, because nothing would capture them |
| `KOUNT_WEBHOOK_PUBLIC_KEY` | no | — | Kount portal public key (base64 DER, or PEM with or without line breaks). Enables `/api/kount-webhook` |
| `KOUNT_MAX_RETRIES` | no | `2` | 0–3 extra attempts after the first, for every Kount API call |
| `KOUNT_FALLBACK_DECISION` | no | `APPROVE` | `APPROVE` or `DECLINE`; used only when evaluation ends without a usable decision |
| `KOUNT_CHANNEL` | no | — | Sent as `channel` when set |
| `KOUNT_SHIPPING_METHOD` | no | — | `STANDARD`, `EXPRESS`, `SAME_DAY`, `NEXT_DAY` or `SECOND_DAY`. Sent as `fulfillment[].shipping.method`; omitted when blank |

Kount settings are **not** writable by the store agent. A prompt must not be
able to change fraud policy.

### Stripe webhook

Create an endpoint at `https://<site>/api/stripe-webhook` subscribed to:

- `checkout.session.completed`
- `payment_intent.payment_failed`
- `payment_intent.canceled`

Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

### Kount webhook

Register `https://<site>/api/kount-webhook` in the Kount portal for order
decision or status changes, and put the portal's public key in
`KOUNT_WEBHOOK_PUBLIC_KEY`. **Developer Settings** shows both webhook URLs
(Kount and Stripe) read-only with a Copy button. They are built from the Site URL.

How a delivery is handled:

| Check | Result |
|---|---|
| Kount portal **Webhook.TestPing** (sent unsigned) | `200`, `outcome: "test_ping"`, no action |
| No public key configured | `503` |
| Missing `X-Event-Timestamp` / `X-Event-Signature`, empty or non-JSON body | `400` |
| Timestamp older than 45 min (Kount's suggested window) or more than 5 min in the future | `400` |
| Signature invalid. RSA-PSS / SHA-256, 32-byte salt, over the timestamp text followed by the raw body | `401` |
| Status/decision changed to APPROVE or DECLINE on an open review | Capture or release, then `200` |
| Same event ID again, unknown order, order not in review, other events | `200` (acknowledged, no action) |
| Capture or release failed in Stripe | `500`, so Kount retries; the retry completes it |

**Test ping.** A live Sandbox `Webhook.TestPing` arrived with no
`X-Event-Signature` or `X-Event-Timestamp` header, only standard headers and
`User-Agent: Go-http-client/1.1`. An unsigned request is therefore accepted only
if its body is a test ping, and then it is acknowledged and ignored. Any other
unsigned request, including an unsigned decision, is rejected and never acted
on. It is still unconfirmed whether real decision events arrive signed with
these header names. Each rejection logs the request's header names (not values)
and its event type, so a different header scheme shows up in `wrangler tail`.

Orders are matched by `kountOrderId`, falling back to `merchantOrderId`. The
expected shape follows Kount's sample event (`Order.StatusChange` with
`fieldName: "status"`, `oldValue`, `newValue`). Kount's guide marks that event
deprecated in favour of *Order Update*. The same fields are read from either,
but the exact payload should be confirmed with a real Sandbox delivery.

The public key is configured by hand. Some Kount reference code fetches it from
a portal endpoint and refreshes it before `validUntil`, but that endpoint isn't
in the integration guide, so OpenShop doesn't call it. When Kount rotates the
key, paste the new one into Developer Settings.

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

- **Kount webhook payload:** built from Kount's sample `Order.StatusChange`
  event and tested with locally signed deliveries. It hasn't yet been checked
  against a real Sandbox delivery or the newer *Order Update* event.
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
| `src/routes/public/kountWebhook.js` | Signed Kount webhook (portal review decisions) |
| `src/lib/kountWebhook.js` | Kount signature verification and event parsing |
| `src/routes/public/kount.js` | `GET /api/kount/config` for DDC |
| `src/routes/admin/kount.js` | Status, review, job retry |
| `src/components/admin/KountOrderStatus.jsx` | Fulfillment badge and read-only Kount/hold panel |
| `tests/unit/kount/`, `tests/integration/kount.test.js` | Tests |

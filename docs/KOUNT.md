# Kount fraud screening

OpenShop can screen every card checkout with **Kount Payments Fraud v2** (Kount 360). Screening is off until it is fully configured. Stores without it keep the plain Stripe Checkout flow.

## Flow (post-authorization, hosted Stripe Checkout)

Hosted Stripe Checkout gives the merchant no hook between "card entered" and "authorization requested". Kount prefers evaluating before authorization, but that is not possible here. OpenShop therefore evaluates **after authorization and before capture**:

```
storefront page load ── Kount DDC SDK (device session ID, one per browser session)
        │
POST /api/create-*-checkout-session  { ..., kountSessionId }
        │   capture_method=manual, metadata kount_hold / kount_session_id / kount_user_ip
        ▼
Stripe hosted Checkout ── card authorized (not captured)
        │
checkout.session.completed ──► POST /api/stripe-webhook
        │   POST /commerce/v2/orders?riskInquiry=true  (authResult APPROVED, AUTHORIZED)
        ├─ APPROVE → capture   → PATCH CAPTURED → fulfillment allowed
        ├─ DECLINE → cancel    → PATCH CANCELED → fulfillment blocked
        └─ REVIEW  → stay held → fulfillment blocked until a reviewer decides
                         ├─ Kount reviewer → POST /api/kount-webhook
                         └─ admin          → POST /api/admin/kount/orders/:id/resolve
```

Other Stripe events (subscribe to them on the same endpoint):

| Event | Action |
|-------|--------|
| `payment_intent.payment_failed` | Data-only order (`riskInquiry=false`) per refused attempt, keyed `<checkout session>:<charge>`. Radar block → `REFUSED` / `UNKNOWN`; issuer decline → `REFUSED` / `DECLINED`. |
| `payment_intent.canceled` | A held authorization canceled outside OpenShop (Stripe expires uncaptured card authorizations after about 7 days) → `EXPIRED` (or `CANCELED`), order parked in `error`. |

Code: [`src/services/KountOrderService.js`](../src/services/KountOrderService.js) (state machine), [`KountService.js`](../src/services/KountService.js) (API client), [`kountPayload.js`](../src/services/kountPayload.js) (Stripe → Kount mapping), [`KountWebhookService.js`](../src/services/KountWebhookService.js), routes in [`src/routes/public/kount.js`](../src/routes/public/kount.js) and [`src/routes/admin/kount.js`](../src/routes/admin/kount.js), browser DDC in [`src/lib/kount.js`](../src/lib/kount.js).

## Order state (KV `kount:order:<checkout session id>`)

| status | payment | fulfillment | buyer sees | next |
|--------|---------|-------------|------------|------|
| `evaluating` | authorized | blocked | processing | in-flight lock (2 min) |
| `evaluation_pending` | authorized | blocked | processing | Kount returned a transient failure; Stripe redelivers (webhook returned 503) |
| `deciding` | authorized | blocked | processing | decision known, capture/cancel not confirmed; next delivery finishes it |
| `approved` | captured | **allowed** | confirmed | — |
| `declined` | canceled | blocked | declined | — |
| `review` | authorized | blocked | received | reviewer decision |
| `error` | authorized / canceled | blocked | received | human; see `reason` |

`error` reasons: `kount_outcome_unknown` (Kount may have created the order: timeout, 5xx, or a crashed evaluation; **never re-posted**, to avoid a duplicate Kount order), `kount_request_failed` (definite 4xx), `kount_no_decision`, `payment_not_held:*`, `capture_impossible:*`, `authorization_expired`, `declined_after_capture`.

Rules this enforces:

- **A failure is never an approval.** Kount errors keep the payment held and fulfillment blocked.
- **Every step is resumable and idempotent.** Capture and cancel use Stripe idempotency keys. A failed Kount `PATCH` stays in `pendingKountStatus` and is retried on the next delivery without capturing again.
- **No regression.** Duplicate or late reviewer events on a settled order are acknowledged and ignored.
- **Decline releases, not refunds.** OpenShop does not capture on REVIEW, so a reviewer decline cancels the authorization. Cancellations carry no `fraudulent` reason, because that feeds Radar and can skew later decisions for the same test identities.

Check `fulfillmentAllowed` before shipping. OpenShop has no fulfillment system yet. Any future one must gate on that flag server-side.

## Configuration

Set these as Worker secrets/vars or in **Admin → Developer settings** (KV takes precedence):

| Key | Required | Notes |
|-----|----------|-------|
| `KOUNT_CLIENT_ID` | yes | Kount merchant/client ID. Public: it is sent to the browser for DDC. |
| `KOUNT_API_KEY` | yes | Portal API key, sent as `Authorization: Basic <key>` to the token endpoint. Secret. |
| `STRIPE_WEBHOOK_SECRET` | yes | `whsec_…` signing secret of the Stripe endpoint below. Screening (and the payment hold) stays **off** without it, so authorizations can't be held with nothing to release them. |
| `KOUNT_WEBHOOK_PUBLIC_KEY` | for reviewer webhooks | PEM public key from the Kount portal. |
| `KOUNT_CHANNEL` | no | Kount channel identifier, if your tenant uses channels. |
| `KOUNT_TOKEN_URL` / `KOUNT_API_URL` | no | Defaults: Sandbox `https://login-uat.equifax.com/as/token` and `https://api-sandbox.kount.com`. |
| `KOUNT_DDC_ENVIRONMENT` | no | `TEST` (default) or `PROD`. |

```bash
wrangler secret put KOUNT_API_KEY
```

```bash
wrangler secret put STRIPE_WEBHOOK_SECRET
```

Stripe endpoint: `https://<site>/api/stripe-webhook` with events `checkout.session.completed`, `payment_intent.payment_failed`, `payment_intent.canceled`.

Kount webhook: `https://<site>/api/kount-webhook` (Order status / Order update events).

CSP allows `https://*.kaptcha.com` (DDC collector) in `script-src`, `connect-src` and `frame-src`.

## Device data collection

`@kount/kount-web-client-sdk` is loaded lazily from `App.jsx` on every storefront entry, including deep links, but not on `/admin`. This matters because buyers can reach hosted Stripe Checkout straight from a product page. The session ID is 32 hex characters, generated once per browser session (`sessionStorage`) and sent with each checkout request. The server accepts `[a-zA-Z0-9.]{1,64}`. An invalid or missing ID never blocks checkout: the order is evaluated without device data.

## Admin API

- `GET /api/admin/kount/orders?status=review`: list screened orders.
- `GET /api/admin/kount/orders/:checkoutSessionId`: get one order.
- `POST /api/admin/kount/orders/:checkoutSessionId/resolve` `{ "decision": "APPROVE" | "DECLINE" }`: resolve `review` or `error` orders.

Resolve reviews within the card authorization window, which is about 7 days.

## Known gaps / to verify in Sandbox

These are unverified against live Kount. Confirm them before production:

- **Kount webhook payload.** The parser follows the k360pf reference (`eventType: Order.StatusChange`, `merchantOrderId`, `kountOrderId`, `newValue`). It also accepts `Order.*` events with `fieldName: status`. Confirm the shape with a real Sandbox delivery.
- **Decision spelling.** Reviewer values `APPROVE`/`APPROVED` and `DECLINE`/`DECLINED` are all accepted, because the guide prose and the schema disagree.
- **Timestamps.** `creationDateTime` and `authorizationStatus.dateTime` are omitted on purpose. The published schema pattern rejects its own RFC 3339 examples.
- **Payment token.** Hosted Checkout never exposes the PAN or BIN. The order sends `payment.type=TOKEN` with Stripe's card fingerprint.
- **Session-ID reuse** across separate risk inquiries in one browser session is not yet confirmed with Kount. The guide says to keep IDs unique for 30 days.
- **KV locking** is best-effort, not transactional (see tech-debt TD-005).
- `userIp` is sent only for IPv4, because the schema format is `ipv4`.

Readiness checklist: run the Kount Developer MCP `check_integration_readiness` with `authorizationFlow: post` and evidence from one held Sandbox checkout.

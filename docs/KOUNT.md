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
        │   retried up to KOUNT_MAX_RETRIES times (exponential backoff + jitter)
        ├─ APPROVE → capture   → PATCH CAPTURED → fulfillment allowed
        ├─ DECLINE → cancel    → PATCH CANCELED → fulfillment blocked
        ├─ REVIEW  → stay held → fulfillment blocked until a reviewer decides
        └─ no decision after all retries → KOUNT_FALLBACK_DECISION (APPROVE or DECLINE)
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
| `evaluating` | authorized | blocked | processing | in-flight lock (2 min); a stale lock is evaluated again |
| `deciding` | authorized | blocked | processing | decision known, capture/cancel not confirmed; next delivery finishes it |
| `approved` | captured | **allowed** | confirmed | — |
| `declined` | canceled | blocked | declined | — |
| `review` | authorized | blocked | received | reviewer decision |
| `error` | authorized / canceled | blocked | received | human; see `reason` |

`error` reasons: `payment_not_held:*`, `capture_impossible:*`, `authorization_expired`, `declined_after_capture`.

## Retries and the fallback decision

Every Kount request (token, risk inquiry, status update, data-only order) is retried on transient failures: network errors and timeouts (5 s per request), HTTP 401 (with a fresh token), 408, 429 and 5xx. Other 4xx responses are not retried.

- **Retries:** `KOUNT_MAX_RETRIES`, 0–3, default 2 (so at most 4 attempts).
- **Backoff:** exponential with full jitter. The wait before retry *n* is random in `[0, min(4 s, 250 ms × 2ⁿ))`. A `Retry-After` header is honored; one longer than 4 s ends the retries.
- **Fallback:** if the risk inquiry still has no decision, `KOUNT_FALLBACK_DECISION` (`APPROVE` by default, or `DECLINE`) is applied as if Kount had returned it. The order records `decisionSource: "fallback"` and `fallbackReason`:
  - `kount_unavailable`: transient failures on every attempt.
  - `kount_request_rejected`: a non-retryable 4xx, which usually means a bad payload or bad credentials. With an `APPROVE` fallback this approves every order until fixed, so watch the logs (`[Kount] risk inquiry failed …`).
  - `kount_no_decision`: Kount answered without a recognized decision. Its order is still updated with the outcome.
  - `kount_error`: an unexpected internal error.
- **Duplicate risk:** Kount cannot look up an order by `merchantOrderId`, so a risk inquiry that timed out cannot be checked before it is retried. A retry after a timeout may create a second Kount order for the same checkout.

Both settings are in **Admin → Developer settings** (or Worker vars) and take effect on the next request.

Rules this enforces:

- **Failures are explicit.** A fallback decision is never mistaken for a Kount decision: `decisionSource` says which it was.
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
| `KOUNT_MAX_RETRIES` | no | Retries per Kount request, `0`–`3`. Default `2`. |
| `KOUNT_FALLBACK_DECISION` | no | `APPROVE` (default) or `DECLINE`, applied when the risk inquiry fails after all retries. |
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

`@kount/kount-web-client-sdk` is loaded lazily from `App.jsx` on every storefront entry, including deep links, but not on `/admin`. This matters because buyers can reach hosted Stripe Checkout straight from a product page.

- **When it runs:** whenever `KOUNT_CLIENT_ID` is set (`/api/kount/config` → `ddcEnabled`), even before screening is fully configured, so collection can be checked on its own.
- **Session ID:** 32 hex characters, generated once per browser session (`sessionStorage`) and passed to the SDK. The same ID is sent with each checkout request and becomes the order's `deviceSessionId`. The server accepts `[a-zA-Z0-9.]{1,64}`.
- **Checkout:** a checkout click waits up to 2 s for collection to finish (`collect-end`) before redirecting to Stripe, so a fast click does not cut collection short. It never blocks: an invalid or missing ID means the order is evaluated without device data.
- **Checking it works:** the browser console logs `[Kount] device data collection started/finished <session id>`, and the network panel shows requests to `tst.kaptcha.com` (Sandbox). On the evaluated order, `deviceId` in the KV record (from `riskInquiry.device.id`) confirms Kount matched the device.
- **Local dev:** `npm run dev` and `npm run dev:local` serve the prebuilt `dist/` without rebuilding it. Run `npm run build` first, or the storefront runs an older bundle without collection.

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
- **Payment token and BIN.** Hosted Checkout never exposes the PAN. The order sends `payment.type=TOKEN` with Stripe's card fingerprint.
  - **Where the BIN can come from:** Stripe's API has a card BIN field, `iin`, plus the issuing bank in `issuer`, on `charge.payment_method_details.card`. Stripe documents both as "for internal use only and not typically available in standard API requests", so they appear only on accounts where Stripe has enabled them.
  - **When it is sent:** if `iin` is present (6–8 digits), the order sends it as `payment.bin`, and `issuer` as `payment.issuingOrganization`. Otherwise both are left out.
  - **To check your account:** retrieve a test-mode Charge and look at `payment_method_details.card.iin`. If it is missing, ask Stripe support to enable it.
  - **Where it does not come from:** Radar rules can match on `:card_bin:` but cannot return the value. Payment Records also document `iin`, but they only cover payments processed outside Stripe.
- **Session-ID reuse** across separate risk inquiries in one browser session is not yet confirmed with Kount. The guide says to keep IDs unique for 30 days.
- **KV locking** is best-effort, not transactional (see tech-debt TD-005).
- `userIp` is sent only for IPv4, because the schema format is `ipv4`.

Readiness checklist: run the Kount Developer MCP `check_integration_readiness` with `authorizationFlow: post` and evidence from one held Sandbox checkout.

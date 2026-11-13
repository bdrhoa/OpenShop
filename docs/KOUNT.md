# Kount fraud prevention

OpenShop can screen orders with **Kount Payments Fraud v2** after card authorization and before capture. It is off until both Kount credentials are set. Without them, checkout works exactly as before.

> Only the **Kount Sandbox** is wired up (`src/config/kount.js`). Going to production needs the production token/API hosts added there and the device collector environment switched from `TEST` to `PROD`.

## Flow

OpenShop uses hosted Stripe Checkout, so it has no point to run code *before* card authorization. Evaluation therefore runs **after authorization and before capture**:

```
Storefront (any page)          Worker                         Stripe / Kount
─────────────────────          ──────                         ──────────────
Kount DDC starts with a   →    create-checkout-session   →    Checkout Session
per-browser-session id         capture_method=manual          (authorize only)
                               PI metadata: kount_hold,
                               device session id, user IP
                                                         ←    checkout.session.completed
                               /api/stripe-webhook
                               → POST /commerce/v2/orders?riskInquiry=true
                                 (with the authorization outcome, CVV/AVS)
                               APPROVE → capture
                               DECLINE → cancel authorization
                               REVIEW  → capture, block fulfillment
                                                         ←    Kount Order Status Change webhook
                               /api/kount-webhook (signature + timestamp checked)
                               reviewer APPROVE → unblock fulfillment
                               reviewer DECLINE → refund (stays blocked)
```

### REVIEW orders

REVIEW orders are **captured right away**, so the payment isn't lost when Stripe's roughly 7-day authorization window runs out during a slow review. Fulfillment stays blocked until a reviewer decides:

- **Reviewer approves:** no payment action is needed. The order moves to `review_approved` and can ship.
- **Reviewer declines:** the payment is fully refunded. The order is never fulfillable.

The fulfillment block is enforced on the server: `POST /api/admin/analytics/orders/:id/fulfill` returns `409` unless the order has no fraud record or is in `approved_captured` / `review_approved`. The admin Fulfillment page shows a "Do not ship" badge on blocked orders and hides the Fulfill button for them.

If the capture at REVIEW time fails (`payment_action_failed`), the reviewer's decision still applies. On approval OpenShop retries the capture. On decline it releases the still-open authorization instead of refunding.

After each payment action OpenShop sends a best-effort `PATCH /commerce/v2/orders/{orderId}` with the transaction status (`CAPTURED`, `CANCELED`, `REFUNDED`). If that update fails, the payment state is kept and the error is saved on the record.

### Failure handling

- **Kount error, timeout, or a response with no decision.** The authorization is **held**, not captured (`evaluation_failed_hold`). A failure is never treated as an approval. Timeouts and HTTP 500 are recorded as *uncertain*: Kount may have accepted the order, so OpenShop never resubmits it automatically. Reconcile in the Kount portal, then capture or cancel in the Stripe Dashboard.
- **Retries.** Token requests retry with bounded backoff. Order writes retry only on `401` (once, after refreshing the token), `429` or `503`, honoring `Retry-After`.
- **Duplicate deliveries.** One KV record per Checkout Session (`kount:order:{sessionId}`) makes repeat Stripe/Kount deliveries no-ops once an order is final. A concurrent Stripe delivery gets `409`, so Stripe retries later. An in-progress record older than 5 minutes is moved to `evaluation_failed_hold` and is not resubmitted. Stripe capture, cancel, and refund calls use per-PaymentIntent idempotency keys.
- **Refunds.** A refund is recorded as complete only when Stripe reports `succeeded`. Otherwise the state is `review_declined_refund_pending` until Stripe sends `refund.updated` (or the older `charge.refund.updated`). Then the record moves to `review_declined_refunded` and Kount is told `REFUNDED`. OpenShop puts `checkout_session_id` in each refund's metadata, and a `kount:pi:{paymentIntentId}` index covers refunds without it. If a refund event arrives before OpenShop has saved the refund ID, the webhook returns `409` so Stripe retries.
- **Failed refunds.** If creating the refund errors, the record moves to `payment_action_failed` and the Kount webhook returns `500`, so Kount redelivers and the refund is retried with the same idempotency key. If Stripe later reports the refund `failed` or `canceled`, the record moves to `payment_action_failed`, Kount is told `REFUND_FAILED`, and the next attempt uses a new idempotency key (`kount-refund-{pi}-{n}`), because Stripe replays the original response for a reused key. The order stays unfulfillable. Retry by redelivering the Kount decline or by refunding in the Stripe Dashboard.
- **Fees.** Refunding a captured payment does not return Stripe's processing fee. That cost comes with capturing REVIEW orders up front.

### Record states

`evaluating`, `approved_captured`, `declined_canceled`, `review_captured`, `review_approved`, `review_declined_canceled`, `review_declined_refunded`, `review_declined_refund_pending`, `evaluation_failed_hold`, `payment_action_failed`. Admins can list them at `GET /api/admin/fraud-reviews`.

## Device data collection

`src/lib/kountDeviceCollection.js` loads `@kount/kount-web-client-sdk` (as a single-page app) on every storefront route except `/admin`. Buyers can go straight from a product page to hosted Checkout, so there is no merchant checkout page where collection could run instead.

- The device session id is 32 hex characters. A new one is created per browser session (`sessionStorage`), kept across navigation, and sent as `kountSessionId` when checkout starts.
- The client ID comes from `GET /api/payments-status` (`fraudPrevention.clientId`). It is not a secret. The API key never leaves the Worker.
- CSP allows `https://*.kaptcha.com` in `connect-src` and `frame-src` (`tst.kaptcha.com` for Sandbox).
- Check that collection worked: the evaluated order should have `riskInquiry.device.id`. The fraud review record stores this as `deviceCollected`.

## Configuration

Set these as Worker secrets or vars, or in **Admin → Developer settings** (KV takes precedence over `env`):

| Key | Secret | Purpose |
|-----|--------|---------|
| `KOUNT_CLIENT_ID` | no | Kount client/merchant ID (the device SDK uses it too) |
| `KOUNT_API_KEY` | yes | Portal Sandbox API key, sent as `Authorization: Basic <key>` to the token endpoint |
| `KOUNT_WEBHOOK_PUBLIC_KEY` | no | Portal webhook public key (PEM or base64 SPKI) |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret for `/api/stripe-webhook` |

Set up webhooks:

1. **Stripe** → Developers → Webhooks → endpoint `https://<site>/api/stripe-webhook`, events `checkout.session.completed`, `refund.updated` and `refund.failed`.
2. **Kount portal** → webhook URL `https://<site>/api/kount-webhook`. Use Order Update (Order Status Change is marked deprecated).

## Open questions from Kount's documentation

These come from the `kount-developer` integration guide. Check them against the Sandbox before going live:

- **Webhook payload shape.** The parser reads the k360pf `Order.StatusChange` sample (`fieldName: status`, `newValue`, `kountOrderId`, `merchantOrderId`), at the top level or nested under `data`. Confirm with a real Sandbox delivery. `DECLINED` is also accepted as `DECLINE`.
- **`X-Event-Timestamp` format.** It is not specified. ISO 8601 and Unix seconds/milliseconds are accepted, within a 45-minute window.
- **Timestamp fields.** `creationDateTime` and `authorizationStatus.dateTime` are omitted, because the OpenAPI pattern rejects its own RFC 3339 examples.
- **Item quantity.** It is sent as an integer, the declared type, although the reference example uses a string.
- **Device session reuse.** The guide asks for uniqueness for 30 days, while maintainer guidance says to use a fresh ID per browser session. Confirm how reuse across separate risk inquiries in one browser session is treated.
- **Payment token.** Raw card data is not available after authorization, so Stripe's card `fingerprint` is sent as `payment.type: TOKEN`.

## Code map

| File | Role |
|------|------|
| `src/config/kount.js` | Endpoints, timeouts, retry limits, record states |
| `src/lib/kountOrder.js` | Stripe → Evaluate Order mapping, response parsing |
| `src/lib/kountWebhook.js` | RSA-PSS signature check, timestamp, payload parsing |
| `src/lib/kountDeviceCollection.js` | Browser DDC and session id |
| `src/services/KountService.js` | Token cache and Kount API calls |
| `src/services/FraudReviewService.js` | Decision handling, Stripe actions, KV records |
| `src/routes/public/webhooks.js` | `/api/stripe-webhook`, `/api/kount-webhook` |
| `src/routes/admin/fraudReviews.js` | `GET /api/admin/fraud-reviews` |
| `tests/lib/kount*.test.js`, `tests/unit/services/{Kount,FraudReview}Service.test.js`, `tests/integration/kount.test.js` | Tests |

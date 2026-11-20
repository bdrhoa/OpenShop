# KV data model

**Source of truth in code:** `src/lib/kv.js` (`KVManager`). Update this doc when key patterns change.

## Index keys

| Pattern | Value |
|---------|--------|
| `products:all` | JSON array of product IDs |
| `collections:all` | JSON array of collection IDs |
| `media:all` | JSON array of media IDs |
| `storefront:pages:index` | JSON array of page index entries (`{ slug, createdAt, updatedAt }`) |

## Entity keys

| Pattern | Entity |
|---------|--------|
| `product:{id}` | Product document (includes `images[]`, optional `collectionId`, `archived`) |
| `collection:{id}` | Collection document |
| `collection:products:{collectionId}` | JSON array of product IDs in collection |
| `media:{id}` | Media metadata record |
| `storefront:page:{slug}` | Puck page-builder document (core slugs `home`/`about` plus admin-created dynamic pages; slugs match `[a-z0-9]+(-[a-z0-9]+)*`, reserved route words rejected — see `src/lib/pageContent.js`) |

## Product shape (typical)

```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "price": 0,
  "images": ["url"],
  "collectionId": "optional-uuid",
  "archived": false,
  "variants": []
}
```

## Collection shape (typical)

```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "heroImage": "url"
}
```

## Media shape

```json
{
  "id": "string",
  "url": "string",
  "source": "string",
  "filename": "string",
  "mimeType": "string",
  "driveFileId": "string",
  "createdAt": 0,
  "updatedAt": 0
}
```

## Storefront page shape

```json
{
  "slug": "home",
  "version": 1,
  "updatedAt": "2026-05-28T00:00:00.000Z",
  "data": {
    "content": [
      {
        "type": "HeroSection",
        "props": {
          "id": "home-hero",
          "title": "Welcome to OpenShop"
        }
      }
    ],
    "root": {
      "props": {
        "title": "optional SEO title (string, max 500 chars)",
        "description": "optional SEO description (string, max 500 chars)"
      }
    }
  }
}
```

Only known root props are kept; unknown keys are dropped during sanitization (`validatePageData`).

## Fraud screening (Kount)

Written by `src/services/FraudOrderStore.js`; see [KOUNT.md](../KOUNT.md).

| Key | Value |
|-----|-------|
| `fraud:order:<cs_id>` | Order record: `evaluation` (state, decision, decisionSource, fallbackReason, attempts, kountOrderId, kountTransactionId, correlationId, possibleDuplicate), `payment` (state, refundId), `review` (status), `fulfillmentAllowed`, `buyerStatus`, `reports[]` (Kount PATCH queue: transactionStatus, state pending/confirmed/rejected/not_applicable, attempts, nextAttemptAt), `conflicts[]` |
| `fraud:pi:<pi_id>` | → `cs_id` |
| `fraud:kount:<kount_order_id>` | → `cs_id` |
| `fraud:checkout:<cs_id>` | `{ deviceSessionId, userIp }` (7-day TTL) |
| `fraud:pending:<cs_id>` | Marker: record has unconfirmed reports |
| `fraud:deferred:<event_key>` | Verified reviewer event awaiting its order |
| `fraud:attempt:<pi_id>:<charge_id>` | Failed-attempt data-only report (confirmed entries expire after 30 days) |
| `fraud:event:<stripe|kount>:<id>` | Processed-event marker (30-day TTL) |
| `fraud:recovery:last-run` | Last cron recovery summary |

No PAN, CVC, tokens or raw webhook bodies are stored.

## Settings and auth

Store settings and admin tokens may use additional keys via `src/services/StoreSettingsService.js` and auth middleware—grep `namespace.put` in `src/` when extending this doc.

**Generated:** manually curated (not auto-synced). Flag drift in [tech-debt-tracker.md](../exec-plans/tech-debt-tracker.md).

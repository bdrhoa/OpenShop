# Technical debt tracker

| ID | Area | Description | Priority | Owner |
|----|------|-------------|----------|-------|
| TD-001 | Docs | `DEVELOPMENT.md` still mentions Pages Functions in places; align with Workers | low | — |
| TD-002 | Tests | More storefront component tests for cart/checkout | medium | — |
| TD-003 | Generated | Automate `kv-data-model.md` from `KVManager` if drift recurs | low | — |
| TD-004 | Lint | Clear remaining `npm run lint` errors in `src/` and `tests/`; then gate full lint in CI | medium | — |
| TD-005 | Kount | `kount:order:*` evaluation lock uses KV (eventually consistent, not atomic). Move per-checkout state to a Durable Object if concurrent webhook deliveries cause duplicate evaluations | medium | — |
| TD-006 | Kount | No admin UI for the review queue yet; resolution is API-only (`/api/admin/kount/orders`) | medium | — |

Add rows when discovering debt; remove or move to completed plans when resolved.

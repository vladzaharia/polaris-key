---
"@polaris-key/worker": minor
"@polaris-key/admin": minor
---

Harden edge-mint: a `.pkey/` push can no longer turn an arbitrary product secret into a publicly
reachable token mint.

- **Secret usage.** `product_secrets.usage` is general (`NULL`) or `edge-mint`, set only through
  `PUT /manage/api/products/<slug>/secrets/<name>` with `"usage"` and audited as `secret.usage`.
  Edge-mint opens only `edge-mint` secrets; the OIDC client-secret path opens only general ones. A
  recipe naming a general secret is `500 misconfigured`.
- **Recipe approval.** New `edge_mint_approvals` table. The mint route signs only when an approval
  equals the current recipe column for column; otherwise it answers `404`, exactly like an unknown
  recipe. A push that changes a security-relevant field makes the recipe inert until re-approved;
  resync deletes approvals for recipe ids the manifest dropped. Config's admin API gains
  `GET …/config/mint`, `POST …/config/mint/<id>/approve` (fields echoed back; `409` if stale;
  `acknowledgeOpenRegistration` required under open registration) and `…/revoke`. The
  acknowledgement is stored on the approval and re-checked on every mint, so a push that opens
  registration (or turns License off) after approval makes the recipe `404` until re-approved.
- **Per-device budget.** Bucket `mintDevice`, 30 mints per device per minute, beside the per-IP one.
- **Discovery.** `config.mint.available` is true only when an approved recipe exists.
- **Console.** An Edge-mint recipes card on the Secrets view, a usage selector when setting a
  secret, and setup-checklist items for pending recipes and unmarked recipe secrets.
- **Upgrade.** Migrations `0025` and `0025a` backfill: every secret a deployed recipe names is
  marked `edge-mint` and every deployed recipe is approved (`approved_by = 'migration'`), so
  existing products keep minting. Operators should review
  `SELECT product, name FROM product_secrets WHERE usage = 'edge-mint'` once after deploy.

The device-facing route keeps its wire contract: no OpenAPI, corpus or SDK change.

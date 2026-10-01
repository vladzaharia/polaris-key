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
  `acknowledgeOpenRegistration` required while the mint is public — open registration,
  anonymous auto-issue enrolment, or an OIDC default tier with Identity on) and `…/revoke`. The acknowledgement is stored on the approval
  and re-checked on every mint, so a push that opens registration, turns License off, or enables
  anonymous `autoIssue` after approval makes the recipe `404` until re-approved. The approval
  also records the sign-in trust (whether Identity is on, and the OIDC provider, issuer, client id
  and group map); while Identity is on, a push that changes any of them makes the recipe `404`
  until re-approved, and the approve body echoes it (`409` if stale). The approval also records whether License was on; the approve body
  echoes it as `licenseEnabled` (`409` if stale, `422` if absent), and the console warns while License is off.
- **Per-device budget.** Bucket `mintDevice`, 30 mints per device per minute, beside the per-IP one.
- **Discovery.** `config.mint.available` is true only when an approved recipe exists.
- **Console.** An Edge-mint recipes card on the Secrets view, a usage selector when setting a
  secret, and setup-checklist items for pending recipes and unmarked recipe secrets.
- **Upgrade.** Migrations `0025_a` and `0025_b` backfill: every secret a deployed recipe names is
  marked `edge-mint` and every deployed recipe is approved (`approved_by = 'migration'`), so
  existing products keep minting. The acknowledgement is backfilled only where the mint was
  already public at deploy; a closed product (djdl) gets none. The sign-in trust is backfilled as deployed. Operators should review
  `SELECT product, name FROM product_secrets WHERE usage = 'edge-mint'` once after deploy.

The device-facing route keeps its wire contract: no OpenAPI, corpus or SDK change.

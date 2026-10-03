# @polaris-key/admin

## 0.1.0

### Minor Changes

- 59564e1: Add `distribution`, the sixth opt-in service, between Release and Update. Release says what
  exists, Distribution delivers it, and Update tells a device what to do next. The chain is
  `release ← distribution ← update`. Distribution ships as a skeleton: it has no routes or outlets
  yet, so turning it on changes no device-facing behaviour today.

  **Action needed if your `.pkey/product` names `release` and `update` without `distribution`.**
  That manifest validated before this change and is now refused with `update_requires_distribution`.
  Add `distribution: { enabled: true }` to its `modules` block before the next push. Until you do,
  the product keeps serving: migration `0033_distribution_backfill` turns Distribution on for every
  product that already has Release on, so the stored state stays coherent. A manifest using the
  legacy `releases` module needs no change.

  - `@polaris-key/manifest`: `ServiceSlug` and `SERVICE_SLUGS` gain `distribution`, and
    `SERVICE_REQUIRES` gains the new edges. `MODULE_SERVICES.releases` now enables release +
    distribution + update. The validator adds two errors, `distribution_requires_release` and
    `update_requires_distribution`. It no longer emits `update_requires_release`: a manifest that
    had Update without Release now gets `update_requires_distribution`, and once Distribution is
    added, `distribution_requires_release`. The product JSON schema accepts `modules.distribution`.
  - `@polaris-key/cli`: `pkey init --modules` and `pkey validate` know the `distribution` slug. The
    scaffold does not add missing `requires` edges: `--modules release,update` writes a manifest
    that fails validation, so name `distribution` too, or use `releases`.
  - `@polaris-key/node` and `@polaris-key/react`: the exported `ServiceSlug` and `ServicesMap`
    types gain `distribution`, defaulting to off. A consumer with an exhaustive
    `Record<ServiceSlug, …>` literal must add the key.
  - Discovery (`/.well-known/polaris.json`) gains an additive `services.distribution` entry:
    `{ "enabled": false }` when off, and `{ "enabled": true, "configured": false, "endpoints": {} }`
    when on. Nothing else in the document changes, and older SDKs ignore the unknown slug.
  - `@polaris-key/worker`: Core gains descriptor hooks through which Release offers its catalog and
    Distribution its delivery state to the services that consume them. A hook whose provider is off
    answers `null`.
  - `@polaris-key/admin`: the console's service list and enablement card show Distribution, and a
    new Distribution view shows whether the release, distribution and update chain is coherent for
    the product.

- 8042cc3: Harden edge-mint: a `.pkey/` push can no longer turn an arbitrary product secret into a publicly
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

### Patch Changes

- Updated dependencies [2baacaf]
- Updated dependencies [bcf402c]
- Updated dependencies [59564e1]
- Updated dependencies [415dff8]
- Updated dependencies [ada5961]
- Updated dependencies [db6fb0d]
- Updated dependencies [fb56b28]
- Updated dependencies [f524aa6]
  - @polaris-key/protocol@0.1.0
  - @polaris-key/manifest@0.1.0
  - @polaris-key/catalog@0.1.0

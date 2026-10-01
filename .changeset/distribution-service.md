---
"@polaris-key/manifest": minor
"@polaris-key/cli": minor
"@polaris-key/node": minor
"@polaris-key/react": minor
"@polaris-key/worker": minor
"@polaris-key/admin": minor
---

Add `distribution`, the sixth opt-in service, between Release and Update. Release says what
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

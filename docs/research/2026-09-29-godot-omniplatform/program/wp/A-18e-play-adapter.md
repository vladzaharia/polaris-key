# A-18e Google Play storefront adapter, with the per-package edit lease

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Admin: store provisioning (storefronts)                                                                                                                        |
| Size        | 2–3 engineer-weeks                                                                                                                                                |
| Depends on  | [A-18a](A-18a-storefront-adapter-layer.md), [A-18b](A-18b-listing-model.md), [P5-03](P5-03-play-connector.md)                                                     |
| Unblocks    | none                                                                                                                                                              |
| Role        | `pkey-implementer`                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                |
| Gates       | adapter conformance suite (including the lease race); spec classification against the pinned discovery document; THREAT-MODEL (rule table is a §9 review trigger) |
| Human input | none to build (fakes); the decision-4 permissions on the Play service account before the first live write (owner)                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                         |

## Goal

Play is a registered `StorefrontAdapter` on the Worker plane. **First**, a per-package edit lease
exists and every Play caller (P5-03's poll and controls, A-16's `?tracks=1` lister, imports and
provisioning) acquires it, so no caller can invalidate another's edit. On top of it, the adapter
writes the listing, images, closed tracks, Google Group testers, release notes and one-time
products through A-18a's gate, classified against the pinned discovery document, and commits with
typed confirmation when production is touched.

## Why

Play has the richest listing API of the new stores, and the owner's guide already provisions its
credential ([S-15 §4.1, §10 item 3](../../notes/S-15-storefront-provisioning.md#41-google-play-worker-plane)).
But "each user may have only a single edit open at a time", and P5-03's poller opens and deletes an
edit on every tick (§5.3). Without a lease, the next poll would silently kill any provisioning edit.

## Read first

- [notes/S-15](../../notes/S-15-storefront-provisioning.md) **§4.1**, **§5.3**, §6.2–§6.6, §8.4,
  §11 (A-18e), owner decisions 2, 4 and 6.
- `connectors/play/{poll,controls,platform,client}.ts` (P5-03, A-16); the P5-03 brief.
- A-18a's `core/storefront/*` and the Apple adapter as the pattern; A-18b's projection.
- `S-15-storefront-provisioning/scan-play-discovery.mjs` (the classification input).

## Scope

**In:**

- **The edit lease (prerequisite, lands first in the PR):** per package, a Durable Object or a KV
  lock with a TTL. Polls skip a tick while provisioning holds it; long uploads renew it. P5-03's
  poll and controls and A-16's `?tracks=1` are switched onto it. Conformance item 10 (a poll tick
  during a provisioning edit neither invalidates it nor runs) is enabled.
- `rules/googlePlay.ts`: allow rules and deny classification for every write in the androidpublisher
  v3 discovery document, revision `20261001`, SHA-256 `bcbce36e…53ad51cf`, as a pinned spec.
- Operations: `details`; `listings` patch and update; `images.upload` (from the blob store, 15 MiB
  cap, `aiGeneratedState`); `tracks.create` (closed testing); `testers` (Google Groups only);
  release notes on tracks; one-time products from `dist_store_products` (store `play`) via
  `monetization.onetimeproducts.patch` with `allowMissing`; prices; `edits.commit` with
  `changesInReviewBehavior=ERROR_IF_IN_REVIEW` and optional `changesNotSentForReview` ("stage only").
- Natural keys and pre-reads from S-15 §6.3 (listing per language, image SHA-1, track by name,
  product by id), with the ledger's own upload record as fallback if `sha1` is absent.
- `readListing` and `status` (`tracks.releases.list` → `releaseLifecycleState`).
- Deep links and verifiers: app create (`apps:search` lists the package, then a read-only edit
  opens), content rating, target audience and app content, category, RTDN (Monetization setup),
  Play Integrity (the one documented link), managed publishing, email tester lists. The 12-tester
  rule for new personal accounts is a preflight operator tick.
- Move the Play client's writes behind `performStoreWrite`; P5-03's existing controls keep working.

**Out:**

- AAB upload (`ci` only, decision 2 and README decision 7). Data safety (decision 4: stays in the
  Console). Microsoft (→ A-18f). Console (→ A-18j).

## Design notes

- **Typed confirmation** (phrase: Play's default-language title) for: `edits.commit` whose tracks
  include production or change a release status; `completed` or a production `userFraction` of
  1.0; any one-time product price change after the initial one. "Manage store presence" also
  covers pricing, so the gate, not the permission, keeps prices typed (§4.1).
- **Never:** all 12 `DELETE`s (including `images.deleteall`, `listings.deleteall` and product
  deletes); `users.*` and `grants.*`; `appsigning.*` and `apprecovery.*`; `orders.refund`,
  `purchases.*.cancel`, `subscriptionsv2.revoke`, `externaltransactions.*`. The conformance suite
  asserts each is unreachable.
- **Decision 6: no deleting Play images in v1.** Replacing a screenshot set uploads the new images,
  then shows a deep link to remove the old ones (§8.4).
- **Decision 4:** the service account holds "Manage store presence" and "Manage testing tracks and
  edit tester lists" plus the release permissions; never Admin; no "Manage policy declarations".
  Permission sufficiency stays [U] until the first write (A-18k).
- Budget: a local sliding counter of 3,000 per minute per bucket (no rate header).
- Audit redaction: Play tester groups are stored as a count.

## Acceptance criteria

- [ ] The lease exists; P5-03 poll and controls and A-16's lister use it; the lease-race
      conformance test passes.
- [ ] Every write in the pinned discovery document is classified; a revision bump fails CI until
      reclassified.
- [ ] The conformance suite passes for Play, including never-list, typed confirmation and
      idempotency over every plan step.
- [ ] Every P5-03 and A-16 Play test passes unchanged.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- storefront play
```

## Hand-off

A-18c moves its Play import onto the lease. A-18j renders Play's plan from its declaration. A-18k
checks permission sufficiency, edit expiry and quota behaviour live.

The role agent sets `--set A-18e in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-18e done`.

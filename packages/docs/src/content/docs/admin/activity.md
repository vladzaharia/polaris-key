---
title: "Activity"
description: "What lands in a product's audit log, and how the console pages through it."
sidebar:
  order: 10
---

The Activity tab is a per-product audit log: every admin-console mutation appends one row, and a
handful of security-relevant runtime events append one too, even though nobody clicked anything
in the console to cause them.

## What's recorded

Every row carries an action string, an optional target (`kind` + `id`), a human summary, and the
verified actor from the session that caused it — never a value the request body could spoof.
Grouped by what triggers them:

| Group                     | Example actions                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Registry                  | `product.create`, `product.link`, `product.update`, `product.delete`                                                |
| Secrets & KEK             | `secret.set`, `kek.reseal`                                                                                          |
| Services & policy         | `product.services.update`, `product.services.revert`, `product.policy.update`, `product.fingerprint.revert`         |
| Signing keys              | `key.prepare`, `key.activate` (or `key.activate.break_glass`), `key.retire`, `key.revoke`                           |
| Licenses                  | `license.create`, `license.update`, `license.tier.change`, `license.overrides`, `license.enable`, `license.disable` |
| License keys              | `key.create`, `key.revoke` — see the note below                                                                     |
| Devices (operator-driven) | `device.deauthorize`, `device.fingerprint.reset`                                                                    |
| Config                    | `schema.publish`, `profile.create`, `profile.delete`, `profile.overrides`                                           |
| Tiers                     | `tier.create`, `tier.update`, `tier.delete`                                                                         |
| Release                   | `release.resync`                                                                                                    |
| Update                    | `update.settings.update`                                                                                            |
| Identity                  | `portal.settings.update`                                                                                            |
| Offline bundles           | `bundle.minted` — see [Offline bundles](/docs/admin/bundles/#nothing-is-stored-but-the-audit-row)                   |
| Access                    | `access.denied`                                                                                                     |

:::note[`key.create` / `key.revoke` name two different things]
Those two action strings are written by **both** the license-key lifecycle and the
product-signing-key lifecycle — a minted or revoked license key, and (for `key.revoke` only,
since a signing key is never "created" outside `key.prepare`) a revoked signing key both land
under the same string with the same target kind (`"key"`). In practice the `id` disambiguates
them: a license key's target id is its opaque hash, a signing key's is its `kid` (something like
`djdl-2026`). Read the summary text if it matters which one a given row means.
:::

### Rows with no actor

Four actions are written by the runtime itself, from a device's own request, with no admin
session behind them at all — they render with a blank actor column:

- `device.fingerprint.drift` — a check-in changed some hardware components but stayed within
  the policy's tolerance; the binding stands.
- `device.fingerprint.mismatch` — drift exceeded tolerance; the binding was retired.
- `device.seat.coalesced` — the same hardware re-registered under a new device id, and the
  stale sibling was retired so one machine holds one seat.
- `license.enroll` — a keyless auto-issued license was minted.

See [Fingerprints](/docs/services/core/fingerprints/) for what triggers the first three.

### `access.denied`

Written when an **authenticated** session fails the platform-admin group check — never for an
unauthenticated request, which is a plain `401` with nothing written, because auditing every
anonymous probe would turn the audit table itself into a denial-of-service surface. Because the
same reasoning applies one level up, `access.denied` rows are themselves rate-limited to **3 per
actor, per product, per 5-minute window**: the `403` is still returned every time, but only the
first few in a burst are written, since the burst is the signal and every row in it individually
is not.

### What's not here: the customer portal's own trail

Customer-facing portal events — a magic-link or OIDC sign-in, a license claimed by key, a device
disconnected from the portal — are audited too, but into a **separate** table (`portal_audit`,
keyed by the customer's account rather than an admin session) that this tab does not read. The
one portal-related action that _does_ show up here is `portal.settings.update` — an operator
changing the module toggles on [Identity](/docs/admin/console-tour/#identity), which is a console
mutation like any other.

## Keyset pagination

`GET /manage/api/products/<slug>/activity?limit=50&beforeAt=…&beforeId=…` returns newest-first.
The console loads the first page on mount; **Load more** re-issues the same call with the last
row's `(at, id)` as the cursor, so paging is stable even while new rows are still being written.
Times render relative ("3 hours ago") with the absolute timestamp in a tooltip.

## Scope and retention

Audit rows are product-scoped — there is no cross-product activity view — and they **survive** a
product being disabled: [deleting a product](/docs/admin/products/#what-deleting-a-product-actually-does)
tombstones the row and scrubs license PII, but never touches `audit`. A scheduled sweep prunes
rows older than **180 days**, the same cutoff applied to the customer portal's own audit table.

## Reference

- [D1 data model](/docs/reference/data-model/) — the `audit` table's columns, under `core`.
- [Console tour](/docs/admin/console-tour/) — where the Activity tab sits in the nav.

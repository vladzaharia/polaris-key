---
title: "Activity"
description: "What lands in a product's audit log, and how the console pages through it."
sidebar:
  order: 10
---

**Core → Activity** (`#/p/<slug>/activity`) is a per-product audit log: every admin-console mutation appends one row, and a
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
| Config                    | `schema.publish`, `profile.create`, `profile.update`, `profile.delete`, `profile.overrides`                         |
| Tiers                     | `tier.create`, `tier.update`, `tier.delete`                                                                         |
| Release                   | `release.resync`, `release.channel.floor`                                                                           |
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
session behind them at all. The console shows them as **Polaris Key**, with a server glyph in
place of initials:

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

## Reading the log

The page groups rows by day (Today, Yesterday, then dates) and phrases each action as a verb:
`license.disable` reads "disabled license", followed by a link to the target when the console
has a page for it (a license, tier, profile or device; secrets, signing keys and CI tokens link to
**Keys & secrets**). Expanding a row shows its summary and the raw action code. **Table** switches
to a When / Actor / Action / Target / Summary table; **Export loaded (CSV)** saves the entries
loaded so far.

### Filters

Every filter is applied by the server and kept in the page URL, so a filtered view is a link you
can share:

| Filter | Query key        | Sent as                                                                                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| Actor  | `actor`          | `actor`: a session subject or email, exactly; `system` for the runtime rows above.               |
| Action | `action`         | `action`: a prefix, by area (`license.` matches `license.create` and `license.tier.change`).     |
| Target | `kind`, `target` | `targetKind` and `targetId`, exactly.                                                            |
| When   | `range`          | `since`: the last 24 hours, 7, 30 or 90 days, measured from when you chose it or last refreshed. |

**Search** narrows the entries already loaded by their text; **Load older** fetches more.

### The API

`GET /manage/api/products/<slug>/activity?limit=50&beforeAt=…&beforeId=…` returns newest-first,
and accepts the filters above as `action`, `actor`, `targetKind`, `targetId`, `since` and
`until` (epoch seconds, inclusive). A malformed filter is refused with `422` naming the field.
**Load older** re-issues the same call, with the same filters, and the last row's `(at, id)` as
the cursor, so paging is stable even while new rows are still being written.

## Scope and retention

Audit rows are product-scoped — there is no cross-product activity view (platform-level
actions have [their own trail](#the-platform-trail)) — and they **survive** a
product being disabled: [deleting a product](/docs/admin/products/#what-deleting-a-product-actually-does)
tombstones the row and scrubs license PII, but never touches `audit`. A scheduled sweep prunes
rows older than **180 days**, the same cutoff applied to the customer portal's own audit table.

The blob collector's trail, `blob_gc_log` (every ref it dropped or restored and every object it
deleted), follows the same **180-day** cutoff. It is platform-wide, not product-scoped: it has no
foreign key to `products` (an object's deletion belongs to no single product; a `ref-dropped` row
names the product whose ref it dropped), and it carries storage keys, never personal data.

## The platform trail

Actions on the platform as a whole, which belong to no product, are recorded in a separate
table, `platform_audit` (A-12). The KEK re-seal sweep writes one row there per run, with the
remaining-row counts before and after as JSON; it still writes its per-product `kek.reseal` row
into each product it touched, so a product's own log keeps showing it. Every change to a
[runtime platform setting](/docs/admin/platform-settings/) writes a `platform.setting.set` or
`platform.setting.revert` row there too, with the stored and effective value before and after.
Each row has the same actor, action, target and summary
fields as `audit`, plus `before` and `after` values, which never hold a secret. The same
**180-day** sweep prunes it.

```http
GET /manage/api/platform/activity?limit=50&beforeAt=<epoch>&beforeId=<id>
```

The endpoint is for platform admins only (403 otherwise). It pages newest first, with the same
`(at, id)` cursor as the product feed, and returns
`{ items: [{ id, at, actor, action, target, summary, before, after }], nextCursor }`. The
console's Platform section will show it; until then, call it directly.

## Reference

- [D1 data model](/docs/reference/data-model/) — the `audit` table's columns, under `core`.
- [Console tour](/docs/admin/console-tour/) — where Activity sits in the nav.

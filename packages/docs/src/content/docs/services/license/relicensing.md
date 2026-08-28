---
title: "Re-licensing"
description: "Changing a license's tier and having running clients pick it up — no push channel, the ETag as the change signal, grandfathered downgrades, re-derived expiry."
sidebar:
  order: 7
---

**Re-licensing** is changing a license's `tier_id`: a trial converts to paid, a customer upgrades
to a plan with more seats, a lapsed subscription drops back to free.

The mechanism is deliberately boring. There is **no push channel**, no websocket, no
invalidation broadcast. Entitlements are re-merged from scratch on every document request, so a
tier change lands the next time a running client refreshes.

## Making the change

```http
PATCH /manage/api/products/<slug>/license/licenses/<id>
Content-Type: application/json

{ "tier": "pro" }
```

The same `PATCH` also moves `name`, `email`, `expiresAt`, `maxOfflineDays`, `channels`,
`minVersion`, `maxVersion`, and the license's attached profiles. Every one of those reaches
clients by the same route as a tier change; the tier is simply the change that has a name.

A tier is considered changed when `tier` is present in the body **and** its value differs from
the stored one. `"tier": null` clears it.

Two audit entries are written when it moves — `license.tier.change` recording old to new, and the
generic `license.update`. When the tier did not move, only the generic entry appears.
`test/relicense.test.ts` pins both: the tier-change summary contains both tier ids, and a patch
that renames the license writes no tier-change entry at all.

Tiers cannot be deleted out from under licenses: `DELETE` on a referenced tier is `409` with the
reference count.

## How a running client finds out

1. The admin `PATCH` writes `licenses.tier_id` and bumps `licenses.modified_at`.
2. On the client's next `GET /<product>/license/document`, the server re-merges every payload
   layer for the license and stamps tier policy on top as enforced entitlements. Nothing is
   cached across requests.
3. The injected entries carry `updatedAt = licenses.modified_at`, so their values **and** their
   timestamps have changed.
4. The document's ETag is computed over content — including `entitlements` — so the tag changes.
5. The client's `If-None-Match` no longer matches, it receives a fresh document, and its change
   callback fires.

`test/relicense.test.ts` walks exactly this: a license on a five-seat `free` tier reports
`deviceLimit: 5`; after `{"tier": "pro"}` the very next document fetch reports
`license.tier: "pro"` and `deviceLimit: 10`, with no client action in between.

### The ETag is the change signal

The tag deliberately excludes `issuedAt`, `expiresAt` and `graceUntil`, so it is stable across
refreshes of an unchanged license and differs only when the **content** differs. That is the
whole reason an SDK can treat "tag changed" as "something real changed" rather than as noise.

Two cases the tests pin:

- After a tier change, the tag differs from the tag before it.
- Two consecutive fetches with nothing changed in between return the **same** tag.

See [The license document](/docs/services/license/document/#the-etag) for how the tag is derived.

### How quickly

That depends on the client's refresh cadence, not on the server. A license document is valid for
one hour, and the wire contract's refresh rule has a client refetch unconditionally once it is
within half an hour of expiry — so a client that is running and online converges within the
document's own lifetime. A client that is offline sees nothing until it reconnects, which is the
same property that makes grace bounds the only offline revocation lever.

:::note[Immediate revocation is a different action]
If a change must take effect **now**, disabling the license is the action that does it:
`POST …/licenses/<id>/disable` purges the cached token record of every device on the license, so
the next request falls through to a database read that fails the usability check. A tier change
does not do this, and is not meant to.
:::

## Downgrades grandfather

Lowering a tier's seat count does **not** evict anyone. The seat check runs only on a *new*
authorization, so:

- Existing authorized devices keep their seats and keep being served documents.
- New activations are refused with `403 device_limit` until the count drops below the new limit.

`test/relicense.test.ts` pins both halves. Two devices are activated, the license is moved to a
one-seat tier, and afterwards both devices are still `authorized` in the database and the license
document still answers `200` — while a third activation attempt is `403 device_limit`.

### The `overLimit` report

Because grandfathering is silent, the `PATCH` response says so explicitly:

```json
{ "ok": true, "id": "lic_…", "overLimit": { "deviceCount": 2, "deviceLimit": 1 } }
```

`overLimit` appears only when all of these hold: the tier actually changed, the new tier declares
a positive `policy_device_limit`, and the license's active device count exceeds it. Otherwise the
field is absent. It exists so the console can tell the operator what they have just done rather
than leaving them to discover it from a support ticket.

:::caution[Two different counts]
The `deviceCount` reported here counts **every** authorized device on the license. The seat check
that actually refuses an activation applies a 90-day dormancy floor and ignores devices that have
stopped checking in. So a license whose devices have gone dark can report `overLimit` and still
admit a new activation.
:::

The client is told about the new limit immediately, too: `deviceLimit` in the license document is
the new tier's number from the next fetch onward, even while more devices than that remain
authorized. A client that renders "2 of 1 devices" is reading the situation correctly.

## Expiry is re-derived from the new tier

A tier's `policy_expiry_days` is a property of the **tier**, so it is re-derived whenever a tier
is assigned — not copied once at creation.

| Situation | Result |
| --- | --- |
| Tier moves, no `expiresAt` in the body | `expires_at` is re-derived from the new tier's policy. |
| Tier moves to a tier with no expiry policy | `expires_at` becomes `null` — no expiry. |
| Body states `expiresAt` as a number | That number wins. |
| Body states `expiresAt` as `null` | "Never" wins. |
| Body does not move the tier | `expires_at` is left exactly as it was. |

This exists because both directions were expensive:

- **trial to paid** kept the trial's `expires_at` and killed the license days *after* the
  customer paid.
- **paid to trial** left a time-boxed tier perpetual.

`test/relicense.test.ts` pins each row of that table against a 14-day `trial` tier and a
no-expiry `paid` tier, including that a patch which does not move the tier leaves an
operator-set expiry untouched.

The same derivation applies on **creation**: an admin creating a license on a trial tier without
stating an expiry gets the tier's time box, and an explicit `expiresAt: null` still means never.
It also applies on the keyless [enrollment](/docs/services/license/enrollment/) path and on OIDC
sign-in, so all four paths that assign a tier agree.

## Removing a tier

Setting `"tier": null` drops the license's plan. The injected entitlements go with it —
`license.tier` and `license.tierLabel` are simply **absent** from the next document rather than
present-and-empty, which the test asserts directly.

What the license keeps: its own `channels_json`, `min_version`, `max_version`, overrides, and
attached profiles. Those are per-license fields, not tier policy. Its device limit falls back to
the product default, because `deviceLimit` is injected only from a tier.

## Reference

- [The license document](/docs/services/license/document/) — the entitlement map and the ETag.
- [The license model](/docs/services/license/model/) — seat pools, dormancy, and the tier's
  policy columns.
- [Activation](/docs/services/license/activation/) — where the seat limit is enforced, and why
  only on new authorizations.
- `test/relicense.test.ts` — the behaviour pins cited throughout this page.

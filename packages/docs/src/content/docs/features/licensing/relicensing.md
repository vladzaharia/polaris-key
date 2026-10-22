---
title: "Re-licensing"
description: "Change a license's tier and running apps pick it up: the ETag as the change signal, grandfathered downgrades and re-derived expiry."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 7
---

Re-licensing is changing a license's tier: a trial converts to paid, a customer upgrades to more devices, a lapsed subscription drops to free. There is no push channel, websocket or invalidation broadcast. The Worker re-merges entitlements on every document request, so a change lands the next time a running client refreshes.

## Make the change

Change the tier on the license's **Overview** tab ([Manage licenses](/docs/features/licensing/manage-licenses/)), or through the admin API.

```json title="PATCH body"
{ "tier": "pro" }
```

The same `PATCH` moves `name`, `email`, `expiresAt`, `maxOfflineDays`, `channels`, `minVersion`, `maxVersion` and the license's profiles. All reach clients by the same route. A tier counts as changed when `tier` is present and differs from the stored value. `"tier": null` clears it.

A tier move writes two audit entries, `license.tier.change` with old and new, and the generic `license.update`. A tier can't be deleted while a license uses it: `409` with the count.

## How a running client finds out

1. The `PATCH` writes the tier and bumps the license's modified time.
2. On the next license document request, the Worker re-merges every layer and stamps the tier's policy on top. Nothing is cached across requests.
3. The injected entries carry the modified time as `updatedAt`, so both their values and their timestamps change.
4. The document's ETag covers content, including `entitlements`, so it changes.
5. The client's `If-None-Match` no longer matches. It receives a fresh document and fires its change callback.

The ETag excludes `issuedAt`, `expiresAt` and `graceUntil`, so two fetches of an unchanged license return the same tag. An SDK can treat a changed tag as a real change. See [License document](/docs/reference/protocol/license-document/).

How quickly depends on the client's refresh, not the server. A document is valid for one hour, and a client refetches unconditionally within 30 minutes of expiry, so an online client converges within the document's lifetime. An offline client sees nothing until it reconnects.

:::note[Disabling is the immediate action]
A tier change doesn't take effect now. **Disable license…** does: it purges the cached token of every device on the license, so the next request fails the usability check.
:::

## Downgrades grandfather

Lowering a tier's device limit evicts nobody. The device-limit check runs only on a new authorization, so existing devices keep counting toward the limit and documents. New activations answer `403 device_limit` until the count drops below the new limit.

Because that is silent, the `PATCH` response says so:

```json title="Output"
{
  "ok": true,
  "id": "<license id>",
  "overLimit": { "deviceCount": 2, "deviceLimit": 1 }
}
```

`overLimit` appears only when the tier changed, the new tier sets a positive device limit and the active device count exceeds it. The count uses the same 90-day dormancy floor as activation, so it predicts what activation does: a license whose extra devices went dark reports no `overLimit`.

The next document carries the new `deviceLimit` even while more devices remain authorized. A client that shows "2 of 1 devices" is reading the situation correctly.

## Expiry follows the tier

A tier's expiry is a property of the tier, so the Worker re-derives it whenever a tier is assigned.

| Situation                              | Result                                       |
| -------------------------------------- | -------------------------------------------- |
| Tier moves, no `expiresAt` in the body | `expires_at` is re-derived from the new tier |
| Tier moves to a tier with no expiry    | `expires_at` becomes `null`: no expiry       |
| Body states `expiresAt` as a number    | That number wins                             |
| Body states `expiresAt` as `null`      | Never expires                                |
| Body doesn't move the tier             | `expires_at` is left as it was               |

Both directions were costly before. Trial to paid kept the trial's expiry and ended the license days after the customer paid. Paid to trial left a time-boxed tier perpetual. Creation, keyless enrollment and sign-in apply the same derivation, so all four paths that assign a tier agree.

## Remove a tier

`"tier": null` drops the tier. `license.tier` and `license.tierLabel` are absent from the next document. The license keeps its own channels, version window, overrides and profiles. Its device limit falls back to the product default, because `deviceLimit` is injected only from a tier.

## Next steps

- [The license model](/docs/features/licensing/model/): the layers and the injected entitlements.
- [Activation](/docs/features/licensing/activation/): where the device limit applies.
- [Manage licenses](/docs/features/licensing/manage-licenses/): the console edit.

---
title: "Profiles"
description: "Reusable sets of config, secret and entitlement values that a tier or a license attaches."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 5
---

A profile is a named set of values, written once and attached by tier or license. Its payload has the same shape as a license's overrides: `{ config, secrets, entitlements }`. A profile is not a tier: a tier is a profile reference plus policy (expiry, device limit, tracks, version window), and a profile grants none of that. Two tiers can share a profile and differ in policy.

"Profile" also names the signed license document's greeting block. They are unrelated.

```json title="Payload of the pro profile"
{
  "config": {
    "run.concurrency": {
      "state": "enforced",
      "value": 6,
      "updatedAt": 1756252800
    }
  },
  "secrets": {},
  "entitlements": {
    "polarisVpn": {
      "state": "enforced",
      "value": true,
      "updatedAt": 1756252800
    }
  }
}
```

## Where it sits

A tier names at most one profile. A license can carry its own ordered list, layered after the tier's profile and before its own overrides. Both are layers in the [management-state merge](/docs/features/managed-config/management-states/). A profile takes effect only once a tier or license attaches it.

A catalog entry's `ui.scopes` says where a key matters: `profile`, `license`, `device`, or all. It only shapes the editor, so a device-only toggle isn't offered where setting it would do nothing.

## In the console

**Config → Profiles** lists every profile with what uses it, such as "1 tier · 4 licenses". **New profile** asks for an id, a name and a description, then opens the profile. It's unavailable until the product has a catalog. A profile has two tabs:

- **Payload** is the editor a license's overrides share. Keys are grouped by category, with `ui.advanced` keys under **More settings**. Search covers keys, labels and values, and "Not set" is its own state. **Review changes** shows each key's before, after and effective value. **Jump to first error** opens the group that holds it.
- **Used by** lists the tiers and licenses that point at it.

**Delete…** is unavailable while anything uses the profile. Detach it first, so deleting never blanks a running license's settings.

## The admin API

Routes live under `/manage/api/products/<slug>/config/profiles`.

| Method   | Path suffix | Behavior                                                                          |
| -------- | ----------- | --------------------------------------------------------------------------------- |
| `GET`    | (none)      | List with `usedBy` counts. No payload                                             |
| `POST`   | (none)      | Create with an empty payload. A taken id is `409` with `reason: "profile_exists"` |
| `GET`    | `/<id>`     | Detail with the redacted payload and `usedBy` tiers and licenses                  |
| `PATCH`  | `/<id>`     | `name` and `description` only. A blank name is `422`. The id never changes        |
| `PUT`    | `/<id>`     | Batch edit `{ updates }`, validated against the active catalog                    |
| `DELETE` | `/<id>`     | `409` with `reason: "profile_in_use"` and a count while a tier or license uses it |

A `PUT` is all-or-nothing. With no active catalog it answers `409` (`no_active_catalog`). Any invalid update answers `422` with every failing key in `fields`. Success audits `profile.overrides`. The same batch mechanism backs a license's override endpoint.

Each update names a key and either sets or changes it:

| `value` | `state`                           | Meaning                                                                                  |
| ------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| absent  | absent or `default`               | Clear: delete the key from this layer, so the next layer down answers                    |
| present | absent                            | Set with state `enforced`. A bare value reads as "this wins", not as a suggestion        |
| present | `default`, `enforced` or `hidden` | Set with exactly that state, validated against the catalog                               |
| absent  | `enforced` or `hidden`            | State-only change. The stored value, already sealed if secret, carries forward untouched |

The state-only row lets an operator flip enforcement without re-supplying a secret they can't read back.

A value under a `secret` entry, or a `config` entry with `secret: true`, is sealed with AES-GCM under the platform KEK before it is stored, bound to the product and the key. A ciphertext copied to another product or key fails to open. Opening happens only when a value is signed into a document or shown through a surface allowed to see it, never in a redacted list or detail response. A row written before sealing reads back as plaintext and is sealed on its next admin write.

A read never echoes a stored secret. Each `secrets` entry reduces to `{ state, configured, updatedAt }`, and a `config` entry the catalog flags secret is blanked. Redaction fails closed: an entry it can't positively classify as non-secret is redacted anyway.

On a repo-linked product the profiles come from `.pkey/product`, and each resync replaces them, except for secret values. A manifest can't carry a secret, so a secret set here is carried forward, still sealed, while the manifest still lists the profile, its payload doesn't declare that key and the catalog still marks the key secret. A plain value you edit here lasts only until the next push.

The per-license override editor rebuilds the layers below the license client-side, in the server's precedence, so a key inherited as Enforced from a tier's profile doesn't read as "not set".

## Next steps

- [Management states](/docs/features/managed-config/management-states/): the merge.
- [The catalog](/docs/features/managed-config/catalog/): the schema each value validates against.
- [Manage licenses](/docs/features/licensing/manage-licenses/): attach profiles to a license.

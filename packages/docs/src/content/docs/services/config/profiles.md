---
title: "Profiles"
description: "Reusable managed-payload baselines: how they layer under a tier or a license, and the set-vs-blank rules the payload editor applies."
sidebar:
  order: 5
---

A **profile** is a reusable managed-payload baseline that a tier or a license can attach — named
once, in Config, and pointed at from as many licenses as want it. It is not a different kind of
data from a license's own overrides: a profile's `payload_json` is a `ManagedPayload` — the same
`{ config, secrets, entitlements }` shape a license's `overrides_json` and the catalog's own
baseline share — just stored once, under a name, instead of duplicated onto every license that
wants the same settings.

:::caution[Two different profiles]
"Profile" is already taken twice in this system: the reusable payload baseline described here,
and `DocProfile` — the signed greeting block (name, first name, email, activation time) carried on
the [license document](/docs/services/license/document/). They are unrelated. Do not overload the
word a third time.
:::

A **profile is not a tier**. A tier is a named plan — a profile reference _plus_ policy (expiry,
device limit, channels, version window); a profile alone grants none of that. Attaching the same
profile to two tiers gives both tiers identical settings while leaving their policies free to
differ, which is the point of keeping the two separate.

## A profile's payload, concretely

A djdl "pro" profile that raises the default download concurrency and turns on the VPN flag might
store:

```json
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

`GET .../config/profiles/pro` returns exactly this as its `payload`, redacted — which for a
profile with no `secrets` entries is a no-op; `secrets: {}` stays `secrets: {}`. Only when a profile actually holds
a `kind: "secret"` value does redaction change the response shape.

## The admin surface

| Route                             | Behaviour                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET .../config/profiles`         | List: `id`, `name`, `description`, `modifiedBy`, `modifiedAt`, and `usedBy: { tiers, licenses }` counts. No payload.                            |
| `POST .../config/profiles`        | Create: an empty payload (`{ config: {}, secrets: {}, entitlements: {} }`), an operator- or server-chosen id. A taken id is refused (below).    |
| `GET .../config/profiles/<id>`    | Detail: the full payload, redacted (below), and `usedBy`: the tiers (`id`, `label`) and licenses (`id`, `name`, `email`) that point at it.      |
| `PATCH .../config/profiles/<id>`  | Edit details: `{ name?, description? }`. A blank `description` (or `null`) clears it; a blank `name` is refused `422`. Audits `profile.update`. |
| `PUT .../config/profiles/<id>`    | Batch-edit: `{ updates: OverrideUpdate[] }`, validated against the active catalog.                                                              |
| `DELETE .../config/profiles/<id>` | Refused `409` (`reason: "profile_in_use"`) with a reference count while any tier or license still uses the profile.                             |

`POST` answers `409` with `reason: "profile_exists"` when the id is already a profile's: a create
never replaces an existing profile's payload. `PATCH` changes only the name and description; the
id is what tiers and licenses refer to, so it never changes.

`PUT` answers `409` (`reason: "no_active_catalog"`) with no active catalog to validate against,
and `422` with a `fields` array on any invalid update in the batch — the whole write is
all-or-nothing. A successful write re-stores the payload and audits `profile.overrides`.

### In the console

**Config → Profiles** lists every profile with what uses it ("1 tier · 4 licenses"); the row opens
the profile. **New profile** asks for the id, a name and a description, then opens the new profile
to set its values; it is unavailable until the product has a catalog. **Delete…** in a row's menu
or on the profile is unavailable, with the reason, while any tier or license still uses the
profile.

A profile has two tabs:

- **Payload** — the managed payload editor, shared with a license's overrides: keys grouped by
  category (`ui.advanced` keys under **More settings**), search across keys, labels and values,
  "Not set" as its own state, and a save bar with **Review changes** (each key's before, after and
  effective value). Only the keys you changed block a save; **Jump to first error** opens the
  group that holds it. A background refresh never discards your edits, and leaving the page with
  unsaved edits asks first.
- **Used by** — the tiers and licenses that point at the profile, each linked.

**Edit details…** changes the name and description.

`PUT .../license/licenses/<id>/overrides` — a License route — validates and stores through this
exact same batch function. A profile's payload and a license's own overrides are edited
identically; only the storage location, and the layer each occupies, differ.

On a repository-linked product the profiles come from `.pkey/product`, and each resync replaces
them — except for their secret values. A manifest can't carry a secret value, so a secret you set
on a profile here (a `secret` entry, or a `config` entry flagged `secret: true`) is carried
forward, still sealed, as long as the manifest still lists the profile and its own payload doesn't
declare that key. A plain config value or flag you edit here lasts only until the next push; see
[What resync actually re-applies](/docs/admin/products/#what-resync-actually-re-applies).

## Redaction on read

`GET` never echoes a stored secret value, on either resource. `redactPayload` reduces every
`secrets` entry to `{ state, configured, updatedAt }`, and blanks the value of any `config` entry
the active catalog flags `secret: true` too. It fails **closed**: an entry it cannot positively
classify as non-secret — because the catalog is momentarily unavailable between a schema swap, or
because a newer catalog silently dropped a key's `secret` flag — is redacted anyway. A value that
was ever sealed as a secret (its stored JSON carries the sealed-envelope shape) stays redacted
regardless of what the _current_ catalog says about that key.

## Set-vs-blank: the batch semantics

An override batch is a list of `{ key, state?, value? }`. Presence and absence of each field
carry meaning independently of what they are set _to_:

| `value` | `state`                                 | Result                                                                                                                                                                            |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent  | absent, or `"default"`                  | **Clear.** The key is deleted from the bucket entirely — not set to the catalog default, genuinely absent, falling through to whatever the next layer down (or nothing) provides. |
| present | absent                                  | **Set, enforced.** Validated against the catalog; `state` defaults to `"enforced"` — supplying a bare value is read as "this wins", not as a suggestion.                          |
| present | `"default"` / `"enforced"` / `"hidden"` | **Set, with an explicit state.** Validated against the catalog; stored with exactly the state given.                                                                              |
| absent  | `"enforced"` / `"hidden"`               | **State-only change.** The currently stored value (already sealed, if it's a secret) carries forward untouched — never re-validated, never re-sealed.                             |

The state-only row is how an operator flips a key's enforcement without needing to know, or
re-supply, an underlying secret they cannot read back.

Every value update in a batch is validated against the active catalog before anything is written,
and the whole batch is all-or-nothing: one bad key fails the entire request, with every failing
key's message collected in `fields`, rather than partially applying a batch the operator has not
reviewed in full.

Any value written under a `kind: "secret"` entry, or a `kind: "config"` entry flagged
`secret: true`, is sealed — AES-GCM, under the platform KEK — **before** it reaches storage, bound
by an AAD to both the product and the catalog key
(`pkey:v2:<product>:product-secret:managed:<key>`), so a ciphertext copied between products, or
between two keys of the same product, fails to open rather than decrypting into the wrong place.
Validation itself still runs on the plaintext the operator submitted; only the persisted copy is
opaque. A row written before this sealing existed reads back as plaintext and is re-sealed lazily
on its next admin write, never by a bulk migration. Opening happens later, immediately before a
value is minted into a signed document or shown to an operator through a surface allowed to see
it — never as part of a redacted list or detail response.

## Where a profile sits in the merge

A profile can be attached at two different points, and both are just layers in the same
[management-state merge](/docs/services/config/management-states/):

```
catalog default -> tier's profile -> license's profiles (in order) -> license overrides -> device overrides
                    ^^^^^^^^^^^^^^    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                    one profile,      an ordered list -- later entries beat earlier
                    inherited by      ones in the list, by the same key-by-key
                    every license     merge rule
                    on the tier
```

A tier names at most one `profile_id`. A license, independently, can carry its own ordered list of
profiles (`license_profiles`) — attached and reordered via the license's `profiles` field, layered
_after_ the tier's profile and _before_ the license's own `overrides_json`.

## What `scopes` means for a profile

A catalog entry's `ui.scopes` (see [The catalog](/docs/services/config/catalog/)) names which
admin surfaces a key is meaningful at: `profile`, `license`, `device`, or some combination,
omitted meaning all three. It is presentation-only, exactly like `dependsOn` — nothing stops an
operator from writing a `profile`-scoped key into a license's own overrides instead. What it
buys is a payload editor that doesn't offer a device-only toggle in a profile form where setting
it would never do anything, because no device layer ever reads a profile directly; a profile only
takes effect once a tier or a license attaches it.

## What the console shows for "not set"

No admin endpoint returns the fully merged, effective payload — that assembly only happens at
document-signing time. So the per-license override editor rebuilds the layers _below_ the license
row itself — the catalog default, the tier's profile, the license's own profiles in order —
client-side, in the server's own precedence, including the rule that a lower `enforced`/`hidden`
entry is not demoted by a higher `default` one, from data it can already fetch. That is
deliberate: without it, a key inherited as `enforced` from a tier's profile would read as "not
set" on the license tab, which is a different fact entirely from "the app never had a value for
this".

## Deleting a profile

`DELETE` is refused with `409` and a reference count while any license still uses the profile —
directly, or through a tier. The console shows the same fact before you try: Delete stays
unavailable while the profile's **Used by** list is not empty. An operator has to detach it first. Deleting a profile can therefore
never silently blank the settings of a license still running against it.

## See also

- [Management states](/docs/services/config/management-states/) — the merge order and the
  `enforced`/`hidden`-survives-`default` rule this page builds on.
- [The catalog](/docs/services/config/catalog/) — what `ConfigEntry.ui.scopes` means for which
  admin surface a key is meaningful in.
- [The license model](/docs/services/license/model/) — the tier and license rows a profile
  attaches to.
- [D1 data model](/docs/reference/data-model/) — the `profiles` table's columns.

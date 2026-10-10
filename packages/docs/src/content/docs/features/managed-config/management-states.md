---
title: "Management states"
description: "How default, enforced, and hidden are seeded, merged across admin layers, and resolved on the client."
sidebar:
  order: 3
---

Every `config` and `secret` key carries a **management state** — `default`, `enforced`, or
`hidden` — the MDM-style knob that decides whether the operator's value is a suggestion or a
mandate. `flag` entries don't have one: they're entitlements, resolved by a different mechanism
entirely (`isEntitled`/`getEntitlements` on the license document), not "managed config" in this
sense.

## The three states

| State      | On the wire                 | Client behaviour                                                                                                                                          |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`  | A suggested value.          | The user/local override wins, then an environment variable, then this remote value, then the SDK's own fallback. Overridable.                             |
| `enforced` | The value, marked enforced. | The remote value always wins; local and environment overrides are ignored. Shown read-only in a settings UI (`listUserConfig` marks it `enforced: true`). |
| `hidden`   | The value, marked hidden.   | Enforced, **and** withheld from `listUserConfig`/any user-facing enumeration — still applied internally by `getConfig`.                                   |

## `managementDefault`: seeding a fresh key

`managementDefault` is the state a freshly-minted key gets when nothing has overridden it yet. It
lives on the `ConfigEntry` itself (see [The catalog](/docs/services/config/catalog/)), authored
once by whoever writes the schema.

It seeds exactly one thing: the bottom layer of the merge, `core/payload.ts`'s
`catalogDefaultPayload`. For every catalog entry whose `kind` is `config` **and** which declares a
schema-level `default`, that layer gets:

```
{ state: entry.managementDefault ?? "default", value: entry.default, updatedAt: now }
```

Two things fall out of that precisely:

- A `config` entry with no `default` contributes **nothing** to the catalog layer — not even a
  `default`-state placeholder. If no higher layer ever sets it either, the key is simply absent
  from the signed document, and the client's own schema fallback is the only thing left to answer
  with.
- `secret`-kind entries are never seeded here at all — the loop skips anything that isn't
  `kind: "config"`. A catalog secret only appears in a document once some admin layer (a profile,
  an account override, a device override) explicitly sets a value for it; there is no such thing
  as a secret's "catalog default".

## How admin layers merge

An admin can override a key's state and value at up to five places, layered in one fixed order —
later layers win:

```
catalog default  ->  tier's profile  ->  license's profiles (in order)  ->  license overrides  ->  account overrides  ->  device overrides
```

- **tier(profile)** — a tier names one `profile_id`; every license on that tier inherits it as a
  layer.
- **license(profile)** — a license may itself carry an ordered list of profiles
  (`license_profiles`); each is its own layer, later ones in the list beating earlier ones.
- **license overrides** — the license row's own `overrides_json`, edited at
  `PUT .../license/licenses/<id>/overrides`. Entitlements only, once the licence-override
  migration has run; until then its config and secrets are still read, below the account layer.
- **account overrides** — the managed config of one account on one product (U-03), edited on the
  user's record or at `PUT .../users/<subject>/overrides`; see [Account overrides](#account-overrides).
- **device overrides** — the device row's own `overrides_json`, the last layer Core reads before
  the merge is complete.

`resolveMergedPayload` (`core/payload.ts`) walks exactly this list — `mergePayloads`
(`src/merge.ts`) — key by key, independently for `config`, `secrets`, and `entitlements`. When
`license` is `null` — a Config-only device under D-08 — the tier, the profile layers, and the
license-override layer simply contribute nothing; the catalog default and the device's own
overrides are exactly the right answer, not a special case.

### The one exception: `default` cannot demote `enforced`/`hidden`

A later layer wins outright _except_ when it would downgrade an already-`enforced`-or-`hidden`
value to a plain `default`. In that one case the lower layer's value and state survive unchanged,
and only `updatedAt` advances to the newer of the two timestamps — so a client watching for change
still notices, without silently un-enforcing something an operator locked down higher up the
stack.

| Lower layer                  | Higher layer                  | Result                                               |
| ---------------------------- | ----------------------------- | ---------------------------------------------------- |
| `enforced` (tier's profile)  | `default` (license override)  | Tier's `enforced` value survives; `updatedAt` bumps. |
| `default` (tier's profile)   | `enforced` (license override) | License override wins outright.                      |
| `hidden` (license override)  | `default` (device override)   | License's `hidden` value survives.                   |
| `default` (license override) | `hidden` (device override)    | Device override wins outright.                       |

Every other combination — including a higher layer explicitly re-`enforcing` or re-`hiding` — is a
plain override: the higher layer's value and state replace the lower one's.

## Account overrides

The **account override** is the operator's managed config for one account on one product: `config`
and `secret` keys (never `flag` keys, which stay on the licence), stored per pairwise subject in
`account_overrides` and validated, sealed and redacted exactly like a profile's payload. It
replaced the licence-level config override on every product (notes/S-17 §5.12).

A device gets one account's layer, chosen in this order:

1. the account **signed in on the device** (the same account Cloud Sync uses), unless the device's
   licence is floating or that account removed the licence from its library;
2. else the **owner of the device's licence**, so a device activated by licence key still gets its
   owner's non-secret values; `secret` keys, and `config` keys the catalog marks secret, reach only
   a device signed in as that account. This line is Config's alone; Cloud Sync has none;
3. else none: a floating (unowned) licence, or a device with no licence and no sign-in.

Edit it on **Users → a user → Overview**, or with `GET`/`PUT
/manage/api/products/<slug>/users/<subject>/overrides` (the licence editor's batch body). The
layer exists on every product, Identity on or off: the account is platform-level, and the owner line
needs no sign-in.

**The licence-override migration.** One platform-wide run, scheduled by the owner, moves every
owned licence's config and secret overrides onto its owner's account overrides and drops those of
licences with no owner, after a 30-day notice that starts only once the login card and the portal
Library are live. Several licences of one product on one account collapse to the value of the
licence updated most recently (a value already on the account wins), and every lost value is in the
90-day report; secrets are listed by name only. From the run's start, the licence route accepts
entitlements only; from its completion, licences no longer deliver config or secrets. The console's
licence page says where its values went, and for a licence with no account offers the portal's
Activate License link to send the customer.

## Client-side resolution

Once the document is signed, a client resolves each key through one fixed chain:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

- **`enforced`/`hidden` (remote)** — the document's own value always wins; nothing client-side can
  override it. `hidden` additionally never appears in a `listUserConfig`-style enumeration, so a
  settings UI cannot render a key that should not be shown at all.
- **local override** — a synced setting, or a programmatic override the client itself stores.
  Only reachable when the remote state is `default`.
- **environment** — `PKEY_CONFIG_` plus the key with every `.` replaced by `__`:
  `run.concurrency` becomes `PKEY_CONFIG_run__concurrency`. The value is parsed when it is one
  strict JSON text (no duplicate member names, no lone surrogate, every number zero or of
  magnitude 10^−307 up to below 10^308, at most 64 levels deep), and is otherwise the raw
  string, the same in every SDK (WIRE-CONTRACT-V3 §2.2.1, pinned by `config-matrix.json`). See
  each SDK's own README for the exact API.
- **remote default** — the value the document carries with `state: "default"`.
- **fallback** — the entry's own schema `default`, compiled into the SDK or a generated mirror,
  used only when nothing above answered at all — including when the key never made it into the
  document because no layer ever set it, per the seeding note above.

:::note[Secrets and flags]
`secret` keys follow this exact same state model — djdl's `proxy.subscriptionUrl` ships
`hidden`, auto-provisioned rather than user-set. `flag` keys are outside this system entirely:
they carry no management state, and are read as entitlements, not as managed config.
:::

## Worked example

Take `run.concurrency`, `managementDefault: "default"`, schema `default: 3`. Two runs through the
same stack, to make the merge concrete.

**No overrides anywhere.** Only the catalog layer contributes:

| Layer                                                                   | Contributes                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| catalog default                                                         | `state: "default"`, `value: 3`                                                                  |
| tier's profile, license's profiles, license overrides, device overrides | nothing                                                                                         |
| **Effective**                                                           | `state: "default"`, `value: 3` — a user override, then env, then this value wins, in that order |

**An operator locks it down on a "pro" tier, then a lower layer tries to loosen it:**

| Layer                               | Contributes                                             | After merge                                                                                          |
| ----------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| catalog default                     | `default`, `3`                                          | `default`, `3`                                                                                       |
| tier "pro" profile                  | `enforced`, `8`                                         | `enforced`, `8` (replaces the catalog layer outright)                                                |
| license's own profiles              | `default`, `2` (an operator meant this as a suggestion) | still `enforced`, `8` — a `default` layer cannot demote an `enforced` one; only `updatedAt` advances |
| license overrides, device overrides | nothing                                                 | `enforced`, `8`                                                                                      |
| **Effective**                       |                                                         | `state: "enforced"`, `value: 8` — the client cannot override it                                      |

Had that license-profile layer instead written `state: "enforced", value: 5`, the result would be
`enforced`/`5` — an explicit `enforced` at a higher layer always replaces a lower one; only a bare
`default` is powerless against an already-locked value.

## See also

- [The catalog](/docs/services/config/catalog/) — where `managementDefault` is authored.
- [Profiles](/docs/services/config/profiles/) — the set-vs-blank rules an admin override batch
  applies at each layer.
- [The config document](/docs/services/config/document/) — where the merged, pruned result is
  signed and delivered.
- `packages/worker/test/merge.test.ts` — pins "applies precedence tier -> license -> device (later
  wins per key)" and "does not let a default layer override an enforced or hidden value"
  byte-for-byte.

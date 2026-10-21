---
title: "Catalog manifest"
description: "Declare config, secret and flag entries, synced settings and Cloud Sync records in .pkey/schema."
type: "reference"
lastReviewed: "2026-10-16"
sidebar:
  order: 3
---

The catalog is `.pkey/schema`: every setting, secret and flag the product can manage. It is required even when Config is off; then it is empty (`schemaVersion: 1`, `entries: []`).

## Entries

The schema file is a `ProductCatalog`: a `schemaVersion` (bumped on incompatible shape
changes; it matches the signed doc's `schemaVersion`) and an `entries` array. Each entry is a
`ConfigEntry` (`packages/shared-catalog/src/types.ts`) — a dotted `key`, a `kind`
(`config` plaintext setting · `secret` redacted, delivered in the config document · `flag` entitlement),
grouping/label/description for settings UIs, a Draft-07 JSON-Schema `schema` the value
validates against, a `default`, and — on `config`/`secret` keys — a `managementDefault`
(`default` · `enforced` · `hidden`) seeding the state a freshly-minted key gets:

```jsonc title=".pkey/schema"
// config — overridable by default
{
  "key": "run.concurrency",
  "kind": "config",
  "category": "Run",
  "label": "Parallel downloads",
  "description": "How many files download at once.",
  "schema": { "type": "integer", "minimum": 1, "maximum": 8 },
  "default": 3,
  "managementDefault": "default",
  "ui": { "widget": "stepper" },
}
```

On the **client**, a value resolves through one fixed precedence, honoring whichever
management state the signed document carries for that key:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` lock the remote value — local and env overrides never apply, and `hidden`
additionally withholds the key from `listUserConfig`/enumeration while `getConfig` still
applies it internally. A `default` (or an absent entry) falls through the rest of the chain to
the caller's `fallback`. The env override for a key is `PKEY_CONFIG_` + the key with dots →
`__` (`run.concurrency` → `PKEY_CONFIG_run__concurrency`).

The full field reference (`ui`/`dependsOn`/`accessor`/`appliesTo` and the rest), worked
`secret`/`flag` examples, and how management states are set and overridden per
tier/license/device live at [The config catalog](/docs/features/managed-config/catalog/). The
`ConfigEntry` type itself, reproduced verbatim, is at
[ConfigEntry — the catalog item shape](/docs/reference/config-entry/).

### Reserved entitlement names

A `flag` is an entitlement, and the platform sets a few entitlements itself in every license
document: `channels`, `deviceLimit`, `app.minVersion`, `app.maxVersion`, `license.tier` and
`license.tierLabel`. Every name under `license.`, `app.` and `pkey.` is reserved for future system
keys too. The platform's value always wins over a product's.

A flag may still **declare** one of these names, to give it a label, a category, a narrower
schema or a `userGrant` label (djdl declares `channels`, `deviceLimit` and both `app.*` keys).
That declaration is valid as long as it is **compatible**:

- its `schema.type` is the system key's type: `channels` an array of strings (`items` of type
  `string`), `deviceLimit` an integer, the `app.*` and `license.*` keys strings;
- the schema only narrows that type (`enum`, `const`, `pattern`, `minLength`/`maxLength`,
  `minimum`/`maximum`, `uniqueItems`, `minItems`/`maxItems`, `format`, `multipleOf`) or annotates
  it;
- the entry carries only presentation fields besides `key`, `kind` and `schema`: `label`,
  `category`, `description`, `default` (of the right type), `examples`, `ui`, `userGrant` and
  `grantLabel`.

Any other name under `license.` or `pkey.` has no compatible form. The validator reports an
incompatible declaration as `incompatible_reserved_name`. It is a **warning** by default (`pkey
validate` prints it and link and resync accept it); the platform setting
`LICENSING_RESERVED_NAMES` (platform admins) turns it into an
error after a window of two minor releases or 60 days, whichever is later. Platform → Settings →
Licensing lists every registered product with a reserved-name declaration and whether it is
compatible.

## Synced settings and Cloud Sync records

With [Cloud Sync](/docs/features/cloud-sync/) on, every Editable `config` key is a **synced setting**:
the value a signed-in person chooses follows them to their other devices. Editable means the
catalog sets no `managementDefault` of `enforced` or `hidden`. A `user` block is optional tuning;
without one, a key behaves as `{ "sync": "user", "conflict": "lastWrite", "listed": true }`:

```jsonc title=".pkey/schema"
{
  "key": "stats.bestScore",
  "kind": "config",
  "category": "Stats",
  "label": "Best score",
  "description": "The highest score on this account.",
  "schema": { "type": "integer", "minimum": 0 },
  "default": 0,
  // sync: user | platform | local; conflict: lastWrite | max | min | merge
  "user": { "sync": "platform", "conflict": "max" },
}
```

- `sync: "local"` keeps a key on the device; nothing else does. `device` is retired and refused:
  use `local`.
- The block is refused on a `secret` or `flag`, and with a conflict policy the value's schema
  cannot support (`max` and `min` need a number, `merge` an object; a set is an object of
  booleans). On an `enforced` or `hidden` key it has no effect, and `pkey validate` warns.
- A key the catalog does not declare is an **open setting**: it syncs as `lastWrite`, without a
  schema, up to 8 KiB. Declared and open settings share one budget of 256 keys and 64 KiB per
  person. Any device of the person can write an open setting, so treat an undeclared key as
  untrusted input; declare a key that matters with a schema, give it `sync: "local"`, or lock it.

The catalog's top-level `cloudSync` block declares the product's **records**: `collections` and
the catalog `migrations` the server applies to synced values. A `saves` collection is the
save-slot template (16 slots per person, `revision`, one file per save and a small thumbnail):

```jsonc title=".pkey/schema"
"cloudSync": {
  "collections": [
    { "name": "saves", "template": "saves", "requires": "cloudSaves" },
    {
      "name": "scores",
      "conflict": "max",
      "conflictField": "best",
      "schema": { "type": "object", "properties": { "best": { "type": "integer" } } },
      "maxRecords": 100,
    },
  ],
}
```

A collection's `conflict` is one of `lastWrite`, `max`, `min`, `merge`, `union` and `revision`
(the default), and `max` and `min` name the number `conflictField` the server compares.
`maxRecords` is at most 10,000 and not allowed on a `saves` collection; `files.maxBytes` is at
most 1 GiB; `requires` names a catalog flag or a system entitlement. Retired with no warning
period: `cloudSync.saves` (use `template: "saves"`), `cloudSync.open` and a collection's
`onAttach` (the first sign-in is an ordinary sync). The full rules are on the
[Cloud Sync](/docs/features/cloud-sync/#validation) page.

## Typed mirrors

When you author a typed mirror for a product that wants compile-time config types, regenerate
it from the catalog with
`pnpm gen mirrors -- --catalog <catalog.json> --out-dir <mirror-dir>` (and add `--check`
in product-specific CI) — see `CONTRIBUTING.md`. `--lang` picks the targets (`ts`, `python` and
`swift` by default, plus `gdscript` for a Godot game's `catalog_generated.gd`).

:::note[Upgrade: mirrors list every Editable key as a setting]
Every Editable `config` key is a synced setting whether or not it has a `user` block, so a
mirror's `USER_SETTINGS` lists each of them with its defaults applied (`sync` `user`,
`conflict` `lastWrite`, `listed` true unless the block says otherwise), plus `local` keys; a key
the catalog locks (`enforced` or `hidden`) is left out, and the `device` scope is gone. A
repository that commits a mirror sees a one-time diff the first time it regenerates after
upgrading; commit it and `--check` is clean again.
:::

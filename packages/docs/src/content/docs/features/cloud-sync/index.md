---
title: "Cloud Sync"
description: "A signed-in person's user settings, collections and saves, synced across their devices: the service, its dependencies, and how a product declares its data."
sidebar:
  order: 1
---

Cloud Sync (slug `sync`) is one of the seven opt-in services over Core. It holds what one person
chose or made in one product, and syncs it across that person's devices:

- **user settings**, catalog `config` keys a person sets (a volume, a key binding, a theme);
- **collections** of **records**, JSON values keyed by id (progress, unlocks, notes);
- **saves**, named slots holding a blob plus metadata and revisions.

Together these are **Cloud Sync data**. See [Concepts](/docs/start/concepts/#cloud-sync-data) for
the vocabulary.

## It needs sign-in

Cloud Sync data belongs to the **Cloud Sync principal**: the account signed in on the device, as
the product's pairwise subject. A device gets one only when a person signs in through the
product. A device activated with a licence key has none and keeps its settings on the device;
they upload at the first sign-in.

So Cloud Sync is off by default and requires two other services:

| Requires   | Why                                                                         |
| ---------- | --------------------------------------------------------------------------- |
| `config`   | A user setting is a catalog `config` key; with Config off there is nothing. |
| `identity` | The principal is the account signed in through the product.                 |

Both edges hold both ways. The Services page, the admin API and manifest ingest refuse Cloud Sync
without Config or Identity (`sync_requires_config`, `sync_requires_identity`), and refuse turning
Config or Identity off while Cloud Sync is on. See
[Enabling services](/docs/admin/services-enablement/).

## Declaring the data

Everything is declared as data, split by who needs it:

| What                                   | Where                                    | Read by                                    |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------ |
| Which keys are user settings           | `.pkey/schema`, a `user` block per entry | Every Config SDK, from the catalog         |
| Collections, saves, catalog migrations | `.pkey/schema`, the `cloudSync` block    | The service and the SDKs, from the catalog |
| Limits and access policy               | `.pkey/product`, the `cloudSync` block   | The service only (product settings)        |

### User settings

Add a `user` block to a `config` entry:

```json
{
  "key": "audio.musicVolume",
  "kind": "config",
  "category": "Audio",
  "label": "Music volume",
  "description": "",
  "schema": { "type": "number", "minimum": 0, "maximum": 1 },
  "default": 0.8,
  "user": { "sync": "user", "conflict": "lastWrite", "listed": true }
}
```

| Member     | Values                                | Default     | Meaning                                                                                                  |
| ---------- | ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `sync`     | `user`, `platform`, `device`, `local` | (required)  | Where the value roams: every device, one platform family, stored per device, or never off the device.    |
| `conflict` | `lastWrite`, `max`, `min`, `merge`    | `lastWrite` | How two devices' writes resolve. `max`/`min` need a number schema; `merge` an object, merged per member. |
| `listed`   | `true`, `false`                       | `true`      | Whether settings panels show the key.                                                                    |

The operator still owns the value: an `enforced` or `hidden` management default refuses the block.
The console's catalog editor edits the block under **User setting**.

### The catalog's `cloudSync` block

```json
{
  "schemaVersion": 4,
  "entries": [],
  "cloudSync": {
    "collections": [
      { "name": "progress", "access": "owner", "conflict": "revision" },
      {
        "name": "unlocks",
        "access": "ownerRead",
        "conflict": "union",
        "schema": { "type": "array", "uniqueItems": true }
      }
    ],
    "open": false,
    "saves": { "conflict": "prompt", "requiresFlag": "cloudSaves" },
    "migrations": [
      { "toSchemaVersion": 4, "rename": { "audio.vol": "audio.musicVolume" } }
    ]
  }
}
```

- **collections** (at most 32): `name` in the key charset (`[A-Za-z0-9._:-]`, a trailing `.*` makes
  a pattern), `access` (`owner`: the person's devices write; `ownerRead`: devices read, the console
  or the developer's backend writes; `server`: never delivered to devices), `conflict` (`revision`,
  `lastWrite`, `merge`, `union`), an optional `schema`, and `onAttach` (`keepCloud`, `keepLocal`,
  `merge`, `prompt`) for a device's local records at its first sign-in.
- **open**: whether undeclared collection names are allowed at the default limits.
- **saves**: the slot conflict policy (`prompt`, `mostRecent`, `longestPlaytime`,
  `highestProgress`), an optional `requiresFlag` the person's entitlements must grant, metadata
  fields, a thumbnail size and `format.refuseNewer`.
- **migrations**: renames, value maps and drops applied to synced values when the catalog reaches
  `toSchemaVersion`.

A console publish keeps the active catalog's `cloudSync` block; it is authored in `.pkey/schema`.

### Limits in `.pkey/product`

```json
{
  "cloudSync": {
    "limits": {
      "totalBytes": 268435456,
      "saves": { "slots": 16, "maxBytes": 33554432, "keepRevisions": 5 },
      "byTier": { "pro": { "totalBytes": 536870912 } },
      "byEntitlement": { "totalBytes": "sync.storageBytes" }
    },
    "unlicensed": { "limits": { "totalBytes": 1048576 }, "saves": false },
    "writes": { "requireLicense": false, "minTrust": null }
  }
}
```

A signed-in person with a usable licence gets the highest of `limits`, the `byTier` entry for
their top tier, and the numeric flag `byEntitlement` names; a person with none gets `unlicensed`.
Every limit stays within the platform ceilings per person: 256 KiB of settings, 64 MiB of
records, 1 GiB of saves. `unlicensed` never exceeds the licensed limits. Per product, the
operator's ceilings are 50 GiB, 100,000 people holding data and 2,000 pushes per second.

## Validation

`pkey validate`, manifest ingest and the console's catalog publish run the same rules:

| Code                               | Rule                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `invalid_user_setting`             | `user` has only `sync` (required), `conflict` and `listed`                   |
| `user_setting_wrong_kind`          | `user` only on a `config` entry                                              |
| `user_setting_locked_default`      | not with an `enforced` or `hidden` management default                        |
| `user_conflict_type_mismatch`      | `max`/`min` need a number schema, `merge` an object schema                   |
| `user_conflict_union`              | a user setting's conflict is never `union`                                   |
| `merge_members_over_limit`         | a merged value has at most 256 top-level members                             |
| `union_collection_schema`          | a `union` collection's schema is `type: array` with `uniqueItems: true`      |
| `collection_name_conflict`         | names unique, `*` patterns disjoint, key charset                             |
| `cloud_sync_unknown_tier`          | `byTier` keys name declared tiers                                            |
| `cloud_sync_unknown_flag`          | `requiresFlag` and `byEntitlement` name declared flags                       |
| `cloud_sync_entitlement_not_max`   | a `byEntitlement` flag is numeric and combines by `max`                      |
| `on_attach_keep_local_forbidden`   | a `server` collection cannot keep local records                              |
| `cloud_sync_limit_over_ceiling`    | limits within the platform ceilings; `unlicensed` within the licensed limits |
| `invalid_cloud_sync_migration`     | rename targets are declared keys; no key both renamed and dropped            |
| `invalid_cloud_sync`               | the `cloudSync` blocks carry only the members above                          |
| `cloud_sync_block_without_service` | a warning: synced settings or a `cloudSync` block while Cloud Sync is off    |

## Discovery

`services.sync` in [discovery](/docs/services/core/discovery/) is `{"enabled": false}` when off.
When on it says which kinds of Cloud Sync data the product serves (`settings`, `collections`,
`saves`) and carries `endpoints` (`pull`, `push`, `saves`), each a URL or `null`. An SDK uses an
endpoint only when discovery names it.

## In the console

The **Cloud Sync** section's **Data** page lists what the product declares: its user settings,
collections, saves and migrations, and the platform ceilings. The catalog editor's **User
setting** fields edit a key's `user` block.

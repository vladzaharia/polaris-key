---
title: "Cloud Sync"
description: "A signed-in person's settings, saves and other records, synced across their devices: what works today, how a product declares its data, and the quota."
sidebar:
  order: 1
---

**Status.** What works today: declarations validate (`pkey validate`, manifest ingest and the
console's catalog publish), the service can be turned on, and the console's **Data** page shows
what a product declares. Nothing syncs yet: the sync routes ship later, and discovery names an
endpoint only from the release that serves it.

Cloud Sync (slug `sync`) keeps what one person chose or made in one product and syncs it across
their devices. It holds two stores:

- **synced settings**: the product's `config` keys a person sets (a volume, a key binding, a
  theme), plus keys the game adds itself;
- **records** in declared collections, such as save slots. Any record may carry one **file**.

Together these are **Cloud Sync data**. See [Concepts](/docs/start/concepts/#cloud-sync-data) for
the vocabulary.

## It needs sign-in

Cloud Sync data belongs to the **Cloud Sync principal**: the account signed in on the device, as
the product's pairwise subject. A device gets one only when a person signs in through the
product. A device activated with a licence key has none and keeps its settings on the device;
they upload at the first sign-in.

So Cloud Sync is off by default and requires two other services:

| Requires   | Why                                                                           |
| ---------- | ----------------------------------------------------------------------------- |
| `config`   | A synced setting is a catalog `config` key; with Config off there is nothing. |
| `identity` | The principal is the account signed in through the product.                   |

Both edges hold both ways. The Services page, the admin API and manifest ingest refuse Cloud Sync
without Config or Identity (`sync_requires_config`, `sync_requires_identity`). Turning Config or
Identity off turns Cloud Sync off in the same change. See
[Enabling services](/docs/admin/services-enablement/).

## Synced settings

Every Editable `config` key syncs: any key whose `managementDefault` is not `enforced` or
`hidden`. A locked key never syncs, and a lock beats a synced value on every device. A synced value
fills the device's `local` slot in the config chain, so it beats every unlocked server value.

An optional `user` block tunes a key:

```json
{
  "key": "audio.musicVolume",
  "kind": "config",
  "category": "Audio",
  "label": "Music volume",
  "description": "",
  "schema": { "type": "number", "minimum": 0, "maximum": 1 },
  "default": 0.8,
  "user": { "sync": "platform", "conflict": "lastWrite", "listed": true }
}
```

| Member     | Values                             | Default     | Meaning                                                                            |
| ---------- | ---------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `sync`     | `user`, `platform`, `local`        | `user`      | Where the value roams: every device, one platform family, or never off the device. |
| `conflict` | `lastWrite`, `max`, `min`, `merge` | `lastWrite` | How two devices' edits resolve (the table below).                                  |
| `listed`   | `true`, `false`                    | `true`      | Whether settings panels show the key.                                              |

A `user` block on a locked key does nothing, and `pkey validate` warns. A `secret` or `flag` key is
never a setting: with Cloud Sync on, `config.set` refuses it with `bad_request`.

### Keys the game adds itself also sync

A key the catalog does not declare is an **open setting**. It syncs to every device of the person,
last write wins, with no schema, and each value is at most 8 KiB. Declared and open settings share
one budget per player:

| Keys per player | Size per player |
| --------------- | --------------- |
| Up to 256       | Up to 64 KiB    |

Any of the person's devices can set an open setting, so an app treats its value as untrusted input.
Declare a key that matters, with a schema, keep it on the device with `sync: "local"`, or lock it.

## Records and saves

A product declares collections of records in the catalog's `cloudSync` block, authored in
`.pkey/schema`:

```json
{
  "schemaVersion": 4,
  "entries": [],
  "cloudSync": {
    "collections": [
      { "name": "saves", "template": "saves" },
      {
        "name": "progress",
        "conflict": "max",
        "conflictField": "level",
        "schema": {
          "type": "object",
          "properties": { "level": { "type": "integer" } }
        }
      },
      {
        "name": "unlocks",
        "conflict": "union",
        "schema": { "type": "array", "uniqueItems": true }
      }
    ],
    "migrations": [
      { "toSchemaVersion": 4, "rename": { "audio.vol": "audio.musicVolume" } }
    ]
  }
}
```

- **collections** (at most 32): `name` in the key charset (`[A-Za-z0-9._:-]`; a trailing `.*`
  makes a pattern), `label`, `template`, `conflict`, `conflictField` (for `max` and `min`),
  `schema`, `maxRecords` (at most 10,000), `files` (`maxBytes` up to 1 GiB, `keepRevisions`) and
  `requires` (an entitlement the person's licence must grant). Records belong to their owner: the
  person's devices read and write them.
- **migrations**: renames, value maps and drops applied to synced values when the catalog reaches
  `toSchemaVersion`.

A record is at most 64 KiB. A console publish keeps the active catalog's `cloudSync` block.

### The saves template

`template: "saves"` declares save slots: 16 per player, which no declaration or entitlement
raises. Each save is a record holding `playtime`, `progress` (0 to 1), `chapter` (up to
128 characters), `formatVersion` and a `thumbnail` (base64, about 32 KiB), plus one file of up to
32 MiB. The last 5 versions of a save's file are kept. Two devices' saves of one slot never
overwrite each other: the app shows both and the person picks.

`template: "session"` is for state to rehydrate: 16 records, last write wins, one 8 MiB file.

## One conflict vocabulary

Both stores use one vocabulary, and the server applies it:

| Policy       | Settings                          | Records                                    | The server keeps                                    |
| ------------ | --------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| `lastWrite`  | the default; open settings always | yes                                        | the latest edit                                     |
| `max`, `min` | a number                          | with `conflictField` naming a number field | the larger or smaller value; a tie keeps the latest |
| `merge`      | an object, member by member       | field by field                             | each member's latest edit                           |
| `union`      | no                                | a list with `uniqueItems`                  | every element added and not removed                 |
| `revision`   | no                                | the default for records and `saves`        | both copies: the app asks the person                |

A set in a setting is an object of booleans with `merge`; a list setting takes `lastWrite` only.
`max` and `min` are not anti-cheat: a device can claim a larger value.

## The quota

A person's Cloud Sync quota is the entitlement `pkey.cloudSync.bytes`, set by a tier, a licence
override or an add-on, and read from the licence of the device that writes:

| The person has               | Quota                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------- |
| a usable licence             | the licence's `pkey.cloudSync.bytes`, else the platform default, 256 MiB        |
| no usable licence            | the product's Anonymous devices tier, when it has one; else 1 MiB, and no files |
| a product with Licensing off | the platform default, 256 MiB                                                   |

No quota passes the per-person ceiling, about 1.06 GiB. Lowering a quota deletes nothing: a person
over it can still read, clear and delete, but not add. Because the quota follows the device's
licence, a device without one is read-only against data a licensed device wrote.

The operator has three controls: the platform default (`cloudSync.quota.defaultBytes`), a product
ceiling (`cloudSync.ceiling.bytes`, 50 GiB) and a platform switch that pauses every write
(`cloudSync.writesPaused`). Pausing deletes nothing, and devices keep their changes until writes
resume.

## Validation

`pkey validate`, manifest ingest and the console's catalog publish run the same rules:

| Code                               | Rule                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `invalid_user_setting`             | `user` has only `sync`, `conflict` and `listed`; `sync: "device"` is retired (use `local`) |
| `user_setting_wrong_kind`          | `user` only on a `config` entry                                                            |
| `user_setting_locked_default`      | a warning: `user` on an `enforced` or `hidden` key does nothing                            |
| `user_conflict_type_mismatch`      | `max`/`min` need a number schema, `merge` an object schema                                 |
| `user_conflict_union`              | a setting's `conflict` is never `union`                                                    |
| `merge_members_over_limit`         | a merged value has at most 256 top-level members                                           |
| `union_collection_schema`          | a `union` collection's schema is `type: array` with `uniqueItems: true`                    |
| `collection_name_conflict`         | names unique, `*` patterns disjoint, key charset                                           |
| `collection_conflict_field`        | `max`/`min` name a number `conflictField`; `conflictField` only with them                  |
| `cloud_sync_unknown_entitlement`   | `requires` names a declared flag or a reserved entitlement                                 |
| `cloud_sync_limit_over_ceiling`    | `maxRecords` at most 10,000; `files.maxBytes` at most 1 GiB                                |
| `invalid_cloud_sync_migration`     | rename targets are declared keys; no key both renamed and dropped                          |
| `invalid_cloud_sync`               | the block's shape; names the replacement of each retired member                            |
| `cloud_sync_block_without_service` | a warning: Cloud Sync declarations while Cloud Sync is off                                 |

Retired with no replacement period: `onAttach` (the first sign-in is an ordinary sync),
`cloudSync.saves` (use a collection with `template: "saves"`), `cloudSync.open`, a collection
`access` other than `owner`, and `.pkey/product`'s `cloudSync` block (the quota is the
`pkey.cloudSync.bytes` entitlement).

## Discovery

`services.sync` in [discovery](/docs/services/core/discovery/) is `{"enabled": false}` when off.
When on it says which kinds of Cloud Sync data the product serves (`settings`, `collections`,
`saves`) and carries `endpoints` (`pull`, `push`, `files`), each a URL or `null`. An SDK uses an
endpoint only when discovery names it.

## In the console

The **Cloud Sync** section's **Data** page lists what the product declares: its synced settings,
collections and migrations, and the platform limits. The catalog editor tunes a key's `user`
block; a key whose syncing is turned off stays on the device (`sync: "local"`).

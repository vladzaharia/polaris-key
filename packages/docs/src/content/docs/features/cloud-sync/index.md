---
title: "Cloud Sync"
description: "A signed-in person's settings, saves and records, synced across their devices: what works, how a product declares its data and the quota."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

Cloud Sync (service slug `sync`) keeps what one person chose or made in one product and syncs it across their devices. It holds synced settings, which are the product's `config` keys a person sets, and records in declared collections, such as save slots. A record may carry one file. Together these are Cloud Sync data.

:::note[Nothing syncs]
Declarations validate in `pkey validate`, in manifest ingest and in the console's catalog publish. You can turn the service on, and the **Data** page shows what a product declares. The sync routes aren't served: the service has no routes, and discovery names an endpoint only from a release that serves it, so `pull`, `push` and `files` are all `null`. The rest of this page describes the declarations the Worker accepts and the limits they carry.
:::

## It needs sign-in

Cloud Sync data belongs to the principal signed in on the device, as the product's pairwise subject. A device activated with a license key has none and keeps its settings on the device. It uploads them at the first sign-in. Cloud Sync is off by default and requires two other services:

| Requires   | Why                                                                          |
| ---------- | ---------------------------------------------------------------------------- |
| `config`   | A synced setting is a catalog `config` key. With Config off there is nothing |
| `identity` | The principal is the account signed in through the product                   |

Both edges hold both ways. The Services page, the admin API and manifest ingest refuse Cloud Sync without them (`sync_requires_config`, `sync_requires_identity`). Turning either off turns Cloud Sync off in the same change.

## Synced settings

Every `config` key syncs unless its `managementDefault` is `enforced` or `hidden`. A locked key never syncs, and a lock beats a synced value on every device. A synced value fills the device's `local` slot in the config chain, so it beats every unlocked server value. An optional `user` block tunes a key:

| Member     | Values                             | Default     | Meaning                                                   |
| ---------- | ---------------------------------- | ----------- | --------------------------------------------------------- |
| `sync`     | `user`, `platform`, `local`        | `user`      | Roam to every device, one platform family, or never leave |
| `conflict` | `lastWrite`, `max`, `min`, `merge` | `lastWrite` | How two devices' edits resolve                            |
| `listed`   | `true`, `false`                    | `true`      | Whether settings panels show the key                      |

A `user` block on a locked key does nothing, and `pkey validate` warns. A `secret` or `flag` key is never a setting. A key the catalog doesn't declare is an open setting: it syncs to every device, last write wins, with no schema and at most 8 KiB. Declared and open settings share a budget of 256 keys and 64 KiB per player. Any of the person's devices can set an open setting, so treat its value as untrusted input.

## Records and saves

A product declares collections in the catalog's `cloudSync` block, authored in `.pkey/schema`.

```json title=".pkey/schema"
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
      }
    ]
  }
}
```

A collection has a `name` (the key charset `[A-Za-z0-9._:-]`, a trailing `.*` makes a pattern), `label`, `template`, `conflict`, `conflictField`, `schema`, `maxRecords` (at most 10,000), `files` (`maxBytes` up to 1 GiB, `keepRevisions`) and `requires`, an entitlement the person's license must grant. A product declares at most 32 collections. `migrations` apply renames, value maps and drops to synced values when the catalog reaches `toSchemaVersion`. A record is at most 64 KiB.

`template: "saves"` declares 16 save slots per player, which nothing raises. A save holds `playtime`, `progress`, `chapter`, `formatVersion` and a `thumbnail`, plus one file of up to 32 MiB, and the last 5 versions of the file are kept. `template: "session"` is 16 records, last write wins, one 8 MiB file.

## Conflicts

You declare a conflict policy per setting and per collection. Both stores use one vocabulary.

| Policy       | Settings                    | Records                                | What you declare                         |
| ------------ | --------------------------- | -------------------------------------- | ---------------------------------------- |
| `lastWrite`  | The default                 | Yes                                    | Keep the latest edit                     |
| `max`, `min` | A number                    | With a `conflictField` naming a number | Keep the larger or smaller value         |
| `merge`      | An object, member by member | Field by field                         | Keep each member's latest edit           |
| `union`      | No                          | A list with `uniqueItems`              | Keep every element added and not removed |
| `revision`   | No                          | The default for records and `saves`    | Keep both copies for the person to pick  |

`max` and `min` are not anti-cheat: a device can claim a larger value.

## The quota

A person's quota is the entitlement `pkey.cloudSync.bytes`, set by a tier, a license override or an add-on and read from the license of the device that writes. When nothing sets it, the platform default applies: 256 MiB. No quota passes the per-person ceiling of about 1.06 GiB.

A platform admin controls three settings: the platform default (`cloudSync.quota.defaultBytes`), a product ceiling (`cloudSync.ceiling.bytes`, 50 GiB) and a switch that pauses every write (`cloudSync.writesPaused`). The settings can be edited, and nothing enforces them because nothing syncs.

## Validation

`pkey validate`, ingest and the console publish run the same rules.

| Code                               | Rule                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `invalid_user_setting`             | `user` has only `sync`, `conflict` and `listed`. `sync: "device"` is retired: use `local` |
| `user_setting_wrong_kind`          | `user` only on a `config` entry                                                           |
| `user_setting_locked_default`      | A warning: `user` on an `enforced` or `hidden` key does nothing                           |
| `user_conflict_type_mismatch`      | `max` and `min` need a number schema, `merge` an object schema                            |
| `user_conflict_union`              | A setting's `conflict` is never `union`                                                   |
| `merge_members_over_limit`         | A merged value has at most 256 top-level members                                          |
| `union_collection_schema`          | A `union` collection's schema is `type: array` with `uniqueItems: true`                   |
| `collection_name_conflict`         | Names are unique, `*` patterns are disjoint, the key charset holds                        |
| `collection_conflict_field`        | `max` and `min` name a number `conflictField`, and only they do                           |
| `cloud_sync_unknown_entitlement`   | `requires` names a declared flag or a reserved entitlement                                |
| `cloud_sync_limit_over_ceiling`    | `maxRecords` at most 10,000, `files.maxBytes` at most 1 GiB                               |
| `invalid_cloud_sync_migration`     | Rename targets are declared keys, and no key is both renamed and dropped                  |
| `invalid_cloud_sync`               | The block's shape; names the replacement of each retired member                           |
| `cloud_sync_block_without_service` | A warning: declarations while Cloud Sync is off                                           |

Retired with no replacement period: `onAttach`, `cloudSync.saves` (use a collection with `template: "saves"`), `cloudSync.open`, a collection `access` other than `owner`, and `.pkey/product`'s `cloudSync` block.

## Discovery and the console

`services.sync` in [discovery](/docs/reference/protocol/discovery/) is `{"enabled": false}` when off. When on, it lists the kinds of data served and `endpoints` for `pull`, `push` and `files`, each a URL or `null`. An SDK uses an endpoint only when discovery names it.

The **Cloud Sync** section's **Data** page lists the product's synced settings, collections and migrations and the platform limits. The catalog editor tunes a key's `user` block; a key whose syncing is off stays on the device (`sync: "local"`).

## Next steps

- [The catalog](/docs/features/managed-config/catalog/): declare the keys that sync.
- [Management states](/docs/features/managed-config/management-states/): which keys are locked.
- [Sign-in](/docs/features/sign-in/): the principal Cloud Sync needs.

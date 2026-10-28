---
title: "Cloud Sync"
description: "A signed-in person's settings, saves and records, synced across their devices: what works, how a product declares its data and the quota."
type: "concept"
lastReviewed: "2026-10-16"
sidebar:
  order: 1
---

Cloud Sync (service slug `sync`) keeps what one person chose or made in one product and syncs it across their devices. It holds synced settings, which are the product's `config` keys a person sets, and records in declared collections, such as save slots. A record may carry one file. Together these are Cloud Sync data.

Settings sync today. Collections, saves and files are declared and validated but not served: discovery reports `collections` and `saves` as false and `files` as `null`.

## The routes

Both routes are unsigned, take the device's bearer token and `X-PKey-Device`, and live under `/<product>/sync`.

| Route                      | Purpose                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /<product>/sync`      | Pull. With no cursor it answers a snapshot, then the changes since `cursor`, at most 500 at a time. A revalidation is a `304` |
| `POST /<product>/sync/ops` | Push a batch of at most 100 mutations and 256 KiB. The answer carries each result and a pull since the request's cursor       |

No route takes a subject or an account id: the person is the account signed in on the device. A device with none gets `403 account_required`. A Cloud Sync answer never changes license state or a cached document. With Cloud Sync, Config or Identity off, the routes answer `404`. A push is refused with `attestation_required` when the product's trust policy enforces `cloudSyncWrite` and the device doesn't meet it. The wire contract is section 13 of `WIRE-CONTRACT-V4.md`.

## Pause and limits

A platform admin can pause every write (`cloudSync.writesPaused`). A push then answers `503 writes_paused` with `Retry-After`, the client keeps its journal, and pulls are still served.

| Limit                        | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| Pushes per device            | 60 a minute, then `429`                            |
| Pushes per product           | 2,000 a second                                     |
| People with data per product | 100,000                                            |
| Mutations per push           | 100, in at most 256 KiB                            |
| Settings per person          | 256 keys and 64 KiB; an open setting at most 8 KiB |

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

## Who can read it

With `e2e`, the default, the person's devices seal each value before it leaves, with a key ring only
their devices hold. Polaris Key stores ciphertext. It sees which declared keys exist, when they
change and how large they are, and open settings under a blinded name; it never sees a value. You
see the same: the console shows counts, never a person's settings. A person recovers the key on a
new device from another of their devices or from a recovery code. With neither, nobody can recover
their synced settings, and Polaris Key can't help. With `server`, Polaris Key can read the values
and you can use `mapValues` in a migration.

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

A collection has a `name` (the key charset `[A-Za-z0-9._:-]`, a trailing `.*` makes a pattern), `label`, `template`, `conflict`, `conflictField`, `schema`, `maxRecords` (at most 10,000), `files` (`maxBytes` up to 1 GiB, `keepRevisions`, `delta`) and `requires`, an entitlement the person's license must grant. A product declares at most 32 collections. `migrations` apply renames, value maps and drops to synced values when the catalog reaches `toSchemaVersion`. A record is at most 64 KiB. `files.delta` sends only the changed chunks of a new file version; it is on for `saves` and off otherwise.

`cloudSync.encryption` is `e2e` (the default) or `server`. With `e2e` the server holds ciphertext and cannot read synced values; `server` is a per-product opt-out that lets it read them, and only then can a migration use `mapValues`. Names starting with `x:` are reserved for the blinded names an E2E client writes, so no config key or collection may use them.

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

A platform admin controls three settings: the platform default (`cloudSync.quota.defaultBytes`), a product ceiling (`cloudSync.ceiling.bytes`, 50 GiB) and a switch that pauses every write (`cloudSync.writesPaused`). The default and the ceiling are enforced on every push: a write that grows usage past either is `quota_exceeded` (scope `user` or `product`), while a clear or a delete always passes. Lowering a quota removes nothing. A device with no usable license gets the product's Anonymous devices tier, else 1 MiB.

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
| `cloud_sync_reserved_prefix`       | No config key or collection name starts with `x:`                                         |
| `cloud_sync_e2e_map_values`        | `mapValues` needs `cloudSync.encryption: "server"`                                        |
| `invalid_cloud_sync_migration`     | Rename targets are declared keys, and no key is both renamed and dropped                  |
| `invalid_cloud_sync`               | The block's shape; names the replacement of each retired member                           |
| `cloud_sync_block_without_service` | A warning: declarations while Cloud Sync is off                                           |

Retired with no replacement period: `onAttach`, `cloudSync.saves` (use a collection with `template: "saves"`), `cloudSync.open`, a collection `access` other than `owner`, and `.pkey/product`'s `cloudSync` block.

## Discovery

`services.sync` in [discovery](/docs/reference/protocol/discovery/) is `{"enabled": false}` when off. When on, it lists the kinds of data served and `endpoints` for `pull`, `push` and `files`, each a URL or `null`. Today `settings` is true and `pull` and `push` are URLs; `collections` and `saves` are false and `files` is `null`. An SDK uses an endpoint only when discovery names it.

## In the console

The **Cloud Sync** section's **Data** page lists the product's synced settings, collections and migrations and the platform limits. The catalog editor tunes a key's `user` block; a key whose syncing is off stays on the device (`sync: "local"`).

The **Usage** page shows how many people have data, the storage they use against the product's limit, syncs and conflicts today, storage by tier with who is over 80 % of the limit, what is stored, and where people sync from. A game says players and an app says people. The figures refresh about every 15 minutes, count only, and never name a person. A row named **No tier** holds people with no tier or no license; with Licensing off it is everyone, on the default. A platform row named **Not reported** is people whose device sent no platform.

## Next steps

- In your app: [Node](/docs/build/sdks/node/your-own-ui/#synced-settings) and [Python](/docs/build/sdks/python/your-own-ui/#synced-settings), the calls, states and events. Planned for [Swift](/docs/build/sdks/swift/#cloud-sync-settings), [Kotlin](/docs/build/sdks/kotlin/#cloud-sync-settings) and [Godot](/docs/build/sdks/godot/#cloud-sync-settings-polariskeycloud_sync).
- [The catalog](/docs/features/managed-config/catalog/): declare the keys that sync.
- [Management states](/docs/features/managed-config/management-states/): which keys are locked.
- [Sign-in](/docs/features/sign-in/): the principal Cloud Sync needs.

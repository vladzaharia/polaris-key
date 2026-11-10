---
title: "Collections"
description: "Declare a Cloud Sync collection in the catalog, pick its conflict policy and read and write its records from your app."
type: "how-to"
lastReviewed: "2026-11-01"
sidebar:
  order: 2
---

A collection is a named set of records a signed-in person holds across their devices: progress, a profile, a list of favorites. You declare it in the catalog; the SDK's `collection(name)` handle reads and writes its records. Settings and `saves` have their own APIs.

1. Declare the collection in the catalog, with a policy.
2. Ship the compiled mirror, or let the app read the served schema.
3. Call `collection(name)` and read and write its records.

## Declare it

Collections live in the catalog's `cloudSync` block, authored in `.pkey/schema`. Each member is described in [the catalog](/docs/features/managed-config/catalog/) and [Records and saves](/docs/features/cloud-sync/#records-and-saves); this page does not repeat them. The two that choose behavior are `conflict` (the policy) and `schema`.

```json title=".pkey/schema"
{
  "schemaVersion": 5,
  "entries": [],
  "cloudSync": {
    "collections": [
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
        "name": "profile",
        "conflict": "merge",
        "schema": { "type": "object" }
      },
      {
        "name": "favorites",
        "conflict": "union",
        "schema": { "type": "array", "uniqueItems": true }
      },
      { "name": "slots", "conflict": "revision" }
    ]
  }
}
```

Without a compiled catalog mirror, an app takes a collection's policy from the served config schema. Ship the compiled mirror (`pkey mirror`) to fix the policies in the build.

A name the catalog does not declare has no handle behavior: every call is refused with `collection_unknown`. No SDK declares a collection for you. To read `saves` through the handle, declare it like any other (`template: "saves"`); its files still move through [the saves API](/docs/features/cloud-sync/files/).

An id is 1 to 128 characters from `A-Za-z0-9._:-`. A record is at most 64 KiB.

## Policies

The policy decides how two devices' edits resolve and which calls the collection takes. A call the policy does not allow is refused with `op_invalid_for_policy`.

| Policy      | Calls                              | Behavior                                                                                 |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `lastWrite` | `put`, `delete`                    | The latest edit wins                                                                     |
| `max`       | `put`, `delete`                    | The larger `conflictField` wins                                                          |
| `min`       | `put`, `delete`                    | The smaller `conflictField` wins                                                         |
| `revision`  | `put` (with `ifVersion`), `delete` | Each write is based on a version. A stale one is a conflict, and the person picks a copy |
| `merge`     | `update`, `delete`                 | Each field keeps its latest edit. `update` leaves the fields it does not name as stored  |
| `union`     | `add`, `remove`, `delete`          | Every element added and not removed stays                                                |

A plain `put` on a `revision` collection that conflicts opens a [MergeRequest](/docs/features/cloud-sync/#conflicts) and sends nothing: the device keeps its value, unsent, until `request.keep` answers it. Use `put` with `ifVersion` when a write should report its outcome instead.

`ifVersion` is a number (the exact version you hold) or `"*"` (create only), and only a `revision` collection takes it. `max` and `min` are not anti-cheat: a device can claim a larger value.

## The handle

`collection(name)` answers a handle for one collection. The calls are the same in every SDK:

| Call                        | Answers                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `get(id)`                   | The record as `value` and `from` (`pending` while an edit waits, else `cloud`), or `null` |
| `ids()`                     | The ids the person holds, in byte order, pending creates included                         |
| `put(id, value, ifVersion)` | Write a whole record                                                                      |
| `update(id, set, remove)`   | Write the fields in `set` and drop the ones in `remove`, in one edit                      |
| `add(id, element)`          | Add an element to a record's set                                                          |
| `remove(id, element)`       | Remove an element                                                                         |
| `delete(id, ifVersion)`     | Delete the record. `ifVersion` is for `revision` only; by default the version held        |
| `on(listener)`              | Changes to this collection: your own edits, a pull, a merge                               |

`get` returns what is stored untouched, so a field your app version does not know survives a round trip. A listener gets a `change` (the ids and an origin: `local`, `remote`, `merge` or `migration`) or an `outcome`, the result of a `revision` `put` with `ifVersion` or a `revision` `delete`, as `ok`, `conflict`, `rejected` or `dropped`.

### Refusals

A refused call is returned, never thrown, and sends nothing. The result is `ok`, or an error:

| Error                   | Meaning                                                |
| ----------------------- | ------------------------------------------------------ |
| `collection_unknown`    | The catalog does not declare the name                  |
| `signed_out`            | Nobody is signed in on this device                     |
| `op_invalid_for_policy` | The policy does not take this call                     |
| `value_invalid`         | The input is over a cap or cannot be sealed. See below |

The checks run in the order `collection_unknown`, `signed_out`, `op_invalid_for_policy`, `value_invalid`: the first that fails is the answer.

`value_invalid` covers:

- a `union` element over 1 KiB of canonical JSON;
- a `merge` field name that is empty, over 1 KiB or repeated across `set` and `remove`, and an `update` that names no field;
- an id outside `A-Za-z0-9._:-` or longer than 128 characters;
- a NUL character in an id or a field name;
- a `NaN` or an integer beyond 2^53 in a value.

### Your SDK

| SDK    | Get the handle                                 | Spelling                                                                                                                                                                   |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `await client.cloudSync.collection(name)`      | `get`, `ids`, `put(id, value, { ifVersion })`, `update(id, { set, remove })`, `add`, `remove`, `delete`, `on(listener)`                                                    |
| React  | `useCollection(name)`                          | `ids` and `get(id)` re-render on every change. The verbs are on `handle`, which is `null` until it loads. Only the writer tab can write                                    |
| Python | `client.cloud_sync.collection(name)`           | `get`, `ids`, `put(id, value, if_version=)`, `update(id, {"set": ..., "remove": [...]})`, `add`, `remove`, `delete(id, if_version=)`, `on(listener)`                       |
| Swift  | `try await client.cloudSync.collection(name)`  | `get(_:)`, `ids()`, `put(_:_:ifVersion:)`, `update(_:set:remove:)`, `add`, `remove`, `delete(_:ifVersion:)`, `on(_:)`                                                      |
| Kotlin | `client.cloudSync.collection(name)` (suspend)  | `get`, `ids`, `put(id, value, ifVersion)`, `update(id, set, remove)`, `add`, `remove`, `delete`, `on(listener)`                                                            |
| Godot  | `await PolarisKey.cloud_sync.collection(name)` | `get_record`, `ids`, `put(id, value, if_version)`, `update(id, {"set": ..., "remove": [...]})`, `add`, `remove`, `delete(id, if_version)`; signals `changed` and `outcome` |

`on` answers a way to stop listening: a function in Node and Python, a subscription with `cancel()` in Swift and Kotlin. Swift passes `ifVersion` as `.version(n)` or `.any`, Kotlin as `IfVersion.At(n)` or `IfVersion.Absent`. Swift and Kotlin answer a result that is `ok` or `refused`; Godot a `PKeyResult`, whose failure code is the error. The async Python client returns an async view: `get`, `put` and the rest are coroutines, and `on` stays synchronous.

```ts
import type { PolarisKeyClient } from "@polaris-key/node";

export async function saveProgress(client: PolarisKeyClient, level: number) {
  const progress = await client.cloudSync.collection("progress");
  const saved = progress.put("main", { level });
  if (!saved.ok) return saved.error; // "signed_out", "value_invalid", ...
  console.log(progress.get("main")); // { value, from: "pending" }
  return undefined;
}

export async function editProfile(client: PolarisKeyClient) {
  const profile = await client.cloudSync.collection("profile");
  // Only the named fields change; others stay as stored.
  return profile.update("me", { set: { theme: "dark" }, remove: ["legacy"] });
}

export async function favorite(client: PolarisKeyClient, item: string) {
  const favorites = await client.cloudSync.collection("favorites");
  const stop = favorites.on((e) => {
    if (e.type === "change") console.log(e.origin, e.ids);
  });
  favorites.add("all", item);
  stop();
}

export async function claimSlot(client: PolarisKeyClient) {
  const slots = await client.cloudSync.collection("slots");
  // Create only: if the slot exists, the outcome reported to `on` is a conflict.
  return slots.put("one", { name: "Run 2" }, { ifVersion: "*" });
}

export async function askOnConflict(client: PolarisKeyClient) {
  // A `revision` conflict on a plain `put` opens a request; answer it here or in a screen.
  return client.cloudSync.onConflict((request) => {
    if (request.collection !== "progress") return undefined;
    // Returning a choice decides it at once; the SDK sends nothing for "remote".
    return request.remote === null ? "local" : "remote";
  });
}
```

```python
from polaris_key import PolarisKeyClient


def save_progress(client: PolarisKeyClient, level: int) -> object:
    progress = client.cloud_sync.collection("progress")
    saved = progress.put("main", {"level": level})
    if not saved["ok"]:
        return saved["error"]  # "signed_out", "value_invalid", ...
    return progress.get("main")  # {"value": ..., "from": "pending"}


def edit_profile(client: PolarisKeyClient) -> object:
    profile = client.cloud_sync.collection("profile")
    # Only the named fields change; others stay as stored.
    return profile.update("me", {"set": {"theme": "dark"}, "remove": ["legacy"]})


def favorite(client: PolarisKeyClient, item: str) -> None:
    favorites = client.cloud_sync.collection("favorites")
    stop = favorites.on(lambda e: print(e["type"], e.get("ids")))
    favorites.add("all", item)
    stop()


def claim_slot(client: PolarisKeyClient) -> object:
    slots = client.cloud_sync.collection("slots")
    # Create only: if the slot exists, the outcome reported to `on` is a conflict.
    return slots.put("one", {"name": "Run 2"}, if_version="*")
```

## Who can read it

With `e2e`, the default, the device seals each value, field and element before it leaves, and Polaris Key sees the record, field and element only under blinded names. A file-only record has no readable id, so `ids()` leaves it out. See [Who can read it](/docs/features/cloud-sync/#who-can-read-it) for the key ring, and for what `merge` and `union` records written before `e2e` can do.

A call that the device cannot seal, such as a value with a `NaN`, is refused as `value_invalid` rather than sent in the clear.

## Next steps

- [Cloud Sync](/docs/features/cloud-sync/): the routes, limits, conflicts and the quota.
- [Files](/docs/features/cloud-sync/files/) and the saves API: the file a record may carry.
- [The catalog](/docs/features/managed-config/catalog/): every member of a collection declaration.

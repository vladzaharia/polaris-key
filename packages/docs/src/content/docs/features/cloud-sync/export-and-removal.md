---
title: "Cloud Sync export and removal"
description: "What a person's export holds of their Cloud Sync data, the zip's layout and limits, and how removing their data from a product reaches Cloud Sync."
type: "reference"
lastReviewed: "2026-11-10"
sidebar:
  order: 4
---

Polaris Locker shows a person what Cloud Sync holds for them in a product, as sizes and times, in its **Sync Across Devices** section. From there they download it, and Your Data removes it with the rest of the product's data. Both go through the portal API with the portal session; no device route takes part.

## Export

A person downloads what Cloud Sync holds for them in Polaris Locker, as part of the product's export: `GET /api/products/<product>/export`, schema `pkey-product-export/1`. Its `stores["sync.cloudSync"]` section carries:

- the directory counters, usage, the encryption mode and `encryptionSince`;
- the synced settings rows, with end-to-end rows as ciphertext and their `kid`;
- counts and bytes per collection, and the chunk count and bytes;
- the client bindings: `clientId`, `deviceId` and `lastSeen`;
- the records inline only while they total 4 MiB or less, else `recordsIn: "zip"`;
- the file metadata up to 2,000 rows, else `filesIn: "zip"`.

With `?format=zip` the answer is `polaris-locker-<product>-data.zip`: `README.txt`, `data.json` (the document above) and the folder `stores/sync.cloudSync/`. Entry names are indexes, never the ids the data holds; `index.json` maps them.

| Entry                           | What it holds                                                      |
| ------------------------------- | ------------------------------------------------------------------ |
| `index.json`                    | Which entry holds which collection, file or chunk container        |
| `records/<i>.ndjson`            | One collection's rows, a line each: live rows and tombstones       |
| `records/parked.ndjson`         | The copies earlier account merges parked                           |
| `files.json`, `files/<n>.bin`   | Every live file and kept revision, as stored                       |
| `chunks.json`, `chunks/<j>.bin` | One collection's delta chunks back to back, with each one's offset |

In end-to-end mode the record values and the files are the stored ciphertext, readable only on the person's devices; in server mode the files are plaintext. The zip is streamed with uncompressed entries, one read at a time. An export that would need more than 8,000 storage reads (two a file, one a chunk) or 65,000 entries is refused up front with `413 export_too_large`, never cut off halfway, and an object erased or merged while the export runs fails the download rather than finishing it short. The export has the same gates as the JSON: the portal session, a sign-in no older than five minutes, a rate limit and an audit row.

## Removal

"Remove my data from <Product>" in Polaris Locker (`DELETE /api/products/<product>/data`) removes what every store holds for the person's pairwise subject in the product, Cloud Sync included, in this order:

1. The removal is recorded in a ledger outside the database. If that fails the answer is `503 erasure_ledger_unavailable` and nothing has changed.
2. The devices signed in with the subject lose the binding: they get `account_required` and stop syncing.
3. Each store deletes on its own. The key ring goes before Cloud Sync's object, which deletes its file keys, its files and its storage, and refuses writes for 24 hours.

If a store fails, the answer is `200` with `pending: true`: the other stores still ran, and the removal is finished on the next maintenance pass or when the person repeats it. While it is owed, the portal's summary (`GET /api/products/<product>/sync`) reads `state: "removing"`. After a database restore, the same pass removes the restored rows again. The developer is told with `subject.deleted`.

## On the device

A device finds out at its next contact. Its Cloud Sync call answers `403 account_required`, from a sync, key-ring or file route, and the SDK treats the subject as gone:

- Unsent edits, the synced copy and the cursor are discarded. The next sign-in starts from a fresh pull.
- The end-to-end root is dropped from memory and the key ring's pin is removed; the platform backup stays. Recovery is the wrap from another device or the recovery code.
- `status()` reads `blocked` with reason `account_required`, across a relaunch, and nothing is sent. A `signedOut` event with the discarded count, then `signInOffered`, are emitted.

Your app does two things:

- Show "Sync stopped." with Sign in to sync, not an error. The kits do. Their button starts the kit's own sign-in unless your app handles it (`onAction`, `onSignIn`, `sign_in_requested`).
- With your own UI, open the event's `signInUrl` if it is not null. The SDK has already checked it is on the Worker's origin; open nothing else. A kit needs no `signInUrl`.

The block lifts when the person completes a sign-in in this run. The account the app replays at launch does not lift it. A signed-in person who is removed from another device is blocked the same way, since a device cannot tell a removal from any other cleared binding.

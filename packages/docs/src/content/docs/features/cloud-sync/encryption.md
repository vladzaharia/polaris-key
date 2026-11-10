---
title: "End-to-end encryption"
description: "How Cloud Sync seals a person's data on their devices: the key ring, the recovery code, the platform backup, unlocking a new device and server mode."
type: "concept"
lastReviewed: "2026-11-09"
sidebar:
  order: 5
---

Cloud Sync is end-to-end encrypted unless the product opts out. The person's devices seal every setting, record and file before it leaves, under a key only those devices hold. Polaris Key stores ciphertext and can't read it, and neither can you.

## What the server sees

In end-to-end mode, the Worker and the console see:

- declared setting keys and collection names, in the clear;
- sizes, versions, times, conflict policies and the key id (`kid`) of each sealed value;
- every name a person chose only as a blinded `x:` name: an open setting's key, a record id, a member, field or element name.

They never see a value or a file's contents. Values are padded to a multiple of 64 bytes, so sizes are approximate.

## The key ring

Each person has one key ring per product. Its root is 32 random bytes made on their first device. The Worker keeps two kinds of copy, and holds no key that opens either:

| Copy            | Sealed to                                  |
| --------------- | ------------------------------------------ |
| A wrap          | One device's agreement key, one per device |
| A recovery blob | The recovery code, one per ring            |

The ring is Core's, served under `/<product>/devices/keyring` with the device's bearer token. Its routes answer `404` unless the operator's `launch.syncE2e` gate is on and the product's Cloud Sync is end-to-end. While the gate is off, discovery reports no `encryption`, and an app that requires end-to-end mode keeps Cloud Sync on the device.

## How a device gets the key

A device with no root is locked. Edits stay on it, nothing is pulled, and sealing or opening a value fails with `sync-locked`.

| Way             | When                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| Its own wrap    | Every start after its first unlock                                                   |
| Platform backup | A new device of the same person: iCloud Keychain on Apple, Block Store on Android    |
| Recovery code   | Any device. The only way in a browser                                                |
| Nearby approval | A signed-in device wraps the root to this one with `wrapTo`. The kits don't offer it |

A device that recovers with the code stores its own wrap, so its next start needs no code. A browser that can't keep its device keys asks for the code on every load.

### The platform backup

The Swift SDK and the Kotlin SDK's Play flavor copy the root into the platform backup, on by default. A new device opens the ring from it before it asks for the code. On Android, Block Store sends it to the cloud only when the backup is end-to-end encrypted. A sign-out keeps the backup, because deleting the item would delete it on every device of that Apple ID.

To opt out, set `SyncKeyringOptions.backup` to `.off` (Swift) or `KeyringOptions(keyBackup = false)` (Kotlin). The opt-out stops reads and writes but leaves an item an earlier build wrote. Call `deleteBackup()` (Swift) or `removeBackup()` (Kotlin) when the person deletes their account. Godot, the web, Node, Python, the Kotlin direct flavor and a JVM desktop have no backup and use the code.

## The recovery code

- **Shown once.** `create()` returns the first code and `reset()` a new one. The SDK keeps it nowhere: not in storage, a log or an error.
- **Its shape.** 32 characters in 8 groups of 4, with a checksum. Case, spaces and hyphens don't matter. The SDK checks the code before any request, so a typing mistake costs nothing.
- **One per product.** `setRecoveryCode()` makes a new one, and the old one stops working.
- **Guarded.** A device can read the recovery blob 5 times a day. Each read is audited, and the account gets an email that names the device. The code works only on a device signed in to that account.

Ask for the code only inside your app. Polaris Locker tells people that no one asks for it, by email, chat, phone or on a web page.

## Start over

`reset()` makes a new ring and a new code, and the account gets an email. The old ring stays read-only for 30 days. In that time, a device that still holds the old root can fold it into the new ring (`adopt`) and move the old data to the new key. After 30 days the Worker deletes rows sealed under the old ring.

With no device holding a root, no wrap and no code, the data can't be recovered, by the person, by you or by Polaris Key.

## A changed ring

Each device pins the first ring it unlocks. When the Worker serves another ring, `unlock()` answers `ring-changed` and opens nothing. Show the person which device set the new ring up. Call `acceptRingChange()` only after they confirm. The new ring's recovery code also re-pins, and a reset by this device re-pins itself.

## In your app

The kits draw every step. The status row says **Sync is locked** with **Unlock sync**. UnlockSync takes the code and offers **Start over**. RecoveryCode shows a new code once and waits for **I've saved my recovery code**. RingChange offers **That was me** and **Use recovery code**.

| Kit     | Screens                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| React   | `UnlockSync`, `RecoveryCode`, `RingChange` and `CloudSyncStatus`, from `@polaris-key/react/kit`             |
| SwiftUI | `CloudSyncKitView`, or `UnlockSyncView`, `RecoveryCodeView`, `RingChangeView` and `CloudSyncStatusView`     |
| Compose | `PolarisCloudSyncKit`, or `PolarisUnlockSync`, `PolarisRecoveryCodeScreen` and `PolarisRingChange`          |
| Godot   | `PKeyCloudSyncKitHost`, or `PKeyUnlockSync`, `PKeyRecoveryCode`, `PKeyRingChange` and `PKeyCloudSyncStatus` |

Put a **New recovery code** action in your settings: the kit's no-code message tells a person to look for it. Wire it to the kit host's `requestNewRecoveryCode()` (Swift, Kotlin) or `request_new_recovery_code()` (Godot), which shows the code on RecoveryCode. In React, show the code `useRecoveryCode().replace()` returns.

With your own UI, the key ring is `client.keyring` (`PolarisKey.keyring` in Godot; `useSyncLock()` and `useRecoveryCode()` in React). See [Node](/docs/build/sdks/node/your-own-ui/#the-key-ring), [Python](/docs/build/sdks/python/your-own-ui/#the-key-ring), [React](/docs/build/sdks/react/your-own-ui/#synced-settings) and [Kotlin](/docs/build/sdks/kotlin/#cloud-sync-key-ring).

## Server mode

A product opts out with `cloudSync.encryption: "server"` in its catalog. Polaris Key then reads the values, validates and merges them on the server, and a migration can use `mapValues`.

An app requires end-to-end mode unless its Cloud Sync `encryption` client option says `server`. The option is app code, never read from the Worker. An app that requires end-to-end mode never sends plaintext to a Worker that offers server mode: Cloud Sync stays on the device with `sync-encryption-pinned`.

Switching modes rewrites nothing. Plaintext written before a switch to `e2e` stays readable ([Who can read it](/docs/features/cloud-sync/#who-can-read-it) has the limits), and sealed rows stay sealed after a switch back to `server`.

## Errors

| Code                     | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `sync-locked`            | This device has no root yet: unlock with the code or the backup    |
| `recovery-code-invalid`  | A bad checksum, or a code that doesn't open this ring's blob       |
| `keyring_conflict`       | A ring already exists, or the device already has a wrap            |
| `rate_limited`           | The 6th read of the recovery blob in a day, with `Retry-After`     |
| `sync-encryption-pinned` | The app requires end-to-end mode and the Worker offers server mode |

## Help for the people who use your app

- [Unlock sync on a new device](/docs/help/sync-new-device/)
- [Your recovery code](/docs/help/recovery-code/)
- [Sync Across Devices](/docs/help/sync/)

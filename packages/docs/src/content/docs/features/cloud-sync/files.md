---
title: "Cloud Sync files"
description: "A record's file in Cloud Sync: how a product declares one, how an upload runs, and the limits, errors and quota."
type: "reference"
lastReviewed: "2026-11-01"
sidebar:
  order: 2
---

A record in a Cloud Sync collection may carry one file, such as a save's data. The Worker serves files only while the operator's `launch.syncFiles` gate is on; until then every file route answers `404` and discovery names no `endpoints.files`.

## Declare it

A collection opts in with `files` (see [Cloud Sync](/docs/features/cloud-sync/)):

| Member          | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `maxBytes`      | The largest file, up to 1 GiB. A larger `begin` is `413 file_too_large` |
| `keepRevisions` | How many older versions are kept. Older ones are collected              |
| `delta`         | Send only the changed chunks of a new version (`format: "chunks"`)      |

`template: "saves"` declares a file of up to 32 MiB and 5 kept versions.

## Upload

An upload is one session. The client opens it, sends the bytes, then commits.

| Step     | Route                                                             | Answer                                                   |
| -------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Begin    | `POST /<product>/sync/files/{collection}/{id}/begin`              | `uploadId`, `mode`, `partBytes` (multipart), `expiresAt` |
| Send     | `PUT …/upload/{uploadId}`, or `PUT …/upload/{uploadId}/parts/{n}` | `204`                                                    |
| Resume   | `GET …/upload/{uploadId}`                                         | `mode`, `size`, `received` (part numbers)                |
| Abort    | `DELETE …/upload/{uploadId}`                                      | `204`; the reserved bytes are released                   |
| Finalize | `POST …/finalize` with `{uploadId}`                               | `version`, `size`, `sha256`, `format`                    |

Begin declares `size`, `sha256` (the hash of the bytes stored), `format` (`whole`, or `chunks` with `delta`), `enc` (`none` or `e2e`, which must match the product's mode) and an optional `baseVersion`: a number is compare-and-swap, `"*"` creates only, and absent overwrites. `expiresAt` is Unix epoch milliseconds.

The server picks the mode. A file up to 16 MiB goes in one `PUT`. A larger one is multipart: parts of `partBytes` (at least 8 MiB, a multiple of 1 MiB, the last shorter), sent in any order, up to 4 at once. Every `PUT` carries `Content-Length` and a `Content-Digest` (`sha-256=:<base64>:`) of its bytes. Finalize is idempotent per `uploadId`.

A session lasts 24 hours and holds its bytes against the person's quota until it ends. A person has at most 4 open sessions.

## From an SDK

The Node, React and Python SDKs run all of this through [saves](/docs/features/cloud-sync/saves/): they begin the upload, resume it after an interruption and finalize it, then write the record. The transfer journal and the chunk cache are per person and are removed at sign-out. With `delta`, a new version sends only the chunks that changed.

## Transfers in the background

A save can keep uploading or downloading after the app leaves the foreground. It is off by default in every SDK. With it on, iOS hands the request to the system; Android runs a user-initiated job and shows a "Syncing" notification. Swift, Kotlin on Android and Godot on iOS and Android have it; the other SDKs and platforms transfer in the foreground only.

The sign-in token reaches native code only inside each request, never in files, events or scheduler data. Android's scheduler holds a hashed transfer id and a hashed person tag, nothing else.

An interrupted write is reported after a relaunch. Each `saves:<id>` upload that is in the transfer journal and that no live write holds arrives once as `transferFailed` with id `saves:<id>` and code `transfer-failed`. Call `write(id, bytes)` again to resume from the journal; parts that already finished are not sent again. The event, code and id are the same in Swift, Kotlin and Godot.

### Swift

Set `backgroundTransfers` on `CloudSyncOptions`, then pass the system's background-events callback to `PolarisKeyClient.handleBackgroundEvents` from the app delegate's `application(_:handleEventsForBackgroundURLSession:completionHandler:)`. It returns `false` for a session that is not Polaris Key's, so handle your own first or after. No Info.plist entry is needed.

```swift
import PolarisKey

func syncOptions() -> CloudSyncOptions {
    CloudSyncOptions(backgroundTransfers: true)
}

// In your UIApplicationDelegate:
// application(_:handleEventsForBackgroundURLSession:completionHandler:)
func handleBackgroundSession(identifier: String, completionHandler: @escaping @Sendable () -> Void) {
    if !PolarisKeyClient.handleBackgroundEvents(identifier: identifier, completion: completionHandler) {
        completionHandler()
    }
}
```

Pass the options as `PolarisKeyClientOptions(core:cloudSync:)`.

### Kotlin on Android

Set `CloudSyncHostOptions.backgroundTransfers`. `PolarisKeyAndroid.client` then installs the scheduler for you. The app declares two permissions itself, because neither AAR does:

| Permission                | Without it                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_USER_INITIATED_JOBS` | The system refuses the job and the write runs as a WorkManager job instead: it waits for a network and a battery that is not low |
| `POST_NOTIFICATIONS`      | The job still runs; on Android 13 and newer the "Syncing" notification is not shown until the person grants it at runtime        |

`SyncTransfers.notifier` replaces the notification. Its text must not name a save.

```kotlin android
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import im.plrs.key.platform.transfer.SyncTransfers
import im.plrs.key.sdk.CloudSyncHostOptions

fun syncOptions(): CloudSyncHostOptions = CloudSyncHostOptions().apply { backgroundTransfers = true }

fun brandNotification() {
    SyncTransfers.notifier { context ->
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("sync", "Sync", NotificationManager.IMPORTANCE_LOW))
        Notification.Builder(context, "sync")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Syncing your saves")
            .setOngoing(true)
            .build()
    }
}
```

Pass the options as `PolarisKeyClientOptions(cloudSync = ...)`.

### Godot

Set `PKeyOptions.cloud_sync_background_transfers`. iOS and Android need the Polaris Key native plugin; without a native lane, saves and files report `unsupported` with reason `dependency`. There is no iOS Info.plist entry.

On Android, also set the export preset option `polaris_key/cloud_sync_background` (`PKEY_CLOUD_SYNC_BACKGROUND` in CI). Without it the export strips the job and notification permissions, and a transfer the person starts runs as a WorkManager job.

```gdscript
func background_options() -> PKeyOptions:
	var opts: PKeyOptions = load("res://polaris_key.tres").duplicate()
	opts.cloud_sync_background_transfers = true
	return opts
```

Linux, Windows, macOS and web have no background transfer.

## Download

`GET …/files/{collection}/{id}` returns the live file; `?version=` returns a kept older one, and `GET …/{id}/revisions` lists them. The answer is `application/octet-stream` with `Content-Disposition: attachment`, an `ETag` of the file's hash and `Range` support (`206`, `416`). Bytes come only through the Worker: there is no public or presigned URL. Deleting a record deletes its file and revisions.

## Errors

| Status | Code                   | Meaning                                                                                                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| 400    | `upload_mismatch`      | The bytes or their digest do not match what `begin` declared; nothing stored                           |
| 403    | `quota_exceeded`       | The size does not fit the person's allowance or a ceiling; `scope` says which                          |
| 403    | `entitlement_required` | The collection's `requires` flag, or file storage, is not granted                                      |
| 409    | `revision_conflict`    | `baseVersion` is stale; `server.version` is the current one                                            |
| 409    | `upload_incomplete`    | Finalize before every part arrived; `missing` lists them                                               |
| 410    | `upload_expired`       | The session is past 24 hours                                                                           |
| 429    | `rate_limited`         | 30 transfers an hour per device, 600 other requests a minute, or 4 open sessions; honour `Retry-After` |

## Encryption

With `cloudSync.encryption: "e2e"` the client encrypts the file and `sha256` is the hash of the ciphertext; the server never sees plaintext. With `server` the file is stored encrypted at rest under a key per person, and deleting the person's data makes the stored copies unreadable.

The wire contract is section 13.8 of `WIRE-CONTRACT-V5.md`.

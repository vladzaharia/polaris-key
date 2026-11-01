---
title: "Cloud Sync files"
description: "A record's file in Cloud Sync: how a product declares one, how an upload runs, and the limits, errors and quota."
type: "reference"
lastReviewed: "2026-10-31"
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
| `delta`         | Planned: send only changed chunks of a new version. Not served yet      |

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

Begin declares `size`, `sha256` (the hash of the bytes stored), `format` (`whole`), `enc` (`none` or `e2e`, which must match the product's mode) and an optional `baseVersion`: a number is compare-and-swap, `"*"` creates only, and absent overwrites. `expiresAt` is Unix epoch milliseconds.

The server picks the mode. A file up to 16 MiB goes in one `PUT`. A larger one is multipart: parts of `partBytes` (at least 8 MiB, a multiple of 1 MiB, the last shorter), sent in any order, up to 4 at once. Every `PUT` carries `Content-Length` and a `Content-Digest` (`sha-256=:<base64>:`) of its bytes. Finalize is idempotent per `uploadId`.

A session lasts 24 hours and holds its bytes against the person's quota until it ends. A person has at most 4 open sessions.

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

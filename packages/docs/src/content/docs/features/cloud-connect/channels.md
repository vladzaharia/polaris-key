---
title: "Cloud Connect channels"
description: "Open a channel to another of a person's devices, send and receive messages, and handle why it closed, including on sign-out."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 3
---

A channel is an encrypted session between two of a person's devices. `start()` brings up discovery and the relay, `open(deviceId)` returns the session, and `onChannel()` hands you the sessions other devices open to this one. See [Cloud Connect](/docs/features/cloud-connect/) for the SDK entries.

## Opening a channel

`open(deviceId)` tries the local network first when the device was seen there, for at most 4 seconds, then the relay. A device not seen on the local network goes straight to the relay. Pass the relay off for the call, or start with it off, to stay on the local network. The session's `path` says which was used: `lan` or `relay`.

When no path works, `open` fails with the last path's error. Over the relay that is one of:

| Reason             | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `disabled`         | The product turned the relay off.                                             |
| `paused`           | The deployment paused it.                                                     |
| `quota`            | A relay quota is spent. See [the relay](/docs/features/cloud-connect/relay/). |
| `unknown_peer`     | The id is not a device on the person's roster, or is this device.             |
| `busy`             | Too many relay sessions are open.                                             |
| `not_connected`    | The relay socket is not up.                                                   |
| `handshake_failed` | The other device did not complete the handshake in time.                      |
| `wrong_peer`       | The device that answered is not the one you asked for.                        |

Only devices of the same person can open a channel. Both devices must be signed in and have started Cloud Connect.

## Sessions and messages

A session has `send`, `receive`, `onMessage`, `onClose` and `close`. A message is bytes plus an application type from `0x0100` to `0x7FFF`; the default is `0x0100`.

- A message is at most the peer's `maxMessage`, and never more than 1 MiB. A larger one fails with `too_large`. Over the relay a message is cut into records that fit the 64 KiB relay envelope and reassembled by the peer.
- With no `onMessage` listener, messages queue for `receive`: up to 256 messages and 8 MiB. The transport pauses at 4 MiB. Past either limit the session closes with `peer_busy`.
- With no `onChannel` listener, a session another device opens is closed at once.
- Every session rekeys, after 2^20 messages or an hour.

## Why a channel closed

`onClose` gives a code and whether the peer closed it.

| Code              | Meaning                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `peer_bye`        | Closed normally, by either side. `close()` sends it.                                         |
| `peer_busy`       | A side's queue passed its limit. `close("peer_busy")` also sends it.                         |
| `connection_lost` | The socket went away, or the relay reported the other device gone. No close record was sent. |
| `peer_expired`    | The other device's certificate ran out while the channel was open.                           |
| `peer_revoked`    | The other device was removed from the person's roster.                                       |

`wrong_peer` is not a close code. It fails an `open` before the session exists, when the certificate that answers names another device than the one dialled.

The Worker never emits these codes. They travel between devices in a `CLOSE` record. See [The peer protocol](/docs/reference/protocol/peer/#errors).

## Sign-out

A sign-out stops Cloud Connect first, then forgets the person's roster and discovery key, before anything else is wiped. The stop is bounded. In every SDK it waits at most 15 seconds for sessions and sockets to close, then cancels what is left without a graceful close and goes on. A callback of yours that blocks the stop cannot hold the sign-out. In Kotlin the stop then throws `LanException(closed)`; in the others it returns.

Call `stop()` yourself when the person leaves the screen that uses channels. In React, put it in the cleanup of the effect that called `start()`.

## Per SDK

| SDK    | Open                                       | Session                                                                             |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Node   | `open(deviceId)`                           | `send(body, type?)`, `receive()`, `onMessage(fn)`, `onClose(fn)`, `close()`         |
| React  | `open(deviceId)` from `useCloudConnect()`  | The relay is the only path                                                          |
| Python | `open(device_id)`                          | `send`, `receive(timeout)`, `on_message`, `on_close`, `close`                       |
| Swift  | `open(_:relay:lanAttemptSeconds:)`         | `send(_:type:)`, `receive()`, `onMessage`, `onClose`, `close(_:)`                   |
| Kotlin | `open(deviceId, relay, lanAttemptSeconds)` | `send(body, type)`, `receive(timeoutMillis)`, `onMessage`, `onClose`, `close(code)` |

The local network path is not offered on Android. See [Cloud Connect](/docs/features/cloud-connect/#calls-per-sdk).

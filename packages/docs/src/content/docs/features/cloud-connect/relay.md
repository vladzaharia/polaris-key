---
title: "The Cloud Connect relay"
description: "How a device gets onto the relay: tickets, who is admitted, the quotas and rate limit that close or slow a socket, and what the relay can see."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 2
---

The relay carries a person's channels when the local network does not reach. A web page has no other path. Everything on it is ciphertext between two of the person's devices. See [Cloud Connect](/docs/features/cloud-connect/) for the service and [Channels](/docs/features/cloud-connect/channels/) for what an app does with one.

The relay is on only when the platform setting `launch.relay` is on, the product's `cloudConnect.relay.enabled` is not `false`, and the deployment has not paused it.

## Getting on the relay

1. The SDK buys a ticket: `POST /<product>/connect/relay/ticket`, with the device's token and `X-PKey-Device`. A device gets 12 tickets a minute.
2. The answer is `{ticket, url, protocol, expiresAt}`. The ticket starts with `pkeyrt_`, lives 60 seconds and opens one socket. The protocol is `pkey-relay.1`.
3. The SDK opens `GET /<product>/connect/relay` as a WebSocket with the subprotocols `pkey-relay.1` and the ticket. A browser socket cannot send an `Authorization` header, which is why the ticket rides there.

The Worker asks the same questions at the ticket and again at the upgrade, because a ticket outlives the answer by up to a minute.

| Order | Question                                                  | Refusal                                                 |
| ----- | --------------------------------------------------------- | ------------------------------------------------------- |
| 1     | Is the product's relay switch on?                         | 403 `relay_disabled`                                    |
| 2     | Has the deployment paused the relay?                      | 503 `relay_paused`, with `Retry-After` of 300 s         |
| 3     | Has the product spent its month, or the person their day? | 429 `relay_quota_exceeded`, scope `product` or `person` |

Upgrades are also limited to 60 a minute per network, counted before the ticket is read. Over either limit the answer is 429 `rate_limited` with `Retry-After: 60`.

## Admission

One room holds one person on one product. The room trusts nothing the client says about itself:

- The person and device come from the consumed ticket, checked again against the device's current binding.
- The roster is read fresh when the socket opens. A device not on it is closed with 4003, and so is a message addressed to a device that is not on it.
- The relay stamps the sender on every message it forwards. A client names only the recipient.
- A device holds two sockets. A third closes the oldest with 4009. A room holds 32 sockets, and a socket past that is closed with 4008.
- A message to a device that is offline is dropped. There is no mailbox.

## Quotas and the console ceiling

| Limit                     | Value                                                                                                              | When spent           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| A person's bytes per day  | The `pkey.cloudConnect.relayBytes` entitlement: 256 MiB when unset, 16 MiB without a usable license, at most 4 GiB | `LIMIT` 2, `person`  |
| A product's bytes a month | The ceiling on the console's **Setup** page, at most 500 GiB                                                       | `LIMIT` 3, `product` |

Days and months are UTC. A message counts by its whole envelope. The local network is never metered.

The console ceiling is `cloudConnect.ceiling.relayBytes`. A value above 500 GiB is read as 500 GiB. Raising a person's day is a tier, a license override or an add-on that sets the entitlement; nothing raises it past 4 GiB. See [Cloud Connect settings](/docs/build/manifest/product/#cloud-connect-settings-connect) for the manifest side.

## Pacing and LIMIT

A socket may send 200 messages a second, with a burst of 400. When the relay cannot take a message it drops it and answers with `LIMIT`. The socket stays open, except where noted.

| `LIMIT` | Reason              | What the SDK reports                                          |
| ------- | ------------------- | ------------------------------------------------------------- |
| 1       | Rate                | `rate_limited`. A hundred in a row close the socket with 4008 |
| 2       | The person's day    | `quota`, scope `person`                                       |
| 3       | The product's month | `quota`, scope `product`                                      |
| 4       | Paused              | `paused`. A paused relay also closes sockets with 4008        |

The Swift, Python and Kotlin SDKs pace themselves under the limit: 180 messages a second with a burst of 360, halved for 10 seconds after a `LIMIT` 1, and a queue of at most 8 MiB behind the socket. A send that would pass the queue fails with `rate_limited` before anything is encrypted. The Node and browser SDKs do not pace, so keep your own sends under 200 a second.

A spent quota, the relay switch or a pause closes sockets within a minute. The SDK reports the reason in its status.

## In a web app

The page's Content-Security-Policy needs `connect-src wss://<Worker host>`. Without it the socket never opens. See [In a web app](/docs/features/cloud-connect/#in-a-web-app) for the React hook and what the status reports.

## What the relay sees

| Sees                                                                  | Does not see                    |
| --------------------------------------------------------------------- | ------------------------------- |
| That a device of the person is online, and which ones                 | The contents of a message       |
| Which device sent to which, the message size and the time             | A label, a name or a file name  |
| Byte counts per product and day, which the console shows as **Usage** | The keys that protect a channel |

The relay forwards the Noise records unopened. Only the two devices hold the keys, and the certificates that bind them to the person's roster are checked on the devices, not the relay. The wire layout of the envelope is in [The peer protocol](/docs/reference/protocol/peer/).

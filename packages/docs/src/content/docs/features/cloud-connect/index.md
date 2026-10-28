---
title: "Cloud Connect"
description: "Link a person's devices and move data between them, over the local network or a relay. What Cloud Connect and Direct Transfer are, and what exists today."
type: "concept"
lastReviewed: "2026-10-26"
sidebar:
  order: 1
---

Cloud Connect (service slug `connect`) lets one person's devices find each other and open an encrypted channel, on the local network or through a relay. It needs sign-in: the devices it links are the ones signed in to the same account.

**Direct Transfer** is the data that crosses such a channel: a file, a save or a setting sent from one of a person's devices to another without going through Cloud Sync's storage.

## Status

Cloud Connect is off by default, and off in production until it is signed off. The platform setting `launch.connect` serves the identity and devices routes and `launch.relay` serves the relay; both default off and fail closed, and with one off its routes answer not found and discovery reports Cloud Connect as off. A product also has to enable the service (below). The SDK calls and the console pages exist.

## Turn it on

Declare it with `modules: { connect: { enabled: true } }` in `.pkey/product`. It requires Identity: a manifest that enables `connect` with `identity` off fails with `connect_requires_identity`.

| Requires   | Why                                                          |
| ---------- | ------------------------------------------------------------ |
| `identity` | Devices are linked by the account that is signed in on each. |

## Settings

The `connect:` block in `.pkey/product` sets `relay` (on by default) and `interAccount` (off by default); see [Cloud Connect settings](/docs/build/manifest/product/#cloud-connect-settings-connect). Nothing reads them until the relay ships. A person's relay bytes per day are the `pkey.cloudConnect.relayBytes` entitlement: 256 MiB when unset, 16 MiB without a usable license, at most 4 GiB. A product's relay is capped at 500 GiB a month.

## In a web app

A page has no LAN, so the relay is its only path. In React, `useCloudConnect()` gives `start()`, `open(deviceId)`, `peers`, `onChannel()` and `status`. Start it in an effect and call `stop()` in that effect's cleanup: nothing stops it for you on unmount, and a session another device opens is closed at once when nothing listens to `onChannel()`.

The page's Content-Security-Policy must allow the relay: add `connect-src wss://<Worker host>`. Without it the socket never opens, and after five tries `status.relayError` says so and retries slow to every five minutes. With the app open in several tabs, one tab holds the socket and the others report `elsewhere`.

## Calls per SDK

| SDK     | Entry                                                                                               | State   |
| ------- | --------------------------------------------------------------------------------------------------- | ------- |
| Node    | `client.cloudConnect`: `start()`, `stop()`, `peers()`, `open(deviceId)`, `devices()`, `onChannel()` | Shipped |
| Browser | `useCloudConnect()` in React; the relay is the only path                                            | Shipped |
| Python  | `client.cloud_connect`: `start()`, `stop()`, `peers()`, `open()`, `devices()`, `on_channel()`       | Shipped |
| Swift   | `client.cloudConnect`: `start()`, `stop()`, `peers()`, `open(deviceId)`, `devices()`, `onChannel()` | Shipped |
| Kotlin  | `client.cloudConnect`: `start()`, `stop()`, `peers`, `open(deviceId)`, `devices()`, `onChannel`     | Shipped |

`start()` brings up discovery and the relay; `open(deviceId)` returns a session that carries encrypted messages, over the local network when the other device is there and through the relay when it is not. Nothing starts on its own, and a sign-out stops it. On Android the local network path is planned: the SDK reports it `off` with reason `unsupported`, and the relay still works. The relay is used only when `relay` is on for the product and the person's quota allows it.

## Local network permission

On iOS, macOS and Android, finding devices on the local network needs the person's permission. When the system refuses, the SDK reports `nearby-permission-denied` ("Local network blocked") and the relay still works. Explain why before the system asks, and point the person to the system settings if they said no. [Use your devices together](/docs/help/nearby-devices/) is the Help page to link to.

## The relay and its quotas

The relay carries only ciphertext between a person's own devices, and only while the local network does not reach. It is not an open relay: each connection needs a one-minute ticket bought with the device's token, the relay stamps the sender, and only devices on the person's roster are admitted.

- A person's bytes per day: the `pkey.cloudConnect.relayBytes` entitlement.
- A product's bytes per month: the ceiling set in the console, at most 500 GiB.
- Two sockets per device and 32 per room. A message is at most 64 KiB.
- 200 messages a second per socket, with a burst of 400. The SDKs pace themselves under that and queue at most 8 MiB.
- A quota, the switch or a pause closes sockets within a minute. The local network is never metered.

## In the console

The **Cloud Connect** section has three pages.

- **Setup:** the relay switch and the monthly relay ceiling, with the platform default beside them.
- **Usage:** relay bytes and sessions per day.
- **Linked devices:** each person and their devices, with label, system, certificate expiry and last relay use. Removing a device is the existing device removal, linked from here.

## What you and Polaris Key can see

- **You** see rosters with labels and relay totals. Never message contents.
- **Polaris Key** stores two public keys per device, each person's roster and discovery key, and relay byte counts per product and day. It signs a certificate on each read and does not keep it.
- **Nobody** else sees contents: channels are end-to-end encrypted, and the relay forwards ciphertext. One residual: a compromised Worker could sign a certificate for a device it adds to an account, so channels between a person's own devices trust the Worker. Cloud Sync keys never cross such a channel. See [Privacy](/docs/reference/what-apps-collect/).
- On the local network, a nearby host can still see the device's host name, network address and that an app of this product is there.

## Next steps

- [The relay](/docs/features/cloud-connect/relay/): tickets, admission, quotas, pacing and what the relay sees.
- [Channels](/docs/features/cloud-connect/channels/): open a channel, send messages, handle close reasons and sign-out.
- [The peer protocol](/docs/reference/protocol/peer/): the certificate, roster, handshake and relay envelope, for implementers.
- [Sign-in](/docs/features/sign-in/): the account Cloud Connect links devices by.
- [Cloud Sync](/docs/features/cloud-sync/): keeps one person's settings and saves across devices.

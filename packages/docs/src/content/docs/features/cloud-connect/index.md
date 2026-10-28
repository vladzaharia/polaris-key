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

Cloud Connect is off by default and not available yet. The service row exists, so a product can turn it on, but it serves no route, issues no certificate and holds no data. The pieces arrive in later releases: device keys, certificates, local discovery, the relay, the SDK calls and the console pages.

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

## In the console

The **Cloud Connect** section has three pages: Setup (the relay switch and the monthly relay ceiling), Usage (relay data and sessions per day) and Linked devices (each person and their devices).

## Next steps

- [Sign-in](/docs/features/sign-in/): the account Cloud Connect links devices by.
- [Cloud Sync](/docs/features/cloud-sync/): keeps one person's settings and saves across devices.

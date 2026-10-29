---
title: "Nearby approval"
description: "Sign in a device with no browser by approving it from a signed-in device on the same network: the gates, what your app does, what the person sees and the limits."
type: "concept"
status: "shipped"
lastReviewed: "2026-10-28"
sidebar:
  order: 5
---

Nearby approval signs in a device that has no good way to sign in, such as a TV, a console or a headset. The person approves it with one tap on a phone or computer that is already signed in to your app, on the same network. There is no code to type, so there is nothing for someone else to read out.

SDK support is **planned** and no SDK ships it yet. This page describes the server, which is built and switched off.

## Compared with the device flow

The [device flow](/docs/features/sign-in/device-flow/) works anywhere: the person types a code on any other device. It is also the proof a bystander can talk someone into reading out. Nearby approval trades reach for safety: the two devices must be near each other, and the person compares two numbers instead of typing one.

Nearby approval is not a replacement. When it is off, when no signed-in device is nearby or when the person is elsewhere, the app falls back to the device flow.

## The gates

Two settings must both allow it, and Identity must be on.

| Gate                                  | Default | Who sets it       |
| ------------------------------------- | ------- | ----------------- |
| Product setting `identity.nearby`     | on      | you, per product  |
| Operator gate `launch.identityNearby` | off     | the platform team |

While either is off, the three nearby routes answer `404 not_found` and discovery leaves out the `nearby` member and the endpoints `nearbyStart`, `nearbyApprove` and `nearbyPoll`. An app reads discovery and starts at the regular sign-in when it finds none of them. You can switch the product setting off at any time; it widens nothing on its own.

## What your app does

The device that needs to sign in (D) and the signed-in device (M) both run your app.

1. D generates its keys and asks the Worker for a request. The Worker answers a request handle that lasts 300 seconds, and D polls every 3 seconds.
2. D finds M on the local network. The two devices run a short encrypted handshake over the local network and the request handle passes from D to M. It never goes through a person or a QR code.
3. Both screens show the same six-digit number. The person checks that they match.
4. On M, the person taps **Approve** or **Deny**. M tells the Worker.
5. D's next poll receives its credential, once. After that the same request answers `timeout`.

If the account has more than one license with a free seat, M asks which one to use before anything is written. With one, there is no extra tap.

D never holds a grant. The approval registers D's keys, binds one seat and mints a credential that D collects with its next poll. If the person has already agreed to the product's consent, D gets the same claims. Otherwise the tap is the consent and the audit trail says so.

## What the person sees

On D, a waiting screen with a number. On M, a banner that names the device and shows the same number. When the numbers match, one tap signs D in. After the tap, the account gets an email that names the device label, so a sign-in nobody expected is noticed. The person can remove the device from Polaris Locker.

A **Deny** is final for that request. The person starts again from D to try again.

## Limits

- **Same network.** The Worker compares the network address M and D reach it from. They must be on the same IPv4 address or the same IPv6 /64, or the approval is refused with `403 not_nearby` and the request stays open. Shared Wi-Fi in a hotel or office, a mobile network with carrier-grade NAT, and a VPN can put strangers behind one address, or split two nearby devices across two. The same-network check narrows who can approve; the number match and the person's tap are the real checks.
- **300 seconds.** A request expires after 300 seconds. An expired, decided or unknown request all answer `404 not_found`.
- **One tap, one decision.** The first approval or denial settles the request. Approvals are limited per device and per account, so a flood of prompts from other devices on the network is capped.
- **One at a time.** M shows one request at a time, with a short pause after a decision.
- **A seat.** If the license has no free seat, M answers `device_limit` and the request stays open. The person can free a seat and approve again.
- **Browsers.** Not available. A browser tab has no way to find devices on the local network, so the web has no nearby approval.

## SDK support

| SDK    | Status               |
| ------ | -------------------- |
| Swift  | planned              |
| Kotlin | planned              |
| Godot  | planned              |
| Node   | planned              |
| Python | planned              |
| React  | not applicable (web) |

Until an SDK ships it, an app on that SDK signs in with the [device flow](/docs/features/sign-in/device-flow/). The wire shapes are in the Worker's API reference, which is generated from the routes.

## What the person reads

The people-facing steps are in Help: [Approve a sign-in on another device](/docs/help/approve-a-sign-in/).

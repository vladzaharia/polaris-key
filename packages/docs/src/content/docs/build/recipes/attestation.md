---
title: "Attestation-gated products"
description: "What happens when a product's trust policy requires attested devices, and which SDKs attest today."
sidebar:
  order: 4
---

A product's [trust policy](/docs/services/core/device-trust/) can require an **attested** device
(a genuine App Store or Google Play install, proved with App Attest or Play Integrity) for
edge-mint, gated delivery or the commerce claim. With `enforce: true`, a `basic` device gets
`403 attestation_required` from those calls; without it, the refusal is only audited.

## Per SDK

| SDK                 | Attestation                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Godot               | `PolarisKey.devices.attest()` on iOS and Android, through the native plugins               |
| Swift               | App Attest primitives in `PolarisKeyPlatform`; the SDK does not call the attest routes yet |
| Kotlin              | Play Integrity in `:platform`; the SDK does not call the attest routes yet                 |
| Node, Python, React | not applicable: no store attestation exists on these runtimes (typed N/A)                  |

## Handling the refusal

- **On a runtime that attests** (Godot today), call `attest()` once and retry the refused call
  once. The planned shared rule (SDK parity pass §3.10) does this automatically.
- **Everywhere else**, show the refusal for what it is: this build is not a verified store
  install. Do not retry in a loop, and do not offer key entry as a workaround.
- **Rolling out**: turn the policy on without `enforce` first and watch the
  `device.trust.would_refuse` audit rows, so desktop and sideloaded players are never locked out
  by surprise.

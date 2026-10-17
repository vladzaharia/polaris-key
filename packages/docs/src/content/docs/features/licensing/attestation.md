---
title: "Require attested devices"
description: "Handle the refusal when a product's trust policy needs an attested device, per SDK."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 11
---

When a product's [trust policy](/docs/features/licensing/device-trust/) requires an attested device for edge-mint, gated delivery or the commerce claim, a basic device gets `403 attestation_required`. Without `enforce: true`, the refusal is only audited.

Requires the License feature, a trust policy set by a platform admin, and an SDK that can attest.

| SDK                 | Attestation                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| Swift               | App Attest on iOS; attests once and retries once on edge-mint and commerce claims |
| Kotlin              | Play Integrity on Android; attests once and retries once on the same calls        |
| Godot               | `PolarisKey.devices.attest()` on iOS and Android                                  |
| Node, Python, React | Not applicable: these runtimes have no store attestation                          |

## Steps

1. **Console** Set the trust policy without `enforce`. Watch the `device.trust.would_refuse` audit rows, so desktop and sideloaded players are never locked out by surprise.
2. **App** On Swift and Kotlin, do nothing for edge-mint and commerce claims: the SDK attests and retries once. On Godot, call `attest()` once after activation, then retry the refused call once.
3. **App** Everywhere else, show the refusal for what it is: this build isn't a verified store install. Don't retry in a loop, and don't offer key entry as a workaround. Node and Python results carry the kind `attestation-required`.
4. **Console** When the log shows no legitimate refusals, set `enforce: true`.

## Check it works

A TestFlight build on an iPhone and an internal-track Play build on a certified device reach `attested`: **Core → Activity** shows an "attested device" entry. A sideloaded build stays `basic` and the SDK reports `outlet`. With `enforce: true`, the sideloaded build gets `attestation_required`.

## If it isn't working

- [Troubleshoot licensing](/docs/features/licensing/troubleshooting/): `attestation_required` and `attestation_rejected`.
- [Device trust levels](/docs/features/licensing/device-trust/): owner setup for each platform.

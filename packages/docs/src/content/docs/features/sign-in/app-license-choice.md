---
title: "Let the app choose the license"
description: "The device flow's app mode: licenseChoice app on the start, the choose poll, the narrower device-code grant and the deviceChoice discovery gate."
type: "concept"
lastReviewed: "2026-10-31"
sidebar:
  order: 5
---

This extends the [device flow](/docs/features/sign-in/device-flow/). A start with `licenseChoice: "app"` moves the license choice from the card into the app. The card shows no license step. When a choice is due on the poll (a candidate license, `keep`, or no grantable license on a product that accepts keys), the poll answers once:

```json title="Poll answer"
{ "status": "choose", "grant": "sg_...", "expiresIn": 300, "choices": {} }
```

The flow is spent at that answer, so a later poll is `timeout`. The SDK stops polling and finishes with the sign-in grant, as it does after a redirect sign-in. `choices` is the license-choice view. The refusals, `confirm` and the account claim all run before `choose`. If no choice is due, the poll binds the device as `ready` and never mints a second license. A store failure while the grant is issued is the usual `503`, and the flow stays.

The grant is the same grant the browser flow issues, bound to the product, the account, the subject and the flow's device id, and it carries `via: "device"`. It never carries `fresh`. Because the user code is public, a device-code grant is narrower than a redirect grant: `choice/devices` answers `404 not_found`, `replaceDeviceId` answers `409 license_choice_required`, and the view's `replace` is `null` (`freeDeviceUrl` stays). `keep` still needs the device's own token in `Authorization: Bearer`. The person's approval page is the consent, and it names the account binding and the app. Every approved app-mode sign-in also sends a security notice to the account's verified addresses, with **Sign out everywhere**.

Without `licenseChoice: "app"` the start behaves as it did before: the choice stays on the card and the poll mints on the identity's own license.

## `deviceChoice` in discovery

The identity fragment of discovery carries `"deviceChoice": true` when the Worker serves the `choose` poll, and only while License is on. An SDK sends `licenseChoice: "app"` only when `deviceChoice` is present and the four `choice*` endpoints are present. It may always send `loginHint`, `nameHint` and `purpose`. The web UI kits use the same test to pick where **Add your name and email** and **Sign in to that account** go: in the page over the device-code channel when `deviceChoice` is present, otherwise to the Polaris Locker card.

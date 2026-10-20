---
title: "Handle the device limit"
description: "Show the right screen when activation is refused at the device limit, and offer the ways a user frees a seat."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 10
---

A license allows a number of devices at once. Activating one more is refused with `403 device_limit`, and the body carries `limit` and `deviceCount` when the server knows them. Every SDK returns the refusal as a typed result, never an exception.

Requires the License feature and an SDK that activates keys.

| SDK                  | Result                                                             |
| -------------------- | ------------------------------------------------------------------ |
| Node                 | `{ kind: "device-limit", code, limit?, deviceCount?, manageUrl? }` |
| Python               | `ActivationDeviceLimit`                                            |
| Swift, Kotlin, Godot | The device-limit case of the activation result                     |

A device stopped at the limit holds no token, so it can't list or deauthorize anything itself. The user frees a seat from somewhere else.

## Steps

1. **App** Catch the device-limit result and show the limit and the count when they are present. Both can be missing.
2. **App** Offer the Polaris Locker link. `manageUrl` is the Polaris Locker link that frees a seat. The server sends it only while the product's Polaris Locker is on, and it never carries a key, an account id or a device id. In Node, `withManageReturn` adds your app's return link and `withManageKey` adds the key for an activate link. Offer it behind a user action such as **Replace a device**. The refusal isn't an auth failure, so keep the app's state.
3. **App** Tell the user the other way to free a seat: from another activated device, in that app's devices screen. Node and Python expose `client.devices.list()` and `client.devices.deauthorize(id)`. The UI kits ship a devices screen.
4. **App** Retry activation on this device once the user says a seat is free.

When the license is in no account and Identity is on, an activation can also be refused with `key_entry_limit`, which points at the same Polaris Locker link to add the key to an account. See [Activation](/docs/features/licensing/activation/).

## Check it works

Run `pkey dev` and activate the test key `device-limit-full`. The SDK returns the device-limit result ([Run Polaris Key locally](/docs/build/local/)). Free a seat in the dev run, then retry.

## If it isn't working

- [Troubleshoot licensing](/docs/features/licensing/troubleshooting/): `device_limit` and its neighbours.
- [The license model](/docs/features/licensing/model/): how seats are counted and when a dormant one frees.
- [Device limit component](/docs/build/ui/components/device-limit/): the kit's screen.

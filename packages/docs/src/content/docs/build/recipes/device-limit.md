---
title: "Device-limit recovery"
description: "What to show when activation is refused at the device limit, and the two ways a user frees a seat."
sidebar:
  order: 1
---

A licence allows a number of devices at once. Activating one more is refused with
`403 device_limit`, and the body carries `limit` and `deviceCount` when the server knows them.
Every SDK returns this as a typed result, never an exception:

| SDK                  | Result                                                                     |
| -------------------- | -------------------------------------------------------------------------- |
| Node                 | `{ kind: "device-limit", limit?, deviceCount? }`                           |
| Python               | `ActivationDeviceLimit` (`kind == "device-limit"`, `limit`, `deviceCount`) |
| Swift, Kotlin, Godot | the device-limit case of the activation result                             |

## What the device cannot do

A device stopped at the limit holds **no token**, so it cannot list or deauthorize anything
itself. Tell the user where a seat can be freed instead:

1. **From another activated device**: in that app's device list (`client.devices.list()` and
   `client.devices.deauthorize(id)` in Node and Python; the devices screen of the UI kits).
2. **From the [customer portal](/docs/users/portal/)**, for a machine that is gone or
   unreachable. The user signs in with the account that owns the licence and disconnects it there
   ([Devices](/docs/users/devices/)).

Then let the user retry activation on this device.

```ts
const r = await client.license.activateWithKey(key);
if (r.kind === "device-limit") {
  showSeatFull({
    limit: r.limit, // may be undefined
    inUse: r.deviceCount, // may be undefined
    // Point at the portal; a built "Manage devices" link waits on portal links (see below).
  });
}
```

## Known gaps

- **Refusals mislabelled as device-limit.** Node, Python, Swift and Kotlin currently map some
  other `403` refusals (`enroll_claimed`, `license_disabled`, `attestation_required`) to the
  device-limit result or to a raw body. Until the typed activation results ship (SDK parity pass
  §3.1), do not promise a seat problem from that result alone; Godot already keeps the codes apart.
- **No built link yet.** A "Manage devices" button that opens the portal on the right licence
  needs `portal.links` (proposed) or the server's `manageUrl` (planned). Link the portal's home
  until then.

---
title: "Devices"
description: "What counts as a device, seat limits, and renaming or disconnecting one from the app or the portal."
sidebar:
  order: 4
---

A **device** is one authorized install of the product on one machine. Activating — any of the
four ways described in [Activation](/docs/users/activation/) — creates one; from then on, that's
what the app uses to prove it's allowed to run without asking you to activate again.

## Seat limits

Your license allows a certain number of devices to be active at once — its device limit, shown
alongside the rest of what the license includes. Activating one more device than that allows is
refused until a seat frees up, either by disconnecting a device you no longer use or by an old,
unused device dropping off on its own after a few months of inactivity. See
[Seat pools and deviceLimit](/docs/services/license/model/#seat-pools-and-devicelimit) for
exactly how the count is worked out.

## If your plan changes

Moving a license to a plan with a smaller device limit than the number of devices already
running on it doesn't disconnect anything — every device already active keeps working exactly
as before. What changes is forward-looking only: activating a **new** device is refused until
the count drops back under the new limit.

## Renaming a device

From inside the app itself — wherever it lists your devices, usually somewhere in settings —
give a device a label of your choosing, like "Sam's laptop", so it's easy to tell apart from any
others on the same license. Renaming isn't available from the customer portal; do it from the
app running on that device.

## Disconnecting a device

Two ways to do this, and which one you need depends on the situation:

- **From the app**, on the device you're currently using — the everyday way to free a seat you
  no longer need.
- **From the [customer portal](/docs/users/portal/)**, for any device on a license you own — the
  way to go when the machine itself is gone, sold, wiped, or otherwise unreachable and you can't
  open the app on it to disconnect it yourself.

## What disconnecting deletes

Disconnecting a device is permanent, not a pause. Its hardware fingerprint and the software
details it last reported are deleted along with it — not just marked inactive — because that
information only ever existed to describe that one machine. See
[Fingerprints](/docs/services/core/fingerprints/) and
[The device principal](/docs/services/core/device-principal/) for exactly what's stored while a
device is connected. A disconnected device can't be reconnected; if you plan to use it again,
activate it like a new one.

:::note[Browser-only products]
If a product runs entirely in the browser, there may be no separate app to manage devices from —
the portal is the only place to do it, when the product offers one.
:::

---
title: "Pairing"
description: "Pair two people's devices once, in person, so their apps can reach each other later. The API per SDK, the gates, the limits and what a pending pairing does."
type: "reference"
lastReviewed: "2026-11-01"
sidebar:
  order: 5
---

Pairing connects a device of one person to a device of another, across two accounts. The two people sit on the same network, both open pairing in the app, and each screen shows the same six-digit code. They compare the codes and each confirms. After that the two devices are **paired**: they can open a [Cloud Connect channel](/docs/features/cloud-connect/channels/) to each other on the local network or through the relay, without pairing again. End users see it as **Pair with Someone Nearby**.

Pairing never merges accounts or moves licenses. The pairing is a secret and a key on each device, not a record the Worker holds. Either person can remove it at any time.

## Gates

Pairing is the developer's opt-in, off by default. All three must hold:

- the platform setting `launch.connectLinks` is on;
- the product enables Cloud Connect;
- the product's `interAccount` setting is on (`connect: { interAccount: true }` in `.pkey/product`; see [Cloud Connect settings](/docs/build/manifest/product/#cloud-connect-settings-connect)).

The SDK reads the answer from discovery (`services.connect.interAccount`) and caches it for 24 hours after the last successful read. A read that fails or says off clears it, and the SDK reads again when it lapses. While it is off or not yet read, `pair` and `open` throw `connect_links_disabled`, the device advertises no pairing and answers none, and the relay refuses a contact ticket with the same code. When a refresh turns it off, open sessions with paired devices end.

## Calls per SDK

| SDK    | Entry                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Node   | `client.cloudConnect.links`: `pair(options)`, `list()`, `remove(id)`, `setReachable(id, on)`, `open(id)`, `onLink(fn)`        |
| Python | `client.cloud_connect.links`: `pair()`, `list()`, `remove(id)`, `set_reachable(id, on)`, `open(id)`, `on_link(fn)`            |
| Swift  | `client.cloudConnect.links`: `pair`, `list`, `remove`, `setReachable`, `open`, `onLink`                                       |
| Kotlin | `client.cloudConnect.links`: `pair`, `list`, `remove`, `setReachable`, `open`, `onLink`                                       |
| Godot  | `PolarisKey.cloud_connect.links`: `pair(options)`, `list()`, `remove(id)`, `set_reachable(id, on)`, `open(id)`, `link` signal |

`interAccount()` (`inter_account()` in Python and Godot) returns the cached gate answer. The registry is `conformance/parity/api.json`.

## Pair

Start `cloudConnect` first. Both people open the pairing window; it closes by itself after `seconds` (at most 300) and once a pairing is made. Pairing runs on the local network only.

`categories` is the list of data categories your app asks both people to approve (at most 8, each `a-z`, `0-9` and `-`, 1 to 32 characters). Show it next to the code, so each person sees what they approve before confirming. The pairing keeps the categories both sides listed. A [Direct Transfer](/docs/features/cloud-connect/transfer/) to a paired device is refused outside them.

```ts
const pairing = await client.cloudConnect.links.pair({
  categories: ["saves", "photos"],
  label: "Ana's laptop",
  seconds: 120,
  onCode: (offer) => {
    // Show offer.code and offer.categories, then let the person choose.
    console.log(offer.label ?? "A device", offer.code, offer.categories);
    void offer.confirm();
  },
  onLinked: (paired) => {
    console.log("paired", paired.id, paired.categories, paired.rePair);
  },
  onFailed: (f) => {
    console.log("not paired", f.reason);
  },
});

// Close the window early.
await pairing.stop();
```

```python
def on_code(offer):
    print(offer.label or "A device", offer.code, offer.categories)
    offer.confirm()

pairing = client.cloud_connect.links.pair(
    categories=["saves", "photos"],
    label="Ana's laptop",
    seconds=120,
    on_code=on_code,
    on_linked=lambda paired: print("paired", paired.id, paired.categories),
    on_failed=lambda f: print("not paired", f.reason),
)

pairing.stop()
```

`label` names this device to the other person; use the device or the person, never an account identifier. The offer's `label` and `platform` come from the other device and nothing has authenticated them: show them as reported by the device. Nothing is stored until both people confirm. A decline, a timeout or a closed session stores nothing on either side. `onFailed` reports `declined`, `timeout`, `full` (at the limit) or `closed`.

## Use a pairing

```ts
const [paired] = await client.cloudConnect.links.list();

// Advertise it on the local network and keep a relay room for it.
await client.cloudConnect.links.setReachable(paired.id, true);

const off = client.cloudConnect.links.onLink((session) => {
  console.log("a paired device connected", session.contact?.id);
});

// Open a session: local network first, then the relay.
const session = await client.cloudConnect.links.open(paired.id);

// Remove the pairing.
await client.cloudConnect.links.remove(paired.id);
off();
```

```python
paired = client.cloud_connect.links.list()[0]
client.cloud_connect.links.set_reachable(paired.id, True)
off = client.cloud_connect.links.on_link(lambda s: print("a paired device connected"))
session = client.cloud_connect.links.open(paired.id)
client.cloud_connect.links.remove(paired.id)
off()
```

`list()` returns each pairing's `id`, `label`, `categories`, `createdAt`, `reachable` and `rePairPending`. The id names the pairing on this device only, and neither the secret nor the other device's key is in it. `open` tries the local network, then the contact relay unless the host turned the relay off. `setReachable` makes a pairing findable by the other device (at most 8 at once). `remove` returns false when the id names no pairing.

To send a file to a paired device, pass its id to `transfer.send`; see [Direct Transfer](/docs/features/cloud-connect/transfer/). The receiving person still decides each transfer.

## Pending pairings

Pairing again with a device you are already paired with does not replace the pairing at once. The new pairing is held as pending next to the current one, and replaces it only when the first connection under the new pairing proves the other device's key. Only the pairing whose secret made that connection is promoted.

- A pending pairing not used within 24 hours is dropped. A running app may still try it for up to 15 minutes after that, until its next refresh.
- Each device key has one pending pairing. A later confirmed pairing that claims the same device key replaces the earlier pending one within those 24 hours.
- A pairing that claims someone else's key never connects, but it takes a slot (up to 8 pending, 64 paired).
- `open` tries a pending pairing before the current one. `rePairPending` in `list()` says one is waiting.

## Remove and turn off

Removing a pairing ends its live sessions and any connection still being set up, and deletes its partial transfers. The other device finds the pairing no longer reachable. Turning pairing off (the gate lapsing or a refresh saying off) ends every pairing's sessions and connections the same way, but keeps the partial transfers.

## Limits

| Limit                          | Value                           |
| ------------------------------ | ------------------------------- |
| Paired devices per device      | 64                              |
| Pending pairings               | 8                               |
| Categories per pairing request | 8                               |
| Pairing window                 | 300 seconds                     |
| Reachable at once              | 8                               |
| Contact tickets per device     | 30 an hour (`429 rate_limited`) |
| Cached gate answer             | 24 hours                        |

## What you and Polaris Key can see

You see nothing of a pairing. Polaris Key does not hold its secret or keys. Through the relay it sees that two accounts met in a room, and when. Contents are encrypted end to end. See [Privacy](/docs/reference/what-apps-collect/).

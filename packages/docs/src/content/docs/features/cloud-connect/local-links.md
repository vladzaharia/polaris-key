---
title: "Local Links"
description: "Pair two devices with no account, by an eight-digit code or a QR on the same network. When to use it instead of a pairing, the gates, the calls per SDK, the limits and what the person sees."
type: "reference"
lastReviewed: "2026-11-10"
sidebar:
  order: 6
---

A **local link** joins two devices that share a network and have no account. One device shows an eight-digit code and a QR; the person types or scans it on the other. Both people then confirm, and each device stores the link. End users see it as **Pair with a Code**.

Nothing crosses the Worker: Polaris Key keeps no record of a local link, and the only server state is the product switch. The link is a secret and a key on each device. Either person can forget it at any time.

## Local links or pairings

|                | Local link                                              | [Pairing](/docs/features/cloud-connect/pairing/)      |
| -------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Needs sign-in  | No                                                      | Yes, on both devices                                  |
| People compare | Nobody compares: one device shows, the other types      | Both screens show the same six digits                 |
| Reaches        | The local network only; the relay is never used         | The local network, then the relay                     |
| Gate           | `cloudConnect.localPairing`                             | `cloudConnect.interAccount`                           |
| Use it when    | The app has no accounts, or the two people are together | The two people want to reach each other from anywhere |

A local link is access on one network and nothing more. A device away from that network is "Nearby only", never reachable, and no code ever works from outside it.

## Turn it on

Two switches must both be on, and the product must enable Cloud Connect.

- The operator's platform gate `launch.localPairing` (off by default; see [Settings](/docs/reference/settings/)).
- Your product's own `connect.localPairing` in `.pkey/product`, which is also the console setting `cloudConnect.localPairing`. Changing it in the console needs a reason.

```yaml title=".pkey/product"
modules:
  identity: { enabled: true }
  connect: { enabled: true }
connect:
  localPairing: true
```

The SDK reads the answer from discovery (`services.connect.localPairing`) and caches it for 24 hours. While it is off, or not yet read, `pair`, `join` and `open` throw the typed N/A `local-pairing-off`, the device advertises nothing and answers nothing. Hide the screen when `localPairing()` is false. `list`, `rename`, `remove` and `setReachable` still work with the gate off, so a person can always see and forget their links.

Start `cloudConnect` first: a window and an `open` need its local network service.

## Calls per SDK

| SDK    | Entry                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `client.cloudConnect.localLinks`: `localPairing()`, `pair(options)`, `join(options)`, `dialsLeft(text)`, `list()`, `rename(id, label)`, `remove(id)`, `setReachable(id, on)`, `open(id)`, `onLink(fn)`, `onChange(fn)` |
| Python | `client.cloud_connect.local_links`: `local_pairing()`, `pair()`, `join()`, `dials_left(text)`, `list()`, `rename()`, `remove()`, `set_reachable()`, `open()`, `on_link()`, `on_change()`                               |
| Swift  | `client.cloudConnect.localLinks`: the Node names, `async throws` where they wait; options are `LocalPairOptions` and `LocalJoinOptions`                                                                                |
| Kotlin | `client.cloudConnect.localLinks`: the Node names as `suspend` functions; options are `LocalPairOptions` and `LocalJoinOptions`                                                                                         |

The registry is `conformance/parity/api.json`. Godot follows with the Godot kit.

## Show a code

`pair` opens a window: the device advertises itself, shows a code and waits. Each window lasts at most 300 seconds. `onCode` gets the first code and a new one after every failed guess; `onConfirm` gets the other device once it has typed the right code, so you can show who it is and what it asks, then call `confirm()` or `decline()`.

`categories` is the list of data categories your app asks both people to approve, as for a [pairing](/docs/features/cloud-connect/pairing/#pair). `label` names this device to the other person; the other device's `label` and `platform` are as it reported them and nothing has authenticated them, so show them that way.

```ts
const pairing = await client.cloudConnect.localLinks.pair({
  categories: ["saves"],
  label: "Ana's laptop",
  onCode: (c) => {
    // Show c.code and c.qr; c.expiresAt is when the window closes (Unix seconds).
    console.log(c.code, c.reason, c.expiresAt);
  },
  onConfirm: (offer) => {
    console.log(offer.label ?? "A device", offer.categories);
    void offer.confirm();
  },
  onLinked: (link) => console.log("paired", link.id, link.categories),
  onFailed: (f) => console.log("not paired", f.reason),
  onInterrupted: (n) => {
    if (n >= 3) console.log("Something on this network keeps interrupting.");
  },
  onEnd: (e) => console.log("window closed", e.reason),
});
```

```python
def on_confirm(offer):
    print(offer.label or "A device", offer.categories)
    offer.confirm()

pairing = client.cloud_connect.local_links.pair(
    categories=["saves"],
    label="Ana's laptop",
    on_code=lambda c: print(c.code, c.reason, c.expires_at),
    on_confirm=on_confirm,
    on_linked=lambda link: print("paired", link.id, link.categories),
    on_failed=lambda f: print("not paired", f.reason),
    on_interrupted=lambda n: print("interrupted", n),
    on_end=lambda e: print("window closed", e.reason),
)
```

The code's `reason` says why it is on screen: `opened` (the window's first code), `wrong-code` (a guess failed), or `declined`, `timeout` or `closed` (a pairing ended with no link). It is for display. `failures` counts the guesses so far in this window (0 to 4); never show it as "tries left", because that is the joiner's number (below). `onEnd` says once why the window ended, after its advert is gone: `expired`, `too-many-tries`, `stored`, `person` (you called `stop()`) or `off` (the gate went off). `onFailed` reports `declined`, `timeout`, `full` (this device is at the limit), `too-many-tries` and `closed`.

`onInterrupted(n)` counts connections that closed without counting a guess, since the code last changed: something on the network is busy or hostile. It never rotates the code. A count of 3 or more is the time to say "Pairing is being blocked, try another network".

### Show a new code

After `onEnd` (or a window that has gone stale), call `renew()` on the same handle. It closes the window and opens a new one: a new code and QR, a new nameplate, 300 seconds and no failures.

```ts
// pairing is the handle pair() returned.
const pairing = await client.cloudConnect.localLinks.pair({
  categories: ["saves"],
  onCode: (c) => console.log(c.code),
  onConfirm: (offer) => void offer.confirm(),
});

const next = await pairing.renew();
console.log(next.code);

// Close the window for good.
await pairing.stop();
```

```python
# pairing is the handle pair() returned.
pairing = client.cloud_connect.local_links.pair(
    categories=["saves"], on_code=print, on_confirm=lambda o: o.confirm()
)
nxt = pairing.renew()
print(nxt.code)

pairing.stop()
```

Renew from a person's action ("Show a new code"). Never renew from `onEnd`, `onFailed` or `onCode` without one: an app that renews by itself keeps a window open for anyone who walks by to guess at. The SDK enforces a floor anyway:

- After a window ended `too-many-tries`, a new window is refused for 30 seconds.
- After the second window within 10 minutes that ended after a failed guess, the same 30 seconds.

A refused `renew()` or `pair()` throws `peer-closed` with `reason` `cooldown`; show the wait, do not retry in a loop. The floor is per product and per process: a new client does not reset it.

In Python, callbacks run on the Connect thread, where `renew()` and every other blocking call refuse with a runtime error. From a button handler on your own thread it works; on the async client, `await handle.renew()`.

## Join with a code

`join` is the other device. Give exactly one of `code` (the digits typed; spaces and hyphens are ignored) or `qr` (the text the scanner read). It browses for up to 15 seconds, dials, waits for both people to confirm and resolves with the stored link.

```ts
const controller = new AbortController();

const left = client.cloudConnect.localLinks.dialsLeft("4812");
if (left === 0) {
  console.log("Ask the other device for a new code.");
} else {
  try {
    const link = await client.cloudConnect.localLinks.join({
      code: "4812 3456",
      categories: ["saves"],
      signal: controller.signal,
      onConfirm: (offer) => {
        console.log(offer.label ?? "A device", offer.categories);
        void offer.confirm();
      },
    });
    console.log("paired", link.id);
  } catch (e) {
    const err = e as { code?: string; reason?: string; cap?: string };
    console.log(err.code, err.reason ?? err.cap);
  }
}

// Cancel a join in progress.
controller.abort();
```

```python
import threading

cancel = threading.Event()

left = client.cloud_connect.local_links.dials_left("4812")
if left != 0:
    try:
        link = client.cloud_connect.local_links.join(
            code="4812 3456",
            categories=["saves"],
            cancel=cancel,
            on_confirm=lambda offer: offer.confirm(),
        )
        print("paired", link.id)
    except Exception as e:
        print(getattr(e, "code", None), getattr(e, "reason", None))

# From another thread: cancel a join in progress.
cancel.set()
```

A failed join throws a `LocalPairingError` (an error with a `code`, a `reason` and, for the limits, a `cap`). The reason is for display; it never holds a digit.

| Code                  | Reason                                         | Means                                                                  |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `pairing-code-failed` | `invalid`                                      | The code is not eight digits, or the QR is not a code.                 |
| `pairing-code-failed` | `other-app`                                    | The QR is another app's.                                               |
| `pairing-code-failed` | `wrong`                                        | The other device answered and the code did not match.                  |
| `pairing-code-failed` | `spent`                                        | The dials for this code's first two digits are used up (see below).    |
| `pairing-not-found`   | none                                           | No device showing this code answered within 15 seconds.                |
| `peer-closed`         | `declined`, `timeout`, `closed` or `cancelled` | The pairing ended after the other device answered; `cancelled` is you. |
| `local-links-full`    | `cap`: `stored`                                | This device holds 32 links already.                                    |
| `local-pairing-off`   | none                                           | The gate is off; nothing was browsed.                                  |

Canceling stops the browse and closes the dial. It gives no dial back. Swift and Kotlin cancel through the task or the coroutine and throw the platform's cancellation error, not `peer-closed`.

### The dial budget

A code's first two digits are public: they are in the advert. A joiner gets **two dials** for each of those prefixes in 300 seconds, however many codes it types. `dialsLeft(text)` answers `2`, `1` or `0` from those two digits alone, and `null` while fewer than two digits are typed or for anything that is not a string. It reads no more than the two digits, keeps nothing and spends nothing, so call it as the person types.

- After a `wrong` reason, keep the first two digits, clear the rest and say "1 try left" when `dialsLeft` is 1.
- At 0, or after `spent`, the person asks the other device for a new code. A new code has a new prefix.
- The budget is in memory, per product and per process. Restarting the app does not give it back to an attacker's host, and you cannot reset it.

## Manage links

```ts
const [link] = await client.cloudConnect.localLinks.list();
// link.id, link.label, link.categories, link.createdAt, link.lastSeen, link.reachable, link.platform

await client.cloudConnect.localLinks.rename(link.id, "Ana's phone");
await client.cloudConnect.localLinks.setReachable(link.id, true);
await client.cloudConnect.localLinks.remove(link.id);

const off = client.cloudConnect.localLinks.onChange(() => {
  void client.cloudConnect.localLinks
    .list()
    .then((rows) => console.log(rows.length));
});
off();
```

```python
link = client.cloud_connect.local_links.list()[0]
client.cloud_connect.local_links.rename(link.id, "Ana's phone")
client.cloud_connect.local_links.set_reachable(link.id, True)
client.cloud_connect.local_links.remove(link.id)

off = client.cloud_connect.local_links.on_change(lambda: print("links changed"))
off()
```

`list()` returns each link's `id` (this device only: no key or secret is in it), `label`, `categories`, `createdAt`, `lastSeen`, `reachable` and `platform`. `platform` is the other device's report of itself, one of the `Platform` values or null; show it as a glyph and never decide on it. `onChange` carries no payload: it fires after a pairing is stored, a rename, a removal, a reachable switch, the gate flipping and a link being seen, so re-read `list()` and `localPairing()`.

`setReachable` makes a link findable on the network, on by default for a new link. At most 8 links are reachable at once, and a ninth is refused with `local-links-full` and `cap` `reachable`. `remove` returns false for an id that names no link; the other device finds the link "Not reachable". Removing a link ends its live sessions and its partial transfers.

## Open a session and send

`open(id)` finds the link's other device by its advert and connects over the local network; the relay is never used. It throws `unknown_peer` for an id that is no link or a device not seen on this network, and `peer_cert_invalid` when the other device has forgotten the link. A dial that failed is not repeated at once. The session is adopted by [Direct Transfer](/docs/features/cloud-connect/transfer/): pass the link's id to `transfer.send`, and the receiver still decides each transfer.

```ts
const [link] = await client.cloudConnect.localLinks.list();

const off = client.cloudConnect.localLinks.onLink((session) => {
  console.log("a linked device connected", session.local?.id);
});

const session = await client.cloudConnect.localLinks.open(link.id);

await client.cloudConnect.transfer.send(link.id, "/home/me/report.pdf", {
  name: "report.pdf",
  category: "saves",
});
off();
```

```python
link = client.cloud_connect.local_links.list()[0]
off = client.cloud_connect.local_links.on_link(lambda s: print("a linked device connected"))
session = client.cloud_connect.local_links.open(link.id)

handle = client.cloud_connect.transfer.send(link.id, "/home/me/report.pdf", name="report.pdf", cat="saves")
print(handle.wait(timeout=600).outcome)
off()
```

A transfer outside the categories both people approved is refused.

## Limits

| Limit                       | Value                                     |
| --------------------------- | ----------------------------------------- |
| Links stored per product    | 32                                        |
| Reachable at once           | 8                                         |
| Categories per link         | 8                                         |
| Window                      | 300 seconds, one open window per product  |
| Wrong guesses per window    | 5; the fifth closes it (`too-many-tries`) |
| Dials per code prefix       | 2 in 300 seconds                          |
| Wait after `too-many-tries` | 30 seconds                                |
| Browse for a code           | 15 seconds                                |
| Cached gate answer          | 24 hours                                  |

## What the person sees

Pair with the screens, not your own copy, where a [kit](/docs/build/ui/components/) has them. The words below are the ones the screens use.

- **Show:** the code as `4812 3456`, the QR, a time ring running to `expiresAt`, and "Enter this code on the other device." A wrong guess changes the code and says "Wrong code entered. The code changed."; there is no count of guesses.
- **Enter:** "Enter the code from the other device." After a wrong code the first two digits stay and the rest clear.
- **Confirm:** "Pair with {label}?" and what it shares, then "Pair" or "Not now". Nothing is stored until both people agree.
- **Paired:** "Paired".
- **Failed:** "That code didn't work. Check it and try again.", "Can't find the other device. Check you're both on the same network.", "Too many tries. Show a new code.", "This device has no room for another pairing." or "Pairing with a code is off for this app."

[Pair with a Code](/docs/help/pair-with-a-code/) is the Help page to link to.

On iOS, macOS and Android, finding devices on the local network needs the person's permission; see [Local network permission](/docs/features/cloud-connect/#local-network-permission). A screen that scans the QR needs the camera: your app declares `NSCameraUsageDescription` itself.

## Swift and Kotlin

The calls are the Node names. Swift: `pair(_:)`, `join(_:)`, `list()`, `rename(_:_:)`, `remove(_:)`, `setReachable(_:_:)`, `open(_:)`, `dialsLeft(_:)` and `onChange(_:)` on `client.cloudConnect.localLinks`, with `LocalPairOptions` and `LocalJoinOptions`; `renew()` and `stop()` are on the returned `LocalPairHandle`. A reason is a `Reason` enum (`LocalCode.Reason`, `LocalPairEnd.Reason`, with `.wrongCode` and `.tooManyTries`). Kotlin: the same as suspend functions on the local links object; reasons on the pairing exception are the wire strings, and `LocalCodeReason` and `LocalWindowEnd` are enums with `.wire`. On Android, pairing needs Android 14 or later and throws the typed unsupported answer before that.

## What you and Polaris Key can see

You see nothing of a local link: no code, secret or key. Polaris Key sees nothing at all. The network sees the advert (your product's tag and the two public digits) for up to 300 seconds, and the rotating link names after that. See [Privacy](/docs/reference/what-apps-collect/).

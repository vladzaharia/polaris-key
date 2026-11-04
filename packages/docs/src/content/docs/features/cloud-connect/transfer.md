---
title: "Direct Transfer"
description: "Send a file from one device to another over a Cloud Connect channel. The person decides on every transfer; hashes are checked before anything is delivered, and an interrupted transfer resumes."
type: "reference"
lastReviewed: "2026-11-01"
sidebar:
  order: 4
---

Direct Transfer sends a file, or a stream of bytes, from one device to another over an open [Cloud Connect channel](/docs/features/cloud-connect/channels/). It uses the local network when the other device is there and the relay when it is not. It works between a person's own devices and, once two people have linked, between those links. The Worker sees none of it.

## Consent per transfer

Every offer goes to your `onOffer` handler, which decides that one transfer. There is no default accept. With no handler, or a handler that throws or names a destination that cannot be used, the SDK declines. An earlier accept covers no other transfer, and a resumed transfer asks again.

The handler gets the sender's label, the file's `name`, `type`, `size` and the data category. All of it is display data from the other device. The SDK never builds a path from `name`. Where the file goes is your choice: the destination you name in the answer.

The [TransferOffer](/docs/build/ui/components/transfer-offer/) screen asks the person and answers for you.

You can answer later: keep the offer, ask the person, and answer within 120 seconds. After that the SDK declines for you. The sender sees `declined`, or `timeout` when nobody answered.

## Receive

Decide each offer and name the destination. The content reaches it only after the SDK has checked the SHA-256 of every byte, and then as a whole file.

```ts
import { createInterface } from "node:readline/promises";
import { join } from "node:path";

const downloadsDir = "/home/me/Downloads";
const rl = createInterface({ input: process.stdin, output: process.stdout });

const off = client.cloudConnect.transfer.onOffer(async (offer) => {
  const who = offer.from.label ?? "A device";
  const reply = await rl.question(
    `${who} wants to send you ${offer.name ?? "a file"} (${offer.size} bytes). Accept? [y/N] `,
  );
  if (reply.trim().toLowerCase() !== "y") return "decline";
  return { saveTo: join(downloadsDir, "incoming.bin") };
});

client.cloudConnect.transfer.onResult((e) => {
  console.log(e.direction, e.id, e.outcome, e.reason ?? "");
});
```

In Python the handler returns `Accept(dest)`, or `None` to answer later with `offer.accept(dest)` or `offer.decline()`.

```python
from polaris_key.connect.transfer import Accept

def on_offer(offer):
    print("offer", offer.name, offer.size)
    return Accept("/home/me/Downloads/incoming.bin")

off = client.cloud_connect.transfer.on_offer(on_offer)

def on_result(r):
    print(r.direction, r.id, r.outcome, r.reason)

client.cloud_connect.transfer.on_result(on_result)
```

An existing file at the destination is kept and the offer is declined, unless you allow overwriting (`overwrite: true` in Node, `Accept(dest, overwrite=True)` in Python). The destination folder must exist.

## Send

`send` takes the other device (its id from `devices()`, a link, or a session you already hold) and a source: a file path, bytes or a stream. A stream is written to a temporary file and hashed first, because the offer carries the hash before the first byte. It resolves when the other device has verified and delivered the content.

```ts
const [device] = await client.cloudConnect.devices();
const controller = new AbortController();

try {
  const sent = await client.cloudConnect.transfer.send(
    device.deviceId,
    "/home/me/report.pdf",
    {
      name: "report.pdf",
      type: "application/pdf",
      signal: controller.signal,
    },
  );
  console.log("delivered", sent.id, sent.size);
} catch (e) {
  console.log((e as { code?: string; reason?: string }).reason ?? e);
}
```

```python
handle = client.cloud_connect.transfer.send(
    device_id, "/home/me/report.pdf", name="report.pdf", type="application/pdf"
)
result = handle.wait(timeout=600)
print(result.outcome, result.reason)
```

Python returns a handle at once; `wait()` gives the result and `result.raise_for_status()` raises unless the content was delivered. `name` and `type` are display data for the receiver; `name` is cut to 255 bytes. Toward a link, set the data category (`category`, `cat` in Python): a link refuses an offer outside the categories both people approved.

## Cancel

Either side can cancel at any time. Aborting the `signal` (Node), calling `handle.cancel()` (Python, Kotlin) or `transfer.cancel(id)` (every SDK) ends the transfer; the other side sees `cancelled`. A receiver that cancels deletes its partial file. Nothing unverified is ever delivered.

## Resume

When a session drops, the receiver keeps what it has for 24 hours. Send again with the same `id` and the same content, and the receiver answers with the offset it has re-read and re-hashed, then the sender carries on from there. The receiver still asks the person, because consent is per transfer. A source that cannot restart at that offset (a stream that cannot seek) cannot resume.

```ts
const [device] = await client.cloudConnect.devices();
let id = "";
await client.cloudConnect.transfer
  .send(device.deviceId, "/home/me/big.iso", {
    onStart: (t) => (id = t.id),
  })
  .catch(() => undefined);
// Later, once the session is back:
await client.cloudConnect.transfer.send(device.deviceId, "/home/me/big.iso", {
  id,
});
```

A hash that does not match never resumes: the partial is deleted and the next try starts at 0.

## Limits

| Limit                   | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Store quota             | 4 GiB of partial files by default, and 256 MiB of disk always left free      |
| Partial files per peer  | 8; the oldest goes first                                                     |
| Partial file lifetime   | 24 hours from its last write                                                 |
| Transfers at once       | 4 per session, both directions together                                      |
| Size                    | 2^40 bytes at most; set a lower limit with `maxSize` (`setMaxSize` in Swift) |
| Time to answer an offer | 120 seconds                                                                  |
| Time without progress   | 60 seconds, never counted while the person is deciding                       |

A receiver refuses an offer it cannot store before it asks the person. That reveals the receiver's limit and free space to the sender, which is accepted. Over the relay the bytes count against the person's relay quota, as any other; the local network is not metered.

## Errors

A transfer that ends without its content delivered fails with `transfer-cancelled`, and `reason` says why.

| Reason      | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `declined`  | The person said no, or there was no handler.                           |
| `cancelled` | A side canceled, or the reason was one this SDK does not know.         |
| `hash`      | The content did not match its hash. Nothing was delivered.             |
| `size`      | Over the receiver's size limit, or `DONE` came early.                  |
| `category`  | A link's offer without an approved category.                           |
| `busy`      | Four transfers already, or the receiver is asking about another offer. |
| `quota`     | No room to store it.                                                   |
| `timeout`   | Nobody answered, or no progress. The partial is kept.                  |

A session that closes mid-transfer fails with `peer-closed` and keeps the partial for resume. `link-unknown` means you named a link this device does not hold. A peer that did not list `xfer/1` fails the send as unsupported before anything goes out.

## Per SDK

| SDK    | Entry                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| Node   | `client.cloudConnect.transfer`: `send(peer, source, options)`, `onOffer(handler)`, `onResult(fn)`, `cancel(id)` |
| React  | The browser does it over the relay only, from a Blob or stream; the answer is a Blob, a stream or a file handle |
| Python | `client.cloud_connect.transfer`: `send`, `on_offer`, `on_result`, `cancel`                                      |
| Swift  | `client.cloudConnect.transfer`: `send(_:source:options:)`, `onOffer`, `onResult`, `cancel(_:)`                  |
| Kotlin | `client.cloudConnect.transfer`: `send(session, source, options)`, `onOffer`, `onResult`, `cancel(id)`           |

Swift's `onReceived` is the earlier name of `onResult`; it stays for one release. Kotlin's `cancel(peer, id)` also still works. Android and Godot do not offer Direct Transfer yet.

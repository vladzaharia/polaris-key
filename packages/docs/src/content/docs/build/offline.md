---
title: "Going offline"
description: "The three offline depths — grace, air-gapped bundles, and local-only builds — and which SDK entry point each one uses."
sidebar:
  order: 6
---

Every Polaris Key client is offline-first by construction: `create()` (or its language
equivalent) loads the device id, the token, and the cached signed documents and re-verifies
them with **no network call**, so a host can render its gate before it has ever reached
`key.plrs.im`. On top of that baseline there are three depths, each a deliberate answer to a
different amount of network absence.

## 1. Online with grace — the default

Every signed document (license, config) carries a short `expiresAt` (one hour) and a much
longer, server-signed `graceUntil` — up to 365 days, capped both when the Worker signs it and
again when a client verifies it, so neither a misconfigured server nor a tampered cache file
can hand out an unbounded offline window. A continuously online client re-signs well before
`expiresAt` (the half-life re-ask described in each SDK's `sync()`); an install that loses its
connection keeps working, unmodified, until `graceUntil`. Nothing about this depth requires an
opt-in — it's what every activated install already does.

## 2. Air-gapped: offline activation bundles

An install that will **never** reach the control plane activates from a signed
`pkey-bundle+jws` file instead of a network round trip — the classic request-code flow. The app
shows its request code (product slug + device id); an operator mints a bundle against it on a
machine that _can_ reach the console; the file crosses the air gap however it needs to (USB
stick, ticket attachment). The protocol-level shape — the envelope, its three time bounds, and
the four ordered refusal steps a verifier walks — is [Offline bundles](/docs/build/wire/bundles/);
this page is the two human sides of that flow.

**The operator side.** `pkey bundle` (`@polaris-key/cli`, see `packages/cli/README.md`) mints
the file:

```sh
PKEY_ADMIN_COOKIE='__Host-pkey_admin=<console session cookie>' \
  pkey bundle --product djdl --device <deviceId> --grace-days 365
```

The console's offline-bundle dialog does the same mint over the UI; both hit
`POST /manage/api/products/<slug>/bundles`, which signs the license document (and the config
document, unless `--no-config`/its UI equivalent says otherwise) alongside the current trust
manifest, into one envelope. See [Offline bundles](/docs/admin/bundles/) in Administer for the
console-side walkthrough. Three time bounds ride in one bundle, deliberately different:

| Bound                       | Length                                     | What it limits                                                                                                                                           |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inner document `expiresAt`  | 1 hour, same as an online document         | nothing bundle-specific — it's what makes an imported bundle indistinguishable from a cache written by a device that synced and immediately went offline |
| inner document `graceUntil` | up to 365 days (`--grace-days`)            | how long the **install** keeps working before it needs re-provisioning                                                                                   |
| bundle `expiresAt`          | a fixed 30 days, not operator-configurable | how long the **file itself** may sit unimported before the mint is wasted                                                                                |

The file's 30-day window is deliberately decoupled from — and much shorter than — the grace
window it grants: it bounds how long a stolen bundle is useful to someone who didn't have it at
mint time, while `graceUntil` bounds how long the install it provisions keeps working. Making
the two equal would mean a 365-day grace also handed out a 365-day replay window for the file
itself.

**The device side.** Every SDK's bundle import is **all-or-nothing**: the file verifies
against the pinned keys, then the inner trust manifest, then each carried document, and only
then does the cache get written, atomically. Any failure imports nothing and the error names
the step that refused, because "get a bundle minted for this machine" is a different remedy
from "the trust manifest inside it was rejected":

```ts
// Node
import { createBundleClient } from "@polaris-key/node/local";
const { client, imported } = await createBundleClient({
  productSlug: "djdl",
  version,
  trust: { pinnedKeys },
  bundle: await readFile(bundlePath, "utf8"),
});
```

```python
# Python — already-provisioned or config-only installs use client.import_bundle(...) directly
from polaris_key.local import create_bundle_client
client, imported = create_bundle_client(bundle=jws, product_slug="djdl", version="1.0.0", trust=TRUST)
```

```swift
// Swift
let (client, imported) = try await PolarisKeyClient.createFromBundle(options: opts, bundle: jws)
```

No token is created — a bundle-activated install has no credential and, on the local-only
profile below, never talks to the server at all. With no server to revoke against, the grace
bound **is** the revocation lever, which is why re-issuing on an annual cadence (not the 365-day
maximum by default) is the operational habit worth adopting, not just the technical ceiling.

## 3. Local-only: a build that never dials

Some builds must not open a socket even by accident — an air-gapped lab image, a regulated
environment, a binary that runs inside a network namespace with no route out. The local-only
profile is a **transportless** client: config resolution, the gate, and bundle import all work,
and every network-requiring call — activation, enrollment, `sync()`, the changelog, the update
check — rejects immediately with a `local-only` error, at the dial, before a URL is even built.
There is still exactly one client type; a host never has to branch on which one it got.

Two construction routes, both fully offline:

|        | Already provisioned / config-only                 | Fresh air-gapped install                                 |
| ------ | ------------------------------------------------- | -------------------------------------------------------- |
| Node   | `createLocalClient()` (`@polaris-key/node/local`) | `createBundleClient()`                                   |
| Python | `create_local_client()` (`polaris_key.local`)     | `create_bundle_client()`                                 |
| Swift  | `PolarisKeyClient.createLocal(options:)`          | `PolarisKeyClient.createFromBundle(options:bundle:now:)` |

`createLocalClient` reads whatever the cache already holds (from a prior bundle import, or —
for a config-only product — nothing to activate at all); `createBundleClient` does the import
and hands back an already-gated client in one step, for the "this machine has never seen the
network" case. `deactivate()` and device-report telemetry still "work" on this profile — they
swallow the refusal, because both were already best-effort against a dead network before
local-only existed.

**Swift's local-only is additionally a link-time fact, not just a runtime flag.** Don't link
the `PolarisKeyUpdate` product and set no `SUFeedURL` in the host's `Info.plist`, and "this
binary generates no update traffic" becomes something true about the compiled artifact, not
something a config value merely asserts at runtime. See the [Swift SDK](/docs/build/sdks/swift/)
for the per-service SwiftPM targets that make this possible.

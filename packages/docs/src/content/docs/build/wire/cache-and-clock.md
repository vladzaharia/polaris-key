---
title: "Cache and clock"
description: "Cache record v3 stores signed artifacts only, re-verifies everything on load, and derives a monotonic clock floor that makes clock rollback inert."
sidebar:
  order: 8
---

The offline cache is one Core-owned record per product. It holds **signed artifacts only**,
and every field a security decision reads is **derived** from those artifacts at load time —
never read from the file.

That is the whole design. Everything below is a consequence of it.

Spec reference: §4. Implementation: `packages/client-core/src/store.ts` (the contract),
`packages/client-core/src/clock.ts` (the floor), `packages/sdk-node/src/core/cache.ts` (a
host's load procedure).

## The record

`CACHE_VERSION` is **3**.

```jsonc
{
  "v": 3,
  "trustJws": "<pkey-trust+jws>", // the manifest, verbatim
  "docs": { "license": "<jws>", "config": "<jws>" }, // per-service slices
  "etags": { "license": "…", "config": "…" }, // conditional-request validators
  "bundle": "<pkey-bundle+jws>", // an offline activation, verbatim
  "pinRevocations": { "<revoked pinned kid>": "<pkey-trust+jws>" }, // the evidence
  "lastSyncUnauthorized": false,
  "blocked": {
    "reason": "version-too-old",
    "allowedRange": { "min": "2.0.0" },
  },
}
```

| Field                          | Signed? | Notes                                                                                                                                                                                            |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trustJws`                     | Yes     | The compact JWS, verbatim. Never a decoded `kid → key` map                                                                                                                                       |
| `docs.license` / `docs.config` | Yes     | Per-service slices. An absent slice means the service is unused or not yet fetched — never that it failed open                                                                                   |
| `etags.*`                      | No      | Non-security. The worst a forged ETag achieves is an unnecessary `200`                                                                                                                           |
| `bundle`                       | Yes     | The imported bundle, verbatim. Re-verified at every load without its import window; `activation: "bundle"` only when its licence document is the cached one, byte for byte, and no token is held |
| `pinRevocations`               | Yes     | Each tombstoned pin's evidence: the manifest another pin signed. Re-verified at every load in issue order; kept through deactivation and a bundle import                                         |
| `lastSyncUnauthorized`         | No      | A recorded hard `401`                                                                                                                                                                            |
| `blocked`                      | No      | The last `403` version/channel block                                                                                                                                                             |

The two hints are for display: no verdict depends on them. A hard `401` removes the document it
answered for, and a `403` build block removes the licence document, in the same write that sets
the hint. Clearing a hint therefore yields `needs-activation`, never a usable document.

What is emphatically **not** in the record: decoded documents, bare keys, and plaintext
counters. Version 1 of this file persisted the decoded doc, a bare `trustedKeys` map, and three
unsigned counters that security decisions read directly — so one write to a plain JSON file was
enough to substitute the key bytes behind a pinned `kid`, pin forged state against a live
server, or invent a license outright with no signature anywhere.

## The load procedure is the security boundary

Every load re-verifies everything, in this order:

1. **Version gate.** A record whose `v !== 3` is **discarded, never migrated.** `v` is checked
   before any other field is read, so a v1/v2 record's `trustedKeys` and unsigned counters are
   never even looked at. One network round trip is the right price for not carrying poisoned
   state forward; an air-gapped install re-imports its bundle.
2. **Pin evidence.** Each `pinRevocations` entry is re-verified, in ascending manifest
   `issuedAt`, against the pins minus the tombstones before it; what survives gives the usable
   pins ([Trust](/docs/build/wire/trust/)). An entry that fails is dropped.
3. **Trust against the usable pins.** `trustJws` is verified against the **usable pinned keys
   only**, with `checkFreshness: false`, producing the effective set. On failure, discard it and
   fall back to the usable pins alone — never to whatever the file claimed.
4. **Each document against the effective set**, with `checkFreshness: false` and the full
   claim validation from [The envelope](/docs/build/wire/envelope/) — including `aud` and
   `deviceId`, so a cache file copied from another machine or another product verifies as
   nothing.
5. **The bundle** on the bundle reload profile ([Offline bundles](/docs/build/wire/bundles/)).
6. **Derive every counter** from what verified: the per-type anti-replay floors, the
   monotonic clock floor, and `lastVerifiedAt`.

Any artifact that fails is treated as **absent** and dropped from the in-memory record. A
failed license document yields `needs-activation`, never a partial state. There is no unsigned
field left to poison, and forging one now requires forging a signature.

A dropped slice is dropped **in memory**, not eagerly erased from disk. A read path that
deleted files would turn a transient key-rotation gap into data loss; the slice is simply
rewritten out on the next patch.

### `lastVerifiedAt` is derived too

On load, the "last checked" timestamp a UI renders is derived from the newest verified
document's signed `issuedAt` — not from a local write time. Offline, the server's own statement
of when it minted is the only trustworthy answer available. A successful authenticated exchange
then re-marks it against the local clock, `200` and `304` alike: at that instant the client has
just been told, so its own reading of "now" is as good as the server's.

### Writes are read-modify-write of the whole record

The record has independent slices — two documents, two ETags, a manifest, an import marker —
updated by different call sites at different times. Every mutation goes through one
Core-mediated patch of the whole record. Service modules never write the file. Serialising
mutations this way is what stops a config write from clobbering a license slice that landed
microseconds earlier in the same parallel sync.

The one exception is bundle import, which **replaces** the record wholesale rather than merging
into it — see [Offline bundles](/docs/build/wire/bundles/).

## The monotonic clock floor

A client that trusts its own clock has no defence against a user winding it back. The floor
removes the need to trust it:

```
highWaterMark = max(issuedAt of every currently-verified artifact)
effectiveNow  = max(systemClock, highWaterMark)
```

```ts
export function highWaterMark(artifacts: readonly DatedArtifact[]): number {
  let mark = 0;
  for (const a of artifacts) if (a.issuedAt > mark) mark = a.issuedAt;
  return mark;
}

export function effectiveNow(systemNow: number, floor: number): number {
  return Math.max(systemNow, floor);
}
```

The fold is over the **whole** artifact set — license document, config document, **and** the
trust manifest. An empty set folds to `0`, and `max(now, 0)` is just `now`, so a fresh install
is unaffected.

The floor is a **minimum, never a substitute**. With an honest clock ahead of every signed
artifact, `effectiveNow` is the system clock unchanged: the floor costs nothing when the clock
is truthful. Pinned as `floor-honest-clock-is-never-lowered`.

### Only re-verified content may be folded in

A rejected artifact contributes nothing. If a refused document could raise the floor, planting
a file with a far-future `issuedAt` would become a way to force every client to `expired`.
Pinned as `floor-rejected-manifest-does-not-raise-it`.

### Why documents alone are not enough

This is the subtle one, and it is worth understanding rather than memorising.

For any document, `issuedAt < graceUntil` holds **by construction** —
`graceUntil = issuedAt + maxOfflineDays × 86 400`. So a floor derived from documents alone can
never push `effectiveNow` past `graceUntil`, and a clock wound back inside the document's own
window still reads `ok`. The clause is _inert_ against the attack it was written for. It does
still block replay of an **older** document, which is why the single-source form was not
worthless — merely ineffective.

v3 giving the client two documents changes nothing: both are stamped by the same fetch. What
makes the floor bite is the **trust manifest**, because it is refreshed independently, on
Core's own schedule, and advances even while a content-stable document sits behind an unchanged
ETag. A client that verified a manifest yesterday cannot then credibly claim it is last month.

The corpus pins the defective form so it cannot silently return:

| Case                                                | What it pins                           |
| --------------------------------------------------- | -------------------------------------- |
| `floor-config-doc-alone-does-not-stop-rollback`     | Documents alone leave rollback working |
| `floor-trust-manifest-defeats-rollback`             | The manifest is what makes it bite     |
| `floor-max-over-three-artifacts`                    | The fold is over the whole set         |
| `floor-stale-cached-manifest-still-yields-its-keys` | Reload-path manifests still count      |
| `floor-manifest-without-a-document`                 | A manifest alone is a valid floor      |
| `floor-honest-clock-is-never-lowered`               | The floor is a minimum                 |
| `floor-rejected-manifest-does-not-raise-it`         | Only verified content feeds it         |

### Core-owned refresh keeps the floor live for any service mix

Because trust refresh is a Core capability rather than a side effect of one service's document
fetch, the floor advances for **every** product shape — license-only, config-only,
release-only, or all of them. In v2 the floor rode the `/config` fetch, so a product that did
not run Config had no independent signed clock at all. That coupling is abolished (spec §4.2).

### Where `effectiveNow` is consumed

The gate evaluates at `max(now, highWaterMark)` before any comparison it makes, so every
transition below is rollback-resistant without a trusted local clock:

```
licenseServiceEnabled: false   →  not-applicable   (isUsable)
                                  (on when the build declares `license` OR discovery says so)
activation: null               →  needs-activation
blocked hint present           →  the block reason
lastSyncUnauthorized           →  revoked
no verified document           →  needs-activation
effectiveNow > graceUntil      →  expired
effectiveNow > expiresAt       →  grace            (isUsable)
otherwise                      →  ok               (isUsable)
```

## Revocation while offline

A recorded hard `401` — set after exactly one token re-acquire attempt has also failed — yields
`revoked` offline. The same write removes the slice that answered `401` (`docs.<slice>` and its
ETag), and a `403` `version_blocked` or `channel_not_allowed` removes `docs.license`. The token
is kept, so the gate still reports `revoked` or the block. A device that never reconnects learns
nothing new and runs out at `graceUntil`. Restoring a full pre-revocation snapshot of the state
directory and the token store works until `graceUntil`.

For bundle-activated installs, the grace bound **is** the revocation lever. There is no
credential to revoke and no connection on which to learn about it. The contract states this
rather than pretending otherwise (spec §4.3).

## Device binding on desktop

A desktop file store does not trust its stored device id. At every start the SDK re-derives the
id from the platform anchor (`ioreg`, the registry's `MachineGuid`, `/etc/machine-id`) with
`deviceIdFromRaw(product, raw)`. A stored id that disagrees is discarded with the token and the
grant slices of the cache (`trustJws`, `docs`, `etags`, the bundle marker and both hints); the
update slices stay. The device re-activates once. A stored id is used only when no anchor is
readable. The probes run by absolute path (`/usr/sbin/ioreg`, `%SystemRoot%\System32\reg.exe`),
never through `PATH`. Keychain and Keystore stores keep their stored id.

## The six inherited offline invariants

These carried forward from wire contract v2 unchanged and are normative in v3. If you are
porting the contract, they are the checklist:

| Invariant                           | Meaning                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **freshness-off-on-reload**         | Cached documents are validated with `checkFreshness: false`; their outer bound is `graceUntil`                              |
| **pins-only manifest verify**       | A trust manifest is verified against pinned keys on every path, online and offline                                          |
| **pins spread last**                | `mergeTrust` puts pins last, so a manifest can never shadow one                                                             |
| **replace-not-merge**               | The discovered key set is replaced wholesale on every refresh; absence is revocation                                        |
| **discard-not-migrate**             | A cache record of another version is discarded, never migrated                                                              |
| **fail-closed-to-needs-activation** | Any verification failure means "absent", and an absent license means `needs-activation` — never a partial or degraded state |

## Where to go next

- [Trust](/docs/build/wire/trust/) — what step 2 of the load is verifying against.
- [Offline bundles](/docs/build/wire/bundles/) — the one path that replaces this record
  wholesale.
- [The conformance corpus](/docs/build/wire/corpus/) — `clockFloorCases` replays this entire
  load path as pure data.

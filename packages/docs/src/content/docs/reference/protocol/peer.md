---
title: "The peer protocol"
description: "pkey-peer/1 for implementers: the device certificate and roster documents, discovery names, the Noise handshake and its modes, the confirmation code, records, and the relay envelope."
sidebar:
  order: 6
type: "reference"
lastReviewed: "2026-10-28"
---

`pkey-peer/1` is what SDKs speak to each other for [Cloud Connect](/docs/features/cloud-connect/). The Worker issues two signed documents and forwards ciphertext on the relay; it never takes part in a channel. This page maps the pieces. The byte layouts are in `docs/security/WIRE-CONTRACT-V5.md` section 15, cited below, and the spec wins where a page disagrees.

The constants are normative (spec §15.1). A certificate and a roster live 604800 seconds (7 days). A certificate is renewed when under 302400 seconds are left or the ring epoch moves. A roster holds 1 to 128 devices. One record is at most 1 MiB. Clock skew is 300 seconds. The cipher is AES-256-GCM and the hash is SHA-256.

## Device keys

A device has two keys: an Ed25519 `signKey` and an X25519 `agreeKey`. It registers them with `PUT /<product>/devices/keys`, proving it holds both (spec §15.8). Keys are made on first use of Connect, not at launch. A device may rotate at most 4 times a day, and `keySeq` only rises. A rotation counts as a roster change.

## The two documents

Both are compact JWS, signed by the product key and verified against the effective key set like any other document (see [The envelope](/docs/reference/protocol/envelope/) and [Trust](/docs/reference/protocol/trust/)). A release key or content key never signs either.

| Document          | `typ`            | Names                                                         | Spec   |
| ----------------- | ---------------- | ------------------------------------------------------------- | ------ |
| Device certificate | `pkey-peer+jws`  | One device: `sub` (a pairwise subject), `deviceId`, both keys, `ringEpoch` | §15.2 |
| Roster            | `pkey-ring+jws`  | The person's devices, sorted by `deviceId`, and the `epoch`    | §15.3  |

A certificate is checked against the Noise remote static key: `agreeKey` must equal it. The checks, in order, are the `typ` and signature, issuer and audience, the `sub` and `deviceId` patterns, both keys (canonical, 32 bytes, `signKey` strict, `agreeKey` not low-order), the lifetime, and the clock. There is no anti-replay floor, because a certificate is shown to third parties.

A held roster is replaced only by one with the same audience and subject, a higher `epoch`, and a live lifetime. A same-epoch roster replaces it only when the device list is identical. A client holds a certificate and roster together and accepts a pair only when the certificate's `ringEpoch` equals the roster's `epoch` and the roster lists this device.

Admission of a peer's certificate: if the held roster's epoch is above the certificate's `ringEpoch`, the peer's keys must be in the roster, or the session closes with `peer_revoked`. Otherwise the peer is admitted, and a certificate with a higher epoch than the held roster asks for `RING`.

## Discovery

On the local network a device advertises `_pkeypeer._tcp` on a random port. The instance name is `p1-` plus the first 16 base32 characters of an HMAC of the quarter-hour, the device id and a 32-byte discovery key. The TXT record holds `v=1` and the mode `m`, and nothing else identifies the device (spec §15.4).

- The discovery key comes from `GET /<product>/connect/identity`, per person and product, and changes with the ring epoch. The response carries the current key and, for 24 hours after a change that only added devices, the previous one.
- A browser tests the current and previous quarter-hour under both keys, for every roster device.
- Anyone who knows a product's slug can tell that an advert belongs to it. See [What apps collect](/docs/reference/what-apps-collect/).

Over the relay there is no advert. The room lists who is online.

## The handshake

A channel is a Noise handshake, then records. The Noise protocol and PSK depend on the mode (spec §15.5).

| Mode | Noise protocol                     | Static keys        | Used by                                     |
| ---- | ---------------------------------- | ------------------ | ------------------------------------------- |
| `a`  | `Noise_XXpsk0_25519_AESGCM_SHA256` | each `agreeKey`    | Cloud Connect, on the local network and the relay |
| `v`  | `Noise_XX_25519_AESGCM_SHA256`     | one-time keys      | Local network only, with a confirmation code |
| `p`  | `Noise_XX_25519_AESGCM_SHA256`     | one-time keys      | Local network only, with a confirmation code |

`client.cloudConnect` opens only mode `a`. Modes `v` and `p` never cross the relay.

- The prologue is `pkey-peer/1`, 0x00, the product slug, 0x00, the mode, 0x00. A mismatch in version, product or mode fails by construction.
- In mode `a` the PSK is HKDF-SHA256 of the discovery key with an empty salt and the label `pkey-peer/1 psk`, 0x00, the slug. The responder tries the current and previous discovery key, and a failed tag closes the connection without a word.
- Handshake payloads are strict JSON of at most 8 KiB. In mode `a`, messages 2 and 3 carry `{v, cert, ring, caps}`: the sender's certificate and its roster epoch. `caps` has at most 32 entries; the session uses the intersection.
- A DH output of all zeros aborts the handshake.

### The confirmation code

Modes `v` and `p` carry no certificate, so the people confirm a six-digit code instead. A code taken straight from the handshake hash could be ground by an attacker on the network, so each side commits first (spec §15.5):

1. The device sends `SAS_COMMIT` with `SHA-256(nD)`, where `nD` is 32 random bytes.
2. The approver answers `SAS_NONCE` with its own `nM`.
3. The device sends `SAS_REVEAL` with `nD`, and the approver checks it against the commit.
4. Both derive the code from the handshake hash and the two nonces, and show it as `123 456`.

An approver accepts at most 5 handshakes a minute per advert. The vectors are in `sas` in `peer-matrix.json`.

## Records

After the handshake each Noise message carries `u16be type`, `u8 flags` and a body. On TCP a frame is `u16be len` and one Noise message. Flag bit 0 is `MORE`: the record continues in the next one of the same type, up to 18 records and 1 MiB reassembled. A type with bit `0x8000` set is critical: an unknown one closes the session. The first record each way is `HELLO`. The type table and the order of checks are spec §15.6.

Application messages use types `0x0100` to `0x7FFF` (and `0x8100` to `0xFFFD` as critical). The channel rekeys every 2^20 messages or 3600 seconds with `REKEY`.

## The relay envelope

The relay takes one binary WebSocket message per envelope, at most 65,564 bytes: `SEND` (`to`, session, Noise frame) from the client, and `RECV` (with the stamped `from`), `MEMBERS`, `RING`, `PONG`, `GONE` and `LIMIT` from the room. The ticket, the subprotocol `pkey-relay.1`, the close codes and the limits are described in [The relay](/docs/features/cloud-connect/relay/); the layout is spec §15.7.

## Errors

Channel codes travel in a `CLOSE` record and are never sent by the Worker: `peer_revoked`, `peer_expired`, `peer_bad_frame`, `peer_unknown_critical`, `peer_not_allowed`, `peer_busy`, `peer_timeout` and `peer_bye`. A failure before the transport exists ends the connection without a record. Worker codes for the routes (`device_keys_invalid`, `device_keys_required`, `ring_too_large`, `relay_disabled`, `relay_paused`, `relay_quota_exceeded`) are in [Error codes](/docs/reference/error-codes/). What an app sees is in [Channels](/docs/features/cloud-connect/channels/#why-a-channel-closed).

## Proving an implementation

The corpus has the sections `peerCertCases`, `ringCases` and `peerAdmissionCases` in `cases.json`, plus `noise-vectors.json` (X25519 and AES-GCM known answers, the low-order points, the three handshakes with fixed ephemerals, rekey) and `peer-matrix.json` (adverts, prologue, PSK, SAS, records, relay envelopes). See [Conformance corpus v2](/docs/reference/protocol/corpus/). The reference code is `packages/client-core/src/peer/`.

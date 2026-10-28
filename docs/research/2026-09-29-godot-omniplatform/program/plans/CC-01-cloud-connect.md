# Plan: Cloud Connect (device keys, peer certificates, LAN, channels, relay) — 2026-10-24

> **Edited 2026-10-26 (L.0, plan-combined.md §6).** Approved by the owner on 2026-10-26 as part of the combined program (plan-combined.md). Cipher is AES-256-GCM everywhere (R-1); nearby approval is one flow (R-2) with a commit-reveal code (R-3); M advertises (R-4); device keys are one Core package and one key store per SDK (CC-26, R-5); one device proof, `pkey-proof/1` (R-6); one lifecycle (R-7). CC-20 is named "Direct Transfer": peer-to-peer data between two Cloud Connect peers already authenticated with each other, directly on the LAN or through the relay, a feature of the Cloud Connect service (contract O-7).

Planner for `plan-cloud-connect.md` in `linking-sync-contract.md`. Scope: O-4, P-1, P-2, P-4, P-6,
P-7, the relay DO, the device half of P-5, the service row and the console's linked-devices view.
It honours L-1…L-13. Code was read on `_merge` (`integ/next-stage`, b03b279ce). Nothing was changed.
This plan is CC-01's plan; the implementer packages execute it. It needs the owner's approval: it
is a wire change (rule 2), and §9 lists the decisions.

## 0. What exists, and corrections

**Exists (build on it):**

- **Device rows.** `devices` is keyed `(product, device_id)`. `devices.subject` holds the pairwise
  subject (`migrations/0068_c_devices_subject.sql`; `core/repo.ts:160-194`).
- **Principal.** `resolveSyncPrincipal` (`core/accounts/accountSubjects.ts:410`) maps a device to
  its principal: authorized, bound and not floating. Cloud Connect uses it unchanged.
- **Subject stores.** The registry is in `core/accounts/subjectHooks.ts:43-80`. Its guard needs
  every subject table and every subject-named DO class declared.
- **Quota pattern.** It is the reserved entitlement `pkey.cloudSync.bytes`
  (`shared-manifest/src/reservedNames.ts:91`), `CLOUD_SYNC_CEILINGS`
  (`shared-catalog/src/cloudSync.ts:96`), the platform default `cloudSync.quota.defaultBytes` and
  the product ceiling setting (`services/sync/settings.ts`). The daily meter
  `sync_product_daily` (`migrations/0132`) is counters only.
- **Single-use store.** `core/singleUse.ts:20` has a closed set of kinds, and the DO fails closed.
- **DOs.** There are four, all `new_sqlite_classes`. Migration tags `v1`–`v4` are top-level only
  (`wrangler.toml:55-81`). Bindings repeat at the top level and in `prod` (:187), `staging` (:314),
  `dev` (:423) and `test` (:515). Classes are re-exported from `src/index.ts:9-12`. No WebSocket
  code exists in the Worker.
- **Signing and verifying.** The `JwsTyp` union is in `shared-jws/src/index.ts:42-50`. The signer
  guards are in `core/signing.ts`, from P3-12.
- **Godot crypto.** The addon already ships pure-GDScript SHA-512 and Ed25519 verify
  (`addons/polaris_key/core/crypto/`). Godot native lanes exist for Android (`:platform`), iOS and
  macOS (`pkey_apple*`) and Windows (`pkey_win.dll`), with pinned inputs in
  `sdks/godot/native/deps.env`.
- **Existing pins.** `@noble/curves` 2.4.0 is pinned in the Worker. Kotlin pins Tink 1.23.0 and
  OkHttp 4.12.0 (`libs.versions.toml:30,38`).

**Corrections (each a fact the design depends on):**

| #   | Claim                                                                                              | Fact                                                                                                                                                                                                                                                    | Consequence                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | P-6: the instance name is HMAC(K_disc, epoch)                                                      | Every same-account device would advertise the same name. DNS-SD names must be unique per service type on a link (RFC 6762 §9), so the devices would collide and rename each other                                                                       | The name also covers `deviceId` (§2.4). Members can tell which device it is; non-members still see random names                                  |
| C2  | P-4 and spike §8: XX payloads carry the certificate                                                | In XX the responder's static key and payload go out in message 2. An active LAN initiator decrypts them. The certificate's `sub` and `deviceId` would reach any device that connects, which is a stable cross-network identifier (the spirit of rule 7) | Account mode is `XXpsk0`, with a PSK from K_disc (§2.5). A non-member fails on message 1 and learns nothing                                      |
| C3  | P-1: keys are "hardware-backed where the platform allows"                                          | The Secure Enclave and StrongBox are P-256 only (spike §4.2). Android 13+ Keystore Curve25519 would put Noise's DH inside the Keystore                                                                                                                  | 25519 keys are software keys in **hardware-wrapped storage** (Keychain `…ThisDeviceOnly`, Keystore-wrapped). Web keys are non-extractable keys   |
| C4  | Spike §8: the relay header has 16-byte `to`/`from`                                                 | A device id is 32 base64url characters, which is 24 bytes (WIRE-V4 §6)                                                                                                                                                                                  | The fields are 24 bytes                                                                                                                          |
| C5  | Spike §8: TLV `u32 len`                                                                            | A Noise transport message is at most 65,535 bytes                                                                                                                                                                                                       | One record per Noise message, with no length field. A `MORE` flag fragments a record (§2.6)                                                      |
| C6  | Spike §3.1: iOS needs the multicast entitlement                                                    | The entitlement is needed only for raw multicast sockets. `NWBrowser` and `NWListener` Bonjour do not need it. It would also be each developer's entitlement, not ours                                                                                  | There is no owner entitlement step. Godot Apple exports must use the native binding, never GDScript UDP                                          |
| C7  | "Android 17 `ACCESS_LOCAL_NETWORK` is mandatory"                                                   | It is enforced only when an app targets 37. The SDK and the Godot template target 36 (`libs.versions.toml:12`)                                                                                                                                          | Declare the permission now and request it at run time when `targetSdk ≥ 37`                                                                      |
| C8  | Spike §4.5: Python uses `python-zeroconf`                                                          | The SDK supports 3.9 (`pyproject.toml:10`). zeroconf ≥0.149 and websockets ≥16 need 3.10 or later                                                                                                                                                       | Per-marker pins (§3)                                                                                                                             |
| C9  | Spike §4.5: the browser uses WebCrypto ChaChaPoly                                                  | WebCrypto has no ChaCha20-Poly1305, but it has AES-256-GCM. Godot's native `AESContext` is ECB/CBC only, which the GDScript lane turns into GCM (R-1)                                                                                                   | One suite everywhere, `AESGCM` (AES-256-GCM). The browser uses WebCrypto; no `@noble/ciphers`. No second suite, so there is no suite negotiation |
| C10 | Lead L-13: device keys live in Core and are "registered against the device row"                    | `ServiceContributions` (`core/contributions.ts:178-200`) has no device-change event, so Connect cannot hear about sign-outs or removals                                                                                                                 | CC-03 adds `contributes.onDeviceChange`                                                                                                          |
| C11 | Spike §5.1: the relay authenticates with a device certificate at connect                           | A browser `WebSocket` cannot send `Authorization`, while Cloud Sync's browser rule is "bearer from a listed origin" (V4 §13.1)                                                                                                                          | A single-use relay ticket is carried in `Sec-WebSocket-Protocol` (§2.7)                                                                          |
| C12 | `contribute/layout.md:191-192` says `TABLE_OWNERS` is in `packages/docs/scripts/gen-reference.mjs` | That file only imports it (`gen-reference.mjs:24`). It is defined in `packages/worker/src/db/owners.ts:12`                                                                                                                                              | CC-02.3 fixes the checklist line                                                                                                                 |
| C13 | The orchestrator procedure names `WIRE-CONTRACT-V3.md`                                             | V4 is normative (`WIRE-CONTRACT-V4.md:2`). `shared-jws/src/index.ts:36,54` still cites V3 §2                                                                                                                                                            | CC-04.2 updates the comments                                                                                                                     |
| C14 | Identity survey: Godot has "no Ed25519"                                                            | The addon has verify only. Ed25519 **sign**, which proof of possession needs, is new GDScript                                                                                                                                                           | CC-14 adds it                                                                                                                                    |
| C15 | Lead: reuse or amend I-40 if it fits                                                               | I-40 is a code that the account side issues and the person types (server-mediated), with no LAN                                                                                                                                                         | I-40 stays with `plan-auto-sign-in.md`. Cloud Connect provides only the LAN channel for the vouch                                                |
| C16 | P-4: XX first, IK for known peers                                                                  | IK saves one round trip, about 1 ms on a LAN. It doubles the patterns and vectors in seven languages and GDScript, weakens initiator identity hiding and adds key-compromise impersonation                                                              | v1 is XX only (D3). IK is an optional later package                                                                                              |
| C17 | Spike §4.5 and this plan\'s first draft: "CryptoKit cannot be called from Objective-C"             | Godot\'s Apple binding already links Swift: `native/macos/build_app*.sh` and `native/ios/build.sh` compile `PolarisKeyPlatform` and its `@_cdecl` surface `PolarisKeyPlatformC` (`pkp_call`)                                                            | CryptoKit is reachable from Godot on Apple through `PolarisKeyPlatformC`; Monocypher is used only in `pkey_win`, for the curves (R-12, CC-14b)   |

## 1. Architecture

```
 Worker (key.plrs.im)
  Core   devices + device_keys (P-1) · PUT /<p>/devices/keys (PoP) · onDeviceChange events
  connect  GET /connect/identity → pkey-peer+jws (7 d) + pkey-ring+jws + discKeys (K_disc)
           POST /connect/relay/ticket → pkeyrt_… (60 s, single use)
           GET  /connect/relay (WS) → ConnectRelayDO "<p>:<subject>" (hibernating; ciphertext only;
                 stamps `from`; presence; RING pokes; per-person day quota; product month ceiling)
  identity (plan-auto-sign-in) approve-nearby route ◄── called by the approving device (vouch)
        ▲ HTTPS                              ▲ WSS (relay, fallback)
 ┌──────┴──────┐  DNS-SD _pkeypeer._tcp  ┌───┴─────────┐
 │ device A    │◄── p1-<HMAC(K_disc,…)> ─►│ device B    │   Noise_XXpsk0 (same account, mode a)
 │ keys: Ed25519│  TCP u16 framing        │ any SDK     │   Noise_XX + SAS (vouch v / pair p)
 └─────────────┘  records: type|flags|body└─────────────┘
```

- **Trust roots are unchanged.** Peers verify certificates and rings against the app's
  effective product trust set, offline, with the verifier every SDK already ships. The relay
  and the LAN are untrusted pipes.
- **One protocol.** `pkey-peer/1` runs over every pipe: TCP on the LAN, the relay WebSocket, and
  later WebRTC or AWDL. A native adapter changes only discovery and the pipe, never the crypto
  or the records.
- **Preference order.** The LAN comes first: a direct TCP connection to the advert, then
  `CANDIDATES` addresses learnt over the relay. The relay comes last and is metered (O-2, L-8).
  WebRTC is optional (CC-21).
- **Modes.** The prologue binds the mode:
  - `a`: the same account;
  - `v`: a nearby vouch, P-5's device half;
  - `p`: inter-account pairing (P-7, opt-in, LAN only, SAS);
  - `c`: a later connection between two linked contacts (CC-19).
- **Revocation.** Removing a device, signing out or a licence that becomes floating changes the
  ring. Each change bumps the epoch, rotates K_disc, closes the device's relay sockets and pushes
  `RING` to every online member. An offline peer refuses the device at its next ring gossip, or
  when the certificate expires (≤7 days).
- **Rule 6.** Connect reads Core's tables (`devices`, `device_keys`) and owns its own tables.
  Cloud Sync and Identity never import it. The vouch reaches Identity only through the SDK, which
  calls the auto-sign-in plan's route.

## 2. Wire

### 2.1 Version: bump `PROTOCOL_VERSION` to 5 (recommended, D1)

Precedent: every new `typ` has entered with a bump.

- `pkey-bundle+jws` arrived in v3 (V3 §9).
- `pkey-feed+jws` and `pkey-release+jws` arrived as v3 → v4 (P3-01 header: "two new `typ`s").
- All eleven amendments that stayed inside v4 say "no new `typ`" (V4 header).

The bump is cheap and safe:

- No SDK enforces `protocolVersion` (V4 §9).
- `PROTOCOL_VERSION` is a generated constant in every SDK (`pnpm gen constants`).
- The four v3 documents and the two v4 documents keep their bytes.

Other version counters:

- `corpusVersion` stays 2; the new sections are additive, as `feedCases` were.
- `DISCOVERY_VERSION` stays 2.
- `CACHE_VERSION` stays 3: Connect state is its own store record, `pkey.connect.v1`, never the
  licence cache.
- New counters: `noiseVectorsVersion = 1` and `peerMatrixVersion = 1`.

`WIRE-CONTRACT-V5.md` is V4 restated (a copy), with §2's table grown to eight `typ`s and a new
§15, Cloud Connect. V4's header becomes "Superseded". AGENTS rule 2 then reads "now 5 … V5 … eight
signed documents".

The alternative is additive `typ`s under v4. It breaks the "new `typ` ⇒ bump" precedent and gains
nothing.

### 2.2 `pkey-peer+jws`: the device certificate (P-2)

Header `{"alg":"EdDSA","typ":"pkey-peer+jws","kid"}`. It is signed by the product key and verified
against the effective product set (V4 §1).

```jsonc
{
  "iss": "key.plrs.im",
  "aud": "<product-slug>",
  "sub": "ps_<22>", // pairwise subject; never the account id
  "deviceId": "<32 b64url>",
  "signKey": "<43 b64url, raw Ed25519 public>",
  "agreeKey": "<43 b64url, raw X25519 public>",
  "ringEpoch": 7, // the ring epoch at issue, integer ≥ 1
  "issuedAt": 1761300000,
  "expiresAt": 1761904800, // issuedAt + PEER_CERT_SECONDS (604800)
}
```

**Verify** (strict JSON §1.2; integer claims from the token, §3.1; unknown members ignored, §3.2):

1. `typ` is `pkey-peer+jws`, and the signature verifies under the effective set. A release key or a
   content key never signs one.
2. `iss` is the fixed issuer, and `aud` is the app's product.
3. `sub` matches `^ps_[A-Za-z0-9_-]{22}$` and `deviceId` matches V4's pattern.
4. `signKey` and `agreeKey` are canonical base64url of exactly 32 bytes.
   - `signKey` passes §1.1 checks 2–3.
   - `agreeKey` is not one of the X25519 low-order points (the list is in `noise-vectors.json`).
5. `1 ≤ expiresAt − issuedAt ≤ MAX_PEER_CERT_SECONDS` (604800).
6. Against the effective clock (V4 §4.2): `issuedAt ≤ now + 300` and `now ≤ expiresAt + 300`.
7. In a session, `agreeKey` equals the Noise remote static key. In mode `a`, `sub` equals the
   verifier's own subject and `deviceId` differs from its own.

There is no anti-replay floor: the certificate is shown to third parties, as in SP-53's class.
Renewal happens when less than `PEER_CERT_RENEW_SECONDS` (302400) is left, or when the ring epoch
moves.

### 2.3 `pkey-ring+jws`: the roster (P-2)

The roster is device-less, like trust and feed. It is signed by the product key and verified
against the effective set.

```jsonc
{
  "iss": "key.plrs.im",
  "aud": "<product>",
  "sub": "ps_…",
  "epoch": 7,
  "issuedAt": 1761300000,
  "expiresAt": 1761904800, // + RING_SECONDS (604800)
  "devices": [{ "deviceId": "…", "signKey": "…", "agreeKey": "…" }],
}
```

`devices` holds 1 to `MAX_RING_DEVICES` (128) entries, sorted by `deviceId` bytes, with unique ids
and keys checked as in §2.2 step 4. At 128 entries the payload is about 20 KiB, under the 64 KiB cap.

**Held ring and replacement.** The held ring R is replaced by R′ only when all of these hold:

- R′ verifies;
- R′ has the same `aud` and `sub`;
- `R′.epoch > R.epoch`;
- R′ is not expired.

An expired held ring counts as no ring at all. That is safe, because the certificates of removed
devices expire on the same horizon.

**Peer admission** with certificate C:

1. C verifies (§2.2).
2. If R exists and `R.epoch > C.ringEpoch`, then `(deviceId, signKey, agreeKey)` must be in R.
   Otherwise the session closes with `peer_revoked`.
3. If `R.epoch ≤ C.ringEpoch`, or there is no R, admit the peer. When `C.ringEpoch > R.epoch`, send
   or request `RING`.

### 2.4 Discovery adverts (P-6)

| Advert         | Instance (`_pkeypeer._tcp`, a random port each listen)                                                                                                                                                                                                                                                                                                            | TXT                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Account (`a`)  | `p1-` + base32lower(HMAC-SHA256(K_disc, "pkey-peer/1 disc"‖0x00‖u64be(⌊now/900⌋)‖deviceId))[0..16]                                                                                                                                                                                                                                                                | `v=1`, `m=a`               |
| Approver (`v`) | `p1-` + 16 random base32 characters, advertised by **M, the signed-in approver** (D connects out, so D needs no listener and no firewall prompt, R-4); only when signed in, `identity.nearby` is on and the Local Network permission was already granted, otherwise after the person picks "Approve a nearby device"; renewed every 300 s while in the foreground | `v=1`, `m=v`, `h=<16 hex>` |
| Pair (`p`)     | `p1-` + 16 random base32 characters, both sides open pairing (unchanged), only while the screen is open, at most 300 s                                                                                                                                                                                                                                            | `v=1`, `m=p`, `h=<16 hex>` |

- **Product tag.** `h` = hex(HMAC-SHA256(SHA-256("pkey-peer/1 salt"‖0x00‖slug), "pkey-peer/1
  pair"‖0x00‖u64be(epoch)))[0..16]. Anyone who knows the slug can recognise the product; the
  privacy docs say so.
- **Browsing.** A browser tests the current and previous 15-minute epoch, under both delivered
  discKeys, for every roster `deviceId`: at most 512 HMACs per result.
- **Nothing else.** No label, id, model or subject appears anywhere in the advert.
- **K_disc.** It is 32 random bytes per `(product, subject)` per ring epoch, stored in
  `connect_rings`. `GET /connect/identity` delivers the current key and the previous one (for 24 h
  after a bump). A device advertises only under the newest key.
- **Why server-delivered.** This keeps L-13's server-delivered key over a root-key derivation.
  Connect then works without Cloud Sync E2E, and rotation is trivial.

### 2.5 Handshake (P-4)

| Mode | Noise protocol name                | Static keys                 | PSK                                                  | Handshake payload, messages 2 and 3          |
| ---- | ---------------------------------- | --------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `a`  | `Noise_XXpsk0_25519_AESGCM_SHA256` | device `agreeKey`           | HKDF-SHA256(K_disc, "", "pkey-peer/1 psk"‖0x00‖slug) | `{"v":1,"cert":"<jws>","ring":7,"caps":[…]}` |
| `v`  | `Noise_XX_25519_AESGCM_SHA256`     | one-time keys on both sides | none                                                 | `{"v":1,"caps":[…]}`                         |
| `p`  | `Noise_XX_25519_AESGCM_SHA256`     | one-time keys on both sides | none                                                 | `{"v":1,"caps":[…]}`                         |
| `c`  | `Noise_XXpsk0_…` (CC-19)           | device `agreeKey`           | the contact secret                                   | `{"v":1,"caps":[…]}`                         |

**Prologue and payloads:**

- The prologue is `"pkey-peer/1"‖0x00‖slug‖0x00‖mode‖0x00`. A version, product or mode mismatch
  fails by construction.
- Message 1's payload is `{"v":1}`.
- Payloads are strict JSON of at most 8 KiB.
- `caps` holds at most 32 entries matching `^[a-z0-9]+/[0-9]+$`. v1 defines `ring/1`, `trust/1`,
  `cand/1`, `vouch/1` and `app/1`. The session uses the intersection.

**Responder rules:**

- In mode `a`, the responder tries at most two PSKs, the current and previous discKeys. A failed
  tag closes the connection silently.
- Any DH output of all zeros aborts the handshake.

**SAS (modes `v` and `p`), commit-reveal (R-3).** A code taken straight from the handshake hash
can be forged by a man in the middle on the LAN who grinds its static key (about 10^6 X25519
operations). Each side therefore commits before the code is shown:

1. D sends `SAS_COMMIT` (0x8014) `{c: SHA-256(nD)}`, where nD is 32 random bytes.
2. M sends `SAS_NONCE` (0x8015) `{nM}`.
3. D sends `SAS_REVEAL` (0x8016) `{nD}`; M checks c.
4. `sas = u32be(HKDF-SHA256(salt=h, ikm=nD‖nM, info="pkey-peer/1 sas"‖0x00‖mode)[0..4]) mod 10^6`,
   shown as "123 456" on both screens.

An approver accepts at most 5 handshakes a minute per advert, so a man in the middle succeeds with
probability about 10^-6 per attempt. The vectors go in `peer-matrix.json` `sas`, with commit and
reveal rows.

**No identity before consent.** Modes `v` and `p` carry no certificate in the handshake.

### 2.6 Records and framing

- **TCP framing.** A frame is `u16be len ‖ Noise message`, with len from 1 to 65,535.
- **Record.** One Noise transport plaintext is `u16be type ‖ u8 flags ‖ body`.
  - Flag bit 0 is `MORE`: the record continues in the next one of the same type. Any other flag
    bit set closes the session with `peer_bad_frame`.
  - A reassembled record is at most `MAX_PEER_MESSAGE_BYTES` (1 MiB).
  - A type with bit `0x8000` set is critical. An unknown critical type closes the session with
    `peer_unknown_critical`; an unknown non-critical type is ignored.
  - A type not allowed in the session's mode closes it with `peer_not_allowed`.

| Type                         | Name                                    | Modes | Body                                                                                                                                                                |
| ---------------------------- | --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x8001                       | HELLO (first record each way)           | all   | `{label?, platform, app, maxMessage}`. The label is display data (V4 §5.4)                                                                                          |
| 0x0002                       | RING                                    | a     | `{"ring":"<pkey-ring+jws>"}`                                                                                                                                        |
| 0x0003                       | TRUST                                   | a     | `{"trust":"<pkey-trust+jws>"}`. The receiver verifies it against its usable pins (V4 §1); it heals a peer that missed a key rotation                                |
| 0x0004 / 0x0005              | PING / PONG                             | all   | 8 bytes                                                                                                                                                             |
| 0x0006                       | CANDIDATES                              | a     | `{"addrs":["ip:port"…≤8]}`, sent over the relay, for a direct upgrade                                                                                               |
| 0x8010                       | VOUCH_REQ (requester to approver)       | v     | `{v: 1, request, signKey, agreeKey, label, platform, sig}`. `sig` is `pkey-proof/1` purpose `vouch`, value `<b64url h>.<request>` (§2.8). No `userCode`, no `pop`   |
| 0x8011                       | VOUCH_RESULT                            | v     | `{"status":"approved"\|"denied"\|"expired"\|"not_nearby"\|"device_limit"}`. For display only; the server is the authority                                           |
| 0x8014                       | SAS_COMMIT                              | v, p  | `{c}` (R-3)                                                                                                                                                         |
| 0x8015                       | SAS_NONCE                               | v, p  | `{nM}` (R-3)                                                                                                                                                        |
| 0x8016                       | SAS_REVEAL                              | v, p  | `{nD}` (R-3)                                                                                                                                                        |
| 0x8012                       | CONFIRM                                 | p     | `{}`. This side's person confirmed the SAS                                                                                                                          |
| 0x0013                       | CONTACT                                 | p     | `{agreeKey, label}`, after both CONFIRMs. It never carries a `sub` or a certificate (CC-19)                                                                         |
| 0x0020–0x0025                | OFFER, ACCEPT, CHUNK, ACK, DONE, CANCEL | a, c  | CC-20 Direct Transfer (`xfer/1`)                                                                                                                                    |
| 0x0030                       | KEYRING_WRAP                            | v     | `{ringId, epoch, kid, kem, enc, ct}`: an HPKE wrap to the agreeKey from VOUCH_REQ. Owned by Sync; legal only in mode v after the code and the server approval (R-9) |
| 0x0031–0x003F                | reserved for Cloud Sync                 | v     | owned by `plan-cloud-sync.md`                                                                                                                                       |
| 0x0100–0x7FFF, 0x8100–0xFFFD | APP                                     | a, c  | the developer's opaque bytes (`app/1`)                                                                                                                              |
| 0x80FE                       | REKEY                                   | all   | empty. The sender rekeys after sending, the receiver after reading. Sent every 2^20 messages or 3600 s                                                              |
| 0x80FF                       | CLOSE                                   | all   | `{"code":"peer_*"}`                                                                                                                                                 |

### 2.7 Relay

**Ticket.** (AGENTS rule 8 gains the `pkeyrt_` relay-ticket prefix, D8.) `POST /<p>/connect/relay/ticket` (bearer and `X-PKey-Device`) answers
`{ticket:"pkeyrt_<32>", url, protocol:"pkey-relay.1", expiresAt}`. The ticket lives 60 s in the
`relay-ticket` single-use kind and is bound to `(product, subject, deviceId)` and the resolved
quota.

**Connect.** The client opens `GET /<p>/connect/relay` with `Sec-WebSocket-Protocol: pkey-relay.1,
pkeyrt_…`. The Worker consumes the ticket, then forwards the request to
`CONNECT_RELAY.idFromName("<p>:<subject>")`. The DO echoes `pkey-relay.1`.

One binary message is an envelope. The DO **stamps `from`** from the admission and never reads it
from the client.

| Direction    | Op   | Layout                                               |
| ------------ | ---- | ---------------------------------------------------- |
| client to DO | 0x01 | SEND: `to(24) ‖ session u32be ‖ noise`               |
| client to DO | 0x02 | LIST (empty)                                         |
| client to DO | 0x03 | PING: 8 bytes                                        |
| DO to client | 0x81 | RECV: `from(24) ‖ session ‖ noise`                   |
| DO to client | 0x82 | MEMBERS: `n ‖ n×24`                                  |
| DO to client | 0x83 | RING: `u64be epoch`                                  |
| DO to client | 0x84 | PONG                                                 |
| DO to client | 0x85 | GONE: `device(24)`                                   |
| DO to client | 0x86 | LIMIT: `u8` 1 rate · 2 person · 3 product · 4 paused |

**Close codes:** 4001 bad ticket · 4003 not a member · 4008 limit · 4009 replaced.

**Limits:**

- 2 sockets per device; a third replaces the oldest.
- 32 sockets per room.
- A message is at most 65,564 bytes.
- 200 messages per second per socket, with a burst of 400.

**Rooms and modes.** In v1 a room is always an account room. Mode `v` never crosses the relay
(LAN only), and neither does `p` (L-9).

### 2.8 Device keys (P-1, Core)

**Route.** `PUT /<p>/devices/keys` (bearer) takes `{signKey, agreeKey, issuedAt, sig}` and answers
`{keySeq}`.

**Proof of possession.** `sig` is `pkey-proof/1` (R-6, owned by CC-03.4) with purpose `keys`; the value is `<signKey>.<agreeKey>.<issuedAt>`, with `|issuedAt − now| ≤ 300`. This replaces the binary `pkey-devkey/1`; its vectors move to `device-proof.json`.

**Rules:**

- §2.2 step 4 applies to both keys.
- `agreeKey` is unique per product.
- A device may rotate at most 4 times a day (an RL bucket).
- A rotation bumps `key_seq` and raises `onDeviceChange("keys")`.
- When a device is removed or purged, its row goes too.

**Registration.** Core owns `registerDeviceKeys(db, product, deviceId, {signKey, agreeKey}, {via: "put"|"exchange"|"nearby"})`, `deviceSignKey`, `accountDeviceKeys` and `verifyDeviceSignature`. The routes `deviceKeys` and keyring are both `CORE_ROUTES` rows in `src/publicRoutes.ts`, matched before `/devices/{deviceId}`. Every registration carries both keys.

**Generation and use.** Keys are generated on first need: Connect, or the auto-sign-in plan's
device-bound nonce. They are not generated at launch.

**Discovery.** `core.endpoints.deviceKeys` is added.

### 2.9 Everything else on the wire

**Corpus** (`tools/sign-corpus.ts`; the Godot mirror is automatic; `conformance/README.md:82` lists
the files):

- **`cases.json`** gains three sections, from `tools/corpus/peer.ts` and the independent
  `tools/corpus/reference/peer.ts`:
  - `peerCertCases` (about 36): valid; wrong `typ`; `aud` or `sub` mismatch; expired, future or
    over-long lifetime; signed by a release key; non-canonical or low-order keys; integer edges;
    unknown members ignored; missing members;
  - `ringCases` (about 28): unsorted; duplicate id; empty; 129 devices; epoch 0; non-integer epoch;
    expired; replacement lower, equal and higher;
  - `peerAdmissionCases` (about 16): certificate plus held ring to a verdict.
- **New file `noise-vectors.json`** (Noise's own JSON test-vector format, hex fields):
  - RFC 7748 X25519 vectors and an AES-256-GCM subset of NIST CAVP (R-1);
  - the 7 low-order points;
  - modes `a`, `v` and `p` with fixed ephemerals;
  - rekey;
  - vendored external `Noise_XX_25519_AESGCM_SHA256` vectors (the external anchors are swapped to the AESGCM name) (source URL and SHA-256
    under `tools/corpus/inputs/`) that anchor the reference.
  - The reference implementation is `tools/corpus/reference/noise.ts` over `node:crypto`, which
    keeps it independent of client-core's WebCrypto.
- **New file `peer-matrix.json`**, about 120 rows:
  - `adverts`: K_disc, epoch and deviceId to a name; TXT parsing;
  - `prologue`;
  - `psk`;
  - `sas`;
  - `frames` (TCP);
  - `records`: flags, `MORE`, critical rules, mode rules and the 1 MiB limit;
  - `relayEnvelopes`;
  - `handshakePayloads`;
  - `sas`: the code, with commit and reveal rows (R-3). The device proof is not here: it lives in `device-proof.json` (R-6).

**Transcripts** (`pnpm gen transcripts`): `device-keys-register`, `device-keys-invalid-pop`,
`discovery-connect`, `connect-disabled`, `connect-identity`, `connect-keys-required`,
`connect-devices`, `connect-relay-ticket`, `connect-relay-quota`.

**`errors.json`:**

| Kind                  | Codes                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wire`                | `device_keys_invalid` (core, 400) · `device_keys_required` (connect, 409) · `relay_disabled` (403) · `relay_paused` (503 with `Retry-After`) · `relay_quota_exceeded` (429, `scope` person or product) · `relay_ticket_invalid` (401, WebSocket 4001). `account_required` and `not_found` are reused |
| new kind `peer` (D10) | `peer_revoked`, `peer_expired`, `peer_bad_frame`, `peer_unknown_critical`, `peer_not_allowed`, `peer_busy`, `peer_bye`. Sent between SDKs in a CLOSE; the Worker never emits them. Needs an `errors.schema.json` enum change and `gen-sdk-constants` support                                         |
| `client`              | `connect-unavailable`, `nearby-permission-denied`, `nearby-unsupported`, `peer-handshake-failed`, `peer-cert-invalid`, `peer-closed`                                                                                                                                                                 |

**`features.json`.** A new family, `connect` ("Cloud Connect"):

- `connect.identity` (corpus and transcript);
- `connect.noise` (`noise-vectors.json`);
- `connect.protocol` (`peer-matrix.json`);
- `connect.lan`: N/A on `web` (a browser has no LAN discovery or sockets) and on `desktop-bridge`
  (the host's Node SDK does it);
- `connect.relay`;
- `connect.links` (N/A on `web`);
- `connect.transfer`;
- `connect.app`.

`devices.keys` goes in the `devices` family, service `core`. `connect.vouch` is dropped: nearby approval is `identity.nearby` (R-13), and the `pkey-peer/1` engine and the LAN adapters ship in a module that Identity and Connect both load.

**API rows.** `api.json` gets `cloudConnect.*` concepts: `start`, `stop`, `peers`, `devices`,
`open`, `onChannel`, `nearby.request`, `nearby.onRequest`, and `links.pair` (reserved for CC-19).

**Catalog and manifest** (rule 9):

- **Product file.** `.pkey/product` gains `modules.connect` and a `connect: {relay: boolean,
interAccount: boolean}` block. Its members are claimable settings, like the `identity` block.
- **Schema.** `product.schema.json` gets `$defs.connect` and adds the slug to `$defs.modules`.
- **Validator codes and mutation rows** (`schema-parity.test.ts`):
  - `invalid_connect` (`schema: "rejects"`);
  - `connect_block_without_service`, a warning (`accepts`);
  - `connect_requires_identity` (`accepts`), also added to `validateServices` and
    `SERVICE_ERROR_MESSAGES`.
- **Reserved entitlement.** `pkey.cloudConnect.relayBytes` (an integer, `injected: false`): the
  relay bytes a person may use per UTC day.
- **Catalog constants.** The new `shared-catalog/src/cloudConnect.ts` holds:
  - `CLOUD_CONNECT_DEFAULTS`: `relayBytesPerDay` 256 MiB, `unlicensedRelayBytesPerDay` 16 MiB, and
    the socket, frame and rate numbers above;
  - `CLOUD_CONNECT_CEILINGS`: `perPerson.relayBytesPerDay` 4 GiB and
    `perProduct.relayBytesPerMonth` 500 GiB.

**Settings** (`pnpm gen settings`):

| Scope    | Setting                                | Ownership | Default         | Notes                            |
| -------- | -------------------------------------- | --------- | --------------- | -------------------------------- |
| Product  | `cloudConnect.relay.enabled`           | claimable | true            |                                  |
| Product  | `cloudConnect.interAccount`            | claimable | false           |                                  |
| Product  | `cloudConnect.ceiling.relayBytes`      | operator  | 500 GiB a month | Confirm L2 to raise, L1 to lower |
| Platform | `cloudConnect.quota.defaultRelayBytes` |           | 256 MiB a day   |                                  |
| Platform | `cloudConnect.relayPaused`             |           |                 | Kill switch                      |

**Routes** (rule 10):

- **Core:** `PUT /<p>/devices/keys`, matched before `/devices/<id>` (`router.ts:263-273,337`), with
  a row in the `routeCoverage` core table.
- **Connect** (its routes table is the descriptor `surface`):
  - `GET /<p>/connect/identity`;
  - `GET /<p>/connect/devices` (the roster with labels, platforms and last seen; display data);
  - `POST /<p>/connect/relay/ticket`;
  - `GET /<p>/connect/relay` (101 Upgrade).
- **OpenAPI.** Each route goes in `openapi/polaris-key.v3.yaml`, and `connect` joins
  `services.required`.
- **Admin:** `/manage/api/products/<slug>/connect/{usage, people, people/<subject>/devices}`, in RBAC
  area `connect` (`test/fixtures/rbac-route-areas.json`) and the route ledger.

**Discovery.** `services.connect` is `{"enabled":false}` when the service is off. When it is on:

```jsonc
{
  "enabled": true,
  "lan": true,
  "relay": true,
  "interAccount": false,
  "endpoints": { "identity": "…", "devices": "…", "ticket": "…" },
}
```

An endpoint stays `null` until the release that serves it.

**D1 tables** (`TABLE_OWNERS`, one statement per migration file, each with a rollback script):

| Owner   | Table                 | Columns                                                                                                                                          | Notes                                  |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| core    | `device_keys`         | `product`, `device_id`, `sign_key`, `agree_key`, `key_seq`, `created_at`, `rotated_at`; PK `(product, device_id)`; unique `(product, agree_key)` | Written only by `core/devices/keys.ts` |
| connect | `connect_rings`       | `product`, `subject`, `epoch`, `members_hash`, `disc_key`, `prev_disc_key`, `prev_epoch`, `bumped_at`; PK `(product, subject)`                   | A subject store (`connect.rings`)      |
| connect | `connect_relay_daily` | `product`, `day`, `bytes`, `sessions`; PK `(product, day)`                                                                                       | Counters only, no subject              |

The migrations are `00XX_device_keys.sql`, `00XX_connect_rings.sql` and
`00XX_connect_relay_daily.sql`. The lead numbers them at merge.

**Durable Object.**

- `ConnectRelayDO` lives in `services/connect/do/relayDo.ts` and is re-exported from `src/index.ts`.
- It is SQLite-backed, with tables `usage(day, bytes)` and `pending(bytes, sessions)`. An alarm
  flushes `pending` into `connect_relay_daily` every 60 s while the room is active.
- Wrangler: a top-level `[[migrations]] tag = "v5"` with `new_sqlite_classes = ["ConnectRelayDO"]`,
  plus a `CONNECT_RELAY` binding at the top level and in `prod`, `staging`, `dev` and `test`.
- `Env.CONNECT_RELAY?` is tagged `@inventory binding stores`. While it is unbound, discovery says
  `relay: false`.
- `idFromName` is called only in `services/connect/do/client.ts`.
- The subject store declares `durableObjects: ["ConnectRelayDO"]`.

**Quotas (O-2).** A person's relay bytes per day come from `pkey.cloudConnect.relayBytes` on the
anchor licence. Without it they come from the platform default; a device with no usable licence
gets 16 MiB. The value is clamped to 4 GiB. The product month total is checked at ticket time and
on each alarm. The LAN is never metered.

The cost is negligible: 1 GB in 64 KiB frames is about 820 billable requests, at the 20:1 incoming
WebSocket rate, plus active DO time.

## 3. Per-SDK work

Every SDK runs the same corpus sections and the `connect-*` transcripts, and gets `parity.json`
rows. Pins are exact. Every new package was released at least 14 days ago (checked on 2026-10-24).

| SDK (WP)                           | Discovery adapter                                                                                                                            | Pipe                                                                                               | Crypto (pinned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Key storage                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| client-core (CC-04, CC-05)         | none (it does no I/O)                                                                                                                        | none: it supplies the session engine, records, envelopes, adverts, SAS and PoP                     | WebCrypto X25519, Ed25519, HMAC and HKDF; WebCrypto AES-256-GCM through an `Aead` port (no new dependency)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | supplied by the host                                                               |
| Node and Electron main (CC-08)     | `multicast-dns@7.2.5` (2022-05-16, an optionalDependency), with our own PTR/SRV/TXT layer                                                    | `node:net` TCP; global `WebSocket` (Node ≥22)                                                      | `node:crypto` (X25519, Ed25519, `aes-256-gcm`) injected into the port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the existing keyring store (`@napi-rs/keyring` 2.1.0) or the file store            |
| React and browser (CC-09)          | none                                                                                                                                         | relay only in v1; WebRTC is CC-21                                                                  | WebCrypto non-extractable keys; AES-256-GCM. Floor: Chrome 137, Firefox 130, Safari 17                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | IndexedDB, non-extractable `CryptoKey`; desktop-bridge goes to the host's Node SDK |
| Python (CC-10)                     | extra `connect`: `zeroconf==0.148.0; python_version<"3.10"`, `zeroconf==0.151.5; python_version>="3.10"`                                     | `asyncio` TCP; `websockets==15.0.1` (<3.10), `==16.1.1` (3.10), `==17.2` (≥3.11)                   | `cryptography` (existing, `>=41`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the existing keyring store                                                         |
| Swift (CC-11)                      | `NWBrowser` and `NWListener` (Bonjour; `includePeerToPeer` gives AWDL Apple-to-Apple)                                                        | `NWConnection` TCP; `URLSessionWebSocketTask`                                                      | CryptoKit (`Curve25519.KeyAgreement` and `.Signing`, `AES.GCM`, `HKDF<SHA256>`); no new dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronizable |
| Kotlin JVM (CC-12)                 | `org.jmdns:jmdns:3.6.1` (2025-03-16)                                                                                                         | sockets; OkHttp 4.12.0 WebSocket (existing)                                                        | JCA on JDK 17 (XDH, Ed25519, `AES/GCM/NoPadding`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the existing OS keyring store (UK-40)                                              |
| Android (CC-12b)                   | `NsdManager` in `:platform` (standalone, so Godot links it)                                                                                  | sockets; OkHttp WebSocket                                                                          | Tink 1.23.0 `subtle.X25519` (existing); JCA `AES/GCM/NoPadding` (Conscrypt, every API level); the existing Ed25519 backend (P6-12).                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keystore-wrapped (P5-06)                                                           |
| Godot (CC-13 spike, CC-14, CC-14b) | Windows and Linux: GDScript mDNS over `PacketPeerUDP`, if CC-13 passes. Apple: `pkey_apple` `NWBrowser`. Android: `:platform` NSD. Web: none | `StreamPeerTCP` and `TCPServer`; `WebSocketPeer` (relay, `supported_protocols` carries the ticket) | Apple: CryptoKit ops (AES-GCM, X25519, Ed25519, HPKE) on `PolarisKeyPlatformC`, with a binary entry point beside the JSON `pkp_call` for bulk data. Windows: BCrypt AES-GCM and HKDF, plus Monocypher **4.0.3** (2026-06-15; CC0/BSD-2; pinned with its SHA-256 in `deps.env`) in `pkey_win` for the curves only. Android: `:platform`. Web: WebCrypto through `JavaScriptBridge`. Linux and the editor: GDScript (keystream from native `AESContext` ECB, GDScript XOR and a constant-time GHASH), only after CC-13 passes; Sync files of at most 32 MiB. No Linux GDExtension in v1 (R-12). | the existing keyring stores (SP-27)                                                |

**Permission prompts (L-11).** A prompt is requested only when the person first turns on a nearby
feature, never at launch. The kit shows one pre-prompt line before the OS prompt ("Find your other
devices on this network"). The copy gets a UX review.

| Platform                    | Prompt                                                           | Developer declares                                                                                           |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| iOS, iPadOS, tvOS, visionOS | Local Network                                                    | `NSLocalNetworkUsageDescription`; `NSBonjourServices = [_pkeypeer._tcp]` (the Godot export plugin adds both) |
| macOS 15+ (apps, Electron)  | Local Network. Tools run from Terminal are exempt                | the same keys. Sandboxed apps also need `network.client` and `network.server`                                |
| Android, `targetSdk ≥ 37`   | Nearby devices (`ACCESS_LOCAL_NETWORK`). Declared in the AAR now | nothing extra                                                                                                |
| Windows                     | Defender Firewall on the first listen                            | none                                                                                                         |
| Linux                       | none                                                             | none                                                                                                         |
| Chrome Local Network Access | not applicable in v1: browsers use the relay                     | none                                                                                                         |

## 4. Console, docs, Help, PRIVACY, THREAT-MODEL

**Console (CC-16).** A `connect` section with the Cloud Connect accent (`brand/src/tokens/services.ts`)
and three pages:

- **Setup:** the switch; the relay and inter-account switches; the product ceiling dialog
  (`CeilingDialog`'s pattern); and the platform default, read-only.
- **Usage:** relay bytes per day, rooms, and people with linked devices.
- **Linked devices:** people, paged by subject. Each person's roster shows label, platform, keys
  since, certificate expiry, last relay and ring epoch. Unlinking is the existing device
  deauthorise action, linked from here. v1 adds no new destructive action.

The tier relay quota is the reserved key `pkey.cloudConnect.relayBytes` in the tier editor. The
Users page (I-12) links to the person's linked devices. The section gets a UX review (BUILT).

**Docs (CC-17).** `features/cloud-connect/` holds `index`, `nearby`, `relay`, `channels`,
`sign-in-nearby` and `link-accounts`. Also:

- `reference/protocol/peer.md`, pointing to V5 §15;
- all the new glossary entries in one `start/concepts.md` edit (rule 4, R-14): linked device, device certificate, roster, relay, nearby device;
- `site-map.json` rows;
- snippet lanes in `covered.ts`.

**Help.** End users see "Polaris Locker" and never the service name.

- New `help/nearby-devices.mdx` ("Use your devices together"): what links, the prompts, how to turn
  it off.
- `help/approve-a-sign-in.mdx` (the nearby approval) is owned by I-50, not CC-17 (R-14).
- `help/devices.md` gains "removing a device unlinks it".
- `help/link-with-someone.mdx` arrives with CC-19.

**PRIVACY.md.** A new section, "Cloud Connect — your devices finding each other":

- Collected: two public keys per device and the ring epoch. Relay counters are per product and day,
  with no subject. The DO keeps a person's day bytes and live presence. Content is end-to-end
  ciphertext.
- Adverts carry the service type, a rotating name and `v`/`m`/`h` only.
- The residual leaks are named: the OS host name, the MAC address and the IP address on the LAN.
- Retention:
  - `device_keys` lives until the device is removed;
  - `connect_rings` lives until per-product removal or account deletion;
  - relay counters are kept 90 days.
- Admin view: rosters with labels, never content.

**THREAT-MODEL.md.** A new section, "Cloud Connect (CC-03…CC-20)", with these rows:

- **LAN spoofing and MITM.** Product-key certificates; the PSK keeps non-members out; SAS in modes
  `v` and `p`; the prologue binds product and mode.
- **Relay abuse.** It is not an open relay: a ticket is needed, `from` is stamped, only roster
  members are admitted, rates and quotas apply, and a frame is at most 64 KiB. A DoS inside one's
  own room stays in one's own account.
- **Downgrade.** There is one suite; the version and mode are in the prologue; `caps` travel
  encrypted; TXT `v` is never trusted.
- **Revocation.** Epoch bump, RING push, the relay check at connect, and certificate expiry of at
  most 7 days. A removed device's PSK fails at the next epoch.
- **Key loss.** A reinstall gets new keys and a new certificate; a lost device is removed in Locker,
  which bumps the ring. Connect has no recovery secret (P-3 is Cloud Sync's).
- **Vouch relay-phishing (R1-07, R8-03).** The vouch is LAN only and needs the SAS on both screens
  and a tap. The approval is server-recorded and bound to the requester's PoP-proven keys, then
  audited and emailed. The same-network check is required of the auto-sign-in route (§10).
- **Inter-account.** No subject is exchanged. It is LAN only, every data category needs its own
  approval, and a link is revocable locally.
- **Signer.** Two new `typ`s go under the P3-12 signer guard.
- **GDScript timing.** Gated by CC-13. Mobile and bulk traffic stay native.
- **Responder identity hiding** (C2).
- **Worker-trust residual for mode `a` (R-9, owner Q6).** A compromised Worker could sign a certificate and add a device to a person's account, so channels between a person's own devices trust the Worker. Sync keys never cross mode `a` (KEYRING_WRAP is mode `v` only), so Cloud Sync stays end-to-end. A later package may bind channels to the sync key.
- **Login CSRF (R-2 step 9).** A hostile approver on the same LAN could sign D into another account. D's form shows "Signed in as {email}" with "Not you?".
- **Commit-reveal SAS (R-3).** A forged-code man in the middle succeeds with probability about 10^-6 per attempt, at 5 handshakes a minute per advert.

## 5. Work packages

Phase entry:
`{"id":"CC","title":"Cloud Connect: device keys, peer certificates, LAN discovery, encrypted channels, the relay and inter-account links (_lead/plans/plan-cloud-connect.md)"}`.
Every row is `"repo":"polaris-key"` and `"status":"todo"`, except CC-01, which is
`awaiting-approval`. `brief` is `wp/<ID>-<slug>.md`.

```jsonc
{"id":"CC-01","title":"Combined plan: automatic sign-in, Cloud Connect and Cloud Sync (owner approval 2026-10-26)","phase":"CC","lane":"corpus","role":"pkey-wire-planner","estimateWeeks":[0.2,0.3],"deps":[],"planMode":true,"gates":["plan-mode","human-approval","threat-model","protocol-version"],"humanInputs":["owner approval of plan-combined.md §3"],"optional":false,"refs":["_lead/plans/plan-cloud-connect.md","_lead/plans/linking-sync-contract.md","_lead/plans/research-device-linking.md §7-§11"]}
{"id":"CC-02","title":"Cloud Connect service row, descriptor, coherence, manifest block, settings and console stub","phase":"CC","lane":"worker","role":"pkey-implementer","estimateWeeks":[0.5,0.7],"deps":["CC-01"],"planMode":false,"gates":["new-service","rule-9","rule-10","drift-gate","docs-generated","docs-links","console-csp-parity"],"humanInputs":["confirm production tolerates unknown slugs (layout.md step 1)"],"optional":false,"refs":["plan §2.9","contribute/layout.md#adding-a-service"]}
{"id":"CC-03","title":"Device keys in Core: device_keys, PUT /<p>/devices/keys, registerDeviceKeys, lifecycle event (R-7), pkey-proof/1 and device-proof.json (.4)","phase":"CC","lane":"worker","role":"pkey-implementer","estimateWeeks":[0.8,1.0],"deps":["CC-01","CC-04"],"planMode":true,"gates":["migration","table-owners","rule-10","drift-gate","threat-model","workerd","docs:privacy","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.8","contract P-1, L-13"]}
{"id":"CC-04","title":"Wire v5: WIRE-CONTRACT-V5, pkey-peer+jws and pkey-ring+jws, corpus sections, client-core verify","phase":"CC","lane":"corpus","role":"pkey-implementer","estimateWeeks":[0.9,1.2],"deps":["CC-01"],"planMode":true,"gates":["plan-mode","protocol-version","corpus","corpus-runner","corpus:mirror","drift-gate","all-sdks","threat-model","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.1-§2.3, §2.9"]}
{"id":"CC-05","title":"pkey-peer/1: Noise vectors, peer matrix, client-core session engine","phase":"CC","lane":"corpus","role":"pkey-implementer","estimateWeeks":[0.9,1.2],"deps":["CC-04"],"planMode":true,"gates":["plan-mode","corpus","corpus-runner","corpus:mirror","drift-gate","all-sdks","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.4-§2.7"]}
{"id":"CC-06","title":"Connect identity on the Worker: certificates, rings, discovery keys, linked-devices route","phase":"CC","lane":"worker","role":"pkey-implementer","estimateWeeks":[0.6,0.8],"deps":["CC-02","CC-03","CC-04"],"planMode":true,"gates":["migration","table-owners","rule-10","rule-6","drift-gate","threat-model","workerd","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.2-§2.4"]}
{"id":"CC-07","title":"Relay Durable Object: ConnectRelayDO, tickets, quotas, meter, RING pokes","phase":"CC","lane":"worker","role":"pkey-implementer","estimateWeeks":[0.9,1.2],"deps":["CC-06"],"planMode":true,"gates":["wrangler","migration","table-owners","rule-10","drift-gate","threat-model","workerd","security-review"],"humanInputs":["quota numbers (O-2)"],"optional":false,"refs":["plan §2.7"]}
{"id":"CC-08","title":"Node SDK Cloud Connect: LAN (multicast-dns), TCP, relay, cloudConnect API","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.7,0.9],"deps":["CC-05","CC-06","CC-07","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","drift-gate","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3"]}
{"id":"CC-09","title":"React and browser Cloud Connect: WebCrypto keys, relay-only channel, useCloudConnect","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.4,0.6],"deps":["CC-08","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","ci","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3"]}
{"id":"CC-10","title":"Python Cloud Connect: cryptography Noise, zeroconf, asyncio, websockets","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.6,0.8],"deps":["CC-05","CC-07","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3"]}
{"id":"CC-11","title":"Swift Cloud Connect: CryptoKit, Network.framework Bonjour and AWDL, Keychain, prompts","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.7,0.9],"deps":["CC-05","CC-07","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","ci:macos","security-review"],"humanInputs":["two Apple devices on one LAN for e2e"],"optional":false,"refs":["plan §3"]}
{"id":"CC-12","title":"Kotlin JVM :connect module: JCA Noise, JmDNS, OkHttp relay, :conformance","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.7,0.9],"deps":["CC-05","CC-07","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","ci:kotlin","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3"]}
{"id":"CC-12b","title":"Android Cloud Connect: :platform NSD, local-network permission, Godot primitives","phase":"CC","lane":"native","role":"pkey-sdk-porter","estimateWeeks":[0.6,0.8],"deps":["CC-12"],"planMode":false,"gates":["ci:android","security-review"],"humanInputs":["Android 16 and 17 devices"],"optional":false,"refs":["plan §3, C7"]}
{"id":"CC-13","title":"Spike: GDScript X25519, Ed25519 sign, the AES-GCM lane speed and timing (desktop, ARM), mDNS coexistence (L-10)","phase":"CC","lane":"spike","role":"pkey-spike-runner","estimateWeeks":[0.3,0.4],"deps":[],"planMode":false,"gates":["security-review"],"humanInputs":["a Windows, a Linux and an ARM device"],"optional":false,"refs":["contract L-10","research §10.10"]}
{"id":"CC-14","title":"Godot Cloud Connect, GDScript lane: Noise, records, desktop mDNS, TCP, WebSocketPeer relay","phase":"CC","lane":"godot","role":"pkey-godot-engineer","estimateWeeks":[0.8,1.1],"deps":["CC-13","CC-07","CC-26"],"planMode":false,"gates":["all-sdks","corpus-runner","corpus:mirror","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3"]}
{"id":"CC-14b","title":"Godot native lanes (R-12): CryptoKit and BCrypt AES-GCM and X25519 ops, Monocypher in pkey_win only, NWBrowser, Android :platform","phase":"CC","lane":"native","role":"pkey-godot-engineer","estimateWeeks":[0.8,1],"deps":["CC-14","CC-12b","CC-26"],"planMode":false,"gates":["ci:macos","ci:windows","ci:android","security-review"],"humanInputs":[],"optional":false,"refs":["plan §3, C6"]}
{"id":"CC-15","title":"Nearby mode v in all SDKs: adverts, SAS, VOUCH_*, cloudConnect.nearby.* (protocol and API only, no UI)","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.8,1],"deps":["CC-08","CC-10","CC-11","CC-12b","CC-14","I-40"],"planMode":false,"gates":["all-sdks","threat-model","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.5-§2.6, §10","THREAT-MODEL R1-07"]}
{"id":"CC-16","title":"Console Cloud Connect section: setup, usage, linked devices","phase":"CC","lane":"console","role":"pkey-implementer","estimateWeeks":[0.6,0.8],"deps":["CC-06","CC-07"],"planMode":false,"gates":["rule-10","console-csp-parity","ui-snapshots","modernity-lint","pkey-ux-reviewer"],"humanInputs":[],"optional":false,"refs":["plan §4"]}
{"id":"CC-17","title":"Cloud Connect docs, Help (nearby-devices), PRIVACY, THREAT-MODEL and all new glossary entries","phase":"CC","lane":"docs","role":"pkey-implementer","estimateWeeks":[0.5,0.7],"deps":["CC-08"],"planMode":false,"gates":["docs-links","docs-generated","docs:privacy","threat-model"],"humanInputs":[],"optional":false,"refs":["plan §4"]}
{"id":"CC-18","title":"Security review of Cloud Connect before production: cross-subject, relay abuse, revocation, vouch","phase":"CC","lane":"worker","role":"pkey-implementer","estimateWeeks":[0.4,0.6],"deps":["CC-07","CC-08","CC-15"],"planMode":false,"gates":["threat-model","security-review"],"humanInputs":[],"optional":false,"refs":["plan §7"]}
{"id":"CC-19","title":"Inter-account links: mode p SAS pairing, CONTACT, mode c, product opt-in, kit approval UI","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.9,1.2],"deps":["CC-15"],"planMode":true,"gates":["plan-mode","all-sdks","corpus","threat-model","pkey-ux-reviewer","security-review"],"humanInputs":[],"optional":false,"refs":["contract P-7, L-9"]}
{"id":"CC-20","title":"Direct Transfer: peer-to-peer data between Cloud Connect peers (LAN or relay)","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.7,0.9],"deps":["CC-15"],"planMode":true,"gates":["plan-mode","all-sdks","corpus","security-review"],"humanInputs":[],"optional":false,"refs":["plan §2.6"]}
{"id":"CC-21","title":"WebRTC data channels for browsers (signalling over the relay, STUN)","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[0.7,1],"deps":["CC-09"],"planMode":true,"gates":["plan-mode","rule-10","security-review"],"humanInputs":[],"optional":true,"refs":["research §5.2"]}
{"id":"CC-22","title":"Native fast paths: tvOS DeviceDiscoveryUI, Wi-Fi Aware, Nearby Connections (Play flavour)","phase":"CC","lane":"native","role":"pkey-sdk-porter","estimateWeeks":[0.8,1.2],"deps":["CC-11","CC-12b"],"planMode":false,"gates":["ci:macos","ci:android"],"humanInputs":["Wi-Fi Aware hardware"],"optional":true,"refs":["research §6"]}
{"id":"CC-23","title":"QR pairing, CPace, server-recorded contact links","phase":"CC","lane":"sdk","role":"pkey-wire-planner","estimateWeeks":[0.3,0.5],"deps":["CC-19"],"planMode":true,"gates":["plan-mode","threat-model"],"humanInputs":[],"optional":true,"refs":["contract L-9"]}
{"id":"CC-24","title":"Relay mailbox: HPKE-sealed messages to offline devices","phase":"CC","lane":"worker","role":"pkey-wire-planner","estimateWeeks":[0.3,0.5],"deps":["CC-07"],"planMode":true,"gates":["plan-mode","threat-model"],"humanInputs":[],"optional":true,"refs":["contract L-8"]}
{"id":"CC-25","title":"Noise IK fast reconnect for known peers","phase":"CC","lane":"corpus","role":"pkey-implementer","estimateWeeks":[0.5,0.7],"deps":["CC-05"],"planMode":true,"gates":["plan-mode","corpus","all-sdks"],"humanInputs":[],"optional":true,"refs":["plan C16, D3"]}
{"id":"CC-26","title":"Device-key store in each SDK: ensure, publicKeys, sign, dh (.1 client-core, proof helper and browser IndexedDB; .2 Node; .3 Python; .4 Swift; .5 Kotlin JVM and Android; .6 Godot GDScript Ed25519 sign and X25519; .7 Godot native)","phase":"CC","lane":"sdk","role":"pkey-sdk-porter","estimateWeeks":[1.3,1.7],"deps":["CC-03"],"planMode":false,"gates":["all-sdks","corpus-runner","security-review"],"humanInputs":[],"optional":false,"refs":["plan-combined.md R-5"]}
```

**Totals.** The required path (CC-01 to CC-20) is about 15.5–20.5 engineer-weeks. The optional
packages add about 2.6–3.9. The critical path is CC-01 → CC-04 → CC-05 → CC-06 → CC-07 → CC-08 →
CC-15 → CC-18, about 6.8–8.6 weeks.

## 6. First wave: ≤60-minute slices

_Combined program (2026-10-26): the waves and dependencies are plan-combined.md §4; this table's slices stand._

**Wave 1** is CC-02, CC-03, CC-04, CC-05, CC-06, CC-07 and CC-08 (Node is the first end-to-end
SDK), plus CC-13. **Wave 2** is the other SDKs, CC-15, CC-16 and CC-17. **Wave 3** is CC-18 to CC-20.

| Slice   | Goal                                                                                                                                                                                                                                                                                                         | Tests and gates                                                                                   | Depends on                | Size |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------- | ---- |
| CC-02.1 | Add the `services.json` row (slug `connect`, label "Cloud Connect", `requires: ["identity"]`, group `cloud-connect`, accent `connect`, icon `Radar`) and run `gen services`. Add `services/connect/` (descriptor, empty routes), `mount.ts`, `connect_requires_identity` and the slug in `services.required` | `serviceTable`, `boundaries`, `routeCoverage`, `schema-parity`; `gen services --check`            | staging                   | 60   |
| CC-02.2 | The manifest `connect` block (schema, the three codes, mutation rows); `cloudConnect.ts` constants; the reserved key; the product and platform settings slices                                                                                                                                               | `schema-parity`, `reservedNames`, settings tests; `gen settings skills docs-reference --check`    | .1                        | 60   |
| CC-02.3 | The console `SECTIONS` stub and page, brand accent and `SERVICE_ICONS`; the docs `features/cloud-connect/index.md` and the `doors.ts` group; the `features.json` family; the AGENTS repo notes; the `layout.md` fix (C12)                                                                                    | admin unit, `services.test` (brand); `gen brand parity --check`; docs build and `check:links`     | .1                        | 60   |
| CC-03.1 | Migration `00XX_device_keys.sql` (and the index file) with rollback; `TABLE_OWNERS`; `core/devices/keys.ts` (get, upsert, delete, `accountDeviceKeys`, `verifyKeyPop`); delete on device purge                                                                                                               | new `core/devices/keys.test.ts`, `tableCrossings`, migration ledger; `gen docs-reference --check` | staging                   | 60   |
| CC-03.2 | The `PUT /<p>/devices/keys` route (PoP, ±300 s, 4 a day, unique `agreeKey`); `core.endpoints.deviceKeys`; `device_keys_invalid` in `errors.json`; OpenAPI; transcripts                                                                                                                                       | route tests, `routeCoverage`; `gen constants transcripts --check`                                 | .1                        | 60   |
| CC-03.3 | `contributes.onDeviceChange` (`bound`, `unbound`, `removed`, `keys`), called after the write from `writeDeviceSubject`, `retireDeviceBinding`, deauthorise, purge and key upsert; never fails the request                                                                                                    | `contributions.test`, a new `deviceChange.test`, `boundaries`                                     | .1                        | 60   |
| CC-04.1 | `WIRE-CONTRACT-V5.md` (V4 copy; §2 table; §15 = plan §2); V4 header "Superseded"; `PROTOCOL_VERSION = 5`; AGENTS rule 2; `gen constants`                                                                                                                                                                     | `gen constants --check`; constants tests in each SDK, run by CI                                   | staging                   | 60   |
| CC-04.2 | `shared-protocol/src/connect.ts` (types and constants); two new members of `JwsTyp` and the V3 comments (C13); signer write checks for the new `typ`s in `core/signing.ts`                                                                                                                                   | `shared-jws`, `sign-guard`, `signing` tests                                                       | .1                        | 60   |
| CC-04.3 | `tools/corpus/reference/peer.ts` and `tools/corpus/peer.ts`: the `peerCertCases`, `ringCases` and `peerAdmissionCases` sections; `gen corpus` (with the mirror)                                                                                                                                              | `gen corpus --check`, generator self-check                                                        | .2                        | 60   |
| CC-04.4 | client-core `peer/cert.ts` (`verifyPeerCert`, `verifyRing`, `admitPeer`); the Node and browser runners for the three sections                                                                                                                                                                                | `corpusV2.test`, `pnpm test:browser`                                                              | .3                        | 60   |
| CC-05.1 | `reference/noise.ts` (`node:crypto`); `noise-vectors.json`, with the external XX anchors vendored under `tools/corpus/inputs/`; driver and `conformance/README` lists                                                                                                                                        | `gen corpus --check`                                                                              | CC-04.3                   | 60   |
| CC-05.2 | client-core `peer/noise.ts` (XX, XXpsk0, CipherState, rekey, the low-order refusal); the `Aead` port on WebCrypto AES-GCM (no noble); the runner                                                                                                                                                             | new `noiseVectors.test` (Node and browser)                                                        | .1                        | 60   |
| CC-05.3 | `reference/peerMatrix.ts` and `peer-matrix.json` (all §2.9 sections)                                                                                                                                                                                                                                         | `gen corpus --check`                                                                              | .1                        | 60   |
| CC-05.4 | client-core `peer/{advert,sas,frame,record,relay,pop,session}.ts`; the session state machine per mode; the runner                                                                                                                                                                                            | new `peerMatrix.test`; an in-memory two-session test                                              | .2, .3                    | 60   |
| CC-06.1 | `00XX_connect_rings.sql`; `TABLE_OWNERS`; `services/connect/ring.ts` (members through the principal rule, `members_hash`, epoch bump with a new K_disc, ring signing); the subject store `connect.rings`; `productDeletion`                                                                                  | `ring.test`, `subjectStores` guard, `tableCrossings`                                              | CC-02.1, CC-03.1, CC-04.2 | 60   |
| CC-06.2 | The routes `GET /connect/identity` and `GET /connect/devices`; the `services.connect` discovery member; `device_keys_required`; transcripts                                                                                                                                                                  | route tests, `routeCoverage`; `gen transcripts constants --check`                                 | .1                        | 60   |
| CC-06.3 | The `onDeviceChange` listener: bump the epoch and call the relay-poke port (a no-op until CC-07.4); audit `connect.ring.bump`                                                                                                                                                                                | `ringListener.test`                                                                               | .1, CC-03.3               | 45   |
| CC-07.1 | `services/connect/relay/engine.ts`, pure: admission, SEND to RECV with a stamped `from`, MEMBERS and GONE, socket caps, the token bucket, person and day bytes, LIMIT                                                                                                                                        | `relayEngine.test`                                                                                | CC-05.3                   | 60   |
| CC-07.2 | The `ConnectRelayDO` shell (hibernation, tags, SQLite usage, alarm flush); `00XX_connect_relay_daily.sql`; wrangler `v5` and the five bindings; the `Env` member; `src/index.ts` export; the DO mock                                                                                                         | `relayDo.test`, `platformInventory`; `gen platform-inventory --check`                             | .1                        | 60   |
| CC-07.3 | The ticket route (`relay-ticket` kind, quota resolution, relay setting, pause, product ceiling); the upgrade route (subprotocol ticket, consume, forward); the four `relay_*` codes; OpenAPI; transcripts                                                                                                    | route tests, `routeCoverage`, `singleUse`; `gen transcripts constants --check`                    | .2, CC-06.2               | 60   |
| CC-07.4 | The `test:workerd` smoke (upgrade, two sockets, SEND and RECV, hibernation wake); the RING poke wired to CC-06.3                                                                                                                                                                                             | `test:workerd`                                                                                    | .3, CC-06.3               | 45   |
| CC-08.1 | Node: keys (`node:crypto`), registration on first need, identity fetch, verify and store `pkey.connect.v1`; transcript replays                                                                                                                                                                               | `sdk-node` connect tests, transcript replays                                                      | CC-05.4, CC-06.2          | 60   |
| CC-08.2 | Node: the `multicast-dns@7.2.5` adapter (advertise and browse, the epoch timer), the TCP listener, sessions; a loopback test with two clients in one process                                                                                                                                                 | `lan.e2e.test` (loopback interface)                                                               | .1                        | 60   |
| CC-08.3 | Node: the relay client (ticket, envelope, reconnect), LAN-then-relay order, the `cloudConnect` API; `api.json` and `parity.json` rows                                                                                                                                                                        | `relay.test` against the CC-07 engine; `gen api parity --check`                                   | .2, CC-07.3               | 60   |
| CC-13.1 | GDScript X25519 ladder, Ed25519 sign and the AES-GCM lane (native ECB keystream, GDScript XOR and GHASH) prototypes; timings on desktop and ARM; a dudect-style timing-variance test; recommend GDScript or native per platform                                                                              | a measurement report (`notes/CC-13-gdscript-crypto.md`)                                           | CC-05.1                   | 60   |
| CC-13.2 | A GDScript mDNS responder next to the Windows (dnscache) and Linux (Avahi) responders: `bind` on 5353, joining the group, receiving answers                                                                                                                                                                  | added to the same report                                                                          | .1                        | 60   |

**Merge order and overlaps:**

- **`openapi/polaris-key.v3.yaml`:** CC-02.1, CC-03.2, CC-06.2 and CC-07.3, in dependency order.
- **`errors.json`:** CC-03.2, CC-06.2 and CC-07.3. Each slice runs `gen constants`, so the file is
  never hand-merged.
- **`cases.json` and the corpus files:** generated. Run `pnpm gen corpus` after the merge; never
  hand-merge.
- **`wrangler.toml`:** CC-07.2 only.
- **Migrations:** the lead numbers them.

## 6a. Dispatch briefs

Common to every slice:

- Prefix every JS command with `mise exec node@22 --`.
- Run scoped tests on the named files only. Run a generator after `pnpm build` of its inputs. Run
  prettier on the changed files.
- Run `$PKEY_LEAD/gate.sh` once before hand-off, and rerun a failed step only.
- Merge staging once, right before hand-off. Stop every background job.
- Report the changed files, the tests and the migration numbers. Security write-ups stay local,
  because the repo is public.
- Worktree `/Users/vlad/Repos/pk-wt/<slice>`, branch `wp/<slice>-<slug>` from `integ/next-stage`.

**CC-02.1** — pkey-implementer (Sonnet 5.5). Plan: §2.9 (service, routes); C12. Brief:
`wp/CC-02-service-row.md`. Steps:

1. Add the row and run `gen services`.
2. Add the descriptor and `mount.ts`.
3. Add the coherence code and message, the manifest requirement, and its mutation row.
4. OpenAPI `services.required`.

Out of scope: settings and the console. Time box 60 min. Hand-off: the descriptor shape.

**CC-02.2** — pkey-implementer (Sonnet 5.5). Plan: §2.9 (catalog, manifest, settings). Steps:

1. Schema `$defs.connect` and the validator codes, with three mutation rows.
2. `cloudConnect.ts` and the reserved key.
3. The settings slices; regenerate.

Time box 60 min.

**CC-02.3** — pkey-implementer (Sonnet 5.5). Plan: §4 (console stub, docs); C12. Steps:

1. Nav, page and accent, then `gen brand`.
2. The docs index and `doors.ts`.
3. The `features.json` family, then `gen parity`.
4. AGENTS repo notes and `layout.md`.

Time box 60 min.

**CC-03.1** — pkey-implementer (Sonnet 5.5). Plan: §2.8, §2.9 (D1); C3. Brief:
`wp/CC-03-device-keys-core.md`. Steps:

1. Migration and rollback.
2. The store and PoP verify, with vectors from `peer-matrix.json` `pop` once CC-05.3 lands. Until
   then, use a local fixed key.
3. The purge path.

Time box 60 min. Hand-off: the migration for numbering.

**CC-03.2** — pkey-implementer (Sonnet 5.5). Plan: §2.8. Steps:

1. Route and router order.
2. RL bucket `device-keys`.
3. The error code and `gen constants`.
4. Discovery, OpenAPI, transcripts.

Time box 60 min. Hand-off: request a Sonnet 5.5 security review over .1–.3.

**CC-03.3** — pkey-implementer (Sonnet 5.5). Plan: C10, §10. Steps:

1. The type in `contributions.ts`.
2. Call sites, each after its write succeeds.
3. Tests that a failing listener never fails the request.

Time box 60 min.

**CC-04.1** — pkey-implementer (Sonnet 5.5). Plan: §2.1–§2.9 as V5 §15. Brief:
`wp/CC-04-wire-v5.md`. Steps:

1. Copy V4 to V5 and edit the header, §2, §9 and §10, and add §15.
2. Mark V4 superseded.
3. The constant, `gen constants`, AGENTS rule 2.

Out of scope: code. Time box 60 min.

**CC-04.2** — pkey-implementer (Sonnet 5.5). Plan: §2.2, §2.3; C13. Steps:

1. `connect.ts` and the index export.
2. `JwsTyp`.
3. Signer checks that refuse a certificate or ring that a v5 verifier would refuse.

Time box 60 min.

**CC-04.3** — pkey-implementer (Sonnet 5.5). Plan: §2.9 (corpus). Steps:

1. The reference verifier, written apart from client-core.
2. The family, with the case lists of §2.9.
3. `gen corpus`, and commit the mirror.

Time box 60 min.

**CC-04.4** — pkey-implementer (Sonnet 5.5). Plan: §2.2, §2.3. Steps:

1. `peer/cert.ts`.
2. The Node runner sections.
3. The browser runner.

Time box 60 min. Hand-off: request a Sonnet 5.5 security review over CC-04.2–.4.

**CC-05.1** — pkey-implementer (Sonnet 5.5). Plan: §2.5, §2.9. Brief: `wp/CC-05-pkey-peer-1.md`.
Steps:

1. Reference Noise.
2. The external anchors, with their hashes.
3. The vectors, then `gen corpus`.

Time box 60 min.

**CC-05.2** — pkey-implementer (Sonnet 5.5). Plan: §2.5; C9. Steps:

1. HandshakeState and CipherState over the `Aead` port.
2. (Removed: the noble pin is gone, R-1.)
3. The runner.

Time box 60 min.

**CC-05.3** — pkey-implementer (Sonnet 5.5). Plan: §2.4, §2.6, §2.7, §2.8. Steps:

1. The reference.
2. The rows, then `gen corpus`.

Time box 60 min.

**CC-05.4** — pkey-implementer (Sonnet 5.5). Plan: §2.4–§2.7. Steps:

1. Codecs.
2. The session machine per mode.
3. The runner and the two-session test.

Time box 60 min. Hand-off: request a Sonnet 5.5 security review over CC-05.2 and .4.

**CC-06.1** — pkey-implementer (Sonnet 5.5). Plan: §2.3, §2.4, §2.9. Brief:
`wp/CC-06-connect-identity.md`. Steps:

1. Migration.
2. Members and hash, epoch bump, K_disc rotation.
3. The subject store and deletion.

Time box 60 min.

**CC-06.2** — pkey-implementer (Sonnet 5.5). Plan: §2.2, §2.9. Steps:

1. `identity`: the principal, keys, the certificate signed at `ringEpoch`.
2. `devices`.
3. Discovery, codes, OpenAPI, transcripts.

Time box 60 min.

**CC-06.3** — pkey-implementer (Sonnet 5.5). Plan: §1 (revocation). Steps:

1. The listener.
2. Audit.
3. The poke port.

Time box 45 min. Hand-off: request a Sonnet 5.5 security review over CC-06.

**CC-07.1** — pkey-implementer (Sonnet 5.5). Plan: §2.7. Brief: `wp/CC-07-relay-do.md`. Steps:

1. The engine with no I/O.
2. Every limit in a table-driven test.

Time box 60 min.

**CC-07.2** — pkey-implementer (Sonnet 5.5). Plan: §2.9 (DO, wrangler). Steps:

1. The shell.
2. The meter migration and the alarm.
3. Wrangler in every environment, then `gen platform-inventory`.

Time box 60 min. Hand-off: the migration for numbering.

**CC-07.3** — pkey-implementer (Sonnet 5.5). Plan: §2.7, §2.9 (quotas); C11. Steps:

1. The ticket.
2. The upgrade.
3. Codes, OpenAPI, transcripts.

Time box 60 min.

**CC-07.4** — pkey-implementer (Sonnet 5.5). Plan: §2.7. Steps:

1. The workerd smoke.
2. The poke. It must close the sockets of removed members immediately; the alarm only catches them within 60 s (security review of CC-07, finding 2).

Time box 45 min. Hand-off: request a Sonnet 5.5 security review over CC-07.

**CC-08.1, CC-08.2, CC-08.3** — pkey-sdk-porter (Sonnet 5.5). Plan: §3 (Node). Brief:
`wp/CC-08-node-connect.md`. Steps: as in the table. Each time box is 60 min. After .3, request one
Sonnet 5.5 security review over the key storage, the session and the relay client.

**CC-13.1, CC-13.2** — pkey-spike-runner (Opus 5.5 for the judgment; a Sonnet 5.5 builder writes the
GDScript). Plan: §3 (Godot); L-10. Run them through `heavy.sh`. Each time box is 60 min. Hand-off:
the report, with a go or no-go per platform.

## 7. Security reviews (Sonnet 5.5, one per security-bearing slice group, one fix round)

| Review | Covers                                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1    | CC-03.1–.3: PoP binding (product, device, both keys, time), unique `agreeKey`, rotation limits, the listener cannot fail or skip a revocation |
| R-2    | CC-04.2–.4: verify order, typ separation, issuer, key-set choice, low-order keys, integer claims, ring replacement, admission                 |
| R-3    | CC-05.2 and .4: Noise state, nonce reuse, rekey, PSK trial, zero DH, `MORE` reassembly bounds, mode rules, no certificate in `v` and `p`      |
| R-4    | CC-06: certificates only for the principal; no cross-subject or cross-product ring; K_disc rotation; ring membership vs floating licences     |
| R-5    | CC-07: ticket single use and binding; `from` stamping; room isolation; quota and ceiling bypass; hibernation state; DoS                       |
| R-6    | CC-08 to CC-12b: key storage per platform, non-extractable on web, permission timing, the relay fallback never carrying `v` or `p`            |
| R-7    | CC-13 and CC-14: GDScript constant-time evidence, Ed25519 sign correctness (RFC 8032 vectors)                                                 |
| R-8    | CC-15 (full): R1-07, SAS, LAN only, the requester's key binding, the same-network rule, no silent approval (L-3)                              |
| R-9    | CC-19 and CC-20 (full): consent per category, no subject leak, contact revocation                                                             |
| R-10   | CC-18: the end-to-end red-team before production                                                                                              |

## 8. Owner steps

_Superseded by plan-combined.md §3.2 (one list for all three plans)._

1. **Approve this plan**, the v5 bump included (L-6), and answer §9.
2. **Before CC-02 ships to production:** confirm that the production Worker carries unknown service
   slugs through (layout.md step 1). The lead checks the deploy.
3. **Cloudflare:** Workers Paid with SQLite DOs (already in use). Add a billing alert for DO requests
   and duration. Migration `v5` and the binding deploy with `wrangler deploy`; there is no
   dashboard step. No TURN (CC-21 is optional).
4. **Confirm the quota numbers** (O-2): 256 MiB a day per person by default, 16 MiB unlicensed, a
   4 GiB a day ceiling, and 500 GiB a month per product.
5. **Apple:** no multicast entitlement (C6). Test kit: two iPhones or iPads and one Mac on one LAN.
   For the owner's own test app, the Godot export plugin adds the two plist keys.
6. **Google:** no Play declaration is known to be needed for `ACCESS_LOCAL_NETWORK` [U; CC-12b checks].
   Test kit: one Android 16 device, and one Android 17 device with a build targeting 37.
7. **CC-13 test kit:** a Windows PC, a Linux PC and an ARM device (Apple Silicon or an Android
   phone).
8. No public registry publishing. New dependencies are pinned exact, as listed in §3.

## 9. Open decisions (recommended option first)

_Answered 2026-10-26: see plan-combined.md §2 (R-16 accepts D2, D3, D4, D5, D7, D8, D10, D11, D13 and D14) and §3 (Q1 to Q13), all as recommended. D6 is replaced by R-1._

1. **D1 Version.** **Bump to 5, with V5 as a restated copy of V4.** The alternative is additive
   `typ`s under v4.
2. **D2 Certificate lifetime.** **7 days, renewed at half-life.** The alternative is 72 hours:
   faster offline revocation, but less LAN use without internet.
3. **D3 Handshake set.** **XX only in v1; IK becomes optional CC-25** (C16). The alternative is XX
   plus IK now (P-4 as written).
4. **D4 Responder privacy.** **Account mode `XXpsk0` with a PSK from K_disc** (C2). The alternative
   is plain XX, which leaks `sub` and `deviceId` to any LAN initiator.
5. **D5 Advert name.** **Cover `deviceId` in the HMAC** (C1). There is no working alternative: names
   would collide.
6. **D6 Suites.** **AESGCM (AES-256-GCM) only, WebCrypto in the browser, no `@noble/ciphers`** (C9, R-1). The alternative is a second suite, which adds negotiation and a downgrade surface.
7. **D7 Key custody.** **Software 25519 keys in hardware-wrapped storage; non-extractable on web**
   (C3). The alternative is to use Keystore Curve25519 on Android 13+ only, a second code path.
8. **D8 Relay authentication.** **A single-use ticket in `Sec-WebSocket-Protocol`** (C11). The
   alternative is a ticket in the query string, which can be logged.
9. **D9 Vouch transport.** **LAN only, never the relay; the auto-sign-in route also refuses
   different public networks without a step-up** (R1-07). The alternative is to allow the relay,
   which reopens remote phishing.
10. **D10 Peer error codes.** **A new `errors.json` kind, `peer`.** The alternative is kebab
    `client` codes.
11. **D11 Godot.** **GDScript lane on desktop only after CC-13 passes; CryptoKit, BCrypt and `:platform` in the native lanes (Monocypher only in `pkey_win`, for the curves; R-12); Godot web export relay-only later.** The alternative is native only, which needs
    a Linux GDExtension.
12. **D12 Inter-account timing.** **Wave 3 (CC-19), after the vouch.** The alternative is in wave 2.
13. **D13 End-user naming.** **Help says "nearby devices" and "your devices"; the service name stays
    on the developer side.** The alternative is to brand "Cloud Connect" in Help.
14. **D14 WebRTC.** **Deferred, optional CC-21; browsers use the relay.** The alternative is in v1.

## 10. Interfaces with `plan-auto-sign-in.md` and `plan-cloud-sync.md`

**Cloud Connect provides (Core modules; no service imports):**

- **`core/devices/keys.ts`** (CC-03):
  - `getDeviceKeys(db, product, deviceId)`;
  - `accountDeviceKeys(db, product, subject)`: the bound, authorized devices with their keys, which
    Cloud Sync P-3 uses to wrap the root key to each `agreeKey`;
  - `verifyDeviceSignature(db, product, deviceId, message, sig)`: auto-sign-in's device-bound nonce
    and poll;
  - `verifyKeyPop(...)`.
- **`contributes.onDeviceChange`** (CC-03.3), with the events `bound`, `unbound`, `removed` and
  `keys`. Cloud Sync can drop or rewrap blobs when it fires.
- **The route `PUT /<p>/devices/keys`** and `core.endpoints.deviceKeys`. Both work whatever Connect's
  state.
- **The channel:**
  - mode `v`, with VOUCH_REQ and VOUCH_RESULT (CC-15);
  - pairing adverts;
  - SDK calls: `cloudConnect.nearby.request()` on the requester (no userCode, R-2) and
    `cloudConnect.nearby.onRequest(handler)` on the approver. The handler shows the kit screen
    and, on Approve, calls the auto-sign-in SDK function;
  - record types 0x0030 (KEYRING_WRAP) and 0x0031–0x003F, reserved for Cloud Sync and legal in mode `v` only (R-9).
- **The relay DO** can later carry Cloud Sync pokes as a new op, if U-14 is revived.

**Cloud Connect consumes from `plan-auto-sign-in.md`:**

- **An approve route.** The server half of P-5: approve a device code from a signed-in SDK session.
  - Input: `{request, signKey, agreeKey, decision, choice?, proof}` (R-2 step 7; the proof is `pkey-proof/1`).
  - It binds the approval to the requester's keys, so the poll completes only for a signature by
    that `signKey`.
  - It refuses, or asks for a step-up, when the requester's device-code start and the approver come
    from different public networks (`clientWideNetwork`).
  - It applies I-37's approval rules, audits and emails, and is single use.
- **Kit screens.** "Sign in from a nearby device" (the requester) and "Sign in <label>? Code 123
  456" (the approver), plus the L-11 pre-prompt copy.
- **Ladder rung 5** calls `cloudConnect.nearby.request()`.

**Cloud Connect consumes from `plan-cloud-sync.md`:** nothing is required (L-13). K_disc is
server-delivered, not derived from the root key.

**Acceptance (whole program):**

- `pnpm gen --check` (corpus, transcripts, constants, services, settings, platform-inventory,
  parity, api, docs-reference);
- `pnpm --filter @polaris-key/worker test` and `test:workerd`;
- `pnpm test:browser`;
- the Python, Swift, Kotlin (`:conformance`) and Godot runners on `cases.json`,
  `noise-vectors.json`, `peer-matrix.json` and the `connect-*` transcripts;
- CC-18 signed off.

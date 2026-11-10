# CC-23L: account-free local pairing ("local links") for v0.11

Lead's plan, **documents only, no code**, 2026-11-03. Planner: `pkey-wire-planner` (Opus 5.5). Owner decision
2026-11-03 (LF:2694): add account-free local pairing to 0.11, as a new mode that extends the optional CC-23.
Read only, nothing changed: `_merge` (`integ/next-stage` `0ac6bd5cc5`) for V5 §15.4–§15.11,
THREAT-MODEL "Cloud Connect", `packages/client-core/src/peer/`, `packages/sdk-node/src/connect/` and the
Python, Swift, Kotlin and Godot Connect code; `plan-cloud-connect.md` (§1, §2.4–§2.9, §9, the CC-23 row);
`plan-combined.md` (R-1…R-18); `CC-16-CC-19-CC-20-slices.md` (D-1…D-23); `CC-18-U-44-U-45-signoff.md` (D-6,
D-40, §3.5); `GODOT-CONNECT-2.md`; `LOCKER-FEATURE-NAMES.md`; `archive/research-device-linking.md` §4.3. It lives
in the lead's local notes only.

This is CC-23L's plan and the plan of the packages that build it (§10). It is a wire change (AGENTS rule 2), so
the ★ slices run in plan mode against it. Status: **approved** (2026-11-03; see "Approval" at the end).

## 0. Summary

- **Today** every Cloud Connect mode needs sign-in: modes `a`, `v`, `p` and `c` rest on Worker-signed
  certificates or the account-registered device key, and `links.pair` fetches `GET /connect/identity` first.
- **New:** two devices with no account pair on the same network. One device shows an 8-digit code and a QR; the
  other types the code or scans the QR. A PAKE (CPace) turns the code into a shared key. Both people confirm,
  and each device pins the other's key. Later, the two devices find each other on the LAN and use app channels
  and Direct Transfer, with no server involved.
- **Shape:** two new modes. Mode `q` is the pairing; mode `l` is a later session over a local link. No new
  signed document and no route. `PROTOCOL_VERSION` stays 5.
- **Off by default.** The developer opts in with `connect.localPairing`, and an operator launch gate holds it
  dark until sign-off. The SDK enforces both from the cached discovery document, because the Worker never
  sees peer-to-peer traffic.
- **LAN only, no licence check, kept apart from any later sign-in.**
- **Size:** 26 build slices plus 8 security passes, about 0.9–1.2 engineer-weeks. Godot waits for its CC-19b
  and CC-20b ports.

## 1. Goal and non-goals

**Goal.** In an app whose product turns it on, any two devices running the app on one LAN can pair by code or QR
without an account. They can then reconnect over the LAN at any time for channels (`app/1`) and Direct Transfer
(`xfer/1`). The SDKs supported are Node (with Electron), Python, Swift, Kotlin JVM, Android and Godot. Every kit
can show the code and the QR, and the phone kits can also scan.

**Non-goals (v0.11):**

- **The relay.** It stays account-bound, because quotas and abuse are counted per person.
- **Server-recorded links.** They remain the open part of CC-23.
- **Turning a local link into an account contact.** See §3.9.
- **Browsers.** They have no LAN, so `web` and `desktop-bridge` are N/A here, as for `connect.links` (D-14).
- **Scanning on desktops, Godot and Python.** These kits show the QR only.
- **Addresses in the QR.** mDNS still resolves the device.
- **Fast reconnect.** IK is CC-25.
- **Changes to modes `a`, `v`, `p` and `c`.**
- **Remote revocation.**

## 2. What exists and what blocks it

- **Reusable as is:**
  - mode `p`'s pairing listener, window and `HandshakeLimiter` (5 handshakes a minute, 4 waiting);
  - `CONFIRM` (0x8012), the categories and `contactTrialOrder`;
  - the pin of mode `c`, the contact adverts and the partial-file keying of Direct Transfer;
  - the shared listener with its contact limiter (V5 §15.10, §15.11).
- **Engines:**
  - The `Noise_XXpsk0_25519_AESGCM_SHA256` engine (modes `a` and `c`) is in client-core, Python
    (`core/peer_noise.py`), Swift (`PolarisKeyCore/PeerNoise.swift`), Kotlin (`:core` `peer/Noise.kt`) and Godot
    (`core/peer/noise.gd`).
  - X25519 is available everywhere: WebCrypto, `node:crypto`, `cryptography`, CryptoKit, JCA/Tink,
    Monocypher, and Godot's `core/crypto/curve25519.gd`.
  - SHA-512 is available everywhere, including Godot's `core/crypto/sha512.gd`.
- **QR drawing** exists in every kit: React `encodeQr`, Swift `PolarisQRCode`, Kotlin zxing-core 3.5.4 and Godot
  `ui/qr/`. No kit scans yet.
- **What blocks account-free use today:**
  - `CloudLinks.pair` calls `connect.identity()`, which needs a bearer.
  - The LAN service throws `no_identity` without a held identity (`sdk-node/src/connect/client.ts`).
  - Mode `c` pins the device `agreeKey` that `PUT /devices/keys` registers to the account.
- **Godot** has no contact machinery yet: CC-19b.G1–G4 and CC-20b.G1–G3 (`GODOT-CONNECT-2.md`) are not started.

## 3. Design

### 3.1 Two new modes: `q` (pair by code) and `l` (local link)

| Mode | Use                   | Noise protocol                     | Static keys                                     | PSK                                  | Prologue mode byte |
| ---- | --------------------- | ---------------------------------- | ----------------------------------------------- | ------------------------------------ | ------------------ |
| `q`  | pairing by code or QR | `Noise_XXpsk0_25519_AESGCM_SHA256` | each side's **new link key**, made for the link | derived from the CPace output (§3.3) | `q`                |
| `l`  | a later session       | `Noise_XXpsk0_25519_AESGCM_SHA256` | each side's link key, pinned at pairing         | the link secret (§3.4)               | `l`                |

The prologue is `"pkey-peer/1"‖0x00‖slug‖0x00‖mode‖0x00`, as for every mode. A version, product or mode mismatch
therefore fails by construction, and a local-link secret never opens a mode-`c` session, nor the reverse.

**Why new modes, not mode `p`/`c` without the account check:**

- They have their own gate (§3.10) and their own record set (§3.6).
- They never touch the relay or the account key.
- A PAKE replaces the commit-reveal code.

**Why a key per link, not the device `agreeKey`:**

- **Unlinkable.** Two peers cannot match the device by comparing keys, and a peer cannot match it to the
  account it signs in to later.
- **Independent of key rotation.** Rotating the device key (`PUT /devices/keys`, at most 4 a day) never breaks a
  link.
- **Forget is complete.** Forgetting a link deletes everything the link holds.

**Trust on first use.** The first use is the pairing, and the code authenticates it. After that each side trusts
only the key it pinned. There is no certificate and no server.

### 3.2 The code and the QR

- **Code.** 8 decimal digits, shown as `4812 3456`.
  - The first two digits are the **nameplate**. It is public, carried in the advert TXT as `n`, and it tells the
    joiner which pairing window to dial. The device showing the code picks a nameplate that no `m=q` advert of
    the same product on the link is using.
  - The last six digits are the **CPace password**.
  - This is Magic Wormhole's nameplate-plus-password design. Without the nameplate, a joiner that tried every
    window would burn the codes of other people pairing at the same time.
- **QR.** `PKP1:<SLUG>:<INSTANCE>:<SECRET>` in upper case, so it fits QR alphanumeric mode (about 60
  characters, version 3–4).
  - `INSTANCE` is the 16 base32 characters of the advert name.
  - `SECRET` is 16 random bytes, written as 26 unpadded base32 characters.
  - The reader accepts any case. A slug other than the app's own answers "This code is for another app."
- **Rotation.** The code and the QR are made per window and rotate together after every failed attempt.
- **Who shows, who types.** The showing device advertises and listens (it is the responder). The other device
  types or scans and connects out (it is the initiator), so it needs no listener and gets no firewall prompt
  (as R-4). Either device may take either role.

### 3.3 The mode-`q` handshake

1. **Find.** The joiner browses `_pkeypeer._tcp` for `m=q` adverts that carry its product tag `h` and either
   `n` = the nameplate (code) or the exact instance (QR). It browses for at most 15 s and dials at most 2
   matching adverts, first seen first. It never retries a failed code by itself.
2. **CPace** (suite `CPACE-X25519-SHA512` of draft-irtf-cfrg-cpace; the revision, or its RFC number, is pinned in
   `tools/corpus/inputs/cpace-anchors.json`).
   - **Inputs:**
     - DSI `"CPace255"`;
     - PRS `"pkey-peer/1 code"‖0x00‖<6 ASCII digits>` for a code, or `"pkey-peer/1 qr"‖0x00‖<16 secret bytes>`
       for a QR;
     - CI = the mode-`q` prologue;
     - **sid** = the 10 random bytes behind the advert instance name;
     - ADa = ADb = empty;
     - the initiator-responder transcript.
   - **Two frames** run before Noise, inside the existing TCP framing (`u16be len ‖ bytes`):
     - C1, initiator to responder: `0x01 ‖ kind ‖ Ya` (34 bytes; kind 0x01 is a code, 0x02 a QR);
     - C2, responder to initiator: `0x01 ‖ Yb` (33 bytes).
   - **Refusals.** Any of the following closes the connection silently and counts no failure:
     - a frame of another length, version or kind;
     - a share that is not canonical, or that is a low-order point (`noise-vectors.json` `lowOrder`);
     - a result K of all zeros.
3. **Noise.** `Noise_XXpsk0_25519_AESGCM_SHA256` with prologue mode `q`.
   - **Static keys:** each side's new link key.
   - **PSK:** `psk = HKDF-SHA256(salt = empty, ikm = ISK, info = "pkey-peer/1 cpace"‖0x00‖slug)`, 32 bytes.
   - **Payloads:** message 1 is `{"v":1}`. Messages 2 and 3 are `{"v":1,"caps":["local/1",…]}` with no `cert`
     (a `cert` refuses). `local/1` is mandatory, as `vouch/1` is in mode `v` (§15.6.1 rule 1).
4. **Key confirmation** happens inside Noise, before any record. Message 1's AEAD tag proves that the joiner holds
   ISK, and message 2's tag proves that the shower does. No extra CPace confirmation messages are needed.
5. **Failure accounting** (on the showing device):
   - A message 1 that does not open counts as one failed guess. The device rotates the password and the QR
     secret, recomputes both generators and closes silently.
   - The fifth failure closes the window ("Too many tries").
   - Only one CPace attempt runs per window at a time; any other connection closes silently as `peer_busy`.
   - Once a session reaches the transport it holds the window. Decline rotates the code and reopens it.
   - The §15.6 limiter (5 handshakes a minute per advert) and the §15.4.1 pool apply unchanged.
6. **Precomputation.** The shower computes its generators at every rotation, and the joiner computes its own
   before it dials. The timing of the Elligator2 map therefore never shows on the network, and the scalar
   multiplications use each platform's constant-time X25519. (The cryptographer confirms this, §8.)

**Bound.** An attacker gets one guess per attempt. With a code, an attacker succeeds with probability at most
5 × 10⁻⁶ per window; with a QR, at most 2⁻¹²⁸. A transcript gives nothing to test a guess offline. A fake advert
with the same nameplate gets at most the one guess of each dial, and the joiner dials at most 2.

### 3.4 Consent, `LOCAL_LINK`, the link secret, and what each side stores

**Order.**

1. Transport.
2. `HELLO` each way. It is display data, and it is the first point at which either side learns a label.
3. Consent from each host. The shower shows "Pair with {label}?" with the categories. The joiner may give its
   consent at code entry; that is the kit's choice.
4. `CONFIRM` (0x8012) each way.
5. `LOCAL_LINK` (**new, 0x0014**) `{v:1, label?, cats}` each way. A side sends it after its own `CONFIRM` is sent
   and the peer's has been read. The rules are `CONTACT`'s without `agreeKey`: strict JSON, at most 4 KiB, at
   most 8 categories matching `^[a-z0-9-]{1,32}$`, and the link keeps the categories both sides listed.
6. A side stores the link when it reads the peer's valid `LOCAL_LINK`, then closes with `peer_bye`.

**Deadlines:** 30 s from the first byte to the transport (C1 and C2 included); 120 s to the person's
confirmation; `CONTACT_EXCHANGE_SECONDS` (30) for the exchange. A success closes the window.

**Link secret.**
`secret = HKDF-SHA256(salt = h, ikm = ISK, info = "pkey-peer/1 local"‖0x00‖lo‖hi)`, 32 bytes. `h` is the mode-`q`
handshake hash, and `lo` and `hi` are the two link public keys, the smaller first by byte order.

| Each side stores (per product, store record `pkey.connect.local.v1`)       | Where                                                                                                                  | Until           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| Its own link private key (32 B) and the link secret (32 B)                 | the platform secret store, as contact secrets: Keychain `…ThisDeviceOnly`, Keystore-wrapped, OS keyring, Godot keyring | forget          |
| Both link public keys; link id (as `contactId`, over the peer's key)       | the store record                                                                                                       | forget          |
| The peer's label (cleaned; Rename overrides it locally) and the categories | the store record                                                                                                       | forget          |
| Created and last-seen times, and the "reachable" flag                      | the store record                                                                                                       | forget          |
| Direct Transfer partials, keyed by the pinned link key                     | the SDK's per-product directory (§15.11)                                                                               | 24 h, or forget |

Nothing is stored on a server. The pairing window's code, secrets, generators and scalars live in memory only and
are wiped when the window ends.

### 3.5 Mode `l`: later sessions

- **Handshake.** XXpsk0 with prologue `l`, the device's own link key as the static key, and the link secret as
  the PSK.
- **The pin.** The remote static key must equal the stored peer link key. Otherwise the session ends as
  `peer_revoked` and nothing is sent, as in mode `c`.
- **One listener, one order** (this amends §15.5).
  - The order is: the account keys, then the contact secrets (at most 72), then the local-link secrets in held
    order (at most `MAX_LOCAL_LINKS` = 32). The total is at most `MAX_LINK_SECRETS` = 104.
  - All of it sits behind the §15.10 contact limiter (5 a minute, 4 waiting), which now covers local links too.
  - A host with no account and no contacts tries local links only.
  - A listener can now run with no account. This is the main SDK change.
- **`HELLO`** is judged as in mode `c`. The host shows the stored label, or the renamed one.
- **Advert.**
  - The name is `p1-` + base32lower(HMAC-SHA256(secret, `"pkey-peer/1 ldisc"‖0x00‖u64be(⌊now/900⌋)‖ownLinkKey`))[0..16].
  - The TXT is `v=1`, `m=l`. It carries no product tag.
  - At most `MAX_LIVE_LOCAL_ADVERTS` = 8 are live, and only for links the host marks reachable.
  - A browser tests the held links × 2 epochs, which is at most 64 HMACs.
  - `parseLocalTxt` needs `v=1` and `m=l`.

### 3.6 Records and caps

| Record                                   | Modes after this plan                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `HELLO`, `PING`/`PONG`, `REKEY`, `CLOSE` | all                                                                         |
| `CONFIRM` 0x8012                         | `p`, `q`                                                                    |
| `LOCAL_LINK` 0x0014 (new)                | `q`                                                                         |
| `APP` (`app/1`)                          | `a`, `c`, `l`                                                               |
| Direct Transfer 0x0020–0x0025 (`xfer/1`) | `a`, `c`, `l`. Mode `c`'s category rule (§15.11 step 5) also applies in `l` |
| Every other type, in `q` or `l`          | `peer_not_allowed`                                                          |

- **Never relayed.** No ticket can name a local link, and `CANDIDATES` is not allowed in `q` or `l`.
- **Not metered.** The LAN is never metered, and Direct Transfer's own limits apply unchanged.
- **New constants [C]:** `LOCAL_PAIR_SECONDS = 300` · `LOCAL_CODE_DIGITS = 8` (a 2-digit nameplate and a
  6-digit password) · `LOCAL_PAIR_FAILURES = 5` · `LOCAL_QR_SECRET_BYTES = 16` · `LOCAL_JOIN_CANDIDATES = 2` ·
  `LOCAL_JOIN_BROWSE_SECONDS = 15` · `MAX_LOCAL_LINKS = 32` · `MAX_LIVE_LOCAL_ADVERTS = 8` ·
  `MAX_LINK_SECRETS = 104`.

### 3.7 Discovery, privacy, LAN limits and the pairing window

| Advert             | Instance                                        | TXT                                        | When                                                                                        |
| ------------------ | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Pairing (`m=q`)    | `p1-` + 16 base32 characters of 10 random bytes | `v=1`, `m=q`, `h=<16 hex>`, `n=<2 digits>` | only while the person has the window open; at most 300 s; one window per device per product |
| Local link (`m=l`) | the HMAC name of §3.5                           | `v=1`, `m=l`                               | links marked reachable; at most 8                                                           |

**Privacy.**

- No label, id, key or subject appears in an advert.
- `HELLO` is sent only after the code is proven. This is stronger than mode `p`, where `HELLO` comes before
  the code.
- Anyone who knows the slug can tell, from `h`, that a pairing window of that product is open. The nameplate
  is public.
- Only the two devices of a link can recognise its advert name, which rotates every 15 minutes.
- The operating system's host name, the MAC address and the IP address remain residuals, as `PRIVACY.md`
  already says.

**Anti-spam.**

- No one sees a "Pair with…?" prompt unless the other side proved the code.
- One attempt runs per window at a time, at most 5 a minute; every failure rotates the code; five failures close
  the window.
- The joiner dials at most 2 adverts.
- The mDNS rules of §15.4 apply (16 new names per source per minute). The joiner keeps `m=q` names only while
  it is joining, only when `h` and `n` match, and at most 8 of them.

### 3.8 Rename, forget, and revocation without a roster

- **Rename** changes the stored label on this device only. It is never sent.
- **Forget** (`remove(id)`) deletes the keys, the secret, the record and the partials.
  - An open session closes with `peer_revoked`.
  - The other device then fails silently and shows "Not reachable"; its person can forget it too. This is mode
    `c`'s D-11.
- **No roster, no server.** A lost or sold device keeps LAN reach to its links until each peer forgets it. There
  is no remote revocation; this is an accepted residual (§5).
- **Product-wide off.** Turning the setting or the gate off reaches each device at its next discovery refresh.
- **Not account data.** Sign-out, licence deactivation and account deletion leave local links alone.
  - The C5 clean-up removes only the account half.
  - Sign-out's bounded stop (D-12) restarts the LAN service without the account half when links are reachable.
  - In Python's local-only profile, local links are refused (`local-only`), because that profile opens no
    socket.

### 3.9 Local links and a later sign-in: keep them separate (recommended)

A local link stays a LAN-only local link after either person signs in, or both do.

- **If both later sign in to different accounts** and want to reach each other across networks, they pair again
  with "Pair with Someone Nearby" (mode `p`).
- **If one person owns both devices** and signs in on both, mode `a` covers them, and the local link can be
  forgotten.
- **The alternatives:**
  - **Migrate** the link into a mode-`c` contact. Both sides would have to bind it to the device `agreeKey`,
    which makes them correlatable, and it needs a re-handshake. About 3 extra slices and a new threat surface.
  - **Drop** links at sign-in. This loses data and surprises people.

### 3.10 Product opt-in, and how the SDKs enforce it

- **Manifest.** `.pkey/product` `connect.localPairing: boolean`, default `false`. It is a member of the existing
  `connect` block and a claimable setting, `cloudConnect.localPairing`.
- **Launch gate.** `launch.localPairing` is off by default, fails closed, needs an L1 confirm and is a §9 review
  trigger.
- **Discovery.** The new member `services.connect.localPairing` is true only while the setting, the gate and the
  service are all on. The member is unsigned and additive, and `DISCOVERY_VERSION` stays 2. Because `services.connect`
  reads `{"enabled":false}` while `launch.connect` is off, local pairing also needs `launch.connect` (open
  question Q4).
- **SDK enforcement** works like §15.10's "Gates":
  - `pair`, `join`, the `m=l` adverts and the mode-`l` dials and answers all need a cached
    `localPairing: true`. Otherwise they throw the typed N/A with the client code `local-pairing-off`.
  - With no cached document, the feature is off.
  - Offline, a cached `true` keeps working.
  - A refresh that says `false` closes the windows, withdraws the adverts and ends mode-`l` sessions with
    `peer_bye`. The links stay on disk but are inert.
  - `peer-matrix.json` `local.gate` pins these rows.
- **Why a gate works here, unlike Direct Transfer (D-40).** D-40 has no gate because builds already deployed
  speak `xfer/1`, so a discovery member would fail open for them. No deployed build speaks `q` or `l`, so this
  gate has no population that could fail open.
- **Not a security boundary.** A modified app can still speak the protocol. The gate protects the developer's
  choice and the dark launch; it is not a control against hostile clients (THREAT-MODEL row).

### 3.11 Licence: no licence check in the SDK (recommended)

- **The Worker cannot enforce it.** It never sees LAN traffic.
- **A client-side check would block the free and trial use** that account-free pairing is for.
- **A developer who wants it paid** gates the call in app code on an entitlement (`license.has("lan-coop")`
  before `localLinks.pair`). The docs page shows this.
- **Alternative:** the SDK requires a usable cached licence on each device. One check per SDK, trivially bypassed.

## 4. Wire, corpus and version

**V5.** A new §15.12, "Local links (account-free pairing)", holds §3 of this plan. It also amends:

- §15.5: the `q` and `l` rows, and "One listener, one order" (§3.5);
- §15.6: the record table (§3.6), with `LOCAL_LINK` 0x0014;
- §15.9: corpus, discovery and errors;
- §15.11 "Where it runs": modes `a`, `c` and `l`.

**`PROTOCOL_VERSION` stays 5 (recommended).** The precedent is §15.6.1, §15.10 and §15.11, all added under 5.

- There is no new `typ` and no signed document.
- The prologue mode byte negotiates the new modes, and no SDK enforces `protocolVersion`.
- Deployed SDKs drop `m=q` and `m=l` adverts: `parseTxt` refuses an unknown `m`.
- Their shared listener fails a mode-`l` message 1 silently, because none of their secrets opens it.
- `LOCAL_LINK` is non-critical and legal only in `q`.
- The alternative, a bump to 6, means a V6 restatement and a constant regenerated in seven languages, with no gain
  in interoperability.

**Corpus** (`pnpm gen corpus`, which also writes the Godot mirror; never edit by hand).

| File                 | Addition (append-only)                                                                                                                                                                                                                                                                                                                                                                                                                                    | About    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `noise-vectors.json` | New section `cpace`: the draft's X25519 vectors, vendored with their SHA-256 in `tools/corpus/inputs/cpace-anchors.json`; Elligator2 map rows (zero input, top bit set, square and non-square, inputs ≥ p); generator rows for the code and QR PRS; share refusals; the all-zero K abort; ISK and PSK. Mode-`q` and mode-`l` rows in `handshakes` and `failures`: wrong code at message 1, wrong slug, bad C1 or C2, low-order share, failed pin          | 40 rows  |
| `peer-matrix.json`   | New section `local`, with sub-sections `codes` (generate, parse, display, nameplate), `qr`, `adverts` (`m=q`, `m=l`), `txt` (`n` is read for `m=q` only), `body` (`LOCAL_LINK`), `secrets`, `exchange` (CONFIRM and LOCAL_LINK order), `pin`, `trialOrder` (account, contacts, locals; the 104 cap), `window` (a machine over attempts, failures, rotation, busy and the clock), `gate` (cached discovery to on, off or withdraw), `records` (mode rules) | 100 rows |

- **Version counters** stay as they are: `corpusVersion` 2, `noiseVectorsVersion` 1, `peerMatrixVersion` 1. A
  runner ignores any section it does not name.
- **Generator modules:** `tools/corpus/local.ts`, plus new independent references `tools/corpus/reference/cpace.ts`
  (over `node:crypto` X25519 and a BigInt Elligator2 of its own, not client-core's) and
  `tools/corpus/reference/local.ts`. `noise.ts` and `peerMatrix.ts` are extended.
- **Unchanged:** `cases.json`.

**Transcripts** (`pnpm gen transcripts`):

- the new `connect-local-pairing`, a discovery read with the setting and the gate on;
- `connect-identity`, `connect-identity-rotate`, `connect-identity-refusals` and `connect-links-disabled`
  regenerate, because they carry `services.connect`.

**Registries:**

- **`errors.json`** gets four client codes first: `local-pairing-off`, `pairing-code-failed`,
  `pairing-not-found` and `local-links-full`. There is no new `peer_*` or `wire` code. Then `pnpm gen constants`.
- **`features.json`** gets `connect.localLinks`, N/A on `web` and `desktop-bridge`. Then `pnpm gen parity`.
- **`api.json`** gets `cloudConnect.localLinks.{pair, join, list, rename, remove, setReachable, open, onLink}`.

**Manifest and settings:**

- `product.schema.json` `$defs.connect` gains `localPairing`.
- The validator's `invalid_connect` message lists it.
- Schema-parity mutation rows are added for a non-boolean value (AGENTS rule 9, `schema: "rejects"`).
- The settings registry gets `cloudConnect.localPairing`, then `pnpm gen settings docs-reference`.
- `core/settings/launchGates.ts` gets `launch.localPairing`.
- The Action bundle is rebuilt (`pnpm build && pnpm gen action-bundle`), because it inlines
  `@polaris-key/manifest`.

**Not needed:** no route (rule 10 is not triggered), no D1 table or migration, no DO change, no
`TABLE_OWNERS` row.

**Drift gates the builders run:**

- `pnpm gen corpus transcripts constants parity settings docs-reference ui-matrix brand action-bundle --check`;
- `schema-parity.test.ts`;
- the worker's settings and launch-gate tests.

## 5. Threat model and PRIVACY

New rows go in THREAT-MODEL "Cloud Connect", written in CC-29.0:

| Threat                                         | Control                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Online code guessing (CC-29)                   | CPace allows one guess per attempt. Every failure rotates the code, the fifth closes the window, and one attempt runs at a time at 5 a minute. The bound is at most 5 × 10⁻⁶ per window, and 2⁻¹²⁸ for a QR        |
| Offline dictionary attack                      | A CPace transcript, passive or active, gives no offline test. Generators are precomputed, so the map's timing never shows on the network                                                                           |
| Man in the middle, or a fake advert on the LAN | Without the code it fails. A fake advert with the nameplate gets one guess per dial, and the joiner dials at most 2 and never retries by itself. A QR names the exact instance and carries 128 bits                |
| Code exposure (shoulder-surfing)               | A code lives only while its window is open, and a success closes the window. Both people confirm, with the categories, before anything is stored                                                                   |
| Identity before consent                        | Adverts carry no label, id or key. `HELLO` comes only after the code is proven                                                                                                                                     |
| Correlation across peers and accounts          | Keys are per link. No device `agreeKey`, subject, device id or account crosses                                                                                                                                     |
| Mode confusion                                 | The prologue and CPace CI carry `q` or `l`. `local/1` is mandatory in `q`. A local secret never opens mode `c`, nor the reverse                                                                                    |
| Revocation without a roster (residual)         | Forget is local, and the other side fails silently. A lost device keeps LAN reach until each peer forgets it. There is no remote revocation. Product-wide off reaches devices only at their next discovery refresh |
| Opt-in is client-side (residual)               | The setting and the gate bind SDKs that honour them. A modified app can speak the protocol. It is not a security control (as D-40)                                                                                 |
| Relay                                          | Never used: no ticket names a local link, and `CANDIDATES` is refused in `q` and `l`                                                                                                                               |
| Denial of pairing (residual)                   | A LAN attacker can burn the 5 failures, or fill the 2 dial slots with fake adverts. This is denial, never access. A QR avoids the second                                                                           |
| Key custody                                    | Link private keys and secrets live in the platform secret store, are never logged and survive sign-out. Forget removes them                                                                                        |
| Timing in GDScript                             | Elligator2 and X25519 in GDScript rest on CC-13's constant-time evidence. The map runs off the network path                                                                                                        |

**PRIVACY.md**, a new subsection "Pairing without an account":

- Polaris Key keeps no record. The only server state is the product switch.
- The device keeps the per-link keys, the secret, the peer's label and the categories, and the times.
- The LAN sees the pairing advert (product tag and nameplate) for up to 300 s, and the rotating link names.
- The residuals are the ones above.

## 6. UX

**Copy rules.**

- The feature label is **"Pair with a Code"** (Title Case, LOCKER-FEATURE-NAMES D-1/D-3). The done state is
  **"Paired"**.
- The copy has no brand: there is no account, so neither "Polaris Locker" nor "Cloud Connect" appears. The
  kit-copy ban already refuses the latter.
- Copy is terse, and each fact is said once.
- Kit-copy keys are `localPairing.*` in `brand/scripts/kit-copy.ts`, followed by `pnpm gen brand`. The Title
  Case list adds `title`, `pairedTitle` and `failedTitle`.

| Screen (`LocalPairingModel` state) | Copy                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `choose`                           | "Pair with a Code" · "Show a code" · "Enter a code" · "Scan a code" (where scanning exists)                                                                                                                                                                 |
| `show`                             | the code `4812 3456`, the QR, a time ring · "Enter this code on the other device." · "Cancel"                                                                                                                                                               |
| `enter` / `scan`                   | "Enter the code from the other device." · 8-digit field, "Pair" / "Point at the code on the other device."                                                                                                                                                  |
| `confirm`                          | "Pair with {label}?" · "Shares {categories}" · "Pair" / "Not now"                                                                                                                                                                                           |
| `waiting`, `paired`                | "Waiting for them to confirm" (the existing `linkPairing.waiting`) · "Paired"                                                                                                                                                                               |
| `failed` ("Couldn't Pair")         | "That code didn't work. Check it and try again." · "Can't find the other device. Check you're both on the same network." · "Too many tries. Show a new code." · "This device has no room for another pairing." · "Pairing with a code is off for this app." |
| `PairedDevicesModel`               | rows: label · "Nearby only" · last seen; actions "Rename" and "Forget" (confirm "Forget {label}?")                                                                                                                                                          |

- **Pre-prompts.** The L-11 Local Network line, and a camera line, "Scan the code with your camera", where the kit
  scans. The developer's app declares `NSCameraUsageDescription`; the docs say so.
- **Per kit.**
  - **React** (Electron, over Node): show, enter and manage. Hidden in a browser.
  - **SwiftUI:** iOS and iPadOS show, enter, scan (AVFoundation, no dependency) and manage; macOS has no scan.
  - **Compose:** Android shows, enters, scans (Q6) and manages; desktop has no scan.
  - **Godot:** show, enter and manage, with the QR from `ui/qr/`.
  - **Python and terminal:** API only, until LinkPairing gets a Python kit.
- **UX review** (an Opus UX designer): the mockups before K.1, and the built screens in a real browser or
  simulator at the committed responsive matrix, compared with the mockups. `ui-matrix` gets rows for every state.

## 7. Slices (each at most 60 minutes; Sonnet 5.5 builders; scoped tests only)

★ marks a plan-mode slice. Branch `wp/<slice>-local-links` from the
current integration base.

| Slice        | ★   | Goal                                                                                                                                                                                                                                                             | Tests and gates                                                                                                                              | Deps                      | Min  |
| ------------ | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---- |
| CC-29.0      | ★   | V5 §15.12 and the §15.5, §15.6, §15.9 and §15.11 amendments; the four `errors.json` client codes; the THREAT-MODEL rows; PRIVACY                                                                                                                                 | `pnpm format`; `gen constants --check`                                                                                                       | none (CC-20.0 is on main) | 60   |
| CC-29.1      | ★   | `reference/cpace.ts`; `inputs/cpace-anchors.json`; the `noise-vectors.json` `cpace` section                                                                                                                                                                      | `gen corpus --check`, generator self-check                                                                                                   | .0                        | 60   |
| CC-29.2      | ★   | Mode-`q` and mode-`l` handshake and failure rows; `peer-matrix.json` `local` codecs (`codes`, `qr`, `adverts`, `txt`, `body`, `secrets`); `reference/local.ts`                                                                                                   | `gen corpus --check` (mirror)                                                                                                                | .1                        | 60   |
| CC-29.3      | ★   | `local` machines: `exchange`, `pin`, `trialOrder`, `window`, `gate`, `records`                                                                                                                                                                                   | `gen corpus --check`                                                                                                                         | .2                        | 60   |
| CC-29.4      | ★   | client-core `peer/cpace.ts` (Elligator2, generator precompute, C1/C2); `noise.ts` `PeerMode` `q` and `l`; the Node and browser runners for `cpace` and the handshakes                                                                                            | `noiseVectors.test` (Node, browser)                                                                                                          | .2                        | 60   |
| CC-29.5      | ★   | client-core `peer/local.ts`: code, nameplate, QR, adverts, `LOCAL_LINK`, secret, the window machine, the gate predicate; runners for the codec and `window`/`gate` rows                                                                                          | `peerMatrix.test`                                                                                                                            | .3, .4                    | 60   |
| CC-29.5b     | ★   | `session.ts` rules for modes `q` and `l` (records, exchange, pin); `contactTrialOrder` extended with local links; the remaining runners; an in-memory test with two sessions                                                                                     | `peerMatrix.test`, `test:browser`                                                                                                            | .5                        | 60   |
| CC-29.6      |     | Manifest member, mutation rows and `ManifestConnect.localPairing`; the setting; `launch.localPairing`; the discovery member; the console Setup row (ProductSettingsSection, no new UI); transcripts                                                              | schema-parity, settings, launchGates; `gen settings constants transcripts docs-reference --check`; `pnpm build && gen action-bundle --check` | .0                        | 60   |
| CC-29.7      |     | Node: the LAN service with no account; `localLinks.pair` and `join` (window, nameplate, 2 dials, failure accounting); the `pkey.connect.local.v1` store in the secret store                                                                                      | sdk-node connect tests; a loopback pairing                                                                                                   | .5b, .6                   | 60   |
| CC-29.8      |     | Node: `m=l` adverts and browsing; the listener trial with local links; `open`, `onLink`, `list`, `rename`, `remove`, `setReachable`; Direct Transfer adoption in mode `l`; gate withdrawal; `api.json` and the `connect.localLinks` parity flip (proof `corpus`) | sdk-node tests; `gen api parity --check`                                                                                                     | .7                        | 60   |
| CC-29.9–.10  |     | Python: as .7 and .8 (`core/peer_cpace.py`, `core/peer_local.py`, `connect/local_links.py`, `connect/local_pairing.py`)                                                                                                                                          | pytest connect                                                                                                                               | .8                        | 2×60 |
| CC-29.11–.12 |     | Swift: as .7 and .8 (`PolarisKeyCore/PeerCPace.swift`, with a small 2²⁵⁵−19 field type because Swift has no BigInt; `PeerLocal.swift`; `ConnectLocalLinks.swift`, `ConnectLocalPairing.swift`)                                                                   | `swift test --filter Connect`                                                                                                                | .8                        | 2×60 |
| CC-29.13–.14 |     | Kotlin JVM: as .7 and .8 (`:core` `peer/CPace.kt`, `peer/Local.kt`; `:sdk` `ConnectLocalLinks.kt`); the `:conformance` runner                                                                                                                                    | `:core:test :sdk:test :conformance:test` (`--no-daemon`)                                                                                     | .8                        | 2×60 |
| CC-29b.A     |     | Android: `:platform` `PeerNsd` handles `m=q` and `m=l`; the Keystore-wrapped store; an instrumented loopback test                                                                                                                                                | `ci:android`                                                                                                                                 | .14                       | 60   |
| CC-29b.G1    |     | Godot: `core/peer/cpace.gd` (Elligator2 over `curve25519.gd`, `sha512.gd`); scalar multiplications through `peer_crypto.gd`; the `cpace` and handshake rows                                                                                                      | Godot runner                                                                                                                                 | .5b, CC-19b.G2            | 60   |
| CC-29b.G2    |     | Godot engine: modes `q` and `l` and the `local` rows                                                                                                                                                                                                             | Godot runner                                                                                                                                 | G1                        | 60   |
| CC-29b.G3    |     | Godot: `services/connect/local_links.gd` (window, join, store, adverts, trial, transfer adoption)                                                                                                                                                                | runner, loopback                                                                                                                             | G2, CC-19b.G4, CC-20b.G3  | 60   |
| CC-29b.G4    |     | Godot native lanes (Apple CryptoKit, Windows Monocypher, Android `:platform`) and the export checks; parity                                                                                                                                                      | CI matrix                                                                                                                                    | G3, b.A                   | 45   |
| CC-29K.1     |     | ui-core `LocalPairingModel` and `PairedDevicesModel`; kit copy; `ui-matrix` rows; the React kit                                                                                                                                                                  | ui-core tests; `gen ui-matrix brand --check`; `ui:lint`; UX review                                                                           | .8, mockup review         | 60   |
| CC-29K.2     |     | SwiftUI and Compose render both models (QR through `PolarisQRCode` and zxing-core)                                                                                                                                                                               | kit snapshot tests; UX review                                                                                                                | K.1, .12, .14             | 60   |
| CC-29K.3     |     | Scanning: iOS and iPadOS (AVFoundation), Android (Q6), the camera pre-prompt                                                                                                                                                                                     | device tests on owner hardware                                                                                                               | K.2, b.A                  | 60   |
| CC-29K.4     |     | The Godot kit: show (with `ui/qr/`), enter, manage                                                                                                                                                                                                               | Godot UI tests; UX review                                                                                                                    | K.1, G3                   | 60   |
| CC-29D       |     | `features/cloud-connect/local-links.md` (with the entitlement snippet); a Help section "Pair with a code" in `help/pair-with-someone.mdx`; `site-map.json`; snippet lanes in `covered.ts` (Node, Python)                                                         | `lint:docs`, `check:links`, snippet lanes                                                                                                    | .8                        | 45   |

**Order.**

- **Wire.** .0 → .1 → .2 → .3 → (.4 alongside .3) → .5 → .5b. In parallel, .6 can start after .0.
- **Node first.** .7 → .8.
- **Then in parallel:** Python, Swift and Kotlin; then Android; then the kits K.1 → K.2 → K.3; and CC-29D.
- **Godot** needs CC-19b.G4 and CC-20b.G3 (`GODOT-CONNECT-2.md`, not started, about 7 slices), then G1–G4 and
  K.4.

**Merge lanes.**

- The V5 text: CC-29.0 alone.
- The corpus: .1 → .2 → .3, then `pnpm gen corpus` after every merge; never merge the output by hand.
- `errors.json`: .0 only.
- Transcripts: .6 only.

**Size.**

- **Build:** 26 slices, 1,530 minutes.
- **Security:** 8 passes and up to 3 fix rounds, about 555 minutes.
- **UX reviews:** about 90 minutes.
- **Total:** about 36 hours, or **0.9–1.2 engineer-weeks** with integration.
- **Critical path:** .0 → … → .5b → .7 → .8 → .11 → .12 → K.2 → K.3 → LP2, about 15 hours. Godot runs on its own
  path behind CC-19b and CC-20b.

## 8. Security sign-off and the cryptographer

**Process.** The process is D-6 of the sign-off plan:

- **Red** (Sonnet 5.5) attacks.
- **Blue** (Sonnet 5.5) tests the defences independently and files its notes before it reads red's.
- **Green** (Opus 5.5) reviews, pushes back, and may put one question to each side.
- Each pass gets one fix round.
- Write-ups stay in the lead's local review notes, and proofs of concept run on local `sec/CC-29-*` worktrees. They are
  never pushed (the repository is public).

| Pass | Covers                                                                                                                                                                     | Red | Blue | Green | After         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | ----- | ------------- |
| LP1  | V5 §15.12, the corpus, client-core `cpace`/`local`/`session`: guess accounting, rotation, busy and limiter, the pin, trial order, records, gate predicate                  | 60  | 45   | 45    | CC-29.5b      |
| LP2  | The Node, Python, Swift, Kotlin and Android ports: secret storage, a listener with no account, gate withdrawal, a sign-out that keeps links, no relay path, scanning input | 60  | 45   | 45    | .14, b.A, K.3 |
| LP3  | The Godot change (D-2): GDScript Elligator2 and X25519 timing, the native-lane routing                                                                                     | 45  | —    | 30    | G4            |

**External cryptographer: new packet part P5** (after P3, through the same engagement; OS-2 is still open). It
covers:

- the CPace instantiation: the suite, the DSI, the PRS encodings, CI equal to the prologue, a sid that is fixed
  per window and reused across attempts until a rotation, and empty AD;
- the composition: ISK through HKDF into the XXpsk0 PSK, with key confirmation by the AEAD tags of messages 1 and
  2;
- whether non-constant-time Elligator2 implementations (JavaScript BigInt, `BigInteger`, Python `int`) are
  acceptable when the generator is precomputed;
- the link secret derived from `h` and ISK, and the per-link static keys;
- the code: a 2-digit nameplate and a 6-digit password, with rotate-on-failure and 5 failures per window.

**Flip.** `launch.localPairing` flips only after LP1 and LP2 PASS and P5 has no open High or Medium (D-7). The Godot
SDK release that carries the feature also needs LP3.

## 9. SDKs that follow, and clients and Workers already deployed

**Who follows.**

| SDK                 | Slices             | Notes                                |
| ------------------- | ------------------ | ------------------------------------ |
| client-core         | CC-29.4, .5, .5b   |                                      |
| Node                | .7, .8             |                                      |
| React               | K.1                | Electron over Node; N/A in a browser |
| Python              | .9, .10            |                                      |
| Swift               | .11, .12, K.2, K.3 |                                      |
| Kotlin JVM          | .13, .14, K.2      |                                      |
| Android             | b.A, K.3           |                                      |
| Godot               | b.G1–G4, K.4       |                                      |
| Worker and manifest | .6                 |                                      |

**Already deployed.**

- **Order.** The Worker ships first (R-15), with the gate off: discovery carries `localPairing: false`, and old
  SDKs ignore the member.
- **SDKs up to v0.10.x** never speak `q` or `l`. They drop `m=q` and `m=l` adverts, and they fail a mode-`l`
  message 1 silently. Modes `a`, `v`, `p` and `c` are unchanged.
- **Pairing needs both devices on an SDK of v0.11 or later.** A joiner on an older app finds nothing ("Can't
  find the other device"), and the docs say so.
- **A new SDK against an old Worker** finds no member, so the feature is off (fail closed).
- **Rollback.** The member disappears, SDKs withdraw at their next refresh, and links stay on disk, inert.
  Nothing on the server needs migrating.

## 10. Repo-side steps (the lead's) and the briefs this changes

**Registry** (`workpackages.json`; then `check.mjs --set`, `pnpm gen graph-index`, and prettier on the
registry and `INDEX.md`):

- **CC-23L:** "Plan: account-free local pairing (local links)". Role `pkey-wire-planner`, `awaiting-approval`,
  `planMode` true, gates `plan-mode`, `human-approval`, `threat-model` and `protocol-version`, refs this file.
- **CC-29:** "Local links: V5 §15.12, corpus, client-core, product switch, Node, Python, Swift, Kotlin" (.0–.14).
  Role `pkey-sdk-porter`, `planMode` true, deps CC-23L, CC-19 and CC-20. Gates `plan-mode`, `protocol-version`,
  `corpus`, `corpus-runner`, `corpus:mirror`, `drift-gate`, `all-sdks`, `rule-9`, `threat-model` and
  `security-review`. About 0.4–0.5 engineer-weeks.
- **CC-29b:** "Local links on Android and Godot". Deps CC-29, CC-19b and CC-20b. About 0.15–0.2 engineer-weeks.
- **CC-29K:** "Pair with a Code kit screens and QR scanning". Gates `pkey-ux-reviewer`, `ui-snapshots` and
  `modernity-lint`. Human input: an iPhone and an Android Play device. About 0.15 engineer-weeks.
- **CC-29D:** "Local links docs and Help", role `pkey-implementer`, about 0.05 engineer-weeks.
- **CC-29S:** "Local links security sign-off (LP1–LP3) and cryptographer part P5", about 0.15–0.2
  engineer-weeks.
- Briefs are `wp/CC-29-local-links.md` and its siblings. Branches are named `wp/CC-29.<n>-local-links`.

**Briefs and plans this changes:**

- **CC-23:** retitle to "Server-recorded contact links". QR and CPace move to CC-23L and CC-29. It stays
  optional.
- **CC-20, V5 §15.11:** "Where it runs" gains mode `l`. The text goes in with CC-29.0, and CC-20's code needs no
  change.
- **The sign-off plan (CC-18-U-44-U-45):** a `launch.localPairing` gate column, packet part P5, and passes
  LP1–LP3.
- **`GODOT-CONNECT-2.md`:** CC-19b.G and CC-20b.G now also unblock CC-29b.
- **`LOCKER-FEATURE-NAMES.md`:** add "Pair with a Code" and "Paired".
- **MASTER-PLAN and REMAINING:** the v0.11 scope rows. MASTER-PLAN's "CC-21–CC-25 not scheduled" row drops QR and
  CPace.
- **CC-17 and CC-19.11:** CC-29D adds a section to `help/pair-with-someone.mdx`.

## 11. Owner steps

1. **Approve this plan** and answer §12.
2. **Test kit:** two devices with no account on one LAN (any SDK), an iPhone or iPad to scan, and an Android device
   with Play services. Add it to `~/Downloads/polaris-key-owner-steps.md`.
3. **The cryptographer (OS-2):** add P5 to the engagement's scope.
4. **No Cloudflare, Apple or Google console step.** Apps that scan declare `NSCameraUsageDescription` themselves.

## 12. Open questions (the recommended option first)

1. **Protocol version.** **(a) Stay at 5: additive modes, like §15.6.1, §15.10 and §15.11.** (b) Bump to 6, with a
   V6 restatement and a constant regenerated in every SDK.
2. **A later sign-in.** **(a) Keep local links separate; to reach across networks, people pair again in mode `p`.**
   (b) Migrate a link into a mode-`c` contact (about 3 more slices; makes the devices correlatable). (c) Drop links
   at sign-in.
3. **Licence.** **(a) No licence check; developers gate on an entitlement in app code.** (b) The SDK requires a
   usable cached licence on each device.
4. **Where the switch lives.** **(a) `connect.localPairing` inside the `connect` block. The product turns on Cloud
   Connect, and so Identity (`connect_requires_identity`), and the feature also waits for `launch.connect`.
   Turning Identity on makes sign-in available but makes no one sign in.** (b) A switch of its own that works with
   Identity and Connect off: a new manifest member, a coherence exception, a discovery member outside
   `services.connect`, and about 2 more slices.
5. **Code length.** **(a) 8 digits: a 2-digit nameplate and a 6-digit password, rotating on every failure, at most 5
   failures per window, so at most 5 × 10⁻⁶ per window.** (b) A 10-digit code (8-digit password), at most
   5 × 10⁻⁸, with more typing.
6. **Scanning in 0.11.** **(a) iOS and iPadOS with AVFoundation (no dependency); Android's Play flavour with
   Google's code scanner (`play-services-code-scanner`, pinned exactly, released at least 14 days earlier, no
   camera permission); typing everywhere else.** (b) CameraX and zxing-core on both Android flavours: a camera
   permission, a viewfinder of our own, about 1 more slice. (c) No scanning in 0.11: the QR is shown only.
7. **Godot in 0.11.** **(a) Yes, after CC-19b.G and CC-20b.G. If those slip, Godot local links ship in a 0.11.x.**
   (b) Port only the shared trial pieces now, so Godot does not wait for contact links.
8. **Kit entry points.** **(a) Separate entries: "Pair with a Code" when `localPairing` is on, and "Pair with Someone
   Nearby" when inter-account links are on and the device is signed in.** (b) One "Pair" entry that offers both
   methods; the people must pick the same one, which needs a UX study.
9. **Link lifetime.** **(a) No expiry; the list shows "last seen" so people can prune.** (b) Forget a link
   automatically after 365 days unseen.

## Approval (lead, 2026-11-03)

Approved with every ★ option in §12 taken (owner rule 2026-10-28: approve plans, record the choice instead of blocking; the owner put account-free local pairing in 0.11 on 2026-11-03). `PROTOCOL_VERSION` stays 5. CC-29.0 (V5 §15.12 and the amendments, the error codes, the THREAT-MODEL rows) is merged; the corpus slices CC-29.1–.3 follow in the corpus lane, then client-core (CC-29.4–.5b) and the SDKs (CC-29.6–.14, CC-29b), the kits (CC-29K) and docs (CC-29D). CPace is in the external cryptographer's scope.

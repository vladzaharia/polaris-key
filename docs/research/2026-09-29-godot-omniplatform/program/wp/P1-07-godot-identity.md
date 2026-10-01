# P1-07 Godot identity: device-code sign-in with a QR code

| Field       | Value                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                        |
| Size        | 0.75–1 engineer-weeks                                                                     |
| Depends on  | [P1-02](P1-02-godot-core.md), [P1-06](P1-06-rfc8628-page.md)                              |
| Unblocks    | [P1-10](P1-10-godot-ui-kit.md)                                                            |
| Role        | `pkey-godot-engineer`                                                                     |
| Plan mode   | no                                                                                        |
| Gates       | none beyond the green gate and the `godot` CI job                                         |
| Human input | a deployed Worker with P1-06 for the one manual end-to-end check (fake server until then) |
| Repo        | `vladzaharia/polaris-key`                                                                 |

## Goal

A player signs in from any Godot build by scanning a QR code or typing an eight-letter code on
another device. `PolarisKey.identity.begin_sign_in()` starts the device-code flow, returns a
prompt with the user code and both verification URLs, polls on the server's cadence (backing off
on `slow_down`), stores the licence-bound token when the flow completes, and syncs. The addon
ships a pure-GDScript QR encoder and a `PKeyQrRect` control that renders
`verificationUriComplete` crisply at any size. Godot is the first SDK with a native device-code
client.

## Why

Device-code sign-in is the only native way to finish an identity sign-in: the Worker has no
loopback or deep-link redirect, and `requires-identity` registration needs a browser cookie a
game never holds (notes/A2 §6, §3.4). For games it is also the right UX: on a Steam Deck in game
mode, a TV or a console the player scans a QR code with a phone (report
[§5.8](../../README.md#58-ui-kit-and-pkeyboot)). No SDK implements it natively today; React
delegates to a host bridge ([PARITY §5.4](../../PARITY.md#54-devices-and-identity),
`identity.devicecode`). Diceroll's cross-device supporter status depends on it (notes/A2 §13).

## Read first

- `AGENTS.md`, the [P1-02](P1-02-godot-core.md) and [P1-06](P1-06-rfc8628-page.md) hand-offs.
- [notes/A2](../../notes/A2-sdk-port.md) §6 (the flow, per-platform UX), §9.5 (the API).
- [notes/E9](../../notes/E9-runtime-building-blocks.md) §8 and §8.1 (the shared boot and sign-in
  experience; QR per runtime).
- [notes/E4](../../notes/E4-godot-ecosystem.md) §3.4 (Kenyoni QR Code, MIT, GDScript, Godot
  4.4+).
- RFC 8628 §3.3–§3.5 (user interaction, polling, `slow_down`) and ISO/IEC 18004 for the encoder.
- Server: `packages/worker/src/services/identity/oidc.ts:729-786` (start) and `:1212-1283`
  (poll); the OpenAPI entries for `/identity/auth/device/{start,poll}` and P1-06's new
  `/identity/auth/device`.
- React's bridge contract for the same flow: `packages/sdk-react/src/desktop/bridge.ts:66-111`.

## Scope

**In:**

- `services/identity.gd` (`PolarisKey.identity`):
  - `is_available() -> bool` from discovery (`services.identity.enabled` and `configured`);
  - `await begin_sign_in(device_name := "") -> PKeySignInPrompt` (`device_code`, `user_code`,
    `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`, `expires_at`; the
    snake_case of P1b-08's `SignInPrompt`);
  - automatic polling with `deviceCode` and the SDK's `X-PKey-Device` id; signals
    `sign_in_pending(prompt)` and `sign_in_finished(result)`; `cancel()`;
  - `open_in_browser(prompt)` (`OS.shell_open(verification_uri_complete)`) and
    `copy_link(prompt)` (`DisplayServer.clipboard_set`) for UI buttons.
- `PKeySignInResult.kind`: `ok`, `timeout`, `expired`, `cancelled`, `denied` (poll `error`),
  `device-mismatch` (401), `rate-limited`, `error`. With Identity off or unconfigured,
  `begin_sign_in` returns `service-unavailable` before any request (D-21, as in every SDK).
  _Correction (implementation):_ as in sdk-node (P1b-08), every 429 on a poll is a `slow_down`
  (the returned interval, else the current one plus five seconds), so `rate-limited` is the start
  refused 429; `timeout` is the server's `timeout` state and `expired` the client's `expires_at`;
  `service-unavailable` is its own kind. A start that fails also emits `sign_in_finished`. The
  lower-level `request_sign_in`, `poll_sign_in` and `wait_for_sign_in` exist for hosts that pace
  the flow themselves and for the transcript replays.
- On `ready`: store the `pkeyt_` token through the token manager with the in-memory token source
  `identity` (P1-03), then `await PolarisKey.sync(true)` so the licence and config documents
  arrive at once. _Correction (implementation):_ the token manager's source for a sign-in is
  `signin` (`PKeyTokenManager.SOURCE_SIGNIN`, P1b-06's `TokenSource`, the same string sdk-node
  uses); there is no `identity` source.
- `ui/qr/`: a QR encoder (byte mode, error-correction level M, versions 1–10, all eight masks
  scored per the standard) returning a module matrix, and `PKeyQrRect extends TextureRect`
  (nearest filtering, a four-module quiet zone, theme colours).
- An `identity` suite against the fake server, and QR fixture tests, in the `ci` set.
- **Opt-in "attach this device's anonymous licence to my account"** (follow-up from P1-06's
  security review). Since P1-06, the sign-in callback never claims, migrates or disables the
  licence the polling device is already on. A device-code flow is confirmed with the public user
  code, so merging at the callback let a user-code holder take the device's anonymous enrolled
  licence over (`docs/security/findings/R8-oidc.md`, R8-02 "The callback merges nothing"). The
  merge now becomes an explicit opt-in that only the device-code holder can make, at
  `/identity/auth/device/poll`. First the device shows the signed-in identity (for example the
  e-mail or name returned with `ready`, or a prior `pending`-with-identity status) and the player
  accepts it on the device. Only then does the device send a poll that asks for its current
  enrolled licence to be attached; the Worker applies `activateFromIdentity`'s claim/migrate
  only for that poll and only for the device id the flow was started with. This needs a server
  half: the poll request and response shape, OpenAPI and `routeCoverage` (rule 10), and attack
  tests extending `R8-oidc.test.ts` › `R8-02 / P1-06 a user-code holder cannot claim…`. It also
  needs a Godot half: a confirmation step in `PolarisKey.identity`, which P1-10's dialog
  renders. The lead decides whether the server half stays here or moves to its own package.
  _Correction (implementation; the lead kept the server half here):_ the callback now stores the
  verified identity and activates nothing for a device-code flow; `/device/poll` activates it.
  Otherwise the claim case could not exist (the callback would already have minted a fresh
  licence for an identity with none). A poll with `confirmIdentity: true` answers
  `{status: "confirm", identity, attachable}` without minting; after the player accepts,
  `attachLicense: true|false` with the device's own bearer completes it, and `ready` reports
  `attached`. Every device-code `ready` also carries `identity` (name, verified e-mail), which is
  what "show the signed-in identity after ready" reads. Godot: `begin_sign_in(name, true)`,
  `sign_in_confirm`, `accept_sign_in(attach)`. _P1-07 review:_ `attachable` is false when a
  migrate would take the identity's licence past its device limit, and when the identity's tier
  has fingerprint mode `strict` (a device-code mint presents no fingerprint, so it would be
  refused after the merge had already been committed).

**Out** (and where it belongs instead):

- `PKeySignInDialog` and its place in the gate and activation panel
  (→ [P1-10](P1-10-godot-ui-kit.md)).
- The server's user-code page (→ [P1-06](P1-06-rfc8628-page.md)); Node, Python and Swift
  clients (→ [P1b-08](P1b-08-devicecode-edgemint-ports.md)).
- A fingerprint on the device-code path, so `strict` tiers work (notes/A2 §15 item 3; unowned).
- Browser OIDC (`identity.oidc`): Godot has no native completion path for it (notes/A2 §9.5).
- Recorded transcripts for the flow (→ [P1b-03](P1b-03-http-transcripts.md)).

## Design notes

- **Polling** (the rules P1b-08 ports): wait at least `interval` seconds between polls. On
  `429 {"status":"slow_down"}` use the returned `interval`, adding 5 s only if none is given
  (RFC 8628 §3.5). Stop at `expires_at`, on `timeout`, `error`, `ready` or `cancel()`. Never poll
  faster because a poll failed. The server enforces the cadence (R8-02).
- **The poll `deviceId` must equal `X-PKey-Device`**, or the server answers 401 device mismatch.
- **`deviceName`** defaults to `OS.get_model_name()` (or a player label); the server truncates it
  to 120 characters and shows it on the confirmation page, which is the anti-phishing cue.
- **Per platform** (notes/A2 §6): desktop shows the code, the QR code, "Open browser" and "Copy
  link"; Steam Deck game mode and TV put the QR code first; iOS and Android open the system
  browser and the player returns to the app (polling completes the flow, no deep link needed);
  on web `OS.shell_open` becomes `window.open`, which popup blockers eat outside an input event,
  so always render the link and the QR code too. Web builds need Worker CORS
  ([P0-05](P0-05-cors.md)).
- **QR choice:** Godot has no built-in encoder. Either vendor Kenyoni QR Code (MIT) under
  `addons/polaris_key/third_party/qr/` with its licence file and pinned version, or write the
  encoder above (about 400 lines). Either way the fixture tests below decide. Record the choice
  in the PR; a vendored licence must ship inside the addon folder (Asset Store rule, notes/E4
  §1.1). _Correction (implementation):_ written, not vendored (`ui/qr/qr_encoder.gd`, about 330
  lines, no licence to carry). The reference encoder is Nayuki's qrcodegen 1.8.0: segno 1.6.6
  appends a 0x00 codeword where ISO/IEC 18004 §7.4.10 adds no padding bits, so its byte-mode
  symbols differ from a conforming encoder's whenever pad codewords exist.
- **Strict tiers:** device-code sign-in sends no fingerprint, so a `strict` tier fails on this
  path. The README (P1-12) says so; do not work around it client-side.
- **Store policy:** signing in through an external browser is fine on iOS and Android; unlocking
  paid content with an externally bought key is not (notes/A2 §6). This work package only signs
  in.
- **Parity registry:** `identity.oidc` has no allowed N/A in PARITY §5.4, but native Godot cannot
  complete it. Raise this for [P1b-01](P1b-01-parity-registry.md): allow a `runtime` N/A for
  native Godot, or define a same-origin web path.

## Steps

1. Write the endpoints for start and poll against the fake server, with every status mapped.
2. Write the polling loop as a coroutine driven by a `Timer`, with cancel and expiry.
3. Hook token storage and the forced sync; confirm the licence gate turns `ok`.
4. Write or vendor the encoder; generate fixtures with a reference encoder; write
   `PKeyQrRect`.
5. Run the manual end-to-end check once P1-06 is deployed.

## Acceptance criteria

- [x] Fake-server tests: start → `pending` → `slow_down` (the returned interval is used) →
      `pending` → `ready` stores the token, emits `sign_in_finished(ok)` and triggers one forced
      sync; `timeout`, `error` and a 401 map to their kinds; `cancel()` stops polling within one
      interval; no poll is sent after `expires_at`.
- [x] `begin_sign_in` on a product whose discovery has `identity.enabled == false` returns
      `service-unavailable` and sends no request.
- [x] Every poll carries the same device id as the `X-PKey-Device` header.
- [x] QR tests: for at least five fixed URLs up to 120 characters, the module matrix equals a
      committed fixture produced by a reference encoder at the same version, level and mask;
      `PKeyQrRect` renders with a quiet zone and nearest filtering.
- [ ] Manual check recorded in the PR: a phone scans the QR code from a desktop build against a
      deployed Worker and the game reaches `ok` without typing. _(Hand-off: needs a deployed
      Worker carrying this package's poll change, a configured IdP and a phone.)_
- [x] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [x] `sdks/godot/parity.json` marks `identity.devicecode` implemented, with test tags (once
      P1b-01 has landed).
- [x] The anonymous-licence attach is opt-in and holder-only. With no opt-in, a device-code
      sign-in leaves the device's anonymous enrolled licence anonymous, active and re-enrollable.
      With the opt-in, the attach happens only on a `/device/poll` carrying the device code and
      the flow's own device id, after the player has accepted the shown identity on the device.
      A user-code holder who confirmed and signed in as themselves can never trigger it. Attack
      tests cover both the claim case and the migrate case.

## Verify

```sh
godot --headless --path sdks/godot -- --pkey-test identity,qr
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.identity`: `is_available()`, `begin_sign_in(device_name, confirm_identity)`,
  `cancel()`, `accept_sign_in(attach_license)`, `open_in_browser(prompt)`, `copy_link(prompt)`,
  `signed_in_identity()` and the three signals `sign_in_pending(prompt)`,
  `sign_in_confirm(confirmation)` and `sign_in_finished(result)`; plus `PKeySignInPrompt`,
  `PKeySignInResult` and `PKeyQrRect`. P1-10's `PKeySignInDialog` is a themed view over exactly
  these, and it must render two things beyond the code and QR:
  - **The confirm step.** On a device that may hold an anonymous enrolled licence, call
    `begin_sign_in(name, true)`. On `sign_in_confirm`, show `confirmation.identity` (name, verified
    e-mail) and ask the player to accept it. Offer "attach this device's licence to my account"
    only when `confirmation.attachable` is true. Answer with `accept_sign_in(attach)`, or
    `cancel()` when the player rejects the identity.
  - **The signed-in identity after `ok`.** Show `PKeySignInResult.identity` (or
    `signed_in_identity()` later, for example in the activation panel). P1-06's accepted residual
    (a user-code holder who signs in as themselves binds the device to their account) relies on
    the player seeing who the device is signed in as.
    _Correction (P1-07 review):_ this bullet used to list only the first five calls and two
    signals, which would have left the confirm step and the identity display out of P1-10.
- The request sequence and result mapping are the reference P1b-08 ports and P1b-03 records.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-07 done`.

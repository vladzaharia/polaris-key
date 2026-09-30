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
- On `ready`: store the `pkeyt_` token through the token manager with the in-memory token source
  `identity` (P1-03), then `await PolarisKey.sync(true)` so the licence and config documents
  arrive at once.
- `ui/qr/`: a QR encoder (byte mode, error-correction level M, versions 1–10, all eight masks
  scored per the standard) returning a module matrix, and `PKeyQrRect extends TextureRect`
  (nearest filtering, a four-module quiet zone, theme colours).
- An `identity` suite against the fake server, and QR fixture tests, in the `ci` set.

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
  §1.1).
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

- [ ] Fake-server tests: start → `pending` → `slow_down` (the returned interval is used) →
      `pending` → `ready` stores the token, emits `sign_in_finished(ok)` and triggers one forced
      sync; `timeout`, `error` and a 401 map to their kinds; `cancel()` stops polling within one
      interval; no poll is sent after `expires_at`.
- [ ] `begin_sign_in` on a product whose discovery has `identity.enabled == false` returns
      `service-unavailable` and sends no request.
- [ ] Every poll carries the same device id as the `X-PKey-Device` header.
- [ ] QR tests: for at least five fixed URLs up to 120 characters, the module matrix equals a
      committed fixture produced by a reference encoder at the same version, level and mask;
      `PKeyQrRect` renders with a quiet zone and nearest filtering.
- [ ] Manual check recorded in the PR: a phone scans the QR code from a desktop build against a
      deployed Worker and the game reaches `ok` without typing.
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [ ] `sdks/godot/parity.json` marks `identity.devicecode` implemented, with test tags (once
      P1b-01 has landed).

## Verify

```sh
godot --headless --path sdks/godot -- --pkey-test identity,qr
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.identity` (`is_available`, `begin_sign_in`, `cancel`, `open_in_browser`,
  `copy_link`, the two signals), `PKeySignInPrompt`, `PKeySignInResult` and `PKeyQrRect`: P1-10's
  `PKeySignInDialog` is a themed view over exactly these.
- The request sequence and result mapping are the reference P1b-08 ports and P1b-03 records.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-07 done`.

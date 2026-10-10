# P1b-08 Port device-code sign-in and edge-mint to Node, Python and Swift

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                 |
| Size        | 1–1.5 engineer-weeks                                                                                                            |
| Depends on  | [P1b-03](P1b-03-http-transcripts.md), [P1-06](P1-06-rfc8628-page.md), [P0-12](P0-12-edge-mint-hardening.md)                     |
| Unblocks    | none                                                                                                                            |
| Role        | `pkey-sdk-porter`                                                                                                               |
| Plan mode   | no                                                                                                                              |
| Gates       | all SDKs; new transcripts through P1b-03's harness (`pnpm gen transcripts --check`); Swift `Package.swift`; `pnpm parity:check` |
| Human input | none (the IdP is mocked in the Worker scenarios)                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

Node, Python and Swift can sign in with a device code:

- begin, and get back the user code, the verification URI and its complete form (the QR payload);
- poll at the advertised interval, honouring `slow_down` and expiry;
- on success, store the device token and run the post-activation sync.

They can also mint third-party tokens through edge-mint, with an in-memory cache that lasts until
expiry. New transcripts pin both flows and replay green in the three SDKs, and `identity.devicecode`
and `config.mint` are `implemented` in their manifests.

## Why

Device-code sign-in exists only through React's desktop bridge, whose host implements it; the Node
SDK does not ([PARITY §5.4](../../PARITY.md#54-devices-and-identity) footnote 5). Edge-mint exists in
no SDK ([§5.3](../../PARITY.md#53-config),
[notes/A2 §14](../../notes/A2-sdk-port.md#14-repo-divergences-found-along-the-way-worth-tickets)
item 4). Godot builds both first ([P1-04](P1-04-godot-config.md) for edge-mint, P1-07 for the device
code), and this package brings the other native SDKs level ([PARITY §8](../../PARITY.md#8-parity-gaps-to-close-now)).

## Read first

- `AGENTS.md`, `CLAUDE.md`; [notes/A2 §6](../../notes/A2-sdk-port.md#6-identity-for-games),
  [§9.3](../../notes/A2-sdk-port.md#93-config) (edge-mint row) and
  [§9.5](../../notes/A2-sdk-port.md#95-identity) (the proposed Godot surface this mirrors).
- The [P1-06](P1-06-rfc8628-page.md), [P1-04](P1-04-godot-config.md) and
  [P1-07](P1-07-godot-identity.md) briefs, and what they shipped.
- Device flow in the Worker (`packages/worker/src/services/identity/`):
  - `routes.ts:1-40`;
  - `oidc.ts:728-787` (`POST /<p>/identity/auth/device/start`);
  - `oidc.ts:1211-1290` (`POST /<p>/identity/auth/device/poll`);
  - `oidc.ts:1140-1180` (`pollAuthFlow`, the `ready` body);
  - `DEVICE_POLL_INTERVAL_SECONDS = 2` and `FLOW_TTL_SECONDS = 600` (`oidc.ts:64-66`).
- Edge-mint in the Worker: `packages/worker/src/services/config/mint.ts:184-296` (`handleMintToken`),
  `services/config/routes.ts:41-46`, and OpenAPI `/{product}/config/mint/{mintId}/token`
  (`mintTokenGet`), as hardened by [P0-12](P0-12-edge-mint-hardening.md).
- React's current flow: `packages/sdk-react/src/desktop/desktopAdapter.ts:214-275`
  (`signInWithOidc`, `pollUntilSettled`) and `desktop/bridge.ts:67-89` (`BridgeOidcBegin`,
  `BridgeOidcPoll`).
- IdP mocking for scenarios: `packages/worker/test/oidcEdge.test.ts:30-45,617-630`.
- SDK structure: Node `src/client.ts` (sub-clients, `onLicenseAcquired`), Python `client.py`, Swift
  `Package.swift` and `Sources/PolarisKey/PolarisKeyClient.swift`.

## Scope

**In:**

- **Transcripts** through P1b-03's harness:
  - `devicecode-happy`: start, pending, `slow_down`, pending, the human confirms (a server-side step
    inside the scenario), ready;
  - `devicecode-expired`;
  - `edge-mint`: success, 404 for an unknown recipe, 429, and a 401 for a token the Worker no
    longer honours (the device was deauthorized), followed by the one re-acquire, which 401s too.
    _(Corrected at implementation: a client holding NO token refuses `unauthorized` locally
    without a request, so "401 without a token" is not a conversation; it is a unit test. The
    transcript also pins the in-memory cache: a second mint inside the lifetime makes no request.)_
- **Node:**
  - `client.identity.beginSignIn({ deviceName? }): Promise<SignInPrompt>`;
  - `client.identity.pollSignIn(prompt): Promise<SignInPoll>`;
  - `client.identity.waitForSignIn(prompt, { signal? }): Promise<SignInResult>`;
  - `client.config.mintToken(recipeId): Promise<{ token, expiresAt }>`.
- **Python:** `identity.begin_sign_in(device_name=None)`, `identity.poll_sign_in(prompt)`,
  `identity.wait_for_sign_in(prompt, timeout=None, *, cancel=None)`, `config.mint_token(recipe_id)`.
  _(Corrected at implementation: `cancel`, a `threading.Event`, is the synchronous SDK's
  cancellation, since "cancellation stops polling" is an acceptance row.)_
- **Swift:**
  - a new library target `PolarisKeyIdentity` (depends on Core) with
    `beginSignIn(deviceName:) async throws -> SignInPrompt`,
    `pollSignIn(_:) async throws -> SignInPoll` and
    `waitForSignIn(_:) async throws -> SignInResult` (cancelled by task cancellation);
    _(corrected at implementation: `pollSignIn` is needed, because the transcripts are made of
    single polls and every SDK replays them)_
  - `ConfigClient.mintToken(_:) async throws -> MintedToken`.
- Unit tests for interval and `slow_down` handling, expiry, cancellation and the mint cache; the
  transcript replays; manifests; the SDK docs pages.

**Out** (and where it belongs instead):

- The RFC 8628 user-code page and any change to the poll statuses (→ [P1-06](P1-06-rfc8628-page.md));
  Godot (→ [P1-04](P1-04-godot-config.md), [P1-07](P1-07-godot-identity.md)).
- QR rendering and sign-in UI (→ [P1-10](P1-10-godot-ui-kit.md) for Godot; `ui.kit` elsewhere). The
  SDKs return `verificationUriComplete` for the host to render.
- A fingerprint on the device flow, so that strict tiers can use it (notes/A2 §14 item 11; a Worker
  change with no owner yet).
- React edge-mint and browser device code. React is not named in this package. Its manifest keeps
  `config.mint` as P1b-01 decided. Moving the Electron host bridge onto the new Node API is optional
  and belongs to adopters.

## Design notes

**Wire shapes today; re-read them after P1-06.**

- Start (`POST …/identity/auth/device/start`):
  - body `{ deviceId?, deviceName? }`; the device id falls back to the `X-PKey-Device` header;
  - answers `status: "pending"` with `deviceCode`, `userCode`, `verificationUri`,
    `verificationUriComplete`, `expiresIn`, `interval` and `pollUrl`.
- Poll (`POST …/identity/auth/device/poll`), body `{ deviceCode, deviceId }`. Answers:
  - `{ status: "pending" }`;
  - `429 { status: "slow_down", interval }`;
  - `{ status: "timeout" }`;
  - `{ status: "error" }`;
  - `401` on a device mismatch;
  - `{ status: "ready", token, schemaVersion }`.
- PARITY §4.2 speaks of RFC 8628's `authorization_pending` and `expired_token`; the Worker does not
  use those names. The transcript captured after P1-06 is the reference, whatever names it has.

**Polling rules.**

- Wait at least `interval` seconds between polls.
- On `slow_down`, use the returned `interval`, and add 5 seconds if none is given (RFC 8628 §3.5).
- Stop at `expiresIn`, or on `timeout`, `error` or cancellation.
- Never poll faster because a poll failed.
- A `ready` result stores the token through the token manager and fires the same post-acquisition
  sync `activate()` does (Node `onLicenseAcquired`; Python and Swift equivalents).

**Service gating.** `beginSignIn` requires the Identity service
(`requireService("identity")`, D-21), and `mintToken` requires Config. When the service is off, both
refuse with `service-unavailable` before any request.

**Edge-mint.**

- `GET /<p>/config/mint/<recipeId>/token` with the device bearer; the body is `{ token, expiresAt }`
  with `cache-control: no-store`.
- Cache in memory only, keyed by recipe id, and reuse it until `expiresAt` minus a small margin
  (30 seconds). Never write it to the cache file or the keyring: minted tokens are short-lived
  secrets.
- On 401, apply the normal single re-acquire (and P1b-06's re-register) once, then fail.
- Recipe ids match the router's `MINT_ID` pattern (`services/config/routes.ts`); validate locally.

**Names** follow notes/A2 §9.3 and §9.5 (Godot's `config.mint_token(recipe_id)`,
`identity.begin_sign_in(device_name)`), camelCased for TypeScript and Swift (PARITY §2.1). Errors use
the generated `ErrorCode` from [P1b-02](P1b-02-sdk-constants.md). _(At implementation P1b-02 had
not landed, so the SDKs raise the Worker's own wire codes — `not_found`, `unauthorized`,
`rate_limited`, `bad_request` — and the client codes `service-unavailable`, `network-error`,
`server-error` and `cancelled` as string literals, ready for P1b-02 to replace.)_

## Steps

1. Record the three transcripts (the IdP is mocked as in `oidcEdge.test.ts`); regenerate.
2. Node: `identity` sub-client and `config.mintToken`, with unit tests and replay.
3. Python, then Swift (new target, `Package.swift` products and test dependencies).
4. Update the manifests and SDK docs pages; run the green gate.

## Acceptance criteria

- [x] `conformance/transcripts/devicecode-happy.json`, `devicecode-expired.json` and `edge-mint.json`
      exist with Swift mirrors, and `pnpm gen transcripts --check` passes.
- [x] Node, Python and Swift replay all three green.
- [x] Unit tests in each SDK show:
  - [x] no poll comes earlier than `interval`;
  - [x] `slow_down` lengthens the interval;
  - [x] expiry and cancellation stop polling;
  - [x] a second `mintToken` inside the expiry window makes no request;
  - [x] a disabled service refuses before any request.
- [x] `parity.json` manifests are updated for every SDK this changes (`identity.devicecode` and
      `config.mint` in Node, Python and Swift), and `pnpm parity:check` passes.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen transcripts --check
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Interfaces:**
  - `identity.beginSignIn`, `pollSignIn` and `waitForSignIn` (snake_case in Python);
  - `SignInPrompt` with `deviceCode`, `userCode`, `verificationUri`, `verificationUriComplete`,
    `expiresIn` and `interval`;
  - `config.mintToken` returning `{ token, expiresAt }`;
  - Swift's `PolarisKeyIdentity` target; the three transcripts.
- An Electron host can now drive its bridge's `beginSignIn`/`pollSignIn` from the Node SDK instead of
  its own code. Kotlin (P6-05) and C# (X-01) replay the same transcripts.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-08 done`.

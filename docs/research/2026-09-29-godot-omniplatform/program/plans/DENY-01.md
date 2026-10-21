# DENY-01 plan: the device-code poll names a refusal

Follow-up to B-096 (`_mockups/review/stabilization/bug-ledger.md`) and item 9 of the locker-final
UX review (`data/deny-poll.txt`). Status: **awaiting approval**. Nothing is implemented. Judged at
`integ/next-stage` `48e482356`. This plan revisits I-37's D3 ("Deny reuses the generic `error`").

**Proposed work-package row** (not yet in `workpackages.json`; see D6 for the id):

| Field         | Value                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| id            | `DENY-01` (filed as **`I-37c`** with `planRef: "DENY-01"`, D6)                                                                        |
| title         | Device-code poll names a refusal (`error` + `reason: "access_denied"`); kits tell declined from failed                                |
| phase / lane  | `I` / `sdk`                                                                                                                           |
| role          | `pkey-sdk-porter` (the Worker part is two lines in `poll.ts`)                                                                         |
| estimateWeeks | `[0.4, 0.6]`                                                                                                                          |
| deps          | `I-37b` (done); starts after the v0.9.15 tag (D5)                                                                                     |
| planMode      | `true`                                                                                                                                |
| gates         | `plan-mode`, `drift-gate`, `corpus`, `all-sdks`, `threat-model`, `rule-10`, `docs-generated`, `docs-links`, `ui-snapshots`, `workerd` |
| humanInputs   | D1–D6 below                                                                                                                           |
| refs          | `plans/DENY-01.md`; `plans/I-37.md` D3; ledger B-096; locker-final `ux-review.md` item 9                                              |

## 0. The gap, precisely

Both deny writers (`decideDeviceFlow` and `denyChosenDeviceFlow` in `productOidc/deviceApproval.ts`)
set the flow record's `error: "denied"`. `poll.ts` then answers a bare `{"status":"error"}` in two
places: line 113 (`pollAuthFlow`) and line 319 (the pre-sign-in branch B-096 added). The same bare
`error` also covers the post-approval refusals: N9 (account refused), a failed activation and a
failed mint. Since I-37b every SDK maps that `error` to `sign-in-denied`, so the kits say
"Sign-in declined" for **every** failure. The copy is false whenever the cause was not a Deny.
`help-messages.json` admits this: "It was refused or it failed, and the service doesn't say which."

## 1. Summary

- **The wire.** A refusal answers `{"status":"error","reason":"access_denied"}` at HTTP 200. Every
  other failure stays the bare `{"status":"error"}`. The status set does not change.
  `PROTOCOL_VERSION` stays 4 and `corpusVersion` stays 2. No route, header or signed shape changes.
- **SDKs.** `reason: "access_denied"` maps to `sign-in-denied`, which keeps its copy. A bare `error`
  maps to the existing `sign-in-failed` ("Sign-in failed / Sign-in didn't finish. Try again.").
  No new error code is added.
- **Kits.** SignInHandoff gains a `failed` state beside `denied`. The `cli` family gains the `login`
  outcomes `sign-in-denied` and `sign-in-failed`. `uiMatrixVersion` goes from 4 to **5**.
- **Transcripts.** `devicecode-denied.json` is re-recorded, and its two refused polls gain
  `reason`. A new transcript, `devicecode-failed.json`, pins the bare `error`. Every other
  device-code transcript stays byte-identical.
- **Deployed builds see no change.** They ignore the new member and keep saying "Sign-in
  declined", exactly as today.

## 2. Contract

**Shape (D1).** Option C is recommended: an optional `reason` member on the existing `error`.
A new top-level `denied` status (A) would regress every deployed build:

- Node, React, Python, Swift and Kotlin fall to their `default` arm, which is a code-less
  "device sign-in failed.";
- Godot answers `invalid-response`, "The poll answered an unknown state.".

All of them stay terminal and hold no token, so nothing is unsafe. But a deployed TV would lose
the "Sign-in declined" it shows on a Deny today. Option B (a `denied` status behind a request
opt-in) avoids that, but it adds a request member forever and changes the exact-match poll body in
all six device-code transcripts.

**`docs/security/WIRE-CONTRACT-V4.md`.** Add **§12.10 "The device-code poll [C]"**. Until now
only the OpenAPI file described the route (I-37 §2). It is SDK-facing and replayed by six SDKs, so
it belongs in the contract. Pinned by `devicecode-*.json` and `locker-devicecode.json`.

| HTTP | Body                                          | Meaning                                                                              | SDK result            |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| 200  | `{"status":"pending"}`                        | Not yet confirmed, signed in and approved                                            | keep polling          |
| 429  | `{"status":"slow_down","interval":n}`         | Polled inside `interval` (a state, not an error body)                                | lengthen the interval |
| 200  | `confirm` / `ready`                           | Unchanged (I-37: `attachable` always `false`)                                        | unchanged             |
| 200  | `{"status":"timeout"}`                        | The flow is gone: expired, redeemed, or dropped after a refusal                      | `expired`             |
| 200  | `{"status":"error","reason":"access_denied"}` | A person refused: Deny, **Not you?**, the chooser's Cancel, or Deny on the code page | `sign-in-denied`      |
| 200  | `{"status":"error"}`                          | The sign-in failed after approval; the cause is not said                             | `sign-in-failed`      |

The rules:

1. `reason` appears only on `error`, and `access_denied` is its only value. A client reads an
   unknown `reason` as absent.
2. A refusal is sticky: the poll answers it until the flow lapses (600 s), then `timeout`.
3. Every refusal gets the same body, whichever page refused and whether or not the person had
   signed in.
4. No account, identity, provider or licence cause is ever named. These stay the bare `error` (D8).

**RFC 8628.** The route does not use RFC 8628's token-endpoint wire. It maps the RFC's codes to
statuses, as the OpenAPI text already says: `pending` stands for `authorization_pending`, `timeout`
for `expired_token`, and `slow_down` keeps the RFC's own spelling. `reason: "access_denied"` is
§3.5's `access_denied`. It is also the token §12.4 returns on Cancel, and the one SIGN-IN.md
§3.6 and §6.2 use for Cancel "on every surface" (D2). The member is not named `error`: the
constants generator scans `error:` literals as wire codes, and the flat-error parsers read
`error`.

**`packages/shared-protocol/src/identity.ts`.** The route has no type today. Add these, and make
the Worker's answers `satisfies` them:

```ts
export const DEVICE_POLL_DENIED = "access_denied" as const;
/** §12.10: `POST /<p>/identity/auth/device/poll` at HTTP 200. */
export type DevicePollResponse =
  | { status: "pending" }
  | {
      status: "confirm";
      identity: { name?: string; email?: string };
      attachable: false;
    }
  | {
      status: "ready";
      token: string;
      schemaVersion: number;
      identity?: { name?: string; email?: string };
    }
  | { status: "timeout" }
  | { status: "error"; reason?: typeof DEVICE_POLL_DENIED };
/** §12.10: the same route at HTTP 429 (a state, not an error body). */
export interface DevicePollSlowDown {
  status: "slow_down";
  interval: number;
}
```

`shared-jws` and `client-core` don't change: client-core has no identity poll.

**`conformance/parity/errors.json`.** No new entry. Two descriptions change:

- `sign-in-denied` narrows to "a device-code poll answered `error` with the `access_denied`
  reason: a person refused …". It adds that builds before DENY-01 also raise it for a bare
  `error`.
- `sign-in-failed` widens from "React: …" to "every SDK: a device-code poll answered a bare
  `error` …".

Hosts that match `sign-in-denied` keep getting it for a Deny. A failure now reports
`sign-in-failed`. The Python, Swift, Kotlin and Godot `CHANGELOG.md` files and the docs
changelog say so.

## 3. Catalog and manifests

None. `shared-catalog` and `shared-manifest` are untouched, and no rule-9 entry is needed.

## 4. Corpus and transcripts

- **`tools/ui-matrix.ts`:**
  - `DEVICE_CODE_PHASES` gains `failed` after `denied`.
  - Add `row("SignInHandoff/failed", dc("failed"), "SignInHandoff", "failed", "all")`, with the
    automatic sheet twin. It expects `core.codes.sign-in-failed.{title,message}` and
    `signInHandoff.newCode`, with action `retry`.
  - `CLI_SITUATIONS` gains `sign-in-denied` and `sign-in-failed`: "`login`: the poll answers
    `error` with / without `reason`".
  - Each situation gets an outcome row and its `--json` twin (below).
  - The header comment gains the version-5 line.
- **`packages/brand/kit-copy/components.json`.** SignInHandoff gains the `failed` state below.
  All its strings already exist in nine locales.

```text
...outcome("sign-in-denied", "login",
  { mark: "fail", exit: 1, error: "sign-in-denied", stdout: "screen" },
  { exit: 1, error: "sign-in-denied" }),
...outcome("sign-in-failed", "login",
  { mark: "fail", exit: 1, error: "sign-in-failed", stdout: "screen" },
  { exit: 1, error: "sign-in-failed" }),
// components.json, SignInHandoff.states:
"failed": { "copy": ["core.codes.sign-in-failed.title", "core.codes.sign-in-failed.message", "signInHandoff.newCode"] }
```

- **Regenerate:**
  - `pnpm gen ui-matrix`;
  - `pnpm gen corpus` (the Godot mirror `sdks/godot/tests/corpus/v2/ui-matrix.json`);
  - `pnpm gen brand` (each SDK's kit-copy bundle);
  - `pnpm gen constants` (`UI_MATRIX_VERSION` = 5 and the two error descriptions);
  - `pnpm gen docs-reference` (`reference/error-codes.mdx`, `reference/protocol/corpus.mdx`).
- **Transcripts** (`packages/worker/test/transcripts/scenarios/identity.ts`, then
  `pnpm gen transcripts`, Godot mirror included):
  - **`devicecode-denied`:** re-recorded. The two refused polls answer `reason`, the
    `sign-in-denied` expectation is unchanged, and the description is reworded.
  - **New `devicecode-failed`:** the player confirms, signs in and approves. Before the
    poll, the account is disabled (N9). An unusable licence for the identity
    (`license-unusable`) also works. The poll answers a bare `error`, which the SDK
    reports as `{result: "error", code: "sign-in-failed", tokenHeld: false}`. The next poll answers
    `timeout`, which the SDK reports as `expired`.
  - `devicecode-happy`, `-default`, `-expired`, `-label` and `locker-devicecode` stay
    byte-identical.
- **Not touched:** `gate-matrix.json`, the `gate` and `cli.gate` families (no sign-in rows), and
  every signed file.

## 5. SDKs, in order

Every SDK below replays both transcripts and runs the new ui-matrix rows. There are no typed N/As:
`identity.devicecode` is implemented in all six, and client-core has no poll.

| SDK     | Poll mapping                                                                                                    | Kit: the declined and failed screens                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ui-core | n/a                                                                                                             | `vocabulary.ts` (`failed`); `models/signIn.ts` (`HandoffState` and view `failed`, tone danger, error slot `screen`); `terminal.ts` `handoffView` (`denied` drops the `oidc_error` keys for `sign-in-denied`, adds `failed`); `test/decisions.test.ts` |
| Node    | `src/identity/client.ts` `case "error"` reads `reason`                                                          | `src/cli/flows.ts`: three ways (expired, denied, failed; `--json` `state: "failed"`). `electron/main.ts` keys on the code (unchanged)                                                                                                                 |
| React   | `src/browser/bearer/session.ts` (the arm, and the `code` type at :175)                                          | `browserAdapter.ts` `signInResult` and the desktop bridge already key on the code (unchanged). SignInHandoff renders through ui-core                                                                                                                  |
| Python  | `identity/client.py` (`status == "error"`)                                                                      | `ui/core/models.py`: drop the `"denied" in message` heuristic, key on the code, add `failed`. `ui/terminal/screens.py`. CLI goldens `sign-in-handoff-failed-{light,dark}`                                                                             |
| Swift   | `PolarisKeyIdentity/IdentityClient.swift` `case "error"`                                                        | `PolarisKeyUICore/States/SignInFamily.swift` (`.failed`). `PolarisKeyUI/PolarisSignIn.swift:119` already splits on the code                                                                                                                           |
| Kotlin  | `identity/.../IdentityClient.kt` `"error" ->`                                                                   | `ui-core/.../KitSignInStates.kt` (`failed`). `PolarisSignInState.kt` already has `Denied` and `Failed`. `ui/.../PolarisSignIn.kt` and `KitSamples.kt`                                                                                                 |
| Godot   | `services/identity.gd` `_poll`: `access_denied` → `denied`, a bare `error` → `KIND_ERROR` with `SIGN_IN_FAILED` | `ui/model/sign_in.gd` (`HANDOFF_STATES`, `failed`), `ui/sign_in/sign_in_controller.gd`, `tests/ui/scenarios.gd`                                                                                                                                       |

Runners: `conformance/runners/node/transcripts.test.ts`, `sdk-react/test/transcripts.test.ts`,
Python `tests/test_transcripts.py`, Swift `TranscriptTests.swift` and `UIMatrixTests.swift`, Kotlin
`:conformance` and `:ui-core`, and Godot `suite_transcripts.gd` and `suite_ui_core.gd`. If Kotlin's
`TranscriptTest.kt` lists transcript ids, `devicecode-failed` is added to that list.

## 6. Worker

- **`productOidc/poll.ts`.** Both sites answer `{status: "error", reason: DEVICE_POLL_DENIED}`
  when `flow.error === FLOW_DENIED`. `FLOW_DENIED` is `deviceApproval.ts`'s `DENIED`, exported and
  renamed. Any other `flow.error`, and every other `error` site, stays bare.
- **Rule 10.** No route is added, and the descriptor surface in `identity/routes.ts` is unchanged.
  `openapi/polaris-key.v3.yaml` changes in three places:
  - `AuthFlowState` gains `reason: {type: string, enum: [access_denied]}`;
  - the description of `deviceAuthPoll` loses "`error` deliberately carries no reason" and gains
    rules 1–4;
  - a `denied` example is added.

  Run `routeCoverage` anyway.

- **Tests:**
  - `deviceApproval.test.ts` and `oidcLicenseChoice.test.ts` (chooser Cancel) expect `reason`.
  - `hostedSigninPages.test.ts` (B-096) gains an assertion that the pre-sign-in and post-sign-in
    refusals produce the same body.
  - A new case asserts that N9, a refused activation, a failed mint and `oidcEdge`'s device
    mismatch stay bare.
- **Unchanged:** no migration, no table (`TABLE_OWNERS`), no `Env` member, and no new audit verb
  (`identity.signin.device_denied` is already written).

## 7. Security: what "denied" tells a device-code poller

- **Who can see it.** Only a holder of the secret device code who polls with the `deviceId` the
  flow was started for. Any other device gets a 401. The poll allows 40 a minute per code and 120
  per network, and the interval is enforced. A user-code holder cannot poll.
- **What it says.** One fact: a person refused this flow on a page reached through its code. It
  says nothing else:
  - not who refused, or which page;
  - not whether they had signed in (rule 3; tested);
  - no identity: `DENY_UNSET` already strips it from the record;
  - no provider or licence cause.
- **It is nothing the poller cannot already learn.**
  - Before approval, the only reachable `error` is a refusal. `pollAuthFlow`'s flow-device
    mismatch is also an `error`, but the 401 on the device record comes first, so it cannot be
    reached.
  - After approval, the account refusals (N9, activation) delete the flow, so their `error` is
    followed by `timeout`. A refusal's `error` repeats until the record lapses.
  - The starter can also see the user code stop resolving on the public entry page once anyone
    decides.

  `reason` names what that sequence already shows. D8 still holds: the bare `error` never says
  which account or licence reason applied.

- **Compared with `timeout`.** Both are terminal, identity-free facts about the holder's own
  flow. `timeout` says the flow is gone, and `access_denied` says a person ended it.
- **Under R1-07** (the starter is an attacker), the attacker learns that the victim refused. That
  is the outcome the approval page exists to produce, and it gives the attacker nothing usable.
  Nothing in the request can set or probe `reason`: it comes only from the server-side record.
- **`THREAT-MODEL.md`.** In "The device-code user-code page (P1-06)", control 5 gains one
  paragraph with this argument. Under "Remote phishing", the line "Deny answers `error`" becomes
  "Deny answers `error` + `access_denied`".

## 8. Rollout

1. **Timing (D5).** Merge after the v0.9.15 tag. The reviewer filed this as a follow-up, not a
   fix for that tag. That tag ships `uiMatrixVersion` 4, so this package bumps it to 5.
2. **The Worker deploys first** (from `main`, as always). Flows already denied at deploy carry
   `error: "denied"` in their record and get `reason` at once. Nothing is migrated.
3. **Deployed SDKs and kits** ignore `reason`, so they behave exactly as today: every `error`
   reads "Sign-in declined".
4. **New SDKs against an older Worker** (only after a rollback): every `error` reads "Sign-in
   failed. Sign-in didn't finish. Try again.", which is true for both causes.
5. **Rollback** drops `reason` and nothing else. No state needs undoing.

## 9. Decisions for the lead

| #   | Question                    | Options                                                                                                                                                                   | Recommendation                                                                                                                                                                     |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Shape                       | A. New status `denied`. B. `denied` behind a request opt-in. C. `error` + `reason`                                                                                        | **C.** Deployed builds are unchanged, there is no request member, and the transcript churn is one file                                                                             |
| D2  | Spelling                    | `access_denied` / `denied`                                                                                                                                                | **`access_denied`**: RFC 8628 §3.5, §12.4's Cancel, and SIGN-IN.md's "on every surface". It is a `reason`, not a wire code, so the retired §13 `access_denied` code is not revived |
| D3  | What a bare `error` maps to | A. `sign-in-failed` (it exists, with copy in nine locales). B. Keep `sign-in-denied`. C. A new code                                                                       | **A**                                                                                                                                                                              |
| D4  | The kits' generic failure   | A. A pinned SignInHandoff `failed` state plus the two `login` rows, `uiMatrixVersion` 5. B. Leave it to each kit's own fallback                                           | **A.** Today the fallbacks differ: Kotlin `Failed`, Swift `signInFailed`, ui-core's SignIn/error "{method} sign-in…", and the terminal shows `oidc_error`                          |
| D5  | When, and the copy          | When: A. after v0.9.15. B. In it. Copy: A. Keep "Sign-in declined / Sign-in was declined. Start again." B. "Sign-in denied", to match the Deny button and the hosted page | **After v0.9.15; keep the copy.** "…on your other device" would be false for `signInWithBrowser()` on the same computer                                                            |
| D6  | The id                      | `DENY-01` fails `workpackages.schema.json`'s id pattern. A. File it as `I-37c` with `planRef: "DENY-01"`. B. Widen the pattern                                            | **A**                                                                                                                                                                              |

**Out of scope (noted).** A failed mint answers `error` and restores the flow, so a retry could
succeed. Every SDK treats `error` as terminal, though. It should become a 5xx (a transient that
SDKs ride out) in its own package.

## 10. Order, drift gates and acceptance

The order follows rule 2. Each step is one commit in one PR:

1. **Contract:** the protocol types, §12.10, the OpenAPI changes and the `errors.json` text.
2. **Worker:** `poll.ts`, its tests, and the re-recorded `devicecode-denied`. Every SDK suite stays
   green here, because they ignore `reason`.
3. **Catalog:** none.
4. **Corpus:** `ui-matrix.ts`, `components.json` and the new `devicecode-failed` scenario.
5. **SDKs:** ui-core, then Node, React, Python, Swift, Kotlin and Godot.
6. **Docs:**
   - the THREAT-MODEL edits from §7;
   - the `features/sign-in/device-flow.md` poll table and `troubleshooting.md`;
   - the `help-messages.json` `sign-in-denied` "why";
   - `UI-KITS.md` §4.1 (the SignInHandoff states);
   - the Swift and Godot `your-own-ui.md` pages;
   - the SDK READMEs.

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- deviceApproval hostedSigninPages oidcLicenseChoice oidcEdge R8-oidc routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd && mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm gen --check            # corpus (+ Godot mirror), ui-matrix, transcripts (+ mirror), constants, brand, docs-reference, parity
mise exec node@22 -- pnpm typecheck && mise exec node@22 -- pnpm --filter @polaris-key/ui-core --filter @polaris-key/conformance-node --filter @polaris-key/react --filter @polaris-key/node test
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_transcripts.py tests/test_ui_contract.py tests/cli )
( cd sdks/swift && swift test --filter 'TranscriptTests|UIMatrixTests|KitModelTests' )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :identity:test :ui-core:test :conformance:test )
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm ui:report && mise exec node@22 -- pnpm --filter @polaris-key/docs lint:docs
mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

The reviewer checks two things in the diff:

- every device-code transcript except the two named ones is byte-identical;
- no SDK still maps a bare `error` to `sign-in-denied`.

## 11. Briefs this plan changes (applied by the lead on approval)

- **New `I-37c`** (or `DENY-01`): the row above, with a brief at `wp/I-37c-device-poll-denied.md`.
- **`plans/I-37.md`:** D3 gains "superseded by plans/DENY-01.md (C)". §2's "the device-code routes
  are not a contract surface" points to §12.10.
- **`wp/I-37b-device-code-denied-kits.md`:** a note that DENY-01 narrows `sign-in-denied` to
  refusals.

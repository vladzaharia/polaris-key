# MINT-01 plan: a failed mint on the device-code poll is retried, not reported

Follow-up to `plans/DENY-01.md` §9 ("Out of scope"). Status: **awaiting approval**. Nothing is
implemented. Judged at `integ/next-stage` `192344816`, where I-37c (DENY-01) is merged. The last
tag is `v0.9.13`, so every build in the field predates DENY-01.

**Proposed work-package row** (not yet in `workpackages.json`; the lead files it on approval):

| Field         | Value                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| id            | `I-37d` (refs `plans/MINT-01.md`)                                                                                                   |
| title         | Device-code poll: a transient failure after approval answers `503 unavailable` and the Worker retries; a refused mint ends the flow |
| phase / lane  | `I` / `worker`                                                                                                                      |
| role          | `pkey-implementer` (the six SDK changes are test-only, in the transcript runners)                                                   |
| estimateWeeks | `[0.3, 0.5]`                                                                                                                        |
| deps          | `I-37c`                                                                                                                             |
| planMode      | `true`                                                                                                                              |
| gates         | `plan-mode`, `drift-gate`, `all-sdks`, `threat-model`, `rule-10`, `docs-generated`, `docs-links`, `workerd`                         |
| humanInputs   | D1–D7 below                                                                                                                         |
| refs          | `plans/MINT-01.md`; `plans/DENY-01.md` §9 "Out of scope"; `wp/I-37c-device-poll-denied.md` "Out"                                    |

## 0. The gap, precisely

`pollAuthFlow` (`packages/worker/src/services/identity/productOidc/poll.ts`) redeems the flow
(`consumeArtefact`, l. 204) before it mints. When `authorizeAndMint` throws, the flow record goes
back with its `licenseId` (l. 209–217) and the poll answers the bare `{"status":"error"}` (l. 218).
The next poll would mint again. Two different failures reach that `catch`:

- **Transient.** D1, the single-use store or the key vault throws inside `getLicense`,
  `claimDeviceSeat` or `bindDevice`. A retry may succeed.
- **Refusal.** `authorizeAndMint` turns every `AuthzError` (`device_limit`, `fingerprint_required`,
  `hardware_mismatch`, `unauthorized`) and a missing licence into a throw (l. 65, l. 72). A retry
  fails the same way, and each attempt writes one `refusals` row (UX-15).

Since I-37c, every SDK reports the bare `error` as `sign-in-failed` and stops polling. Builds up to
v0.9.13 report it as `sign-in-denied` instead. Either way nobody retries, and the person starts
again although the approval still stands. A raw poller can retry, though: every 2 s until the code
lapses, which is about 300 mint attempts and 300 refusal rows per approved flow.

A throw anywhere else after approval is not caught: in N9's `pollAccountRefused`, in
`activateFromIdentity` or in `attachClaimedLicenses`. It leaves the router as the runtime's bare
500, with no JSON body and no CORS headers.

**What each SDK does with a 5xx on the poll today.** It rides it out at the current interval, and
every SDK has done so since its first device-code build (Node, Python and Swift in P1b-08 on
2026-09-30; Godot in P1-07; Kotlin in P6-07; the React bearer mode and the Electron bridge on
2026-10-05; all before v0.9.0):

| SDK               | 5xx on one poll                                                          | Wait loop                                                  | Unknown `status`                    |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------- |
| Node              | throws `server-error` (`sdk-node/src/identity/client.ts:403`)            | `TRANSIENT` (:216), `continue` (:507)                      | code-less error, terminal (:478)    |
| React, bearer     | throws `server-error` (`sdk-react/src/browser/bearer/session.ts:1490`)   | `continue` (:1578)                                         | code-less, terminal (:1548)         |
| Electron, desktop | `sdk-node/src/electron/main.ts:785` answers `{kind: "pending"}`          | `sdk-react/src/desktop/desktopAdapter.ts` re-polls         | n/a                                 |
| Python            | `CoreContext.request` raises `server-error` (`core/context.py:452`)      | `_TRANSIENT` (`identity/client.py:53`, :359); `aio.py:177` | code-less, terminal (:313)          |
| Swift             | throws `serverError` (`PolarisKeyIdentity/IdentityClient.swift:277`)     | `continue` (:358)                                          | code-less, terminal (:313)          |
| Kotlin            | throws `serverError` (`identity/.../IdentityClient.kt:182`)              | `continue` (:231)                                          | code-less, terminal (:209)          |
| Godot             | `{"status":"transient"}` (`addons/polaris_key/services/identity.gd:337`) | `"pending", "transient": continue` (:413)                  | `invalid-response`, terminal (:375) |

The kits and CLIs all wait through these loops. Those are Node's `cli/flows.ts` and `cli/kit.ts`,
Python's `ui/terminal/flows.py`, Swift's `PolarisSignIn` and `PolarisKeyGateModel`, Kotlin's
`PolarisSignInState`, React's `browserAdapter` and Godot's `begin_sign_in`. client-core has no poll.

## 1. Summary

- **The wire.** A transient server failure after approval answers
  **`503 {"error":"unavailable","message":"try again"}`** with `Retry-After`, and the flow is kept.
  The status set, every 200 body and every other answer stay as they are. `PROTOCOL_VERSION` stays 4.
- **The Worker** retries the completion at most four times, no sooner than 2, 4, 8 and 16 s after
  each failure. The fifth failure answers the bare `error`, and the next poll answers `timeout`.
  A refused mint answers the bare `error` once and drops the flow. It is never put back, and it is
  never a 503.
- **SDKs.** No poll loop changes, because all six already treat a 5xx as transient. The transcript
  runners learn a `transient` result. One new transcript, `devicecode-mint-retry`, pins
  503 → `ready`.
- **Corpus.** None. No signed shape and no ui-matrix state change. `corpusVersion` stays 2 and
  `uiMatrixVersion` stays 5.
- **Builds in the field** improve without an update. Today they stop at the failure; after this
  they get `ready` on the retry.

## 2. Options (D1)

| Option                                  | Builds up to v0.9.13 (bare `error` is `sign-in-denied`)                                                          | I-37c builds             | Verdict                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `503 unavailable`, `Retry-After`** | Ride it out (§0 table), then `ready`                                                                             | Same                     | **Recommended.** True, visible in the Worker's 5xx analytics, carries a delay, and does on purpose what a thrown 500 already does                   |
| B. `200 pending` while put back         | Keep polling                                                                                                     | Same                     | Works, but `pending` means "not approved yet", so the contract would be false. A 200 hides an outage from monitoring and cannot carry `Retry-After` |
| C. `429 slow_down`                      | Lengthen the interval for the rest of the flow and keep polling                                                  | Same                     | Works, but it blames the client. RFC 8628 §3.5 means "you polled too fast", and dashboards count a 429 as abuse                                     |
| D. A new status (`retry`)               | Node, React, Python, Swift, Kotlin: code-less "device sign-in failed."; Godot: `invalid-response`. Both terminal | Must learn it to benefit | **No.** Every shipped build ends the sign-in with a vaguer error than the bare `error`, and the status must be kept forever                         |

A, B and C keep every deployed build polling. Only A states the cause.

## 3. Contract

**`docs/security/WIRE-CONTRACT-V4.md` §12.10.** Add one row and reword one:

| HTTP | Body                                                              | Meaning                                                                          | SDK result                               |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| 503  | `{"error":"unavailable","message":"try again"}`, `Retry-After: n` | Approved, but the sign-in could not finish yet. The flow is kept                 | keep polling (`server-error`, transient) |
| 200  | `{"status":"error"}`                                              | The sign-in failed after approval and will not be retried. The cause is not said | `sign-in-failed`                         |

Add rules 5–8:

5. **The Worker retries a transient failure.**
   - Any failure after approval that is not a refusal answers the 503 and keeps the flow. That
     covers a database, store or vault error in the account check, the activation or the mint.
   - The first poll at or after `Retry-After` attempts the completion again. A poll before then
     gets the same 503 with the seconds left, and nothing is attempted.
   - There are four retries, at 2, 4, 8 and 16 s. The fifth failure answers the bare `error` and
     drops the flow, so the next poll answers `timeout`.
   - If the code lapses first, the poll answers `timeout`.
6. **A refusal is never a 503.** A seat, fingerprint, hardware or licence refusal at the mint
   answers the bare `error` once and drops the flow, then `timeout`. N9 and a refused activation
   already work this way.
7. **A client treats every 5xx on the poll as transient**, with or without a JSON body, the
   runtime's own 500 included. It keeps polling at its interval until the code lapses.
   `Retry-After` is advisory, because the Worker enforces the spacing.
8. The 503 names no cause, and rule 4 still holds.

The closing paragraph gains one sentence: "Every SDK since its first device-code build treats a
5xx on the poll as transient, so a build that predates rule 5 completes on the retry. The Worker
deploys first, and nothing else changes for it."

**`PROTOCOL_VERSION` stays 4.**

- Nothing on this route is signed. `ready` carries an opaque `pkeyt_` token, and the client
  fetches the licence document afterwards on its own route.
- No `typ`, claim, header, status or route is added.
- The 503 is an unsigned answer that every SDK already classifies, so no client needs a version
  number to tell the old behaviour from the new.

Every other §9 counter is unchanged too: `corpusVersion` 2, `DISCOVERY_VERSION` 2,
`uiMatrixVersion` 5 and `CACHE_VERSION` 3.

**`packages/shared-protocol/src/identity.ts`.** Add this beside `DevicePollSlowDown`, and make the
Worker's answer `satisfies` it:

```ts
/** §12.10 rule 5: the same route at HTTP 503, with `Retry-After` (LEGACY FLAT, as its 400/401/429). */
export interface DevicePollUnavailable {
  error: "unavailable";
  message?: string;
}
```

`shared-jws` and `client-core` don't change.

**`packages/worker/openapi/polaris-key.v3.yaml`, `deviceAuthPoll`.**

- Add a `"503"` response: `FlatError`, the `Retry-After` header and the example
  `{error: unavailable, message: try again}`.
- Add rules 5–7 to the description as one paragraph.

No route changes, so rule 10 is satisfied; run `routeCoverage` anyway.

**`conformance/parity/errors.json`.** Descriptions only; no code is added.

- `unavailable` widens: "…; or the device-code poll could not finish an approved sign-in yet (503
  with `Retry-After`): the flow is kept, poll again (I-37d)".
- `server-error` names every SDK's device-code poll: Node, React, Python, Swift, Kotlin and Godot.
- `sign-in-failed` adds "and the Worker will not retry it".

## 4. Worker

**`productOidc/config.ts`.**

```ts
/** I-37d: the Worker's retries of a device-code completion after a transient failure, as the
 *  seconds to wait before each. The failure after the last one ends the flow. */
export const DEVICE_MINT_RETRY_SECONDS = [2, 4, 8, 16] as const;
```

`FlowRecord` gains `mintFailures?: number` and `mintRetryAt?: number`. Only the server writes
them, and they never appear on a page.

**`productOidc/poll.ts`.**

1. **Refusals get their own error.** `authorizeAndMint` throws `new MintRefused(code)`, an exported
   `Error` subclass whose message is the code, for each `AuthzError` arm and for a missing licence.
   `oidc.test.ts:229` still sees `.rejects.toThrow("device_limit")`.
2. **The backoff is checked first.** In `pollAuthFlow`, after `flowApproved` and before N9: while
   `flow.mintRetryAt > now`, answer the 503 with `Retry-After: flow.mintRetryAt − now`. No D1 read
   happens.
3. **One handler covers the post-approval work**, from the N9 check to the mint.
   - N9, a refused activation and `MintRefused` keep the bare `error` and drop the flow. A
     refused mint is not put back.
   - Any other throw is transient. Let `k = (flow.mintFailures ?? 0) + 1`.
   - **Give up** when `k > DEVICE_MINT_RETRY_SECONDS.length`: delete the flow (best effort) and
     answer the bare `error`.
   - **Otherwise retry.** Write `mintFailures: k` and
     `mintRetryAt: now + DEVICE_MINT_RETRY_SECONDS[k − 1]` onto the record, and answer the 503
     with that `Retry-After`. After the redemption, this write is the put-back, which keeps
     `licenseId`. Before it, the write is an `updateArtefact`.
   - **A lost flow.** If that write throws, the flow is gone, so the answer is the bare `error`. A
     503 would promise a retry that can never happen.
4. **The claim sync runs on every attempt.** `attachClaimedLicenses` moves from inside
   `if (!licenseId)` to just before the redemption. It is an idempotent sync
   (`syncAccountLicenseLinks`), so a retry after it threw still joins the licence to the claim
   account. Today a retry skips it.
5. **A retry after a partial commit is safe.**
   - `reconcileDeviceHardware` finds the device already on the licence
     (`isNewAuthorization: false`), so no second seat is taken.
   - `bindDevice` mints a fresh token and deletes the record of the one that was never delivered
     (`core/devices.ts:540`).
6. **`handleAuthDevicePoll` is unchanged.** A 503 has no `status`, so the device record and the
   user-code index stay (l. 354).

**How long a put-back flow lives.** The put-back keeps today's `FLOW_TTL_SECONDS`, but that TTL
never decides anything. Only `/device/poll` reaches the flow, and it reads the device record
first. `updateArtefact` never extends that record's expiry. A put-back flow therefore lives until
the retry succeeds, the fifth failure gives up, or the code lapses 600 s after start, whichever
comes first.

**Tests** (`packages/worker/test/`):

- `oidcEdge.test.ts` › "poll states":
  - a one-shot D1 fault on the seat claim answers 503 with `Retry-After: 2` and keeps
    `licenseId`; the poll after the backoff answers `ready`;
  - a fault after the seat claim retries without a second seat;
  - a poll inside the backoff answers 503 with the seconds left and runs no D1 statement;
  - the fifth failure answers the bare `error`, then `timeout`;
  - `device_limit`, `fingerprint_required` and a deleted licence answer the bare `error` once,
    write one `refusals` row, then `timeout`;
  - a put-back that throws answers the bare `error`;
  - a throw in the activation or in N9's read answers 503 and is counted;
  - an account disabled during the backoff gets the bare `error` at the next attempt;
  - the 503 carries the poll's CORS headers for a `web.origins` origin.
- `attack/R8-oidc.test.ts`:
  - a poller drives at most five completion attempts per approved flow;
  - a refused mint is attempted once (before: until the code lapsed).

**Unchanged:**

- routes and the descriptor `surface`;
- migrations and `TABLE_OWNERS`;
- `Env`;
- the rate limits and `CORS_EXPOSE_HEADERS`. No SDK reads `Retry-After` here (D5).
- the audit verbs. A refusal is already logged once, and an infrastructure failure is not an
  account event: it shows in the Worker's 5xx analytics.

## 5. Security: can a poller drive repeated mint attempts?

**Who can poll.** Only the holder of the secret device code, polling with the flow's own
`deviceId`. Any other device gets a 401. A mint is reachable only after a person approved in the
browser that signed in (I-37). The limits are unchanged:

- one poll per 2 s slot (compare-and-set);
- 40 a minute per code;
- 120 a minute per network.

**Today.** Any failed mint goes back, so each poll re-runs the mint until the code lapses. That is
about 300 attempts per approved flow, each about ten D1 statements. A refused attempt also writes a
`refusals` row, which feeds the console's Status line and its attention model.

**After.**

- A refusal is attempted once.
- A transient failure is attempted at most five times, over at least 30 s.
- Polls inside the backoff touch only the single-use store. During a D1 outage the poll adds no D1
  load between attempts, and it stops after the fifth failure.
- The counter and the deadline live server-side on the flow record. Nothing in the request sets,
  resets or skips them. A fresh budget needs a new code and a new approval.

**What the 503 discloses.** Only that the server failed. It is never a policy outcome (rule 6), so
D8 and rule 4 hold: the bare `error` never says which refusal applied. Under R1-07, where the
starter is the attacker, the retry yields exactly what an untroubled poll would have yielded after
the victim's approval. That is nothing new.

**Residuals, not changed here:**

- A store outage at the redemption still reads as "absent" and answers `timeout`, under the
  single-use store's fail-closed policy.
- A second poller of the same code, during a slow mint, sees the flow redeemed and gets `timeout`
  (G15). One SDK never races itself.

**`docs/security/THREAT-MODEL.md`.**

- The G15 bullet "(a failed mint puts it back)" becomes "(a transiently failed mint puts it back,
  at most four times and only after its backoff; a refused one does not)".
- Control 5 of "The device-code user-code page (P1-06)" gains one paragraph with the bounds above.

## 6. Catalog, corpus and transcripts

- **Catalog and manifests:** none, and no rule-9 entry.
- **Corpus:** none. Nothing signed changes, and during a transient the kits stay on `waiting`. So
  `ui-matrix.json` gains no state, and no version constant moves.
- **Transcripts.** Add `devicecodeMintRetry` to
  `packages/worker/test/transcripts/scenarios/identity.ts` and to `scenarios/index.ts`. Then
  `pnpm gen transcripts` writes `conformance/transcripts/devicecode-mint-retry.json` and its Godot
  mirror. The steps:
  1. `beginSignIn`.
  2. `pollSignIn` at T0+2: `pending`.
  3. The player confirms, signs in and approves (unrecorded). A one-shot `world.db` proxy, the same
     technique `discovery-failure` uses, rejects the first D1 `batch` that writes `devices`.
  4. `pollSignIn` at T0+5: `503` with `retry-after: 2`. The expectation is
     `{result: "transient", code: "server-error", tokenHeld: false}`.
  5. `pollSignIn` at T0+8: `ready` with `identity`. The expectation is
     `{result: "ready", tokenHeld: true}`.
- **`packages/worker/test/transcripts/format.ts`.** `pollSignIn` gains the result `"transient"`:
  no answer, or a 5xx, with `code` set to `network-error` or `server-error`. `waitForSignIn` never
  reports it. Format version 1 stays, because every runner changes in the same PR.
- **Byte-identical:** `devicecode-happy`, `-default`, `-expired`, `-label`, `-denied`, `-failed`
  and `locker-devicecode`. `-failed` takes the activation-refusal branch, which does not change.

## 7. SDKs, in order

No SDK changes its poll loop or its public API. Each one must replay `devicecode-mint-retry`. There
are no typed N/As: all six implement `identity.devicecode`, and client-core has no poll.

| SDK    | Runner change: `pollSignIn` maps a thrown `server-error` or `network-error` to `result: "transient"` plus `code`    | Also                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Node   | `conformance/runners/node/transcripts.test.ts` (`act`)                                                              | none                                                                                                                 |
| React  | `packages/sdk-react/test/transcripts.test.ts`                                                                       | New unit case: bearer `waitForSignIn` rides out a 503 and ends `ready`. None exists today                            |
| Python | `sdks/python/tests/test_transcripts.py`                                                                             | D7: `aio.py:194` drops `code` from `SignInResult`. Pass `code=poll.code` and test it in `tests/test_async_client.py` |
| Swift  | `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift` (`do`/`catch` around `pollSignIn`)                         | none                                                                                                                 |
| Kotlin | `sdks/kotlin/conformance/.../TranscriptTest.kt` (`try` around `pollSignIn`; add the id to `REQUIRED`)               | none                                                                                                                 |
| Godot  | `sdks/godot/tests/suite_transcripts.gd` (`transient` already passes `_sign_in_status`; set `code` from `p["code"]`) | none                                                                                                                 |

Existing unit cases already pin the ride-out:

- Node: `test/identity.test.ts:357`;
- Python: `tests/test_identity_mint.py:282`;
- Swift: `IdentityMintTests.swift:333`;
- Kotlin: `IdentityClientTest.kt:79`;
- Godot: `tests/identity/test_flow.gd` `_transient`.

Only Python's `CHANGELOG.md` gets a line, for D7. The docs changelog carries the Worker change.

## 8. Rollout

1. **When.** Merge after I-37c. The v0.9.15 tag doesn't matter here, because no SDK API changes.
2. **The Worker deploys first**, from `main`. A flow the old Worker put back carries no
   `mintFailures`, so its next poll retries with a full budget.
3. **Builds up to v0.9.13.**
   - On a transient failure they get the 503, keep polling and get `ready`.
   - When the budget runs out, or on a refusal, they still say "Sign-in declined", as today.
   - Dropping a refused flow changes nothing for them, because they stop at the first `error`
     anyway.
4. **I-37c builds** behave the same, but say `sign-in-failed` when the budget runs out and on a
   refusal.
5. **A host that paces itself** with `pollSignIn()` and treats a thrown `server-error` as fatal
   ends where it ends today. The docs already tell it to retry.
6. **A new SDK on an old Worker** (only after a rollback) gets the bare `error`, as today.
7. **Rollback** restores put-back-and-`error`. Nothing is migrated, and the old Worker ignores the
   two new record members.

## 9. Decisions for the lead

| #   | Question                                                 | Options                                                                                                                            | Recommendation                                                                                                                      |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Shape                                                    | A. 503. B. `pending`. C. `slow_down`. D. A new status                                                                              | **A** (§2)                                                                                                                          |
| D2  | What the Worker retries                                  | a. A thrown mint only. b. Any thrown failure after approval (N9's read, the activation, the claim sync, the mint), never a refusal | **b.** Today the other throws become the runtime's bare 500 without CORS. One handler gives them a budget and a JSON body           |
| D3  | The budget                                               | a. Four retries at 2/4/8/16 s (at least 30 s). b. Until the code lapses. c. Two retries                                            | **a.** It covers a D1 blip. With b, one outage can drive about 300 attempts per flow                                                |
| D4  | A refused mint                                           | a. Terminal at once, flow dropped. b. Put back, as today                                                                           | **a.** A retry can't succeed, and today each poll writes another refusal row                                                        |
| D5  | SDK pacing                                               | a. Unchanged: a 5xx is retried at the current interval. b. Honour `Retry-After` in six SDKs                                        | **a.** The Worker enforces the spacing. React can't read the header (it isn't CORS-exposed), and an early poll costs one store read |
| D6  | Wire code                                                | `unavailable` (already exists; flat; device start's 503) or a new code                                                             | **`unavailable`.** An SDK reports the class, `server-error`, either way                                                             |
| D7  | Python `aio` drops `code` (a DENY-01 residue found here) | a. Fix it in I-37c's open review round. b. Carry it in I-37d                                                                       | **a** while I-37c is in review, else **b**                                                                                          |

**Not proposed:** a "Finishing sign-in…" state in the kits. A retry lasts at most about 30 s behind
the waiting screen. A new state would bump `uiMatrixVersion` and touch every kit.

## 10. Order, drift gates and acceptance

One PR, with one commit per step, in rule 2's order:

1. **Contract.** §12.10, `DevicePollUnavailable`, the OpenAPI changes and `errors.json`. Then run
   `pnpm gen constants` and `pnpm gen docs-reference`, which regenerates
   `reference/error-codes.mdx`.
2. **Worker.** `config.ts`, `poll.ts` and the tests. Every SDK suite stays green, because no
   existing transcript changes.
3. **Catalog and corpus:** none.
4. **Transcripts.** The scenario, `format.ts`, then `pnpm gen transcripts`. From this step the six
   runners fail on the new file until step 5.
5. **SDK runners**, with the React unit case and D7: Node, React, Python, Swift, Kotlin, Godot.
6. **Docs.**
   - `packages/docs/src/content/docs/features/sign-in/device-flow.md`: the 503 row, rules 5–7, and
     the budget under "Lifetime and limits".
   - The THREAT-MODEL edits from §5.
   - `reference/changelog/index.md`.

```sh
mise exec node@22 -- pnpm build && mise exec node@22 -- pnpm typecheck
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- oidcEdge R8-oidc oidc deviceApproval hostedSigninPages oidcLicenseChoice routeCoverage
mise exec node@22 -- pnpm --filter @polaris-key/worker typecheck:workerd && mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm gen --check            # transcripts (+ Godot mirror), constants, docs-reference, parity; corpus unchanged
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node --filter @polaris-key/react test
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_transcripts.py tests/test_async_client.py tests/test_identity_mint.py )
( cd sdks/swift && swift test --filter 'TranscriptTests|IdentityMintTests' )
( cd sdks/kotlin && ./gradlew -Ppkey.jvmOnly=true :identity:test :conformance:test )
sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm --filter @polaris-key/docs lint:docs && mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
mise exec node@22 -- pnpm format
```

The reviewer checks three things in the diff:

- every existing transcript is byte-identical;
- no `MintRefused` path answers 503;
- no SDK source changes outside the runners, the React test and D7.

## 11. Briefs this plan changes (applied by the lead on approval)

- **New `I-37d`:** the row above, with the brief `wp/I-37d-device-mint-retry.md`.
- **`wp/I-37c-device-poll-denied.md`:** "Out: a failed mint as a 5xx (its own package)" points to
  I-37d. Under D7a, the `aio.py` fix joins its review round.
- **`plans/DENY-01.md` §9 "Out of scope":** gains "→ `plans/MINT-01.md` (I-37d)".

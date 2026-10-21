---
title: "Add a corpus case"
description: "Pin an observed divergence in the corpus, regenerate without hand-editing, and record the HTTP transcripts beside it."
sidebar:
  order: 5.5
  label: "Add a corpus case"
type: "reference"
lastReviewed: "2026-10-16"
---

## Adding a case

Each case family is an array returned by its own `async function` in its family module under
`tools/corpus/` — `buildJwsCases` (`jws.ts`), `buildLicenseDocCases` and `buildConfigDocCases`
(`claims.ts`), `buildTrustCasesV2` (`trust.ts`), `buildClockFloorCasesV2` (`clock.ts`),
`buildBundleCases` (`bundle.ts`), `buildFeedCases` (`feed.ts`), `buildReleaseRecordCases`
(`record.ts`) and the rest — assembled by `buildV2()` (`cases.ts`) into the object
`gen corpus` writes as `cases.json`. To add a case:

1. Add a case object to the relevant array, with a unique `id` and a `description` explaining
   what it proves and why (the existing cases are the style guide — read a few nearby first).
2. Run `pnpm gen corpus` to sign it and update every output file, source and mirror alike.
3. Run `pnpm gen corpus --check` before committing, to confirm nothing else drifted.

The gate matrix is different: it is hand-authored, and its carried rows — the fifteen inlined
from corpus v1 when v1 was deleted — are **frozen**. Nothing may be edited there to make a gate
change pass. A genuinely new decision is a new row appended in `buildGateMatrixV2`, so the diff
shows exactly what changed rather than rewriting history that was already pinned. A carried row
can be retired only by an approved plan, through `RETIRED_CARRIED_ROWS`, which names the plan,
the reason and a successor row; the frozen array itself is never edited, and the generator
refuses to run if a retired name is not a carried row or its successor is not emitted.

`entitlementRows` is a second family in the same file, beside
`rows`, so `gateMatrixVersion` stays 2 and a runner that iterates `rows` is unaffected. Each row
is `{name, gate, license, entitlement, expect: {status, isEntitled}}`: the same `gate` and
`license` inputs as `rows`, plus `entitlement: {key, entry}`, the entry the cached license
document carries at `entitlements[key]` (`null` when it carries none, always `null` without a
document). `isEntitled` is `isUsable(status) && entry.value === true`, so a revoked, expired or
unactivated license entitles nothing even while its cached document still says `true` (S-19
G11). The documents are today's license shape (S-19 `legacy` mode). The generator evaluates every
row through `@polaris-key/client-core`'s `licenseState` and `isUsable` and refuses to write one
that disagrees.

`feed-url-matrix.json` is hand-authored the same way. Its templates are not: `endpointSets.everything`
is read from the Worker's byte-checked discovery golden
(`packages/worker/test/fixtures/discovery-golden.json`), so a Worker change to a template goes
stale under `--check`. Each row names an endpoint set and `{kind, channel?, velopackChannel?,
buildId?}`. The expansion is the one sdk-node's `appcastUrlFrom` and Godot's updater already
ship: an absent channel is `stable`, an alias goes through `CHANNEL_ALIASES` (`staging` → `beta`,
`latest` → `stable`), every placeholder is replaced by the value encoded as
`encodeURIComponent`, `appcast` puts a non-stable channel in the path before `/appcast.xml`, and
`velopack` without a `velopackChannel` is the feed directory Velopack's UpdateManager opens. The
generator recomputes every row with its own reference expansion.

The stage matrix is hand-authored too, and **append-only** in the same way. `buildStageMatrix`
writes literal rows (each an ordered list of host events with the exact emits each produces),
an `accepts` table and one probe per event type, and self-checks them before writing: the stage
lists, the vocabulary, the `accepts` table and every cell of the sync and gate tables. Every
runner replays every row and sends every probe at every state the rows reach. Rows that use
only the current vocabulary keep `stageMatrixVersion`; a change to the vocabulary, to `accepts`
or to an existing row's expectation bumps it, and the package that does so updates every port
in the same change.

`headers.json` and `config-matrix.json` are hand-authored and **append-only** too.
`buildHeadersCorpus` writes one row per spelling; its self-check ties every canonical value to
`conformance/parity/enums.json` and requires an identity row for each, so a new vocabulary value
needs a corpus case, and every runner asserts that its generated table equals the rows. A new
spelling (a row plus a table entry) keeps `headersVersion`; a changed row bumps it. `buildConfigMatrix` checks every
expectation against a generator-local reference of §2.2.1 that imports nothing from the SDKs,
and fails on a missing or redundant `expectNoEnv`, an unsorted list, an unused source or JSON
type, a number some SDK would read differently, or a rule whose edges are not pinned. A new row
keeps `configMatrixVersion`; a changed row or rule bumps it.

`sync-scenarios.json` is **literal data** and **append-only**:
`tools/sync-scenarios.ts` writes every scenario and its expectations by hand and imports nothing
from `client-core`, so the reference state machine `@polaris-key/client-core/cloud-sync` is
checked against it like any other SDK, by `conformance/runners/node/syncScenarios.test.ts` (the
template every SDK's runner copies). Its self-check fixes the step, call and assert vocabulary,
requires every listed rule to have a scenario, checks HLC and `clientId` syntax, and refuses a
fresh `mutationId` at or below one the same client already sent. A new scenario keeps
`syncScenariosVersion`; a vocabulary or expectation change bumps it.

Version **2** was such a change: the calls became the shipped `set` and
`clear`, every pull body carries `quota` and `usage` in place of `limits`, the scenario catalog's
settings are routes (`syncedSettings`), `states` pins `sync` in place of `pending`, and
`locked-key-refused` lost its unknown-key step (an undeclared key is an open setting). It appends
the `legacyLocal` init member (the `config.local` contents handed to `importLocal`), the rules and
scenarios for open settings, setting routes, the import, record field policies, 403 reasons, paused
writes and parked rejections, and a last section, `settingCases`: catalog entries in,
`syncedSettings` routes out.

`presentation-matrix.json` is hand-authored, ASCII
only and **append-only**: a new row keeps `presentationMatrixVersion`; a changed row or rule bumps
it. `tools/presentation-matrix.ts` writes the rows and checks every expectation against its own
reference implementations (`refParse`, `refPick`, `refMatches` over `node:crypto`), written from
WIRE-CONTRACT-V4 §5.5 and importing nothing they check: not `client-core`, not
`@polaris-key/protocol`. It restates the limits locally, and `tools/presentation-matrix.test.ts`
asserts they equal `@polaris-key/protocol/core`'s generated constants. `client-core/presentation`
is checked against the file like any other SDK, by its own test
(`packages/client-core/test/presentation.test.ts`), because a golden file that shares code with
the implementation it checks cannot catch a bug in it.

`ui-matrix.json` is generated from rows authored in
`tools/ui-matrix.ts`, ASCII only and **append-only** within `uiMatrixVersion` 3: a new row keeps
the version; a changed row, input member or rule bumps it, and each runner checks the generated
`UI_MATRIX_VERSION`. There is no reference state machine: the generator checks structure (every
must state has a row and the rows' copy covers its `components.json` list, every component has a
presentation-absent row and a row per service it depends on, the sign-in form ends one way,
inline rows get sheet twins), and the five runners are the
independent implementations. Its i18n strings are computed from the kit copy by a formatter that
imports nothing it checks. A feature package adds its `components.json` state, its catalog keys
and its rows in one PR and holds the corpus lane while it regenerates. **A copy-only edit** (a
reworded or translated key) changes the file only through the computed i18n strings: run
`pnpm gen corpus` and commit the result, without the lane.

A variant the matrix cannot pin yet is declared, never left out silently: `GAPS` in
`tools/ui-matrix.ts` (written to `vocabulary.gaps`) names it, says why and names the work package
that appends its rows, and the build fails on an entry without an owner. It is empty today.
Version 2 closed the one it held, DL7's delayed response: the `elapsedMs` input and
`vocabulary.loadingDelay` (`min` 250, `max` 300, and the loading states it applies to) pin a
loading state that shows nothing before the delay and its usual copy after it, with no row inside
the window, so each kit's model timer may wait anywhere in it.

Version 3 adds the `cli` family, the terminal drop-in contract. It has no component, so it
is one object with typed sections rather than component rows: `verbs` (the end-user set a mount
offers by default, the developer verbs it offers only by name, the aliases), `mount` and `help`
(what registering into a host CLI mounts, refuses with `polaris-verb-collision`, skips, hides and
lists under the `cli.help.group` heading), `gate` (every `licenseStatus` × TTY × `--json` ×
entitlement: run, the inline flow, or a refusal drawn as ▲ with its fix that exits 4), `outcomes`
(a kit verb in a named situation: its mark, exit, result fields, stdout and fix verbs), `stdin`
(what `activate` with no key reads, per kind of stdin), `capabilities` (the terminal capability
table) and `exit` (the exit table). `vocabulary.cli` holds the rules. The mount, help, gate and
capability expectations are computed by references in `tools/ui-matrix.ts` that import nothing they
check, and `checkCli` refuses a refusal drawn as ✗, a refused gate that does not exit 4 and a
missing gate cell. The two terminal kits run `exit`, `capabilities`, `stdin` and `outcomes`
(`packages/sdk-node/test/cli/cliContract.test.ts`, `sdks/python/tests/cli/test_cli_contract.py`, the
second with strict xfails for the rows its kit does not pass yet, each with its owner); the framework
adapters run `mount`, `help` and `gate`.

`backend-matrix.json` is generated from rows authored in
`tools/corpus/backend.ts`, ASCII only and **append-only** within `backendMatrixVersion` 1. Every
row's expectation is written by hand and recomputed by `tools/corpus/reference/backend.ts`, which
imports nothing it checks (it reuses the reference JWS verifier and claim checks), so a row that
contradicts WIRE-CONTRACT-V4 §14 fails `pnpm gen corpus`. The problem rows' titles and details
are the copy catalog's (`conformance/parity/copy.<locale>.json`): a copy edit to a backend code
changes the file, so run `pnpm gen corpus` with it. `client-core/backend` is checked against the
file by the Node and browser runners and by its own test, like any SDK.

`update-matrix.json` and `outlet-matrix.json` (wire contract v4) are hand-authored from the
plan's row lists and **append-only** as well. The generator carries
its own reference `compareVersions`, `effectiveCapabilities`, `resolveUpdateOutlet`,
`decideUpdate`, `bootDecision` and `detectOutlet`, written from the plan and importing nothing
from the SDKs, recomputes every version case, capability case, outlet case, bucket vector,
decision row and detection row, and fails when a result differs from the row's expectation. It
also runs its own claim checks for all six `typ`s, so every per-claim integer case is proved to
break its claim alone. A corpus change that edits a row is plan-mode: amend the plan first.

The content sections append without moving any version:

- `cases.json` gains three `feedCases` (`feed-valid-content-members-populated`,
  `feed-valid-content-members-per-platform`, `feed-valid-content-at-cap`, a payload of exactly
  65,536 bytes), so every existing runner proves a populated feed still verifies; a new
  `feedContentCases` section (about 32 cases) after `feedCases`, each a signed, valid feed built
  from one base by one mutation, with `expect.content` (each of `packSets`, `packFloors` and
  `revocations` parsed, or `null`); and a new `revocationCases` section (about 18 cases) after
  `releaseRecordCases`, each with an `entry` (the feed entry) and `mode`
  (`revocation` or `replacement`), expecting the parsed revocation or a failing step (`hash`,
  `jws`, `claims`, `cross-check`, `revocation`). The superseding cases also name the case they
  supersede and are checked with `newerRevocation`.
- `update-matrix.json` gains `packs` in `vocabulary.actions`, `content-floor` and
  `revoked-content` in `vocabulary.blockedReasons`, and 44 `contentRows` after `rows`: the same
  shape plus `input.content`, and on a `packs` answer an `expect.packSetId` the runner recomputes
  as `packSetId(decision.set)`. The self-check that no row answers `required` stays for `rows`;
  `contentRows` must answer `required` exactly on the revoked-content rows.
- `content/cases.json` gains four `stampCases` with `expect.holds`. `parseContentStamp`'s result
  is unchanged; a runner that implements holds runs `holdsOf` on the parsed stamp and compares it
  **only when `expect.holds` is present**, so the section stays append-only.

A runner that does not yet implement a new section ignores it; the count assertions move
(`feedCases` 77 → 80, `stampCases` 6 → 10) in every runner in the same change.

The delegation and key sections each append as the **last** member of its file, so each
file's diff is a pure append and every earlier section stays byte
for byte; no version moves and no runner count assertion changes:

- `cases.json` gains `delegationCases` (46), after `markerCases`. Each case has `id`,
  `description`, `mode` and `jws`, then per mode:
  - `record`: `delegation` (the delegation's compact JWS the caller supplies), `releaseKeys`,
    `productTrust`, `expectedAud`, `expectedHash`, `pin` (or `null`) and, on the two
    `recordRevoked` cases, `revoked` (target hashes); `expect` is `{verify: "ok", kind,
delegation: {sha256, deliverable, types, issuedAt, expiresAt} | null, revoked?}` or
    `{verify: "fail", step}` with `step` one of `hash`, `jws`, `claims`, `cross-check`,
    `delegation`, `scope`. A runner calls `verifyReleaseRecord` with `delegation`, then
    `recordRevoked` when `revoked` is present;
  - `release-only`: the same keys with `delegation: null`; verified with no delegation passed;
  - `revocation`: `delegation: null`, `releaseKeys`, `productTrust`, `expectedAud` and `entry`
    (the feed entry, with `kind: "delegation"` on a delegation target); `expect` as in
    `revocationCases`, checked with `verifyRevocation`;
  - `feed`: `trust`, `expectedAud`, `channel`, `platform`, `now`, `checkFreshness`; a signed, valid
    feed whose `expect.content` is `feedContent`'s answer (the entry `kind` kept, dropped or
    making `revocations` unusable).

  The content key is a deterministic test key derived from a fixed seed in the generator; its
  public half appears only inside the cases' delegations, so the top-level `keys` are unchanged.
  The generator's own reference `delegationOf`, delegated steps 12–16 and `recordRevoked` refuse
  each failing case at exactly its step.

- `content/cases.json` gains `dataOnlyCases` (76), after `frameWindowCases`:
  `{id, description, path, head, tail, tailFill?, content?, expect}`. `head`, `tail` and
  `content` are standard base64. The file is `head ‖ tail`, where a `tailFill` (`{byte, length}`)
  stands in for a long tail of `length` copies of `byte`; or, when `content` is present (Amendment
  A1), the file is `content` and `head` and `tail` are empty. A runner passes `dataOnlyRefusal`
  the path, the file's first 64 bytes, its last 65,557 bytes and the whole file, and expects
  `{ok: true}` or `{ok: false, rule}` with `rule` `extension` or `content`. The cases cover each
  allowed extension, the refused loader extensions, every refused head, the head window's cut
  (whitespace to its end, a word head it cuts), the tail sniff and its bound, an empty file, nine
  paths that are not already normalised, and the text rule (script markers, backslash-split
  markers, ASCII or malformed `\u`/`\U` escapes, invalid UTF-8; non-ASCII escapes and a marker in a `.png` pass).

The feed's delta menu appends three sets; no version moves:

- `cases.json` gains 28 `feedContentCases` (48 → 76), each the base feed plus one `deltas`
  mutation. `expect.content` keeps the three base members, so every older runner passes them
  unchanged, and the menu goes in a sibling `expect.deltas`. A runner that reads the menu compares
  `content.deltas` with `expect.deltas ?? null` on every case, so the 48 older cases pin `null`.
- `plan-matrix.json` gains `feedDeltaCases` (13), after `targetCases`:
  `{id, description, variant, recordSha256, filesIndex, chunkIndex, deltas, installed, caps,
expect: {feedIds, target, plan}}`. A runner computes `withFeedDeltas(variant, deltas)`, then
  `planTarget` over the merged variant and `plan`, and compares by canonical JSON.
- `content/cases.json` gains `feedDeltaApplyCases` (4), after `dataOnlyCases`: the payload-delta
  shape plus `deltas`, over the committed v1 → v2 frame. A runner merges, then runs `applyDelta`
  on the merged variant's delta whose id is `feedIds[0]`.

The only edit outside the new sections is the `feedContentCases` count, 48 → 76, in every runner.

The signed-in subject, `profile.user` (WIRE-CONTRACT-V4 §2.1, §3.2), appends two sets; no version moves:

- `licenseDocCases` gains three accepted cases (25 → 28): `license-profile-user-valid`,
  `license-profile-user-not-object` and `license-profile-user-extra-members`. They prove a
  verifier that predates the member accepts it in every shape.
- `cases.json` gains `licenseUserCases` (14), its last section. Each case is a license document
  that verifies, with the `licenseDocCases` keys and `expect: {accept: true, user}`, where `user`
  is `{subject}` or `null`. A runner verifies the document, then compares `licenseUserOf` on its
  payload with `expect.user`. The generator's reference reader recomputes every row, and the
  self-check proves each row differs from `user-valid` only under `/profile/user` (the
  no-profile row, under `/profile`).

## HTTP transcripts

Registration, activation and sync are conversations, not pure functions, so the corpus cannot
pin them. `conformance/transcripts/*.json` does instead: each file is one conversation — the
requests a client must send and the Worker's real answers — recorded through the production
router by the Worker's own scenario tests and replayed by every SDK against a fake server that
serves the recorded responses and asserts each request.

| Piece                  | Where                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Format (documented)    | `packages/worker/test/transcripts/format.ts`                                                       |
| Recorder and scenarios | `packages/worker/test/transcripts/` (`recorder.ts`, `determinism.ts`, `scenarios/`)                |
| Drift check            | `packages/worker/test/transcripts.test.ts`, wrapped by `pnpm gen transcripts`                      |
| Godot mirror           | `sdks/godot/tests/transcripts/` (generator-owned; an exported pack reads only `res://`)            |
| Node replayer          | `conformance/runners/node/transcripts.test.ts` over `transcriptReplay.ts`                          |
| React replayer         | `packages/sdk-react/test/transcripts.test.ts` (the same engine; discovery, update and chunk range) |
| Python replayer        | `sdks/python/tests/test_transcripts.py` over `transcript_replay.py`                                |
| Swift replayer         | `sdks/swift/Tests/PolarisKeyTests/TranscriptTests.swift` over `TranscriptReplay.swift` (in place)  |
| Godot replayer         | `sdks/godot/tests/suite_transcripts.gd` over `support/transcript_replay.gd`                        |
| Kotlin replayer        | `sdks/kotlin/conformance/…/TranscriptTest.kt` over `TranscriptReplay.kt` (in place)                |

**Recording.** A scenario seeds a product, builds each request exactly as a wire-contract client
would, sends it through `dispatchWith` (the router with the request clock injected), asserts
the server's behavior as an ordinary test, and declares what a replaying SDK is held to. Values
from the client's own state are recorded as placeholders (`{deviceId}`, `{version}`,
`{token}`, `{key}`); values the server chose, such as an ETag, are recorded literally. The
seven `X-PKey-*` headers are asserted by presence only. Recording is deterministic: `Date` is
frozen, `crypto.getRandomValues` and `crypto.randomUUID` draw from a stream seeded by the
scenario id, and the Worker signs with the corpus test key, so every recorded document verifies
against the corpus pins. Each scenario is recorded twice per run and the two must match.

**Replaying.** An SDK replays a transcript when its `parity.json` marks every id in the
transcript's `features` `implemented` and none in its `requires` `na`, so a transcript for a
feature an SDK has not built yet is skipped rather than failing, and runs the moment the
manifest claims the feature. A replayer fails on an unexpected request, on an expected request
the SDK never sent, on a header or body that does not match, and on a client outcome that
differs from the step's `expect`. Each replayer also runs doctored transcripts to prove those
failures fire. `pnpm parity:check` holds the other end: where a transcript applies to an SDK,
each feature it proves needs a test tagged `@pkey-feature <id>` that replays
`conformance/transcripts`.

```sh
pnpm gen transcripts            # re-record every scenario, write the files and the Godot mirror
pnpm gen transcripts --check # the drift guard — exit 1 if anything is stale
```

Never hand-edit a transcript: change the scenario and re-record. A Worker change that alters a
recorded response regenerates the transcripts in the same change; if an SDK replayer then
fails, that SDK has to follow. To add a conversation, add a scenario under
`packages/worker/test/transcripts/scenarios/`, list it in `scenarios/index.ts`, run
`pnpm gen transcripts`, and map any new action in each SDK's replayer.

A replayer decides whether a transcript applies **before** it maps any step's action. A transcript
whose features an SDK has not implemented can therefore use an action that SDK's replayer does
not know yet, and it is skipped, never failed.

### The newest conversations

Five more transcripts sit beside the existing ones (none was re-recorded). Each one
is inert in every SDK until that SDK's task marks its feature `implemented` and maps the new
action in its replayer:

| Transcript                         | Proves                 | Steps                                                                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activate-refusals.json`           | `license.refusals`     | `enroll` refused `403 enroll_claimed`, then `403 license_disabled`; `activate` with an expired license's key (`401 unauthorized` today), on drifted hardware (`409 hardware_mismatch`) and with the client's budget spent (`429 rate_limited`, no `Retry-After`) |
| `boot-cold-register.json`          | `ui.boot`              | One `boot` on a fresh install of an open-registration product: discovery, keyless registration, trust, the config document and the report, ending at the stage machine's `ready` with the gate `not-applicable`                                                  |
| `release-fetch-gated.json`         | `release.fetch`        | `discover`, then `releaseFetch` under licensed delivery: the whole payload (200), a resumed one with `Range` and `If-Range` (206), and, once the license is disabled, `401 download_auth_required`                                                               |
| `distribution-download-model.json` | `release.distribution` | `downloadModel`: the public `GET /<p>/distribution/download.json`, its platform groups and the group for `initial.platform`                                                                                                                                      |
| `telemetry-report-updates.json`    | `telemetry.updates`    | Two `report` calls over a seventeen-event `initial.updateJournal`: sixteen events (the per-report cap), then the last one                                                                                                                                        |

The three new actions are documented in `format.ts`:

- `boot` is the SDK's one-call boot, with every request its stages make and `expect.bootOutcome`,
  the stage machine's terminal outcome (`stage-matrix.json`'s `vocabulary.outcomes`).
- `releaseFetch` takes a release record's build entry (`version`, `platform`, `arch`, `build`,
  `size`, `sha256`) and an optional `partial`, the byte count of a partial download the replayer
  seeds. It expands discovery's `distribution.endpoints.builds` template and reports the
  verified `size` and `sha256`.
- `downloadModel` is `distribution.downloadModel()`, with `expect.platforms` and `expect.current`.

Two refusals in SDK-PARITY-PASS §3.1 are not recorded, because no route answers them today:
`license_expired` (activation refuses every unusable license as `unauthorized`) and
`attestation_required` (activation and enrolment are not trust operations).

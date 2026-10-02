# P4-13 Revocation records, pack floors in the feed, and `update-matrix.json` rows for content

| Field       | Value                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs (v2)                                                                                                                                                                                                                                           |
| Size        | 2.5–3 engineer-weeks                                                                                                                                                                                                                                     |
| Depends on  | [P4-12](P4-12-compat-resolution.md), [P3-04](P3-04-v4-node.md), [P3-05](P3-05-v4-react.md), [P3-06](P3-06-v4-python.md), [P3-07](P3-07-v4-swift.md), [P3-08](P3-08-v4-godot.md)                                                                          |
| Unblocks    | [P4-14](P4-14-readiness-gc-rollouts.md), [P4-15](P4-15-console-compat-matrix.md), [P4-19](P4-19-content-key-delegation.md), [P4-23](P4-23-content-decision-python-swift.md), [P4-24](P4-24-content-decision-godot.md)                                    |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                    |
| Plan mode   | yes: `program/plans/P4-13.md` is written and approved before any code                                                                                                                                                                                    |
| Gates       | plan mode; corpus (`cases.json` feed and release-record cases, `update-matrix.json`, Swift and Godot mirrors, generated `corpus.mdx`); all SDKs; `PROTOCOL_VERSION` only if the plan says the fields were not reserved in v4; rule 10 if a route changes |
| Human input | approval of the plan (merging the plan PR); nothing else                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                |

## Goal

The channel feed (`pkey-feed+jws`) carries the resolved pack sets keyed by `contentApi` with their
`packSetId`s, the pack floors per level, the revocations in force and the per-outlet binding
narrowing. CI can sign `kind: revocation` release records, the Worker ingests them, and
resolution skips revoked releases. `update-matrix.json` gains the content rows, and the update
decision in every SDK (`client-core` for Node and React, Python, Swift, Godot) passes them.

## Why

Without these fields a device cannot receive a `compatible` pack, cannot be blocked on a content
floor, and cannot stop using dangerous content it already holds
([CONTENT §6.7](../../CONTENT.md#67-lifecycle-implications) items 1, 3, 6 and 10;
[§6.9](../../CONTENT.md#69-record-and-table-changes)). Revocation must be CI-signed so the Worker
can withhold content but never condemn or substitute it
([README §3.3](../../README.md#33-trust-model-two-signers-two-documents); decision 18). The
decision is conformance-tested like the licence gate, so these rows are what keep six SDKs in step
([README §3.6](../../README.md#36-update-what-an-installed-app-should-do-next)).

## Read first

- `AGENTS.md` (rules 1–3), `CLAUDE.md` (plan mode), `program/plans/README.md`,
  `.claude/agents/pkey-wire-planner.md`.
- The approved plans `program/plans/P3-01.md` and `program/plans/P4-01.md`, and the v4 contract
  P3-02 wrote (`docs/security/WIRE-CONTRACT-V4.md` or the successor it named): what the feed and
  the record already reserve, the feed payload cap, and the `update-matrix.json` row shape.
- [CONTENT §6.3](../../CONTENT.md#63-resolution-what-the-server-computes),
  [§6.6](../../CONTENT.md#66-transport-imposed-binding-per-outlet),
  [§6.7](../../CONTENT.md#67-lifecycle-implications), [§6.8](../../CONTENT.md#68-diceroll-worked-through),
  [§6.9](../../CONTENT.md#69-record-and-table-changes) and [§9](../../CONTENT.md#9-formats) (feed
  pack part); [README §3.3](../../README.md#33-trust-model-two-signers-two-documents),
  [§3.6](../../README.md#36-update-what-an-installed-app-should-do-next) and
  [§3.7](../../README.md#37-content-packs-across-release-distribution-and-update).
- [notes/A4](../../notes/A4-diceroll-mapping.md) §5 (Diceroll's decision invariants, including
  "the binary supersedes content").
- The P4-12 hook functions and `set_json` shape; P3-03's feed composer in
  `packages/worker/src/services/update/`; `tools/sign-corpus.ts`; `docs/security/THREAT-MODEL.md`
  (AT-3).

## Scope

**In:**

- The plan, `program/plans/P4-13.md`.
- Contract: the v4 contract section and `packages/shared-protocol` types for the new feed fields and
  `kind: revocation`; the decision function in `client-core`.
- Worker: revocation ingest on the publish submit route (signature checked against the product's
  release keys); resolution skips revoked releases (a P4-12 hook); the update feed composer adds
  `packSets`, pack floors, revocations and per-outlet narrowing, reading distribution's transports
  through the `delivery` and `outletCapabilities` hooks (P2b-01).
- CLI: `pkey release revoke <deliverable>@<version> [--replacement <version>] --reason <text>`,
  signed with the release key.
- Corpus: `feedCases` for the new fields, `releaseRecordCases` for `kind: revocation`,
  `packSetId` vectors, and the `update-matrix.json` rows below.
- SDKs: the decision and the revocation check in `client-core` (Node, React), Python, Swift and
  Godot; SDKs refuse to mount a revoked release.
- Docs: the contract section, the regenerated corpus page, a threat-model note on the new record kind.

**Out** (and where it belongs instead):

- Distribution's per-outlet rollout and halt data for packs (→ [P4-14](P4-14-readiness-gc-rollouts.md)).
  If the v4 plan has no decision rows for a rolling or halted **pack** release, add them here:
  P4-14 has no corpus gate.
- Content-key delegation records (→ [P4-19](P4-19-content-key-delegation.md)).
- Console display of revocations (→ [P4-15](P4-15-console-compat-matrix.md)).
- Outlet readiness (→ P4-14) and platform-transport enforcement (→ P5-08).

## Design notes

- **From P3-01's approved plan** (`plans/P3-01.md` §2.8, §8): the feed route is
  `GET /{product}/update/{channel}/feed.jws?platform=`; `content-floor` and `revoked-content` sit
  after `app-floor` and the mandatory offers in the decision order, and `prestage` is filled on
  `binary`. Both reasons are reserved names that this package adds to `BLOCKED_REASONS`, the
  `updateBlockedReason` enum and `vocabulary.blockedReasons` together. This package decides
  whether either maps to `required`, the boot value v4 leaves unused (P3-01 decision 1: no v4
  answer stops play). New integer claims follow plan §2.2's rule, each with its minimum.
- **The slots exist.** P3-01's plan reserves, for P4: in the record, `kind: revocation` and
  `content: {contentApi, pins[], holds[], expects[], packChannels}`; in the feed, `packSets`, pack
  floors per `contentApi` and revocations; in the decision, `packs`, `prestage`, `content-floor`
  and `revoked-content`. v4 verifiers "verify, then refuse to act on" reserved kinds. This package
  fills those slots rather than inventing shapes, and its plan states what a v4 SDK that predates
  it does with a feed that carries them (it keeps using a revoked release until upgraded; say so).
- **Feed fields** (names from CONTENT §6.9; the plan freezes them): `packSets` keyed by
  `contentApi` → `{packSetId, packs[] {id, version, release}}` per (platform, variant) selector
  (CONTENT §9 sketches `sets[] {select, packs[], rollout}`); pack floors per level; revocations in
  force; per-outlet binding narrowing (proposed `narrowed: {<outlet>: {<packId>: "pinned"}}`); the
  `unsatisfied` marker P4-12 stores. Pinned packs have no feed entry.
- **Feed partitioning.** The research disagrees with itself: README §3.3 says the feed is signed
  "per channel and selector (`contentApi`, platform, variant)", CONTENT §6.9 has one feed carrying
  `packSets` keyed by `contentApi`, and CONTENT §11's route is one feed per channel
  (`GET /<p>/update/<channel>/feed.jws`). P3-01's plan answers it (its brief recommends one feed per
  (product, channel) with a `selector` object that P4 extends with `contentApi` and variant, served
  at the route P3-03 landed, proposed `GET /{product}/update/feed/{channel}`). Follow it; carrying
  every live level in one feed also means a device about to update its binary already holds the
  next level's set for pre-staging.
- **Size.** The v3 payload cap is 65,536 bytes (`docs/security/WIRE-CONTRACT-V3.md` §1); use v4's
  value. Levels × platforms × variants × packs × revocations can approach it. Add a generator test
  at the cap and a Worker guard, and plan the split (for example a per-platform feed as a cache
  key) before it is needed. Revocations whose target is below every floor can drop out of the feed.
- **Revocation record**: a `pkey-release+jws` with `kind: revocation`, proposed body
  `{deliverable, target (release record sha256), replacement?, reason, seq}`. Only the CI release
  key may sign one; a delegated content key may not (P4-19). The feed lists revocation record
  hashes (the record hash P3-01 defined: SHA-256 over the ASCII compact JWS); the client fetches
  each from the record route by hash and verifies it against the **pinned release keys**
  (`pinnedReleaseKeys`), never the Worker's trust set. A replacement must be the same deliverable.
  SDKs refuse to mount a revoked release (embedded baselines and pinned packs included) and swap
  in the replacement if it is compatible with the device (level, engine, variant); otherwise
  `blocked(revoked-content)`.
- **Yank vs revoke** (CONTENT §6.7 item 6): a yank stops new serving; devices keep what they have. A
  revocation makes devices stop using it. Resolution treats a revoked release as yanked.
- **Floors.** A pack floor is per (pack, channel, level) (P4-12). A device is
  `blocked(content-floor)` when its active release of a pack is below the floor for its level and
  nothing in its reach satisfies it: the set carries no satisfying release (`unsatisfied`), or the
  pack is pinned or narrowed to pinned by the outlet's transport. The UX is the app floor's: store
  prompt or binary update.
- **Narrowing** (CONTENT §6.6): effective binding = declared binding ∧ transport capability,
  evaluated per outlet when the feed is composed. `play-pad` narrows `compatible` to pinned;
  `apple-ba` keeps it (the level is in the asset-pack id, e.g. `foes-c3`); `embedded` is a baseline
  under a CDN overlay. Update reads distribution's transports through the Core descriptor hooks;
  the only service import stays `update → release`.
- **Active set and `packSetId`.** The device's active set is its record's pins, then its holds
  over the feed set, then the feed set (P4-12's proposal). The formula is P4-01's (pinned by
  `packSetIdCases`, P4-04); add cases for an active set that mixes pins, holds and feed entries.
- **Decision precedence.** The plan writes one order and the rows pin it. Proposed:
  `blocked(app-floor)` → mandatory `binary`/`store` → `blocked(revoked-content)` →
  `blocked(content-floor)` → `binary` with `prestage[]` → `packs` → `none`.
- **`update-matrix.json` rows** (proposed ids; the plan may rename):

  | Row                                          | Expected                                                                                                |
  | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | `packs-new-compatible-release`               | `packs` with the feed's set for the device's level                                                      |
  | `packs-active-equals-target`                 | `none`                                                                                                  |
  | `packs-standalone-any-level`                 | `packs`; a `standalone` pack reaches every level                                                        |
  | `packs-hold-overrides-feed`                  | the held release stays; others update                                                                   |
  | `packs-pinned-never-from-feed`               | a pinned pack is untouched by the feed                                                                  |
  | `packs-narrowed-to-pinned-on-play`           | the PAD-carried pack is not updated                                                                     |
  | `binary-prestage-on-contentapi-change`       | `binary` with `prestage[]` = the new level's required packs (+ installed optional, if the plan says so) |
  | `binary-same-contentapi-no-prestage`         | `binary`, empty `prestage`                                                                              |
  | `store-new-level-fetch-at-boot`              | after a store update, `packs` for the new level's required set before READY                             |
  | `blocked-content-floor-no-backport`          | `blocked(content-floor)`                                                                                |
  | `content-floor-met-by-backport`              | `packs` (CONTENT §6.8 row 3)                                                                            |
  | `blocked-content-floor-pinned-below-floor`   | `blocked(content-floor)`                                                                                |
  | `revoked-with-compatible-replacement`        | `packs` with the replacement                                                                            |
  | `blocked-revoked-no-compatible-replacement`  | `blocked(revoked-content)`                                                                              |
  | `revoked-embedded-baseline`                  | the baseline is not mounted; replacement or `blocked(revoked-content)`                                  |
  | `app-floor-precedes-content-floor`           | `blocked(app-floor)`                                                                                    |
  | `mandatory-binary-supersedes-optional-packs` | mandatory `binary`; optional packs for the old level are skipped, required ones still fetched           |
  | `mandatory-store-supersedes-packs`           | `store`                                                                                                 |
  | `non-mandatory-binary-with-pack-update`      | as the plan decides (the Diceroll invariant is "the binary supersedes content")                         |

- **Wire version.** Because P3-01 reserved these slots, no `PROTOCOL_VERSION` bump should be
  needed; the plan confirms that v4 parsers accept the fields being present and non-empty. If the
  approved plans differ, the plan explains the bump and what happens to clients and Workers
  already deployed.
- **Generated constants** (once P1b-02 exists): the `blocked` reasons and new enums go through
  `tools/gen-sdk-constants.ts`, not hand-written per SDK.
- **Corpus concurrency.** Only one corpus-touching package may be in flight (program README §5);
  coordinate with P4-10 and P4-19.

## Steps

1. Write `program/plans/P4-13.md` with all nine required sections, including the feed field
   shapes, the revocation body, the decision order, every row above, the corpus sections, the SDK
   order (`client-core` → Python → Swift → Godot) and the rollout story. Set `awaiting-approval`
   and stop.
2. After approval: contract text and `shared-protocol` types.
3. Worker: revocation ingest, resolution hook, feed composition and narrowing, size guard.
4. Corpus: generator changes, `pnpm gen:corpus`, mirrors, docs regeneration.
5. SDKs in wave order, each against the regenerated corpus.
6. CLI `pkey release revoke`; threat-model note; the green gate.

## Acceptance criteria

- [ ] `program/plans/P4-13.md` is merged (human approval) before any code lands.
- [ ] `cases.json` has `feedCases` for `packSets`, pack floors, revocations and narrowing,
      `releaseRecordCases` for `kind: revocation` (valid; signed by the product key instead of a
      release key → rejected; replacement from another deliverable → rejected), and `packSetId`
      vectors; `update-matrix.json` has every row listed above; `pnpm gen:corpus -- --check` is
      clean, mirrors included.
- [ ] The rows and cases pass in `conformance/runners/node` (`client-core`), pytest, `swift test`
      and the Godot runner (editor and release template).
- [ ] Worker tests: a revocation signed by a release key is ingested and one signed otherwise is
      refused; resolution skips the revoked release; the composed feed carries the fields; a
      pack carried by `play-pad` on the Play outlet is narrowed to pinned; the payload-cap guard
      trips at the limit.
- [ ] `pkey release revoke` has a CLI test.
- [ ] The corpus page and contract text are regenerated or updated; the threat model mentions the
      revocation record kind.
- [ ] The green gate passes (`AGENTS.md`).
- [ ] `parity.json` manifests are updated for every SDK this changes (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm conformance
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- update
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
```

## Hand-off

- **P4-19** extends `releaseRecordCases` and the record verification chain with delegation, and
  forbids delegated keys from signing revocations.
- **P4-14** fills per-outlet pack rollouts and halts into the feed shape frozen here.
- **P4-15** shows revoked releases and effective bindings using the composer's functions.
- **P5-08** relies on narrowing for `apple-ba` and `play-pad`; **D-04** on the decision rows for
  Diceroll's boot shell.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-13 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-13)

The approved [`plans/P4-13.md`](../plans/P4-13.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Corrections from implementation

Where the code and the approved plan differed, the code is the fact. Each item below is a
recorded deviation or a precision the plan left open; none changes a decision.

- **Counts.** `feedContentCases` has 48 cases and `revocationCases` 27 (the plan said about 32
  and about 18). `contentRows` has exactly 44 (C1–C43 and C9b). The generator asserts all three.
- **`update-matrix.json`'s `description` is unchanged.** Only the two vocabulary arrays were
  edited in place, so the file stays append-only. `contentRows` is documented in
  `contribute/corpus.md` and the generated corpus page.
- **`holdsOf` takes a pointer.** Its signature is `holdsOf(content, nonWire?, pointer = "/content")`,
  and a stamp is read with `""`. `stampHolds(bytes | text)` in `client-core` wraps strict JSON and
  `holdsOf` for hosts. `parseContentStamp` is unchanged.
- **The token rule reaches the decision through normalised inputs.** `verifyFeed` (and the reload
  path) now return `content` (`feedContent` with the payload's own `nonWireIntegers`).
  `withFeedContent` replaces each member with its parsed value, or removes it, before
  `decideUpdate`. A record whose `content.holds` fails the token rule reaches the decision with
  `holds: null`. `verifyReleaseRecord` returns `nonWireIntegers` for this.
- **Limits live in protocol `core`.** `MAX_FEED_REVOCATIONS` and `REVOCATION_REASON_MAX_BYTES` are
  in `@polaris-key/protocol/core`, because `gen:constants` reads `WIRE_LIMIT_EXPORTS` from there.
  `update` re-exports the first.
- **The engine's second store.** `PackEngineOptions.revocations` is a second `PackStateStore` (the
  same seam: atomic replace and quarantine) for `revocations.json`. It is not a key on
  `PackStorage`. Node's `DirPackStorage.revocationStore()` and React's OPFS and memory stores
  provide it. `state.json` gains `revocationsStored: true`, which the engine writes before the
  sibling file.
- **Applying `packs`.** The engine gains `ensureReleases` and `estimateReleases` (exact releases,
  `pack-revoked` for a revoked one). `runBootFetch` gains `install` (a `packs` answer's list) and
  returns `background` when given it.
- **Worker:**
  - A channel pointer pinned to a revoked release falls back to the channel's unpinned rule.
  - Size step 3 keeps "referenced" revocations: the target is pinned or held by a _live_ app
    release, or a row lists it. The drop rule keeps those named by _any_ stored app release on
    the channel. Read literally, the two sets were the same, so step 3 would have removed nothing.
  - A revocation is not refused while Distribution is off.
  - Content audits are written on each re-sign.
  - No new route and no new error code: the refusal reasons extend `release_record_rejected`.
  - The HTTP transcripts did not change.
- **CLI:**
  - `revoke --dry-run` still needs the CI token and discovery, because it resolves both records
    through the uploads preflight.
  - `content-stamp --hold` also refuses a pack whose binding is not `compatible`, as ingest's
    `hold-binding` does.
- **P4-07 merged during this package.** Its Python and Swift content runners gained the
  `stampCases` count bump (6 → 10). They compare `parseContentStamp` without `expect.holds`, which
  P4-23 checks with `holdsOf`. Their parity manifests list `update.content` and `packs.revoke` as
  planned for P4-23.
- **Godot.** Only the runner count moved (`feedCases` 77 → 80). The release-template run was not
  executed locally (the installed export template is Linux x86_64); CI runs it.
- **Corpus growth.** The source grew by about 1.38 MB (cases.json +504 KB, update-matrix.json
  +869 KB, content/cases.json +8 KB), not the plan's ≈0.44 MB: every `contentRows` input carries
  the whole six-target feed. With the Swift and Godot mirrors the repository grows by about
  4.1 MB.
- **Review fixes (lead review).**
  - `relearn` clears once step 11 has fetched, verified and stored every revocation of the pack
    whose target is in H (the entries step 11 considers), on a fresh, network-verified feed with
    a usable `revocations` member. An entry for an older release the device does not hold never
    keeps a pack in `relearn`. The threat model records the residual under size step 3's
    narrowed set.
  - **Amendment to plans/P4-13.md §2.5:** `relearn` (and `revocationsStored` with an unreadable
    `revocations.json`) refuses embedded mounts at every boot, online or offline, not only
    offline. Online the pack is fetched instead; when no copy can be fetched the engine raises
    `pack-revoked` with detail `relearn`.
  - A torn `state.json` that lost `revocationsStored` gets the flag back when a readable
    `revocations.json` with entries is loaded.
  - An admin un-yank of a revoked release is refused (`release_revoked`, 409), and the unyank
    statement is guarded in SQL: a revocation is permanent.
  - React reads a stamp's holds from its original bytes or text, never from re-serialised JSON.

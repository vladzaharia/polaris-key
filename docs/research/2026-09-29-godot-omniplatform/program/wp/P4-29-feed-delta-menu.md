# P4-29 The feed's delta menu: offer lazy deltas in the signed feed, read them in every SDK's planner

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v3)                                                                                                                                   |
| Size        | 1–1.5 engineer-weeks                                                                                                                             |
| Depends on  | [P4-17](P4-17-lazy-deltas.md), [P4-13](P4-13-revocation-floors-decision.md), [P4-18](P4-18-web-dcz.md)                                           |
| Unblocks    | [P4-30](P4-30-feed-delta-menu-python-swift.md), [P4-31](P4-31-feed-delta-menu-godot.md), [P6-08](P6-08-kotlin-update-packs.md)                   |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                            |
| Plan mode   | yes: `program/plans/P4-29.md` is written and approved before any code                                                                            |
| Gates       | plan mode; corpus (`feedContentCases`, a new `plan-matrix.json` section, mirrors); drift gates; every SDK; threat model; generated docs; workerd |
| Human input | approval of the plan (merging the plan PR); nothing else (the corpus uses test keys and the committed content blobs)                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Goal

Give the feed's reserved `deltas` member a shape, so the Worker can offer the lazy deltas P4-17
generates and every SDK's planner can choose one. Today generated deltas are stored, verified and
recorded in `release_lazy_deltas`, but no device is offered them. After this package, a device on
payload `from` that installs payload `to` sees the lazy delta as one more `payload` candidate
beside the record's own deltas. The planner costs it as usual. The applier checks it against the
target hash in the CI-signed record, and on any failure falls back.

## Why

P4-17's Corrections moved the delta menu out of that package. WIRE-CONTRACT-V4 §2.4 lists
`deltas` (P4-17) only as a **reserved** member that v4 verifiers ignore, with no shape. Giving it
a shape, reading it in `client-core`, adding corpus cases and porting the reader to every SDK is
an all-languages change, the same kind P4-13 made under plan mode (`CLAUDE.md`, `AGENTS.md`
rule 2). README §3.3 lists "the delta menu" among the feed's fields. CONTENT §8.1's telemetry
bullet and notes/E8 §5.8 ("deltas need no signature; a bad artifact fails the verification of
what it produces, then the client falls back") are the design.

## Read first

- `AGENTS.md` (rules 1–3, 6, 10), `CLAUDE.md` (plan mode), `program/plans/README.md`.
- [P4-17's brief](P4-17-lazy-deltas.md) and its Corrections: the descriptor in
  `release_lazy_deltas.descriptor_json`, `readyDeltasTo()`, the `lazy-delta` ref, the gated
  prefix and the two opt-in switches.
- `docs/security/WIRE-CONTRACT-V4.md` §2.4, §2.4.1, §2.5.1 (`variants[].deltas`), §2.6 (window
  rule), §3.1, §3.2, §11.4.
- [`plans/P4-13.md`](../plans/P4-13.md) §2.1, §2.2 and §4 (the precedent for a member parsed
  beside the claims, and for an append-only corpus).
- `packages/client-core/src/feed.ts` (`feedContent`), `src/packs/select.ts` (`planTarget`),
  `src/packs/plan.ts`, `src/packs/apply.ts` (`applyDelta`) and `src/packs/engine.ts` (the
  candidate loop and `objectsFor`).
- `packages/worker/src/services/update/feedDoc.ts` (composition and shedding),
  `services/distribution/blobAccess.ts` (`decideBlob`), `services/distribution/payload.ts`
  (P4-18's `dcz` answer), `core/blobs.ts` (`refHolders`).
- [notes/S-08](../../notes/S-08-cloudflare-async-compute.md) §6;
  [CONTENT §8.1, §9](../../CONTENT.md#81-the-strategy-ladder-and-planner);
  [notes/E8 §5.8](../../notes/E8-content-delivery.md#58-signing-and-trust).

## Scope

**In** (the plan fixes each item):

- Contract: the `deltas` member's shape in a new V4 §2.4.2, read by `feedContent` beside the
  claims; two limits in `@polaris-key/protocol/core`.
- `client-core`: the reader, `withFeedDeltas` (the merge into a variant's delta list), the
  engine's use of the committed feed's menu, and the fallback rules.
- Corpus: appended `feedContentCases`, a new `plan-matrix.json` section and a new
  `content/cases.json` section, with their regeneration and mirrors.
- Node and React (through `client-core`), with the runners of every other SDK kept green.
- Worker: the composer lists ready lazy deltas; the blob route and P4-18's payload URL serve them
  under the pack's delivery rules.
- Parity row, generated constants and docs, the threat-model note, the RUNBOOK.

**Out** (and where it belongs instead):

- The Python and Swift readers (→ P4-30), and the Godot reader (→ P4-31).
- The Kotlin SDK (→ P6-05, which inherits the parity row). There is no C# SDK.
- Generating deltas (→ P4-17); collecting cold ones (→ P4-14); console views of the menu.

## Steps

1. Wait for the plan's approval and for P4-17 to merge.
2. Execute the plan's step order: contract, catalog (none), corpus, `client-core` with Node and
   React, Worker, docs.
3. Run the green gate, stopping at the first failure. Report to the lead.

## Acceptance criteria

- [ ] Every appended `feedContentCases` vector and every new `feedDeltaCases` and
      `feedDeltaApplyCases` vector passes in the Node and browser runners. Every pre-existing
      vector is byte-identical (a canonical-JSON diff in the PR).
- [ ] The Python, Swift and Godot runners pass unchanged apart from the moved count.
- [ ] A composed feed lists a ready lazy delta for devices on `from`, and `client-core`'s planner
      picks it on the content set's v1 → v2 inputs (P4-17's fourth criterion).
- [ ] A lazy delta of a gated pack is served only to a caller that the pack's gate admits.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen corpus --check
mise exec node@22 -- pnpm gen constants --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- feed blobAccess payload
mise exec node@22 -- pnpm test:browser
```

## Corrections from implementation

- **`feed-delta-platform-target` became `feed-delta-no-delta-strategy`.** `planTarget` always
  maps `platform` to null, so the runner's pipeline (`withFeedDeltas` → `planTarget` → `plan`)
  cannot express a platform target. The 13th `feedDeltaCases` case covers §2.4 step 3's other
  untested rule instead: a host without `delta` in `caps.strategies` merges the entry and never
  plans it.
- **Unusable `feedContentCases`.** Plan §4.2's list counts 16 only when "`artifact` missing or
  with a bad `sha256`" is one case; it is `feed-deltas-bad-artifact` (an upper-case
  `artifact.sha256`). A missing `artifact` fails the same rule in every reader.
- **Corpus size.** Plan §4.1 estimated about 60 KB of source. The real growth is `cases.json`
  +405 KB, `plan-matrix.json` +260 KB and `content/cases.json` +8 KB, or about 1.3 MB with the
  two mirrors. Each appended feed case is a full signed copy of P4-13's base feed (about 13 KB).
  `feed-delta-real-v1-v2` carries the content set's files index, chunk index and target inline,
  as the `plan-real-*` rows do. Every pre-existing case is byte-identical by canonical JSON (610
  in `cases.json`, 61 in `plan-matrix.json`, 188 in `content/cases.json`); only the two
  generated `description` strings changed.
- **`runUpdateCheck` returns `content`.** Plan §2.5 names only the engine option. The Node and
  React wiring needs the verified `FeedContent` of the feed the decision used (the menu read with
  its own `nonWireIntegers`), so the check result gains `content`.
  - Node: `UpdateClient` keeps the menu after `decide()` and `feed()`. It also reads the
    committed feed from the cache, through `reloadFeeds` and with no freshness check, when the
    pack engine starts. Since the follow-up, `feed({ channel })` keeps the menu only when
    `channel` is the configured one.
  - React: `decideBrowserUpdate` returns `feedDeltas`. The adapter hands them to
    `BrowserPacks.recordFeedDeltas`, and `BrowserPacksOptions.feedDeltas` lets a host supply its
    own. Since the follow-up, the adapter also seeds the facet at construction
    (`BrowserPacks.seedFeedDeltas`) with the menu of the most recently committed feed in its
    cache (highest `issuedAt` that re-verifies, no freshness check), and the engine's start waits
    for it. The adapter has no configured channel, so it takes the newest feed rather than the
    canonical channel's.
  - The desktop bridge needs nothing: its host runs `@polaris-key/node`.
- **A runner line outside the new sections.** In the Node runner, `delegationCases`' `feed` mode
  compared `r.content` with an `expect.content` of three members. It now compares the three and
  asserts `deltas` is null. `FeedContent` gained a member, and those feeds carry no menu. The
  Python, Swift and Godot runners compare `expect.content` only, so they changed only in the count
  (48 → 76).
- **The resume rule.** The engine never resumes a candidate from the journal; it always
  re-plans, reusing the plan id. A journal's `feedDelta` is merged again before planning. A
  journal whose `delta` neither the record nor its own `feedDelta` names gets a fresh plan id
  (abandoned and re-planned). A feed delta whose fetch fails falls back, as plan §2.4 step 5
  says, instead of raising the record path's "the next ensure resumes".
- **Worker.**
  - The hook returns the ready rows. The composer ranks and caps them (`feedDeltas.ts`).
  - The `seq` hash covers the set of candidates, not their rank. A delta turning `ready` or
    `cold` bumps `seq`, but a change in device counts alone does not, because otherwise the seq
    would move on almost every report. V4 §2.4.2 says so.
  - Serving through the blob route and the payload URL also requires both P4-17 switches
    (decision 9).
  - The feed response's OpenAPI schema is a plain string, so only descriptions changed.
  - **Risk 3 understated the cost.** The plan said "one more indexed D1 read per feed request".
    The candidate set is read on every request, before the seq hash, because the hash covers it:
    the pins and holds of each target's app release (two reads per target), the product's
    switch, one read of the ready rows, and the named pack records (one read per 90). The
    device counts behind the rank (`installedBase`, one `COUNT … GROUP BY` over
    `delta_demand_devices` per pack deliverable) are not hashed. Since the follow-up
    (`fix/p4-29-followups`) they are read through a separate hook, `lazyDeltaDevices`, only when
    a document is signed (`withRankedMenu` in `feedDoc.ts`); a request served from the stored
    copy reads none. The feed route's probe `documentFor` carries no menu, since the menu never
    changes the document choice.
  - No `test:workerd` CPU test at 64 packs × 3 levels was added (risk 3). The Node CPU budget
    test (`feedContentSize.test.ts`, 64 packs × 3 levels × 6 platforms) now runs with a 64-entry
    menu, and a variant of P4-13's `appTargetNearCap` fixture sweeps the padding to show the
    menu never adds a shed step. `test:workerd` passes.
  - The simulation route (`simulate.ts`) originally passed no `env`, so the console's simulation
    showed no menu. Since the follow-up, the admin handler passes the `LAZY_DELTAS` switch's
    string value (still no binding), the simulated document is ranked as on the sign path, and
    the answer's `feed.deltas` counts the entries listed; the console shows it.

## Hand-off

- **P4-30 and P4-31** port the reader, the merge and the fallback rules from the approved plan.
- **P6-05** implements the `packs.delta.feed` parity row in the Kotlin SDK.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-29 done`.

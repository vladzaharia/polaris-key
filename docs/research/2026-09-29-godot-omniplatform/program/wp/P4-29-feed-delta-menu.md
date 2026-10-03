# P4-29 The feed's delta menu: offer lazy deltas in the signed feed, read them in every SDK's planner

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v3)                                                                                                                                   |
| Size        | 1–1.5 engineer-weeks                                                                                                                             |
| Depends on  | [P4-17](P4-17-lazy-deltas.md), [P4-13](P4-13-revocation-floors-decision.md), [P4-18](P4-18-web-dcz.md)                                           |
| Unblocks    | none                                                                                                                                             |
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

- The Python and Swift readers (→ P4-30), and the Godot reader (→ P4-31), proposed in the plan's
  graph edits.
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
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- feed blobAccess payload
mise exec node@22 -- pnpm test:browser
```

## Hand-off

- **P4-30 and P4-31** port the reader, the merge and the fallback rules from the approved plan.
- **P6-05** implements the `packs.delta.feed` parity row in the Kotlin SDK.

Set the status in the PR that completes the work:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-29 done`.

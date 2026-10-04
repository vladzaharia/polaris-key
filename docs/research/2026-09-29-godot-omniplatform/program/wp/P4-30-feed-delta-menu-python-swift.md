# P4-30 Feed delta menu in Python and Swift

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v3)                                                                                                     |
| Size        | 0.5–0.75 engineer-weeks                                                                                            |
| Depends on  | [P4-29](P4-29-feed-delta-menu.md)                                                                                  |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                               |
| Plan mode   | yes: execute the approved `plans/P4-29.md` (its P4-30 parts); the plan's approval is this package's plan-mode gate |
| Gates       | plan mode; corpus (runners only; P4-29 owns the corpus); all SDKs                                                  |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Port P4-29's feed delta menu to Python and Swift, so every appended `feedContentCases` vector and
every `feedDeltaCases` and `feedDeltaApplyCases` vector passes there exactly as in `client-core`,
and their pack engines take a lazy delta from the committed feed with P4-29's fallback rules.

## Read first

- [`plans/P4-29.md`](../plans/P4-29.md): §2.2 (the member and its rules), §2.4 (reader, merge,
  planner, verification, fallback, journal), §4 (the three sets and the runner rule
  `expect.deltas ?? null`), §5's P4-30 row and §8's decisions. Where it and this brief differ, the
  plan wins.
- `client-core`'s P4-29 implementation on `main` (the reference): `feed.ts`, `packs/select.ts`
  (`withFeedDeltas`) and `packs/engine.ts`.
- The SDKs' own sites: `sdks/python/src/polaris_key/core/feed.py`,
  `sdks/python/src/polaris_key/update/packs/select.py` and the Python pack engine;
  `sdks/swift/Sources/PolarisKeyCore/Content.swift`, `sdks/swift/Sources/PolarisKeyPacks/Select.swift`
  and the Swift pack engine.

## Scope

**In:**

- `feed_content` / `feedContent` returns `deltas` (`null` when absent or unusable; a `files`-scope
  entry dropped alone; an unknown method kept), with the two generated limits
  (`MAX_FEED_DELTAS`, `MAX_FEED_DELTAS_PER_TARGET`).
- `with_feed_deltas` / `withFeedDeltas(variant, deltas) → (variant, feed_ids)`: container and
  usable variants only, record deltas first, a duplicate artifact id dropped.
- The engines: the committed feed's menu as the source (fresh or stale), at most one feed delta
  tried per install, the optional journal `feedDelta` on resume, the existing fallback events.
- Runners: the appended `feedContentCases` comparing `content.deltas` with `expect.deltas ?? null`
  on every case, `plan-matrix.json#feedDeltaCases`, `content/cases.json#feedDeltaApplyCases`.
- `parity.json`: `packs.delta.feed` from `planned` to implemented; README.

**Out:** the Worker, client-core, Node, React and the corpus (P4-29); Godot (P4-31).

## Steps

1. Branch from `main` after P4-29 has merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [ ] Every new vector in the three sets passes in pytest and `swift test`.
- [ ] Engine tests: fallback after a 404 and after each mismatch, the one-feed-delta rule, resume
      with `feedDelta`.
- [ ] `pnpm parity:check` and the full green gate pass.

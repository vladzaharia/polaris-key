# P4-31 Feed delta menu in Godot

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v3)                                                                                                     |
| Size        | 0.5–0.75 engineer-weeks                                                                                            |
| Depends on  | [P4-29](P4-29-feed-delta-menu.md)                                                                                  |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                           |
| Plan mode   | yes: execute the approved `plans/P4-29.md` (its P4-31 parts); the plan's approval is this package's plan-mode gate |
| Gates       | plan mode; corpus (runners only; P4-29 owns the corpus); all SDKs                                                  |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Port P4-29's feed delta menu to the Godot SDK, so every appended `feedContentCases` vector and
every `feedDeltaCases` and `feedDeltaApplyCases` vector passes in `run_tests.sh` (editor and
release template), and `PKeyBoot`'s pack fetch takes a lazy delta from the committed feed with
P4-29's fallback rules, on the GDScript path and the native payload port alike.

## Read first

- [`plans/P4-29.md`](../plans/P4-29.md): §2.2, §2.4, §4 (the runner rule `expect.deltas ?? null`),
  §5's P4-31 row and §8's decisions. Where it and this brief differ, the plan wins.
- `client-core`'s P4-29 implementation on `main` (the reference).
- `sdks/godot/addons/polaris_key/core/feed.gd`, `sdks/godot/addons/polaris_key/packs/select.gd`,
  the Godot pack engine and its native payload port, `sdks/godot/tests/suite_conformance.gd`.

## Scope

**In:**

- `PKeyFeed.feed_content` returns `deltas` under §2.2's rules (token rule through
  `PKeyClaims.is_wire_integer`), with the generated limits.
- `with_feed_deltas(variant, deltas)` in `select.gd`, returning the merged variant and the feed ids.
- The engine: the committed feed's menu as the source, at most one feed delta tried per install,
  the journal `feedDelta`, fallback events, and the native payload port receiving a merged delta.
- Runners: the three sets; `parity.json` `packs.delta.feed` implemented; README.

**Out:** everything P4-29 and P4-30 own.

## Steps

1. Branch from `main` after P4-29 has merged.
2. Implement the scope; run `sdks/godot/tools/run_tests.sh` with and without `GODOT_TEMPLATE`, then
   the green gate.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [ ] Every new vector in the three sets passes, editor and release template.
- [ ] Engine tests: fallback after a 404 and after each mismatch, the one-feed-delta rule, resume
      with `feedDelta`, the native port path.
- [ ] `pnpm parity:check` and the full green gate pass.

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

- [x] Every new vector in the three sets passes, editor and release template.
- [x] Engine tests: fallback after a 404 and after each mismatch, the one-feed-delta rule, resume
      with `feedDelta`. The native port path does not apply (see Corrections).
- [x] `pnpm parity:check` and the full green gate pass.

## Corrections from implementation

- **No native payload port path.** The Godot pack engine has no native payload transport.
  Client-core's `applyNative` is P4-18's host hook, and Godot never ported it: a `platform`
  plan is refused with `plan-transport-unsupported`. Every feed delta therefore goes through the
  engine's own decode (GDDL on 4.6 and 4.7), and the acceptance item about the native port has
  nothing to test. A platform-bound pack never takes a feed delta, because `plan` answers
  `platform` before it costs any candidate.
- **The engine cases are a new packs group, `feed_deltas`** (`tests/packs/test_feed_deltas.gd`).
  It ports client-core's `packsFeedDelta.test.ts` case for case over `custom.blob` container
  packs (`F.blob_pack`) built from the probe pair. The suite does not advertise
  `zstd-patch-from` on 4.4 and 4.5. On those engines the group instead checks that the menu is
  never planned and the install still completes.
- **The menu source.** `PKeyPacks.feed_menu()` answers the menu of the feed that the last update
  check or `fetch_feed` in this process committed, or fell back to (`remember_feed_content`).
  Before either has run, it reads the cached committed feed of the configured channel and its
  alias target (`PKeyFeed.bound_channels`), fresh or stale. `PKeyUpdateCheck` gains `content`
  (client-core's check result `content`), which carries the feed's content members and its
  menu.
- **Fallback events.** Godot emitted no P4-18 `fallback` progress event before this package. The
  engine now emits `{phase: "fallback", strategy, error}` whenever a candidate fails and the next
  one runs, as client-core does.

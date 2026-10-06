# P1-13 Godot timing tests that hold under any load: replace wall-clock ratio and frame-count checks with deterministic work counters

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Phase       | P1: Godot SDK core                                   |
| Size        | 0.25–0.5 engineer-weeks                              |
| Depends on  | none                                                 |
| Unblocks    | none                                                 |
| Role        | `pkey-godot-engineer`                                |
| Plan mode   | no                                                   |
| Gates       | the `godot` CI job (`sdks/godot/tools/run_tests.sh`) |
| Human input | none                                                 |
| Repo        | `vladzaharia/polaris-key`                            |

## Goal

No check in `sdks/godot/tests` passes or fails depending on machine load. Complexity checks
(linear, not quadratic; linear in the bytes, not in the hits) assert on counts of work the code
reports, not on milliseconds. Checks that work moved off the main thread or across frames assert
on what the code did, not on how many frames happened to pass. Wall-clock bounds remain only as
generous hang guards. The Godot suite passes on a machine at load average 300 as it does idle.

## Why

The Godot runner flakes in the lead gate when parallel work packages push the load average above
about 270. The ratio checks compare the fastest of three interleaved runs
(`PKeyTestFixtures.fastest_ms`) with a fixed factor plus 25 ms of slack. Interleaving cancels a
steady load, but not the bursty scheduling of a heavily oversubscribed machine, where one run of
one function can be preempted on all three rounds. The frame-count checks in
`tests/core/test_offload.gd` (`frames >= 2`) depend on how a worker thread's speed compares with
the frame rate, and load changes both. CLAUDE.md's test budget says a timing flake under load is
not a blocker but must not be fixed by raising timeouts. This package removes the cause instead.

## Read first

- `AGENTS.md` and `CLAUDE.md` ("Test budget": no raised timeouts to get green).
- `sdks/godot/tests/support/fixtures.gd` `fastest_ms` and its doc comment.
- The ratio checks: `tests/packs/test_pck.gd` `_scan_scaling` (`G_RUN_HIT_FACTOR`,
  `G_RUN_SCALE_FACTOR`, `RATIO_SLACK_MS`) and `tests/core/test_json.gd` (the
  "json pointer set stays linear" ratio).
- The precedent for the fix: `PKeyPck.type_reads`, a work counter the GAP D check in
  `test_pck.gd` reads instead of timing.
- The frame-count checks: `tests/core/test_offload.gd` (`r["frames"] >= 2`, `frames == 0` for
  inline) and its `_run` helper. Also the offload code in
  `addons/polaris_key/core/crypto/ed25519_job.gd` and the verify offload it drives.
- Run `git grep -n "fastest_ms\|get_ticks_usec\|get_ticks_msec\|frames\"\] >=" -- sdks/godot/tests`
  for the full set. Loops that wait up to 30 s for a request are hang guards and stay.

## Scope

**In:**

- Every ratio check moves to a work counter the code under test exposes as a static counter, as
  `type_reads` does. For example, `PKeyPck._marker` counts bytes examined and candidate
  comparisons. Then 8 MiB of `G` makes at most a constant times the comparisons of 8 MiB of `Z`,
  and 4× the bytes makes at most a constant times the work. `PKeyJson.walk` counts pointer-string
  bytes built, so a long path costs the same work as the same bytes off the path. The bounds are
  exact or near exact, because counts do not vary.
- Every frame-count check moves to a deterministic signal. Examples: the job reports the mode it
  ran in (`thread`, `sliced`, `inline`); a sliced run reports its slice count, at least 2 for the
  350 KB bundle at a 4 ms budget, forced by a fake clock or a work-unit budget rather than real
  time; a small verify reports `inline`. Where the production code takes a time budget, inject
  the clock (as `now_source` does elsewhere) so the test can drive it.
- The timing `info` lines can stay for humans, but no `check` reads them.
- `fastest_ms` is deleted if nothing uses it any more. Otherwise its doc comment says it is for
  info lines only.

**Out** (and where it belongs instead):

- Production behaviour. The counters are test hooks, cheap enough to leave in (an integer
  increment), and no algorithm changes.
- Timing checks in other SDKs. File a follow-up if the same pattern turns up there.

## Design notes

- **Counters, not clocks.** A complexity claim is about work, so measure work. Counters are
  static members reset or diffed around the call (`before := X.counter; call(); X.counter - before`),
  which avoids threading through APIs.
- **Keep the regression power.** Each new check must still fail on the regression the old one
  guarded against. Prove it in the PR by temporarily reintroducing the per-hit loop in
  `first_present` (the P4-27 audit's GAP 2) and the per-number pointer string (the JSON walk),
  and record the failing output.
- **Hang guards stay wall-clock and generous** (120 s as today). They catch a hang, not a slowdown.
- Do not raise a factor, a slack or a timeout to make a check pass. That is the anti-pattern this
  package removes.

## Steps

1. Enumerate every timing-sensitive `check` with the grep above, and list them in the PR.
2. Add the counters and clock injection the checks need.
3. Rewrite each check against them, and prove its regression power as described above.
4. Run the suite under load (for example `stress-ng`, or several parallel `run_tests.sh`
   instances pushing the load average past 300), and record the result.

## Acceptance criteria

- [ ] No `t.check` in `sdks/godot/tests` compares measured milliseconds or a frame count, apart
      from hang guards of at least 30 s (grep listed in the PR).
- [ ] The P4-27 GAP 2 scan checks and the JSON pointer-set check assert on work counters. Each
      fails when its regression is reintroduced (output recorded in the PR).
- [ ] The offload checks assert on the reported mode and slice count, driven by an injected clock
      or work budget.
- [ ] `sdks/godot/tools/run_tests.sh` passes 5 times in a row at load average above 300
      (recorded in the PR), and passes in CI with and without `GODOT_TEMPLATE`.
- [ ] The green gate passes (`AGENTS.md`), scoped to the Godot SDK.

## Verify

```sh
GODOT_BIN=… sdks/godot/tools/run_tests.sh
```

## Hand-off

- Future Godot complexity checks use a work counter. The rule goes into `fixtures.gd`'s doc comment
  in place of `fastest_ms`'s.

The role agent sets `--set P1-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-13 done`.

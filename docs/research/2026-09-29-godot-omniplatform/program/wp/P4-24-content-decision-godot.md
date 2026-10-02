# P4-24 Content decision, feed pack members and revocations in Godot

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                        |
| Size        | 1–1.25 engineer-weeks                                                                                                            |
| Depends on  | [P4-13](P4-13-revocation-floors-decision.md), [P4-08](P4-08-godot-packs.md)                                                      |
| Unblocks    | [P4-26](P4-26-delegation-godot.md), [D-04](D-04-diceroll-after-p4.md)                                                            |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                         |
| Plan mode   | yes: execute the approved `plans/P4-13.md` (its P4-24 parts); the plan's approval is this package's plan-mode gate, as for P4-21 |
| Gates       | plan mode; corpus (runners only; P4-13 owns the corpus); all SDKs                                                                |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Goal

Port P4-13's content decision, the feed's pack members (`packSets`, `packFloors`, `revocations`) and
revocation records to Godot, so every `feedContentCases`, `revocationCases` and `contentRows` row
passes there exactly as it does in client-core.

## Read first

- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-13.md`**: §2.3–§2.6 (feed members,
  revocation records, `newerRevocation`, persistence in the sibling `revocations.json` with
  `relearn` and `revocationsStored`, the decision and boot values), §5's P4-24 row, §8.1 decisions
  (especially 4, 7, 15, 18) and §8.5's P4-24 bullet. Where it and this brief differ, the plan wins.
- client-core's P4-13 implementation on main (the reference), and the SDK's own P4-0x packs port.

## Scope

**In:**

- `feedContent`, `revocationOf`/`verifyRevocation`, `holdsOf` and `newerRevocation` (names identical up
  to casing), with a malformed member treated as absent, never refusing the feed or record.
- The content decision: the `packs` action, `contentBlock`, `prestage`, the `content-floor` and
  `revoked-content` reasons, and boot values (`revoked-content` on a **required** pack is `required`;
  floors never stop play). Exact engine match: `E = installed.engine ?? ""`.
- The pack engine's `pack-revoked`, the sibling `revocations.json` (written only when the first entry
  is stored; P4-06's hardening; unreadable/torn rules; `relearn`; 256-entry cap; `recoverState()`
  clears `relearn`). A product with no revocations behaves exactly as before.
- Runners: `feedCases` count 77→80, `stampCases` 6→10, the new sections, and `holds` checked only when
  `expect.holds` is present.
- Change these "no v4 answer stops play" sites (decision 4 amends P3-01 decision 1): `sdks/godot/addons/polaris_key/distribution/decision.gd:14` and `:500-502`, `sdks/godot/README.md:389` and `:696`, `sdks/godot/tests/suite_boot.gd:204`, `ui/boot/boot_host.gd:26`, `ui/update/update_prompt_controller.gd:14`, `ui/update/pkey_update_prompt.gd:10`, `services/update/update_check.gd:19`; add the revoked-content copy to the Godot UI kit (`PKeyRecord.newer_revocation`). Godot rules: thread-reachable code never indexes a const Array; PKeyJson for signed bytes.
- parity.json, README.

**Out:** the Worker, CLI, client-core and corpus (P4-13).

## Steps

1. Branch from `main` after P4-13 and its SDK predecessor have merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [x] Every `feedContentCases`, `revocationCases` and `contentRows` row passes.
- [x] P4-06-style persistence tests (torn, unreadable, two loads) pass for `revocations.json`.
- [x] The full green gate passes.

## Corrections from implementation

- **Line references moved.** The brief's text sites were re-located by text: `README.md:389` and
  `:696` are now the `boot` member of PKeyUpdateCheck and the PKeyBoot "decide" paragraph;
  `core/stages.gd:40` (the `BOOT_DECISIONS` comment) also said "no v4 update decision maps to it"
  and was changed with them. `feedCases` was already 80 and `stampCases` 10 after P4-10; this
  package added the `expect.holds` check (four cases), the two new pointer-set families
  (`feedContentCases`, `revocationCases`: 553 pointer sets) and the three new sections.
- **Godot follows client-core, not Python, on integers.** `feed_content`, `revocation_of` and
  `holds_of` take the verified payload's `non_wire_integers` (PKeyJson's pointer set), as
  client-core does; `verify_release_record` now also returns `non_wire_integers`, which
  `verify_revocation` and the update check's record holds use. `verify_feed` and `reload_feeds`
  carry `content`, and committed feeds keep it, so the decision always reads the token-rule
  verdict through `with_feed_content`.
- **Storage seam.** PKeyPackStorage gains `revocations_read`, `revocations_replace`,
  `revocations_quarantine` and `revocations_clear_quarantine` over
  `user://pkey/content/revocations.json` (the same atomic write as `state.json`); the engine has a
  `revocations_enabled` switch instead of an optional second store. The sibling file is written
  only after `revocationsStored` reached `state.json`; if that state write fails, the sibling write
  is skipped (never a file without its flag).
- **A revoked `godot.pck` cannot be unmounted.** A revoked restart pack not yet mounted is withdrawn
  from this boot's mount (`PKeyGodotPckHandler.withdraw`); a mounted one stays until restart and is
  refused from the next boot. `mount()` also refuses a revoked release (`pack-revoked`).
- **Applying `packs` in Godot.** PKeyBootHost keeps a `packs` answer's `install` and passes it to
  `boot_fetch`; entries that are neither required nor essential wait in
  `PKeyPacks.background_targets` and BACKGROUND installs them with `ensure_releases` (client-core
  returns them as `background` from `runBootFetch`). `record_revocations` emits
  `set_changed("hot")` when a running release stops.
- **Boot and UI.** PKeyBootHost answers `decide.done required` for boot `required`; PKeyBoot's
  BLOCKED card shows the revoked-content copy (`update_revoked_title`, `update_revoked_body`) with
  the outlet's update button for an offer and none for `blocked`, and no banner under it. The
  prompt model gains `required`; `packs` shows nothing; a content floor uses
  `update_content_floor_body`. `update_available` fires for boot `required` too.
- **Timings (M-series Mac).** feedContentCases 48 in 558 ms (4.7.2 editor), 343 ms (4.7.2 macOS
  release template), 388 ms (4.4.1 editor); revocationCases 27 in 143 / 103 / 139 ms; contentRows
  44 in 13 / 16 / 12 ms; the `revocations` packs group in 4.1 / 2.7 / 3.7 s.

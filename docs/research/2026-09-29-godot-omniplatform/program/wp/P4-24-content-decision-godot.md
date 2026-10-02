# P4-24 Content decision, feed pack members and revocations in Godot

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                        |
| Size        | 1–1.25 engineer-weeks                                                                                                            |
| Depends on  | [P4-13](P4-13-revocation-floors-decision.md), [P4-08](P4-08-godot-packs.md)                                                      |
| Unblocks    | [D-04](D-04-diceroll-after-p4.md)                                                                                                |
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

- [ ] Every `feedContentCases`, `revocationCases` and `contentRows` row passes.
- [ ] P4-06-style persistence tests (torn, unreadable, two loads) pass for `revocations.json`.
- [ ] The full green gate passes.

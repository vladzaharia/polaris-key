# P4-23 Content decision, feed pack members and revocations in Python and Swift

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P4: Packs                                                                                                                        |
| Size        | 1–1.5 engineer-weeks                                                                                                             |
| Depends on  | [P4-13](P4-13-revocation-floors-decision.md), [P4-07](P4-07-python-swift-packs.md)                                               |
| Unblocks    | [P4-25](P4-25-delegation-python-swift.md)                                                                                        |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                             |
| Plan mode   | yes: execute the approved `plans/P4-13.md` (its P4-23 parts); the plan's approval is this package's plan-mode gate, as for P4-21 |
| Gates       | plan mode; corpus (runners only; P4-13 owns the corpus); all SDKs                                                                |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Goal

Port P4-13's content decision, the feed's pack members (`packSets`, `packFloors`, `revocations`) and
revocation records to Python and Swift, so every `feedContentCases`, `revocationCases` and `contentRows` row
passes there exactly as it does in client-core.

## Read first

- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-13.md`**: §2.3–§2.6 (feed members,
  revocation records, `newerRevocation`, persistence in the sibling `revocations.json` with
  `relearn` and `revocationsStored`, the decision and boot values), §5's P4-23 row, §8.1 decisions
  (especially 4, 7, 15, 18) and §8.5's P4-23 bullet. Where it and this brief differ, the plan wins.
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
- Change these "no v4 answer stops play" sites (decision 4 amends P3-01 decision 1): `sdks/python/src/polaris_key/core/decide.py:507-508`, `sdks/swift/Sources/PolarisKeyCore/UpdateDecision.swift:668-670`, `sdks/swift/Sources/PolarisKeyUpdate/UpdateClient.swift:384`, `sdks/swift/README.md:480`, and the Python and Swift README sections that restate them.
- parity.json, README.

**Out:** the Worker, CLI, client-core and corpus (P4-13).

## Steps

1. Branch from `main` after P4-13 and its SDK predecessor have merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [x] Every `feedContentCases`, `revocationCases` and `contentRows` row passes.
- [x] P4-06-style persistence tests (torn, unreadable, two loads) pass for `revocations.json`.
- [ ] The full green gate passes.

## Corrections from implementation

- **Python** reads integers by type (`json.loads` gives a `float` for every non-plain token), so
  `feed_content`, `revocation_of` and `holds_of` take no non-wire pointer set, and a record whose
  holds fail the token rule reaches the decision as unusable without a rewritten copy.
- **Swift** carries `nonWireIntegers` on `ChannelFeedDoc` and `ReleaseRecordDoc` (ignored by
  equality) instead of a `content` member on `verifyFeed`'s result; `UpdateCheckContent` takes a
  `selectsVariant` closure because PolarisKeyCore cannot import PolarisKeyPacks. `binary`,
  `store`, `platform` and `blocked` gain a defaulted `contentBlock`, `binary.prestage` becomes
  `[PackTarget]`, and `.packs` is a new case (source-breaking for exhaustive positional matches).
- Both SDKs' directory stores gain a `name` parameter for the sibling `revocations.json`
  (`revocation_store()` / `revocationStore()`), and `boot_fetch` / `runBootFetch` gain `install`
  with a `background` result, as in client-core.
- Online, an embedded baseline refused for `relearn` is fetched and re-verified; the commit
  reuses the embedded payload's location, as client-core does.

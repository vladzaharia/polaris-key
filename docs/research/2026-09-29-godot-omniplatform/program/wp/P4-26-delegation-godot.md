# P4-26 Content-key delegation in Godot

| Field       | Value                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs                                                                                                          |
| Size        | 0.5–0.75 engineer-weeks                                                                                            |
| Depends on  | [P4-19](P4-19-content-key-delegation.md), [P4-24](P4-24-content-decision-godot.md)                                 |
| Unblocks    | none                                                                                                               |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                           |
| Plan mode   | yes: execute the approved `plans/P4-19.md` (its P4-26 parts); the plan's approval is this package's plan-mode gate |
| Gates       | plan mode; corpus (runners only; P4-19 owns the corpus); all SDKs                                                  |
| Human input | none                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                          |

## Goal

Port P4-19's content-key delegation to the Godot SDK, so every `delegationCases` and
`dataOnlyCases` row passes in the editor and the release template exactly as in client-core.

## Read first

- **`docs/research/2026-09-29-godot-omniplatform/program/plans/P4-19.md`**: §2.3–§2.7, §4.2–§4.3,
  §5's order-3 row, §8.1 decisions and §8.5's P4-26 bullet. Where it and this brief differ, the
  plan wins.
- client-core's P4-19 implementation on main (the reference); P4-08's engine and `files.tree`
  handler; P4-24's content decision.

## Scope

**In:**

- `PKeyRecord` (the chain, `recordRevoked`), `PKeyDataOnly` (`dataOnlyRefusal`: normalised paths
  only, content-sniffed heads never extensions, the tail sniff, tree layout only), step 11
  relevance, the decision-input expansion, the install member and the engine refusals.
- The `simplify_path()` identity assertion in the `files.tree` handler.
- **A delegated file is never passed to `load_resource_pack`** or any API that mounts or loads code.
- Runners for both sections in `run_tests.sh` (4.4.1 floor and current); `parity.json` moves
  `packs.delegation` from `planned` to implemented; README. Signed bytes go through `PKeyJson`;
  thread-reachable code never indexes a const Array.

**Out:** the Worker, CLI, client-core and corpus (P4-19); Python and Swift (P4-25).

## Steps

1. Branch from `main` after P4-19 and P4-24 have merged.
2. Implement the scope; run the green gate, stopping at the first failure.
3. Report to the lead; the lead reviews, merges and sets the status.

## Acceptance

- [ ] Every `delegationCases` and `dataOnlyCases` row passes in the editor and the release template.
- [ ] Non-normalised paths and extension-disguised resources are refused (P4-08 review lesson).
- [ ] The full green gate passes.

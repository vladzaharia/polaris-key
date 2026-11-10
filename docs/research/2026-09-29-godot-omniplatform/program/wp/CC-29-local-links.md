# CC-29 Local links: V5 §15.12, corpus, client-core, product switch, Node, Python, Swift, Kotlin

| Field       | Value                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | CC                                                                                                                                                                                                                       |
| Size        | 0.4–0.5 engineer-weeks                                                                                                                                                                                                   |
| Depends on  | [CC-23L](CC-23L-local-links-plan.md), [CC-19](CC-19-inter-account-links.md), [CC-20](CC-20-direct-transfer.md)                                                                                                           |
| Unblocks    | [CC-29.15](CC-29.15-local-pairing-kit-api.md), [CC-29b](CC-29b-local-links-android-godot.md), [CC-29K](CC-29K-local-links-kit-screens.md), [CC-29D](CC-29D-local-links-docs.md), [CC-29S](CC-29S-local-links-signoff.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                     |
| Plan mode   | yes                                                                                                                                                                                                                      |
| Gates       | plan-mode, protocol-version, corpus, corpus-runner, corpus:mirror, drift-gate, all-sdks, rule-9, threat-model, security-review                                                                                           |
| Human input | none                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                |

## Goal

Account-free local pairing, slices CC-29.0-CC-29.14: V5 §15.12 and the §15.5, §15.6, §15.9 and §15.11 amendments (.0); the CPace reference and corpus (.1-.3); client-core `peer/cpace.ts`, `peer/local.ts` and the session rules for modes `q` and `l` (.4-.5b); the manifest member and the product setting `ManifestConnect.localPairing` (.6); Node (.7-.8), Python (.9-.10), Swift (.11-.12) and Kotlin JVM (.13-.14).

## Why

v0.11 scope (owner 2026-11-03). CC-29.0 is merged on `next` (V5 §15.12, the four `errors.json` client codes, the THREAT-MODEL rows and PRIVACY); the package stays in progress until .14. The `connect.local` feature row in `conformance/parity/features.json` names this package.

## Read first

- `AGENTS.md` (always).
- The CC-23L plan §6-§10 (`plans/CC-23L.md`)
- `docs/security/WIRE-CONTRACT-V5.md` §15.12

## Acceptance criteria

- [ ] Every slice in the plan's §10 table is merged; `pnpm gen corpus --check`, `pnpm gen parity --check` and the SDK suites for `connect.local` pass.
- [ ] Branches are `wp/CC-29.<n>-local-links`; ★ slices run in plan mode.

## Hand-off

The role agent sets `--set CC-29 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set CC-29 done`.

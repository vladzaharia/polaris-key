# P0-46 Lint baselines with debt ledgers

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on)) |
| Size        | 1–1.5 engineer-weeks                                                                                                  |
| Depends on  | [P0-43](P0-43-ci-consolidation.md)                                                                                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | none beyond the green gate                                                                                            |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

## Goal

Lint baselines with debt ledgers, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-05** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md), for **CQT-05**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- knip and jscpd (TS), ruff and mypy (Python), ktlint and detekt (Kotlin), swift-format lint, gdlint; committed debt ledgers; report-only first, then blocking on new code.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-05**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [x] Each language has a committed baseline
- [x] New code is blocked on new findings
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-46 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-46 done`.

## Corrections (2026-10-24)

From the approved plan (§0 L1–L6, decisions D-L1–D-L7):

- **L1.** No language linter existed before this package: no knip or jscpd config, no ruff, mypy only in the docs snippet lane, no ktlint or detekt, no `.swift-format`, no gdtoolkit.
- **L2.** The ledger is not report-only (D-L2): a new finding fails from the first commit, and a recorded finding the tool no longer reports fails too, so ledgers only shrink. The docs (`lint-debt.json`) and UI-kit (`kit-debt.json`) ledgers already had these semantics in other shapes.
- **L3.** Each lane is a plain-Node first step with no pnpm install, as `kit-lint.mjs` is.
- **L4.** Tool availability: `swift format` ships with the toolchain and cannot be pinned apart from Xcode; ruff and gdlint come from pip, ktlint and detekt from checksum-verified jars (detekt 1.23's Gradle plugin targets Kotlin 2.0, the repo is on 2.1.21, so the CLI jars are used, D-L7).
- **L5.** The Verify section above is boilerplate: this package does not touch the CLI. The tests that cover it are `pnpm exec vitest run tools/lint tools/gate.test.ts tools/agents-md.test.ts`, plus each lane's `check` (`pnpm lint:ts`, `sdks/<lang>/tools/lint.sh check`).
- **L6.** Generated files are not linted: the registry's `outputs` (`tools/generators.ts`) are the exclusion list.
- **Rule set.** Ruff selects `E, F, W, B, I` at 120 columns (`sdks/python/pyproject.toml`), not ruff's defaults, and mypy checks `src/polaris_key` with `platform = "linux"`.

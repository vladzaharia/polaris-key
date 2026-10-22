# SP-52b Swift iOS app footprint: at least 25% smaller than 0.8.33

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.2–0.4 engineer-weeks                                                             |
| Depends on  | [SP-52](SP-52-swift-package-footprint.md)                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | `ci:macos`                                                                         |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Split 2026-10-22 (triage)

Filed from [SP-52](SP-52-swift-package-footprint.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 1–2 days). SP-52 carries what is on staging; this package carries the rest.

On staging already: SP-52 on staging: registry archive under 6 MB, two fonts, vendored `libzstd`, `check-resolve-clones.sh`, the report-only `apple-footprint` job.

## Goal

Swift iOS app footprint: at least 25% smaller than 0.8.33. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [SP-52](SP-52-swift-package-footprint.md), its Progress and Split notes.

## Scope

**In:**

- The one unmet criterion of SP-52: a Release arm64 iOS app with the kit and `decide()` is at least 25% smaller than at 0.8.33. Today it is +7.7% (3,348,956 B against 3,109,960 B, CI run 39571880256). When the target holds, `apple-footprint` stops being report-only. Nothing in the graph needs this to land (SP-62 does not).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything SP-52 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `measure-ios-footprint.sh` shows at least 25% smaller than the `v0.8.33` baseline in CI
- [ ] `apple-footprint` runs as a required, non-`continue-on-error` job
- [ ] The archive stays under 6 MB; `swift package resolve` still clones only Sparkle
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-52b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-52b done`.

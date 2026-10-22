# A-19b Channel labels from the catalogue everywhere, the store-name literal lint, the per-channel docs check

| Field       | Value                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Phase       | A: Distribution channels and store provisioning (DX consolidation H: Distribution channels, storefronts and commerce) |
| Size        | 0.1–0.15 engineer-weeks                                                                                               |
| Depends on  | [A-19](A-19-one-channel-catalogue-tools-channels.md)                                                                  |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                |
| Role        | `pkey-implementer`                                                                                                    |
| Plan mode   | no                                                                                                                    |
| Gates       | none beyond the green gate                                                                                            |
| Human input | none                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                             |

## Split 2026-10-22 (triage)

Filed from [A-19](A-19-one-channel-catalogue-tools-channels.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 3–5 h). A-19 carries what is on staging; this package carries the rest.

On staging already: A-19 on staging (76350fa74): `tools/channels.json`, `tools/gen-channels.ts`, `channels.generated.ts`, `reference/channels`, the two-way conformance test and the `channels` generator family.

## Goal

Channel labels from the catalogue everywhere, the store-name literal lint, the per-channel docs check. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [A-19](A-19-one-channel-catalogue-tools-channels.md), its Progress and Split notes.

## Scope

**In:**

- The remainder of A-19: migrate every label table onto `findChannel` / `channelLabel` (`packages/admin` `lib/labels.ts`, storefronts `data.ts` and about 10 admin files with store-name literals; the worker and CLI readers), add the lint that refuses store-label literals elsewhere, and check the per-channel docs pages against the catalogue. It touches the same admin files as A-22: run it before or alongside A-22.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything A-19 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `channelLabel` is the only source of store labels in admin, worker and CLI (the label tables are deleted)
- [ ] A lint refuses store-name literals outside `tools/channels.json` and the generated copies
- [ ] The per-channel `features/ship-builds/channels/*` pages are checked against the catalogue (a failing check on drift)
- [ ] `pnpm gen --check` and the two-way conformance test still pass
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set A-19b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set A-19b done`.

# DOC-08a SDK quickstarts

| Field       | Value                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Developers: SDKs and kits) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                           |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                     |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                           |
| Role        | `pkey-implementer`                                                                                                               |
| Plan mode   | no                                                                                                                               |
| Gates       | `docs-generated`, `docs-links`                                                                                                   |
| Human input | none                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                        |

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- Quickstarts fork App · Server · CLI.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The fresh-reader run may use AX-05's harness (suite `first-product`).

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-08a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Both lanes in all six quickstarts; the docs-snippets targets in each SDK (§4); `build/sdks/*`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/sdk-node`, `packages/sdk-react`, `sdks/{python,swift,kotlin,godot}`; `examples/*`; `conformance/parity/features.json`

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [x] The common definition of done in the docs plan §6.3 holds (with the exceptions below).
- [ ] No hand-written SDK fence remains.
- [ ] Each snippet target compiles in its SDK lane.
- [ ] Joins DOC-07a's fresh-reader run.
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Corrections and notes (2026-10-16)

- The six quickstarts are now numbered, install through `<InstallSteps>`, and show both lanes through `<Lanes>`. They are `.mdx` so they can import the components; `test/snippets/covered.ts` follows the rename.
- **Not met, waiting on SP-33a/SP-33b:** no hand-written SDK fence remains, and each SDK's docs-snippets target compiles. `<Generated>` throws until SP-33's `renderUsage` exists, and no `docs-snippets` target exists in any SDK. This package wrote no new SDK snippet: the fences that remain are the ones SP-45b compiled in the covered lanes, and the library lane links to each SDK's own-UI page instead of showing a call. SP-33b replaces each fence with `<Generated>` or `<Snippet>` and adds the six targets.
- The SDK overview's sub-client and verb table is still hand-written; the generated one waits on SP-35 (`api-names`). The old claim "Distribution has no sub-client" was false (`client.distribution` and `client.commerce` exist in Node) and is fixed.
- The fresh-reader run (DOC-07a's harness) has not been run on these pages.
- Unbuilt-behaviour lines ("planned", "is planned") are removed from the quickstarts.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-08a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-08a done`.

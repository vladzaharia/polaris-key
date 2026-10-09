# DOC-07a Start path

| Field       | Value                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Developers: start and build) |
| Size        | 0.4–0.6 engineer-weeks                                                                                                             |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md), [ST-37](ST-37-vocabulary-one-word-concept-rule-4.md)                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                             |
| Role        | `pkey-implementer`                                                                                                                 |
| Plan mode   | no                                                                                                                                 |
| Gates       | `docs-generated`, `docs-links`                                                                                                     |
| Human input | none                                                                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                                                                          |

## Owner decision (2026-10-08): public developer docs

The developer sections (`start/`, `build/`, `features/`, `reference/`) are public (owner decision, 2026-10-08; [docs plan](../../../2026-10-08-docs/README.md) D2). Operate → Console stays member-only; Operate → Platform, Contribute and the runbook stay admin-only. Where the text below assumes members-only developer pages, this wins.

- The landing copy labels only the Operate card "For console members"; the start path is public.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The fresh-reader run may use AX-05's harness (suite `first-product`).

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-07a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Landing copy (`index.mdx` content); `start/index`, `first-product` (interim), `choose-your-integration`, `how-it-works` (with the coherence-rule table), `concepts`; `build/install`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`packages/cli/src/{help,sdkConfig,feedSetup}.ts`; the console's New product, Services, Licenses and Devices pages; `shared-manifest` and `core/services.ts` (both validators, for the table); `engines` (≥ 22.13.0); `sdk.docs-first-product`; the SP-37 scope

## Design notes

- Writes the 0.9.x interim path on today's console and CLI; SP-37 writes the final path after the wizard (§3.5). `concepts` waits for ST-37's word table.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] The **fresh-reader run** (§6.2) on Node and Swift.
- [ ] Install steps rendered from `feedsSetup()`.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] `pkey-wp-reviewer` passes the package.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

The role agent sets `--set DOC-07a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-07a done`.

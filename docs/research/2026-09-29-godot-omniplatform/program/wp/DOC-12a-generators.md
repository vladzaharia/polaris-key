# DOC-12a Generators

| Field       | Value                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Reference and contribute) |
| Size        | 0.6 engineer-weeks                                                                                                              |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md), [DOC-05a](DOC-05a-help-messages.md)                                               |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-10](AX-10-sdk-skills-should-tier.md)                                                |
| Role        | `pkey-implementer`                                                                                                              |
| Plan mode   | no                                                                                                                              |
| Gates       | `drift-gate`, `docs-generated`, `docs-links`                                                                                    |
| Human input | none                                                                                                                            |
| Repo        | `vladzaharia/polaris-key`                                                                                                       |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-12a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Error codes (the Help column after DOC-05a); CLI; GitHub Action; the changelog collection and views with `replaces`; **Upgrade to 0.9** and its table; compatibility; validation codes, settings, parity, routes and config entry kept current; the removed-names lint (on at SP-35)

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`scripts/gen-reference.mjs`; `conformance/parity/{errors,copy.en}.json`; OpenAPI; `help.ts`; `action.yml`; AGENTS.md rule 3; the P0-42 and SP-37 scopes

## Design notes

- The error-code Help column waits for DOC-05a's message map; the rest does not. The developer changelog generator lives here, so v0.9.0 ships its break list (§10 amendment 5).
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [x] The common definition of done in the docs plan §6.3 holds.
- [x] Every new generator has `--check` and a byte-compare test.
- [ ] `pkey-wp-reviewer` passes the package.
- [x] The green gate passes (scoped: docs lint, build, check:links; CI runs the rest) (`AGENTS.md`), including every drift gate in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/docs build
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs test
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Corrections (2026-10-24)

- **G1.** Done, generated and gated: `reference/{cli,validation-codes,config-entry,routes,parity,settings,channels}.mdx` (`cli-reference`, `docs-reference`, `settings`, `channels`). The last slice confirms each is live.
- **G2.** This package owns three stubs: `reference/github-action.md`, `reference/changelog/index.md`, `reference/compatibility.md`. No page is generated from `action.yml`.
- **G3.** There was no changelog machinery: no collection, and `build/upgrade-to-0-9.md` was hand-written. Entries are `packages/docs/changelog/*.md`, read by `gen-reference.mjs` (decision D-D2); the page and the upgrade tables are generated. Per-feature and per-SDK views wait for a P2 package (D-D1).
- **G4.** The error-code page has no Help column (`scripts/gen-reference.mjs`); DOC-05a's map is `packages/docs/help-messages.json`, read through `helpMessageUrl`.
- **G5.** The removed-names lint has half a source: `conformance/parity/api.json` `removed` rows carry `scan` patterns, scanned only in SDK sources by `tools/api-check.ts` rule 2. `lint-docs.ts` has no such rule and `lint-debt.json` is empty.
- **G6.** SDK versions are lockstep, derived from the tag (`tools/sdk-version.mjs`); every in-tree version file is `0.0.0`. The compatibility page states the rule and the toolchain floors, not a version table.

## Hand-off

The role agent sets `--set DOC-12a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-12a done`.

## DOC-12a.4 note

The `removed-name` rule in `packages/docs/scripts/lint-docs.ts` reads the changelog's `replaces[].old` code spans (plain lowercase words match in code only), `api.json` `removed` rows (`scan.pattern`, else the qualified name; `fence:` file hints are not honoured, any code matches) and the validator's "X is removed" messages. Exempt: `build/upgrade-to-0-9`, `reference/changelog/index`. Debt: 7 hits on 4 pages. G1 confirmed: all seven reference pages plus github-action, compatibility and changelog are live, generated, not stubs.

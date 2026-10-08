# DOC-03a Skeleton and contracts

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (skeleton and access)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Size        | 0.4–0.6 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Depends on  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-02a](DOC-02a-shared-components.md), [DOC-03b](DOC-03b-public-access.md), [DOC-04a](DOC-04a-help-get-started.md), [DOC-04b](DOC-04b-help-sign-in-and-account.md), [DOC-05a](DOC-05a-help-messages.md), [DOC-05b](DOC-05b-help-library-and-devices.md), [DOC-05c](DOC-05c-help-downloads-updates-purchases.md), [DOC-07a](DOC-07a-start-path.md), [DOC-07b](DOC-07b-build-basics.md), [DOC-08a](DOC-08a-sdk-quickstarts.md), [DOC-08b](DOC-08b-ui-kits-and-web-apps.md), [DOC-09a](DOC-09a-licensing.md), [DOC-09b](DOC-09b-sign-in.md), [DOC-09c](DOC-09c-managed-config-and-cloud-sync.md), [DOC-10a](DOC-10a-releases-and-updates.md), [DOC-10b](DOC-10b-channels.md), [DOC-10c](DOC-10c-packages-and-packs.md), [DOC-11a](DOC-11a-operate-console.md), [DOC-11b](DOC-11b-operate-platform.md), [DOC-12a](DOC-12a-generators.md), [DOC-12b](DOC-12b-reference-and-contribute.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Gates       | `docs-generated`, `docs-links`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-03a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** Door directories and the sidebar data (§3.2); `src/lib/features.ts`; every move, split, merge and delete in §5, with every redirect; stubs (`status: "stub"`: hidden from the sidebar, search and sitemap, planned anchors as headings, a one-line pointer to the nearest live page); `nav.ts` and `docsLinks.ts` targets per the door rule, plus `nav-docs-targets.test.ts`; the frontmatter schema; the MDX components with final props, unstyled (§8.3, `PortalShot` and `InstallSteps` included); the `help-messages.json` schema and id format (§7.1); the lints (type skeletons, programme ids, counts, future tense, Help words, `pkey` commands, HTTP paths) with `lint-debt.json`; anchors and frontmatter in the slug manifest; AGENTS.md rule 4 (product and app, style guide §4) and "Where docs live"

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`astro.config.mjs`, `src/content.config.ts`, `scripts/*`, `services.test.ts`, `docsLinks.ts`, `nav.ts`, `docsLinks.test.ts`, `tools/services.json`; AGENTS.md

## Design notes

- Lands first and ships the contracts every other DOC package needs: every target path (moved content or a hidden stub with its planned anchors), every redirect, the frontmatter schema, the MDX components with their final props (unstyled), the `help-messages.json` schema and id format, and every lint with its debt ledger (§6.1). No writing package carries a mechanical move.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] A test walks §5 and finds a redirect for every old path.
- [ ] No page's text changes except merge appends.
- [ ] The lints run site-wide and today's hits are in the ledger.
- [ ] `docsLinks.test.ts` and `check:links` pass.
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

The role agent sets `--set DOC-03a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-03a done`.

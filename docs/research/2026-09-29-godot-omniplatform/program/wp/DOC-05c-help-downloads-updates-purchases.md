# DOC-05c Help: downloads, updates, purchases

| Field       | Value                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Help)                  |
| Size        | 0.3 engineer-weeks                                                                                                           |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                 |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md) |
| Role        | `pkey-implementer`                                                                                                           |
| Plan mode   | no                                                                                                                           |
| Gates       | `docs-generated`, `docs-links`                                                                                               |
| Human input | none                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                    |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-05c (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `download`, `check-a-download`, `install-sources`, `update`, `restore-purchase`, `refunds`

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`portal/downloads.ts`; `distribution/page/render.ts`; store origins; the kits' update screens

## Correction (verified 2026-10-11)

The named sources are `packages/worker/src/services/identity/portal/downloads.ts` and the portal's Get it panel, download flow and library quick action; the public page (`distribution/page/render.ts`, `model.ts`); the kits' update screens (`ui-core` `models/update.ts` and `models/gate.ts`, the kit-copy `update.*` and `boot.*` lines, `ui-matrix.json` and `update-matrix.json`); and, for store origins, `model.ts` `storeLink`, `customer.ts` and the commerce service. Where the code disagrees with the legacy pages or the plan, the pages follow the code:

- The legacy `download` page told readers to check an Android file against the Android app signing certificate. The key inventory also holds a separate sideload certificate for sideloaded and Obtainium APKs (`features/ship-builds/channels/availability.md` key table, `render.ts` `KEY_LABELS`), so `check-a-download` names both and says which file each one checks.
- The legacy `download` page stated platform facts that no shipped source states: the free Apple ID refresh and app limits, the AltStore PAL regions and notarization, `scoop update`. They are removed. The legacy `update` page's channel and Sparkle text is removed too: beta access is written in the package that ships it (P2-08), and the updater's name is a developer word.
- Linking Steam: Discover's `store_owned` path ("You own it on Steam") is not built (`identity/portal/store/obtain.ts`, `identity/portal/discover.ts`: "until then no engine source offers them"). `restore-purchase` sends Steam buyers to **Connect** under **Sign-in methods**, the library's own **Missing a license?** advice (`MissingLicense.tsx`).
- Refunds: no code writes a license-level refund yet (`core/licensing/lifecycle.ts`: "Nothing writes a reversal through this module yet"). What ships is a store refund removing the purchase's unlock (`commerce.md`, `distribution/commerce/recheck.ts`) and a developer's Disable, which the portal shows as **Suspended**. `refunds` describes only that.
- The old updates URL `/docs/users/updates/#the-download-page` is still linked from `help/messages/index.md` (DOC-05a's page), so `update` keeps that anchor until the link goes.

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] As DOC-05b.
- [ ] `pkey-ux-reviewer` passes the rendered pages in built mode, both themes and phone (§6.3).
- [ ] A plain-language critic (a fresh subagent with no repo context, reading as someone who never chose Polaris Key) finds nothing blocking, citing `page#anchor` for each finding (§6.3).
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

The role agent sets `--set DOC-05c in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-05c done`.

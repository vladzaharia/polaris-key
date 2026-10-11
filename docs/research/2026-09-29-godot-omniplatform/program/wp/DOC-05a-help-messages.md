# DOC-05a Help: messages

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (Help)                                                    |
| Size        | 0.4 engineer-weeks                                                                                                                                             |
| Depends on  | [DOC-03a](DOC-03a-skeleton-and-contracts.md)                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [DOC-06a](DOC-06a-portal-entry-points.md), [DOC-06b](DOC-06b-worker-entry-points.md), [DOC-12a](DOC-12a-generators.md) |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `docs-generated`, `docs-links`                                                                                                                                 |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-05a (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.
- [`style-guide.md`](../../../2026-10-08-docs/style-guide.md): the only home for writing rules.

## Scope

**In:** `help-messages.json` filled; `<HelpMessage>` renders catalog titles and indexes the translated titles as aliases; `helpMessages.test.ts`; the message pages (§7.1)

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`conformance/parity/copy.*.json`; the portal's `errors.ts`; `components.json`

## Design notes

- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Screen acceptance (brand transition, 2026-10-09)

N/A: no screen or state ships in this package (selected by the overview-04 rule on its gate or mention only).

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [ ] Every catalog key and portal error is in exactly one entry or the developer-only list.
- [ ] Titles render from the catalog.
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

The role agent sets `--set DOC-05a in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-05a done`.

## Correction (2026-10-11)

The code differs from the brief and the plan in these ways; the pages and the map follow the code.

- **The catalog is bigger than the plan's table.** `conformance/parity/copy.en.json` holds 184 ids (`fallback`, 160 `codes`, 9 `gate`, 14 `activation`) and 108 distinct titles. Plan §7.1 lists about 70 of them and ends "…". Every id now has one home: 106 entries across the seven pages (174 ids) plus a developer-only list of 21 ids under 12 titles. Titles the plan does not name sit where their cause belongs (for example "Activate" and "Activated" under the license key, "License active" and "No license needed" under the license status, "Storage problem" and "Not available here" under Other).
- **The portal's `errors.ts` has no catalog ids.** It words four download refusals, the step-up code, five HTTP statuses and a default itself. They are mirrored in the new optional `portal` section of `help-messages.json` and addressed as `portal.<key>` (the id grammar and the schema grow by that one group; the shape of `messages` is unchanged). `helpMessages.test.ts` reads `errors.ts` and fails when the mirror and the file disagree, or when an error has no entry.
- **Two codes the Worker does not answer today.** `license_expired` (an expired license's key is answered `401 unauthorized`: `packages/worker/test/transcripts/scenarios/license.ts:12-15`, `core/licensing/authz.ts:420-421`) and `activation.attestation-required` (activation is not a trust operation: `scenarios/license.ts:16-19`). Their entries say what the catalog title means; the Worker does not produce them yet.
- **Copy fix filed: "Sign-in cancelled".** The catalog's `codes.cancelled` reads "Sign-in cancelled" / "Sign-in was cancelled." against the US spelling rule. The copy fix is "Sign-in canceled" / "Sign-in was canceled." in `copy.en.json`, regenerated into every SDK's copy module by `pnpm gen constants`. It is not made here: it is a catalog change across seven SDKs. The Help title follows the catalog when it changes.
- **`components.json`** was used to check which core copy keys the kits show on screen (it names `core.codes.*`, `core.gate.*` and `core.activation.*` keys per state); no data is taken from it.
- **The scout's lead was off**: it counted about 120 codes; there are 160.
- **Links.** `help/update.md` linked to the removed "Troubleshooting" anchor `#your-version-is-blocked`; it now links to `help/messages/license-status#gate.version-too-old`. DOC-05c rewrites that page.
- **Search.** Starlight's right-hand "On this page" lists only Overview on a messages page, because `<HelpMessage>` renders the headings. A table of contents override can list the entries from `helpEntries()` in `src/lib/helpMessages.ts`.

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

- **The catalog is bigger than the plan's table.** `conformance/parity/copy.en.json` holds 184 ids (`fallback`, 160 `codes`, 9 `gate`, 14 `activation`) and 108 distinct titles. Plan §7.1 lists about 70 of them and ends "…". Every id now has one home: 108 entries across the seven pages (180 ids) plus a developer-only list of 15 ids under 10 titles. Titles the plan does not name sit where their cause belongs (for example "Activate" and "Activated" under the license key, "License active" and "No license needed" under the license status, "Storage problem" and "Not available here" under Other).
- **The portal's `errors.ts` has no catalog ids.** It words four download refusals, the step-up code, five HTTP statuses and a default itself. They are mirrored in the new optional `portal` section of `help-messages.json` and addressed as `portal.<key>` (the id grammar and the schema grow by that one group; the shape of `messages` is unchanged). `helpMessages.test.ts` reads `errors.ts` and fails when the mirror and the file disagree, or when an error has no entry.
- **Two codes the Worker does not answer today.** `license_expired` (an expired license's key is answered `401 unauthorized`: `packages/worker/test/transcripts/scenarios/license.ts:12-15`, `core/licensing/authz.ts:420-421`) and `activation.attestation-required` (activation is not a trust operation: `scenarios/license.ts:16-19`). Their entries say what the catalog title means; the Worker does not produce them yet.
- **Copy fix filed: "Sign-in cancelled".** The catalog's `codes.cancelled` reads "Sign-in cancelled" / "Sign-in was cancelled." against the US spelling rule. The copy fix is "Sign-in canceled" / "Sign-in was canceled." in `copy.en.json`, regenerated by `pnpm gen constants` into the six core copy modules (`COPY_TARGETS` in `tools/gen-sdk-constants.ts`: Node, React, Python, Swift, Godot, Kotlin) and the brand kit copy. The hosted sign-in card (`packages/worker/src/services/identity/oidc.ts`) words it too. It is not made here: it is a catalog change across those surfaces. The Help title follows the catalog when it changes.
- **`components.json`** was used to check which core copy keys the kits show on screen (it names `core.codes.*`, `core.gate.*` and `core.activation.*` keys per state); no data is taken from it.
- **The scout's lead was off**: it counted about 120 codes; there are 160.
- **Links.** `help/update.md` linked to the removed "Troubleshooting" anchor `#your-version-is-blocked`; it now links to `help/messages/license-status#gate.version-too-old`. DOC-05c rewrites that page.
- **Search.** Starlight's right-hand "On this page" lists only Overview on a messages page, because `<HelpMessage>` renders the headings. A table of contents override can list the entries from `helpEntries()` in `src/lib/helpMessages.ts`.
- **The developer-only list holds what nobody can act on.** `value_not_representable` joined it: only the console's write paths answer it (`core/console/writeChecks.ts`, `core/console/overrides.ts`), so no app screen asks a person to change a value. `server-error`, `http-error`, `bad_response`, `invalid-response`, `response-too-large` and `platform-error` left it: a person meets each in normal use, and the catalog message says to try again. A title is one heading, so "Service problem" (with `document_not_representable`, which stays "tell the developer"), "Unexpected answer" and "Platform problem" are entries on Other.
- **Text names only what is built.** No Why or What to do points at joining accounts (PX-15), a new license key (G7), a terms screen (PX-21) or a security-check widget. `email_in_use` and `link_conflict` give the shipped path (sign in with the method used before, then add the email under **Sign-in methods**; connect a different sign-in method), as DOC-04b's join-accounts article does. `step_up_required` names only passkeys and sign-in methods. `terms_required` is a code no shipped screen shows (only the email gate answers it, and its screen, FinishStep, is not built): its entry says what the title means and sends the reader to the app's developer. The portal's sign-in page runs no security-check widget (it sends no `turnstileToken`), so `turnstile_failed` says to ask again, then to choose another sign-in method.
- **Fixes follow what the code does.** A device activated with an activation file holds no device token, and `sync()` makes no call without one (`packages/sdk-node/src/core/sync.ts:5`), so `gate.grace` and `gate.expired` send it to the app's developer for a new file, as DOC-05b does. An unusable license is refused like a bad key (`401 unauthorized`, `core/licensing/authz.ts:116` and `:420-421`), so `gate.revoked` and `unauthorized` add the developer as the next step. In `entitled` delivery mode the library refuses an ended or turned-off license as `not_entitled` (`services/identity/portal/api.ts`, the download link mint), so `portal.not_entitled` and `portal.license_inactive` name it, and neither promises an upgrade or an "offline time". A device with the wrong date fails a feed (`client-core/src/feed.ts:346-354`) and an activation file (`client-core/src/bundle.ts:179-183`): `feed-rejected` and `bundle-claims-rejected` say so. With no `manageUrl` the app's own advice is to sign out on another device (`deviceLimit.noManage`), so `device_limit` names it. `swap-failed` also means a full disk (`sdks/godot/addons/polaris_key/updater/sidecar_swap.gd:230-231`), and `pack-revoked` also means the app can't check (`client-core/src/packs/engine.ts:2181-2201`).
- **Contact.** Every messages page ends "Still stuck?" with a link to [Get help with an app](/docs/help/contact/). That page is DOC-04a's and a stub in this branch: the link resolves, and it is live once that package merges. Library failures (`portal.default`, `portal.status-401`, `-403`, `-429`) point there, not at the app's developer.
- **120 words per entry.** The plan counts an entry, one heading with all its branches (README §2, the Help messages row; style guide §3). `helpMessages.test.ts` counts the title plus each branch's message, Why and What to do, per entry; it counted per branch at first. The activation-file entry (five messages) and "Not available here" (five) needed the shortest texts.
- **Links held for merge.** `device_limit` points at "Manage your devices", not the planned `device-limit` article, because `help/device-limit` is a stub in this branch and the test requires a shipped article. Retarget it when DOC-05b merges. The same holds for `email_unavailable`, `turnstile_failed` and `rate_limited` (`code-didnt-arrive`, DOC-04b), `hardware_mismatch` (`new-computer`), the activation-file ids (`offline-activation`), `gate.*` (`license-status`) and `not_removable` (`remove-from-library`).
- **`cta`.** A message can carry `"cta": "library"`, an "Open your library" link after What to do (`device_limit`, `device_deauthorize_failed`, `not_removable`, `device-management-unsupported`, `portal.status-404`), or `"cta": "contact"`, a "Still need help? Read Get help with an app." line after What to do and More help (`portal.default`, `portal.status-401`, `-403`, `-429`, `sign-out-failed`; the library failures no longer name the page in plain text). Like Why and What to do, it sits on the first id of a branch. The library link goes to the portal root (`/`): the portal is hash-routed and the Worker serves its shell for `/`, `/index.html`, `/activate` and `/assets/` only, so `PortalLink` maps `library` to `/` and any other page to `/#/<page>` (`src/lib/portalHref.ts`).

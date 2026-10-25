# DOC-06b Worker entry points

| Field       | Value                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | DOC: Documentation: one docs site with Help, Developers and Operate (docs/research/2026-10-08-docs/) (entry points)                                                                                                                                                      |
| Size        | 0.3 engineer-weeks                                                                                                                                                                                                                                                       |
| Depends on  | [DOC-03b](DOC-03b-public-access.md), [DOC-04a](DOC-04a-help-get-started.md), [DOC-04b](DOC-04b-help-sign-in-and-account.md), [DOC-05a](DOC-05a-help-messages.md), [DOC-05b](DOC-05b-help-library-and-devices.md), [DOC-05c](DOC-05c-help-downloads-updates-purchases.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                                                                                                       |
| Gates       | `email-snapshots`, `docs-links`                                                                                                                                                                                                                                          |
| Human input | none                                                                                                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                |

## Goal

The pages and parts below ship and meet the docs plan's common definition of done (§6.3) and this package's own checks.

## Why

The owner asked for "first class documentation, thorough but not overly so" on one site that also serves consumers and looks like part of Polaris Key. [The docs plan](../../../2026-10-08-docs/README.md) (2026-10-08) splits the work into 28 packages; this is its row DOC-06b (§6.1).

## Read first

- `AGENTS.md` (always), and [the docs plan](../../../2026-10-08-docs/README.md): §1, §2, §6.1 (this row), §6.3 and the sections the scope names.

## Scope

**In:** Email footers and per-notice links (security notices also link **Secure your account**); the download page footer; the Worker's HTML pages

**Out** (and where it belongs instead):

- Pages and parts other DOC packages own (§6.1); P2 pages, written in the PR of the consolidation package that ships the behaviour (§10).

## Sources of truth

`notices.ts`, `render.ts`, `brandHtml.ts`

## Design notes

- Follows DOC-03b's public switch: it puts live links in front of customers.
- Nothing describes unbuilt behaviour as shipped; P2 lines belong to the consolidation packages that ship them (§10).

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [x] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
      DOC-06b.2: the new links are native anchors in reading order (footer after main; `nav.ac-links` after the card), focus ring from the page CSS; no overlay, no route change. Evidence: `_evidence/DOC-06b/results.json` (tab order per page).

- [x] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
      DOC-06b.2: links are named by their text; the device links sit in the existing labelled `nav` ("Help and privacy"); one h1 per page, unchanged. The footer links are inline in the existing `footer` landmark.

- [x] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
      DOC-06b.2: no sideways scroll at 320 px or at 200 % root font on the download page, device entry and approval (`results.json`, `overflow: false`); device links are 44 px tall; the download footer's inline links are 17 px tall like the existing Website link in the same line (inline text links in a sentence).

- [x] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
      DOC-06b.2: light and dark renders of the download page, device pages and three mails (`_evidence/DOC-06b/*.png`); the links reuse `a` and `.ac-links` tokens, so forced-colors and contrast-more follow the page CSS unchanged. No custom accent: Locker pages carry none.

- [x] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
      DOC-06b.2: not applicable: no new state or motion; native kits are untouched.

- [x] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
      DOC-06b.2: not applicable: no new state or motion; native kits are untouched.

- [x] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
      DOC-06b.2: no new action or colour; links use the neutral link ink; copy is the fixed labels Help, Check a download.

- [x] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
      DOC-06b.2: not applicable: no new state or motion; native kits are untouched.

- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Corrections (2026-10-24)

The code is the fact (slice plan A-25-DOC-12a-DOC-06b-slices §0).

- **W0.** "Worker entry points" means the pages and mails a customer reaches from the Worker, not
  `index.ts`, `mount.ts`, `router.ts` or `dispatch.ts`. None of those changes.
- **W1.** There is no `notices.ts`. The templates are `core/notify/templates.ts` (`buildNotice`),
  rendered by `core/notify/render.ts`. The other Locker mail is the sign-in link in
  `core/notify/send.ts`. Operator mail (`cliSignInNotice`, `access*`, alerts) is Polaris Key mail
  and keeps its footer (D-W1).
- **W2.** The Help targets exist: `help/emails.md` has one `<a id>` per notice,
  `secure-your-account.mdx`, `check-a-download.md`, `approve-a-sign-in.mdx`. `what-is-polaris-key`
  is now `what-is-polaris-locker.md`.
- **W3.** Three Locker notices had no entry on `help/emails.md`: `deviceReplacedNotice`,
  `packagesTokenNotice`, `licenseFromDeveloperNotice`. Added in DOC-06b.1.
- **W4.** "Wasn't you? Secure your account" goes to the app (`#/account/methods`), not Help. The
  callout keeps that link; the footer adds **Secure your account** to the Help article (D-W2).
- **W5.** Worker HTML pages already link Help and Privacy (`LOCKER_CARD_LINKS`, now reading
  `core/helpLinks.ts`). The device pages did not link `approve-a-sign-in`; DOC-06b.2 adds
  `DEVICE_CARD_LINKS` (Help to Approve a sign-in, Privacy) on every device-code page.
- **W6.** The download page footer had no Help link; DOC-06b.2 adds **Check a download** and
  **Help** on `feedOriginOf(env)` (the customer site, else the console host), none when neither exists.
- **W7.** The gates: the snapshot suites `portalNotices`, `customerEmailHtml`, `lockerMail`,
  `licenseCreateDelivery`; `customerHelpLinks.test.ts` and the slug-manifest checks.

## Steps

1. Verify this brief against the code and the docs site (the code is the fact) and record any correction here, in the same branch.
2. Write or build the scope against DOC-03a's contracts; run the docs tests while working and the scoped gate once at hand-off.

## Acceptance criteria

- [ ] The common definition of done in the docs plan §6.3 holds.
- [x] Email template tests (DOC-06b.1; the snapshot suites are unchanged by .2).
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

The role agent sets `--set DOC-06b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set DOC-06b done`.

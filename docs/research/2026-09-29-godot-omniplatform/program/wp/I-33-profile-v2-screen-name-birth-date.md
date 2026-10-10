# I-33 Profile v2: screen name, birth date, platform terms

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity) |
| Size        | 0.8–1.2 engineer-weeks                                                                            |
| Depends on  | [I-27](I-27-plan-identity-consolidation.md)                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-21](PX-21-email-gate-ui.md)                           |
| Role        | `pkey-implementer`                                                                                |
| Plan mode   | no                                                                                                |
| Gates       | `migration`, `table-owners`                                                                       |
| Human input | none                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-08** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: §2.4: the birth date accepted from the gate record only; terms URLs, with privacy linked and not accepted; one `ALTER` per file. Acceptance (Q2): terms acceptance is recorded for every new account once `identity.platformTerms` is set; none is shown or recorded while it is unset.

## Corrections from the code (2026-10-09)

Checked against `integ/ux-docs` at `ffefd94f5`. The code is the fact; these narrow how the scope
lands, not what it is.

- **The FinishStep UI is PX-21's.** `plans/I-27.md` §2.4: "the API in I-33, the UI in PX-21". The
  portal SPA renders no gate step today (`SignInPage.tsx` has none). This package builds the one
  finish API (`card/gate.ts`, both new-account paths) and the portal's Account → Profile; the
  `identity.finish` and `hosted:finish-email-gate` mockup items stay with PX-21 for the screen.
  `identity.app-sign-in`'s Terms card is I-29's page, over I-09's `identity.terms`.
- **Copy keys.** The catalog's `signin.register.*` has no name key (title, verified, submit; no
  kit draws a RegisterStep), and the portal does not read the catalog yet (UK-02a): its profile
  copy is `portal/copy/profile.ts`. "Screen name" lands in `profile.name.label`; FinishStep's
  catalog keys come with PX-21's UI. SIGN-IN.md and PORTAL.md say "Screen name".
- **No connection exists yet (I-30).** A connection's `birthdate` claim enters through
  `ProviderSignIn.connection` (`{id, label, birthdate}`), the seam I-30's connection client fills.
  The platform IdP's `/callback` (until I-30) and the legacy product callback (until I-32b) still
  create accounts outside the gate, so publishing `identity.platformTerms` waits for them and for
  PX-21 (RUNBOOK "Publish Polaris Key's terms").
- **`identity.terms` is I-09's.** Product terms URLs resolve through `productTerms()` and the
  `delivery` hook's new `legalUrls` (the listing model's `eulaUrl`, `privacyUrl`); the front door
  that passes a product's terms (I-08) calls it.
- **The email path asks only when there is something to ask.** A new address finishes through the
  gate while `identity.platformTerms` is set; otherwise it is created at the code as before, so the
  live card keeps working until PX-21 renders the step (PX-21 then makes it unconditional).
- **Existing accounts** are not asked to accept a new Polaris Key terms version (Q2's acceptance
  covers new accounts); re-acceptance is a later owner decision.
- **Docs.** The docs site has no `features/`, `operate/` or `help/` tree yet (the 2026-10-08 docs
  plan's batches): this package updates today's pages for the same readers
  (`users/portal.md`, `users/privacy.mdx` through `docs/PRIVACY.md`,
  `services/identity/portal.md`, `admin/platform-settings.md`). The React cookie note belongs to
  SP-40, which removes cookie mode.

## Goal

Profile v2: screen name, birth date, platform terms, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-08** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.3, for **IX-08**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.

## Scope

**In:**

- accounts.birthdate and `birthdate_source`, optional, imported from a connection's birthdate claim and overridable; apps never receive it, and age booleans (and any minimumAge) wait until a product gates content; 'Screen name' with per-source suggestions (`signin.register.*`, `portal.profile.*`); one finish API for both new-account paths (I/card/gate.ts state machine extended); Polaris Key terms and privacy accepted as `_platform` rows with a platform version setting; product terms URLs from the listing's eulaUrl and privacyUrl; PRIVACY.md birth-date minimisation.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-08**; DX consolidation F: Identity.
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [x] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
      **I-33:** the birth date sits in reading order (name, picture, birth date, Save); Remove birth date moves focus to the field it emptied; a refused save focuses the field; no overlay, no route change (unit and e2e tests).
- [x] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
      **I-33:** the field's label, "Optional", and its hint and error linked through `aria-describedby`; the error is `role=alert`; one h1 (quality states); no icon-only control added.
- [x] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
      **I-33:** 1440, 390 and 320 px: no sideways scroll, no small target, axe clean (states `account-profile-edit`, `account-profile-birthdate`). At 200 % text the Account section strip overflows 19 px with or without this field (pre-existing, the Account page's owner).
- [x] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
      **I-33:** dark and light, forced-colors and `prefers-contrast: more` rendered; axe colour contrast clean in both themes; the native date picker follows `color-scheme`. Product accent: n/a (the account page has no product context); reduced transparency: n/a (nothing translucent added).
- [x] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
      **I-33:** none (no card line, empty field), set ("Born February 28, 1987"), saved, removed, and the Worker's `invalid_birthdate` on the field with the input kept; loading and load error are the card's existing ones; the API sends no `expectedVersion`.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
      **I-33:** no motion added. The field's error line is inserted under the field and moves the hint, as the editor's name and picture errors already do: an editor-wide change, left to the Profile editor's owner.
- [x] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
      **I-33:** no new primary or colour; terse copy, each fact once ("Private to you. Apps never receive it."). Profile copy lives in `portal/copy/profile.ts`: the portal does not read the catalog yet (UK-02a). The editor's existing Save button keeps its accent fill (pre-existing).
- [x] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
      **I-33:** n/a: no kit screen (FinishStep's screen is PX-21's).
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).
      **I-33:** the lead's reviewer step.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 3 mockup item(s):** `identity.app-sign-in`, `identity.finish`, `hosted:finish-email-gate`.

## Acceptance criteria

- [x] Apps never receive a birth date (test)
      **Tests:** `test/accountBirthdate.test.ts` (every transcript and its Godot mirror; a source test that allows the name only in the profile, FinishStep and lifecycle files; no link, audit row, mail or log line), `test/consoleUsers.test.ts` (Users list, search, row, export, events, licences, devices, Activity, with every claim consented), `test/accountsPrivacy.test.ts` (device routes and the signed licence document).
- [x] Platform terms acceptance recorded for every new account
      **Per Q2:** none shown or recorded while `identity.platformTerms` is unset; once set, both gate paths (a provider's first sign-in, a new address's email code) record the `_platform` row in the batch that creates the account (`test/platformTerms.test.ts`). The platform IdP's `/callback` (I-30) and the legacy product callback (I-32b) still create accounts outside the gate, so publishing waits for them (RUNBOOK).
- [x] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
      **I-33:** today's pages for the same readers (see Corrections): `users/portal.md`, `docs/PRIVACY.md` (shown at `users/privacy`), `services/identity/portal.md`, `admin/platform-settings.md`. The React cookie note is SP-40's.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-33 done`.

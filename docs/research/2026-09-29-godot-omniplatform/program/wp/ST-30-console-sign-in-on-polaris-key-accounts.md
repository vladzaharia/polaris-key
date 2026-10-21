# ST-30 Console sign-in on Polaris Key accounts

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity)                                 |
| Size        | 1.2–1.8 engineer-weeks                                                                                                                                   |
| Depends on  | [ST-29](ST-29-admin-route-table-can-usecan.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [P0-21](P0-21-notification-substrate-core-notify.md)        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-31](ST-31-roles-bindings-invites-members-pages.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md) |
| Role        | `pkey-implementer`                                                                                                                                       |
| Plan mode   | no                                                                                                                                                       |
| Gates       | `threat-model`                                                                                                                                           |
| Human input | none                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-03** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- UX rows absorbed (`uxRows` in `backlog-changes.json`): UX-02, UX-42.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: it owns `strong_at`, `asserted_at`, the `consoleSubject` hook, `operatorIssuerAllowed`, SM-1 to SM-5, the console step-up for SM-3(a), the browser-bound flow, cookie v2 with `memberId`, `console.signin`, and break-glass as an explicit link with the exit facts in §2.6. Its membership is root only until ST-31.
- [`plans/I-27.md`](../plans/I-27.md) §12: `SignInFacts`; `connection:<id>` in `amr`; one Pocket ID connection with audience `both`.

## Goal

Console sign-in on Polaris Key accounts, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-03** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **AC-03**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- Absorbs RB-07, IX-06, UX-42 and UX-02: /manage/callback goes through I-05 signIn; console membership is having a binding (ST-31); the admin cookie carries account and session ids (no groups), checked per request with a 30-second cache; the login card in console context for the seeded env Pocket ID console IdP and passkeys (identifier-first routing to an operator's own SSO connection is ST-32's, after I-30); ST-28's strong-method rule; the computed root rule PLATFORM*ADMIN_GROUP -> Superadmin; ADMIN_OIDC*\* as break-glass for at least 30 days, removed only after 14 days with no break-glass sign-in and at least two Superadmins on passkeys (P0-24 ledger); deletes the 'a session carries full platform authority' invariant comment in admin/session.ts and merges only after ST-29 put docs.ts on can(); audit actor becomes the account id with a sub mapping; signed-out and session-ended states; 'My library' and 'Open console' cross-links; account merge, deletion and disable end membership.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-03**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Screen acceptance (brand transition, 2026-10-09)

Done when every row holds for each screen and state this package ships, checked in the real runtime
(not mockups; native kits on device or simulator), with evidence paths in the PR. A row that cannot
apply says why in one line. One home: EXPERIENCE.md §7.3; kits also follow DL1–DL18.

- [ ] Keyboard: tab order follows reading order; focus always visible (DL9); no trap outside a modal;
      Escape or Cancel backs out of every overlay and step; focus returns to the opener (or the heading
      when it is gone); a route change changes the URL and moves focus to the h1, an inline mutation
      changes neither.
- [ ] Screen readers: landmarks and exactly one h1; every icon-only control named; help and errors
      linked (aria-describedby); one polite announcement per change, none while typing; tables use
      th with scope; status is a word and an icon, never colour alone.
- [ ] Sizing: this surface's UI-KITS §7.1 rows plus 200 % text and 400 % zoom (320 CSS px reflow) with
      no page-level sideways scroll; a dense table scrolls only inside a labelled, focusable region;
      targets ≥ 44 px on customer and touch surfaces, ≥ 24 px with separation in the console.
- [ ] Themes: dark and light; a custom product accent on a light and a dark ground (kits, hosted
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the render (text 4.5:1, UI 3:1) for every state colour in its service accent, both themes.
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state (neutral action ink in console, portal and hosted
      sign-in; the product accent in kits); focus, selected, hover, checked and context
      borders take the accent of the service the element references (data-service; -fg for
      text and edges, base for fills; a non-colour cue stays); status colours (success,
      warning, danger, info, signed) never become a service accent; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Primary actions are neutral ink in the portal card, hosted sign-in and console card (B2); provider row fills come only from the Apple, Google and Steam allowed sets, never the host tint (B8). PX-21: FinishStep sits inside the passport with no provider strip; the primary stays disabled until both terms are ticked, with the reason line. ST-30: the console card has no app context, so no passport. (auth-17)
- [ ] Forced-colours render, 400% zoom (320 CSS px, no sideways scroll), 200% text, a custom product accent on light and dark, and 44 px customer targets. (auth-17)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 4 mockup item(s):** `admin.cli-login`, `admin.confirm-step-up`, `admin.members`, `admin.no-access-home`.
- `admin-3-05`, `admin.confirm-step-up`: Add the console ConfirmDialog step-up state to the acceptance: caution row, 'Sign in again', the typed word kept across the round trip (plans/ST-28 s10); the stub I-30 provides the passkey step-up.

## Acceptance criteria

- [ ] Every current PLATFORM_ADMIN_GROUP member signs in as Superadmin with no setup
- [ ] An email-code-only session is refused console access
- [ ] No route treats a non-null session as authorisation (ST-29's grep test still passes)
- [ ] Break-glass documented in the RUNBOOK with its exit facts; security review signed
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/console/members`, `reference/roles`, the runbook's lockout recovery and the rule 11 text.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen transcripts --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-30 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-30 done`.

## Progress and continuation (2026-10-20, sign-in card slice)

Built (wp/ST-30-console-signin): the console sign-in card, on the shared AuthCard.

- Worker: `GET /manage/login` serves the card (`console/signinPage.ts`, `renderAuthCard` with
  `brand: "console"`, the compact Key lockup and "Console"; one rule set with the Locker card, own
  palette and CSP hash). PKCE starts on Continue (`go=1`), `returnTo` and `stepUp` survive, the
  typed email goes to the IdP as `login_hint`. States by flag: `signedOut`, `ended`, `stepUp`.
  Sign-in errors use the same card.
- SPA: sign out goes to `?signedOut=1`, a 401 to `?ended=1&returnTo=`; the boot error is
  `ConsoleOffline` (AuthCard, "Can't reach Polaris Key", Try again).

Not in this slice (the rest of the brief stands): cookie v2, `consoleSubject`, binding-based
membership, break-glass link, audit actor mapping, account-lifecycle exits, threat-model rows,
docs pages, 'My library' and 'Open console' cross-links.
Deferred from the card: the passkey button (I-30 provides the endpoint), the known-operator chip
(needs a last-operator hint), the in-place "session ended" overlay that keeps unsaved edits
(today a 401 leaves the tab and the card brings the person back to the page), the not-configured
docs link (the docs tier needs a session), the "Next:" line says the host only (no IdP name).

### Fix round (2026-10-20, after the BUILT UX review)

Fixed: the card's `form-action` names the IdP (issuer and discovered authorization origins) and a
real-browser e2e (`packages/admin/e2e/consoleSignin.e2e.test.ts`) proves Continue reaches it with no
CSP violation; "Your session ended" only when the console API's 401 carries `X-PKey-Session:
expired` (a session cookie was presented and failed), a first visit gets the plain card; error
actions keep `returnTo`, step-up and the typed address; "Use another account" sends
`prompt=select_account` (`login` when discovery's `prompt_values_supported` lacks it); callback
copy rewritten (§3.13 strings, 403 names the account, 429 shows when to retry and has no link); the
SPA offline card is neutral ink, busy while retrying, focused and announced; step-up shows the
session's email; the not-configured card says who sets it up; viewing the card no longer counts
toward the sign-in limit.

### Slice 2a (2026-10-20, wp/ST-30-slice2; local, security-relevant)

Built: cookie v2, `consoleSubject` and `operatorIssuerAllowed`, the login form as a POST, the card's
Help and Privacy links, the in-place session-ended overlay, and the 'My library' / 'Open console'
cross-links. THREAT-MODEL has the rows (slice 1's GET residual is closed).

- **Cookie v2** (`core/console/session.ts`): signed `pkey.admin.v2|`, body `{aid, sid, name, email,
csrf, exp, authAt, stepUpAt?}`, no `groups` and no `sub`. The callback now runs I-05 `signIn` for
  the console IdP (`services/identity/consoleAccount.ts`, `consoleSignIn`): one account per person
  (the portal's issuer key), an operator whose verified address another account uses joins it, and a
  session row is opened in `account_sessions` (8 h). Per request, `console/consoleSession.ts` asks
  `consoleSubject` at most every `LIVE_CHECK_SECONDS` (30 s, in the limits inventory); a revoked
  session, a disabled, deleted or merged account, or a sign-out ends access within that. v1 cookies
  are still read until they expire (`issueSession` stays as the v1 minter for tests; delete both
  readers with the first release after 8 h). The audit actor is still the IdP `sub`.
- **`operatorIssuerAllowed`** (`core/rbac/operatorIssuer.ts`) fails closed: only `console-idp`
  unless `OIDC_ISSUER_ALLOWLIST` lists the host.
- **Login POST** (`POST /manage/login`, 303; `go=1` GET kept for error actions); the 502 retry is a
  POST form with the IdP in its `form-action`. e2e proves it in Chromium.
- **Card links**: Help (`/docs/help/`) and Privacy (`/docs/help/your-data/`). No Terms link: no
  public Terms page exists yet (the Locker menu says the same).
- **Overlay**: `console/shell/SessionEnded.tsx` is a modal `Dialog`; "Sign in again" opens the card
  in a second tab (a link) that returns to `#/signed-in` and tells the first over a
  `BroadcastChannel`. The request that met the 401 is held and sent again after sign-in, so the page
  never shows an error and keeps its form state; "Not now" fails it with its 401. This keeps unsaved
  input, which a same-tab round trip cannot. Only a page
  that loaded `/me` in this tab gets the overlay; a first load with a lapsed cookie still shows the
  card.
- **Cross-links**: the console user menu has 'My library' (`/me.customerOrigin`); `GET /api/me` on
  the portal answers `account.console` (the console address, else null) for an operator's account
  and the Locker account menu shows 'Open console' from it.

Verified against the code: the brief said the callback "goes through I-05 signIn"; it did not
(slice 1 minted from the IdP claims). `strong_at` and `asserted_at` do not exist yet, so groups are
read from the console link as last written by the sign-in, bounded by the 8 h session row.

**Security fix round (2026-10-21).** A held write is replayed only as the account that started it
(different account on sign-in: dropped with its 401 and a toast; also dropped after 10 minutes);
the operator join checks the target account is active before writing; tests added for the disabled,
ambiguous-address and portal-tagged-token cases. Lead rulings: operator join by IdP-verified email
accepted (needs the platform-admin group; allowlisted IdPs cannot reach it); the cache's
clear-at-500 accepted; groups stale up to 8 h accepted as documented.

### Slice 2b (2026-10-21, wp/ST-30-slice2b; local, security-relevant)

Built: the strong-method rule, the computed root rule, the audit actor as the member id, and the
lifecycle exits. THREAT-MODEL has the rows (console section, "slice 2b").

- **Migration** `0128_console_strong_method.sql` (the lead numbers it at merge): `account_links.
strong_at` and `asserted_at`, both NULL on existing rows (nothing is strong until a console
  sign-in marks it); rollback in `scripts/rollback/`. No new table, so no `TABLE_OWNERS` row.
- **SM-1/SM-3(b)(c)/SM-4/SM-5** (`services/identity/consoleAccount.ts`): `consoleSubject` reads only
  a strong link; a known, non-strong link without the group asserted is refused (`method`) before
  anything is written; the card is `consoleRefusalCopy`. SM-3(a) and (d) (step-up enrolment, "Use
  for the console") need the passkey button and stay for the next slice.
- **Root rule** (`rootRuleHolds`, `core/rbac/principal.ts`): strong + group + `asserted_at` under
  8 h; `asserted_at` is written only with `groups_json`. A v2 session's principal takes `root` from
  it. The 8 h bound stays documented for sessions held open after a group is removed.
- **Audit actor** = `mbr_` member id (`core/console/memberId.ts`); `consoleActorAliases` maps it
  and the IdP `sub` both ways for the activity filter; `/me.priorSubs` keeps "you" on old records.
- **Merge / disable / delete**: the absorbed account's links lose `strong_at`/`asserted_at` in the
  merge batch; disable revokes sessions and clears strength; erasure start clears it.

Corrections to the brief: the v1 "full authority" comment and `docs.ts` are untouched.

### Remaining after slice 2b (ST-30 not finished)

Console membership as a binding (ST-31); SM-3(a)/(d) with the passkey button and the console
step-up; break-glass as an explicit link with its audit row and exit facts; the known-operator
chip; the security review; the docs pages (operate/console/members, reference/roles), the RUNBOOK
lockout recovery and the rule 11 text; deleting the 'full platform authority' comment once ST-29's
docs.ts is on can(); removing the v1 cookie reader after the deploy. A larger lockup on the console
card is not done.

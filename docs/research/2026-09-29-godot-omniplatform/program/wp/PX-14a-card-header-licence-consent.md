# PX-14a Card header, licence choice, replace device, consent, key confirm, web return and passport pane (split of PX-14)

> **I-37 (2026-10-20).** The card's DeviceConfirm calls `decideDeviceFlow` (`productOidc/deviceApproval.ts`) from its JSON route. Neither the request handle nor `__Host-pk_req` is approval; only the page token for the flow, found through the binder, is.

| Field       | Value                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (Locker UX waves)                                                                                                                                                                                                                                                                                                     |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                                                                                                                                                                                            |
| Depends on  | [PX-12](PX-12-login-card-v2.md), [PX-W13](PX-W13-passthrough-metadata.md), [I-08](I-08-app-passthrough.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md), [UK-02b](UK-02b-ui-fixtures-parity.md), [LK-04](LK-04-cross-host-sign-in.md), [LK-06](LK-06-locker-shell-portal-card.md), [LK-07](LK-07-worker-pages-and-mail.md), [MK-L1](MK-L1-locker-auth-mockups.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-14b](PX-14b-native-return-consent-toggles.md), [PX-33](PX-33-signin-product-cover.md)                                                                                                                                                                                                                                 |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                |
| Gates       | console-csp-parity; portal-e2e; ui-snapshots                                                                                                                                                                                                                                                                                                                      |
| Human input | none                                                                                                                                                                                                                                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                         |

## Goal

The app sign-in card shows "<App> wants you to sign in" through every step, from data alone, lets the person choose a licence or replace a device, asks consent, and returns them to the web app. Half of the original PX-14 (full spec in [PX-14](PX-14-passthrough-header.md)); the native returns and consent toggles are [PX-14b](PX-14b-native-return-consent-toggles.md).

Executes the row(s) named in the [Locker UX map](../locker-ux-waves.md); do not restate it.

## Read first

- `AGENTS.md`, `CLAUDE.md` and `.claude/agents/pkey-ux-reviewer.md` (the quality bar).
- the [Locker UX map](../locker-ux-waves.md) rows and section 5 for this package. (section 1, rows 'App card header', 'LicenseChoiceStep, ReplaceDevice', 'ConsentStep', 'KeyStep in the card, ReturnStep (web)').
- [PX-14](PX-14-passthrough-header.md) for the full original spec; SIGN-IN.md §3.1, §3.6 to §3.10, §3.18, §4.16; mockups `identity.sign-in`, `identity.refusals`, `identity.consent`, `identity.key-step` (Locker re-skin from MK-L1).

## Owner rules (cite, do not restate)

- **Locker branding on every end-user surface**: the Polaris Locker lockup, `data-brand="locker"`, `polaris.locker`, no host line, and no Key mark, name or violet on a customer surface. **Polaris Key only on developer and admin surfaces.** Coral is for identity only (BRAND §15, D9a); the primary action is neutral ink.
- **No switch**: the customer origin is Locker and old URLs 301 (A5). Drop any "once `customer.host` is on" or soak language.
- plans/LK-00.md §15–§16 holds the rules. The mockups still draw Key in places: follow section 5 of the [Locker UX map](../locker-ux-waves.md), not the pixels.

## Scope

UI-first on I-08's `SignInRequestView`. Builds: CardHeader (app and device variants), LicenseChoiceStep, ReplaceDevice (0, 1, many, full; the server orders the rows, no LX-10), ConsentStep "Continue to <App> as <name>?" with the chosen licence, Change and equal Allow and Deny (**per-claim toggles hidden** until I-34, see PX-14b), KeyStep confirm, the web ReturnStep, the §4.16 integrated flow, motion (§3.18) and the React passport pane at 960 px landscape and wider. Owns `ui/auth/steps/{License,Consent,Return}*` and hosts PX-12b's step (FinishStep, built in PX-12's branch under PX-21). **The I-15 and I-37 dependencies are dropped.**

**Out** (and where it belongs instead):

- Native ReturnStep variants and consent toggles (→ PX-14b).
- Worker-rendered pages (`/device`, `/tv`, device confirm, refusals, magic link) (→ I-38a).
- FinishStep (→ PX-21, shipped in PX-12's branch).

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

## Acceptance criteria

- [ ] `pkey-ux-reviewer` passes the built screens in BUILT mode (a real browser, dark and light, 390 and 1440 px), against the matching Locker mockup.
- [x] A product with Identity off renders the `identity_disabled` card (test); a spoofed name never renders.
- [x] The LicenseChoice rows of `ui-matrix.json` pass against `portal/model` (admin unit test).
- [ ] The scoped green gate passes (AGENTS.md); the header's gates hold.

## Built (2026-10-20) and corrections to the brief

Built in the portal SPA on P0-38's AuthCard: `CardHeader` app and device variants (`ui/auth`),
`RequestHeader`/`RequestFooter`, `LicenseChoiceStep`, `ReplaceDeviceStep` (devices as a radio group,
nothing preselected, one ink primary **Replace and sign in**, the error under the group, the safety
line), `ConsentStep` (equal Allow and Don't allow, no toggles), `ReplacedDone` (names both devices),
`NoneStep`, `RequestFlow` (the signed-in half at `/signin?request=rq_…`) and PX-12's `AccountUpgrade`
on the key on-ramp (`POST /api/key/preview`; skippable while entries remain and only where an app sent
the person, forced at zero; a neutral ink meter). The model is `portal/model/signInRequest.ts`; the
LicenseChoice rows of `ui-matrix.json` run against it in `test/portalSignInRequestModel.test.ts`.

Corrections (the code is the fact):

- **The Worker answered 404 to `GET /signin?request=`** ("until PX-14"), so the card was unreachable.
  `dispatch.ts` now serves the portal shell there to a browser that holds a `__Host-pk_req` binder
  (not on the bind hop, not without a binder: those stay 404). Test: `worker/test/signInCardShell.test.ts`.
- **The ReplaceDevice and licence-list preselection follow the lead's decision, not §3.7**: no device
  is preselected ("Least recent" is a tag only). A licence list keeps the server's preselection,
  except that with every row full nothing is chosen (one lone row is chosen for the person).
- **Replace writes at Continue**, as §3.7 says: "Replace and sign in" goes to consent ("<licence> ·
  replaces <device>"), and Continue to <App> applies it; the done state then names both devices.
- **A store or purchase row names no origin** (`LicenseChoice` carries no store name).
- **The passport pane (>= 960 px landscape) is not built**; neither are native return variants and
  toggles (PX-14b). See the report's follow-ups.
- New catalog keys (nine locales): `signin.choice.{pickOne,pickDevice,replaceAndSignIn,replaceSafety,
replacedTitle,replacedBody}`, `signin.request.{goneTitle,gone}`, `signin.header.onDevice`,
  `signin.thisBrowser`, `signin.consent.{deny,cloudSync,newLicense}`,
  `signin.key.{upgradeTitle,upgradeLede,createAccount,signInInstead,noEntriesTitle,noEntriesKeeps,meter,keyWorks}`.

## Hand-off

The role agent sets `--set PX-14a in-review` when it hands off; the lead sets done after review. Branch from integ/next after the packages in Depends on have merged.

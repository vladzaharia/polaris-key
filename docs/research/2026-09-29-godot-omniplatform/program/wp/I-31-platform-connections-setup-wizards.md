# I-31 Platform -> Connections and setup wizards

| Field       | Value                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase       | I: Identity: one Polaris Key account, then per-app identity (S-16) (DX consolidation F: Identity)                          |
| Size        | 1–1.4 engineer-weeks                                                                                                       |
| Depends on  | [I-30](I-30-connections-one-oidc-relying-party.md), [ST-09](ST-09-platform-settings-area.md), [ST-39](ST-39-wizard-kit.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                     |
| Role        | `pkey-implementer`                                                                                                         |
| Plan mode   | no                                                                                                                         |
| Gates       | `threat-model`, `console-csp-parity`                                                                                       |
| Human input | none                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                  |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **IX-04** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: the built-in connection rows with `seed-builtin-connections`, and the `SIGNIN_*` names removed in the same release (its scope's "env `SIGNIN_*` as overrides" goes). Operator audiences stay refused until ST-32.

## Goal

Platform -> Connections and setup wizards, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **IX-04** in [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §5); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §5, for **IX-04**.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- One Platform -> Connections page grouped by kind: Sign-in providers and SSO (Google, Apple, Steam with status and step-by-step setup, secrets sealed under the platform KEK, env SIGNIN\_\* as overrides; SSO connections list and add wizard: discovery, redirect URI, client, test sign-in with claims preview, domains with the TXT record and live verification, audience, group mappings; per-connection status), Email (delivery status, I-18) and Turnstile; the Stores group joins when P0-28 lands, replacing the separate Store connections nav item. No Policies page: method strength is ST-28's fixed rule, session lengths are shown read-only as deploy-time values, reserved display terms stay with PX-W13b.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track F (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **IX-04**; DX consolidation F: Identity.
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

- Test sign-in window: the popup result reaches only the opener that started it (state bound to the operator session and the wizard draft id); the same-tab fallback returns through an allowlisted path to the same step; the provider's error body is shown as plain text, length-capped, with secret-shaped values redacted; claims from the test token are shown, never stored, and nothing is persisted until the last step. (admin-3-19)
- [x] Tests for each of the four rules. (admin-3-19) (`worker/test/connectionsAdmin.test.ts`, "test sign-in")
- Structure follows the current dx-mockups ids (I-29: identity.app-sign-in, identity.app-sign-in-changes, identity.sign-in-off; I-31: identity.connections, identity.connection*, centred 960 px wizard column; ST-38: commerce.features*, commerce.turn-off-licensing; A-22: commerce.sales\*; ST-39: the stepper where done steps say what was decided, inside the centred wizard column). The guide boards supply chrome only. (admin-3-18)
- [ ] `pkey-ux-reviewer` passes against those mockups in BUILT mode. (admin-3-18)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 9 mockup item(s):** `admin.platform-settings`, `identity.connection-audience`, `identity.connection-enforce`, `identity.connection-new-failed`, `identity.connection-new-start`, `identity.connection-new`, `identity.connection`, `identity.connections`, `identity.sign-in-routes`.

## Acceptance criteria

- [x] A connection is added end to end without editing env (wizard: provider check, client, test sign-in, claims, add; then domains on the connection page)
- [x] No new policy knob and no new setting: connections are rows, not settings (see Progress and continuation)
- [~] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/sign-in/*`; `operate/platform/connections`; `help/work-account`, `help/account`, `help/connected-apps`; the React cookie note removed.
- [x] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set I-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set I-31 done`.

## Progress and continuation (2026-10-19)

Built on `integ/next` (I-30's connections, P0-49 runner, P0-25's route table). Done: the admin API
(`console/handlers/platformConnections.ts`, rows in `ADMIN_ROUTES`, `STEP_UP_ROUTES`,
`rbac-route-areas.json`; platform area, step-up on every change, audit in the change's batch),
`services/identity/connections/{admin,testSignIn}.ts`, the console page, the connection page and the
add wizard on the ST-39 kit (`CONNECTION_FLOW`), the threat model section and the docs page
`operate/platform/connections`. Self-look at 360/390/1440, dark and light: no sideways scroll; the
screens read as intended.

Corrections to the brief (the code is the fact):

- **No route in `IDENTITY_ROUTES`.** Connections are an operator surface: the routes are rows of the
  console table (`/platform/connections/**`), narrative-only under rule 10 like every `/manage/api`
  route. The one change on the identity table's side is `GET /callback`, which also finishes a test
  flow (a `test` record in the portal's flow); it adds no route.
- **Registry and SettingsRow.** Connections are `identity_connections` rows with their own audit
  rows (`identity.connection.*`), not registry settings, so there is no `SettingsRow`; the page uses
  the console's `Section` and step-up pattern. No policy knob was added.
- **Built-in providers are status and steps only.** The plan's `seed-builtin-connections` job (a
  row per Google, Apple and Steam, the `SIGNIN_*` names removed from `Env`) is not in this package:
  it rewrites the sign-in path of three providers and the platform inventory, and the brief's 1 to
  1.4 weeks do not hold it beside the page. The page shows each provider's status and setup steps
  and the redirect URI; the secrets stay sealed in Worker values. Follow-up id: I-31b.
- **Docs.** `operate/platform/connections` and `features/sign-in/oidc` are updated. `help/work-account`
  already describes the sign-in; `help/account` and `help/connected-apps` and "the React cookie
  note" are not touched (no connected-apps page exists, the cookie note could not be found). Owner:
  the docs lane (DOC-\*).
- **Operator audiences stay refused** (`audience_not_available`) until ST-32.
- **Not built:** UX review (BUILT mode) and the mockup comparison; the lead schedules both.

## Fix round (2026-10-19)

The BUILT UX review failed with 4 blockers; fixed here, with the majors and the security-review
items.

- Blockers: (1) built-in setup shows one exact registration per provider from
  `providers/config.ts` (`signInRegistration`, the helper the login flow now builds its own callback
  from); Steam shows the realm. (2) A closed or blocked pop-up, or five minutes of silence, ends the
  test: "The sign-in window closed", focus back on the button. (3) A refused Change, Require,
  Stop requiring, Release or Delete keeps its dialog and the typed values; a field refusal shows on
  the field. (4) The secret entered before a same-tab trip is asked for again on Review and Add is
  blocked until it is; nothing is held server-side.
- Majors: field errors on the field with focus; Release of a verified domain confirms and names the
  effect; the test step has one primary ("Sign in with <name>"), Continue waits for a success,
  "Back to Client" on failure; focus after Check provider, Check now, the result and a failed save;
  specific error titles; "Cancel" for "Do this later" and the step-up return keeps the draft; the
  not-found page has an h1, breadcrumb and Back; Test sign-in on a saved connection, an action on the
  last-failure callout, the redirect URI; the seal command and runbook links, a next step for email;
  Add a domain lands on the field; PageHeader wraps at large text and the Stepper collapses by its
  own width in rem (shared components); the list is columned with quiet status; Email and Turnstile
  are compact; two columns at 1280 and up; quiet Delete; the wizard head sits in its column.
- Security review: the test start validates the claim map; domain add, release and enforce are one
  batch with their audit row; an unverify is audited; an issuer cannot move while people sign in;
  `hasSecret` is true for a secret reference; two threat-model lines.
- Not done: session lengths read-only (brief scope, still absent); the unverified-domain Undo is a
  toast action that claims the domain again with a new TXT record.

## Last round (2026-10-19)

PageHeader keeps its three-column grid at normal text and gets the large-text layout from the
header's own width in rem (`@container`, `@2xl`); below it the actions take right-aligned rows under
the title. Error words (no bare "api 500", "Already connected", "Secrets can't be sealed yet"),
focus to the opener or heading, verb copy-button names, viewer reasons, "Claim again" with the new
TXT record named, one place for the secret on Review, a columned list with headers, a container-width
rail. Follow-up **I-31c**: session lengths as a read-only card (brief scope).

Follow-up (not a CI row): `djdl:deliverables/record/delivery` shows a `trailing-space/main` violation
(scrolls 102 px past the last box) at 640×400 and 720×450, found with ad-hoc viewports of the layout
e2e. The page is not in `ZOOM_CASES`; I did not check whether it predates this package.

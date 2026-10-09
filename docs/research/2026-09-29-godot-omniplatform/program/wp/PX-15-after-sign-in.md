# PX-15 After sign-in: add a method, link accounts, approve a device

| Field       | Value                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | PX: Customer portal (docs/design/PORTAL.md) (phase B: new API, S-16, S-17)                                                                                                               |
| Size        | 0.4–0.8 engineer-weeks                                                                                                                                                                   |
| Depends on  | [PX-12](PX-12-login-card-v2.md), [PX-W12](PX-W12-sign-in-methods-api.md), [PX-W14](PX-W14-approve-device.md), [P0-38](P0-38-authcard-in-ui-auth-ux-40.md)                                |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                                                                                                                                   |
| Role        | `pkey-implementer`                                                                                                                                                                       |
| Plan mode   | no                                                                                                                                                                                       |
| Gates       | the PORTAL.md §11 green gate; CSP browser test (zero violations); admin build; `pnpm --filter @polaris-key/admin test:e2e` with zero CSP violations; `vitest-axe` on new page components |
| Human input | none                                                                                                                                                                                     |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- DeviceApproval outcomes and step-up copy per SIGN-IN.md §3.11 (`signin.approve.*`); the Add-another-way nudge is deferred out of passthrough to the next portal visit (D-40).

## Follow-ups from the 2026-10-06 reviews

Checked against `main` at `148439c4f`.

- **Link an existing account under `license_owned`** ([PX-17](PX-17-activate-confirm.md)). PX-17 left
  PORTAL.md §4.19's **Link an existing account** action, and its notice "If that account is yours
  too, sign in to it and join the two.", out of the Activate dialog's `license_owned` refusal,
  because `#/account/link` does not exist (the router's account sections are `profile`, `methods`,
  `products`, `sessions`, `appearance` and `data`). When this package adds `#/account/link`
  (`LinkAccounts`, on PX-W12), add the action and the notice to `RefusalActions` in
  `ActivateDialog.tsx`, next to **Use a different key** and **Sign in to that account**.

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track F, Identity](../../../2026-10-07-dx-consolidation/tracks.md#f-identity)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Add a method, link accounts and approve a device as AuthCard steps.

- Title: was "After sign-in: `AddMethodNudge`, `LinkAccounts`, `DeviceApproval` (both sides)".
- Depends on: added P0-38.

## Goal

After sign-in the person may be nudged to add another method, can link an existing account with proof of both, and can sign in on a new device by approving it from a signed-in one (both sides).

## Why

Recovery and multi-device sign-in ([PORTAL.md §4.10](../../../../design/PORTAL.md#410-add-another-way-to-sign-in-nudge), [PORTAL.md §4.11](../../../../design/PORTAL.md#411-link-an-existing-account), [PORTAL.md §4.23](../../../../design/PORTAL.md#423-sign-in-with-another-device), [PORTAL.md §4.24](../../../../design/PORTAL.md#424-approve-a-new-device)). PORTAL.md sizes this M (2–4 agent-days); the owner approved the design on 2026-10-04.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [docs/design/PORTAL.md](../../../../design/PORTAL.md) in full once, then: [PORTAL.md §11.3](../../../../design/PORTAL.md#113-phase-b-features-on-the-new-api-s-16-and-s-17) (this package's row) and [PORTAL.md §11.4](../../../../design/PORTAL.md#114-order).
- [PORTAL.md §4.10](../../../../design/PORTAL.md#410-add-another-way-to-sign-in-nudge), [PORTAL.md §4.11](../../../../design/PORTAL.md#411-link-an-existing-account), [PORTAL.md §4.23](../../../../design/PORTAL.md#423-sign-in-with-another-device), [PORTAL.md §4.24](../../../../design/PORTAL.md#424-approve-a-new-device)
- `docs/design/BRAND.md` and `@polaris-key/brand`; the console kit in `packages/admin/src/ui/`.

## Scope

**In:**

- `AddMethodNudge`, `LinkAccounts`, `DeviceApproval` (QR, code and poll on the new device; approve dialog on the signed-in one).

**Out** (and where it belongs instead):

- Anything not in PORTAL.md's row for this package (→ the PX package that owns it, per §11).

## Design notes

- Plain words: "join", never "merge" (§6.1).

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

## Steps

1. Re-read the PORTAL.md sections above and the matching mockups in `docs/design/portal/`; verify this brief against the code and record any correction here.
2. Implement the **In** list in small commits prefixed `PX-15:`.
3. Add the tests named in the acceptance criteria.
4. Run the green gate and the extra gates in the header; set `--set PX-15 in-review`.

## Acceptance criteria

- [ ] e2e: join requires both proofs.
- [ ] Approval shows device and location and never auto-approves (test).
- [ ] `pnpm --filter @polaris-key/admin build` passes and `pnpm --filter @polaris-key/admin test:e2e` reports zero CSP violations.
- [ ] `vitest-axe` passes on every new or changed page component; one `h1` per screen (§9).
- [ ] No horizontal page scroll at 360 px on every screen this package touches (§8).
- [ ] The green gate passes (`AGENTS.md` and PORTAL.md §11), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test:e2e
```

## Hand-off

none.

The role agent sets `--set PX-15 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set PX-15 done`.

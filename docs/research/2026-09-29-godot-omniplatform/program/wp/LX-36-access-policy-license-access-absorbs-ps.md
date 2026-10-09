# LX-36 Access policy license.access (absorbs PS-09)

| Field       | Value                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | LX: Licensing model: licences, grants, entitlements (S-19) (DX consolidation E: Licensing model)                                                                                                                                                                                                                                     |
| Size        | 1–1.4 engineer-weeks                                                                                                                                                                                                                                                                                                                 |
| Depends on  | [LX-35](LX-35-add-on-definitions-grantaddon.md), [P0-20](P0-20-split-identity-oidc-ts-extract-issuance.md), [P0-49](P0-49-data-migration-runner-dry-run-report.md)                                                                                                                                                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [P2-10](P2-10-product-access-page-who-gets-what.md), [I-35](I-35-one-identity-manifest-block-joint-lx-36.md), [D-02](D-02-diceroll-after-p1.md), [LX-16](LX-16-licensing-contract.md), [PS-12](PS-12-discover-visibility-one-setting.md), [LX-38](LX-38-account-keyed-automatic-licences.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                   |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                   |
| Gates       | `threat-model`, `rule-9`                                                                                                                                                                                                                                                                                                             |
| Human input | none                                                                                                                                                                                                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                            |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **LX-36** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model).

- Owner 2026-10-07: manifest fields are removed, not deprecated. A removed field is a validator error that names its replacement, with no rule-9 warning period; this package migrates the in-repo manifests (the repo-root `.pkey/` and `products/djdl/*`) in the same change, adopters' repos (DJDL's, Diceroll) are owner steps, and `pkey migrate` is used only where this package already plans it.
- Absorbs PS-09: An email-domain rule is one branch of license.access; autoIssue.emailDomains is never created.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: `license.access` rules use §2.4's `when` object verbatim.
- [`plans/I-27.md`](../plans/I-27.md) §12: `SignInFacts`; the approval's policy half and its job (`edge-mint-approval-access`).
- [`plans/U-01b.md`](../plans/U-01b.md) §11: wire the Anonymous devices tier into `syncAccess`'s quota.

## Goal

Access policy license.access (absorbs PS-09), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **LX-36** in [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track E, Licensing model](../../../2026-10-07-dx-consolidation/tracks.md#e-licensing-model): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.4, for **LX-36**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.
- [`audits/licensing-core.md`](../../../2026-10-07-dx-consolidation/audits/licensing-core.md), for file and line evidence.

## Scope

**In:**

- Setting license.access and manifest licensing.access: Nobody | Everyone -> a tier | rules matching an issuer-bound group, a verified email domain or a claim -> tier:<id> | addon:<id>; an Anonymous devices tier (anonymous entry's only home). No upgradeOnSignIn knob: automatic licences (origin oidc) re-run accessFor() on every sign-in, upgrade only; licences issued by hand or by purchase are never touched. One pure accessFor() used by sign-in, the card, Discover, the storefront persona preview and edge-mint approval; RuleEditor, match preview and ClaimMatcher shared with ST-32's console.access. Migration through a P0-49 job from license.autoIssue, the groupRoleMap tier half (warning for its unread role), syncTierOnSignIn, storefront.polarisKey.groupLabels and provisioning entitlement hooks, converting LX-08's grt*oidc*<licence> grants into add-on grants with addon_id; PS-09's email domains become a rule; THREAT-MODEL rows (group injection, unverified domains). The editor lives on P2-10's product Access page.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track E (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **LX-36**; DX consolidation E: Licensing model.
- Security review and THREAT-MODEL rows before merge (`sec`).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

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

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 7 mockup item(s):** `admin.sso-rules`, `licenses.access-confirm`, `licenses.access-rule-states`, `licenses.access-rule`, `licenses.access`, `entitlements.addon`, `portal.discover`.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Acceptance criteria

- [ ] P0-49 report for djdl and polaris-key shows identical outcomes, provisioned keys included
- [ ] accessFor() is the only evaluator (grep test)
- [ ] Unverified emails never match a domain rule (test)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/licensing/access` (enrollment and policy merged; automatic licences); `help/activate`, `help/library`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set LX-36 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set LX-36 done`.

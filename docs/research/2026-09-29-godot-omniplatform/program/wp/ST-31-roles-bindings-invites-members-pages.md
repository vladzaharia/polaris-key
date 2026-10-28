# ST-31 Roles, bindings, invites and the Members pages (absorbs ST-22)

| Field       | Value                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (DX consolidation D: Administration, access control and console identity)                          |
| Size        | 1.4–2 engineer-weeks                                                                                                                              |
| Depends on  | [ST-30](ST-30-console-sign-in-on-polaris-key-accounts.md), [P0-21](P0-21-notification-substrate-core-notify.md)                                   |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [ST-32](ST-32-sso-rules-admingroup-conversion.md), [ST-35](ST-35-rbac-docs-lockout-recovery-docs-gate.md) |
| Role        | `pkey-implementer`                                                                                                                                |
| Plan mode   | no                                                                                                                                                |
| Gates       | `migration`, `table-owners`, `threat-model`, `console-csp-parity`                                                                                 |
| Human input | none                                                                                                                                              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                         |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **AC-04** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity).

- Absorbs ST-22: No longer optional: the owner asks for full RBAC (ST-28 plan, ST-29 gate, ST-30 sign-in, ST-31 roles). Security review carried over.

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/ST-28.md`](../plans/ST-28.md) §10: it owns the §5.1 DDL, G1–G8, SM-6, SM-7, the merge on conversion and the generated `console-roles.mdx`.

## Goal

Roles, bindings, invites and the Members pages (absorbs ST-22), as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **AC-04** in [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.2, §4.2, §4.4); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track D, Administration, access control and console identity](../../../2026-10-07-dx-consolidation/tracks.md#d-administration-access-control-and-console-identity): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.2, §4.2, §4.4, for **AC-04**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/rbac-admin.md`](../../../2026-10-07-dx-consolidation/audits/rbac-admin.md), for file and line evidence.

## Scope

**In:**

- One table, console_role_bindings (subject = account_id or email_norm, role, scope, areas, source, by, at): a member is anyone with at least one binding; an invite is a binding on an email, converted at the first strong sign-in the way a waiting licence is; the four built-in roles with platform, product and All-products scopes; area narrowing on Product admin; the product creator becomes Product admin; Platform -> Members (Members, Invite, Roles matrix generated with a drift gate) and Product -> Settings -> Members (standalone until ST-08's hub); step-up, notify and audit on every grant.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track D (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **AC-04**; DX consolidation D: Administration, access control and console identity.
- Security review and THREAT-MODEL rows before merge (`sec`).
- D1 migration (`mig`): name the file `00XX_<name>.sql`; the lead assigns the number at merge. Contracts take two releases (tracks.md rule 5): replay-safe, safe for the Worker still serving during the deploy, with a down script in `scripts/rollback/`.
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

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

Corrections recorded by slice 31.1 (code is the fact):

- `TABLE_OWNERS` already had a `console_role_bindings` row under `core` (ST-28 added it ahead of the migration); 31.1 only updated its comment.
- The DDL is ST-28 §5.1 verbatim. Migrations are `0130_a_console_role_bindings.sql` and `0130_b_platform_audit_action_idx.sql` (the `idx_platform_audit_action` index ST-30 never added); the lead renumbers both at merge.
- `normalizeAreas` throws on any id that is not a product area (the prompt said "only product areas"), so a typo never silently narrows or widens a grant.

Corrections recorded by slice 31.18 (code is the fact):

- `operate/console/members` is built and links to `reference/roles`, not back: `reference/roles` is public and the docs link-tier rule (`check:links`) refuses a public page linking an admin page, so the brief's "linked from `reference/roles`" is met in the other direction. `platform-members` and `settings-members` in `console/nav.ts` point at it; `lib/docsLinks.ts` has no members entry, so only the nav table changed.
- 404-before-403 is closed: ST-31.8 answers an unknown `/products/:slug/*` slug with the same 403 as an unreachable real product. The ST-31.5 THREAT-MODEL line calling it "older behaviour, unchanged" was stale and is corrected.
- The roster "list is cut" hint exists in `platformMembers.tsx` and `SettingsMembers.tsx` (`truncated`/`incomplete` callout). `useListCap.ts` is a different thing (show five more rows) and is not used by Members.
- SM-6 and SM-7 move to ST-31b (lead decision Q8, registered separately). Conversion rule 5 already enforces the operator-connection requirement for platform roles; the docs page states only that.
- "Sign out everywhere" and SSO rules are left to ST-34.13 and ST-32.9.

## UX coverage (2026-10-09)

Generated from `ux-coverage.json` (read `ux-coverage.md` for the whole map). Do not edit this section by hand; change the coverage file.

- **Builds or backs 6 mockup item(s):** `admin.invite`, `admin.members`, `admin.no-access-home`, `admin.no-access`, `admin.product-members`, `admin.roles`.

## Acceptance criteria

- [ ] Console access alone shows NoAccessPage with the scope's admins to contact
- [ ] A product admin sees only their products; an area-narrowed one sees only those areas
- [ ] Roles matrix is generated and drift-gated; security review before merge
- [ ] Role-granted products and console-member access answer in `personMayRead` (`services/distribution/registry/authorize.ts`), from the bindings this package adds (taken over from F-33, 2026-10-22)
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `operate/console/members`, `reference/roles`, the runbook's lockout recovery and the rule 11 text.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set ST-31 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-31 done`.

## Consolidation 2026-10-22 (triage)

F-33 was split and set done. Its "role-granted and console-member access in `personMayRead`" item moves here: this package owns the bindings that source it, and the acceptance above carries it.

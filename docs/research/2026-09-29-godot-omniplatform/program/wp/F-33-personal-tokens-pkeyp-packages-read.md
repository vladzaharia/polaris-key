# F-33 Personal tokens (`pkeyp_`, `packages:read`) and portal Packages

| Field       | Value                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (DX consolidation I: Packages, updates and packs)                                                                                                                                                               |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                         |
| Depends on  | [P0-17](P0-17-layering-move-lead-codemod-at-batch-6.md)                                                                                                                                                                                        |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [F-34](F-34-feeds-that-provision-themselves.md), [F-37](F-37-pkey-feeds-setup-write-cli-naming.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md), [PX-31](PX-31-account-composition-v3.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                             |
| Plan mode   | no                                                                                                                                                                                                                                             |
| Gates       | `migration`, `table-owners`, `threat-model`                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                      |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **FX-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs).

## Approved plans (2026-10-08)

These approved plans change this package. Where they differ from the text below, they win.

- [`plans/I-27.md`](../plans/I-27.md) §12: §2.5's lifetimes, device login with `purpose: "cli"`, and the phishing row.

## Goal

Personal tokens (`pkeyp_`, `packages:read`) and portal Packages, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **FX-01** in [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§3.1, §3.2, §4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track I, Packages, updates and packs](../../../2026-10-07-dx-consolidation/tracks.md#i-packages-updates-and-packs): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §3.1, §3.2, §4.2, §4.3, for **FX-01**.
- [`audits/backlog-sweep.md`](../../../2026-10-07-dx-consolidation/audits/backlog-sweep.md), for file and line evidence.
- [`audits/feeds-updates-packs.md`](../../../2026-10-07-dx-consolidation/audits/feeds-updates-packs.md), for file and line evidence.
- [`audits/identity.md`](../../../2026-10-07-dx-consolidation/audits/identity.md), for file and line evidence.

## Scope

**In:**

- An account*tokens table (pkeyp*, HMAC under the pepper, shown once, expiry, last used; scopes are exclusive per token: packages:read, or the admin scope ST-34 adds); the registry host accepts pkeyp* packages tokens, licence-bound pkeyr* and pkeyci* service tokens with packages:read, and refuses any admin token; it resolves a person per owner: the Library's usable licences under each feed's access mode, plus role-granted products, plus the system product's SDK listing for console members (owner decision 3); serve-time filtering of list documents; portal Account -> Packages with one combined setup across every product the account can read; console account menu -> Personal tokens; new product service tokens are minted as pkeyci* with packages:read (registry*tokens keeps only licence-bound tokens; existing owner-bound pkeyr* tokens are honoured until they expire); the portal stops minting licence-bound tokens (existing ones honoured); cascades on account delete, merge and membership removal; THREAT-MODEL entry; an authenticated registry-clients.yml row over two owners.

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track I (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **FX-01**; DX consolidation I: Packages, updates and packs.
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
      sign-in); forced-colors; prefers-contrast: more; reduced transparency; contrast measured on the
      render (text 4.5:1, UI 3:1).
- [ ] States: loading (skeleton after the grace), first-run empty, filtered empty, permission refused,
      expired or stale, network and API error with Try again, partial failure, success; input survives a
      failed save; where the API sends expectedVersion, a changed-since-open conflict is named with
      Reload.
- [ ] Motion: tokens only; reduced motion is an instant swap and the outcome still reads; errors appear
      without moving content; progress is real (no invented percentage, nothing loops after a failure);
      no celebration on refunds, revocation, removal, deletion or consent.
- [ ] Hierarchy and copy: one filled primary per state; the section accent marks context only, never
      success, warning or failure; copy from the catalog, each fact once; no decorative numbers or
      taglines; no text drawn over customer art.
- [ ] Native (kits): Dynamic Type or font scale at the 200 % row, VoiceOver or TalkBack, gamepad and
      D-pad focus, TV and title-safe insets, terminal keys with NO_COLOR, ascii and --json paths.
- [ ] pkey-ux-reviewer passes the built screens (BUILT mode).

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- Tokens and setup live only in Account → Packages: `pkeyp_` tokens are account-wide, one per machine, and revoking from a product page would break every product's installs. Each product page with packages replaces the per-product token list with one pointer row: '<n> packages from <Product> · Set up in Account → Packages'. Account nav: Profile · Sign-in methods · Connected apps · Packages · Where you're signed in · Appearance · Your data. Sign out aligns with the h1. (portal-11)

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] One token installs every package the account may read, across products
- [ ] Customers never see the system product in listings
- [ ] Existing pkeyr* tokens keep working until expiry; new service tokens are pkeyci*
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `features/ship-builds/packages/*`; `build/install` (private feeds); `help/packages`.
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test
mise exec node@22 -- pnpm gen:transcripts -- --check
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set F-33 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-33 done`.

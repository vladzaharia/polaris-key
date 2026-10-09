# P0-45 pkey command registry, context and doctor

| Field       | Value                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene, unblockers and code quality (DX consolidation B: Foundations (code quality the feature tracks build on))                                                                                                                                                                                                       |
| Size        | 1.5–2 engineer-weeks                                                                                                                                                                                                                                                                                                        |
| Depends on  | [UK-14](UK-14-node-terminal.md)                                                                                                                                                                                                                                                                                             |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [A-25](A-25-action-v2-channels-auto-thin-inputs.md), [ST-34](ST-34-admin-scope-personal-tokens-pkey-login.md), [ST-46](ST-46-interactive-pkey-init.md), [AX-08](AX-08-pkey-agents-product-repo-block-console-card.md), [AX-16](AX-16-the-cli-for-agents-json-codes-pkey-explain.md) |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                          |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                          |
| Gates       | `rule-9`                                                                                                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                   |

## Consolidation 2026-10-07

Registered by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) as **CQT-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on).

- Owner 2026-10-07: removal, not deprecation. No aliases; the 0.9 release notes list the break.

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- Registry entries for `agents` (AX-08), `explain` (AX-16) and `mcp` (AX-17), each as it lands.
- Every command declares whether it has `--json`.

## Goal

pkey command registry, context and doctor, as scoped below. Done when every acceptance criterion holds and the green gate passes.

## Why

Filed by the [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) (2026-10-07) as **CQT-04** in [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on). The decision record is [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) (§4.2, §4.3); the crosswalk from its working ids to graph ids is at the end of [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md#crosswalk-integrationmd-ids-to-registered-ids). Evidence: [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md).

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- [Track B, Foundations (code quality the feature tracks build on)](../../../2026-10-07-dx-consolidation/tracks.md#b-foundations-code-quality-the-feature-tracks-build-on): the package's row, the track's dependencies and exit criteria, and the six cross-track rules at the top.
- [`integration.md`](../../../2026-10-07-dx-consolidation/integration.md) §4.2, §4.3, for **CQT-04**.
- [`audits/cq-sdks-tools.md`](../../../2026-10-07-dx-consolidation/audits/cq-sdks-tools.md), for file and line evidence.

## Scope

**In:**

- Typed command registry grown from UK-14's help.ts driving parse, help, completion, reference/cli.mdx and the Action mapping; --product and --base-url default from .pkey/product and PKEY_BASE_URL; pkey doctor as the CLI twin of the console's Integration verdict; pkey validate --fix. A wave-7 item (A-25 and ST-46 wait for it).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and the rest of Track B (→ the ids in [`tracks.md`](../../../2026-10-07-dx-consolidation/tracks.md)).

## Design notes

- Working id **CQT-04**; DX consolidation B: Foundations (code quality the feature tracks build on).
- No new copies (tracks.md rule 4): build on the one mechanism this plan names, never beside it.

## Brand transition (2026-10-09)

Applied from the brand and transition integration ([Brand transition decisions](../BRAND-TRANSITION.md)). This section wins over the text below where they differ.

- [ ] The built `pkey help` shows a header with the version and a 'Here' line in both states (product from `.pkey/product` and base URL; outside a repository 'no product: no .pkey/product here or above; pass --product · key.plrs.im'); groups and verbs use glossary words (Channels, release tracks), not 'Storefront' or 'outlet'; footer link; wraps at 40 columns without losing a fact. (sdk-c-23)

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

- **Builds or backs 2 mockup item(s):** `sdk.pkey-help`, `sdk.pkey-doctor`.
- This package is the builder that carries the UX gate for the items above: the Screen acceptance block applies, and `pkey-ux-reviewer` must pass the built screens (record it with `--ux-review`).

## Acceptance criteria

- [ ] reference/cli.mdx generated with --check
- [ ] pkey doctor reports the same Verified facts as ST-40
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/cli test
```

Then the full green gate in `AGENTS.md`.

## Hand-off

What downstream work packages rely on from this one is named in their briefs (the Unblocks row). The role agent sets `--set P0-45 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-45 done`.

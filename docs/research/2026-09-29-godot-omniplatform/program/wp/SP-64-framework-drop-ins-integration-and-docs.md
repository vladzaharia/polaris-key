# SP-64 Framework drop-ins on the Integration page and in the docs (servers and CLIs)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                                                                                                       |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                 |
| Depends on  | [SP-33a](SP-33a-one-integration-content-generator-on.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [UK-46](UK-46-node-terminal-kit-for-existing-clis.md), [UK-48](UK-48-python-terminal-kit-as-a-mountable-drop-in.md), [DOC-03a](DOC-03a-skeleton-and-contracts.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-11](AX-11-drop-in-skills-servers-and-cli-hosts.md)                                                                                                                                                                                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                     |
| Gates       | `docs-generated`, `docs-links`, `console-csp-parity`                                                                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                              |

## Goal

Framework drop-ins on the Integration page and in the docs (servers and CLIs), as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-64.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-64).

## Scope

**In:** §10: `sdkFit(platforms, repoSignals)` returns `{sdk, host, framework}` from the server and CLI repo signals; the server card (the framework snippet with the product's config and first entitlement, two links, Verified on a `<lang>-server` sighting), the app card's `client.backend` line, and the CLI card's mount and gate. Docs (public): the **Your server** third lane on Licensing, Sign-in, Managed config and Commerce with the host/framework picker; `build/servers/` and one page per framework; the CLI framework sections under the kit pages; the four `backend` codes on the error reference. Snippets come from SP-33a's generator with `lane: "server"`.

**Out** (and where it belongs instead):

- The concepts page `features/licensing/server-verification` (→ DOC-09a); the generator itself (→ SP-33a).

## Design notes

- The docs are public (owner, 2026-10-08).
- No client SDK changes, except SP-54b (the native `profile.user` readers, reached through UK-48; approved `plans/SP-54.md`, 2026-10-09). Sign-in lanes describe the signed-in subject as `profile.user.subject`, and a client that signs in refreshes the licence document afterwards (SP-58).
- The managed-config server lane is written on the plain client; `serverClient()` (SP-63, optional) is a later improvement.

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

## Acceptance criteria

- [ ] `sdkFit` detects each must-tier framework from its repo signal; the server card turns Verified on a `<lang>-server` sighting.
- [ ] The Your server lane renders for Licensing, Sign-in and Managed config; lanes stay the only tab set (docs plan §3.6).
- [ ] Every server snippet compiles as an SP-33a golden.
- [ ] `build/servers/` states the one-hour replay window and the ~65-minute revocation bound.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-64 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-64 done`.

# UK-02b UI state fixtures and parity rows: shared component/state/copy-key fixtures, `features.json` `ui.*` rows, every SDK's `parity.json` at `planned`

| Field       | Value                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                        |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                |
| Depends on  | [UK-02](UK-02-copy-fixtures-parity-plan.md), [SP-00](SP-00-parity-registry-plan.md), [UK-02a](UK-02a-kit-copy-catalog.md)                                                                                                           |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [PX-14](PX-14-passthrough-header.md), [UK-03](UK-03-ui-core.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md) |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                |
| Plan mode   | yes: executes the approved [`plans/UK-02b.md`](../plans/UK-02b.md) (2026-10-08), which carries [`plans/UK-02.md`](../plans/UK-02.md) §3.5 and §4                                                                                    |
| Gates       | plan mode (executes `plans/UK-02b.md`); `pnpm parity:check -- --check`; `gen:constants -- --check` (feature ids); `gen:corpus -- --check`; `gen:brand -- --check`; the generated parity docs page                                   |
| Human input | none                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                           |

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- `LicenseChoice` UI fixtures: loading, many, one, current, keep, new, create, all-full, sign-in, mixed, replace-open, raced, none-keys, none-no-keys, none-replaceable (SIGN-IN.md §6.2).

## One sign-in form (2026-10-05): `plans/I-04.md` §G and SIGN-IN.md §3.17

The owner decided on 2026-10-05 that every in-app sign-in step happens in **one form whose body
morphs in place** (no stacked sheets), that the license is chosen **inside the app** when it can
show it, that the presentation is configurable with native controls kept, that there are **two
equal ways to integrate** (the hosted card, and the kit form with headless primitives), and that
the web flow is one continuous, animated card. The wire is
[`plans/I-04.md`](../plans/I-04.md) §G (a pending sign-in grant, `licenseChoice: "app" | "card"`);
the experience is [`SIGN-IN.md`](../../../../design/SIGN-IN.md) §2.4, §3.17, §3.18, §4.16 and
D-78–D-93. Where this brief differs, they win. **No device-wire version change**
(`PROTOCOL_VERSION` 4, `DISCOVERY_VERSION` 2, `corpusVersion` 2; no corpus file). New UI copy uses
the owner's license vocabulary (SIGN-IN.md O-17: the tier pill and "{used} of {limit} devices" on
every row, no "Account-wide"). For this package:

- Add the `signin-form` fixtures: every step and state of the one form (methods, handoff, no browser, code, finishing, choose and its §6.2 states, replace, replace confirm, key, done, grant expired, cancelled) in the `inline` and `sheet` presentations. They are the `signIn` family of `ui.signin` (D1).

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **keep** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Add service-off and presentation-absent fixture rows for every component so kits degrade identically; the portal's hosted card consumes the signin-form fixtures. Its plan is dispatched in week 0 (UK-03 waits for it).

## Approved plan (2026-10-08)

[`plans/UK-02b.md`](../plans/UK-02b.md) is the scope: one PR that adds `conformance/corpus/v2/ui-matrix.json`, its mirrors, the ten `ui.*` rows and `UI_MATRIX_VERSION`. It wins over the text below where they differ.

- `ui.signin` covers the whole sign-in form; no `ui.kit.signin` row (D1).
- Service-off rows come from one dependency map; Paywall and EntitlementGate depend on `license`, and CM-29 appends the `commerce` pairs (D5, Q4).
- No runner is added; every SDK suite keeps its verdicts (§5).
- Node's `ui.*` owner is UK-06 (§8).

## SDK usability review (2026-10-08)

Accepted changes from the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.1. Where they differ from the text below, they win.

- Terminal-kit state fixtures (rows, fix lines, copy keys) and the kit-verb contract.

## Owner direction (2026-10-08)

- **Responsive.** Every kit screen adapts to its window, with landscape layouts where the window is landscape.
- **Resolution matrix.** Tested at every size in [UI-KITS.md](../../../../design/UI-KITS.md) §7.1, including 200% text or zoom.
- **Spacing and theming.** One spacing rhythm, and themable with `preset: "polaris-key" | "native"`, where `native` matches the platform.
- **Quality bar.** Meets the bar in `.claude/agents/pkey-ux-reviewer.md` ("a GOOD UI", good use of visual space), not just no overflow.
- **Review.** Several UX reviews (`pkey-ux-reviewer`), not one.
- **For this package.** The rows stay size-independent; each kit renders them at the matrix sizes.

## Goal

The presentation state machines are specified once as fixtures that every core can run, and the parity registry tracks the UI kit features in every SDK.

## Why

Layer (c) must be the same state machine in every language (§1.3); without fixtures, a React screen and a Godot scene fed the same inputs can disagree. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- [`plans/UK-02b.md`](../plans/UK-02b.md) (approved), and [`plans/UK-02.md`](../plans/UK-02.md) §3.5 and §4
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.1 (components and states), §5.2
- `conformance/parity/`, every `parity.json`

## Scope

**In:**

- The fixture files at the planned path, one case per component × state, including presentation present and absent.
- A runner contract (input shape, expected output) each core implements.
- `features.json` rows and allowed N/As; every SDK manifest at `planned` with its UK item named.

**Out** (and where it belongs instead):

- The runners in each core (→ UK-03, UK-07, UK-09, UK-11, UK-12).
- `ui.cli` and the `headless` N/A removal (→ SP-00, already done).

## Design notes

- No server or wire change.
- Fixture inputs reuse existing SDK result shapes, so no new types enter `shared-protocol`.

## Steps

1. Implement exactly `plans/UK-02b.md`, in its order.
2. Hold the corpus lane only from regeneration to merge (D11, Q3).
3. Run the gates in the header.

## Acceptance criteria

- [ ] `pnpm parity:check -- --check` passes with every new id `planned` in every SDK.
- [ ] Every §4.1 must component has at least one fixture per listed state.
- [ ] Docs, in this PR ([docs plan](../../../2026-10-08-docs/README.md) §10): its part of `<StatesToHandle>` from the fixtures; a kit tab per component; a component page returns when a kit ships it; a recipes page at UK-31.
- [ ] The green gate passes (AGENTS.md), including every drift gate listed in the header.

## Verify

`plans/UK-02b.md` §13.

## Hand-off

Each core runs these fixtures in its own suite; UK-15 renders every fixture state in every kit for the report.

The role agent sets `--set UK-02b in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-02b done`.

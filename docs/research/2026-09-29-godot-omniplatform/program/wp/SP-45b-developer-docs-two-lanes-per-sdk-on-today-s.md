# SP-45b Developer docs, two lanes per SDK on today's API: Swift, Kotlin, Godot

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 1.2–1.6 engineer-weeks                                                             |
| Depends on  | [SP-45a](SP-45a-developer-docs-two-lanes-per-sdk-on-today-s.md)                    |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-09](AX-09-sdk-skills-must-tier.md)     |
| Role        | `pkey-implementer`                                                                 |
| Plan mode   | no                                                                                 |
| Gates       | `docs-generated`, `docs-links`, `ci`, `ci:macos`                                   |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## LLM audit (2026-10-08)

The [LLM audit plan](../../../2026-10-08-llm-audit/README.md) §9 changes this package. Where it differs from the text below, it wins.

- The snippet lane also compiles SDK-tagged fences under `packages/agent-kit/skills/` (AX-07 and the skill packages). AX-09 waits for this package.

## Goal

Developer docs, two lanes per SDK on today's API: Swift, Kotlin, Godot, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-45b) and §10.4.

## Scope

**In:** the lane skeleton of §4.1; a doc-snippet extractor (fenced blocks in every SDK README and docs page, by language, with an opt-out marker) and compile lanes; status badges on `build/ui/index.mdx`, framework pages and component tabs; shipped names in the layer table, spec names labelled; terminal and Electron rows; UI-KITS §4.2 amended to the `polaris-key.json` shape; `DOCS_LINKS` entries for every console link in §4.2. _(a)_ Node, React and Python: the pages and fixes in §4.2. _(b)_ Swift, Kotlin and Godot: the pages and fixes in §4.2, the Xcode install tab, the Compose Desktop recipe, the Godot class-name drift check and AssetLib metadata.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- Builds on SP-45a's skeleton and snippet lane.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections (verified against the code, 2026-10-11)

- The branch is `wp/SP-45b-sdk-docs`. `sdks/godot.mdx` moves to `sdks/godot/index.mdx` like every
  other SDK page (the slug is unchanged); `doors.test.ts` failed on the half-done move.
- Godot README: the in-flight edit lost a closing fence and nested a snippet in a list without
  indenting its code, so 50 lines rendered as one code block. Fixed; every `gdscript` block compiles
  in the lane and the prose names no test-only class.
- Godot facts corrected from the code: `expired` is the cached licence document outliving its grace
  window (the old "Connect to renew" text does not exist; the copy is "Connect to keep playing");
  today's Worker answers an ended licence `401 unauthorized`, so `license-expired` does not occur
  against it; `key_entry_limit` arrives as `refused` with that code and no manage link; `sync()`
  keeps `ok` true offline and `classify()` says `offline`, `error` or `ok`; an `unknown` outlet
  (the editor) always gets `none` with reason `not-available`; the test seams are
  `PKeyOptions.store` (`PKeyMemoryStore`), `now_source` and `local_only`, with no transport seam.
- Kotlin pages (verified by file and line): the quickstart shows `0.9.3`, `PolarisKeyApp(client,
signIn = true)`, and the own-UI gate emits `status()` before `licenseChanges` (`licenseState` is
  null until the first publish); `licenseUser()` ships after `v0.9.3`.
- Swift: the README is now a covered page with the shipped `.polarisKeyGate` instead of the
  `PolarisGateModel(license:)` recipe, the real floors (`macOS(.v15)`, `iOS(.v18)`) and `from:
"0.9.3"`. The kit is not English-only (nine locales; `ErrorCopy` is). `.polarisKeyGate` draws no
  update prompt and no Renew; `signInWithBrowser()` never returns `.confirm`; the generated
  `clientOptions` omits `pinnedReleaseKeys`, so `configureUpdate` is documented.
- Added: Godot component tabs generated from the addon's `class_name`s with a drift test
  (`godotKit.ts`, `godotKit.test.ts`); the SwiftUI tabs carry the status badge; `layerTable.test.ts`
  checks the shipped names in the layer table of `build/ui/index.mdx`, row by row, per SDK.
- The native lanes are new, so their failures in sources this package does not change are
  registered once in `advisory-baseline.json` (20 blocks: `install.md`, `offline.md`,
  `ship-builds/packages`, `first-product.md`, and the Kotlin and Kotlin UI READMEs). It may only
  shrink from here.
- AssetLib: `SYSTEM_FEEDS` gives the Godot feed `license: "MIT"` and `minGodotVersion: "4.4"`, and
  the release declares the brand icon. The bootstrap never overwrites an existing feed, so an
  operator sets License `MIT` and Oldest editor `4.4` on the platform's Godot feed in the console
  once; the icon and description reach the listing with the next publish.

## Open (blocks `in-review`)

- The newcomer dry run per SDK is not recorded: it needs a local Polaris Key and SP-41's `pkey dev`
  has not landed.
- The full green gate has not run. Run so far: the docs unit tests, `lint:docs`, the whole snippet
  suite on every lane (Swift, Kotlin, GDScript, TypeScript, Python), the docs build, `check:links`,
  `gen:check`, and the worker and admin `docsLinks` tests.
- Not done: the Compose and Godot tabs of `build/ui/theming.mdx` still say "Planned" for APIs that
  ship; the Kotlin and Swift sections of `build/install.md` still show `0.8.33` and the
  `polaris-key-platform-play` coordinate for Android; programme ids in the Godot README and the
  slimming of the SDK READMEs belong to SP-37.

## Acceptance criteria

- [ ] For each SDK, both lanes reach the eight checkpoints.
- [ ] Every code block on the new and changed pages compiles in its lane, and a deliberately broken block fails CI.
- [ ] A check fails when a page names a symbol the SDK does not export.
- [ ] Docs-links and the slug manifest pass.
- [ ] A newcomer dry run per SDK is recorded in the PR.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-45b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-45b done`.

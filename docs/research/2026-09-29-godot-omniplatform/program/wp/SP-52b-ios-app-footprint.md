# SP-52b Swift iOS app footprint: at least 25% smaller than 0.8.33

| Field       | Value                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08)) |
| Size        | 0.2–0.4 engineer-weeks                                                             |
| Depends on  | [SP-52](SP-52-swift-package-footprint.md)                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md)                                             |
| Role        | `pkey-sdk-porter`                                                                  |
| Plan mode   | no                                                                                 |
| Gates       | `ci:macos`                                                                         |
| Human input | none                                                                               |
| Repo        | `vladzaharia/polaris-key`                                                          |

## Split 2026-10-22 (triage)

Filed from [SP-52](SP-52-swift-package-footprint.md) by the program triage (`/Users/vlad/Repos/pk-wt/_lead/triage-2026-10-22.md`, size 1–2 days). SP-52 carries what is on staging; this package carries the rest.

On staging already: SP-52 on staging: registry archive under 6 MB, two fonts, vendored `libzstd`, `check-resolve-clones.sh`, the report-only `apple-footprint` job.

## Goal

Swift iOS app footprint: at least 25% smaller than 0.8.33. Done when every acceptance criterion holds and the green gate passes.

## Read first

- `AGENTS.md` (always), and the skill that applies, if any.
- The parent brief [SP-52](SP-52-swift-package-footprint.md), its Progress and Split notes.

## Corrections (2026-10-24)

From the SP-52b slice plan (`_lead/plans/UK-09b-UK-31-SP-52b-slices.md` §0). The code is the fact.

- **F1. The baseline is rebuilt on every run.** `sdks/swift/tools/measure-ios-footprint.sh` archives `v0.8.33`'s `sdks/swift` and builds the same size app (`tools/size-app`: `PolarisKey` + `PolarisKeyUI` + `PolarisKeyUpdate`, `Text("Hello").polarisKey(client)` plus `client.update.decide()`, iOS 18, Release arm64, unsigned) over both trees with the runner's toolchain, then compares the `zip -9` sizes of `Payload/`. No number is recorded (D-22: the CI figure on macos-26 is the acceptance; local figures are for development).
  - CI (macos-26, Xcode 26.6, run 39571880256): baseline 3,109,960 B, this tree 3,348,956 B (+7.7%). Target at most 2,332,470 B.
  - Planner's Mac (Xcode 27.1, 2ea16a0d5): baseline 3,067,895 B, this tree 3,512,909 B (+14.5%). Target at most 2,300,921 B; 1,211,988 B (34.5%) must go.
  - Reproduce: `PKEY_FOOTPRINT_KEEP=<dir> XCODEGEN=$(which xcodegen) _lead/heavy.sh sdks/swift/tools/measure-ios-footprint.sh` (about 9 minutes; network for the Sparkle clone and, on the baseline, facebook/zstd). It keeps both archives and link maps and writes `<dir>/footprint.json` (bytes per payload part, per module and per section, plus the target and delta). Never commit that directory.
- **F2. Where the bytes are** (planner's Mac, compressed bytes in the .ipa): binary 2,096,017 (0.8.33) to 2,732,034 (now); `PolarisKeyUI.bundle/*.lproj` (compiled String Catalog) 236,902 to 331,810; `PolarisKeyUICore.bundle/kit-copy.json` none to 191,755; fonts 349,252 (4 faces) to 237,188 (Rubik-Variable 146,610 + JetBrains Mono 90,578); brand PNGs and badges about 366,000 to 4,573. Linked code now: PolarisKeyUI 2.44 MB, Core 1.33 MB, UICore 0.93 MB, umbrella 0.34 MB, Platform 0.23 MB, Update 0.18 MB; at 0.8.33: Core 1.18 MB, Packs 1.04 MB, UI 0.64 MB, libzstd 0.42 MB. SP-52 removed packs and zstd (1.46 MB); the UK-07 kit added 2.7 MB.
- **F3. PolarisKeyUI ships two gates.** The size app's `.polarisKey(client)` (`PolarisKeyModel.swift:251`) wraps content in the legacy SP-S04 `PolarisGate` family; the UK-07 drop-in is `.polarisKeyGate(client)` (`Kit/PolarisKeyGate.swift:350`), which the docs, README and iOS sample document. Public SwiftUI types survive dead-stripping through their metadata, so every app links both. The legacy family is at least 759 KB of PolarisKeyUI's 2.44 MB linked code (D-17).
- **F4. The String Catalog is shipped but never read.** `Package.swift:214` processes `Localizable.xcstrings` into nine `.lproj` (332 KB compressed); no Swift source looks it up. The kit reads `kit-copy.json` through `KitCopy.bundled`. `build/ui/localization.mdx:47` wrongly says Swift receives the String Catalog (D-18).
- **F5. Release builds link the previews and fixtures** (`PolarisKeyPreviewState`, `PreviewStates.swift`, `PolarisKeyPreview`): about 144 KB of code (D-20).
- **F6. The CI comment was stale** ("13% LARGER ... 3.47 MB vs 3.07 MB", 2026-10-11). Refreshed in SP-52b.1. `ci-ok` already lists `apple-footprint`; making it required means dropping `continue-on-error` and "report only" from its name.
- **F7. The fonts are synced byte for byte** by `sdks/swift/tools/sync-brand-assets.sh` and checked by `BrandThemeTests.swift:270`. Brand already ships Latin woff2 subsets; JetBrains Mono stays (key and code fields).
- **F8. The staging tree had uncommitted edits** to `AGENTS.md` and `sdks/swift/tools/lint.sh`, not from this plan (a note for the lead).

### Measured by SP-52b.1 (2026-10-24)

`PKEY_FOOTPRINT_KEEP=<dir> XCODEGEN=$(which xcodegen) _lead/heavy.sh sdks/swift/tools/measure-ios-footprint.sh` on Xcode 27.1 (27A9275), tree `4f0a1dd16` plus the script change; `zip -9` of `Payload/`, compressed bytes:

| Item                                    |   0.8.33 (baseline) | now (current) | target (-25%) |
| --------------------------------------- | ------------------: | ------------: | ------------: |
| .ipa                                    |           3,067,895 |     3,512,908 |     2,300,921 |
| Binary `SizeApp`                        |           2,096,017 |     2,732,033 |             - |
| `PolarisKeyUI.bundle/*.lproj`           |             236,902 |       331,810 |             - |
| `PolarisKeyUICore.bundle/kit-copy.json` |                   - |       191,755 |             - |
| Fonts (Rubik-Variable + JetBrains Mono) |   349,252 (4 faces) |       237,188 |             - |
| Brand PNGs and badges                   |             365,956 |         4,573 |             - |
| Linked: PolarisKeyUI                    |             639,899 |     2,439,040 |             - |
| Linked: PolarisKeyCore                  |           1,177,112 |     1,328,666 |             - |
| Linked: PolarisKeyUICore                |                   - |       932,316 |             - |
| Linked: PolarisKeyPacks / libzstd       | 1,043,012 / 421,327 |             - |             - |

Current is +14.5% over the baseline; 1,211,987 B must go. These match the planner's numbers (one byte apart on the binary). The CI figure (macos-26, Xcode 26.6) stays the acceptance (D-22).

## Scope

**In:**

- The one unmet criterion of SP-52: a Release arm64 iOS app with the kit and `decide()` is at least 25% smaller than at 0.8.33. Today it is +7.7% (3,348,956 B against 3,109,960 B, CI run 39571880256). When the target holds, `apple-footprint` stops being report-only. Nothing in the graph needs this to land (SP-62 does not).

**Out** (and where it belongs instead):

- Work owned by the packages in the Depends on and Unblocks rows, and everything SP-52 already shipped.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `measure-ios-footprint.sh` shows at least 25% smaller than the `v0.8.33` baseline in CI
- [ ] `apple-footprint` runs as a required, non-`continue-on-error` job
- [ ] The archive stays under 6 MB; `swift package resolve` still clones only Sparkle
- [ ] The green gate passes (`AGENTS.md`), including any drift gate this work package touches.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-52b in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-52b done`.

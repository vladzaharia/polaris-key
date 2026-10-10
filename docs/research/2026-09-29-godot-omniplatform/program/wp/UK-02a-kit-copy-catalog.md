# UK-02a Kit copy catalog: `packages/brand/kit-copy/` ICU catalog over `core.copy`, per-platform generators and the eight launch locale packs

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (must)                                                                                                                                                                                                                                                                                          |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                                                                                                                                                                                                                                                |
| Depends on  | [UK-02](UK-02-copy-fixtures-parity-plan.md), [SP-00](SP-00-parity-registry-plan.md)                                                                                                                                                                                                                                                                                   |
| Unblocks    | [UK-02b](UK-02b-ui-fixtures-parity.md), [UK-03](UK-03-ui-core.md), [UK-04](UK-04-web-components.md), [UK-05](UK-05-react-kit.md), [UK-07](UK-07-swiftui-ios.md), [UK-09](UK-09-compose-android.md), [UK-11](UK-11-godot-kit.md), [UK-12](UK-12-python-qt.md), [UK-13](UK-13-python-terminal.md), [UK-14](UK-14-node-terminal.md), [UK-15](UK-15-visual-qa-harness.md) |
| Role        | `pkey-implementer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                                                                 |
| Plan mode   | yes: executes the approved [`plans/UK-02.md`](../plans/UK-02.md)                                                                                                                                                                                                                                                                                                      |
| Gates       | plan mode (executes `plans/UK-02.md`); the generator's `--check` drift gate; rule 3 banners; every SDK suite's generated-file test                                                                                                                                                                                                                                    |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                             |

## Owner decision (2026-10-05): licence choice at sign-in

The owner decided on 2026-10-05 that every sign-in that binds a device asks the person which licence to use (**Choose a license for this device**, with an inline **Replace a device** on full licences), never silently mints a second auto-issued licence, and treats the rank-first rule as the preselected default only. The verbatim decision, the card API and the delegated decisions are in [`plans/I-04.md`](../plans/I-04.md), "Owner decision (2026-10-05): licence choice at sign-in"; that section wins over this brief where they differ. **The device wire does not change** (`PROTOCOL_VERSION` 4, no corpus change).

For this package: **add the copy keys** for the renamed device-limit screen:

- `deviceLimit.title`: "Replace a device";
- `deviceLimit.confirmTitle`: "Replace {device}?";
- `deviceLimit.consequence`: SIGN-IN.md's `signin.replace.consequence`;
- `deviceLimit.primary`: "Replace and continue".

They replace "Remove <device> and continue". _Amended 2026-10-05 (sign-in alignment):_ the hosted
card's `LicenseChoiceStep` copy lives in this catalog too, as the `signin.*` namespace that the
portal, the Worker pages and the kits all read (SIGN-IN.md §5.2, D-41).

## Sign-in alignment (2026-10-05): SIGN-IN.md

[`docs/design/SIGN-IN.md`](../../../../design/SIGN-IN.md) is the canonical sign-in experience, and `plans/I-04.md`
§F (the reconciliation, with delegated decisions 16–24) is its wire counterpart. Where this brief
differs from either, they win. Copy comes from SIGN-IN.md §5.2 (`signin.*`, US "license").
**No device-wire change** (`PROTOCOL_VERSION` 4, `corpusVersion` 2). For this package:

- Add the `signin.*` namespace of SIGN-IN.md §5.2 (incl. `signin.choice.devices`, `signin.choice.origin.*`, `signin.term.*`; no `signin.choice.accountWide`, `signin.consent.licenseLineAccount`, `signin.desktop.toastAccount` or `signin.cli.licenseAccount`: owner decision 2026-10-05, no 'Account-wide' label) over `core.copy`; the portal `AuthCard`, the Worker's `renderAuthCard()` and the emails read it (D-41).

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

- Add the new `signin.*` keys of SIGN-IN.md §5.2 (`signin.consent.licenseInApp`, `signin.return.signedInShort`, `signin.return.chooseInApp`, `signin.desktop.notifyChoose`, `signin.done.start`, `signin.replace.lede`, `signin.replace.openSystem`, `signin.menu.signIn`), and the O-17 vocabulary once `fix/drop-account-wide-label` lands.

## Goal

One ICU catalog holds every kit string, every SDK gets its generated catalog in the launch locales, and the drift gate fails on a hand edit.

## Why

Copy drift between kits was a root cause in critique round 1, and every audit found hard-coded strings outside the copy bags (§4.7). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md` (plan mode).
- `plans/UK-02.md` (approved)
- [UI-KITS.md](../../../../design/UI-KITS.md) §4.7, §1.5 rule 11 (copy rules)
- Today's copy bags: React `theme.ts`, Swift `PolarisCopy`, Kotlin `strings.xml`, Godot `pkey_ui_copy.gd`

## Scope

**In:**

- `kit-copy/en.json` with every key the plan lists; references to `core.copy` keys instead of duplicates.
- Generators for every platform format the plan names, with GENERATED banners.
- The eight non-English packs, glossary-driven, marked `reviewed: false`.
- Plural and select via ICU; platform words ("this iPhone", "this Mac") as selects.

**Out** (and where it belongs instead):

- Kits switching to the catalog (→ each kit).
- The string lint (→ UK-15).

## Design notes

- Translations are produced in this package and reviewed by a native speaker later (lead decision, 2026-10-05); that review is not a merge blocker.
- CJK packs must not introduce line-break opportunities inside keys or user codes.

## Steps

1. Confirm `plans/UK-02.md` is approved (merged).
2. Implement exactly the plan, in its order.
3. Run the gates in the header.

## Implementation record (UK-02a, 2026-10-05)

Built on SP-00's core copy slice (`copy.en.json`, `copy.schema.json`, the six generated core copy
modules). The code is the fact; where it differs from plans/UK-02.md the choice is recorded here,
each the recommended option.

- **Catalog size.** `kit-copy/en.json` holds 479 keys: 250 kit keys over the §4.1 components,
  parts, `common` and `a11y`, plus SIGN-IN.md §5.2's `signin.*` namespace (229 keys, `main` after
  the one-form sign-in, with the eight keys of the section above), including the `deviceLimit.*`
  keys of the owner decision above.
- **Two SIGN-IN.md §5.2 corrections** (recorded there, on top of `main`'s text):
  `signin.cli.headless` says "this computer" (AGENTS rule 4, "device, not machine"), and
  `signin.key.owned` is not a kit key because `main`'s core copy now gives
  `core.codes.license_owned.message` the same words (the duplicate ban); surfaces read the core
  key. `signin.again` stays a kit key: `core.codes.step_up_required.title` became "Confirm it's
  you" on `main`.
- **No license-type label** (owner, 2026-10-05: every license is account-bound). Every license
  shows its tier pill and "N of M devices"; `signin.choice.accountWide`,
  `signin.consent.licenseLineAccount`, `signin.desktop.toastAccount`, `signin.cli.licenseAccount`
  and `signin.origin.*` are gone. The origin is plain words on the meta line,
  `signin.choice.origin.{signIn,key,keyAdded,storeKey,storeKeyAdded,store,developer,free,gift,org}`
  ("From signing in", "Key ending {last6}", "{store} key ending {last6}", "From {store}" …), key
  names aligned with `fix/drop-account-wide-label` (not yet on `main`). The picker's short option
  is `signin.choice.picker.{signIn,key,storeKey,store}` ("{tier} · Sign-in", "{tier} · Key
  …{last6}", "{tier} · {store} key …{last6}", "{tier} · {store}"). The mixed rule (a key license
  hides its counter beside a sign-in license) is kit behaviour, not copy.
- **Components follow `main`'s UI-KITS §4.1:** SignIn's states are the one form's (methods,
  handoff, code, finishing, choose, replace, key, done, error, expired), SignInHandoff gains
  `no-browser` and `code`, and LicenseChoice drops `account-wide` and gains `grant-expired`.
- **Namespaces.** `signin` joins the plan's first-segment list. `part`, `common`, `a11y` and
  `signin` are shared groups: a component state may list their keys but need not. Every other key
  must be listed by a `components.json` state, which may also list `core.*` keys.
- **Closed argument set.** The plan's set plus the arguments SIGN-IN.md §5.2 uses (`app`,
  `developer`, `provider`, `code`, `email`, `place`, `name`, `origin`, `term`, `license`,
  `position`, `thisDevice`, `newDevice`, `platform`, `when`, `url`, `identity`, `tier`, `command`,
  `idp`, `host`, `s`, `last6`) and `prefix` (the cut-short key error). Integer (plural) arguments add
  `seconds`, `left` and `n`.
- **ICU subset, tightened from D5** so every target expresses it natively: one complex argument
  per message (a plural or the formFactor select, never both); plural case text holds `#` and text
  only, with plain arguments outside the plural (Swift plural substitutions); no `%`, no ICU
  apostrophe quoting. Variants are not allowed on plural or select messages, and D13 title case
  skips them.
- **The duplicate ban and the vocabulary ban apply to English**, the source; translations are
  checked for keys, arguments, plural categories, control characters and "Polaris Key".
- **Core packs (D4).** `copy.de/es/pt-BR/it/ja/ko/zh-Hans.json` are written, `reviewed: false`,
  and follow `main`'s core copy fixes (`license_owned`, `step_up_required`, `server-error`);
  `copy.schema.json` gains the optional `reviewed` flag and `gen constants` now validates every
  `copy.<locale>.json` (keys, placeholders, locale, reviewed) without emitting it. `copy.fr.json`
  stays with SP-03: until it lands, the French kit tables carry English core strings, listed in
  each table's `KIT_COPY_CORE_FALLBACK` (`CORE_PACK_PENDING` in `scripts/kit-copy.ts`); any other
  missing core pack fails the generator.
- **Variants in the outputs.** Swift maps `macos`/`ios`/`tv` to device variations; Kotlin and
  Godot carry `<name>__<platform>` entries and `msgctxt <platform>` in every locale (the locale's
  own value outside English, so a lookup never leaves the locale); web, Node and Python expose an
  English `KIT_COPY_VARIANTS` map.
- **Swift (risk §8).** `.xcstrings` builds with the Swift 6.4 toolchain, so no `.strings` /
  `.stringsdict` fallback. `Package.swift` gains `defaultLocalization: "en"` and
  `.process("Resources/Localizable.xcstrings")`.
- **Web.** `src/generated/kit-copy/<locale>.json` plus `index.ts` (`KitCopyKey`, `KIT_COPY_EN`,
  `loadKitCopy(locale)` with JSON import attributes), exported as `@polaris-key/brand/kit-copy`;
  the brand `tsconfig.json` turns on `resolveJsonModule`, and the brand package takes `ajv` as a dev
  dependency for the source schemas.
- **Python.** `polaris_key/ui/__init__.py` is not generated: `main`'s UI foundations work owns it
  (hand-written), so the generator writes only `kit_copy_generated.py` and the `.pot` beside it.
- **Translation registers.** de formal "Sie", fr "vous", es "tú" (neutral international), pt-BR
  "você", it "tu", ja です・ます, ko 해요체, zh-Hans "你". Terminal prompts keep "(y/N)" in every locale.
  Each pack's `$comment` says it is unreviewed; the native-speaker review is a release follow-up.

## Acceptance criteria

- [x] Every key has a value in all nine locales; a missing key fails the generator (`validateKitCopy`, tested in `packages/brand/test/kit-copy.test.ts`).
- [x] The generator's `--check` mode is in the green gate and passes (`gen brand` writes the kit copy outputs; `test/generated.test.ts` runs `run({ check: true })`).
- [x] The green gate passes (AGENTS.md), including every drift gate listed in the header (`gate.sh`, scope changed, 2026-10-05: `gen brand --check`, `gen constants --check`, pytest, `swift test`, the Godot suite and `pnpm format` included).

## Verify

```sh
mise exec node@22 -- pnpm gen brand --check
mise exec node@22 -- pnpm gen constants --check
```

## Hand-off

Kits read only generated catalogs. UK-15's string lint diffs visible strings against these keys.

The role agent sets `--set UK-02a in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-02a done`.

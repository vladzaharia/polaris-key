# P1-01 Create `sdks/godot` from the prototype, with a corpus mirror and CI runner

| Field       | Value                                                                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                                                                                                                                                |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                              |
| Depends on  | none                                                                                                                                                                                                              |
| Unblocks    | [P1-02](P1-02-godot-core.md), [P1-11](P1-11-godot-export-plugin.md)                                                                                                                                               |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                          |
| Plan mode   | yes: `program/plans/P1-01.md` must be approved (merged) before any code                                                                                                                                           |
| Gates       | plan mode; corpus mirror (rule 1, `pnpm gen:corpus -- --check` guards it); a new CI job (editor **and** release template); generated `reference/corpus.mdx` (rule 3, `pnpm --filter @polaris-key/docs gen:check`) |
| Human input | plan approval; adding the new `godot` CI job to the branch's required checks (repository settings)                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                         |

## Goal

`sdks/godot/` is a Godot 4 project that holds the addon `addons/polaris_key/` (moved from the
research prototype with its history) and a headless test runner. The runner reads a
generator-owned mirror of `conformance/corpus/v2/` from `res://` and passes all 36 `jwsCases`
plus the SHA-512 and Ed25519 vectors on the Godot 4.7.2 editor, on an official 4.7.2 Linux
release template, and on the 4.4 editor (the source-compatible floor). A new `godot` CI job runs
all three. `pnpm gen:corpus -- --check` fails if the Godot mirror drifts by one byte.

## Why

The pure-GDScript Ed25519/SHA-512/JWS verifier exists only as research code
([`prototype/README.md`](../../prototype/README.md), report
[§14](../../README.md#14-the-prototype)), outside every gate. Moving it is the first task of
P1. Godot must join the corpus as the sixth language
([§5.11](../../README.md#511-conformance-and-ci)), and PARITY requires the runner on the
editor **and** a release template, because official 4.6+ templates ignore `--path`, `--script`
and `--main-pack` ([PARITY §4.3](../../PARITY.md#43-runners), notes/A5 §1). An exported pack can
only rely on `res://`, so the corpus needs a generator-owned mirror there, exactly like Swift's
([PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data)).

The report and notes/A2 §5.3 say "no mirror is needed" because a desktop editor run can read
`../../conformance/`. That holds for the editor only; PARITY and this work package's graph entry
(`corpus:mirror`) supersede it so the same runner works from an exported pack, and later on web
and devices.

## Read first

- `AGENTS.md` (rule 1, rule 3, the green gate) and `CLAUDE.md` (plan mode).
- `program/plans/README.md` (plan format) and the lead's rules on corpus hotspots in
  [`program/README.md`](../README.md) §5.
- Report [§5.1](../../README.md#51-shape-and-api), [§5.11](../../README.md#511-conformance-and-ci),
  [§5.12](../../README.md#512-packaging-and-versions), [§14](../../README.md#14-the-prototype).
- [`prototype/README.md`](../../prototype/README.md) and the prototype itself.
- [notes/A2](../../notes/A2-sdk-port.md) §5 (the runner sketch in §5.3, the inventory in §5.4).
- [notes/A5](../../notes/A5-godot-empirical.md) §1 (templates, Range download of one template
  binary), §2 (JSON quirks, int64 and shift gotchas), §3 (the verifier and its results).
- [notes/E4](../../notes/E4-godot-ecosystem.md) §1.2 (`.uid` files), §7 (headless testing),
  §9.3 (4.4 floor: no `@abstract`, no variadic arguments).
- Code: `tools/sign-corpus.ts:34-46` (`SWIFT_V2_RESOURCES`), `:2311-2378` (`reconcile`,
  `main`); `.github/workflows/ci.yml`; `sdks/swift/Package.swift:107` (how Swift bundles its
  mirror); `packages/docs/scripts/gen-reference.mjs:380-382` (the generated corpus page text).

## Scope

**In:**

- **Project skeleton** `sdks/godot/`: `project.godot` (a dummy main scene, which templates
  require, and `application/run/main_loop_type="PKeyTestRunner"`), `.gitignore` (`.godot/`,
  `build/`), `export_presets.cfg` with one preset `Conformance (Linux)` (`include_filter="*.json"`,
  `binary_format/embed_pck=false`, export path under `build/`), and a short contributor
  `README.md`.
- **Move, with history** (`git mv`, `.uid` sidecars included) from
  `docs/research/2026-09-29-godot-omniplatform/prototype/`:
  - `addons/polaris_key/crypto/sha512.gd` → `addons/polaris_key/core/crypto/sha512.gd`;
  - `crypto/ed25519_fast.gd` → `core/crypto/ed25519.gd`; `crypto/ed25519_tweetnacl.gd` →
    `core/crypto/ed25519_ref.gd`; `jws.gd` → `core/jws.gd` (the §5.1 layout);
  - `tests/suite_{sha512,ed25519,platform,profile}.gd`, `vectors/{ed25519,sha512}.json` and
    `vectors/gen_ed25519.mjs` → `sdks/godot/tests/…`; `tests/cli.gd` → `tests/runner.gd` and
    `tests/suite_jws.gd` → `tests/suite_conformance.gd` (both rewritten below).
- **Rename** the global classes to the SDK prefix: `PKSha512` → `PKeySha512`, `PKEd25519Fast` →
  `PKeyEd25519`, `PKEd25519Ref` → `PKeyEd25519Ref`, `PKJws` → `PKeyJws`, `PKTestRunner` →
  `PKeyTestRunner`. No behaviour change.
- **Addon shell:** `plugin.cfg` (`name="Polaris Key"`, `version="0.1.0"`), `plugin.gd`
  (`@tool extends EditorPlugin`, empty), `polaris_key.gd` with `const SDK_VERSION := "0.1.0"`.
- **Runner:** `tests/runner.gd` (`class_name PKeyTestRunner extends SceneTree`). It runs suites
  only when the user arguments contain `--pkey-test <suite>[,<suite>]`; with none it behaves as
  a plain `SceneTree`, so the project still runs scenes. It prints the engine version, debug or
  release, editor or template, then one line per case and a summary, and quits with exit code 1
  on any failure. Suites may be coroutines. `ci` is the CI set.
- **Conformance suite** `tests/suite_conformance.gd`: every `jwsCases` entry from
  `res://tests/corpus/v2/cases.json`, asserting the verdict, the `kid` and the decoded document
  (the prototype's derived `corpus_jws.json` and `gen_corpus.mjs` are not carried over).
- **Corpus mirror:** `GODOT_V2_RESOURCES` in `tools/sign-corpus.ts` →
  `sdks/godot/tests/corpus/v2/`, written and `--check`-guarded for all three files exactly like
  Swift's; the header comment updated.
- **One entry point** `sdks/godot/tools/run_tests.sh`: `--import`, then the `ci` suites on
  `$GODOT_BIN`; when `$GODOT_TEMPLATE` is set, `--export-pack "Conformance (Linux)"`, copy the
  template binary beside the pack as `build/pkey_conformance.x86_64`, and run it. Root
  `package.json` `test:all` calls it.
- **CI job `godot`** in `.github/workflows/ci.yml`: editor legs on 4.7.2 and the latest 4.4.x,
  a template leg on the official 4.7.2 `linux_release.x86_64`. Cache the downloads.
- **Corpus, runner and gate text** (the rows marked P1-01 in the inventory below), then
  regenerate `reference/corpus.mdx`.
- A pointer in `prototype/README.md` and one line under report §14 saying the code now lives in
  `sdks/godot/`.

**Out** (and where it belongs instead):

- Strict JSON, claims, trust, clock, cache, transport, the remaining `cases.json` sections and
  `fingerprint.json` device ids (→ [P1-02](P1-02-godot-core.md)); `gate-matrix.json`
  (→ [P1-03](P1-03-godot-license.md)); fingerprint components (→ [P1-05](P1-05-godot-devices.md)).
- The product-facing "four SDKs / five languages" statements (→ [P1-12](P1-12-godot-release.md)).
- The export plugin and build stamp (→ [P1-11](P1-11-godot-export-plugin.md));
  `release-godot.yml` (→ [P1-12](P1-12-godot-release.md)).
- New corpus vectors (Ed25519 malleability, lone surrogate, control characters; report
  [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #19)
  (→ [P3-02](P3-02-wire-v4-contract-corpus.md)).
- Web, Android and iOS runs of the runner (unowned; see Hand-off).
- Filling `sdks/godot/parity.json` (→ P1-02 onwards). If [P1b-01](P1b-01-parity-registry.md) has
  already landed, create the manifest here with every entry `planned`; otherwise P1b-01 creates it.

## Design notes

**Decisions the plan must put to the human**, each with the recommendation shown:

1. **`valid-nul-byte-in-string`.** A Godot `String` cannot hold U+0000; the verdict is right but
   the decoded document differs (notes/A5 §2). WIRE-CONTRACT-V3 §10 forbids local tolerances and
   rule 1 forbids weakening runners. Options: (a) a WIRE-CONTRACT-V3 §10 ledger entry plus a
   generator-emitted, per-case annotation that the decoded string is lossy in Godot, which the
   Godot runner honours for that one case only while still asserting the verdict; (b) the
   contract forbids U+0000 in signed documents and the case flips to reject in every SDK (an
   all-languages behaviour change). **Recommend (a).** With (a) the plan must confirm that the
   Node, Python, Swift and React runners ignore the new field.
2. **Mirror path** `sdks/godot/tests/corpus/v2/` (recommended), not inside the addon, which
   would ship 1.4 MB of vectors into games.
3. **CI engines:** 4.4.x editor (floor, README decision 11), 4.7.2 editor, 4.7.2 release
   template. If the prototype does not parse on 4.4, record the fix or escalate the floor.
4. **Template download:** extract only `linux_release.x86_64` from the 1.28 GB `.tpz` with HTTP
   Range (notes/A5 §1), or cache the full set; either is fine, record which.

**Corpus regeneration and SDKs that follow.** No vector changes, `corpusVersion` stays 2 and no
SDK behaviour changes. `pnpm gen:corpus` gains a second mirror. Under option (a), the one
annotated case is regenerated and every runner is checked to ignore the field. From this work
package on, every corpus change (P0-04, P1-09, P1b-04, P3-02, …) must keep the Godot job green,
and its plan must name Godot.

**Pitfalls:**

- Godot often exits 0 after a script parse error. The CI step must also fail when the log
  contains `SCRIPT ERROR` or `Parse Error`, and the import step must not be `|| true`.
- `class_name` globals need `--import` first (notes/E4 §7).
- The editor and the template use the same invocation, because the runner is the main loop:
  `godot --headless --path sdks/godot -- --pkey-test ci` and
  `build/pkey_conformance.x86_64 --headless -- --pkey-test ci`.
- Negative shifts in constant expressions are parse errors in debug builds (notes/A5 §2(f)).
  The rename must not reformat the crypto code.
- Keep 4.4 syntax: typed dictionaries are fine; `@abstract` and variadic arguments are not.
- The moved `tests/vectors/*.json` are compact JSON: add them to `.prettierignore` (as the
  prototype's vectors are) or format them; `pnpm format` checks `**/*.json`.
- The generated mirror is prettier-formatted by the generator, byte-identical to the source.

**Inventory: every place that enumerates the language set** (notes/A2 §5.4, re-checked against
the tree). P1-01 edits the rows about the corpus, runners, mirrors and the gate; P1-12 edits the
rest once the SDK ships.

| Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Owner             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `AGENTS.md` repo map (`:15-37`, add `sdks/godot/`), green gate (`:77-100`), rule 1 (`:107-110`, the mirror)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P1-01             |
| `CONTRIBUTING.md:42-51` (gate, `test:all`), `:84` ("four runners, the Swift mirror")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1-01             |
| `packages/docs/src/content/docs/build/wire/corpus.md:3,9,22-35,67-84,94,103,131,146`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1-01             |
| `packages/docs/src/content/docs/contribute/corpus.md:3,11,31,51-66`; `agents/conventions.md:58`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P1-01             |
| `packages/docs/scripts/gen-reference.mjs:380-382` → regenerate `reference/corpus.mdx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1-01             |
| `tools/sign-corpus.ts:1-13,2119`; `conformance/runners/node/{corpusV2.test.ts:1-5, fingerprint.test.ts:4}`; root `package.json` `test:all`; `.github/workflows/ci.yml`                                                                                                                                                                                                                                                                                                                                                                                                 | P1-01             |
| `AGENTS.md:8-9,118`; `CONTRIBUTING.md:3-4,65,81`; `README.md:4,58`; `SECURITY.md:55`; `docs/security/WIRE-CONTRACT-V3.md:5`; `docs/PRIVACY.md:31`; `.husky/pre-commit` comment                                                                                                                                                                                                                                                                                                                                                                                         | P1-12             |
| docs site: `index.mdx:3`, `start/index.md:9,99-103`, `start/concepts.md:10`, `build/index.md:16,26`, `build/sdks/index.md` (+ new `godot.mdx`), `build/wire/index.md:26,78`, `build/wire/envelope.md:19`, `contribute/index.md:8-9,28-29`, `contribute/waves.md:3,29,35`, `contribute/setup.md:79`, `agents/index.md:57-58`, `admin/bundles.md:11`                                                                                                                                                                                                                     | P1-12             |
| code comments: `packages/client-core/src/claims.ts:2`, `bundle.ts:24,68`; `packages/client-core/README.md:12`; `packages/worker/test/bundles.test.ts:7`; `sdks/python/src/polaris_key/core/{jws.py:13,108, bundle.py:16,65, models.py:193}`, `_version.py:20`; `sdks/python/tests/{test_conformance.py:5, test_bundle_local.py:3}`; `sdks/swift/Sources/PolarisKeyCore/{Bundle.swift:24,62, Trust.swift:3, DeviceID.swift:24}`; the device-id formula comments `packages/sdk-node/src/devices/deviceId.ts:54` and `sdks/python/src/polaris_key/devices/deviceid.py:86` | P1-12             |
| `packages/cli/src/manifest.ts:161-178` + `packages/cli/README.md:104` (`pkey trust` GDScript snippet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | P1-11             |
| `tools/gen-mirrors.ts:248-258` (`gdscript` target)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P1-04             |
| `packages/admin/src/views/ProductOverview.tsx` quick-start snippet (optional Godot tab)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | unowned, optional |

Historical documents (`docs/security/2026-08-26-security-audit.md`, `findings/*`,
`arch/business-model-fit.md`, `docs/superpowers/`, `.changeset/*`) stay as written.

## Steps

1. Write `program/plans/P1-01.md` (summary, corpus, SDKs, rollout, the four decisions above,
   acceptance). Set the status to `awaiting-approval` and stop.
2. After approval: create the skeleton; `git mv` the files; rename the classes; run the moved
   suites on the 4.7.2 editor to confirm nothing changed.
3. Write the runner and `suite_conformance.gd` against the mirror path.
4. Add the Godot mirror to `tools/sign-corpus.ts`; run `pnpm gen:corpus`; commit the mirror.
5. Write `tools/run_tests.sh`; export the pack and run it on the release template locally.
6. Add the CI job; run it on the 4.4 editor and fix syntax, or escalate.
7. Update the P1-01 rows of the inventory; run `pnpm --filter @polaris-key/docs gen`.
8. Add the prototype pointers; run the green gate.

## Acceptance criteria

- [ ] The approved plan is merged before the first code commit.
- [ ] `git log --follow sdks/godot/addons/polaris_key/core/crypto/ed25519.gd` reaches the
      prototype commits, and every `.gd` file has its `.uid` beside it.
- [ ] `pnpm gen:corpus` writes `sdks/godot/tests/corpus/v2/{cases,gate-matrix,fingerprint}.json`
      byte-identical to `conformance/corpus/v2/`; changing one byte in the Godot mirror makes
      `pnpm gen:corpus -- --check` exit 1 (shown in the PR description).
- [ ] On the 4.7.2 editor, `-- --pkey-test ci` reports `jwsCases` 36/36 (verdict, `kid` and
      decoded document, per the plan's NUL decision), SHA-512 24/24 and Ed25519 26/26 for both
      `PKeyEd25519` and `PKeyEd25519Ref`, and exits 0; a corrupted vector makes it exit 1.
- [ ] The same result from the exported pack on the official 4.7.2 Linux release template.
- [ ] The same result on the 4.4.x editor, or the plan's recorded decision on the floor.
- [ ] The `godot` CI job is green on the PR and fails on a deliberately introduced parse error.
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes and the corpus pages name the Godot
      runner and mirror.
- [ ] The green gate passes (`AGENTS.md`), including `pnpm gen:corpus -- --check` and
      `pnpm format`.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus
mise exec node@22 -- pnpm gen:corpus -- --check
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
GODOT_BIN=godot-4.4.1 sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm format
```

## Hand-off

- **Layout:** `sdks/godot/addons/polaris_key/{plugin.cfg, plugin.gd, polaris_key.gd, core/…}`,
  tests under `sdks/godot/tests/`, the mirror at `res://tests/corpus/v2/`.
- **Classes:** `PKeySha512`, `PKeyEd25519.verify(sig, msg, pk) -> bool`, `PKeyEd25519Ref`,
  `PKeyJws.verify(jws, trust, typ, max_payload_bytes) -> Variant` (null on any failure), and
  `PolarisKey.SDK_VERSION`. P1-02 reshapes `PKeyJws` behind the strict JSON module.
- **Runner contract:** `-- --pkey-test <suite>[,<suite>]`; each later work package registers its
  suite in the `ci` set, and CI and `tools/run_tests.sh` stay the only entry points.
- Web, Android and iOS runs (a web export under headless Chromium, device runs) are not owned by
  any work package yet; S-04 measures performance only.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-01 done` in the
  PR that completes the work.

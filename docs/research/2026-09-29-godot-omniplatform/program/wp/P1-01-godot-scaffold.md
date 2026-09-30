# P1-01 Create `sdks/godot` from the prototype, with a corpus mirror and CI runner

| Field       | Value                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                                                                                                                                                                                                                                                          |
| Size        | 1–1.5 engineer-weeks                                                                                                                                                                                                                                                                                                        |
| Depends on  | none                                                                                                                                                                                                                                                                                                                        |
| Unblocks    | [P1-02](P1-02-godot-core.md), [P1-11](P1-11-godot-export-plugin.md)                                                                                                                                                                                                                                                         |
| Role        | `pkey-godot-engineer` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                                                                                                                    |
| Plan mode   | yes: `program/plans/P1-01.md` must be approved (merged) before any code                                                                                                                                                                                                                                                     |
| Gates       | plan mode; corpus mirror (rule 1, `pnpm gen:corpus -- --check` guards it); a new CI job (editor **and** release template); generated `reference/corpus.mdx` (rule 3, `pnpm --filter @polaris-key/docs gen:check`); the Godot parity manifest (`pnpm parity:check`, generated `reference/parity.mdx`) once P1b-01 has landed |
| Human input | plan approval; adding the new `godot` CI job to the branch's required checks (repository settings)                                                                                                                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                   |

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
  mirror); `packages/docs/scripts/gen-reference.mjs:380-383` (the generated corpus page text).

## Scope

**In:**

- **Project skeleton** `sdks/godot/`, with the exact settings in plan §5.3:
  - `project.godot`: a dummy main scene, which templates require,
    `application/run/main_loop_type="PKeyTestRunner"` and `run/flush_stdout_on_print=true`;
  - `.gitignore` (`.godot/`, `build/`);
  - `export_presets.cfg` with one preset `Conformance (Linux)` (`include_filter="*.json"`,
    `binary_format/embed_pck=false`, export path under `build/`);
  - a short contributor `README.md`.
- **Move, with history** (`git mv`, `.uid` sidecars included) from
  `docs/research/2026-09-29-godot-omniplatform/prototype/`:
  - `addons/polaris_key/crypto/sha512.gd` → `addons/polaris_key/core/crypto/sha512.gd`;
  - `crypto/ed25519_fast.gd` → `core/crypto/ed25519.gd`; `crypto/ed25519_tweetnacl.gd` →
    `core/crypto/ed25519_ref.gd`; `jws.gd` → `core/jws.gd` (the §5.1 layout);
  - `tests/suite_{sha512,ed25519,profile}.gd`, `vectors/{ed25519,sha512}.json` and
    `vectors/gen_ed25519.mjs` → `sdks/godot/tests/…`; `tests/suite_jws.gd` →
    `tests/suite_conformance.gd` (rewritten below);
  - the prototype keeps its runner `tests/cli.gd` (`PKTestRunner`), `tests/suite_platform.gd` and
    `tests/http_probe.gd` as the spike-probe harness (plan §5.2, decision 8), and
    `vectors/gen_corpus.mjs` is deleted.
- **Rename** the global classes to the SDK prefix: `PKSha512` → `PKeySha512`, `PKEd25519Fast` →
  `PKeyEd25519`, `PKEd25519Ref` → `PKeyEd25519Ref`, `PKJws` → `PKeyJws`. The runner class
  `PKeyTestRunner` is new, in a new file.
  - There is no behaviour change, except one, in its own commit: `PKeyJws` decodes the escape
    `\u0000` as U+FFFD on every engine (WIRE-CONTRACT-V3 §10, plan §5.4).
- **Addon shell:** `plugin.cfg` (`name="Polaris Key"`, `version="0.1.0"`), `plugin.gd`
  (`@tool extends EditorPlugin`, empty), `polaris_key.gd` with `const SDK_VERSION := "0.1.0"`.
- **Runner:** `tests/runner.gd` (`class_name PKeyTestRunner extends SceneTree`). It runs suites
  only when the user arguments contain `--pkey-test <suite>[,<suite>]`; with none it behaves as
  a plain `SceneTree`, so the project still runs scenes. It prints the engine version, debug or
  release, editor or template, then one line per case and a summary, and quits with exit code 1
  on any failure. Suites may be coroutines. `ci` is the CI set.
  - Suites follow the contract in plan §5.5: `run(t, args) -> bool`, explicit `t.check` calls and a
    closing coverage check, and never `assert`.
  - The rule is needed because release templates skip GDScript runtime error checks.
- **Conformance suite** `tests/suite_conformance.gd`: every `jwsCases` entry from
  `res://tests/corpus/v2/cases.json`, asserting the verdict, the `kid` and the decoded document
  (the prototype's derived `corpus_jws.json` and `gen_corpus.mjs` are not carried over).
- **Corpus mirror:** `GODOT_V2_RESOURCES` in `tools/sign-corpus.ts` →
  `sdks/godot/tests/corpus/v2/`.
  - It is written and `--check`-guarded for all three files, exactly like Swift's, through one list
    of corpus targets.
  - The header comment is updated.
  - The generator also writes `expect.docNulReplaced` for the one U+0000 case, with a
    WIRE-CONTRACT-V3 §10 entry (plan §2 and §4).
- **One entry point**, `sdks/godot/tools/run_tests.sh`:
  - `--import`, then the `ci` suites on `$GODOT_BIN`;
  - when `$GODOT_TEMPLATE` is set: `--export-pack "Conformance (Linux)"`, copy the template binary
    beside the pack as `build/pkey_conformance.x86_64`, and run it;
  - every step runs under a log watchdog and a timeout (plan §5.6).
  - Root `package.json` `test:all` calls it.
  - CI fetches the engines with `tools/fetch_godot.sh`, checked against `tools/godot.sha512`.
- **CI job `godot`** in `.github/workflows/ci.yml`: editor legs on 4.7.2 and the latest 4.4.x,
  a template leg on the official 4.7.2 `linux_release.x86_64`. Cache the downloads.
- **Corpus, runner and gate text** (the rows marked P1-01 in the inventory below), then
  regenerate `reference/corpus.mdx`.
- What remains of the prototype (plan §7):
  - `tests/cli.gd` defaults to `platform` and quits with 1, pointing to `sdks/godot`, for a suite
    that moved;
  - its `README.md` and `.gitignore`;
  - one line under report §14 and one under §5.11;
  - a pointer in `lowend/README.md`, if S-04 has merged.
- **Parity manifest** (plan §5.1), if P1b-01 has landed: the registry's `godot` entry and
  `sdks/godot/parity.json`, with every feature `planned` under the plan's owner table.

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
  already landed, create the manifest here with every entry `planned` (plan §5.1); otherwise
  P1b-01 creates it.
- Porting spike harnesses to the SDK: S-04's `prototype/lowend/` keeps copying the pre-move
  verifier and gets a pointer instead (plan §7).

## Design notes

**Decisions the plan must put to the human**, each with the recommendation shown. All four are
resolved in [`plans/P1-01.md`](../plans/P1-01.md) §8, with six more that measuring raised.

1. **`valid-nul-byte-in-string`.** A Godot `String` cannot hold U+0000; the verdict is right but
   the decoded document differs (notes/A5 §2). Measured 2026-09-30: when both sides are parsed by
   Godot, the comparison still passes, vacuously. 4.7.2 turns the U+0000 into U+FFFD on both
   sides, and 4.4.1 drops it from both (PARITY §6.3 #4). WIRE-CONTRACT-V3 §10 forbids local
   tolerances and rule 1 forbids weakening runners. Options: (a) a WIRE-CONTRACT-V3 §10 ledger
   entry plus a generator-emitted, per-case annotation that the decoded string is lossy in Godot,
   which the Godot runner honours for that one case only while still asserting the verdict; (b)
   the contract forbids U+0000 in signed documents and the case flips to reject in every SDK (an
   all-languages behaviour change). **Recommend (a).** With (a) the plan must confirm that the
   Node, Python, Swift and React runners ignore the new field.
   - **Resolved (plan §8):** (a), made exact rather than lossy.
     - The annotation is `expect.docNulReplaced`, the U+FFFD form of each such string.
     - `PKeyJws` decodes `\u0000` as U+FFFD on every engine.
     - The Godot runner asserts those strings exactly, so 4.4.1's dropped NUL fails.
2. **Mirror path** `sdks/godot/tests/corpus/v2/` (recommended), not inside the addon, which
   would ship 1.4 MB of vectors into games.
3. **CI engines:** 4.4.x editor (floor, README decision 11), 4.7.2 editor, 4.7.2 release
   template. If the prototype does not parse on 4.4, record the fix or escalate the floor. The
   latest 4.4.x is 4.4.1; there is no 4.4.2. The prototype passes on 4.4.1 unchanged (measured
   2026-09-30).
4. **Template download:** extract only `linux_release.x86_64` from the 1.28 GB `.tpz` with HTTP
   Range (notes/A5 §1), or cache the full set; either is fine, record which.

**Corpus regeneration and SDKs that follow.** No vector changes, `corpusVersion` stays 2 and no
shipped SDK changes behaviour (only the unreleased Godot `PKeyJws` gains the U+0000 rule).
`pnpm gen:corpus` gains a second mirror. Under option (a), the one annotated case is regenerated
and every runner is checked to ignore the field. From this work package on, every corpus change
(P0-04, P1-09, P1b-04, P3-02, …) must keep the Godot job green, and its plan must name Godot.

**Pitfalls:**

- A script parse error is not reliably reported by exit code (measured on 4.4.1 and 4.7.2):
  - `--import` exits 0. 4.4.1 prints the error; 4.7.2 prints nothing.
  - `--check-only` exits 0 on 4.7.2.
  - When the runner (the main loop) fails to load, `main/main.cpp` calls `OS::alert()`, then
    returns `EXIT_FAILURE`. On macOS 4.7.2 that alert is a modal `NSAlert`, which nobody can
    dismiss under `--headless`, so the run **hangs**; 4.4.1 on macOS aborts instead (SIGABRT, exit
    134). On Linux both print `Invalid MainLoop script base type` and exit 1. The main scene never
    loads, so a scene-based guard cannot help.

  So every step must fail when the log contains `SCRIPT ERROR`, `Parse Error`,
  `Failed to load script`, `Cannot get class` or `Invalid MainLoop`, and it needs a timeout. The
  import step must not be `|| true`. The plan's watchdog does this. It must not match a generic
  `ERROR:`: a container without fontconfig prints `ERROR: Unable to load fontconfig` on every
  run.

- Release templates skip GDScript runtime error checks (measured on 4.7.2): a method call on null,
  a missing key or index read and `assert(false)` all continue silently. The editor aborts the
  function instead. Suites therefore use explicit checks and a coverage check, never `assert`.
- Release templates block-buffer stdout, so set `application/run/flush_stdout_on_print=true` to
  keep logs in order.

- `class_name` globals need `--import` first (notes/E4 §7).
- The editor and the template use the same invocation, because the runner is the main loop:
  `godot --headless --path sdks/godot -- --pkey-test ci` and
  `build/pkey_conformance.x86_64 --headless -- --pkey-test ci`.
- Negative shifts in constant expressions are parse errors in debug builds (notes/A5 §2(f)).
  The rename must not reformat the crypto code.
- Keep 4.4 syntax: typed dictionaries are fine; `@abstract` and variadic arguments are not.
- The moved `tests/vectors/*.json` are not prettier-formatted: `ed25519.json` uses one-space
  indentation, and `sha512.json` uses Python's `json.dumps` style. `pnpm format` checks `**/*.json`,
  so the `.prettierignore` entry moves with them and the files stay byte-for-byte.
- The generated mirror is prettier-formatted by the generator, byte-identical to the source.

**Inventory: every place that enumerates the language set** (notes/A2 §5.4, re-checked against
the tree). P1-01 edits the rows about the corpus, runners, mirrors and the gate; P1-12 edits the
rest once the SDK ships.

| Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Owner             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `AGENTS.md` repo map (`:15-37`, add `sdks/godot/`), standalone toolchains (`:53-54`), green gate (`:77-100`), rule 1 (`:107-111`, the mirror)                                                                                                                                                                                                                                                                                                                                                                                                                          | P1-01             |
| `CONTRIBUTING.md:12-17` (setup), `:29-52` (gate, `test:all`), `:83-84` ("four runners, the Swift mirror")                                                                                                                                                                                                                                                                                                                                                                                                                                                              | P1-01             |
| `packages/docs/src/content/docs/build/wire/corpus.md:3,9,13-15,22-35,37-39,67-84,94,103,130-131,146`, plus a `docNulReplaced` paragraph (plan §6)                                                                                                                                                                                                                                                                                                                                                                                                                      | P1-01             |
| `packages/docs/src/content/docs/contribute/corpus.md:3,11,17-33,51-66,83`; `agents/conventions.md:28-44,58,86-87`; `contribute/waves.md:66` (drift-gate row); `contribute/setup.md:3,9,18,33-62` (toolchain, gate, `test:all`); `contribute/layout.md:9,27-29` (repo map); the corpus and setup rows `build/wire/index.md:78` and `contribute/index.md:26,29`                                                                                                                                                                                                          | P1-01             |
| `packages/docs/scripts/gen-reference.mjs:380-383` → regenerate `reference/corpus.mdx`; `:86`, a raw NUL byte that makes git treat the file as binary, becomes the escape `\u0000`                                                                                                                                                                                                                                                                                                                                                                                      | P1-01             |
| `tools/sign-corpus.ts:1-19` (`:2119` is historical and stays); `conformance/runners/node/corpusV2.test.ts:1-5`; root `package.json` `test:all`; `.github/workflows/ci.yml`; `.prettierignore` (the vectors entry); `packages/worker/test/attack/R12-secrets.test.ts:1036-1042` (add `sdks/godot/README.md` to the READMEs that must not publish a corpus key)                                                                                                                                                                                                          | P1-01             |
| `conformance/runners/node/fingerprint.test.ts:4-6` and `build/wire/corpus.md:85-89` (the fingerprint runners), once Godot runs `deviceIds`                                                                                                                                                                                                                                                                                                                                                                                                                             | P1-02             |
| `AGENTS.md:8-9,118`; `CONTRIBUTING.md:3-4,65,81`; `README.md:4,58`; `SECURITY.md:55`; `docs/security/WIRE-CONTRACT-V3.md:5`; `docs/PRIVACY.md:31`; `.husky/pre-commit` comment                                                                                                                                                                                                                                                                                                                                                                                         | P1-12             |
| docs site: `index.mdx:3`, `start/index.md:9,99-103`, `start/concepts.md:10`, `build/index.md:16,26`, `build/sdks/index.md` (+ new `godot.mdx`), `build/wire/index.md:26`, `build/wire/envelope.md:19`, `contribute/index.md:8-9,28`, `contribute/waves.md:3,29,35`, `contribute/setup.md:79`, `agents/index.md:57-58`, `admin/bundles.md:11`                                                                                                                                                                                                                           | P1-12             |
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
7. Add the parity registry entry and manifest (plan §5.1), if P1b-01 has landed.
8. Update the P1-01 rows of the inventory; run `pnpm --filter @polaris-key/docs gen`.
9. Trim the prototype to its probe harness (plan §7); run the green gate.

## Acceptance criteria

- [ ] The approved plan is merged before the first code commit.
- [ ] `git log --follow sdks/godot/addons/polaris_key/core/crypto/ed25519.gd` reaches the
      prototype commits, and every `.gd` file has its `.uid` beside it.
- [ ] `pnpm gen:corpus` writes `sdks/godot/tests/corpus/v2/{cases,gate-matrix,fingerprint}.json`
      byte-identical to `conformance/corpus/v2/`; changing one byte in the Godot mirror makes
      `pnpm gen:corpus -- --check` exit 1 (shown in the PR description).
- [ ] On the 4.7.2 editor, `-- --pkey-test ci` reports `jwsCases` 36/36 (verdict, `kid` and
      decoded document, with `valid-nul-byte-in-string` matching `docNulReplaced` exactly),
      SHA-512 24/24 and Ed25519 26/26 for both
      `PKeyEd25519` and `PKeyEd25519Ref`, and exits 0; a corrupted vector makes it exit 1.
- [ ] The same result from the exported pack on the official 4.7.2 Linux release template.
- [ ] The same result on the 4.4.1 editor, including the Linux x86_64 build CI uses (the floor
      stays 4.4; plan §8 decision 3).
- [ ] The `godot` CI job is green on the PR and fails on a deliberately introduced parse error.
- [ ] `pnpm --filter @polaris-key/docs gen:check` passes and the corpus pages name the Godot
      runner and mirror; git diffs `packages/docs/scripts/gen-reference.mjs` as text.
- [ ] If P1b-01 has landed: `sdks/godot/parity.json` lists all registry features as `planned`
      under the plan §5.1 owners, and `pnpm parity:check` passes and lists three Godot unowned
      gaps.
- [ ] The prototype's `tests/cli.gd` still runs `platform`, and a moved suite exits 1 with a
      pointer to `sdks/godot` instead of hanging.
- [ ] The green gate passes (`AGENTS.md`), including `pnpm gen:corpus -- --check` and
      `pnpm format`.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus
mise exec node@22 -- pnpm gen:corpus -- --check
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
GODOT_BIN=godot-4.4.1 sdks/godot/tools/run_tests.sh
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm format
```

## Hand-off

- **Layout:** `sdks/godot/addons/polaris_key/{plugin.cfg, plugin.gd, polaris_key.gd, core/…}`,
  tests under `sdks/godot/tests/`, the mirror at `res://tests/corpus/v2/`.
- **Classes:** `PKeySha512`, `PKeyEd25519.verify(sig, msg, pk) -> bool`, `PKeyEd25519Ref`,
  `PKeyJws.verify(jws, trust, typ := "", max_payload_bytes := 0, fast := true) -> Variant` (null
  on any failure), and `PolarisKey.SDK_VERSION`. P1-02 reshapes `PKeyJws` behind the strict JSON
  module.
  - The prototype keeps `PKTestRunner` (`tests/cli.gd`) for its `platform` and `outlet` probes; it
    is a separate Godot project, so the two runner classes never meet.
  - `polaris_key.gd` has no `class_name`: `PolarisKey` is the name of the autoload that P1-02
    registers.
  - Until then, read the constant with `preload("res://addons/polaris_key/polaris_key.gd").SDK_VERSION`.
- **Runner contract:** `-- --pkey-test <suite>[,<suite>]`. A suite is
  `func run(t: PKeyTestContext, args: PackedStringArray) -> bool`, reporting through `t.check` and
  ending with a coverage check. Each later work package registers its
  suite in the `ci` set, and CI and `tools/run_tests.sh` stay the only entry points.
- Web, Android and iOS runs (a web export under headless Chromium, device runs) are not owned by
  any work package yet; S-04 measures performance only.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-01 done` in the
  PR that completes the work.

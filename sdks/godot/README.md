# Polaris Key — Godot SDK (contributors)

A Godot 4 project holding the Polaris Key addon and its headless test runner. The addon is pure
GDScript: the engine has no Ed25519 and no SHA-512, so `addons/polaris_key/core/crypto/` carries
its own. Godot is the sixth language of the conformance corpus. Licence: MIT, like the rest of the
repository.

This package is the P1-01 scaffold: compact-JWS verify and the runner. The `PolarisKey` autoload,
strict JSON, trust, cache and transport arrive with P1-02 and later work packages.

## Layout

```text
sdks/godot/
  project.godot               main loop = PKeyTestRunner; flush_stdout_on_print
  export_presets.cfg          one preset, "Conformance (Linux)": the test pack
  parity.json                 the Godot parity manifest (conformance/parity/)
  addons/polaris_key/         the addon (the only directory a release ships)
    plugin.cfg, plugin.gd     editor shell
    polaris_key.gd            SDK_VERSION; becomes the PolarisKey autoload in P1-02
    core/jws.gd               PKeyJws: compact-JWS verify (WIRE-CONTRACT-V3 §1, §10)
    core/crypto/              PKeySha512, PKeyEd25519 (fast), PKeyEd25519Ref (TweetNaCl-style)
  tests/
    runner.gd                 PKeyTestRunner
    support/test_context.gd   PKeyTestContext: check() and info()
    suite_<name>.gd           one suite per file
    corpus/v2/                GENERATED mirror of conformance/corpus/v2/ — never edit
    vectors/                  hand-generated SHA-512 and Ed25519 vectors (byte-for-byte)
  tools/
    run_tests.sh              the one entry point, locally and in CI
    fetch_godot.sh            CI: download and hash-check the official Linux binaries
    godot.sha512              upstream SHA-512 pins for those downloads
```

## Running the tests

```sh
sdks/godot/tools/run_tests.sh                                   # godot on PATH, the ci suites
GODOT_BIN=/path/to/godot sdks/godot/tools/run_tests.sh          # a specific editor
GODOT_TEMPLATE=/path/to/linux_release.x86_64 sdks/godot/tools/run_tests.sh   # + exported pack
PKEY_TEST_SUITES=ed25519 sdks/godot/tools/run_tests.sh bench 20 # one suite, with suite args
```

- `GODOT_BIN` defaults to `godot` on `PATH`. Without an editor the script exits 2; it never skips.
- `GODOT_TEMPLATE` is optional. When set, the project is exported with
  `--export-pack "Conformance (Linux)"`, the template is copied beside the pack as
  `build/pkey_conformance.x86_64`, and the same suites run from the pack. On macOS, a template
  binary extracted from `macos.zip` (`godot_macos_release.universal`) works the same way.
- `PKEY_TEST_SUITES` defaults to `ci`; `PKEY_TEST_TIMEOUT` is per step, default 300 s.
- Logs land in `build/logs/<step>.log` (`build/` is git-ignored).

CI (`.github/workflows/ci.yml`, job `godot`) runs two legs: the 4.7.2 editor plus the official
4.7.2 `linux_release.x86_64` template, and the 4.4.1 editor (the floor). Both must print the same
corpus SHA-256.

## The runner protocol

The runner is the project's main loop, so the editor and an exported template use the same
invocation. Official 4.6+ templates ignore `--path`, `--script` and `--main-pack`, so nothing may
depend on them.

```sh
godot --headless --path sdks/godot -- --pkey-test ci
build/pkey_conformance.x86_64 --headless -- --pkey-test ci
godot --headless --path sdks/godot -- --pkey-test ed25519 bench 20   # args after the list go to every suite
```

- `--pkey-test <suite>[,<suite>]` selects suites; `ci` expands to the CI set (`SETS` in
  `tests/runner.gd`). Without `--pkey-test` the project is a plain `SceneTree`.
- Output: one `PKEY-TEST engine=… build=… target=editor|template …` header, then
  `PASS|FAIL <suite> <name>` and `INFO` lines, then `PKEY-TEST SUMMARY suites=N checks=N failed=N`.
  The exit code is 1 on any failure.
- A suite is `tests/suite_<name>.gd`, `extends RefCounted`, with
  `func run(t: PKeyTestContext, args: PackedStringArray) -> bool`. It may `await`. It fails if it
  does not load, returns anything but `true`, or reports zero checks. A new work package adds its
  suite to `SETS["ci"]`; `run_tests.sh` and CI stay the only entry points.

**Suites never use `assert` and never rely on a runtime error.** A release template skips GDScript
runtime checks: a method call on null, a missing key or index read (which returns null) and
`assert(false)` all continue silently, where the editor aborts the function. Report only through
`t.check(name, ok, detail)` and `t.info(text)`, and end every suite with a coverage check (vectors
evaluated equals vectors loaded, with a floor). Timing is `INFO`, never a check.

## The corpus mirror

`tests/corpus/v2/` is written by `pnpm gen:corpus` (`tools/sign-corpus.ts`, `CORPUS_TARGETS`) and
guarded by `pnpm gen:corpus -- --check`, exactly like the Swift mirror. **Never edit it**: change
the generator and regenerate. A JSON file there that the generator does not write fails the gate.
An exported pack can read only `res://`, which is why the mirror exists.

`PKeyJws` decodes the escape `\u0000` as U+FFFD on every engine (WIRE-CONTRACT-V3 §10), and the
conformance suite compares those strings against the generator's `expect.docNulReplaced`.

## Writing GDScript here

- **4.4 syntax is the floor.** Typed dictionaries are fine; `@abstract` and variadic arguments are
  not. Do not add `config/features` to `project.godot`, which would pin the project to one engine.
- **Commit every `.uid` with its script.** The first import writes it; `run_tests.sh` fails on an
  untracked one.
- **Never reformat the crypto files.** A negative shift in a constant expression is a parse error in
  debug builds.
- Godot's own JSON parser is lenient and turns every number into a float. P1-02 adds the strict
  pre-validation.

## Measured pitfalls

| Behaviour                         | 4.7.2                                                                 | 4.4.1                                                        | Consequence                         |
| --------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| `--import` with a parse error     | exit 0, prints nothing                                                | exit 0, prints the error                                     | watch the log; never `\|\| true`    |
| runner fails to load              | macOS: modal alert, the run hangs; Linux: exit 1 (`Invalid MainLoop`) | macOS: SIGABRT, exit 134; Linux: exit 1 (`Invalid MainLoop`) | watchdog and timeout                |
| runtime error in a suite          | editor aborts it; template continues silently                         | editor aborts it                                             | explicit and coverage checks        |
| `\u0000` in JSON                  | U+FFFD, plus a "Unicode parsing error" line                           | dropped                                                      | the §10 rule in `PKeyJws`           |
| `--export-pack`                   | works with no templates installed                                     | same                                                         | CI needs only the template binary   |
| slim container without fontconfig | `ERROR: Unable to load fontconfig` on every run                       | same                                                         | the watchdog ignores generic errors |

So every `run_tests.sh` step fails on `SCRIPT ERROR`, `Parse Error`, `Failed to load script`,
`Cannot get class` or `Invalid MainLoop` in its log, on its timeout, on a non-zero exit, and (for
runs) without a final `PKEY-TEST SUMMARY … failed=0`.

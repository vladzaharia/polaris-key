# P1b-04 Add `headers.json` and `config-matrix.json` to the corpus

| Field       | Value                                                                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                                                                                                            |
| Size        | 0.75–1 engineer-weeks                                                                                                                                                                                                      |
| Depends on  | [P1b-02](P1b-02-sdk-constants.md)                                                                                                                                                                                          |
| Unblocks    | [X-01](X-01-dotnet-sdk.md), [SP-08](SP-08-apple-platform-values.md)                                                                                                                                                        |
| Role        | `pkey-sdk-porter` (the plan is written first by `pkey-wire-planner`)                                                                                                                                                       |
| Plan mode   | **yes**: `program/plans/P1b-04.md` needs human approval before any code                                                                                                                                                    |
| Gates       | plan mode; the corpus drift gate (`pnpm gen:corpus -- --check`, the mirrors (Swift, Godot) included); all SDKs; the generated `reference/corpus.mdx` page (AGENTS rule 3); one corpus-touching package in flight at a time |
| Human input | approval of the plan, including the header vocabulary and the compatibility choice in Design notes                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                  |

## Goal

After an approved plan:

- corpus v2 gains two generated files, `headers.json` and `config-matrix.json`, each mirrored into
  the Swift test resources and the Godot `res://` mirror and guarded by
  `pnpm gen:corpus -- --check`;
- every SDK sends the canonical `X-PKey-Platform`, `X-PKey-Arch` and `X-PKey-SDK` values those files
  pin;
- the Node, React, Python and Swift runners pass both files;
- `core.headers` is `implemented` in the four manifests, and the `config.resolve` and `config.list`
  proofs point at `config-matrix.json`.

## Why

Header values differ across SDKs, so the Worker's device records and analytics split by SDK
([README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #17):

- Node sends `os.platform()` and `os.arch()` (`win32`, `darwin`, `x64`;
  `packages/sdk-node/src/core/context.ts:301-312`);
- Python sends `platform.system().lower()` and `platform.machine()` (`windows`, `AMD64`, `aarch64`;
  `sdks/python/src/polaris_key/core/context.py:372-373`);
- Swift sends `darwin`, `ios`, `win32` and `arm64`, `x86_64`
  (`sdks/swift/Sources/PolarisKeyCore/Platform.swift`);
- the React browser adapter sends `browser` (`packages/sdk-react/src/browser/browserAdapter.ts:257`).

Config precedence is implemented three times (`client-core/src/config.ts`, Python
`config/resolve.py`, Swift `ConfigClient.swift`), with Godot next, and has no shared vectors. Its
environment-variable JSON parsing is exactly the kind of rule languages disagree on
([PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data), [§5.3](../../PARITY.md#53-config)).

## Read first

- `AGENTS.md` (rules 1–3), `CLAUDE.md` (plan mode), `program/plans/README.md` (the nine required plan
  sections).
- `docs/security/WIRE-CONTRACT-V3.md` §5 (it names the seven headers but never their values).
- [PARITY §4.1](../../PARITY.md#41-corpora-behaviour-as-data),
  [§5.1](../../PARITY.md#51-core), [§5.3](../../PARITY.md#53-config);
  [README §3.1](../../README.md#31-vocabulary) (the `platform` and `arch` vocabularies);
  [notes/A2 §14](../../notes/A2-sdk-port.md#14-repo-divergences-found-along-the-way-worth-tickets)
  items 7–8.
- [P1b-02](P1b-02-sdk-constants.md): `conformance/parity/enums.json` and the generated `Platform`,
  `Arch` and `HeaderName`.
- `tools/sign-corpus.ts` (`main()`, `reconcile()`, `SWIFT_V2_RESOURCES`);
  `packages/client-core/src/config.ts` (`resolveSource`, `resolveValue`, `listUserEntries`,
  `looksLikeJson`, `safeJsonParse`); `packages/sdk-react/src/core/adapter.ts` (`ctxFor`: React's
  environment layer is always empty).
- Where the Worker keeps header values: `packages/worker/src/core/devices.ts:671-687`
  (`deviceMetadata`) and `packages/worker/src/repo.ts:1224-1250` (`upsertDevice`, stored verbatim).
- `packages/docs/scripts/gen-reference.mjs`, `corpusInventory()`.

## Scope

**In** (the plan specifies each; the implementation follows it exactly):

- `tools/sign-corpus.ts` builders for `conformance/corpus/v2/headers.json` (`headersVersion: 1`) and
  `config-matrix.json` (`configMatrixVersion: 1`), plus their mirrors in
  `sdks/swift/Tests/PolarisKeyTests/Resources/v2/` and `sdks/godot/tests/corpus/v2/` (both written
  through `CORPUS_TARGETS`).
- In each SDK, a pure mapping from that runtime's raw inputs to the canonical values, used by its
  header builder. Node, Python and Swift change what they send; React's browser adapter sends
  `web`.
- Runners:
  - Node: `conformance/runners/node/headers.test.ts` and `configMatrix.test.ts`;
  - React: `packages/sdk-react/test/configMatrix.test.ts`, the web-host rows, and its header rows;
  - Python: `tests/test_headers.py` and `tests/test_config_matrix.py`;
  - Swift: `HeadersTests.swift` and `ConfigMatrixTests.swift`.
- The canonical values documented in `WIRE-CONTRACT-V3.md` §5.
- The corpus file list updated in `AGENTS.md` rule 1, `contribute/corpus.md` and
  `build/wire/corpus.md`.
- `corpusInventory()` extended to list the new files, then `reference/corpus.mdx` regenerated.
- Manifests updated: `core.headers` implemented; `config.resolve` and `config.list` proven by
  `config-matrix.json`.
- **Wave-1 sync:** **Headers proof must become enforceable (from P1b-01).** The parity checker never compares a registry proof's `wp` against the program, so `core.headers`'s proof naming this package stays silently unenforced until `headers.json` exists. Create it, and have `tools/parity-check.ts` rule 4 also check proof-level `wp` (a proof whose `wp` is `done` with no file is an error).

**Out** (and where it belongs instead):

- `ramBucket` below 1 GiB, the second half of #17: it is a fingerprint component, not a header
  (→ [P1b-09](P1b-09-fingerprint-storage-fixes.md), in `fingerprint.json`).
- Channel derivation (`channelForVersion`, `X-PKey-Channel` values) (→ [P0-04](P0-04-channel-unification.md)).
- Godot's runner and mapping (→ the Godot P1 packages, [P1-02](P1-02-godot-core.md) and
  [P1-04](P1-04-godot-config.md)). The plan names what Godot must pass.
- Asserting header values in the HTTP transcripts: a follow-up edit to the P1b-03 harness once these
  values land.

## Design notes

**Decisions the plan must make** (recommendations in bold):

1. **Platform values:** `macos`, `ios`, `android`, `windows`, `linux`, `web` (README §3.1). **iPadOS
   is `ios`.**
2. **Arch values:** `arm64`, `x86_64`, `armv7`, `wasm32`. These match the Worker's `UpdateArch` and
   the Release `Arch` (`packages/shared-protocol/src/update.ts:5`,
   `packages/worker/src/services/release/assets.ts:14-19`). An unrecognised input either omits the
   header or sends `unknown`: **omit it**, as components that cannot be read are omitted today.
3. **`X-PKey-SDK` values:** keep the package names (`@polaris-key/node`, `@polaris-key/react`,
   `polaris-key-python`, `PolarisKeySwift`) or switch to short ids (`node`, `react`, `python`,
   `swift`, `godot`). **Short ids**, pinned in `enums.json`, with the package version staying in
   `X-PKey-SDK-Version`.
4. **Compatibility.** Header values were never specified, so this is not a contract change. **No
   `PROTOCOL_VERSION` bump.** The Worker stores the values verbatim, so old and new clients will split
   the console's device lists. **Recommend a small normaliser in `deviceMetadata`** mapping legacy
   values (`win32`→`windows`, `darwin`→`macos`, `x64`, `AMD64`, `amd64`→`x86_64`,
   `aarch64`→`arm64`, `browser`→`web`), with Worker tests, so stored rows converge. Include it in
   this package or name its owner.
5. **Engine.** PARITY §4.1 says "engine header values", but there is no engine header; `engine` is a
   `devices/report` key that P1 adds. **Leave it out** unless P1-05 has landed, in which case pin the
   report value's format (`godot-4.7`).

**`headers.json` shape** (proposed):

```text
{
  "headersVersion": 1,
  "canonical": { "platform": ["macos", "…"], "arch": ["arm64", "…"], "sdk": ["node", "…"] },
  "cases": [
    { "id": "node-win32-x64", "sdk": "node",
      "input": { "platform": "win32", "arch": "x64" },
      "expect": { "x-pkey-platform": "windows", "x-pkey-arch": "x86_64" } },
    { "id": "python-windows-amd64", "sdk": "python",
      "input": { "system": "Windows", "machine": "AMD64" },
      "expect": { "x-pkey-platform": "windows", "x-pkey-arch": "x86_64" } },
    { "id": "python-linux-aarch64", "sdk": "python",
      "input": { "system": "Linux", "machine": "aarch64" },
      "expect": { "x-pkey-platform": "linux", "x-pkey-arch": "arm64" } }
  ]
}
```

Each SDK's runner feeds the rows for its own `sdk` into its mapping function. Rows that describe the
same machine across SDKs must agree on the expected values.

**`config-matrix.json` rows** pin `resolveValue`, `resolveSource` and `listUserEntries`:
`{ id, remote, localOverrides, env, envPrefix, key, expect: { value, source } }` plus `listCases`. The
rows cover:

- `enforced` and `hidden` beat local and environment; `hidden` is excluded from the list, `enforced`
  is flagged;
- `default` loses to local, which beats environment, which beats the remote default, which beats the
  fallback;
- a key absent remotely but present in the environment;
- the environment-variable name rule (dots become `__`, with the prefix);
- the JSON parsing of environment values, where languages disagree: `true`, `null`, `"1e3"`, `"01"`
  (not JSON, so the raw string), `"-0"`, a malformed `"{"` (raw string), whitespace-only and empty
  strings, and a quoted string;
- a `hosts` field, or a per-host expectation, for the web host, whose environment layer is empty by
  definition (PARITY §5.3, footnote 1).

Integers stay below 2^53, and runners compare with canonical JSON equality, treating integral floats
as integers ([notes/A7 §5](../../notes/A7-xlang-content.md#5-corpus-encoding-and-runner-expectations)).

**What the plan must name** (the `plans/README.md` sections): the generator functions and version
constants; the mirrors (Swift, Godot); each runner file above; the SDK order Node → React → Python → Swift, then
Godot; the docs pages; and the deploy order (Worker normaliser first, then SDK releases).

**Godot.** Settled by P1-01: the Godot runner reads a generator-owned `res://` mirror at
`sdks/godot/tests/corpus/v2/`. `CORPUS_TARGETS` in `tools/sign-corpus.ts` writes `headers.json` and
`config-matrix.json` there by construction.

## Steps

1. The wire planner writes `program/plans/P1b-04.md` with the decisions above, sets the status to
   `awaiting-approval` and stops.
2. After approval: extend the generator, regenerate the corpus and mirror, and run `--check`.
3. Add the mapping functions and runners in the order Node, React, Python, Swift, one SDK per commit.
4. Add the Worker normaliser if the plan includes it.
5. Update the contract doc, `AGENTS.md` rule 1, the corpus docs, the docs emitter and the manifests;
   run the green gate.

## Acceptance criteria

- [x] `program/plans/P1b-04.md` is merged (approved) before any code change.
- [x] `conformance/corpus/v2/headers.json` and `config-matrix.json` exist, with the mirrors (Swift, Godot), and
      `mise exec node@22 -- pnpm gen:corpus -- --check` passes.
- [x] The Node, React, Python and Swift runners pass every row that applies to them; a doctored row
      fails each one.
- [x] A captured request from each SDK carries the canonical values (unit test per SDK).
- [x] `reference/corpus.mdx` lists both files; `pnpm --filter @polaris-key/docs gen:check` passes.
- [x] `parity.json` manifests are updated for every SDK this changes, and `pnpm parity:check`
      passes.
- [x] The green gate passes (`AGENTS.md`).
- [x] `core.headers` has an enforced corpus proof; `pnpm parity:check` fails if a `done` package's proof file is missing.

## Verify

```sh
mise exec node@22 -- pnpm gen:corpus -- --check
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q tests/test_headers.py tests/test_config_matrix.py )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Interfaces:** the two corpus files, their version constants and row shapes; one pure mapping
  function per SDK (`canonicalPlatform`/`canonicalArch`, `canonical_platform`/`canonical_arch`); the
  canonical values in `WIRE-CONTRACT-V3.md` §5.
- Godot (P1-02, P1-04), Kotlin (P6-05) and C# (X-01) must pass both files. The HTTP transcript
  harness (P1b-03) can now assert header values.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-04 done`.

# P1b-02 Generate SDK constants: error codes, header values, enums, feature ids

| Field       | Value                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                                              |
| Size        | 1 engineer-weeks                                                                                                                             |
| Depends on  | [P1b-01](P1b-01-parity-registry.md), [P0-09](P0-09-service-table.md)                                                                         |
| Unblocks    | [P1b-04](P1b-04-headers-config-corpora.md), [P1b-10](P1b-10-core-caps.md), [P6-05](P6-05-kotlin-sdk.md)                                      |
| Role        | `pkey-implementer`                                                                                                                           |
| Plan mode   | no (it must not edit `shared-protocol` or `client-core`; see Design notes)                                                                   |
| Gates       | a new drift gate (`pnpm gen:constants -- --check`, in CI and the green gate); the generated `reference/error-codes.mdx` page (AGENTS rule 3) |
| Human input | none                                                                                                                                         |
| Repo        | `vladzaharia/polaris-key`                                                                                                                    |

## Goal

`tools/gen-sdk-constants.ts` emits one constants module per language (TypeScript for Node and React,
Python, Swift, and GDScript once `sdks/godot` exists) from one set of sources. Each module holds the
error-code registry, the `X-PKey-*` header names, the canonical platform and arch values, the service
slugs, the feature ids with the `supports()` reason enum, and the protocol and corpus versions.
`pnpm gen:constants -- --check` fails on drift and runs in CI. Each SDK has a test proving that every
error code it raises is in the registry, and `core.errors` is `implemented` in the four manifests.

## Why

Names must be identical up to casing, and the mapping must be generated rather than remembered
([PARITY §2.1](../../PARITY.md#21-the-contract), [§4.4](../../PARITY.md#44-generated-constants)).
Today:

- error codes are string literals scattered through the SDKs (`PolarisError("service-unavailable")`,
  `"sign-in-failed"`, `"local-only"`);
- header values disagree across SDKs
  ([README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #17);
- each SDK enumerates the service slugs by hand
  ([notes/A3 §5.3](../../notes/A3-admin-dx.md#53-blast-radius-of-a-sixth-service-content) items
  14–17).

[P1b-04](P1b-04-headers-config-corpora.md) needs the canonical header values to pin in `headers.json`.

## Read first

- `AGENTS.md`, `CLAUDE.md` (plan mode covers any `shared-protocol` or `client-core` change).
- [PARITY §2.1–§2.2](../../PARITY.md#2-what-parity-means) and
  [§4.4](../../PARITY.md#44-generated-constants);
  [README §3.1](../../README.md#31-vocabulary) (the `platform` and `arch` vocabularies).
- [P0-09](P0-09-service-table.md) (the service table and its drift gate) and
  [P1b-01](P1b-01-parity-registry.md) (the registry this reads).
- `tools/gen-mirrors.ts` (banner, per-language renderers, `--check`) and `tools/sign-corpus.ts`
  (`reconcile()` near the end, prettier formatting of outputs).
- `packages/shared-protocol/src/core.ts`: `PROTOCOL_VERSION` (`:9`), `PolarisErrorCode`
  (`:191-205`), the `HEADER_*` names (`:224-230`).
- `packages/worker/src/core/errors.ts` (the `ErrorCode` object) and the `errorResponse(<status>, "<code>")`
  call sites across `packages/worker/src` (`rate_limited`, `misconfigured`, `oidc_error`, …).
- `packages/client-core/src/errors.ts` (`PolarisError`, whose code is widened to `string`).
- `packages/docs/scripts/gen-reference.mjs`, `errorCodes()`.
- Today's literals: `packages/sdk-node/src/core/context.ts`, `release/client.ts`, `update/client.ts`,
  `core/bundle.ts`; `packages/sdk-react/src/browser/browserAdapter.ts`,
  `desktop/desktopAdapter.ts`; `sdks/python/src/polaris_key/core/errors.py`;
  `sdks/swift/Sources/PolarisKeyCore/Transport.swift` (`PolarisError`'s client-side codes,
  `:39-47`; `Models.swift:307-317` is the `HEADER_*` block) and `Platform.swift`.

## Scope

**In:**

- **Sources**, hand-written and schema-validated:
  - `conformance/parity/errors.json` (and `errors.schema.json`): every error code the Worker or an
    SDK emits, with `kind` (`wire`: appears in a response body; `client`: raised only by an SDK),
    `service` and `description`;
  - `conformance/parity/enums.json` (and schema): `platform` (`macos`, `ios`, `android`, `windows`,
    `linux`, `web`) and `arch` (`arm64`, `x86_64`, `armv7`, `wasm32`), from README §3.1. `universal`
    and `any` are artifact values, not header values, and stay out.
  - Also read: feature ids and `reasons` from `conformance/parity/features.json`; service slugs from
    P0-09's table; header names, `PROTOCOL_VERSION` and P0-04's channel constants (`CHANNEL_STABLE`,
    `CHANNEL_BETA`, `CHANNEL_PR`, `CHANNEL_DEV`, `CHANNEL_ALIASES`, `CHANNEL_NAME_PATTERN`,
    `PR_CHANNEL_PATTERN`, `PR_NUMBER_MAX_DIGITS`, plan §2.2) imported from `@polaris-key/protocol/core`
    (the generator emits every `CHANNEL_*`/`PR_*` export the module has; P0-04 landed while this
    package was in review and all eight are now emitted in every output and re-exported from each
    package root — Node and React `export * from "./constants.generated.js"`, Python
    `from .constants_generated import *` plus the generated `__all__` — so a future addition needs
    only `pnpm gen:constants`);
    `corpusVersion`, `gateMatrixVersion` and `fingerprintVersion` from the corpus files.
- **Outputs**, each with a GENERATED banner (TypeScript formatted with prettier, as `sign-corpus.ts`
  does):
  - `packages/sdk-node/src/constants.generated.ts`;
  - `packages/sdk-react/src/constants.generated.ts`;
  - `sdks/python/src/polaris_key/constants_generated.py`;
  - `sdks/swift/Sources/PolarisKeyCore/Constants.generated.swift`;
  - a GDScript module under `sdks/godot/` at the path P1-01's layout implies
    (`sdks/godot/addons/polaris_key/core/constants_generated.gd`, `class_name PKeyConstants`),
    written only if `sdks/godot/addons/polaris_key` exists. The GDScript renderer is unit-tested
    either way.
- Root script `"gen:constants": "tsx tools/gen-sdk-constants.ts"` with `--check`; a CI step; the
  `AGENTS.md` green gate; a row in the `contribute/waves.md` drift-gate inventory.
- `tools/gen-sdk-constants.test.ts`: renderers, casing and collision checks, `--check` behaviour, and
  a source test. The source test extracts every wire code from `PolarisErrorCode`, the Worker's
  `ErrorCode` and the `errorResponse(…)` call sites, in the same way `gen-reference.mjs` reads source,
  and fails if `errors.json` misses one. (Correction, review: the boot stage machine's own error
  codes, `sync-failed` and `fetch-failed`, are client codes no `PolarisError` scan sees; the
  generator also checks every `error` emit in `conformance/corpus/v2/stage-matrix.json` that is not
  the host's `fail` code echoed back.)
- Per SDK, a test that every code the SDK raises is in the generated registry. For TypeScript, scan
  `src/**` for `PolarisError("…")` literals; for Python and Swift, check their code constants.
- Extend the `errorCodes()` emitter to list the client codes from `errors.json`, then regenerate
  `reference/error-codes.mdx`.
- Mark `core.errors` `implemented` in the four manifests and tag those tests.

**Out** (and where it belongs instead):

- Changing the header values the SDKs send (→ [P1b-04](P1b-04-headers-config-corpora.md),
  plan-mode, with `headers.json`).
- Enums for outlets, transports, pack types, patch strategies and bindings. They are added to
  `enums.json` when their owners define them (→ [P2b-02](P2b-02-distribution-manifest.md),
  [P4-01](P4-01-packs-plan.md)).
- `supports()` and the typed `Unsupported` result in each SDK (→ unowned; see P1b-01's Hand-off).
- Kotlin and C# emitters (→ [P6-05](P6-05-kotlin-sdk.md), [X-01](X-01-dotnet-sdk.md)); GDScript
  catalog mirrors in `gen-mirrors.ts` (→ [P1-04](P1-04-godot-config.md)).
- Renaming any existing code. Hosts match on these strings, so a rename is a behaviour change.

## Design notes

- **Why the sources live in `conformance/parity/`.** `CLAUDE.md` puts any change to `shared-protocol`
  or `client-core` in plan mode, and this package is not plan-mode. Importing their exports is fine;
  editing them is not. The same reason gives two TypeScript outputs instead of one shared module. If
  review wants the error registry inside `shared-protocol`, that move is a plan-mode follow-up.
- **Two code styles exist and are both recorded as they are.** Wire codes are `snake_case`
  (`device_limit`, `registration_closed`). Client codes are kebab-case (`service-unavailable`,
  `local-only`, `insecure-base-url`, `sign-in-failed`), and the §7 bundle refusal reasons
  (`BundleRefusalReason`) are client codes too.
- **Casing** follows PARITY §2.1:
  - TypeScript and Swift members are camelCase: `ErrorCode.serviceUnavailable`,
    `Feature.licenseChannels`, `Platform.macos`, `HeaderName.platform`, `PROTOCOL_VERSION`.
  - Python and GDScript constants are UPPER_SNAKE: `ErrorCode.SERVICE_UNAVAILABLE`,
    `FEATURE_LICENSE_CHANNELS`.
  - Swift types: check `Models.swift` for clashes (it already declares `HEADER_*` globals). Prefix
    with `PKey` only where a name collides.
  - The identifier mapping is deterministic, and the generator fails on a collision, for example
    `sign-in-failed` and `sign_in_failed` mapping to one identifier.
- **Adoption.** The registry test stops new literals. Migrating existing literals to the constants is
  welcome where it is mechanical, but it is not required here. The SDK porter agents use the
  constants from now on.
- **Service slugs** come from P0-09's table. If P0-09 already emits SDK service enums, fold that
  emitter into this generator, or call it, so that one generator owns each output file.
- `--check` mirrors `sign-corpus.ts`: regenerate in memory, print `stale: <path>`, exit 1.

## Steps

1. Write `errors.json` and `enums.json` with their schemas; fill `errors.json` from the source scan.
2. Write the generator with one renderer per language and the tests.
3. Generate the outputs; export them from each SDK's package entry (Node `src/index.ts`, React
   `src/index.ts`, Python `__init__.py`, Swift through `PolarisKeyCore`).
4. Add the per-SDK "raised codes are registered" tests; tag them `@pkey-feature core.errors`.
5. Extend the error-codes emitter and regenerate the docs.
6. Wire the root script, the CI step, `AGENTS.md` and `waves.md`; run the green gate.

## Acceptance criteria

- [x] `mise exec node@22 -- pnpm gen:constants -- --check` exits 0, and exits 1 after a hand edit
      to any output.
- [x] The source test fails when a new `errorResponse(…, "new_code")` appears without an
      `errors.json` entry (a fixture shows this).
- [x] The four outputs compile: `pnpm typecheck`, `pytest`, `swift build`.
- [x] Each SDK's registry test passes and fails on an unregistered literal (shown by a fixture or in
      the PR).
- [x] `reference/error-codes.mdx` lists the client codes; `pnpm --filter @polaris-key/docs gen:check`
      passes.
- [x] `core.errors` is `implemented` in the four manifests, and `pnpm parity:check` passes.
- [x] CI runs `pnpm gen:constants -- --check`; `AGENTS.md` and `waves.md` list it.
- [x] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm --filter @polaris-key/tools test
mise exec node@22 -- pnpm typecheck && mise exec node@22 -- pnpm test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Interfaces:** the generated names (`ErrorCode`, `Feature`, `UnsupportedReason`, `Platform`,
  `Arch`, `HeaderName`, `ServiceSlug`, `PROTOCOL_VERSION`, corpus versions) and their file paths; the
  source files `conformance/parity/errors.json` and `enums.json`; the command `pnpm gen:constants`.
- [P1b-04](P1b-04-headers-config-corpora.md) uses `Platform`, `Arch` and `HeaderName` as the values
  that `headers.json` pins. P1b-06 to P1b-09 raise errors through `ErrorCode`.
- Godot (P1-02 onwards) consumes the GDScript output. P6-05 and X-01 add their emitters here.
- A new error code now needs an `errors.json` entry first; say so in `contribute/waves.md`.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-02 done`.

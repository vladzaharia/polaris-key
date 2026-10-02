# X-01 Optional: the C#/.NET SDK (desktop, MAUI, Unity, Godot C#)

| Field       | Value                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | X: Optional SDKs                                                                                                                                                                                            |
| Size        | 10–14 engineer-weeks                                                                                                                                                                                        |
| Depends on  | [P1b-01](P1b-01-parity-registry.md), [P4-11](P4-11-chunk-sync-sdks.md), [P1b-03](P1b-03-http-transcripts.md), [P1b-04](P1b-04-headers-config-corpora.md)                                                    |
| Unblocks    | none                                                                                                                                                                                                        |
| Role        | `pkey-sdk-porter`                                                                                                                                                                                           |
| Plan mode   | no (a new SDK verifies the existing contract; it changes no wire format)                                                                                                                                    |
| Gates       | `pnpm parity:check` with a new manifest; every corpus file and transcript; new emitters in `gen-sdk-constants` and `gen-mirrors` with `--check`; a new CI job; every place that enumerates the language set |
| Human input | the go/no-go on optional work (program README §6); later, a NuGet organisation and API key for publishing, and devices for the MAUI and Unity mobile rows. Build and test proceed without them              |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                   |

This is a **kickoff brief**. It fixes scope, layout, dependencies and the order of milestones. Each
milestone is one PR (or a short series) whose detailed steps the porter writes into the PR
description, driven by the manifest's `planned` entries.

## Goal

A C#/.NET SDK lives in `sdks/dotnet`. One core package serves .NET desktop, MAUI, Unity and Godot C#.
It starts from a parity manifest in which every registry id is `planned`, and it reaches
`implemented` or an allowed N/A on every row by passing the same corpus files and transcripts in
`dotnet test` that the other SDKs pass.

## Why

One package reaches four runtimes that no current SDK covers
([PARITY §1](../../PARITY.md#1-sdks-runtimes-and-shared-native-backends),
[§9](../../PARITY.md#9-new-sdks-order-and-shape) item 4). The core needs no native code on .NET
desktop, only one crypto dependency (the base library has no Ed25519) and one zstd dependency below
.NET 11
([notes/E9 §9](../../notes/E9-runtime-building-blocks.md#9-minimal-native-footprint-per-runtime),
[notes/A7 §10.3](../../notes/A7-xlang-content.md#103-c--net)). notes/A7 already ran the content
vectors on .NET 10 and 11 with identical verdicts.

## Read first

- `AGENTS.md` (the wave model, "done when every SDK passes"), `CLAUDE.md`.
- [PARITY](../../PARITY.md) in full: §2 (contract, typed unsupported, concurrency), §3 (manifest), §4
  (corpora, transcripts, runners, constants), §6.2 (zstd), §7 (.NET row).
- notes/E9: [§5.2–§5.3](../../notes/E9-runtime-building-blocks.md#5-atomic-file-replace-locking-and-app-data-directories),
  [§6](../../notes/E9-runtime-building-blocks.md#6-secure-storage), the U and D columns of
  [§10](../../notes/E9-runtime-building-blocks.md#10-runtime--feature-matrix).
- notes/A7: [§6](../../notes/A7-xlang-content.md#6-results-by-language) (.NET results),
  [§10.3](../../notes/A7-xlang-content.md#103-c--net),
  [§11.2](../../notes/A7-xlang-content.md#112-one-small-dependency-per-sdk-none-for-godot).
- [notes/A2 §5.4](../../notes/A2-sdk-port.md#54-every-place-the-repo-enumerates-the-language-set):
  every file that enumerates the SDK languages.
- The reference implementations: `packages/client-core/src` (verify, trust, clock, gate, config,
  bundle) and `sdks/python/src/polaris_key` (a full non-JS port with the same layering).

## Scope

**In (the kickoff PR, milestone M0):**

- `sdks/dotnet/parity.json`, every entry `planned` with its milestone below, runtimes `dotnet`,
  `maui`, `unity`, `godot-csharp`.
- The solution skeleton, a CI job, and the first real code: Ed25519 verify passing `jwsCases`.

**In (later milestones, one PR series each):**

| Milestone | Delivers                                                                                                                                                                           | Proven by                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| M1        | core: JWS, documents, trust, clock floor, bundle, gate, config resolution, headers                                                                                                 | `cases.json`, `gate-matrix.json`, `config-matrix.json`, `headers.json`        |
| M2        | transport and the service clients: discovery, sync, licence, config (incl. secrets, catalog, edge-mint), devices (fingerprint per P1b-09's rules), identity, release, update check | `fingerprint.json`, every transcript                                          |
| M3        | wire v4: feed and release-record verification, the update decision, outlet detection                                                                                               | `feedCases`, `releaseRecordCases`, `update-matrix.json`, `outlet-matrix.json` |
| M4        | packs: planner, appliers, install state, chunk sync                                                                                                                                | the content corpus, `plan-matrix.json`, `stage-matrix.json`                   |
| M5        | heads: MAUI (SecureStorage, `FileSystem`), Windows (DPAPI, MSIX identity), Unity layer (UI Toolkit, Addressables provider)                                                         | unit and device tests; the mobile rows through the native packages            |

**Out** (and where it belongs instead):

- Apple and Android native backends for MAUI and Unity mobile: bind the shared packages
  (→ [P5-05](P5-05-apple-plugin-package.md), [P5-06](P5-06-kotlin-aar.md)); those rows stay
  `planned` until they exist.
- Publishing to NuGet or the Unity Asset Store (after the human supplies accounts).
- Any wire, corpus or registry change. A missing case is reported, not added (the porter rule).
- Blazor WebAssembly as a target. Decide in M0 whether to declare a `web` runtime at all.

## Design notes

**Layout** (proposed):

```text
sdks/dotnet/
  PolarisKey.sln
  src/PolarisKey.Core/        netstandard2.0; net8.0 — verify, trust, clock, gate, config, transport, errors
  src/PolarisKey/             the client and service sub-clients (license, config, devices, identity, release, update)
  src/PolarisKey.Content/     packs: planner, appliers, chunk sync
  src/PolarisKey.Windows/     DPAPI / Credential Manager token store, MSIX identity
  src/PolarisKey.Maui/        SecureStorage, app directories, outlet detection heads
  unity/com.polariskey.sdk/   UPM package: the netstandard2.0 assemblies plus the Unity layer
  tests/PolarisKey.Tests/     xUnit; links conformance/ and the transcripts as content files
  parity.json
```

Tests run inside the repo, so link `conformance/corpus/v2/*.json` and `conformance/transcripts/*.json`
as content items. No generator-owned mirror is needed, unlike Swift. The Unity test project may need
one; if so, add it to `tools/sign-corpus.ts` with `--check`.

**Dependencies:**

- **Ed25519:** `BouncyCastle.Cryptography` 2.7.0, which is pure managed and runs under Unity IL2CPP
  and MAUI. **Recommend it for the core.** NSec 26.4.0 wraps libsodium natively and could be an
  optional desktop backend. PARITY §7 records this as a `dependency` that is always present, not an
  N/A.
- **zstd:** `ZstdSharp.Port` 0.8.8 on netstandard2.0, ≤ .NET 10, Unity and Blazor. On .NET 11,
  `System.IO.Compression.ZstandardDecoder` with `SetPrefix` and `MaxWindowLog2`, except on browser
  and WASI.
  - notes/A7 reached ZstdSharp's raw-prefix mode only through a private handle; wrap it in one small
    helper, or ask upstream for a public `SetPrefix`.
  - Apply the magic-base rule (`37 A4 30 EC`) and set the window limit explicitly
    ([PARITY §6.3](../../PARITY.md#63-spec-rules-found-by-running-six-runtimes)).
- **JSON:** System.Text.Json (a package on netstandard2.0), with the strict parsing rules the corpus
  enforces.
- **Hashing:** `IncrementalHash`.
- **Transport:** `HttpClient` with an injectable handler, which is the transcript seam.

**Surface.**

- Async is `Task`; events and `IObservable<T>` in the UI layers (PARITY §2.3).
- **PARITY §2.1 says C# uses camelCase, but .NET convention is PascalCase for public members.**
  Recommend PascalCase members (`client.License.EntitledChannels()`) with wire strings unchanged, and
  update `gen-sdk-constants`' C# emitter and PARITY §2.1 to match. Confirm with the human at M0.
- Errors carry the generated `ErrorCode`, and unsupported features return the typed `Unsupported`
  result (PARITY §2.2), if that has an owner by then; see P1b-01's unowned list.

**Runtime facts that become N/As or special cases** (notes/E9 §10):

- Unity has no updater (`update.driver`: `runtime`).
- Unity's secure storage needs native plugins.
- Godot C# cannot export to web ([README §5.12](../../README.md#512-packaging-and-versions)).
- `ProtectedData` is Windows-only, so desktop needs per-OS token stores.
- Android hardware serials are blocked, so MAUI and Unity on Android use an app-scoped id.

**Repo wiring** (M0):

- A CI job running `dotnet test` on ubuntu, windows and macOS.
- C# emitters in `tools/gen-sdk-constants.ts` and `tools/gen-mirrors.ts` (`--lang csharp`), both with
  `--check`.
- `test:all`, the `AGENTS.md` repo map and green gate, and every language-set enumeration in
  notes/A2 §5.4 ("five-language" becomes six or seven).
- A docs page `build/sdks/dotnet.mdx`.

## Steps

1. M0: manifest, skeleton, CI job, emitters, JWS verification against `jwsCases`; open the PR with
   the milestone table.
2. M1 to M5 in order. Each milestone moves its manifest rows to `implemented` or an allowed N/A,
   with tags `// @pkey-feature <id>`.
3. After M2, ask the human about publishing; after M4, run the notes/A7 content vectors' 37 MB
   companion set in a performance job, outside the green gate.

## Acceptance criteria

- [ ] M0: `sdks/dotnet/parity.json` lists every registry id; `pnpm parity:check` passes; the CI
      `dotnet` job passes on three OSes; every `jwsCases` vector passes.
- [ ] Each later milestone: its corpus files and transcripts pass in `dotnet test`, and its manifest
      rows are `implemented` or an allowed N/A.
- [ ] `pnpm gen:constants -- --check` and the C# mirror check pass.
- [ ] Done: no `planned` entry remains except rows waiting on P5-05, P5-06 or human inputs, each
      named in the PR.
- [ ] The green gate passes (`AGENTS.md`), plus `dotnet test`.

## Verify

```sh
( cd sdks/dotnet && dotnet test )
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm gen:constants -- --check
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- **Interfaces:** the NuGet package ids (`PolarisKey.Core`, `PolarisKey`, `PolarisKey.Content`,
  `PolarisKey.Windows`, `PolarisKey.Maui`), the UPM package `com.polariskey.sdk`, and the C# emitters.
- A Godot C# facade (README §5.12) can wrap `PolarisKey` directly.
- Set the status per milestone in PR descriptions, and at the end:
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set X-01 done`.

## Plan amendments (P4-10)

The approved [`plans/P4-10.md`](../plans/P4-10.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

## Plan amendments (P4-19)

The approved [`plans/P4-19.md`](../plans/P4-19.md) changes this package; its §8.5 bullet for this
package, and every decision in §8.1 that names it as owner, override this brief where they differ.

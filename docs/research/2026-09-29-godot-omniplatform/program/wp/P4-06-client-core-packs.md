# P4-06 `client-core` packs: planner, appliers, path rules, install state; Node and React wiring

| Field       | Value                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | P4: Packs (v1)                                                                                                                                   |
| Size        | 1.5–2.5 engineer-weeks                                                                                                                           |
| Depends on  | [P4-04](P4-04-content-corpus-v1.md), [P3-04](P3-04-v4-node.md), [P3-05](P3-05-v4-react.md), [P1b-09](P1b-09-fingerprint-storage-fixes.md)        |
| Unblocks    | [P4-11](P4-11-chunk-sync-sdks.md), [P4-16](P4-16-more-pack-types.md), [P4-20](P4-20-save-compat.md)                                              |
| Role        | `pkey-sdk-porter`                                                                                                                                |
| Plan mode   | no                                                                                                                                               |
| Gates       | corpus: the content corpus and `plan-matrix.json` pass in Node (lowest and current Node 22) and Chromium; `pnpm gen:corpus -- --check` unchanged |
| Human input | none                                                                                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                        |

## Goal

`@polaris-key/client-core` holds the language-neutral half of packs: the install planner, the
full, file and delta appliers, files-index parsing, the path rules, the error registry, the
`packSetId` function and the install-state machine, all pure and with SHA-256, zstd, byte I/O and
fetch injected. It passes every content case and every `plan-matrix.json` row. `@polaris-key/node`
and `@polaris-key/react` expose `client.update.packs` (`ensure`, `state`, `registerHandler`,
progress events) with a `files.tree` handler, embedded baselines, the right zstd backend, and
`packSetId` in their device reports.

## Why

notes/A7's JavaScript core ran unchanged in Node and Chromium with only `{sha256, zstd}` and
`fetch` swapped, which is the shape `client-core` needs
([A7 §11.4](../../notes/A7-xlang-content.md#114-what-client-core-should-hold),
[CONTENT §13](../../CONTENT.md#13-per-sdk-integration)). Putting it in `client-core` once gives the
Node and React SDKs the same verdicts as the corpus, and gives the Python, Swift and Godot ports a
reference to read.

## Read first

- `AGENTS.md`; the approved `program/plans/P4-01.md` (formats, facet names, `packSetId`, types,
  N/As).
- [notes/A7 §3.4–§3.5](../../notes/A7-xlang-content.md#34-apply-algorithms-and-verdict-precedence)
  (apply algorithms, verdict precedence, error codes),
  [§4](../../notes/A7-xlang-content.md#4-install-planner-language-neutral-specification) (the
  planner, exactly), [§6](../../notes/A7-xlang-content.md#6-results-by-language) (Node),
  [§9](../../notes/A7-xlang-content.md#9-browser-specifics-chromium-141-measured) (browser APIs,
  OPFS, the WASM decoder), [§11.2](../../notes/A7-xlang-content.md#112-one-small-dependency-per-sdk-none-for-godot).
- [CONTENT §4.1](../../CONTENT.md#41-handler-contract-every-sdk) (handler contract),
  [§8.1](../../CONTENT.md#81-the-strategy-ladder-and-planner), [§10](../../CONTENT.md#10-client-pipeline-every-sdk)
  (the pipeline, install state, web), [PARITY §5.6](../../PARITY.md#56-packs),
  [§6.2](../../PARITY.md#62-zstd-one-codec-at-most-one-dependency-per-sdk).
- Reference code in `docs/research/2026-09-29-godot-omniplatform/prototype/content/`:
  `runners/js/content.mjs` (the isomorphic core with injected SHA-256 and zstd) and
  `runners/js/cases.mjs` (the case interpreter), `runners/node/run.mjs` and `run-wasm.mjs`,
  `runners/browser/` (worker, OPFS and `Range` probes), `wasm/zdec.c`, `wasm/build.sh` and
  `runners/browser/zstddec-prefix.mjs` (the decoder-only WASM build and its loader).
- Code: `packages/client-core/src/index.ts:1-5` ("WebCrypto only, zero Node APIs, no I/O"),
  `src/errors.ts`, `src/store.ts`, `package.json` (subpath exports);
  `packages/sdk-node/src/update/client.ts`, `src/core/telemetry.ts`;
  `packages/sdk-react/src/update/`; `conformance/runners/node/corpusV2.test.ts`.

## Scope

**In:**

- **`client-core/src/packs/`**, exported as `@polaris-key/client-core/packs`:
  - `plan(input)`: A7 §4.2 exactly, including chunk costing over inline records, total tie-break
    order, `requestWeight` default 16,384, disk as a constraint, `full` always last;
  - `applyFull`, `applyDelta`, `applyFile` (container and tree): A7 §3.4 and the formats P4-01
    fixed, with the same counters and first-failure verdicts;
  - `parseFilesIndex`, `checkPaths`, `packSetId`, the error registry (A7 §3.5);
  - the install-state machine over `active`, `previous`, `inflight` (journal), `observed`,
    `confirmedBootSeq` (CONTENT §9), with commit, activate, confirm, rollback and GC roots, over an
    injected store with atomic replace.
- **Injected ports**: incremental SHA-256, `zstd.decode(frame, size)`,
  `zstd.decodeWithPrefix(frame, prefix, size, windowLogMax)`, `fetch` with `Range`/`If-Range`,
  and byte sources and sinks (`read(offset, length)`, `write(offset, bytes)`), so a 200 MB payload
  never sits in memory. The corpus runner injects in-memory ports.
- **Node** (`client.update.packs`): the pipeline of CONTENT §10 (preflight, journal, fetch,
  verify, commit, activate, confirm, resume) for `files.tree` (hot: versioned directory plus
  atomic pointer swap); embedded baselines registered by the host (payload path plus marker,
  verified once, then used as installed state); zstd from `node:zlib` after a start-up probe (a
  tiny built-in prefix vector: advertise `zstd-patch-from` only if it decodes), else the WASM
  decoder; `packSetId` in the report.
- **React** (`update.packs`): the same facet over the `web` transport, the WASM decoder,
  streaming SHA-256 (`hash-wasm`, MIT), and a storage adapter with an OPFS implementation and an
  in-memory one for tests.
- **The WASM decoder** (decoder-only libzstd 1.5.7, `ZSTD_DCtx_refPrefix` +
  `ZSTD_decompressDCtx`, about 69 KB): vendored once for both SDKs (proposed package
  `@polaris-key/zstd-wasm`), with its C shim, a rebuild script, the recorded SHA-256 of the
  committed `.wasm`, and the BSD-3 licence.
- **Runners**: `conformance/runners/node/content.test.ts` over the content corpus and
  `plan-matrix.json` at the paths P4-04 landed (proposed `conformance/corpus/v2/content/` and
  `conformance/corpus/v2/plan-matrix.json`), run with `node:zlib` and with the WASM decoder; the
  same core under the Chromium runner P1b-05 added.

**Out** (and where it belongs instead):

- Chunk sync and chunk-index parsing (→ [P4-11](P4-11-chunk-sync-sdks.md)); the planner already
  costs chunk candidates, but v1 capabilities never list `chunk`.
- `data.json`, `l10n.table`, `ml.model`, `archive.*`, game-registered `custom.*` handlers
  (→ [P4-16](P4-16-more-pack-types.md)); `isAvailable` from `provides` (→ P4-20).
- `dcz` deltas in Chromium (→ P4-18); background-download plumbing beyond resume.
- Pack sets from the feed, floors, revocation handling (→ P4-12, P4-13). In v1 the active set is
  the app record's pins.

## Design notes

- **`client-core` stays pure.** No Node or DOM APIs, no I/O, no timers; WebCrypto only where it
  already is. Everything else is a port. This is why the appliers take byte sources and sinks
  rather than A7's whole buffers.
- **The Node zstd traps** (A7 §6): `node:zlib` has zstd from 22.15, but the `dictionary` option is
  silently ignored before 22.19 (and 24.0–24.5), and streaming decodes cap the window at 128 MiB
  unless `windowLogMax` is set. `engines` says `>=22`, so 22.0–22.14 have no zstd at all: the WASM
  fallback is required, not optional. Run the runner on the lowest supported Node (P1b-05).
- **Never auto-detect dictionaries.** Decode deltas in raw-content prefix mode only, and refuse
  nothing CI published: the magic-base rule keeps such deltas off the menu.
- **Verify before use.** Check every delta artifact's SHA-256 from the signed menu before
  decoding, the base's hash before applying, and the output's hash before commit. Seeds installed
  and verified earlier are not re-hashed on the fast path (A7 §3.4).
- **UX policy stays outside the planner** (metered consent, "replace in place" offers).
- **Web storage.** `Cache.put` rejects 206 responses; `DecompressionStream` has no zstd; WebCrypto
  `digest` does not stream (A7 §9). Stage in OPFS; request `persist()` after engagement; re-plan
  from scratch when storage was evicted.
- **Data directories.** Node's store, staging and state live in the platform data directory with
  backup exclusion (PARITY §8, P1b-09); if P1b-09 has not landed, use one helper and note it.

## Steps

1. Port A7's JavaScript core into `client-core/src/packs/` behind ports; make the corpus runner
   pass with in-memory ports and `node:zlib`.
2. Package the WASM decoder; run the corpus through it in Node and Chromium.
3. Install-state machine and its unit tests (crash between commit and pointer swap, resume from a
   journal, rollback, GC roots).
4. Node facet and `files.tree` handler; embedded baselines; the zstd probe; telemetry.
5. React facet with OPFS and `hash-wasm`; tests with the in-memory adapter.
6. Registry manifests and docs pages (`build/sdks/`).

## Acceptance criteria

- [ ] Every `applyCases`, `pathCases` and `packSetIdCases` entry and every `plan-matrix.json` row
      passes in `conformance/runners/node` with `node:zlib` and with the WASM decoder, and in
      Chromium with the WASM decoder.
- [ ] On a Node without a working `dictionary` option (simulated by failing the probe), deltas go
      through the WASM decoder and the delta cases still pass.
- [ ] Unit tests: a crash after staging leaves `active` untouched; a resumed plan re-hashes
      completed ranges; rollback restores `previous`; GC keeps active, previous, in-flight and
      embedded roots.
- [ ] Node and React `update.packs.ensure([id])` install a `files.tree` pack from a local fake
      byte server and report `packSetId` through `devices/report`.
- [ ] `@polaris-key/client-core` has no new Node or DOM import (typecheck against its lib set).
- [ ] The green gate passes.
- [ ] `parity.json` manifests for Node and React mark `packs.plan`, the files index, `packs.apply.full`,
      `packs.apply.file`, `packs.apply.delta`, `packs.state` and `packs.handlers` implemented
      (once P1b-01 has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm typecheck && mise exec node@22 -- pnpm build
```

## Hand-off

`@polaris-key/client-core/packs` is the reference that P4-07 and P4-08 port and that P4-11 extends
with the chunk applier and chunk-index parser (its planner is already complete). P4-16 adds handler
types through `registerHandler`; P4-18 adds `dcz` beside the WASM decoder. Then
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P4-06 done`.

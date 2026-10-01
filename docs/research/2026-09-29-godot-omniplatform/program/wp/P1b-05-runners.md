# P1b-05 Add Chromium and minimum-version runners; fix the Node runner's build-gate port

| Field       | Value                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                      |
| Size        | 0.75–1 engineer-weeks                                                                                |
| Depends on  | [P0-04](P0-04-channel-unification.md)                                                                |
| Unblocks    | [P4-18](P4-18-web-dcz.md)                                                                            |
| Role        | `pkey-implementer`                                                                                   |
| Plan mode   | no for Parts A and B; Part C needs a corpus row change, which only an approved plan may make         |
| Gates       | CI (new jobs); for Part C, the corpus drift gate (`pnpm gen:corpus -- --check`) through P0-04's plan |
| Human input | none for A and B; Part C rides on the human's approval of P0-04's plan                               |
| Repo        | `vladzaharia/polaris-key`                                                                            |

## Goal

- **A:** CI runs `client-core` over `cases.json` and `gate-matrix.json` in real Chromium.
- **B:** the Node runner and the Node SDK suite run on the lowest Node that `engines` allows; the
  Python suite runs on CPython 3.9 and 3.14; every runner prints its runtime and library versions.
- **C:** the build-gate ports in the Node, Python and Swift runners mirror
  `packages/worker/src/core/gate.ts`, and a Worker test proves the gate-matrix rows agree with the
  real server gate.

## Why

- **One runtime is not proof.** notes/A7 found version-dependent decoder behaviour that only a run on
  the minimum version shows: Node 22.15–22.18 silently ignore the zstd `dictionary` option
  ([notes/A7 §6](../../notes/A7-xlang-content.md#6-results-by-language),
  [§11.5](../../notes/A7-xlang-content.md#115-corpus-plan-a-plan-mode-all-languages-event-per-claudemd)).
  CI runs one Node 22 and one Python (3.12) today (`.github/workflows/ci.yml`).
- **The React SDK is only tested in jsdom.** Its runtime is a browser, where WebCrypto Ed25519, WASM
  zstd, OPFS and `dcz` live ([PARITY §4.3](../../PARITY.md#43-runners)).
- **The runners' build-gate port is stale**
  ([README §9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #15,
  [notes/A2 §14](../../notes/A2-sdk-port.md#14-repo-divergences-found-along-the-way-worth-tickets)
  item 1). It still has the dev-build bypass that finding R3-01 removed, maps an unknown channel to
  `stable`, and lets a declared channel replace the one the version implies.

## Read first

- `AGENTS.md` (rule 1: never weaken a runner, never hand-edit the corpus), `CLAUDE.md`.
- [PARITY §4.3](../../PARITY.md#43-runners), [§11](../../PARITY.md#11-open-questions) Q4;
  [notes/A7 §6](../../notes/A7-xlang-content.md#6-results-by-language) and
  [§9](../../notes/A7-xlang-content.md#9-browser-specifics-chromium-141-measured).
- `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, root `package.json` (`engines: ">=22"`),
  `sdks/python/pyproject.toml` (`requires-python = ">=3.9"`).
- `conformance/runners/node/corpusV2.test.ts` (the whole file; the port is at `:322-374`),
  `sdks/python/tests/test_gate_matrix.py:72-100`,
  `sdks/swift/Tests/PolarisKeyTests/GateMatrixTests.swift:75-100`.
- `packages/worker/src/core/gate.ts:52-150` (`channelForVersion`, `isDevBuild`, `normalizeChannel`,
  `checkBuildGate`), `packages/worker/src/core/entitlements.ts` (`entitledChannels`,
  `versionWindow`).
- `tools/sign-corpus.ts:1698` (the dev-bypass row); `packages/worker/test/fingerprintCorpus.test.ts`
  (the pattern for "the Worker checks a corpus file").
- The [P0-04](P0-04-channel-unification.md) brief and plan.

## Scope

**In:**

- **A. Chromium.** A workspace package `conformance/runners/browser`
  (`@polaris-key/conformance-browser`), added to `pnpm-workspace.yaml`, using Vitest browser mode
  (`@vitest/browser` with the `playwright` provider, Chromium only).
  - Move the case-driving code out of `corpusV2.test.ts` into a module both runners import (for
    example `conformance/runners/node/suites.ts`, exporting `defineCorpusSuites(corpus, matrix)`).
    The Node runner keeps reading files with `node:fs`; the browser runner imports the JSON through
    Vite.
  - A CI job `browser` that installs Chromium (`pnpm exec playwright install --with-deps chromium`)
    and runs it.
  - `fingerprint.json` stays Node-only: `@polaris-key/node/devices` hashes with `node:crypto`, and web
    has no fingerprint (PARITY §5.4).
- **B. Version floors.**
  - Declare `engines.node` in `packages/sdk-node/package.json`, `packages/client-core/package.json`
    and `packages/sdk-react/package.json`. None has one today.
  - A CI job `node-floor` that installs exactly that version and runs `@polaris-key/conformance-node`,
    `@polaris-key/client-core` and `@polaris-key/node` tests. If the declared floor fails, raise it to
    the lowest version that passes; never skip or weaken tests.
  - The Python job becomes a matrix of `3.9` and `3.14` on ubuntu, with macOS kept on the current
    version.
  - Version banners: the Node runner prints `process.versions` (node, openssl, v8); pytest prints
    `sys.version` and the `cryptography` and `httpx` versions (a `conftest.py` report header); the
    browser runner prints `navigator.userAgent`.
- **C. The build-gate port** (after P0-04, see Design notes):
  - the three ports rewritten to mirror `core/gate.ts`, including P0-04's channel vocabulary;
  - a Worker test, `packages/worker/test/gateMatrixCorpus.test.ts`, that feeds every row's `gate`
    inputs to the real `checkBuildGate` and asserts `expect.reason` and `allowedRange`, so the server
    is the oracle and the ports cannot drift silently again.
- **D. WebKit and Firefox ([S-04](../../notes/S-04-low-end-performance.md)).** The same browser runner adds WebKit 26.6 and Firefox 155.0,
  the builds bundled with `playwright-core` 1.63.0, run on Linux: for example in
  `mcr.microsoft.com/playwright:v1.63.0-noble`. That WebKit is the Linux port and stands in for
  WebKitGTK.
  - WebKit's WebCrypto Ed25519 crashes the web process on signing inputs of about 64 KiB and above.
    Its run must route `payload-at-cap` and `bundle-payload-at-cap` through the documented
    fallback, or cap them, rather than crash.
  - Playwright WebKit has no OPFS sync access handle, so OPFS is asserted only in Chromium and
    Firefox.
- Docs: the runner table in `packages/docs/src/content/docs/build/wire/corpus.md` ("Four runners")
  and `contribute/corpus.md` gain the Chromium and version-floor jobs.

**Out** (and where it belongs instead):

- Changing any corpus row (→ [P0-04](P0-04-channel-unification.md)'s plan).
- Real iOS Safari and Android Chrome runs (→ [S-04](S-04-low-end-performance.md)'s hand-off); an iOS simulator
  job (→ [P5-05](P5-05-apple-plugin-package.md)); the Godot runner (→ [P1-01](P1-01-godot-scaffold.md)).
- zstd probes and the WASM decoder in the browser job (→ [P4-06](P4-06-client-core-packs.md),
  [P4-18](P4-18-web-dcz.md)); the Chromium job is where they will run.

## Design notes

**Why Part C cannot be fixed in the runners alone.** `gate-matrix.json` row "ok — dev build bypasses
the gate despite an out-of-range window + non-entitled channel" (`tools/sign-corpus.ts:1698`) pins
the pre-R3-01 behaviour. Its inputs are version `0.0.0-dev+abc123`, channel `staging`, window
`5.0.0`–`6.0.0` and no entitlements. The Worker's `checkBuildGate` does not bypass for it (`dev` is
not entitled) and returns `version-too-old`. A correct port therefore turns that row red.

- AGENTS rule 1 forbids weakening the runner, and changing the row is a corpus change: plan-mode and
  the one-corpus-package lane.
- [P0-04](P0-04-channel-unification.md)'s plan already re-baselines `gate-matrix.json` for the channel
  vocabulary.
- So Part C lands with or after that plan. It asks P0-04's plan to include the re-baselined dev row
  and three new rows:
  - a `0.0.0-dev` build with the `dev` channel entitled bypasses the window;
  - an unrecognised channel header (`beta` before P0-04, or whatever P0-04 leaves unknown) is refused
    with `channel-not-entitled`;
  - a declared `stable` header cannot loosen a `0.0.0-pr-42` build.
- If P0-04 is not approved when you start, ship A and B in one PR, and open C as a second PR that
  waits on it. Do not touch the corpus here.

**The port must mirror the server, not re-derive it.** Port `normalizeChannel` returning `null` for
unknown values, the `allowDevBuilds ?? entitledChannels(…).includes("dev")` rule, and "the implied
channel always applies; a header can only add one". The React test
(`packages/sdk-react/test/gateMatrixParity.test.ts`) feeds the row's own block decision and needs no
port.

**Runner hygiene.** A runner that cannot run a case fails loudly; it never skips
([notes/A7 §5](../../notes/A7-xlang-content.md#5-corpus-encoding-and-runner-expectations)).

## Steps

1. Extract the shared suite module; keep the Node runner green with zero behaviour change.
2. Add the browser package and the CI job; confirm Ed25519 verification runs in Chromium's WebCrypto
   (Chromium 137+).
3. Add `engines`, the `node-floor` job, the Python matrix and the version banners.
4. Update the runner docs. Open the PR for A and B.
5. After P0-04's plan is approved: rewrite the three ports, add `gateMatrixCorpus.test.ts`, and
   regenerate against P0-04's rows.

## Acceptance criteria

- [ ] The CI `browser` job runs every `cases.json` and `gate-matrix.json` case in Chromium and passes.
- [ ] The CI `node-floor` job runs on the version in `engines.node`, which is declared in
      `sdk-node`, `client-core` and `sdk-react`.
- [ ] The Python job passes on 3.9 and 3.14.
- [ ] Each runner's log shows its runtime and library versions.
- [ ] (C) The Node, Python and Swift ports match `core/gate.ts`; `gateMatrixCorpus.test.ts` passes on
      the re-baselined matrix and fails if a row's `expect.reason` is doctored.
- [ ] The runner docs list the new jobs.
- [ ] `parity.json` manifests are updated for every SDK this changes (for example, React's `core.verify`
      proof now includes the Chromium runner).
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser exec playwright install chromium
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser test
mise exec node@<floor> -- pnpm --filter @polaris-key/conformance-node test
( cd sdks/python && .venv/bin/python -m pytest -q )   # repeat in 3.9 and 3.14 virtualenvs
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- gateMatrixCorpus   # Part C
mise exec node@22 -- pnpm gen:corpus -- --check
```

## Hand-off

- **Interfaces:** the shared suite module (`defineCorpusSuites`); the `conformance/runners/browser`
  package and its CI job; the `node-floor` job and the declared `engines.node`; the Python version
  matrix.
- P1b-04's `config-matrix.json` and every later corpus file should run in the browser job too. P4-06
  adds the zstd probe to the floor job, and P4-18 adds `dcz` to the browser job.
- `gateMatrixCorpus.test.ts` makes the Worker the oracle for `gate-matrix.json`; P0-04 and later
  gate changes keep it green.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-05 done`.

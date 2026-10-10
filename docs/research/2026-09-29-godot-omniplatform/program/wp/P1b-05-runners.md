# P1b-05 Add Chromium and minimum-version runners

| Field       | Value                                 |
| ----------- | ------------------------------------- |
| Phase       | P1b: SDK parity                       |
| Size        | 0.5–0.75 engineer-weeks               |
| Depends on  | [P0-04](P0-04-channel-unification.md) |
| Unblocks    | [P4-18](P4-18-web-dcz.md)             |
| Role        | `pkey-implementer`                    |
| Plan mode   | no                                    |
| Gates       | CI (new jobs)                         |
| Human input | none                                  |
| Repo        | `vladzaharia/polaris-key`             |

> **Corrections from implementation (2026-10-01).** The code is the fact; where this brief and
> the branch disagree, the branch wins.
>
> - **Four corpus files, not two.** Since P3-02/P3-05, `corpusV2.test.ts` also drives
>   `update-matrix.json` and `outlet-matrix.json`. The shared module moves all of it, so the
>   signature is `defineCorpusSuites({ corpus, matrix, updateMatrix, outletMatrix })`, and the
>   browser runner runs all four files (865 cases, the same names as the Node runner).
> - **`suites.ts` names its files.** `parity:check` rule 2 accepts a corpus proof only from a
>   tagged file that names the corpus file as a string literal. The `@pkey-feature` tags moved
>   with the cases, so `suites.ts` exports `CORPUS_FILES`, which both runners load from.
> - **Root `pnpm test` leaves the browser package out.** Otherwise the `js`, deploy and release
>   jobs would need a Playwright browser. It runs as `pnpm test:browser` (turbo, after `^build`)
>   or with `pnpm --filter @polaris-key/conformance-browser test`, plus `--browser=firefox` or
>   `--browser=webkit`. The Verify lines' `test -- --browser=…` form also works.
> - **WebKit 26.6 needs `macos-15`.** playwright-core 1.63.0's `browsers.json` pins an older
>   WebKit build (revision 2251) on macOS 14 (`revisionOverrides.mac14`).
> - **The Node floor is 22.0.0.** It is declared as `"engines": { "node": ">=22.0.0" }` in all
>   three packages. The conformance runner, client-core and the Node SDK suites pass on 22.0.0
>   on macOS and on Linux, running as a non-root user. One SDK store test assumes `chmod`
>   binds, which is false for root in a container. CI runs as a normal user.
> - **Python on macOS stays on 3.12**, the version CI already used. Its leg names now carry the
>   interpreter, which is a HANDOFF item for the required checks.
> - **The docs heading is "The runners"**, not "Four runners".

## Goal

- **A:** CI runs `client-core` over `cases.json` and `gate-matrix.json` in real Chromium.
- **B:** the Node runner and the Node SDK suite run on the lowest Node that `engines` allows; the
  Python suite runs on CPython 3.9 and 3.14; every runner prints its runtime and library versions.
- **D:** the same browser runner passes every `cases.json` and `gate-matrix.json` case in Firefox
  and WebKit too, on the engine builds S-04 measured.

## Why

- **One runtime is not proof.** notes/A7 found version-dependent decoder behaviour that only a run on
  the minimum version shows: Node 22.15–22.18 silently ignore the zstd `dictionary` option
  ([notes/A7 §6](../../notes/A7-xlang-content.md#6-results-by-language),
  [§11.5](../../notes/A7-xlang-content.md#115-corpus-plan-a-plan-mode-all-languages-event-per-claudemd)).
  CI runs one Node 22 and one Python (3.12) today (`.github/workflows/ci.yml`).
- **The React SDK is only tested in jsdom.** Its runtime is a browser, where WebCrypto Ed25519, WASM
  zstd, OPFS and `dcz` live ([PARITY §4.3](../../PARITY.md#43-runners)).

## Read first

- `AGENTS.md` (rule 1: never weaken a runner, never hand-edit the corpus), `CLAUDE.md`.
- [PARITY §4.3](../../PARITY.md#43-runners), [§11](../../PARITY.md#11-open-questions) Q4;
  [notes/A7 §6](../../notes/A7-xlang-content.md#6-results-by-language) and
  [§9](../../notes/A7-xlang-content.md#9-browser-specifics-chromium-141-measured).
- `.github/workflows/ci.yml`, `pnpm-workspace.yaml`, root `package.json` (`engines: ">=22"`),
  `sdks/python/pyproject.toml` (`requires-python = ">=3.9"`).
- `conformance/runners/node/corpusV2.test.ts` (the whole file; P0-04 rewrites its build-gate port,
  so start from P0-04's merged version).
- The [P0-04](P0-04-channel-unification.md) brief and plan (it owns the build-gate port rewrite and
  `gateMatrixCorpus.test.ts`).

## Scope

**In:**

- **A. Chromium.** A workspace package `conformance/runners/browser`
  (`@polaris-key/conformance-browser`), added to `pnpm-workspace.yaml`, using Vitest browser mode
  (`@vitest/browser` with the `playwright` provider). Part A is Chromium; Part D adds Firefox and
  WebKit to the same package.
  - Move the case-driving code (including P0-04's rewritten build-gate port, verbatim) out of `corpusV2.test.ts` into a module both runners import (for
    example `conformance/runners/node/suites.ts`, exporting `defineCorpusSuites(corpus, matrix)`).
    The Node runner keeps reading files with `node:fs`; the browser runner imports the JSON through
    Vite.
  - A CI job `browser` that installs Chromium (`pnpm exec playwright install --with-deps chromium`)
    and runs it. Part D adds its own jobs; this one stays Chromium-only.
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
- **D. Firefox and WebKit ([S-04](../../notes/S-04-low-end-performance.md)).** The same browser
  package runs in the engine builds bundled with `playwright-core` 1.63.0, which S-04 measured:
  - a CI job `browser-firefox` on Linux runs Firefox 155.0, for example in the image
    `mcr.microsoft.com/playwright:v1.63.0-noble`;
  - a CI job `browser-webkit` on a macOS runner runs WebKit 26.6. On macOS, S-04 measured WebCrypto
    Ed25519 verifying the corpus's 87,474 B and 349,618 B signing inputs correctly, and rejecting
    them with a flipped signature.
  - **Do not run WebKit on Linux in this package.** Linux Playwright WebKit, like WebKitGTK 2.52.6
    with libgcrypt 1.10.3, kills the web process when WebCrypto Ed25519 verifies a message of about
    64 KiB or more. `payload-at-cap` and `bundle-payload-at-cap` would therefore fail on every run.
    That is the correct, loud result (AGENTS rule 1; Runner hygiene below). Never skip, cap or
    special-case those rows to make such a job green. The job becomes possible only when
    `shared-jws`/`client-core` gains a size-aware Ed25519 fallback for GCrypt-backed WebKit. That
    work is unowned: [X-02](X-02-tauri-plugin.md)'s plan adds an injectable primitive for Tauri and
    lists a pure-JS browser fallback only as an option. S-04 flags it to the lead. It touches
    `shared-jws`, so it needs plan mode (`CLAUDE.md`).
  - Playwright WebKit has no OPFS sync access handle on either OS. If a later package adds an OPFS
    assertion to these jobs, it holds only in Chromium and Firefox.
- Docs: the runner table in `packages/docs/src/content/docs/build/wire/corpus.md` ("Four runners")
  and `contribute/corpus.md` gain the Chromium, Firefox, WebKit and version-floor jobs.

**Out** (and where it belongs instead):

- The build-gate port in the Node, Python and Swift runners, the carried dev row and
  `gateMatrixCorpus.test.ts` (→ [P0-04](P0-04-channel-unification.md), plan D6). Part A's shared suite
  module moves P0-04's rewritten port verbatim; it does not change it.
- Changing any corpus row (→ [P0-04](P0-04-channel-unification.md)'s plan).
- Real iOS Safari and Android Chrome runs (→ [S-04](S-04-low-end-performance.md)'s hand-off); an iOS simulator
  job (→ [P5-05](P5-05-apple-plugin-package.md)); the Godot runner (→ [P1-01](P1-01-godot-scaffold.md)).
- zstd probes and the WASM decoder in the browser job (→ [P4-06](P4-06-client-core-packs.md),
  [P4-18](P4-18-web-dcz.md)); the Chromium job is where they will run.
- A Linux WebKit (WebKitGTK-proxy) job and the size-aware Ed25519 fallback in `shared-jws` that
  would let it pass (unowned; see Part D).

## Design notes

**Runner hygiene.** A runner that cannot run a case fails loudly; it never skips
([notes/A7 §5](../../notes/A7-xlang-content.md#5-corpus-encoding-and-runner-expectations)).

## Steps

1. Extract the shared suite module; keep the Node runner green with zero behaviour change.
2. Add the browser package and the CI job; confirm Ed25519 verification runs in Chromium's WebCrypto
   (Chromium 137+).
3. Add the `browser-firefox` and `browser-webkit` jobs (Part D) on Playwright 1.63.0.
4. Add `engines`, the `node-floor` job, the Python matrix and the version banners.
5. Update the runner docs. Open the PR.

## Acceptance criteria

- [ ] The CI `browser` job runs every `cases.json` and `gate-matrix.json` case in Chromium and passes.
- [ ] (D) The CI `browser-firefox` (Firefox 155.0, Linux) and `browser-webkit` (WebKit 26.6, macOS)
      jobs run every `cases.json` and `gate-matrix.json` case and pass. No case is skipped, capped
      or routed around. Each log shows the `navigator.userAgent` banner.
- [ ] The CI `node-floor` job runs on the version in `engines.node`, which is declared in
      `sdk-node`, `client-core` and `sdk-react`.
- [ ] The Python job passes on 3.9 and 3.14.
- [x] Each runner's log shows its runtime and library versions.
- [x] The runner docs list the new jobs.
- [x] `parity.json` manifests are updated for every SDK this changes (for example, React's `core.verify`
      proof now includes the Chromium runner).
- [x] The green gate passes (`AGENTS.md`).

> The four CI rows above wait for the branch's first CI run. Locally on 2026-10-01, the browser
> runner passed all 865 cases in Chromium 153 and WebKit 26.6 (macOS), and in Firefox 155.0 in
> `mcr.microsoft.com/playwright:v1.63.0-noble`. The Node conformance runner, client-core and
> the Node SDK passed on Node 22.0.0 (macOS, and Linux as a non-root user). The Python suite
> passed on CPython 3.9 and 3.14 (1750 tests each).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser exec playwright install chromium
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser exec playwright install firefox webkit
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser test -- --browser=firefox  # Linux
mise exec node@22 -- pnpm --filter @polaris-key/conformance-browser test -- --browser=webkit   # macOS
mise exec node@<floor> -- pnpm --filter @polaris-key/conformance-node test
( cd sdks/python && .venv/bin/python -m pytest -q )   # repeat in 3.9 and 3.14 virtualenvs
mise exec node@22 -- pnpm gen corpus --check
```

## Hand-off

- **Interfaces:** the shared suite module (`defineCorpusSuites`); the `conformance/runners/browser`
  package and its CI jobs (`browser`, `browser-firefox`, `browser-webkit`); the `node-floor` job and the declared `engines.node`; the Python version
  matrix.
- P1b-04's `config-matrix.json` and every later corpus file should run in the browser job too. P4-06
  adds the zstd probe to the floor job, and P4-18 adds `dcz` to the browser job.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-05 done`.

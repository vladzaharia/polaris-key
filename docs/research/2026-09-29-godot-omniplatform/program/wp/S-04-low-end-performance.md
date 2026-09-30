# S-04 Spike: crypto, hashing and zstd on low-end Android, iOS and mobile/WebKit browsers

| Field       | Value                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase       | S: Spikes                                                                                                                                                                                                                                  |
| Size        | 1 engineer-weeks                                                                                                                                                                                                                           |
| Depends on  | none                                                                                                                                                                                                                                       |
| Unblocks    | none                                                                                                                                                                                                                                       |
| Role        | `pkey-spike-runner`                                                                                                                                                                                                                        |
| Plan mode   | no                                                                                                                                                                                                                                         |
| Gates       | none beyond `pnpm format` on the files it adds                                                                                                                                                                                             |
| Human input | low-end Android and iOS devices (see Design notes for the minimum set). Also needed, not in the graph: a Mac with Xcode and an Apple account to install on the iPhones, and an HTTPS origin reachable from the phones for the browser runs |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                  |

## Goal

A research note, `notes/S-04-low-end-performance.md`, replaces the estimates in
[README §5.2](../../README.md#52-crypto-measured) ("20–45 ms on low-end Android, 10–60 ms on web")
with measurements, and answers [CONTENT §17](../../CONTENT.md#17-open-questions-and-spikes) Q4 and
[PARITY §11](../../PARITY.md#11-open-questions) Q4. Per device and runtime it gives:

- Ed25519 verify time in pure GDScript for a small message, the 87 KB payload at the cap and the
  350 KB bundle at the cap, and the main-thread stall each causes;
- GDScript SHA-512, engine SHA-256 (`HashingContext`) and engine zstd decode throughput;
- the content runner's `bench` (chunk sync, delta, full, file rebuild) on the content vectors;
- in browsers: WebCrypto Ed25519 availability and time, SHA-256 (WebCrypto, `hash-wasm`), the WASM
  zstd decoder, OPFS in a worker, and the 75 content cases' verdicts in WebKit and Gecko.

## Why

[README §12](../../README.md#12-risks-and-open-questions) lists performance on low-end devices as a
risk: the phone and web numbers are estimates from a 4-vCPU Xeon
([notes/A5 §3](../../notes/A5-godot-empirical.md#3-pure-gdscript-ed25519-verify)). Desktop is measured
([notes/A7 §8](../../notes/A7-xlang-content.md#8-throughput): Godot hashes at 242 MB/s and decodes zstd
at 568 MB/s; Chromium chunk-syncs at 106–136 MB/s), but Firefox, Safari and mobile browsers were
never run ([notes/A7 §13](../../notes/A7-xlang-content.md#13-limits)). The results decide:

- whether the Godot core must run verifies off the main thread and cache decompressed keys per
  `kid` from the start (P1-02), and how `PKeyBoot` budgets its stages (P1-10);
- whether chunk sync and delta baking fit a boot on a low-end phone (P4-08, P4-11);
- which WebKit and Firefox versions join the browser runner (P1b-05), and whether the React SDK may
  claim `packs.apply.delta` (PARITY §11 Q4, P4-18);
- whether WebCrypto Ed25519 works in WebKitGTK, which Tauri uses on Linux
  ([notes/E9 §13](../../notes/E9-runtime-building-blocks.md#13-spikes-and-open-questions) item 1; X-02).

## Read first

- `AGENTS.md` and `.claude/agents/pkey-spike-runner.md`.
- [README §5.2](../../README.md#52-crypto-measured) and [§5.3](../../README.md#53-transport-persistence-device-identity); [notes/A5 §3](../../notes/A5-godot-empirical.md#3-pure-gdscript-ed25519-verify).
- [notes/A7 §8](../../notes/A7-xlang-content.md#8-throughput), [§9](../../notes/A7-xlang-content.md#9-browser-specifics-chromium-141-measured) and [§13](../../notes/A7-xlang-content.md#13-limits); [PARITY §6](../../PARITY.md#6-content-delivery-across-languages) and [§11](../../PARITY.md#11-open-questions).
- [notes/E4 §9.5](../../notes/E4-godot-ecosystem.md#95-spikes-to-run-before-committing-ordered-by-risk) spike 1 (frame-slice if a verify exceeds about 50 ms).
- Code to reuse:
  - [`prototype/README.md`](../../prototype/README.md): the `sha512`, `ed25519 fast`, `jws` and
    `profile` suites behind `tests/cli.gd` (`PKTestRunner`). If P1-01 has landed, use
    `sdks/godot` instead (classes `PKeyEd25519`, `PKeySha512`).
  - `prototype/content/runners/godot/content_runner.gd` (its `bench` mode) and the vector sets from
    `prototype/content/gen/gen.py small|large`.
  - `prototype/content/runners/browser/` (`index.html`, `worker.mjs`, `drive.mjs` on Playwright,
    `server.mjs` with single-range `Range`) and the WASM decoder `prototype/content/wasm/zdec.c`.

## Scope

**In:**

- Godot exports (release templates) of a wrapper scene that runs the suites and the content bench
  and writes `user://results.json`: Android APK (arm64), iOS, and web (single-threaded).
- Browser runs: Playwright WebKit and Firefox on Linux first (switch `drive.mjs` from `chromium`),
  then real iOS Safari and low-end Android Chrome loading the same page over HTTPS and posting
  results back to the server.
- A frame-time probe: a spinning element while a bundle-sized verify runs on the main thread; then
  the same verify on `WorkerThreadPool` (native) or sliced across frames (single-threaded web).

**Out** (and where it belongs instead):

- Optimising the verifier (per-`kid` cache, inlining) (→ P1-02).
- Native accelerators (Monocypher GDExtension); Swift and Kotlin SDK performance, which use
  platform crypto (not owned; propose only if the numbers demand it).
- The `packs.apply.delta` parity claim itself (→ P1b-05, P4-18).

## Design notes

- **Minimum device set:** one Cortex-A53/A55-class Android phone with 3 GB RAM or less on Android 10
  or later; one mid-range Android phone; one older iPhone on the oldest iOS the game supports
  (Diceroll's preset is `min_ios_version=15.0`, notes/A4 §1.13); one current iPhone. Record model,
  SoC, RAM, OS and browser versions.
- Keep the prototype's own Linux preset untouched; put new presets, the wrapper scene and the result
  collector under `prototype/lowend/`.
- On mobile there is no command line for the runner: the wrapper runs a fixed list and writes JSON;
  pull it with `adb` or from the Xcode device container.
- Run each measurement 3–5 times after a warm-up; report median and best, and note thermal state.
  Phones throttle, so interleave runs rather than looping one test.
- Use the `small` vector set (4.1 MB) everywhere and the `large` (37 MB) set where memory allows;
  record any out-of-memory failure as a result.
- Web must be a secure context for WebCrypto and OPFS: serve over HTTPS (or `adb reverse` to
  `localhost` for Android Chrome). Use a single-threaded Godot web build so COOP/COEP are not
  needed.
- Treat Playwright's WebKit on Linux as a proxy for WebKitGTK, and say so.

## Steps

1. Build the wrapper and exports; confirm the suites pass on the device before timing anything.
2. Run the Godot matrix on every device; collect JSON.
3. Run the browser matrix: Playwright WebKit and Firefox, then the phones.
4. Run the frame-time probe on the low-end phone (native and web).
5. Write the note with one table per metric and a one-line verdict per decision listed in Why.

## Acceptance criteria

- [ ] `notes/S-04-low-end-performance.md` exists with the provenance blockquote, question, short
      answer, method, environment per device, results, recommendation, affected briefs and sources,
      with evidence tags.
- [ ] Tables give, per device: Ed25519 (three sizes), SHA-512, SHA-256, zstd decode, content bench
      rows, and the main-thread stall with and without off-thread or sliced verification.
- [ ] The content vectors' pass count (out of 75) is reported for WebKit, Firefox, iOS Safari and
      Android Chrome, with any failing case named.
- [ ] WebCrypto Ed25519 support and timing are reported per browser, including Playwright WebKit.
- [ ] The recommendation says, with numbers: off-main-thread verification in P1-02 (yes/no);
      acceptable pack sizes for chunk sync at boot on the low-end phone; the browser versions for
      P1b-05; and whether README §5.2's estimates should be replaced (the edit is proposed, not
      applied).
- [ ] `prototype/lowend/` holds the wrapper, presets and collector with a README.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm format
# Desktop sanity run of the wrapper before any device run:
godot --headless --path docs/research/2026-09-29-godot-omniplatform/prototype --script res://tests/cli.gd -- ed25519 fast 20
```

## Hand-off

P1-02 takes the verify budget and the off-thread decision; P1-10 the stage budgets; P4-08 and P4-11
the per-device throughput for planning and progress UX; P1b-05 the browser versions; P4-18 the
WebKit and Gecko verdicts for the WASM decoder path. Set the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set S-04 done`.

> Research note for [Godot on Polaris Key](../README.md), 2026-09-30. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. The harness is kept in
> [`prototype/lowend/`](../prototype/lowend/README.md).

# S-04: crypto, hashing and zstd on low-end Android, iOS and mobile/WebKit browsers

Run 2026-09-30, work package [S-04](../program/wp/S-04-low-end-performance.md).

Evidence markers, as in the other notes:

- **[M]** measured here;
- **[V]** a primary source read raw;
- **[S]** a summary source;
- **[I]** inference.

Each result row also carries one of three labels:

- **measured**: the real runtime on real hardware (this host, or its browsers);
- **emulated**: the real code in a simulator, an emulator or a throttled browser. These run at the
  host's CPU speed, or at an artificial fraction of it;
- **unmeasured**: no device was available. The row gives a derived default [I], and the device run
  is a hand-off item.

## Question

The questions come from README §5.2, CONTENT §17 Q4 and PARITY §11 Q4.

1. How long do these take, and how long do they stall the main thread, on a low-end phone and in
   mobile and WebKit browsers?
   - pure-GDScript Ed25519 at 252 B, at the 87 KB payload cap and at the 350 KB bundle cap;
   - GDScript SHA-512, the engine's SHA-256 and zstd;
   - the content operations.
2. Does WebCrypto Ed25519 work there, WebKitGTK (Tauri on Linux) included?
3. Do the 75 content cases pass in WebKit and Gecko?

## Short answer

1. **No physical phone was available.** Every device row is emulated or unmeasured, and the device
   runs are in the hand-off. This host also ran under extreme contention: load averages of 130–1,000
   on 18 cores from other work packages. So even the desktop timings here are upper bounds. The
   correctness results, the crash findings and the within-run ratios are solid.
2. **Correctness holds everywhere it ran [M].** The official 4.7.2 **release** templates pass
   everything in five runtimes: macOS arm64; the Android arm64 APK on an API 34 emulator; the iOS
   engine in the iPhone 17e simulator (iOS 26.5); and the single-threaded web export in Chromium
   153, WebKit 26.6 (macOS and Linux) and Mobile Safari 26.5. The suites that pass are:
   - SHA-512 24/24;
   - Ed25519 26/26, and 26/26 for the new frame-sliced verifier;
   - corpus v2 `jwsCases` 36/36;
   - raw corpus signatures 68/68;
   - content vectors 75/75.
3. **The browser matrix also passes 75/75 for every primitive combo [M].** This covers Playwright
   Chromium 153, WebKit 26.6 (macOS and Linux), Firefox 155 (Linux), Mobile Safari 26.5 in the
   simulator and Android Chrome 113 in the emulator, with no failing case. **WebKit and Gecko can
   take `packs.apply.delta` over the WASM decoder.**
4. **WebCrypto Ed25519 kills WebKitGTK's web process for messages of about 64 KiB or more [M].**
   Linux WebKit, as both the Playwright build and Ubuntu 24.04's distro **WebKitGTK 2.52.6 /
   libgcrypt 1.10.3**, gives:
   - `OperationError` from 65,504 B;
   - a web-process crash (`Ohhhh jeeee: ... this is a bug (sexp.c:481:_gcry_sexp_find_token)`)
     at 65,535 B, at the 87 KB payload and at the 350 KB bundle, for verify as well as sign;
   - correct results at 65,472 B and below.

   Feature detection therefore does not protect Tauri on Linux (X-02). The fallback must also be
   chosen by signing-input size.

   Elsewhere:
   - Chromium, Firefox, macOS WebKit and Mobile Safari verify all three sizes in 0.04–2.6 ms;
   - Chrome 113 has no Ed25519 at all (`NotSupportedError`).

5. **Verification must run off the main thread in P1-02 [M][I].** The measurements:
   - A bundle verify blocks one frame for its whole duration: 90–176 ms here on a fast host, and
     500–880 ms under a 4–6× CPU throttle.
   - `WorkerThreadPool` removes the stall on threaded builds: the worst frame is back at the idle
     level.
   - On the **single-threaded web build `WorkerThreadPool` runs the task inline**, so its stall
     equals the main-thread stall (WebKit: 172 ms against 176 ms). Only the frame-sliced verifier
     helps there. With a 4 ms slice the worst frame was 22 ms against 24 ms idle, and the verify
     took 4.5× longer in wall time (703 ms against 157 ms).
6. **A Cortex-A53 phone, by derivation [I].** Scaling A5's quiet-host numbers by published CPU
   scores (×5–9) gives:
   - 35–70 ms for a small verify;
   - 140–280 ms for the 87 KB payload;
   - 0.5–0.9 s for the 350 KB bundle;
   - chunk sync at 18–32 MB/s.

   Plan boot-time chunk sync inline only for payloads up to **50 MB**, with background sync and
   progress above that. The throttled-Chromium Godot web runs agree with this band: 44–76 ms small
   and 0.5–0.9 s bundle.

7. **Replace README §5.2's estimates.** The proposed text is in the Recommendation. "20–45 ms on
   low-end Android" is optimistic by 1.5–2×, and it does not mention the 0.5–1 s bundle case.

## Method

### Harness

Everything is under [`prototype/lowend/`](../prototype/lowend/README.md), and it reuses the
existing code.

- **Wrapper project.** `project/` is a Godot 4.7.2 project. `sync.sh` copies in
  `addons/polaris_key` (`PKEd25519Fast`, `PKSha512`, `PKJws`) and the vectors. It also derives
  `PKLowendContent` from `content/runners/godot/content_runner.gd`, keeping everything but its
  SceneTree entry points.
- **The fixed run list.** `lowend.gd` runs with no command line:
  1. correctness first;
  2. then one warm-up round and five measured rounds, where each round runs every metric once, so
     no metric is looped on its own;
  3. then the frame-time probe.

  It writes `user://results.json`.

- **Frame-time probe.** A bar spins in `_process`. Around one verify of the 87 KB or 350 KB input,
  the probe records every `_process`-to-`_process` interval in five interleaved modes:
  - `idle`;
  - `main`: synchronous on the main thread;
  - `pool`: `WorkerThreadPool.add_task`, polled once per frame;
  - `sliced4` and `sliced8`: `PKLowendSliced`.

  `PKLowendSliced` is `PKEd25519Fast.verify` whose SHA-512 block loop and double-scalar multiply
  `await process_frame` once the slice budget is spent. It passes 26/26 and 68/68. It is a probe,
  not the SDK's verifier (P1-02).

- **Content bench.** On the small set (v1 5.26 MB → v2 5.26 MB) and, natively, the large set (37.0 →
  37.7 MB), it times:
  - full apply (decode + SHA-256);
  - chunk sync;
  - delta, verified and decode-only;
  - file rebuild;
  - index parse;
  - the planner.
- **Browsers.** `browser/index.html` runs the matrix as one page and POSTs the result:
  - worker capabilities (OPFS sync access handle, `DecompressionStream`, `Cache.put` of a 206);
  - WebCrypto Ed25519 on the page and in a worker, timed in batches because engine timers are
    coarsened;
  - the 75 cases with `webcrypto|hashwasm|noble` SHA-256, `custom|bokuweb` zstd, and Range on or
    off;
  - the throughput bench.

  It extends `content/runners/browser/`: the worker gains the `ed25519` and `lowbench` ops, and the
  server gains mounts and `POST /results`.

- **Browser drivers.** `drive.mjs` drives Playwright 1.63.0, and `linux-matrix.sh` runs the same
  in the official `mcr.microsoft.com/playwright:v1.63.0-noble` image. `edprobe.mjs` and
  `gtkprobe.py` isolate the WebKitGTK crash.

### Environment

Host: Apple M5 Pro (Mac17,9), 18 cores, 64 GB, macOS 27.0, Xcode 27.0 [M].

The host ran under extreme contention from parallel agents; `uptime` load averages were:

| Time  | Load average (1 min) | What was running         |
| ----- | -------------------- | ------------------------ |
| 03:01 | 130                  | the desktop run          |
| 04:02 | 880                  | the iOS simulator run    |
| 04:05 | 940                  | the Android emulator run |
| 04:29 | 790–1,020            | the later runs           |

`collect.sh` records `uptime` in every result. Treat each timing as an upper bound. The medians are
contaminated, and the best of five is the better estimator.

| Run                      | Runtime                                                                                                                                           | CPU seen by the runtime      | Label               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------- |
| macOS desktop            | release template (`macos.zip`, universal), `--headless`, `max_fps` 60                                                                             | M5 Pro, contended            | measured            |
| Android emulator         | release APK (arm64-v8a, no Gradle), AVD `s04lowend`, API 34, 2 vCPU, 2 GB, `-gpu host`                                                            | host cores via Hypervisor.fw | emulated            |
| iOS simulator            | iOS release engine, iPhone 17e sim, iOS 26.5 (software renderer)                                                                                  | host cores                   | emulated            |
| Godot web, Chromium      | `web_nothreads_release`, Playwright Chromium 153.0.8010.12 headless, CPU ×1 / ×4 / ×6                                                             | host; ×4 and ×6 via CDP      | measured / emulated |
| Godot web, WebKit        | same export, Playwright WebKit 26.6 on macOS and on Linux (arm64 container)                                                                       | host                         | measured            |
| Godot web, Mobile Safari | same export in the iOS 26.5 simulator's Safari (`simctl openurl`)                                                                                 | host                         | emulated            |
| Browser matrix           | Chromium 153 (macOS, Linux), WebKit 26.6 (macOS, Linux), Firefox 155.0 (Linux), Mobile Safari 26.5 (sim), Chrome 113.0.5672.136 (API 34 emulator) | host                         | measured / emulated |
| Distro WebKitGTK         | `libwebkitgtk-6.0-4` 2.52.6-0ubuntu0.24.04.1, libgcrypt 1.10.3, under Xvfb                                                                        | host                         | measured            |

Two build adaptations were needed.

- **iOS simulator.** The official 4.7.2 `ios.zip` ships an **x86_64-only** "arm64_x86_64-simulator"
  slice [M], which cannot link for the arm64 simulator. `ios-sim-retarget.py` patches the arm64
  device objects' `LC_BUILD_VERSION` to the simulator platform. `ios-sim-metal-stub.m` supplies two
  Metal constants (`MTLIOErrorDomain`, `MTLTensorDomain`) that the iOS 27 simulator SDK lacks.
- **WASM decoder.** It was built with zig 0.16's clang, since Apple clang has no `wasm-ld`. The
  build is 66,826 B, not byte-identical to A7's clang 18 build, and passes 75/75 in Node.

### Commands

The full sequence is in [`prototype/lowend/README.md`](../prototype/lowend/README.md). The
essential commands:

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype
godot --headless --path . --script res://tests/cli.gd -- ed25519 fast 20   # desktop sanity (Verify)
cd lowend && ./sync.sh both && godot --headless --path project --import
HOME=$PWD/build/godot-home godot --headless --path project --export-release macOS   # and Android, iOS, Web
build/macos/pkey-s04.app/Contents/MacOS/pkey-s04-lowend --headless -- rounds=5 probe_reps=3 large=1
adb install -r build/android/pkey-s04.apk; adb shell am start -n org.polariskey.s04lowend/com.godot.game.GodotAppLauncher
./collect.sh android android-emu-api34-2core emulator-5580
python3 ios-sim-retarget.py build/ios   # then xcodebuild -sdk iphonesimulator ... (README)
./collect.sh ios-sim ios-sim-iphone17e <udid>
cd .. && MOUNTS=/lowend=$PWD/lowend RESULTS_DIR=$PWD/lowend/results/posted \
  node content/runners/browser/server.mjs "$PWD/content" 8431 &
node lowend/browser/drive.mjs chromium|webkit http://127.0.0.1:8431; GODOT=1 CPU=4|6 node lowend/browser/drive.mjs chromium ...
LARGE=1 lowend/browser/linux-matrix.sh; GODOT=1 lowend/browser/linux-matrix.sh webkit
xcrun simctl openurl <udid> "http://localhost:8431/lowend/browser/index.html?tag=ios-sim-safari&large=1"
adb reverse tcp:8431 tcp:8431; adb shell am start -a android.intent.action.VIEW -d "http://localhost:8431/lowend/browser/index.html?..." com.android.chrome
node lowend/report.mjs lowend/results/*.json; node lowend/browser/report.mjs lowend/results/browser-*.json
```

The raw JSON of every run is in `prototype/lowend/results/`, which is git-ignored and regenerated by
the commands above.

## Results

### 1. Correctness per runtime [M]

| Runtime (label)                                    | SHA-512 | Ed25519 fast / sliced | jwsCases | raw sigs | content |
| -------------------------------------------------- | ------- | --------------------- | -------- | -------- | ------- |
| macOS release template (measured)                  | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Android arm64 release APK, API 34 (emulated)       | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| iOS release engine, iOS 26.5 (emulated)            | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web nothreads, Chromium 153 (measured)       | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web nothreads, WebKit 26.6 macOS / Linux     | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web nothreads, Mobile Safari 26.5 (emulated) | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web, Firefox 155 Linux headless              | —       | —                     | —        | —        | —       |
| Godot web, Android Chrome 113 emulator             | —       | —                     | —        | —        | —       |

The last two did not start: Godot requires WebGL2.

- Headless Firefox in a GPU-less container has none, even with `webgl.force-enabled`.
- The emulator's Chrome 113 GPU process kept exiting (`gpu_process_host.cc(953)`).

The JavaScript matrix covers both browsers instead (§4), and the device runs are in the hand-off.

### 2. Ed25519 in pure GDScript, ms per verify: median (best of 5)

| Runtime                                          | Label         | 252 B         | 87 KB (cap)     | 350 KB (cap)    | SHA-512 MB/s |
| ------------------------------------------------ | ------------- | ------------- | --------------- | --------------- | ------------ |
| A5 reference: Linux release, Xeon 2.1 GHz, quiet | measured (A5) | 7.06 (6.60)   | 28.4            | 95.7            | ~3.6         |
| macOS release, M5 Pro, load 130                  | measured      | 7.85 (7.44)   | 33.9 (24.1)     | 140.6 (113.8)   | 2.0 (2.8)    |
| iOS 26.5 simulator, load 880                     | emulated      | 6.83 (6.42)   | 22.3 (19.9)     | 68.3 (64.2)     | 5.4 (6.4)    |
| Android API 34 emulator, 2 vCPU, load 940        | emulated      | 14.5 (7.5)    | 85.2 (38.3)     | 515 (310)       | 0.7 (1.2)    |
| Godot web, Chromium 153                          | measured      | 10.8 (10.5)   | 42.4 (40.6)     | 130 (126)       | 2.9 (2.9)    |
| Godot web, Chromium 153, CPU ×4                  | emulated      | 45.7 (43.8)   | 167 (155)       | 526 (497)       | 0.7 (0.8)    |
| Godot web, Chromium 153, CPU ×6                  | emulated      | 76.2 (67.2)   | 275 (245)       | 876 (792)       | 0.5 (0.5)    |
| Godot web, WebKit 26.6 macOS                     | measured      | 13 (12)       | 52 (48)         | 158 (157)       | 2.2 (2.5)    |
| Godot web, WebKit 26.6 Linux                     | measured      | 16 (13)       | 54 (50)         | 165 (159)       | 2.1 (2.3)    |
| Godot web, Mobile Safari 26.5 simulator          | emulated      | 12 (11)       | 49 (43)         | 157 (138)       | 2.4 (2.8)    |
| **Cortex-A53/A55, ≤ 3 GB, Android 10+**          | unmeasured    | **35–70** [I] | **140–280** [I] | **480–900** [I] | ~0.4–0.7 [I] |
| Mid-range Android (A73/A76 big cores)            | unmeasured    | 18–30 [I]     | 70–120 [I]      | 250–400 [I]     | —            |
| Oldest iPhone on iOS 15 (A9, iPhone 6s)          | unmeasured    | 12–20 [I]     | 50–80 [I]       | 170–280 [I]     | —            |
| Current iPhone (A18/A19)                         | unmeasured    | 3–6 [I]       | 10–25 [I]       | 35–80 [I]       | —            |

Readings:

- **SHA-512 dominates the large inputs [M].** The 350 KB verify is about 12× the small one in
  every runtime.
- **Web is 1.4–1.7× native on the same host [M].** Compare Chromium's best of 10.5 / 40.6 / 126
  with the iOS-engine best of 6.4 / 19.9 / 64.2.
- **The unmeasured rows scale A5's quiet-host numbers by published Geekbench 6 single-core
  scores [S][I].**
  - The Xeon host is taken at about 1,200. Helio G35 (8× A53) scores 189, Snapdragon 680 412 and
    Apple A9 633–645.
  - That gives ×6.3 for an A53 phone, ×2.9 for a mid-range phone and ×1.9 for an A9.
  - The ranges widen these by −20%/+50%, because in-order A53 cores suffer more than benchmark
    mixes on interpreter-heavy code.
  - Two runs corroborate them: throttling Chromium ×4–×6 gives 44–76 ms and 0.5–0.9 s.
- **This host is not a speed reference.** Its uncontended M5 Pro (Geekbench 6 about 4,200) should
  beat the Xeon by about 3×, yet it measured like the Xeon. That is the contention.

### 3. Engine SHA-256, engine zstd and the content bench, MB/s of output: best of 5 (small set) / best of 3 (large set)

| Runtime                              | Label         | Set   | SHA-256 stream | zstd full      | full apply | chunk sync    | delta verified | file rebuild  |
| ------------------------------------ | ------------- | ----- | -------------- | -------------- | ---------- | ------------- | -------------- | ------------- |
| A7 reference: Linux release, Xeon    | measured (A7) | large | 242            | 568            | —          | 161           | 97             | 129           |
| macOS release, M5 Pro, load 130      | measured      | small | 274            | 1,280          | 246        | 192           | 69             | 43            |
| macOS release, M5 Pro, load 130      | measured      | large | 209            | 925            | 50         | 112           | 50             | 28            |
| iOS 26.5 simulator                   | emulated      | small | 307            | 1,067          | 239        | 188           | 129            | 56            |
| iOS 26.5 simulator                   | emulated      | large | 277            | 731            | 204        | 194           | 136            | 128           |
| Android API 34 emulator, 2 vCPU      | emulated      | small | 164            | 771            | 29         | 112           | 24             | 17            |
| Android API 34 emulator, 2 vCPU      | emulated      | large | 74             | 232            | 57         | 43            | 32             | 44            |
| Godot web, Chromium 153              | measured      | small | 241            | 1,031          | 214        | 157           | 118            | 61            |
| Godot web, Chromium ×4               | emulated      | small | 57             | 212            | 49         | 39            | 44             | 13            |
| Godot web, Chromium ×6               | emulated      | small | 38             | 135            | 32         | 24            | 18             | 8             |
| Godot web, WebKit 26.6 macOS / Linux | measured      | small | 210 / 210      | 877 / 877      | 195 / 181  | 138 / 138     | 107 / 105      | 69 / 58       |
| Godot web, Mobile Safari 26.5 sim    | emulated      | small | 239            | 1,052          | 210        | 159           | 114            | 81            |
| **Cortex-A53 phone**                 | unmeasured    | large | **30–50** [I]  | **70–110** [I] | —          | **18–32** [I] | **11–19** [I]  | **14–26** [I] |

Readings:

- **Godot's SHA-256 is software even on arm64 [M][I].** The M5, which has SHA-2 instructions, hashes
  at the same 210–310 MB/s as the Xeon, which lacks SHA-NI, and far below Chromium's WebCrypto (1.4–
  2.0 GB/s on the same host). So Godot 4.7.2's mbedTLS does not use the ARMv8 crypto extensions. A
  low-end phone's SHA-256 therefore scales with its scalar speed, and the A53 row is the Xeon's
  242 MB/s ÷ 5–8.
- **Chunk sync stays at 55–75% of raw SHA-256 speed in every runtime [M].** A7 found the same. It
  is the throughput to plan with.
- **The large-set native medians collapsed under load**: 2–4× below the best run. Only the best runs
  are shown.

### 4. Browser matrix: WebCrypto Ed25519, the 75 cases, SHA-256, WASM zstd and OPFS

WebCrypto Ed25519 in a dedicated worker, ms per verify: median (best), batches of 10–100.

| Browser                                             | Label      | Page / worker available                                 | 252 B         | 87 KB                            | 350 KB                  |
| --------------------------------------------------- | ---------- | ------------------------------------------------------- | ------------- | -------------------------------- | ----------------------- |
| Chromium 153 macOS / Linux                          | measured   | yes / yes                                               | 0.04 / 0.06   | 0.10 / 0.12                      | 0.27 / 0.33             |
| WebKit 26.6 macOS (Playwright)                      | measured   | yes / yes                                               | 0.58 (0.31)   | 0.9 (0.55)                       | 2.4 (1.2)               |
| WebKit 26.6 Linux (Playwright; WebKitGTK proxy)     | measured   | yes / yes                                               | 1.63 (1.33)   | **web process crashes**          | **web process crashes** |
| WebKitGTK 2.52.6 distro (Tauri's engine)            | measured   | yes                                                     | 2 ms, correct | **crashes (libgcrypt sexp bug)** | **crashes**             |
| Firefox 155 Linux                                   | measured   | yes / yes                                               | 0.26 (0.18)   | 0.95 (0.55)                      | 2.6 (2.1)               |
| Mobile Safari 26.5 (iOS simulator)                  | emulated   | yes / yes                                               | 0.8 (0.15)    | 0.7 (0.3)                        | 0.7 (0.6)               |
| Android Chrome 113 (API 34 emulator)                | emulated   | **no**: `NotSupportedError`, "Unrecognized name"        | —             | —                                | —                       |
| iOS Safari, real iPhone; Android Chrome, real phone | unmeasured | Safari: yes (same engine) [I]; Chrome: yes from 137 [S] | < 3 [I]       | < 5 [I]                          | < 10 [I]                |

The WebKitGTK size bisection, with a generated key and a fresh page per size [M]:

| Message size          | Result                     |
| --------------------- | -------------------------- |
| up to 65,472 B        | correct                    |
| 65,504 B and 65,520 B | `OperationError`           |
| 65,535 B and above    | the web process terminates |

The distro build prints `Ohhhh jeeee: ... this is a bug (../../src/sexp.c:481:_gcry_sexp_find_token)`
before it dies. Verify-only over the corpus's 87,474 B and 349,618 B signing inputs crashes the same
way. The raw log is `results/webkitgtk-2.52.6-ed25519.txt`.

A search found no public report of this crash, only the separate leading-zero key bug in the same
GCrypt backend (WebKit PR 72772) [S]. It should be filed upstream (hand-off).

Content vectors, 75 cases [M]:

| Browser                       | webcrypto + custom WASM + Range | hash-wasm + custom WASM, no Range | noble + bokuweb + Range |
| ----------------------------- | ------------------------------- | --------------------------------- | ----------------------- |
| Chromium 153 macOS / Linux    | 75/75 / 75/75                   | 75/75 / 75/75                     | 75/75 / 75/75           |
| WebKit 26.6 macOS / Linux     | 75/75 / 75/75                   | 75/75 / 75/75                     | 75/75 / 75/75           |
| Firefox 155 Linux             | 75/75                           | 75/75                             | 75/75                   |
| Mobile Safari 26.5 (emulated) | 75/75                           | 75/75                             | 75/75                   |
| Android Chrome 113 (emulated) | 75/75                           | 75/75                             | 75/75                   |

No case failed anywhere.

Throughput, JavaScript in a worker, MB/s. The large set is best of 3; Range is best of 2.

| Browser (label)                   | Set   | SHA-256 WebCrypto | hash-wasm | noble | WASM zstd full | delta apply | chunk sync, memory | chunk sync, HTTP Range |
| --------------------------------- | ----- | ----------------- | --------- | ----- | -------------- | ----------- | ------------------ | ---------------------- |
| Chromium 153 Linux (measured)     | large | 2,000             | 269       | 66    | 554            | 2,922       | 207                | 130                    |
| WebKit 26.6 Linux (measured)      | large | 1,850             | 153       | 170   | 649            | 3,770       | 122                | 100                    |
| Firefox 155 Linux (measured)      | large | 1,850             | 231       | 36    | 481            | 1,795       | 192                | 113                    |
| Mobile Safari 26.5 sim (emulated) | large | 2,177             | 157       | 135   | 607            | 4,189       | 78                 | 43                     |
| Android Chrome 113 emu (emulated) | large | 403               | 62        | 27    | 64             | 435         | 60                 | 36                     |

Notes on the throughput table:

- WebKit's timers are coarsened to 1 ms. Its small-set rows therefore quantise (5.26 MB in 3 ms
  reads as "1,753"), and only large-set rows are shown.
- The emulator's Chrome shares 2 vCPUs with the page and the host was at load ~940, so its row is a
  floor, not a phone.

Worker capabilities [M]:

- **OPFS `createSyncAccessHandle`** works in Chromium, Firefox, Mobile Safari (sim) and Android
  Chrome 113. It fails in **Playwright WebKit** on both macOS and Linux with `UnknownError`.
  A CI WebKit job therefore cannot exercise the OPFS path; the iOS simulator can.
- **`DecompressionStream`** has no `zstd` anywhere. `brotli` is present in WebKit (macOS) and
  Firefox.
- **`Cache.put` of a 206** is rejected everywhere, as A7 §9 found for Chromium.

### 5. Frame-time probe: worst frame gap in ms (median of 3 reps); wall time of the verify in ms

The 350 KB bundle:

| Runtime                             | Label      | idle worst / p50 | main thread     | WorkerThreadPool worst / wall | sliced 4 ms worst / wall | sliced 8 ms worst / wall |
| ----------------------------------- | ---------- | ---------------- | --------------- | ----------------------------- | ------------------------ | ------------------------ |
| macOS release, headless, 60 fps cap | measured   | 24 / 16          | **102**         | 24 / 90                       | 28 / 399                 | 31 / 166                 |
| iOS simulator (software renderer)   | emulated   | 39 / 24          | **91**          | 40 / 88                       | 45 / 603                 | 50 / 399                 |
| Android emulator, 2 vCPU            | emulated   | 297 / 18         | **602**         | 235 / 582                     | 434 / 1,907              | 239 / 884                |
| Godot web, WebKit 26.6 macOS        | measured   | 24 / 17          | **176**         | **172** / 156                 | **22** / 703             | 25 / 327                 |
| Godot web, WebKit 26.6 Linux        | measured   | 59 / 29          | **174**         | **176** / 159                 | 42 / 1,250               | 39 / 672                 |
| Godot web, Mobile Safari 26.5 sim   | emulated   | 18 / 17          | **158**         | **160** / 144                 | **23** / 685             | 24 / 321                 |
| Godot web, Chromium ×4              | emulated   | 186 / 46         | **640**         | **629** / 510                 | 248 / 9,760              | 219 / 4,553              |
| **Cortex-A53 phone, native**        | unmeasured | —                | **500–900** [I] | ≈ idle [I]                    | —                        | —                        |

The 87 KB payload at the cap, main thread against the best alternative:

| Runtime            | Main-thread stall | Best alternative |
| ------------------ | ----------------- | ---------------- |
| macOS              | 41                | pool 23          |
| Web, WebKit        | 66                | sliced 4 ms: 20  |
| Web, Mobile Safari | 59                | sliced 4 ms: 20  |

Readings:

- **Main thread.** The stall equals the verify time plus a frame, in every runtime [M].
- **`WorkerThreadPool` on threaded builds.** It brings the worst frame back to the idle level
  (macOS, iOS) [M]. On the contended 2-vCPU emulator it only halved the stall: the worker shares
  two cores with the renderer and a host at load 940.
- **`WorkerThreadPool` on the no-threads web build.** It executes the task synchronously inside
  `add_task` [M]: the stall matches the main thread's within 2%, and the task completes before the
  first poll (0 frames while running, against 3–5 on macOS and iOS). P1-02 cannot rely on it there.
- **Slicing.** At a 4 ms budget the worst frame matched idle in WebKit and Mobile Safari. The cost
  is wall time: at 60 fps, 4 ms per 16.7 ms frame is roughly a 24% duty cycle, so the verify takes
  ×4.5. At an 8 ms budget it takes ×2.1, with the worst frame at idle + 1–8 ms.
- **Headless Chromium's idle frames are already irregular** (p50 37–46 ms, worst 130–190 ms), so
  its slicing rows are noise. Use the WebKit rows.

## Recommendation

1. **P1-02: verify off the main thread, yes [M].**
   - Run every verify of a signing input over **4 KB** on `WorkerThreadPool` when
     `OS.has_feature("threads")`. That covers bundles, licence documents near the cap and trust
     manifests.
   - Run everything **during gameplay** off the main thread too. Even the 252 B verify is an
     estimated 35–70 ms on an A53 phone, which is two to four frames.
   - On single-threaded web, use the sliced verifier with a **6 ms default budget**, configurable
     between 4 and 8 ms. Never rely on `WorkerThreadPool` there.
   - Where `JavaScriptBridge` reaches a WebCrypto that has Ed25519, prefer it on web as an optional
     accelerator. It is 50–500× faster and asynchronous. Restrict it to signing inputs **≤ 60,000
     B** on WebKitGTK and other GCrypt-backed WebKit, or detect the engine and skip WebCrypto for
     large inputs there. The GDScript path stays the oracle.
   - Keep the per-`kid` decompressed-key cache from the brief. On the 252 B verify it saves about
     0.4 ms of 7 (A5), which is not what matters on phones. Slicing and threading are.
2. **P1-10: stage budgets for PKeyBoot on the low-end phone [I].** A boot that verifies trust,
   licence and config (three small verifies) plus one bundle import needs:

   | Stage                                         | Budget  |
   | --------------------------------------------- | ------- |
   | three small verifies (trust, licence, config) | ~0.2 s  |
   | one bundle import                             | ~0.9 s  |
   | cache load and parse                          | ≤ 0.1 s |
   - The stage machine should show progress after 250 ms in any one stage. It should also not
     treat a 1 s bundle stage as a hang: time out at ≥ 10 s, not 2 s.
   - On desktop the same stages take about 25 ms and 100 ms.

3. **P4-08 / P4-11: chunk sync at boot [I].** Plan with **25 MB/s** of output on an A53-class phone
   (range 18–32), 70 MB/s on a mid-range phone, and 150 MB/s or more on desktop and current phones.
   The file-rebuild and verified-delta strategies run at about 0.5–0.8× the chunk rate.
   - **Inline chunk sync at boot for payloads up to 50 MB** (about 2 s on the low-end phone).
   - Above 50 MB, sync in the background, with progress UX and a "play with the old content"
     option.
   - These numbers are CPU-only: network fetch time (chunk bytes) comes on top, and the
     planner's request weighting (CONTENT §8) already accounts for that.
   - Keep the large-set memory in mind. A 37 MB payload needs about 3× its size resident (seed,
     output and decoded chunks) [I]; it ran on the 2 GB emulator [M], but test the ≤ 3 GB phone before
     raising the ceiling.
4. **P1b-05: browser versions [M].** Add **WebKit 26.6** and **Firefox 155.0**, as bundled by
   `playwright-core` **1.63.0**, next to Chromium 153.0.8010.12. Run them on Linux, in the image
   `mcr.microsoft.com/playwright:v1.63.0-noble`. That WebKit is the Linux port, so it also stands
   in for WebKitGTK.
   - Cap WebCrypto Ed25519 conformance inputs at 60,000 B on that WebKit, or assert the documented
     fallback. Otherwise the job crashes on `payload-at-cap` and `bundle-payload-at-cap`.
   - Do not expect OPFS sync access handles in Playwright WebKit.
   - Optionally, on a macOS runner, drive Mobile Safari through `simctl openurl` and the same POST
     endpoint.
5. **P4-18 / PARITY §11 Q4 [M].** WebKit and Gecko pass all 75 content cases with the vendored WASM
   decoder, with every SHA-256 backend and with Range on and off. The React SDK may claim
   `packs.apply.delta` on WebKit and Firefox **through the WASM path**; `dcz` remains Chromium-only.
6. **X-02 [M].** Feature detection of WebCrypto Ed25519 is insufficient on Tauri/Linux. WebKitGTK
   2.52.6 reports Ed25519 and verifies small messages, then kills the web process at about 64 KiB.
   The plugin's Rust Ed25519 fallback must be used for any signing input over 60,000 B on
   WebKitGTK. Better still, always use it on Linux: a crashed web process is not a catchable
   exception.
7. **README §5.2: replace the estimates** (proposed, not applied). Replace "Estimates: 20–45 ms on
   low-end Android, 10–60 ms on web." with:

   > Measured on web (single-threaded export, desktop host): 10.5–16 ms small, 40–54 ms at 87 KB,
   > 126–165 ms at 350 KB in Chromium, WebKit and Mobile Safari; a 4–6× CPU throttle gives 44–76 ms
   > / 155–275 ms / 0.5–0.9 s. Low-end Android (Cortex-A53) is derived, not measured: 35–70 ms small,
   > 140–280 ms at 87 KB, 0.5–0.9 s at 350 KB (notes/S-04). Every bundle-sized verify is a visible
   > stall; `WorkerThreadPool` does not help on the no-threads web build (it runs inline), so web
   > slices across frames.

   The recommendation bullet "run bundle-sized verifies off the main thread (chunked on
   single-threaded web)" stands, and gains "all verifies off the main thread during gameplay".
   README §12's "Performance on low-end devices" risk should say the web and emulated numbers are
   measured and the phone numbers still derived. CONTENT §17 Q4 is answered for browsers and
   emulated runtimes; the device rows remain open.

## Briefs changed in this branch

| Brief  | Change                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-02  | Design note: the off-thread threshold, `WorkerThreadPool` running inline on no-threads web, the slice budget, and the WebCrypto accelerator's 60,000 B cap on GCrypt WebKit |
| P1-10  | Design note: low-end stage budgets and the 250 ms progress / ≥ 10 s timeout rule                                                                                            |
| P4-08  | Design note: the per-device throughput planning figures and the 50 MB inline ceiling                                                                                        |
| P4-11  | Design note: the same figures for the SDK chunk-sync progress UX                                                                                                            |
| P1b-05 | Out → In: the WebKit 26.6 and Firefox 155.0 jobs (Playwright 1.63.0, Linux), with the Ed25519 cap and OPFS caveat                                                           |
| P4-18  | The WebKit/Gecko precondition is met through the WASM path                                                                                                                  |
| X-02   | The WebKitGTK Ed25519 crash: choose the fallback by size (or always on Linux), not by feature detection                                                                     |

This spike's own brief gains one design note: the official iOS template's simulator slice is
x86_64 only, and `ios-sim-retarget.py` works around it.

## Limits

- **No physical device.** This covers all four rows of the brief's minimum device set: an
  A53/A55-class Android phone with ≤ 3 GB, a mid-range Android phone, the oldest iPhone on iOS 15 and
  a current iPhone. Nor was there an HTTPS origin reachable from phones, or an Apple account to sign
  an iPhone build. Thermal state could not be observed. Every unmeasured row is a derivation.
- **Host contention.** Load averages of 130–1,000 on 18 cores make every timing an upper bound, and
  medians unreliable. This is why A5's quiet Xeon, not this M5, anchors the derivations.
- **Simulators and emulators** run at host speed. The iOS simulator used the software renderer and
  the Android emulator shared 2 vCPUs, so their frame baselines are poor.
- **Two runtimes could not start the Godot web build.** Headless Firefox in a container has no
  WebGL2 (a headed retry under Xvfb, with Mesa software GL, did not finish within its time limit). The emulator's Chrome
  113 GPU process kept exiting. Both browsers ran the JavaScript matrix.
- **Firefox on macOS would not launch under this session's sandbox** ("Could not find profile
  folder"). Firefox was measured on Linux only.
- **The WebKitGTK crash was reproduced on arm64 Ubuntu 24.04 only** (WebKitGTK 2.52.6, libgcrypt
  1.10.3). Other distributions and x86_64 were not tried.
- **The derived phone ranges rest on Geekbench 6 single-core ratios.** An interpreter-bound
  workload on an in-order core can fall outside them. The device run settles it.

## Hand-off (needs hardware or accounts)

- Run the wrapper APK on an A53/A55 phone with ≤ 3 GB (Android 10+) and on a mid-range Android
  phone, three times each after a warm-up and interleaved, then run `collect.sh android`. Record the
  model, SoC, RAM, OS and thermal state.
- Sign the iOS Xcode project with a team, and run it on the oldest iPhone on iOS 15 and on a current
  iPhone, then run `collect.sh ios-device`.
- Serve the harness over HTTPS reachable from the phones, and run `browser/index.html` and the
  Godot web export in iOS Safari and in low-end Android Chrome (≥ 137, for Ed25519).
- File the WebKitGTK/libgcrypt Ed25519 ≥ 64 KiB crash upstream, with `browser/gtk.html` as the
  reproduction.

## Sources

- [M] this note's runs: `prototype/lowend/results/*.json` (git-ignored; regenerate per the README).
- [V] `prototype/addons/polaris_key/crypto/{ed25519_fast,sha512}.gd`,
  `prototype/content/runners/godot/content_runner.gd`, `prototype/content/runners/browser/*`.
- notes/A5 §3 (the quiet-host Ed25519 numbers) and notes/A7 §8–§9 (desktop throughput, Chromium
  141).
- [S] Geekbench 6 single-core scores:
  - Helio G35 189: [CpuTronic](https://cputronic.com/soc/mediatek-helio-g35),
    [NanoReview G36](https://nanoreview.net/en/soc/mediatek-helio-g36);
  - Snapdragon 680 412–415: [NanoReview](https://nanoreview.net/en/soc/qualcomm-snapdragon-680),
    [HWPure](https://hwpure.com/submission/792-sm6225-snapdragon-680-4g-geekbench-6-single-core);
  - Apple A9 633–645: [NanoReview](https://nanoreview.net/en/soc/apple-a9),
    [CPU-Monkey](https://www.cpu-monkey.com/en/benchmark-apple_a9-geekbench_6_single_core);
  - M5 Pro about 4,250: [CPU-Monkey](https://www.cpu-monkey.com/en/cpu-apple_m5_pro_18_cpu_20_gpu).
- [S] WebCrypto Ed25519 on by default from Chrome 137 on desktop and Android (Firefox 129, Safari
  17 earlier): [Chrome 137 release notes](https://developer.chrome.com/release-notes/137),
  [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/T2kriFdjXsg/m/izUiF-1uBwAJ),
  [IPFS blog](https://blog.ipfs.tech/2025-08-ed25519/).
- [S] WebKit's GCrypt Ed25519 leading-zero key bug, a different defect in the same backend:
  [WebKit PR 72772](https://github.com/WebKit/WebKit/pull/72772).

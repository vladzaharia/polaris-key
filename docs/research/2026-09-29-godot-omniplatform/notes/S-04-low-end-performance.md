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

1. **No physical phone was available.** Every phone row is emulated or unmeasured, and the device
   runs are in the hand-off. The timings come from a second pass on a near-quiet host (load 7–21
   on 18 cores). A first pass ran under heavy contention from other work packages (load
   130–1,000) and is superseded; it agreed on every correctness result and every ratio.
2. **Correctness holds everywhere it ran [M].** The official 4.7.2 **release** templates pass
   everything in these runtimes:
   - macOS arm64;
   - the Android arm64 APK on an API 34 emulator;
   - the iOS engine in the iPhone 17e simulator (iOS 26.5);
   - the single-threaded web export in Chromium 153, WebKit 26.6 (macOS and Linux), Firefox 155
     (Linux, headed under Xvfb) and Mobile Safari 26.5.

   The suites that pass are:
   - SHA-512 24/24;
   - Ed25519 26/26, and 26/26 for the new frame-sliced verifier;
   - corpus v2 `jwsCases` 36/36;
   - raw corpus signatures 68/68;
   - content vectors 75/75.

3. **The browser matrix passes 75/75 for every primitive combo [M].** This covers Playwright
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
   chosen by signing-input size. Elsewhere:
   - Chromium, Firefox, macOS WebKit and Mobile Safari verify all three sizes in 0.02–0.7 ms;
   - Chrome 113 has no Ed25519 at all (`NotSupportedError`).

5. **Verification must run off the main thread in P1-02 [M][I].** The measurements:
   - A verify blocks one frame for its whole duration. For the 350 KB bundle that is 37 ms native
     and 75–160 ms on the web build on this host, and 1.6 s on the web build under a ×20 CPU
     throttle (an A53-class phone by Geekbench ratio).
   - `WorkerThreadPool` removes the stall on threaded builds (macOS, iOS simulator, Android
     emulator): the worst frame is back at the idle level.
   - On the **single-threaded web build `WorkerThreadPool` runs the task inline**, so its stall
     equals the main-thread stall (Chromium: 100 ms against 101 ms). Only the frame-sliced
     verifier helps there. With a 4 ms slice the worst frame stayed within 4 ms of idle in every
     browser, and the verify took 4–5× longer in wall time.
   - **On a low-end phone's web build, slicing is too slow for a bundle.** Under the ×20 throttle
     the sliced bundle verify took 6.5 s (8 ms slices) to 12 s (4 ms slices). This note therefore
     recommends WebCrypto Ed25519 on web wherever it exists, with slicing only as the fallback.
     That changes README §5.2's "pure GDScript is the one trust path", so it is a decision for the
     lead (Recommendation 1). Until the lead makes it, P1-02 slices.
6. **A Cortex-A53 phone, by derivation [I].** Scaling two quiet anchors (A5's Xeon and this M5
   Pro) by published CPU scores gives, natively:
   - 35–85 ms for a small verify;
   - 140–280 ms for the 87 KB payload;
   - 0.5–0.9 s for the 350 KB bundle;
   - chunk sync at 16–30 MB/s.

   The ×20-throttled web build lands where that predicts for web (1.7–2.7× native): 141 ms,
   0.5 s and 1.6 s, with chunk sync at 12 MB/s. Plan boot-time chunk sync inline only up to
   **50 MB natively and 25 MB on web**, with background sync and progress above that.

7. **Replace README §5.2's estimates.** The proposed text is in the Recommendation. "20–45 ms on
   low-end Android" is optimistic by up to 2×, "10–60 ms on web" holds only for desktop browsers,
   and neither mentions the 0.5–1.6 s bundle case.

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
- **CPU throttle as a phone stand-in.** Chromium's CDP `Emulation.setCPUThrottlingRate` slows the
  page's main thread. ×4 and ×6 approximate a mid-range phone; ×20 approximates an A53-class phone,
  because the M5 Pro's Geekbench 6 single-core score is about 22× a Helio G35's. It applies to the
  Godot web build only (workers are not throttled), so it models the web build, not a native APK.

### Environment

Host: Apple M5 Pro (Mac17,9), 18 cores, 64 GB, macOS 27.0, Xcode 27.0 [M].

| Pass               | Time (local) | Load average (1 min, 18 cores) | Status                   |
| ------------------ | ------------ | ------------------------------ | ------------------------ |
| first (contended)  | 03:00–04:30  | 130–1,020                      | superseded for timings   |
| second (near-idle) | 17:21–17:37  | 7–21                           | the timings in this note |

`collect.sh` records `uptime` in every result. Other agents' emulators stayed up during the second
pass, so even it is not a clean bench: medians sit within 2–10% of the best run, and the tables
give both.

| Run                      | Runtime                                                                                                                                      | CPU seen by the runtime        | Label               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- |
| macOS desktop            | release template (`macos.zip`, universal), `--headless`, `max_fps` 60                                                                        | M5 Pro                         | measured            |
| Android emulator         | release APK (arm64-v8a, no Gradle), AVD `s04lowend` (`sdk_gphone64_arm64`), Android 14 / API 34, 2 vCPU, 2 GB, `-gpu host`                   | 2 host cores via Hypervisor.fw | emulated            |
| iOS simulator            | iOS release engine, iPhone 17e sim, iOS 26.5 (23F77), software renderer                                                                      | host cores                     | emulated            |
| Godot web, Chromium      | `web_nothreads_release`, Playwright Chromium 153.0.8010.12 headless, CPU ×1 / ×4 / ×6 / ×20                                                  | host; throttles via CDP        | measured / emulated |
| Godot web, WebKit        | same export, Playwright WebKit 26.6 on macOS and on Linux (arm64 container)                                                                  | host                           | measured            |
| Godot web, Firefox       | same export, Playwright Firefox 155.0 on Linux, headed under `xvfb-run` (Mesa llvmpipe WebGL2)                                               | host                           | measured            |
| Godot web, Mobile Safari | same export in the iOS 26.5 simulator's Safari (`simctl openurl`)                                                                            | host                           | emulated            |
| Browser matrix           | Chromium 153 (macOS, Linux), WebKit 26.6 (macOS, Linux), Firefox 155.0 (Linux), Mobile Safari 26.5 (sim), Chrome 113.0.5672.136 (API 34 emu) | host                           | measured / emulated |
| Distro WebKitGTK         | `libwebkitgtk-6.0-4` 2.52.6-0ubuntu0.24.04.1, libgcrypt 1.10.3, under Xvfb                                                                   | host                           | measured            |

The Linux runs use OrbStack's arm64 VM (kernel 7.0.14) on the same host.

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
./collect.sh macos macos-quiet
adb install -r build/android/pkey-s04.apk; adb shell am start -n org.polariskey.s04lowend/com.godot.game.GodotAppLauncher
./collect.sh android android-emu-quiet emulator-5580
python3 ios-sim-retarget.py build/ios   # then xcodebuild -sdk iphonesimulator ... (README)
xcrun simctl launch <udid> org.polariskey.s04lowend; ./collect.sh ios-sim ios-sim-quiet <udid>
cd .. && MOUNTS=/lowend=$PWD/lowend RESULTS_DIR=$PWD/lowend/results/posted \
  node content/runners/browser/server.mjs "$PWD/content" 8431 &
LARGE=1 node lowend/browser/drive.mjs chromium|webkit http://127.0.0.1:8431 browser-<engine>-quiet
GODOT=1 CPU=1|4|6|20 node lowend/browser/drive.mjs chromium http://127.0.0.1:8431 godot-web-chromium-cpu<n>-quiet
GODOT=1 node lowend/browser/drive.mjs webkit http://127.0.0.1:8431 godot-web-webkit-quiet
LARGE=1 lowend/browser/linux-matrix.sh; GODOT=1 lowend/browser/linux-matrix.sh webkit
GODOT=1 HEADFUL=1 lowend/browser/linux-matrix.sh firefox
xcrun simctl openurl <udid> "http://localhost:8431/lowend/browser/index.html?tag=ios-sim-safari-quiet&large=1"
xcrun simctl openurl <udid> "http://localhost:8431/lowend/build/web/index.html"
adb reverse tcp:8431 tcp:8431; adb shell am start -a android.intent.action.VIEW \
  -d "'http://localhost:8431/lowend/browser/index.html?tag=android-emu-chrome-quiet&large=1'" com.android.chrome
node lowend/report.mjs lowend/results/*-quiet.json; node lowend/browser/report.mjs lowend/results/browser-*.json
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
| Godot web nothreads, Firefox 155 Linux (measured)  | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web nothreads, Mobile Safari 26.5 (emulated) | 24/24   | 26/26 / 26/26         | 36/36    | 68/68    | 75/75   |
| Godot web, Android Chrome 113 emulator             | —       | —                     | —        | —        | —       |

Godot needs WebGL2:

- Headless Firefox in a GPU-less container has none, even with `webgl.force-enabled`. Headed under
  `xvfb-run` it gets Mesa's llvmpipe and runs (`HEADFUL=1`).
- The emulator's Chrome 113 shows Godot's "check your browser configuration and hardware support"
  error on two attempts; its GPU process kept exiting (`gpu_process_host.cc(953)`).

The JavaScript matrix covers Chrome 113 instead (§4), and the device runs are in the hand-off.

### 2. Ed25519 in pure GDScript, ms per verify: median (best of 5)

| Runtime                                          | Label         | 252 B         | 87 KB (cap)     | 350 KB (cap)      | SHA-512 MB/s |
| ------------------------------------------------ | ------------- | ------------- | --------------- | ----------------- | ------------ |
| A5 reference: Linux release, Xeon 2.1 GHz, quiet | measured (A5) | 7.06 (6.60)   | 28.4            | 95.7              | ~3.6         |
| macOS release, M5 Pro                            | measured      | 3.88 (3.65)   | 12.9 (12.5)     | 37.4 (37.1)       | 10.3 (10.4)  |
| iOS 26.5 simulator                               | emulated      | 4.01 (3.92)   | 13.2 (13.0)     | 41.4 (40.5)       | 9.3 (9.4)    |
| Android API 34 emulator, 2 vCPU                  | emulated      | 4.40 (4.25)   | 17.7 (16.6)     | 52.5 (49.7)       | 7.2 (7.5)    |
| Godot web, Chromium 153                          | measured      | 6.3 (6.2)     | 26.3 (23.0)     | 83 (75)           | 4.6 (5.1)    |
| Godot web, WebKit 26.6 macOS                     | measured      | 8 (7)         | 31 (30)         | 103 (99)          | 3.7 (3.7)    |
| Godot web, WebKit 26.6 Linux                     | measured      | 13 (13)       | 50 (47)         | 193 (160)         | 2.3 (2.4)    |
| Godot web, Firefox 155 Linux                     | measured      | 14 (12)       | 48 (48)         | 160 (145)         | 2.5 (2.5)    |
| Godot web, Mobile Safari 26.5 simulator          | emulated      | 10 (10)       | 38 (38)         | 123 (121)         | 3.0 (3.1)    |
| Godot web, Chromium 153, CPU ×4                  | emulated      | 26.6 (26.2)   | 96 (93)         | 308 (294)         | 1.2 (1.3)    |
| Godot web, Chromium 153, CPU ×6                  | emulated      | 43.2 (39.8)   | 148 (146)       | 469 (458)         | 0.8 (0.8)    |
| **Godot web, Chromium 153, CPU ×20 (A53-class)** | emulated      | **145 (141)** | **512 (504)**   | **1,622 (1,608)** | 0.2 (0.2)    |
| **Cortex-A53/A55, ≤ 3 GB, Android 10+, native**  | unmeasured    | **35–85** [I] | **140–280** [I] | **480–900** [I]   | ~0.4–0.7 [I] |
| Mid-range Android (A73/A76 big cores), native    | unmeasured    | 18–40 [I]     | 70–130 [I]      | 250–400 [I]       | —            |
| Oldest iPhone on iOS 15 (A9, iPhone 6s), native  | unmeasured    | 12–25 [I]     | 50–85 [I]       | 170–280 [I]       | —            |
| Current iPhone (A18/A19), native                 | unmeasured    | 3–6 [I]       | 10–20 [I]       | 30–55 [I]         | —            |

Readings:

- **SHA-512 dominates the large inputs [M].** The 350 KB verify is 10–14× the small one in every
  runtime.
- **Web is 1.7–2.7× native on the same host [M].** Compare Chromium's best of 6.2 / 23 / 75 and
  WebKit's 7 / 30 / 99 with the macOS release's 3.65 / 12.5 / 37.1. Firefox and Linux WebKit are
  slower again, at 3.3–4.3×.
- **The emulators run at host speed [M].** The iOS simulator is within 10% of macOS; the 2-vCPU
  Android emulator is 15–35% slower. They are correctness checks, not phone timings.
- **The unmeasured rows scale two quiet anchors by published Geekbench 6 single-core scores
  [S][I].**
  - The Xeon (A5) is taken at about 1,200 and the M5 Pro at about 4,250. Helio G35 (8× A53)
    scores 189, Snapdragon 680 (A73) 412 and Apple A9 633–645.
  - The anchors disagree: the M5 is 3.5× the Xeon by score but only 1.9–2.6× faster here, so
    GDScript scales sub-linearly at the top. Xeon-anchored, an A53 phone is ×6.3 (44 / 179 /
    603 ms); M5-anchored it is ×22.5 (82 / 281 / 834 ms). The ranges span both, widened by 20%
    downwards.
  - The ×20-throttled web build corroborates the A53 row: dividing its 141 / 504 / 1,608 ms by the
    measured web-to-native factor of 1.7–2.7 gives 52–83 / 187–296 / 600–950 ms native.

### 3. Engine SHA-256, engine zstd and the content bench, MB/s of output: best of 5 (small set) / best of 3 (large set)

| Runtime                                 | Label         | Set   | SHA-256 stream | zstd full      | full apply | chunk sync    | delta verified | file rebuild  |
| --------------------------------------- | ------------- | ----- | -------------- | -------------- | ---------- | ------------- | -------------- | ------------- |
| A7 reference: Linux release, Xeon       | measured (A7) | large | 242            | 568            | —          | 161           | 97             | 129           |
| macOS release, M5 Pro                   | measured      | small | 507            | 2,007          | 411        | 324           | 225            | 125           |
| macOS release, M5 Pro                   | measured      | large | 509            | 1,482          | 380        | 369           | 240            | 273           |
| iOS 26.5 simulator                      | emulated      | small | 457            | 1,556          | 370        | 282           | 197            | 95            |
| iOS 26.5 simulator                      | emulated      | large | 478            | 1,229          | 352        | 329           | 220            | 230           |
| Android API 34 emulator, 2 vCPU         | emulated      | small | 363            | 1,441          | 288        | 217           | 149            | 121           |
| Android API 34 emulator, 2 vCPU         | emulated      | large | 370            | 917            | 268        | 216           | 151            | 174           |
| Godot web, Chromium 153                 | measured      | small | 390            | 1,696          | 348        | 262           | 193            | 106           |
| Godot web, WebKit 26.6 macOS            | measured      | small | 329            | 1,315          | 309        | 229           | 170            | 120           |
| Godot web, WebKit 26.6 Linux            | measured      | small | 219            | 877            | 202        | 135           | 114            | 64            |
| Godot web, Firefox 155 Linux            | measured      | small | 195            | 657            | 164        | 120           | 97             | 56            |
| Godot web, Mobile Safari 26.5 sim       | emulated      | small | 263            | 1,052          | 229        | 170           | 131            | 88            |
| Godot web, Chromium ×4                  | emulated      | small | 95             | 387            | 83         | 62            | 46             | 24            |
| Godot web, Chromium ×6                  | emulated      | small | 63             | 268            | 55         | 42            | 31             | 15            |
| **Godot web, Chromium ×20 (A53-class)** | emulated      | small | **18**         | **59**         | **15**     | **12**        | **9**          | **3.6**       |
| **Cortex-A53 phone, native**            | unmeasured    | large | **22–48** [I]  | **60–100** [I] | —          | **16–30** [I] | **10–16** [I]  | **12–20** [I] |

Readings:

- **Godot's SHA-256 is software even on arm64 [M][I].** The M5 has SHA-2 instructions, yet the
  engine hashes at 507 MB/s, a quarter of WebCrypto on the same host (1.5–2.6 GB/s, §4) and only
  2.1× the Xeon, which lacks SHA-NI. So Godot 4.7.2's mbedTLS does not use the ARMv8 crypto
  extensions, and a phone's SHA-256 scales with its scalar speed.
- **Chunk sync stays at 55–75% of raw SHA-256 speed in every runtime [M].** A7 found the same. It
  is the throughput to plan with.
- **The A53 row** takes the Xeon divided by 5–8 and the M5 divided by 22.5 as its two ends. The
  ×20-throttled web build's 12 MB/s chunk sync is the web build on such a phone.
- WebKit's timers are coarsened to 1 ms, so its small-set rows quantise (a 3 ms step is ±30%).

### 4. Browser matrix: WebCrypto Ed25519, the 75 cases, SHA-256, WASM zstd and OPFS

WebCrypto Ed25519 in a dedicated worker, ms per verify: median (best), batches of 10–100.

| Browser                                             | Label      | Page / worker available                                 | 252 B         | 87 KB                            | 350 KB                  |
| --------------------------------------------------- | ---------- | ------------------------------------------------------- | ------------- | -------------------------------- | ----------------------- |
| Chromium 153 macOS                                  | measured   | yes / yes                                               | 0.026 (0.023) | 0.085 (0.075)                    | 0.26 (0.24)             |
| Chromium 153 Linux                                  | measured   | yes / yes                                               | 0.049 (0.046) | 0.13 (0.12)                      | 0.35 (0.25)             |
| WebKit 26.6 macOS (Playwright)                      | measured   | yes / yes                                               | 0.09 (0.08)   | 0.2 (0.15)                       | 0.6 (0.5)               |
| WebKit 26.6 Linux (Playwright; WebKitGTK proxy)     | measured   | yes / yes                                               | 0.8 (0.62)    | **web process crashes**          | **web process crashes** |
| WebKitGTK 2.52.6 distro (Tauri's engine)            | measured   | yes                                                     | 2 ms, correct | **crashes (libgcrypt sexp bug)** | **crashes**             |
| Firefox 155 Linux                                   | measured   | yes / yes                                               | 0.09 (0.08)   | 0.25 (0.25)                      | 0.7 (0.6)               |
| Mobile Safari 26.5 (iOS simulator)                  | emulated   | yes / yes                                               | 0.07 (0.06)   | 0.15 (0.15)                      | 0.5 (0.4)               |
| Android Chrome 113 (API 34 emulator)                | emulated   | **no**: `NotSupportedError`, "Unrecognized name"        | —             | —                                | —                       |
| iOS Safari, real iPhone; Android Chrome, real phone | unmeasured | Safari: yes (same engine) [I]; Chrome: yes from 137 [S] | < 2 [I]       | < 6 [I]                          | < 15 [I]                |

The unmeasured row scales the Chromium, Firefox and Safari rows by the ×22 A53 factor and rounds
up. Even on such a phone WebCrypto is about 40–100× faster than GDScript.

The WebKitGTK size bisection, with a generated key and a fresh page per size [M]:

| Message size          | Result                     |
| --------------------- | -------------------------- |
| up to 65,472 B        | correct                    |
| 65,504 B and 65,520 B | `OperationError`           |
| 65,535 B and above    | the web process terminates |

The distro build prints `Ohhhh jeeee: ... this is a bug (../../src/sexp.c:481:_gcry_sexp_find_token)`
before it dies. Verify-only over the corpus's 87,474 B and 349,618 B signing inputs crashes the same
way. The raw log is `results/webkitgtk-2.52.6-ed25519.txt`. The quiet-pass Linux WebKit matrix
times only the small input (`EDMAX=65000`), because the larger ones crash the page.

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

No case failed anywhere, in either pass.

Throughput, JavaScript in a worker, large set (37 MB), MB/s: best of 3; Range is best of 2.

| Browser (label)                   | SHA-256 WebCrypto | hash-wasm | noble | WASM zstd full | delta apply | chunk sync, memory | chunk sync, HTTP Range |
| --------------------------------- | ----------------- | --------- | ----- | -------------- | ----------- | ------------------ | ---------------------- |
| Chromium 153 macOS (measured)     | 1,907             | 413       | 88    | 789            | 3,733       | 297                | 230                    |
| Chromium 153 Linux (measured)     | 1,832             | 274       | 57    | 562            | 2,401       | 172                | 107                    |
| WebKit 26.6 macOS (measured)      | 2,643             | 190       | 216   | 771            | 3,770       | 165                | 118                    |
| WebKit 26.6 Linux (measured)      | 2,056             | 185       | 203   | 617            | 1,984       | 146                | 111                    |
| Firefox 155 Linux (measured)      | 1,480             | 276       | 55    | 500            | 2,218       | 243                | 144                    |
| Mobile Safari 26.5 sim (emulated) | 2,467             | 181       | 154   | 787            | 2,900       | 105                | 85                     |
| Android Chrome 113 emu (emulated) | 1,823             | 479       | 86    | 600            | 2,083       | 288                | 151                    |

These run at host speed. Divide by about 20 for an A53-class phone [I]; the CPU throttle cannot
reach workers, so there is no emulated low-end row here.

Worker capabilities [M]:

- **OPFS `createSyncAccessHandle`** works in Chromium, Firefox, Mobile Safari (sim) and Android
  Chrome 113. It fails in **Playwright WebKit** on both macOS and Linux with `UnknownError`.
  A CI WebKit job therefore cannot exercise the OPFS path; the iOS simulator can.
- **`DecompressionStream`** has no `zstd` anywhere. `brotli` is present in WebKit (macOS), Mobile
  Safari and Firefox.
- **`Cache.put` of a 206** is rejected everywhere, as A7 §9 found for Chromium.

### 5. Frame-time probe: worst frame gap in ms (median of 3 reps); wall time of the verify in ms

The 350 KB bundle:

| Runtime                             | Label      | idle worst / p50 | main thread     | WorkerThreadPool worst / wall | sliced 4 ms worst / wall | sliced 8 ms worst / wall |
| ----------------------------------- | ---------- | ---------------- | --------------- | ----------------------------- | ------------------------ | ------------------------ |
| macOS release, headless, 60 fps cap | measured   | 24 / 16.5        | **71**          | 24 / 52                       | 24 / 255                 | 26 / 85                  |
| iOS simulator (software renderer)   | emulated   | 16.7 / 16.7      | **61**          | 17.6 / 50                     | 20.7 / 188               | 24.7 / 114               |
| Android emulator, 2 vCPU            | emulated   | 17.7 / 16.6      | **72**          | 18.7 / 67                     | 20.0 / 202               | 24.3 / 102               |
| Godot web, Chromium 153             | measured   | 17.2 / 16.7      | **101**         | **100** / 84                  | 20.6 / 336               | 24.7 / 171               |
| Godot web, WebKit 26.6 macOS        | measured   | 19 / 17          | **117**         | **117** / 100                 | 20 / 436                 | 24 / 208                 |
| Godot web, WebKit 26.6 Linux        | measured   | 22 / 17          | **185**         | **170** / 153                 | 21 / 805                 | 25 / 404                 |
| Godot web, Firefox 155 Linux        | measured   | 21 / 17          | **134**         | **142** / 126                 | 21 / 645                 | 25 / 291                 |
| Godot web, Mobile Safari 26.5 sim   | emulated   | 17 / 17          | **122**         | **125** / 108                 | 21 / 569                 | 25 / 219                 |
| Godot web, Chromium ×6              | emulated   | 18.3 / 16.7      | **525**         | **509** / 491                 | 22.6 / 2,504             | 24.5 / 1,139             |
| **Godot web, Chromium ×20**         | emulated   | 27.2 / 19.4      | **1,740**       | **1,741** / 1,715             | 41.6 / **12,042**        | 39.1 / **6,528**         |
| **Cortex-A53 phone, native**        | unmeasured | —                | **500–900** [I] | ≈ idle [I]                    | —                        | —                        |

The 87 KB payload at the cap, main thread against the best alternative:

| Runtime            | Idle worst | Main-thread stall | Best alternative        |
| ------------------ | ---------- | ----------------- | ----------------------- |
| macOS              | 24         | 30                | pool 22                 |
| Android emulator   | 18         | 35                | pool 17.5               |
| Web, Chromium      | 19         | 42                | sliced 4 ms: 21         |
| Web, WebKit macOS  | 20         | 48                | sliced 4 ms: 20         |
| Web, Firefox Linux | 21         | 67                | sliced 4 ms: 21         |
| Web, Mobile Safari | 18         | 46                | sliced 4 ms: 20         |
| Web, Chromium ×20  | 36         | 552               | sliced 4 ms: 34 (3.6 s) |

Readings:

- **Main thread.** The stall equals the verify time plus a frame, in every runtime [M].
- **`WorkerThreadPool` on threaded builds.** It brings the worst frame back to within 1 ms of idle
  on macOS, the iOS simulator and the 2-vCPU Android emulator [M]. In the contended first pass the
  emulator only halved the stall, because the worker then shared two cores with the renderer and
  a host at load 940. A real low-end phone with 4–8 small cores is closer to the quiet case [I].
- **`WorkerThreadPool` on the no-threads web build.** It executes the task synchronously inside
  `add_task` [M]: the stall matches the main thread's within 6% in every browser, and the task
  completes before the first poll. P1-02 cannot rely on it there.
- **Slicing.** At a 4 ms budget the worst frame stayed within 4 ms of idle in every browser. The
  cost is wall time: ×4–5.3 at 4 ms and ×2.0–2.3 at 8 ms, with the worst frame at idle + 5–8 ms at
  8 ms. Under the ×20 throttle the factors grow to ×7 and ×3.8, so a sliced bundle verify takes
  6.5–12 s.

## Recommendation

1. **P1-02: verify off the main thread, yes [M].**
   - Run every verify of a signing input over **4 KB** on `WorkerThreadPool` when
     `OS.has_feature("threads")`. That covers bundles, licence documents near the cap and trust
     manifests.
   - Run everything **during gameplay** off the main thread too. Even the 252 B verify is an
     estimated 35–85 ms on an A53 phone, which is two to five frames.
   - **Open decision for the lead [I]:** on single-threaded web, prefer WebCrypto Ed25519 through
     `JavaScriptBridge` wherever the browser has it (Chrome ≥ 137, Firefox ≥ 129, Safari ≥ 17). It is 90–300× faster than the
     GDScript path here and asynchronous. Restrict it to signing inputs **≤ 60,000 B** on WebKitGTK
     and other GCrypt-backed WebKit, or detect the engine and skip WebCrypto for large inputs
     there. The GDScript path stays the oracle.
     - This amends README §5.2's "pure GDScript is the one trust path" and turns P1-02's Out item
       "WebCrypto or GDExtension verify accelerators" into In for web. So it is proposed, not
       applied.
     - P1-02's brief records it as an open decision, with the acceptance row it would need: all 36
       `jwsCases` through the WebCrypto path in a web runner, and a proven fallback above 60,000 B
       on GCrypt WebKit.
     - Until the lead adopts it, P1-02 ships the sliced verifier on web.
   - Without WebCrypto Ed25519, use the sliced verifier with a **6 ms default budget**,
     configurable between 4 and 8 ms. Never rely on `WorkerThreadPool` there. Expect a sliced
     bundle verify to take 6–12 s on a low-end phone, and surface it as progress.
   - Keep the per-`kid` decompressed-key cache from the brief. On the 252 B verify it saves about
     0.4 ms of 7 (A5), which is not what matters on phones. Slicing and threading are.
2. **P1-10: stage budgets for PKeyBoot on the low-end phone [I].** A boot that verifies trust,
   licence and config (three small verifies) plus one bundle import needs:

   | Stage                                         | Native A53 | Web build on A53, no WebCrypto |
   | --------------------------------------------- | ---------- | ------------------------------ |
   | three small verifies (trust, licence, config) | ~0.25 s    | ~0.45 s (main thread)          |
   | one bundle import                             | ~0.9 s     | 1.6 s blocking, 6–12 s sliced  |
   | cache load and parse                          | ≤ 0.1 s    | ≤ 0.1 s                        |
   - The stage machine should show progress after 250 ms in any one stage. It should also not
     treat a slow bundle stage as a hang: time out at ≥ 10 s natively and ≥ 30 s on sliced web,
     not 2 s.
   - On a desktop host the same stages take about 11 ms and 37 ms natively, 19–42 ms and
     75–160 ms on web.

3. **P4-08 / P4-11: chunk sync at boot [I].** Plan with **20 MB/s** of output natively on an
   A53-class phone (range 16–30) and **12 MB/s** for the web build there; about 40 MB/s on a
   mid-range phone (35–55); 250 MB/s or more natively on desktop and current phones (measured
   324–369 here), 120–260 on desktop web. File rebuild and verified delta run at about 0.5–0.8× the
   chunk rate.
   - **Inline chunk sync at boot for payloads up to 50 MB natively and 25 MB on web** (about
     2–2.5 s of CPU on the low-end phone).
   - Above that, sync in the background, with progress UX and a "play with the old content"
     option.
   - These numbers are CPU-only: network fetch time (chunk bytes) comes on top, and the
     planner's request weighting (CONTENT §8) already accounts for that.
   - Keep the large-set memory in mind. A 37 MB payload needs about 3× its size resident (seed,
     output and decoded chunks) [I]; it ran on the 2 GB emulator [M], but test the ≤ 3 GB phone
     before raising the ceiling.
4. **P1b-05: browser versions [M].** Add **Firefox 155.0** and **WebKit 26.6**, as bundled by
   `playwright-core` **1.63.0**, next to Chromium 153.0.8010.12.
   - Run Firefox on Linux, for example in `mcr.microsoft.com/playwright:v1.63.0-noble`.
   - Run WebKit on a **macOS** runner. There, WebCrypto Ed25519 verifies the corpus's 87,474 B and
     349,618 B signing inputs correctly and rejects them with a flipped signature
     (`browser-webkit-quiet.json`).
   - **Do not add a Linux WebKit job yet.** It would crash on `payload-at-cap` and
     `bundle-payload-at-cap` on every run, because `shared-jws` calls `crypto.subtle.verify`
     directly (`index.ts:359`) and has no size-aware fallback. Failing loudly there is correct;
     skipping or capping those rows would weaken the runner (AGENTS rule 1).
   - The fix is a size-aware Ed25519 fallback in `shared-jws`/`client-core` for GCrypt-backed
     WebKit. It needs plan mode, because it touches `shared-jws`. No work package owns it.
     X-02's plan adds an injectable Ed25519 primitive for its Tauri (Rust) fallback. It lists a
     pure-JS fallback for plain browsers only as an option to compare, not as a deliverable. This
     is flagged to the lead as unowned. It matters beyond CI, because
     the React SDK in a WebKitGTK browser would crash the tab on an at-cap licence today [I].
   - Do not expect OPFS sync access handles in Playwright WebKit on either OS.
   - Whichever package adds a Godot web job in Firefox needs a headed browser under `xvfb-run`;
     headless has no WebGL2.
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

   > Measured on a desktop host (M5 Pro): native 3.7 ms small, 12.5 ms at 87 KB, 37 ms at 350 KB;
   > the single-threaded web export 6–14 ms / 23–50 ms / 75–160 ms in Chromium, Firefox, WebKit and
   > Mobile Safari. A ×20 CPU throttle (an A53-class phone) gives 141 ms / 0.5 s / 1.6 s on web.
   > Native low-end Android (Cortex-A53) is derived, not measured: 35–85 ms small, 140–280 ms at
   > 87 KB, 0.5–0.9 s at 350 KB (notes/S-04). Every bundle-sized verify is a visible stall;
   > `WorkerThreadPool` does not help on the no-threads web build (it runs inline), so web uses
   > WebCrypto Ed25519 where present and slices across frames otherwise.

   The last clause assumes the lead adopts Recommendation 1. Otherwise it reads "so web slices
   across frames".

   The recommendation bullet "run bundle-sized verifies off the main thread (chunked on
   single-threaded web)" stands, and gains "all verifies off the main thread during gameplay".
   README §12's "Performance on low-end devices" risk should say the web and emulated numbers are
   measured and the phone numbers still derived. CONTENT §17 Q4 is answered for browsers and
   emulated runtimes; the device rows remain open.

## Briefs changed in this branch

| Brief  | Change                                                                                                                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-02  | Design note: the off-thread threshold, `WorkerThreadPool` running inline on no-threads web, and the slice budget. WebCrypto first on web is recorded as an open decision for the lead; the Out item stands until then |
| P1-10  | Design note: low-end stage budgets (native and web) and the 250 ms progress / ≥ 10 s (≥ 30 s sliced web) timeout rule                                                                                                 |
| P4-08  | Design note: the per-device throughput planning figures and the 50 MB native / 25 MB web inline ceilings                                                                                                              |
| P4-11  | Design note: the same figures for the SDK chunk-sync progress UX                                                                                                                                                      |
| P1b-05 | New Part D (Goal, Scope, Steps, Acceptance, Verify, Size): Firefox 155.0 on Linux, WebKit 26.6 on macOS. A Linux WebKit job is Out until the unowned `shared-jws` fallback exists                                     |
| P4-18  | The WebKit/Gecko precondition is met through the WASM path                                                                                                                                                            |
| X-02   | The WebKitGTK Ed25519 crash: choose the fallback by size (or always on Linux), not by feature detection                                                                                                               |

This spike's own brief gains one design note: the official iOS template's simulator slice is
x86_64 only, and `ios-sim-retarget.py` works around it.

## Limits

- **No physical device.** This covers all four rows of the brief's minimum device set: an
  A53/A55-class Android phone with ≤ 3 GB, a mid-range Android phone, the oldest iPhone on iOS 15 and
  a current iPhone. Nor was there an HTTPS origin reachable from phones, or an Apple account to sign
  an iPhone build. Thermal state could not be observed. Every unmeasured row is a derivation.
- **A shared host.** The second pass ran at load 7–21 on 18 cores, with other agents' emulators
  running. Medians are within 2–10% of the best run; a dedicated bench would tighten them.
- **Simulators and emulators** run at host speed. They check correctness and give ratios.
- **CPU throttling is a model, not a phone.** CDP slows the main thread uniformly; a real A53 also
  has smaller caches, slower memory and thermal limits. It cannot throttle workers, so the
  JavaScript matrix has no low-end row.
- **Android Chrome 113 could not start the Godot web build** (no WebGL2 in the emulator's GPU
  process). It ran the JavaScript matrix only.
- **Firefox on macOS would not launch under this session's sandbox** ("Could not find profile
  folder"). Firefox was measured on Linux only.
- **The WebKitGTK crash was reproduced on arm64 Ubuntu 24.04 only** (WebKitGTK 2.52.6, libgcrypt
  1.10.3). Other distributions and x86_64 were not tried.
- **The derived phone ranges rest on Geekbench 6 single-core ratios**, and the two anchors already
  disagree (3.5× by score against 1.9–2.6× measured). An interpreter-bound workload on an in-order
  core can fall outside them. The device run settles it.

## Hand-off (needs hardware or accounts)

- Run the wrapper APK on an A53/A55 phone with ≤ 3 GB (Android 10+) and on a mid-range Android
  phone, three times each after a warm-up and interleaved, then run `collect.sh android`. Record the
  model, SoC, RAM, OS and thermal state.
- Sign the iOS Xcode project with a team, and run it on the oldest iPhone on iOS 15 and on a current
  iPhone, then run `collect.sh ios-device`.
- Serve the harness over HTTPS reachable from the phones, and run `browser/index.html` and the
  Godot web export in iOS Safari and in low-end Android Chrome (≥ 137, for Ed25519).
- Lead: decide whether to adopt WebCrypto first on web (Recommendation 1). It amends README
  §5.2 and P1-02's Out list.
- Lead: assign the size-aware Ed25519 fallback in `shared-jws`/`client-core` for GCrypt-backed
  WebKit (Recommendation 4). It is unowned, and a Linux WebKit runner waits on it.
- File the WebKitGTK/libgcrypt Ed25519 ≥ 64 KiB crash upstream, with `browser/gtk.html` as the
  reproduction.

## Sources

- [M] this note's runs: `prototype/lowend/results/*.json` (git-ignored; regenerate per the README).
  The quiet pass is `*-quiet.json` plus `browser-linux-*.json` and `godot-web-linux-*.json`.
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
- [S] Chrome DevTools Protocol `Emulation.setCPUThrottlingRate`:
  [CDP reference](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate).

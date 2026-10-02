# Content operations across languages: vectors and runners (A7)

This is research code for [Godot on Polaris Key](../../README.md) that backs
[A7: content operations across languages](../../notes/A7-xlang-content.md); it is not part of the
green gate and not a published SDK.

It builds one shared vector set for content delivery (`pkey-chunks/1` index parsing; full, chunk,
delta and file apply with negative cases; the install planner; files-index path rules) from the
[patching experiment](../patching/README.md)'s real Godot packs, and checks a reference applier in
each of six runtimes against the same expected verdicts: Python, Node, Chromium (Web Worker), the
JVM (standing in for Kotlin/Android), .NET and GDScript on Godot 4.7.2. The note's §3–§5 define the
formats, the planner and the corpus shape that this code implements.

## What is here

| Path                                                | What                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen/gen.py`                                        | the generator (CI stand-in): `gen.py small\|large <dir>` re-packs the input PCKs, chunks them (file-aware FastCDC), builds bundles, deltas and files indexes, mutates blobs for the negative cases and writes `cases.json` with expected verdicts. Python 3.14                                                                                                    |
| `gen/planref.py`                                    | the 19 synthetic planner rows and the 4 rows built from the set's own menu                                                                                                                                                                                                                                                                                        |
| `gen/refapply.py`                                   | shim: expected verdicts come from the Python reference runner                                                                                                                                                                                                                                                                                                     |
| `gen/pck.py`, `gen/fastcdc.cjs`                     | PCK v2–v4 reader/writer and the FastCDC port, identical to the copies in `../patching/tools/` (`.cjs` because the repo root `package.json` is ESM)                                                                                                                                                                                                                |
| `runners/python/pkey_content.py`                    | reference implementation (index, apply, planner, paths); zstd through stdlib `compression.zstd` (3.14) or `zstandard`                                                                                                                                                                                                                                             |
| `runners/python/runcases.py`                        | Python runner: `runcases.py <dir> stdlib\|zstandard`                                                                                                                                                                                                                                                                                                              |
| `runners/python/pkey_content_v1.py`, `runcorpus.py` | the P4-04 oracle: an independent implementation of `plans/P4-01.md` §2.7–§2.9's formats (blob refs in the files index, trees, the packed `pkey-patch/1` set, the window check, `packSetId`, the stamp, `selectVariant`, `planTarget`, the planner with `full.requests`), run over the repo's `conformance/corpus/v2/content/` and `plan-matrix.json` (see step 3) |
| `runners/js/content.mjs`                            | isomorphic JavaScript core; SHA-256 and zstd are injected, so Node and the browser share it unchanged                                                                                                                                                                                                                                                             |
| `runners/js/cases.mjs`                              | case interpreter shared by the Node and browser runners                                                                                                                                                                                                                                                                                                           |
| `runners/node/run.mjs`                              | Node runner: `run.mjs <dir> zlib\|zstd-napi`                                                                                                                                                                                                                                                                                                                      |
| `runners/node/run-wasm.mjs`                         | Node runner on the custom decoder-only WASM                                                                                                                                                                                                                                                                                                                       |
| `runners/browser/server.mjs`                        | static server with single-range `Range` and the Compression Dictionary Transport (`dcz`) endpoints `/cdt/v1.pck`, `/cdt/v2.pck`                                                                                                                                                                                                                                   |
| `runners/browser/{index.html,worker.mjs}`           | the page and the module worker: suite, capability probes (OPFS, `Cache.put` of a 206, `DecompressionStream`), benchmarks                                                                                                                                                                                                                                          |
| `runners/browser/drive.mjs`                         | Playwright driver: runs suite combos, the capability probe, the bench and the `dcz` check                                                                                                                                                                                                                                                                         |
| `runners/browser/cdtcap.mjs`                        | bisects Chromium's dictionary size cap (`SIZES=<bytes,...>`)                                                                                                                                                                                                                                                                                                      |
| `runners/browser/t.mjs`                             | smoke test: launch, load the page, ask the worker for its capabilities                                                                                                                                                                                                                                                                                            |
| `runners/browser/zstddec-prefix.mjs`                | 24-line loader for the WASM decoder                                                                                                                                                                                                                                                                                                                               |
| `runners/godot/`                                    | `ContentRunner` (`content_runner.gd`): the GDScript runner, with a bench mode and a `probe` mode; `--patch-from` goes through the engine's delta decoder (GDDL delta PCKs, A6 §2.4)                                                                                                                                                                               |
| `jvm/Runner.java`, `jvm/build.sh`                   | JVM runner (zstd-jni + `MessageDigest`) and a script that fetches its two jars (SHA-256 checked) and compiles it                                                                                                                                                                                                                                                  |
| `dotnet/runner/`                                    | .NET runner: `-p:TF=net11.0` uses the built-in `ZstandardDecoder`; `net10.0`, or `ZSTD=sharp`, uses ZstdSharp.Port; `probe` and `bench` modes                                                                                                                                                                                                                     |
| `dotnet/reflect/`                                   | lists the public `System.IO.Compression.Zstandard*` surface of the installed .NET 11                                                                                                                                                                                                                                                                              |
| `wasm/zdec.c`, `wasm/fakelibc/`                     | the 46-line shim (bump allocator, `memcpy`/`memset`, exports around `ZSTD_DCtx_refPrefix` + `ZSTD_decompressDCtx`) and five stub libc headers                                                                                                                                                                                                                     |
| `wasm/build.sh`                                     | fetches zstd 1.5.7 (SHA-256 checked) unless `ZSTD_SRC` is set, and builds the `-O3` and `-Oz` modules                                                                                                                                                                                                                                                             |
| `probe/magic/`                                      | the "base starts with the dictionary magic" probe (§7.1): `probe.mjs` (Node libraries), `M.java` (zstd-jni), `DZ.java` (any delta/old/new triple), `BW.java` (the 153 MiB window, §7.2)                                                                                                                                                                           |
| `probe/bigwin.mjs`                                  | the 153 MiB window in the WASM decoders and `zstd-napi` (§7.2)                                                                                                                                                                                                                                                                                                    |
| `npm/probe.mjs`                                     | the npm zstd package matrix (§7.4); lives next to the local `npm/node_modules`                                                                                                                                                                                                                                                                                    |
| `bench/bench_py.py`, `bench/bench-node.mjs`         | the Python and Node throughput rows of §8, on the large set                                                                                                                                                                                                                                                                                                       |
| `run-all.sh`                                        | every runner against one set: `run-all.sh small\|large`                                                                                                                                                                                                                                                                                                           |

Vector sets, fetched sources and jars, built modules, SDKs, virtualenvs and `npm/node_modules` are
all git-ignored (`.gitignore`). The vector sets are also excluded from Prettier, because they are
compared byte for byte when regenerated.

## Prerequisites

Versions are the ones the note measured with (A7 §1). Newer patch releases should work.

| Tool            | Version measured                                                                                                                                                                                   | Needed for                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Python          | 3.14.7 (stdlib `compression.zstd`); 3.11.15 and 3.9.25 with `zstandard` 0.25.0                                                                                                                     | generator (3.14 only), Python runners, bench                |
| zstd CLI        | 1.5.5                                                                                                                                                                                              | generator (`-19`, `--patch-from`); recorded in `cases.json` |
| Node            | 22.22.2; for the matrix also 22.18.0 (expected to fail 5 cases), 22.19.0 and 24.6.0. zstd prefix decode needs ≥ 22.19 / ≥ 24.6                                                                     | generator (FastCDC), Node and browser runners               |
| npm packages    | `zstd-napi` 0.0.13, `@bokuweb/zstd-wasm` 0.0.27, `zstd-codec` 0.1.5, `fzstd` 0.1.1, `zstddec` 0.3.1, `@mongodb-js/zstd` 7.0.0, `@noble/hashes` 2.4.0, `hash-wasm` 4.12.0, `playwright-core` 1.63.0 | Node `zstd-napi` runner, browser, probes                    |
| Chromium        | 141.0.7390.37, headless, driven by Playwright                                                                                                                                                      | browser runner                                              |
| JDK             | OpenJDK 21.0.10, with zstd-jni 1.5.7-20 and Gson 2.14.0 (fetched by `jvm/build.sh`)                                                                                                                | JVM runner                                                  |
| .NET            | SDK 10.0.401 (runtime 10.0.12) and SDK 11.0.100-rc.1.26425.128 (runtime 11.0.0-rc.1), ZstdSharp.Port 0.8.8                                                                                         | .NET runners                                                |
| Godot           | 4.7.2-stable official (`ed1daf0bf`): the standard editor binary and the official `linux_release.x86_64` template                                                                                   | GDScript runner                                             |
| clang + wasm-ld | 18.1.3 (`--target=wasm32`); no emscripten, no libc                                                                                                                                                 | WASM decoder                                                |

The input packs come from the patching experiment: `v1.pck` (37,001,008 B) and `v2.pck`
(37,697,544 B), exported by Godot 4.7.2. See [its README](../patching/README.md) to build them.

## Environment variables

| Variable                                      | Used by                                                                                                                  | Default                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `PACKS_DIR`                                   | `gen/gen.py` (`v1.pck`, `v2.pck`); `probe/bigwin.mjs`, `probe/magic/BW.java`, `bench/*` (`big_old.bin`, `big.pf.zst`)    | `../patching/out`: the patching experiment's export directory                         |
| `VECTORS_DIR`                                 | `run-all.sh`, `bench/*`                                                                                                  | `vectors`                                                                             |
| `PY314`, `PY39`, `PY311`                      | `run-all.sh`                                                                                                             | `py314/bin/python`, `py39/bin/python`, `../patching/venv/bin/python`                  |
| `NODE`, `NODES_DIR`                           | `run-all.sh` (`NODES_DIR` holds `node-v<version>-linux-x64/`)                                                            | `node`, `nodes`                                                                       |
| `NAPI_PATH`                                   | `runners/node/run.mjs` (an absolute path to `zstd-napi`'s entry)                                                         | the bare specifier `zstd-napi`                                                        |
| `DOTNET10_ROOT`, `DOTNET11_ROOT`              | `run-all.sh`                                                                                                             | `dotnet/sdk10`, `dotnet/sdk11`                                                        |
| `GODOT`                                       | `run-all.sh`                                                                                                             | `godot`                                                                               |
| `GODOT_TEMPLATES`                             | the release-template step below                                                                                          | `~/.local/share/godot/export_templates/4.7.2.stable`                                  |
| `ZSTD_SRC`, `CC`                              | `wasm/build.sh`                                                                                                          | fetch into `wasm/zstd-1.5.7`; `clang`                                                 |
| `PLAYWRIGHT_CORE`, `CHROMIUM`                 | `runners/browser/{drive,cdtcap,t}.mjs`                                                                                   | `npm/node_modules/playwright-core/index.mjs`; the browser Playwright installed itself |
| `ZSTD`, `SHARP_DICT`                          | .NET runner: `builtin\|sharp`; ZstdSharp dictionary mode `prefix\|load`                                                  | `builtin` (net11), `prefix`                                                           |
| `VERBOSE`, `DUMP`                             | runners: per-case lines; write the verdicts to a JSON file                                                               | unset                                                                                 |
| `COMBOS`, `NOBENCH`, `BENCHZ`, `NOCDT`, `OUT` | `drive.mjs`: `set:sha:zstd:range\|norange` list, skip bench, bench decoder (`bokuweb\|custom`), skip `dcz`, results file | three `bokuweb` combos; bench and `dcz` on; `browser-results.json`                    |
| `CDT_SET`, `CDT_BIG`                          | `server.mjs`: vector set for `/cdt/*`; a directory with the 160 MB pair instead                                          | `vectors/small`; unset                                                                |

Only the install and fetch steps use the network (`wasm/build.sh`, `jvm/build.sh`, `npm install`,
`dotnet-install.sh`, the NuGet restore of `dotnet build`). They take any proxy from the environment
(`HTTPS_PROXY`); nothing here hard-codes one.

## Run it

All commands run from this directory:

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype/content
```

1. **Input packs.** Build `../patching/out/v1.pck` and `../patching/out/v2.pck` with the
   [patching experiment](../patching/README.md), or point `PACKS_DIR` at a directory that holds
   them.

2. **Vectors.** The generator needs Python 3.14, `node` and the `zstd` CLI on `PATH`:

   ```sh
   python3.14 -m venv py314                          # stdlib zstd; nothing to install
   py314/bin/python gen/gen.py small vectors/small   # ~15 s; 4.1 MB, 75 cases
   py314/bin/python gen/gen.py large vectors/large   # ~90 s; 32 MB, same 75 cases, throughput only
   ```

   Running it again over the same packs rewrites every blob and `cases.json` byte for byte, so
   `diff -r` against a previous set is a drift check.

3. **Python.**

   ```sh
   python3.9 -m venv py39 && py39/bin/pip install zstandard==0.25.0
   py314/bin/python runners/python/runcases.py vectors/small stdlib
   py39/bin/python runners/python/runcases.py vectors/small zstandard
   ```

   The repo's content corpus (P4-04) is in P4-01's formats, not A7's, so it has its own runner.
   From the repository root, with Python 3.14:

   ```sh
   python3.14 docs/research/2026-09-29-godot-omniplatform/prototype/content/runners/python/runcorpus.py conformance/corpus/v2
   ```

   It checks every blob against `content/cases.json`'s table, then compares every content case and
   every `plan-matrix.json` row and case by canonical JSON. It is a one-off cross-check of the
   generator, not part of the gate.

4. **Node** (and the npm packages the browser and probes use):

   ```sh
   npm install --prefix npm @bokuweb/zstd-wasm@0.0.27 @mongodb-js/zstd@7.0.0 @noble/hashes@2.4.0 \
     fzstd@0.1.1 hash-wasm@4.12.0 playwright-core@1.63.0 zstd-codec@0.1.5 zstd-napi@0.0.13 zstddec@0.3.1
   wasm/build.sh                                     # decoder-only libzstd -> runners/browser/zstddec-prefix.wasm
   node runners/node/run.mjs vectors/small zlib
   NAPI_PATH=$PWD/npm/node_modules/zstd-napi/dist/index.js node runners/node/run.mjs vectors/small zstd-napi
   node runners/node/run-wasm.mjs vectors/small
   ```

   For the version matrix, unpack official builds into `nodes/`, for example
   `mkdir -p nodes && curl -sSfL https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.xz | tar -xJ -C nodes`.

5. **JVM.**

   ```sh
   jvm/build.sh
   java -Xmx4g -cp "jvm/lib/*:jvm/out" Runner vectors/small
   java -Xmx4g -cp "jvm/lib/*:jvm/out" Runner vectors/large bench
   ```

6. **.NET.** Install the SDKs with Microsoft's `dotnet-install.sh` (not vendored here), then build
   one output directory per target framework:

   ```sh
   curl -sSfL -o dotnet/dotnet-install.sh https://dot.net/v1/dotnet-install.sh
   bash dotnet/dotnet-install.sh --version 10.0.401 --install-dir dotnet/sdk10
   bash dotnet/dotnet-install.sh --version 11.0.100-rc.1.26425.128 --install-dir dotnet/sdk11
   (cd dotnet/runner && DOTNET_ROOT=../sdk11 ../sdk11/dotnet build -c Release -p:TF=net11.0 -o bin11)
   (cd dotnet/runner && DOTNET_ROOT=../sdk10 ../sdk10/dotnet build -c Release -p:TF=net10.0 -o bin10)
   DOTNET_ROOT=dotnet/sdk11 dotnet/sdk11/dotnet dotnet/runner/bin11/runner.dll vectors/small            # built-in
   ZSTD=sharp DOTNET_ROOT=dotnet/sdk11 dotnet/sdk11/dotnet dotnet/runner/bin11/runner.dll vectors/small # ZstdSharp
   DOTNET_ROOT=dotnet/sdk10 dotnet/sdk10/dotnet dotnet/runner/bin10/runner.dll vectors/small
   ```

   `runner.dll <dir> bench` prints the throughput rows; `runner.dll probe <delta> <old> <new>`
   decodes one `--patch-from` frame with every available API.

7. **Godot.** Pass absolute vector paths. On the editor:

   ```sh
   godot --headless --path runners/godot --script res://content_runner.gd -- "$PWD/vectors/small"
   ```

   Official 4.6+ templates ignore `--script` (godotengine/godot#111909), so for the release template
   export the runner as a pack next to a copy of the template; `project.godot` sets
   `run/main_loop_type="ContentRunner"`:

   ```sh
   mkdir -p runners/godot/tpl
   godot --headless --path runners/godot --export-pack Linux "$PWD/runners/godot/tpl/runner.pck"
   cp "$GODOT_TEMPLATES/linux_release.x86_64" runners/godot/tpl/runner.x86_64
   runners/godot/tpl/runner.x86_64 --headless -- "$PWD/vectors/small"
   runners/godot/tpl/runner.x86_64 --headless -- "$PWD/vectors/large" bench
   ```

   The negative case `delta-whole-wrong-base-unchecked` makes the engine log
   `Failed to decode delta … Restored data doesn't match checksum`; that is the expected verdict.

8. **Browser.** The server's root is this directory, so it serves `runners/`, `vectors/` and
   `npm/node_modules/`:

   ```sh
   node runners/browser/server.mjs "$PWD" 8123 &
   CHROMIUM=/path/to/chromium-141/chrome NOBENCH=1 \
     COMBOS=small:webcrypto:bokuweb:range,small:hashwasm:custom:range,small:noble:custom:norange \
     node runners/browser/drive.mjs http://127.0.0.1:8123
   CHROMIUM=/path/to/chromium-141/chrome BENCHZ=custom COMBOS=large:hashwasm:custom:range \
     node runners/browser/drive.mjs http://127.0.0.1:8123          # needs vectors/large
   CHROMIUM=/path/to/chromium-141/chrome SIZES=104857600,104857601 node runners/browser/cdtcap.mjs
   ```

9. **Everything at once.** After steps 2–8 (the release-template runner included), with the
   defaults or the environment variables above:

   ```sh
   ./run-all.sh small
   ./run-all.sh large
   ```

10. **Throughput** (§8), on the large set: `py314/bin/python bench/bench_py.py stdlib`,
    `py39/bin/python bench/bench_py.py zstandard`, `node bench/bench-node.mjs`, plus the `bench`
    modes of the JVM, .NET and Godot runners and `drive.mjs` above. The Python and Node scripts
    also decode the 160 MB pair from `PACKS_DIR`.

11. **Probes** (§7). They need inputs that were made by hand and are not kept (see Known limits):

    - `probe/magic/{old.bin,new.bin,d.zst}`: a 440,008 B base that begins with the zstd dictionary
      magic `37 A4 30 EC` followed by four zero bytes, a 405,400 B target sharing its first
      100,000 B, and `zstd -19 --patch-from=old.bin new.bin -o d.zst`.
    - `probe/{old.bin,new.bin,d.zst}`: a 3,000,000 B base, a 2,900,013 B target sharing its first
      1,000,000 B, and their `--patch-from` frame (the second dictionary case of `npm/probe.mjs`).
    - `probe/v1-v2.dcz`: the RFC 9842 header `5E 2A 4D 18 20 00 00 00` + SHA-256(v1 payload)
      followed by `vectors/small/blobs/deltas/v1-v2.pf.zst`; `probe/v1.bin` and `probe/v2.bin` are
      the small set's decoded payloads (§7.3).
    - `big_old.bin` and `big.pf.zst` in `PACKS_DIR`: the 160 MB base and its 822,301 B frame with a
      153 MiB window (A6 §2.4).

    ```sh
    node probe/magic/probe.mjs
    javac -cp "jvm/lib/*" -d probe/magic probe/magic/*.java
    java -cp "jvm/lib/*:probe/magic" M
    java -cp "jvm/lib/*:probe/magic" DZ probe/v1-v2.dcz probe/v1.bin probe/v2.bin
    java -Xmx4g -cp "jvm/lib/*:probe/magic" BW
    node probe/bigwin.mjs
    (cd npm && node probe.mjs)
    godot --headless --path runners/godot --script res://content_runner.gd -- probe "$PWD/probe/magic/d.zst" "$PWD/probe/magic/old.bin" "$PWD/probe/magic/new.bin"
    DOTNET_ROOT=dotnet/sdk11 dotnet/sdk11/dotnet dotnet/runner/bin11/runner.dll probe probe/magic/d.zst probe/magic/old.bin probe/magic/new.bin
    ```

## Expected results

**75/75 identical verdicts in every runtime** on both sets, except Node 22.18.0 (70/75, by
design: 22.15–22.18 and 24.0–24.5 silently ignore the zstd `dictionary` option). `run-all.sh small`
prints:

```text
python 3.14.7 [compression.zstd (libzstd 1.5.7)]: 75/75 cases match
python 3.9.25 [zstandard 0.25.0 (libzstd (1, 5, 7))]: 75/75 cases match
python 3.11.15 [zstandard 0.25.0 (libzstd (1, 5, 7))]: 75/75 cases match
node v22.22.2 [zlib, libzstd 1.5.7]: 75/75 cases match
node v22.22.2 [zstd-napi, libzstd 1.5.7]: 75/75 cases match
node v22.22.2 [custom wasm libzstd 1.5.7, zstddec-prefix.wasm]: 75/75 cases match
node v22.19.0 [zlib, libzstd 1.5.7]: 75/75 cases match
node v24.6.0 [zlib, libzstd 1.5.7]: 75/75 cases match
node v22.18.0 [zlib, libzstd 1.5.7]: 70/75 cases match
java 21.0.10 [zstd-jni 1.5.7-20, libzstd 1.5.7-20]: 75/75 cases match
.NET 11.0.0-rc.1.26425.128 [System.IO.Compression.ZstandardDecoder]: 75/75 cases match
.NET 11.0.0-rc.1.26425.128 [ZstdSharp.Port 0.8.8.0]: 75/75 cases match
.NET 10.0.12 [ZstdSharp.Port 0.8.8.0]: 75/75 cases match
[editor] godot 4.7.2-stable (official) [engine zstd via PackedByteArray.decompress + GDDL delta PCK; 66 patch-from calls, 132 mounts]: 75/75 cases match
[release template] godot 4.7.2-stable (official) [engine zstd via PackedByteArray.decompress + GDDL delta PCK; 66 patch-from calls, 132 mounts]: 75/75 cases match
```

The browser prints `browser <combo>: 75/75 match` per combo, and the `dcz` check returns v2's exact
SHA-256 with `"sent": "dcz"` in the server log. Every runner reproduces the pinned payload SHA-256
or tree digest, so agreeing verdicts also mean byte-identical outputs.

**The small set** (from A6's packs): v1 5,257,944 B (147 files), v2 5,255,248 B (151 files);
468 v2 chunk records in 6 bundles; 22 per-file deltas; 66 blobs, 4.1 MB on disk with `cases.json`.
**The large set:** the full 37.7 MB payload, 1,531 records, 64 KiB chunks, 4 MiB bundles, 32 MB.

**Throughput** (A7 §8; 4-vCPU Xeon @ 2.80 GHz without SHA-NI; MB/s of output, best of 3 or 5, warm,
single-threaded):

| Runtime                            | SHA-256 stream                                                     | zstd full decode (9.8 → 37.7 MB)         | Delta decode                       | Delta verified | Chunk                                                | File rebuild |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------- | -------------- | ---------------------------------------------------- | ------------ |
| Python 3.14 stdlib                 | 372                                                                | 388                                      | 419                                | 126            | 206                                                  | 171          |
| Python 3.11 `zstandard`            | 378                                                                | 560                                      | 717                                | 152            | 215                                                  | 176          |
| Node 22.22 `node:zlib`             | 386                                                                | 319 (default) – 578 (`chunkSize` 64 MiB) | 339 – 1,022                        | 121            | 221                                                  | 231          |
| Java 21 zstd-jni                   | 331                                                                | 617                                      | 800                                | 137            | 236                                                  | 189          |
| .NET 11 built-in                   | 397                                                                | 227                                      | 2,429                              | 185            | 285                                                  | 240          |
| .NET 10/11 ZstdSharp               | 385–387                                                            | 493–555                                  | 2,075–2,110                        | 177–180        | 273–278                                              | 202–208      |
| Godot 4.7.2 release template       | 242                                                                | 568                                      | 423 (engine, incl. host-PCK write) | 97             | **161**                                              | 129          |
| Chromium 141, custom WASM          | WebCrypto one-shot 179; `hash-wasm` stream 202; `@noble/hashes` 98 | 302                                      | 694                                | —              | 136 (memory); **106 over HTTP `Range`**, 29 requests | —            |
| Chromium 141, `@bokuweb/zstd-wasm` | as above                                                           | 146                                      | 480                                | —              | 136; 98 over `Range`                                 | —            |

**The WASM decoder:** `-O3` 68,949 B (24,110 B gzipped), `-Oz` 56,506 B (19,225 B). With clang
18.1.3, `wasm/build.sh` reproduces both byte for byte and says so.

## Known limits

From the note (A7 §13):

- No Swift toolchain or Apple hardware, no Kotlin compiler or Android device: Kotlin is represented
  by the same zstd-jni Java API on the JVM, and the `.aar`'s native libraries were not executed.
- One browser engine, headless Chromium 141 on Linux. Firefox, Safari and mobile browsers were not
  run.
- Localhost networking: `Range` and `dcz` timings exclude real RTT and CDN behaviour; the Worker
  and R2 were not exercised.
- One synthetic content pair from A6 (textures dominate). Single host, warm cache, best-of-N
  timings.
- .NET 11 is RC1.
- ZstdSharp's raw-prefix call reaches a private field by reflection. That is a test harness, not a
  design.
- The 160 MB window case was run once per decoder on a 16 GB host.

From porting the experiment into the repo:

- **The numbers above are tied to A6's exact packs.** Re-running `../patching` with other library
  or engine versions produces different packs, so hashes, chunk counts and byte figures in the
  expected verdicts change. The property to check is that every runtime agrees (75/75).
- **Hand-made probe inputs were not kept**, and neither was a generator for them: the magic-base
  pair, the 3 MB pair, the `dcz` body and the 160 MB pair are described in step 11 only.
  `probe/bigwin.mjs` and `probe/magic/BW.java` compare against the original 160 MB target's SHA-256
  (`085b1d1a…`), so a new pair needs that constant changed.
- The Python rows of the §7 decoder matrices were run inline; no script was kept for them.
- `npm install` pins the direct packages only; there is no lockfile.

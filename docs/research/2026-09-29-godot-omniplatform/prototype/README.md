# Pure-GDScript Ed25519 / JWS prototype (Godot 4.7)

This is research code for [Godot on Polaris Key](../README.md). It showed that a GDScript client
can verify Polaris Key's EdDSA compact JWS **without a GDExtension**.

Godot 4.7 has no Ed25519 and no SHA-512: mbedTLS 3.6 has no EdDSA, and `HashingContext` stops at
SHA-256. So both were implemented here in GDScript.

**The verifier now lives in [`sdks/godot/`](../../../../sdks/godot/README.md)** (P1-01), moved with
its history: `PKeySha512`, `PKeyEd25519` (was `PKEd25519Fast`), `PKeyEd25519Ref` (was
`PKEd25519Ref`) and `PKeyJws` (was `PKJws`), with the `sha512`, `ed25519`, `profile` and
conformance suites and the hand-generated vectors. There they run in the green gate, on an editor
and on an exported release template, against a generator-owned mirror of the corpus.

What stays here is the spike-probe harness. This project is not part of the green gate.

## What is here

| Path                      | What                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tests/cli.gd`            | `PKTestRunner`, the probe runner. A suite that moved to `sdks/godot` prints where to run it and exits 1 |
| `tests/suite_platform.gd` | `platform`: OS, engine and feature-tag facts, and `user://` paths                                       |
| `tests/http_probe.gd`     | the HTTP probe (redirect credentials, gzip and `Range`, `download_file`, ETag, TLS name mismatch)       |
| `lowend/`, `content/`, …  | other spikes; see [Other experiments](#other-experiments) and each directory's README                   |

## Run it

Needs the Godot 4.7 standard editor binary (not .NET).

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype
godot --headless --path . --import               # registers class_name globals
godot --headless --path . --script res://tests/cli.gd -- platform
godot --headless --path . --script res://tests/http_probe.gd   # network; honours HTTPS_PROXY
```

The verifier suites run from the SDK project instead:

```sh
godot --headless --path sdks/godot -- --pkey-test ci              # sha512, ed25519, conformance
godot --headless --path sdks/godot -- --pkey-test ed25519 bench 20
```

Official 4.6+ export templates ignore `--path`, `--script` and `--main-pack`
(godotengine/godot#111909). To run a probe on a release template instead of the editor:

1. Export the `Linux` preset with `--export-release`, which produces `build/pkey.x86_64` plus
   `build/pkey.pck`.
2. Run `./build/pkey.x86_64 --headless -- <suite>`. `project.godot` sets
   `application/run/main_loop_type="PKTestRunner"`.

## Results (Godot 4.7.2-stable `ed1daf0bf`, 4-vCPU Xeon @ 2.1 GHz)

Measured here before the move, with the prototype class names.

| Check                                                 | Result                                        |
| ----------------------------------------------------- | --------------------------------------------- |
| SHA-512 vectors                                       | 24/24                                         |
| Ed25519 vectors (fast and ref)                        | 26/26 each                                    |
| Corpus v2 `jwsCases` verdicts                         | **36/36**                                     |
| Raw Ed25519 over every distinct JWS in `cases.json`   | **68/68** agree with Node/OpenSSL             |
| `PKEd25519Fast` verify, release template              | ~7.1 ms median (min 5.35 ms)                  |
| `PKEd25519Fast` verify, editor                        | ~9 ms median                                  |
| `PKEd25519Ref` verify, release template               | ~122 ms                                       |
| 87 KB payload at cap / 350 KB bundle at cap (release) | 28 ms / 96 ms (dominated by GDScript SHA-512) |

The one decoded-document difference is `valid-nul-byte-in-string`. Its verdict is correct, but a
Godot `String` cannot hold U+0000, so the payload does not round-trip byte for byte. WIRE-CONTRACT-V3
§10 now declares that limit: `PKeyJws` decodes `\u0000` as U+FFFD on every engine, and the SDK
runner compares the generator's `expect.docNulReplaced` exactly.

The HTTP probe records five behaviours:

1. `HTTPRequest` forwards `Authorization` on cross-host redirects. Use `max_redirects = 0` and
   follow redirects yourself.
2. Gzip is on by default and breaks `Range`.
3. `download_file` truncates rather than appending; resume with `HTTPClient`.
4. ETag/304 is surfaced to the caller.
5. A TLS name mismatch fails closed.

## Not done yet

- A per-`kid` cache of the decompressed key and its precomputed table.
- Inlining field add/sub; flattening point storage. The realistic floor is about 4–5 ms.
- Running bundle-sized verifies off the main thread.
- A strict JSON validator (Godot's parser accepts trailing commas, leading zeros and raw control
  characters, and silently keeps the last duplicate key).
- Measurements on real phones and in browsers.

## Other experiments

Two more research experiments live next to this project. Like it, they are not part of the green
gate.

- [`patching/`](patching/README.md) backs [A6](../notes/A6-godot-patching.md): which patching and
  content-update methods a pure-GDScript client can run on Godot 4.7.2. Its exported packs are the
  input of the content vectors.
- [`content/`](content/README.md) backs [A7](../notes/A7-xlang-content.md): one shared
  content-delivery vector set, checked against reference appliers in Python, Node, Chromium, the
  JVM, .NET and GDScript.

# Pure-GDScript Ed25519 / JWS prototype (Godot 4.7)

This is research code for [Godot on Polaris Key](../README.md). It shows that a GDScript client can
verify Polaris Key's EdDSA compact JWS **without a GDExtension**.

Godot 4.7 has no Ed25519 and no SHA-512: mbedTLS 3.6 has no EdDSA, and `HashingContext` stops at
SHA-256. So both are implemented here in GDScript. This project is not part of the green gate and
not a published SDK. Moving it to `sdks/godot/` is the first task of the SDK phase.

## What is here

| Path                                             | What                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addons/polaris_key/crypto/sha512.gd`            | `PKSha512`: FIPS 180-4 SHA-512                                                                                                                                                                                                              |
| `addons/polaris_key/crypto/ed25519_fast.gd`      | `PKEd25519Fast`: ref10-style verify with unrolled field arithmetic and an interleaved double-scalar multiply. Rejects S ≥ L and non-canonical public keys, matching Node/OpenSSL                                                            |
| `addons/polaris_key/crypto/ed25519_tweetnacl.gd` | `PKEd25519Ref`: a TweetNaCl port, about 18× slower, kept as a cross-check                                                                                                                                                                   |
| `addons/polaris_key/jws.gd`                      | `PKJws`: the `packages/shared-jws` verify order (length caps, strict base64url, header cap and duplicate-key scan, alg/typ/kid, pinned trust lookup, Ed25519 over the ASCII signing input, then payload decode)                             |
| `tests/`                                         | suites run through `tests/cli.gd` (`PKTestRunner`): `sha512`, `ed25519 [ref\|fast] [iters]`, `jws`, `platform`, `profile`; plus `http_probe.gd`                                                                                             |
| `vectors/ed25519.json`                           | 26 vectors: RFC 8032 §7.1, Node-signed messages at SHA-512 block boundaries, and negatives whose verdicts come from Node                                                                                                                    |
| `vectors/sha512.json`                            | 24 SHA-512 vectors (Python `hashlib`)                                                                                                                                                                                                       |
| `vectors/gen_ed25519.mjs`                        | regenerates `ed25519.json` with Node's OpenSSL-backed crypto                                                                                                                                                                                |
| `vectors/gen_corpus.mjs`                         | derives `corpus_jws.json` (the 36 `jwsCases`) and `corpus_sigs.json` (every distinct JWS in `cases.json`, with Node's raw verdict) from `conformance/corpus/v2/cases.json`. The outputs are git-ignored, so run this before the `jws` suite |

## Run it

Needs the Godot 4.7 standard editor binary (not .NET) and Node 22.

```sh
cd docs/research/2026-09-29-godot-omniplatform/prototype
node vectors/gen_corpus.mjs                      # corpus-derived vectors (git-ignored)
godot --headless --path . --import               # registers class_name globals
godot --headless --path . --script res://tests/cli.gd -- sha512
godot --headless --path . --script res://tests/cli.gd -- ed25519 fast 20
godot --headless --path . --script res://tests/cli.gd -- jws
godot --headless --path . --script res://tests/cli.gd -- platform
godot --headless --path . --script res://tests/http_probe.gd   # network; honours HTTPS_PROXY
```

Official 4.6+ export templates ignore `--path`, `--script` and `--main-pack`
(godotengine/godot#111909). To benchmark a release template instead of the editor:

1. Export the `Linux` preset with `--export-release`, which produces `build/pkey.x86_64` plus
   `build/pkey.pck`.
2. Run `./build/pkey.x86_64 --headless -- <suite>`. `project.godot` sets
   `application/run/main_loop_type="PKTestRunner"`.

## Results (Godot 4.7.2-stable `ed1daf0bf`, 4-vCPU Xeon @ 2.1 GHz)

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
Godot `String` cannot hold U+0000, so the payload does not round-trip byte for byte.

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

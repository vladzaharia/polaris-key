> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# A5: Godot 4 (GDScript) SDK feasibility for Polaris Key, empirical results

Date: 2026-09-29. Engine tested: **Godot 4.7.2-stable (official, `ed1daf0bf`)**, the newest stable
release (4.7.3 and 4.8 return 404). It ran on a 4-vCPU Intel Xeon @ 2.10 GHz (Ubuntu 24.04, 16 GB).
The repo was not modified. All work is in
`../prototype/` (the `pkey/` project; probe and reference scripts were not kept)
(referred to below as `$S`).

## TL;DR

| Question                              | Answer                                                                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Ed25519 in Godot?              | **No.** mbedTLS 3.6.7 has no EdDSA. Loading an Ed25519 PEM into `CryptoKey` fails with `-15488` (`MBEDTLS_ERR_PK_UNKNOWN_PK_ALG`). No other engine class covers it.                                                                       |
| Native SHA-512?                       | **No.** `HashingContext` only offers MD5, SHA-1 and SHA-256. `start(3)` returns `ERR_UNAVAILABLE`. `HMACContext` is SHA-1/SHA-256 only.                                                                                                   |
| Pure-GDScript Ed25519 verify works?   | **Yes, in both variants.** RFC 8032: 26/26 vectors pass. Corpus v2: **36/36 `jwsCases` verdicts match**, and **68/68** distinct corpus JWS signatures agree with Node/OpenSSL.                                                            |
| Speed (this box)                      | Optimized variant (ref10 port): **~6.3–7 ms/verify on the release template**, ~8.6 ms on the debug template or editor. Baseline (TweetNaCl port): ~122 ms release, ~160–210 ms debug.                                                     |
| Speed for a 262 KB bundle             | ~96 ms release (SHA-512 in GDScript dominates)                                                                                                                                                                                            |
| Native ECDSA P-256 / RSA verify?      | **Yes** (DER-encoded ECDSA only): 0.84 ms and 0.074 ms. RSA-PSS is not reachable. Using them would require a wire change.                                                                                                                 |
| HTTP needs (Bearer, ETag, Range, TLS) | **All work.** Four gotchas, listed below: `download_file` truncates, redirects **forward `Authorization` cross-host**, gzip is on by default, and on Web the **Worker has no CORS**.                                                      |
| Device identity                       | Linux `/etc/machine-id` raw, Windows HW-profile GUID, macOS **serial number**, iOS IDFV, Android `ANDROID_ID`. On Web it returns `""` plus an engine error. On Windows and macOS these **differ** from what the Node and Swift SDKs hash. |
| GDExtension Web / iOS                 | Both are supported in 4.7. Web needs the "Extensions Support" export option (`web_dlink_*` templates, which ship officially). iOS takes `.xcframework`, `.framework`, `.a` or `.dylib`, and a `.dylib` is converted to a `.framework`.    |

---

## 1. Obtaining Godot

Commands:

```sh
cd $S
for v in 4.7.3 4.7.2 4.8; do curl -sS -o /dev/null -w "%{http_code}" -I -L \
  "https://github.com/godotengine/godot/releases/download/${v}-stable/Godot_v${v}-stable_linux.x86_64.zip"; done
# 4.7.3 404, 4.7.2 200, 4.8 404  (4.7.1/4.7/4.6.x/4.5.x all 200)
curl -sS -L -o godot472.zip https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip
unzip godot472.zip  # -> Godot_v4.7.2-stable_linux.x86_64 (146 MB), --version = 4.7.2.stable.official.ed1daf0bf
```

The downloads went through the agent proxy with no problems.

**Export templates.** The full `.tpz` is 1.28 GB. I pulled only the needed entries with HTTP
Range requests against the zip central directory (`$S/templates/rangezip.py`, ~4 s):
`linux_release.x86_64` and `linux_debug.x86_64`. The listing confirms that the official 4.7.2
templates include `web_dlink_{debug,release}.zip`, `web_dlink_nothreads_*`, `web_nothreads_*`,
`ios.zip`, `android_*`, `macos.zip` and the Windows builds.

**What failed.** Official 4.7 templates reject `--path`, `--main-pack` **and** `--script` with
"this Godot binary was compiled without support for path overrides". To run on the real templates I
exported a `.pck` with `--export-pack "Linux"`, copied the template binary next to it as
`pkey.x86_64` + `pkey.pck`, and set `application/run/main_loop_type="PKTestRunner"` plus a dummy main
scene, because the template aborts without one. One `--import` run aborted (SIGABRT) once. It was
not reproducible and did not affect any results.

## 2. Native crypto capabilities (source + empirical)

Source files fetched at the `4.7.2-stable` tag into `$S/src/`: `core/crypto/crypto.h|.cpp`,
`hashing_context.cpp`, `crypto_core.h`, `modules/mbedtls/crypto_mbedtls.cpp`,
`thirdparty/mbedtls/include/godot_{module,core}_mbedtls_config.h` and `thirdparty/README.md`
(mbedTLS **3.6.7**).

Probe: `$S/probe/probe_crypto.gd`, output in `$S/probe/probe_crypto.out`. Keys and signatures were
generated with OpenSSL 3.0.13 in `$S/probe/keys/`. Run command:
`Godot_v4.7.2-stable_linux.x86_64 --headless --path $S/probe --script probe_crypto.gd`.

**(a) Ed25519: none.**

- Classes present: `AESContext`, `Crypto`, `CryptoKey`, `DTLSServer`, `HMACContext`,
  `HashingContext`, `PacketPeerDTLS`, `StreamPeerTLS`, `TLSOptions`, `X509Certificate`.
- Loading an Ed25519 public or private key into `CryptoKey.load_from_string` gives
  `Error parsing key '-15488'` (`MBEDTLS_ERR_PK_UNKNOWN_PK_ALG`).
- An X25519 key _loads_ (RFC 8410 curves), but `Crypto.sign` then fails with `-20352`
  (`MBEDTLS_ERR_ECP_BAD_INPUT_DATA`).
- mbedTLS 3.6 has no EdDSA implementation, and `Crypto` exposes no generic PSA interface.

**(b) EC P-256 works.** `CryptoKey.load_from_string(spki_pem, true)` returns OK.
`Crypto.verify(HASH_SHA256, sha256(msg), der_sig, key)` returns `true`, and `false` when the input
is tampered. P-384 and secp256k1 also load and verify. The signature **must be ASN.1 DER**: a JOSE
ES256 raw `r||s` signature returns `false`, so an ES256 path would need a small raw-to-DER
conversion.

**(c) RSA works (PKCS#1 v1.5 only).** RSA-2048 PKCS#1 v1.5 + SHA-256 returns `true`. **RSA-PSS
returns `false`**, because `mbedtls_pk_verify` defaults to v1.5 and `mbedtls_pk_verify_ext` is not
bound.

**Hash types for sign/verify.** `Crypto.sign/verify` accept only `HASH_MD5`, `HASH_SHA1` and
`HASH_SHA256`. `md_type_from_hashtype` errors on anything else.

**Native verify speed** (`probe_native_speed.gd`): ECDSA P-256 **0.844 ms**, RSA-2048 **0.074 ms**.

**(d) Hashing.** `HashingContext.HashType` = `[HASH_MD5, HASH_SHA1, HASH_SHA256]`. `start(3)` and
`start(4)` return `ERR_UNAVAILABLE` and print `Parameter "ctx" is null`. There is **no SHA-512**
anywhere in the exposed API. The core mbedTLS config only defines `MBEDTLS_SHA256_C` (plus MD5 and
SHA1). Native SHA-256 of 1 MiB takes 4.8 ms. `Crypto.constant_time_compare` and
`hmac_digest(SHA256)` exist.

**(e) base64 (probe `$S/probe/probe_lang.gd`, output `probe_lang.out`).**

- `Marshalls.raw_to_base64` is standard with padding.
- `Marshalls.base64_to_raw` is **standard alphabet and padding required**:
  - `"AQI"` and `"AQ"` (unpadded) fail;
  - `-` and `_` fail;
  - whitespace fails;
  - trailing data after `=` fails.
- On failure it returns an empty array **and prints an engine `ERROR:`** (log noise).
- base64url therefore takes four steps: validate `^[A-Za-z0-9_-]*$` with the native `RegEx`
  (PCRE2), reject `len % 4 == 1`, replace `-_` with `+/`, then pad with `=`. This is implemented in
  `PKJws.b64url_decode_strict` and passes all corpus alphabet cases (`sig-out-of-alphabet-*`,
  `base64url-payload-padding`, `-trailing-data`).
- `String.to_ascii_buffer()` turns non-ASCII characters into `0x20` and logs an error. That is only
  safe after alphabet validation.

**(f) 64-bit int semantics** (editor = debug build):

- `INT64_MAX + 1` gives `-9223372036854775808`, `INT64_MAX * 2` gives `-2`, and a
  `PackedInt64Array` element also wraps. So arithmetic mod 2^64 is two's-complement wrapping in
  practice. Technically it is C++ signed-overflow UB, but the operations run at VM runtime and wrap
  on x86-64, ARM and wasm.
- `>>` is **arithmetic**. `-17 >> 4 == -2` at runtime, both typed and untyped.
- **Gotcha: constant expressions.** `-17 >> 4` written as a _constant expression_ is a **parse
  error** in debug/editor builds: "Invalid operands for bit shifting. Only positive operands are
  supported." `Variant::evaluate` carries a `DEBUG_ENABLED` check, but the GDScript VM
  (`OPCODE_OPERATOR`, `gdscript_vm.cpp`) caches and calls the _validated_ evaluator, which has no
  check. So the rule is: never constant-fold negative shifts, and replace `c << k` with `c * 2^k`
  in carries (done in both ports).
- `1 << 64 == 1`. This is UB and the hardware masks the count, so never shift by 64 or more.
- `-17 / 4 == -4` (truncating division); `-17 % 4 == -1`.
- Debug builds never take the fast path for `/` and `%` (zero-division check), so avoid them in hot
  loops.
- Hex literals larger than `INT64_MAX` **saturate to `INT64_MAX` with an error**
  (`0xffffffffffffffff` becomes `9223372036854775807`). 64-bit constants must be written as signed
  decimal (see the SHA-512 `K` table).
- `PackedByteArray` stores truncate mod 256 (`300` becomes `44`, `-1` becomes `255`).
- `Packed*Array` values are passed and aliased **by reference**, which output-parameter crypto code
  relies on (verified).

**(g) Performance (debug editor, 1M iterations):**

| Operation                  | Time             |
| -------------------------- | ---------------- |
| `PackedByteArray` write    | 28 ms (28 ns/op) |
| `PackedByteArray` read     | 16 ms            |
| `PackedInt64Array` write   | 15 ms            |
| `PackedInt64Array` read    | 16 ms            |
| `Array[int]` read or write | ~29 ms           |
| `x=(x*38+i)&0xffff` loop   | 27 ms            |

Locals are much cheaper than array slots, which is why the unrolled ref10 field multiply wins
(below).

**JSON (relevant to verify parity, `probe_json.gd`):**

- **Lenient.** The Godot parser accepts:
  - trailing commas (`{"a":1,}`, `[1,2,]`);
  - leading zeros (`01`);
  - `1.`;
  - raw control characters inside strings;
  - `1e400` (becomes `inf`).
- **Stricter than JS.** It rejects a lone surrogate `"\ud800"`.
- **All numbers become float64.** `9007199254740993` becomes `9007199254740992.0`, which is fine up
  to 2^53 and so fine for the corpus `valid-large-integer-timestamps` case.
- **Duplicate keys: last wins silently.** The SDK needs its own duplicate-key scan (ported).
- **Godot `String` cannot hold U+0000.** `\u0000` is replaced with U+FFFD, plus an error print, both
  in `JSON` and in `get_string_from_utf8`. Consequence: corpus `valid-nul-byte-in-string` gives the
  **correct verdict (ok) but a different decoded doc** (`"before�after"`). Fixing this needs a
  documented divergence entry or a byte-level JSON parser. Note that AGENTS.md rule 1 forbids
  weakening runners, so the corpus owner has to make this call.

## 3. Pure-GDScript Ed25519 verify

### Code (all in `$S/pkey/`, a Godot project)

| File                                                                         | What                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addons/polaris_key/crypto/sha512.gd` (`PKSha512`, 107 lines)                | FIPS 180-4 SHA-512. Constants are signed-decimal int64. Logical shift is `(x>>n)&mask`. Big-endian word loading is done natively: pad, then `reverse()` the whole buffer, then `to_int64_array()`, so word i is element n-1-i.                                                                                                                                                                                                                             |
| `addons/polaris_key/crypto/ed25519_tweetnacl.gd` (`PKEd25519Ref`, 328 lines) | **Baseline.** Faithful TweetNaCl `crypto_sign_open` port: 16×16-bit limbs in `PackedInt64Array`, looped `M`, Montgomery-ladder `scalarmult` twice, `modL`.                                                                                                                                                                                                                                                                                                 |
| `addons/polaris_key/crypto/ed25519_fast.gd` (`PKEd25519Fast`, 1256 lines)    | **Optimized.** ref10 structure via orlp/ed25519: radix-2^25.5 10-limb field. `fe_mul`/`fe_sq`/`fe_sq2`/`fe_frombytes`/`fe_tobytes` were **mechanically translated** from C by `$S/ref/translate_fe.py`, fully unrolled on locals. Uses extended coordinates, **one interleaved width-5 sliding-window double-scalar mult** (`ge_double_scalarmult_vartime`), and the constant ref10 `Bi` table of 8 odd multiples of B. Generated by `$S/ref/gen_fast.py`. |
| `addons/polaris_key/jws.gd` (`PKJws`, 162 lines)                             | Port of `packages/shared-jws` `verifyJws`, with the same step order: encoded caps, then strict base64url, header ≤ 1024 B, dup-key scan, object check; then alg/typ/kid and trust lookup; then Ed25519 over the ASCII `h.p`; **then** payload decode, cap, dup-key scan, parse. `maxPayloadBytes` only ever raises the cap.                                                                                                                                |
| `tests/cli.gd` (`PKTestRunner`) + `tests/suite_*.gd`                         | Runner (works in the editor via `--script` and in exported templates via `main_loop_type`). Suites: `sha512`, `ed25519`, `jws`, `profile`, `platform`. `tests/http_probe.gd` is a separate SceneTree script.                                                                                                                                                                                                                                               |
| `vectors/gen_ed25519.mjs`, `vectors/gen_corpus.mjs`                          | Node 22 (OpenSSL) oracles. They read corpus v2 read-only.                                                                                                                                                                                                                                                                                                                                                                                                  |

Both verifiers are **stricter than TweetNaCl**, which accepts malleable S:

- they reject **S ≥ L**;
- they reject a **non-canonical public-key y (≥ p)**.

Both behaviors were confirmed against Node's verdicts ("S + L", "S == L", "pk y = p+1" are all
rejected by Node too). `A` decompression failure (a point not on the curve) is rejected.
Variable-time is acceptable because only public data is involved.

### Vectors

`vectors/ed25519.json` (26 vectors):

- the 4 RFC 8032 §7.1 vectors (TEST 1, 2, 3, SHA(abc)), each re-derived by Node signing with the
  RFC secret key to rule out transcription errors;
- 13 Node-signed random messages at SHA-512 block boundaries (0, 1, 31, 32, 63, 64, 111, 112, 127,
  128, 200, 1023, 4000 bytes);
- 9 negative cases whose expected verdicts are **Node's**, not ours (R flip, S flip, S+L, S=L,
  S=0xff…, wrong message, wrong key, non-canonical y, off-curve y).

Corpus:

- `vectors/corpus_jws.json`: all 36 `jwsCases` plus a canonical byte-level rendering of
  `expect.doc`.
- `vectors/corpus_sigs.json`: every distinct compact JWS string anywhere in `cases.json` (68: 61
  valid and 7 invalid per Node), including trust manifests, config docs and the bundle-at-cap
  (349,618-byte signing input).

### Commands

```sh
cd $S/pkey
node vectors/gen_ed25519.mjs && node vectors/gen_corpus.mjs         # (/opt/node22/bin/node)
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --import
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --script res://tests/cli.gd -- sha512
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --script res://tests/cli.gd -- ed25519 fast 20
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --script res://tests/cli.gd -- ed25519 ref 5
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --script res://tests/cli.gd -- jws fast
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --script res://tests/cli.gd -- profile
# real templates:
../Godot_v4.7.2-stable_linux.x86_64 --headless --path . --export-pack "Linux" build/release/pkey.pck
cp ../templates/linux_release.x86_64 build/release/pkey.x86_64   # (same for debug)
build/release/pkey.x86_64 --headless -- ed25519 fast 30          # likewise: ref / sha512 / jws / profile / platform
```

### Results

**Correctness:**

- SHA-512: 24/24 vs Python `hashlib`.
- Ed25519: 26/26 for **both** variants, on the editor, debug template and release template.
- Corpus: `[fast] corpus v2 jwsCases verdicts: 36/36 match`, and also 36/36 for `ref`. The only
  decoded-doc mismatch is `valid-nul-byte-in-string` (Godot `String` limitation, §2).
- Raw Ed25519 over the 68 distinct corpus JWS: 68/68 agree with Node/OpenSSL, for both variants.

**Performance** (ms per verify; median of 20–30 runs unless noted):

| Build                | Variant | 1-byte msg          | 1023-byte msg       | Typical corpus doc (~1 KB JWS) | `payload-at-cap` (87 KB) | `bundle-payload-at-cap` (350 KB) |
| -------------------- | ------- | ------------------- | ------------------- | ------------------------------ | ------------------------ | -------------------------------- |
| **release template** | fast    | **7.06** (min 6.60) | **6.25** (min 5.35) | ~7.1                           | 28.4                     | **95.7**                         |
| release template     | ref     | 122.5               | 126.6               | —                              | —                        | —                                |
| debug template       | fast    | 8.62                | 8.83                | —                              | —                        | —                                |
| debug template       | ref     | 211                 | 202                 | —                              | —                        | —                                |
| editor (debug)       | fast    | 8.8                 | 9.0                 | 9–13                           | 52                       | 123                              |
| editor (debug)       | ref     | 160–175             | 160                 | 150–180                        | 201                      | 276                              |

The optimized variant is **about 18× faster** than the TweetNaCl baseline.

Phase breakdown for the fast variant on the release template:

| Phase                       | Time    |
| --------------------------- | ------- |
| decompress A                | 0.41 ms |
| SHA-512 + reduce (tiny msg) | 0.11 ms |
| double-scalar mult          | 5.62 ms |
| encode/invert               | 0.40 ms |

Field ops on the release template: `fe_mul` 1.92 µs, `fe_sq` 1.64 µs, `fe_add` 0.51 µs (mostly call
overhead). The TweetNaCl looped 16-limb `M` takes 12.8 µs.

GDScript SHA-512 throughput: 256 KiB in **51.8 ms** (release) or 66 ms (debug), about 40 µs per
128-byte block. For bundles, hashing, not curve math, dominates.

**Mobile and Web estimate** (not measured here: no browser or device in the sandbox). The GDScript
VM is the same C++ interpreter:

- **Web (wasm32; i64 ops are native in wasm, dispatch is slower)**: expect about 1.5–3× this box.
  That is roughly **10–20 ms/verify on desktop browsers**, 20–60 ms on mobile browsers, and
  0.15–0.3 s for a 262 KB bundle.
- **Mobile native**: flagship ARM (A17 or Snapdragon 8-class) is about 1–1.5×, so ~7–10 ms. Low-end
  Cortex-A55-class Android is about 3–6×, so **~20–45 ms** (fast), or 0.4–0.8 s with the baseline.

A session needs about 3 verifies (trust + license + config), or 4 for a bundle import, so the fast
variant is fine everywhere. The baseline is tolerable on desktop only. Running verifies on a
`WorkerThreadPool` is possible natively but **not** on `nothreads` web exports.

**Further optimizations not done:**

- cache the decompressed A and its 8-entry odd-multiple table per trusted `kid` (saves ~0.7 ms and
  ~8 point ops);
- inline `fe_add`/`fe_sub` into the point formulas (~1 ms);
- flatten points into one `PackedInt64Array(40)` to drop `Array` indirection.

Realistic floor: ~4–5 ms release. A GDExtension (libsodium or monocypher) would be about 0.05 ms,
at the cost of a native build per platform.

## 4. HTTP (empirical on Linux + source for Web)

Probe: `$S/pkey/tests/http_probe.gd`. It uses `HTTPRequest.set_https_proxy("127.0.0.1", 37345)`,
because Godot does **not** read `HTTPS_PROXY` from the environment. The Linux build loaded the
system CA bundle (`OS.get_system_ca_certificates()` returned 230 KB), which contains the agent-proxy
CA, so TLS verification stayed on. Endpoints: httpbin.org and postman-echo.com.

| #   | Test                                                                                                                                         | Result                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Custom headers `Authorization: Bearer pkeyt_…`, `X-PKey-SDK`, `X-PKey-Device`                                                                | 200, all echoed. Godot adds `User-Agent: GodotEngine/4.7.2.stable.official (Linux)` and `Accept-Encoding: gzip, deflate`                                                    |
| 2   | ETag, then `If-None-Match`                                                                                                                   | 200 with `ETag`, then **304, empty body, passed to caller** (no internal cache)                                                                                             |
| 3   | `Range: bytes=100-199` with `accept_gzip=false`                                                                                              | **206**, `Content-Range: bytes 100-199/1000`, 100 B                                                                                                                         |
| 4   | `download_file` + `Range` into an existing 17-byte file                                                                                      | file becomes **100 B: truncated** (`FileAccess::WRITE`), not appended. **Resumable downloads cannot use `download_file`.**                                                  |
| 5   | 302 cross-host redirect with `Authorization`                                                                                                 | **Bearer token forwarded to the redirect target** (postman-echo saw it). With `max_redirects=0`: result 12 (`REDIRECT_LIMIT_REACHED`), code 302, Location header available. |
| 6   | TLS `TLSOptions.client(null, "not-the-right-name.example")`                                                                                  | Fails closed (result 2 `CANT_CONNECT` through the proxy)                                                                                                                    |
| 7   | Resumable download with low-level `HTTPClient`: stream chunks, open with `FileAccess.READ_WRITE` + `seek_end()`, send `Range: bytes=<have>-` | Two 206 parts appended into a correct 1000-byte file                                                                                                                        |

**Source notes (`scene/main/http_request.cpp`, `core/io/http_client_tcp.cpp`):**

- Auto-redirect happens for 301/302/303/305, and for 307/308 on safe methods. Custom headers are
  kept except when the method changes.
- `accept_gzip` defaults to true and the body is transparently decompressed. For Range and resume,
  set it false or send `Accept-Encoding: identity`.
- `body_size_limit` also guards against zip bombs. `timeout` exists.
- `HTTPRequest` must be inside the SceneTree (`ERR_UNCONFIGURED` otherwise); `HTTPClient` works
  standalone.
- TLS goes through `TLSOptions.client(trusted_chain?, cn_override?)`, and the per-request CA chain
  allows pinning. The project setting `network/tls/certificate_bundle_override` exists.

**System CA source per platform:**

| Platform | Source                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | distro bundle file (`/etc/ssl/certs/ca-certificates.crt`, Fedora/Arch/openSUSE/BSD paths)                                                                                                |
| Windows  | `CertOpenSystemStore("ROOT")`                                                                                                                                                            |
| macOS    | `SecTrustCopyAnchorCertificates`                                                                                                                                                         |
| Android  | Java `get_ca_certificates()`                                                                                                                                                             |
| **iOS**  | **none (`apple_embedded` has no override): falls back to the Mozilla bundle compiled into the engine.** User or MDM-installed CAs are ignored because mbedTLS, not the OS, does the TLS. |

**Web (`platform/web/http_client_web.cpp`, `js/libs/library_godot_fetch.js`):**

- The request is `fetch(url, {method, headers, body})`: default `mode:"cors"`,
  `credentials:"same-origin"`, `cache:"default"`, `redirect:"follow"`. `TLSOptions` are ignored
  apart from http vs https; there is no blocking mode and no `StreamPeer`.
- The browser follows redirects invisibly, and modern browsers strip `Authorization` on cross-origin
  redirect.
- A manual `If-None-Match` switches the fetch cache mode to no-store per the Fetch spec, so a 304
  reaches the game.
- **CORS is the blocker.**
  - `Authorization` and `X-PKey-*` force a preflight.
  - `ETag` and `Content-Range` are not CORS-safelisted response headers. The server must send
    `Access-Control-Expose-Headers: ETag, Content-Range, …`, and also `Access-Control-Allow-Origin`
    and `Access-Control-Allow-Headers: Authorization, If-None-Match, Range, X-PKey-*` in answer to
    `OPTIONS`.
  - **`packages/worker/src` contains no `Access-Control-*` handling at all** (grep).
  - So a Godot Web export served from any other origin (itch.io, CrazyGames, the game's own domain)
    cannot currently reach `key.plrs.im`. That is a Worker change, and needs an OpenAPI/route
    coverage entry per AGENTS.md rule 10 if `OPTIONS` routes are added.

## 5. Platform identity APIs (source at 4.7.2 + empirical on Linux)

Empirical (`tests/suite_platform.gd`, editor and both templates, Linux container):

- `get_distribution_name()` = "Ubuntu 24.04.4 LTS"; `get_version()` = "24.04".
- `get_unique_id()` = `0d0af05ee8fd4dc29275718f2ce4dff1` = **raw `/etc/machine-id`**.
- `get_model_name()` = "GenericDevice".
- `get_processor_name()` = "Intel(R) Xeon(R) Processor @ 2.10GHz", count 4.
- `get_memory_info()` = `{physical: 16877547520, free: …, available: …, stack: 8388608}`.
- `Engine.get_version_info()` = `{major 4, minor 7, patch 2, hex 263938, status "stable", build "official", hash …, string "4.7.2-stable (official)"}`.
- `Engine.get_architecture_name()` = "x86_64".

`OS.has_feature` sets:

- editor: `editor, editor_runtime, debug, linux, linuxbsd, pc, x86_64, x86, 64, threads, single, etc2, s3tc, bptc, system_fonts`;
- release template: `template, release, template_release, linux, …` (no `editor`/`debug`);
- debug template: `template, debug, template_debug, linux, …`.

Per platform (source):

| Platform | `get_unique_id()`                                                                                          | `get_model_name()`                                                             | `get_processor_name()`                                         | `get_memory_info()`        | Match with other Polaris SDKs' raw device id                                |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| Linux    | `/etc/machine-id` raw (FreeBSD: `kern.hostuuid`); no `/var/lib/dbus` fallback                              | "GenericDevice"                                                                | `/proc/cpuinfo` "model name"                                   | `/proc/meminfo` (Unix)     | **Same source** as Node (`/etc/machine-id`)                                 |
| Windows  | `GetCurrentHwProfileA().szHwProfileGuid` (HW profile GUID)                                                 | Registry BIOS `SystemProductName`, else `BaseBoardProduct`, else GenericDevice | Registry `ProcessorNameString`                                 | `GetPerformanceInfo`-based | **Differs**: Node uses `HKLM\…\Cryptography\MachineGuid`                    |
| macOS    | `IOPlatformSerialNumber` (**hardware serial**)                                                             | `sysctl hw.model` (e.g. `MacBookPro18,3`)                                      | `machdep.cpu.brand_string`                                     | `hw.memsize` + vm stats    | **Differs**: Node/Swift use `IOPlatformUUID`                                |
| iOS      | `UIDevice.identifierForVendor` (resets when all of the vendor's apps are uninstalled)                      | device model (`iPhone15,2`)                                                    | SoC lookup table (e.g. "Apple A16 Bionic"), "Simulator" on sim | Mach stats                 | **Same** as Swift (IDFV)                                                    |
| Android  | `Settings.Secure.ANDROID_ID` (per app signing key + user + device since Android 8; reset on factory reset) | `Build.MODEL`                                                                  | `/proc/cpuinfo` (Unix path)                                    | Unix path                  | n/a (no other Android SDK)                                                  |
| Web      | `""` **plus engine `ERROR` "not available on the Web platform"**                                           | "GenericDevice"                                                                | ""                                                             | defaults (-1s)             | none: must persist a random id in `user://` (IndexedDB, per origin/profile) |

**Implications:**

- The SDK must hash with the frozen `pkey-device:<slug>:<raw>` SHA-256 base64url[0:32] formula.
  That is feasible natively (`HashingContext` SHA-256 + `Marshalls` + url-alphabet conversion).
  AGENTS.md rule 7 requires hashing because Godot returns raw machine-id or serial numbers.
- To match Node and Swift on Windows and macOS, the Godot SDK would read `MachineGuid` with
  `OS.execute("reg", …)` and `IOPlatformUUID` with `OS.execute("ioreg", …)` instead of
  `get_unique_id()`. `OS.execute` is desktop-only.
- Fingerprint components (`fingerprint.json`: machineUuid, boardSerial, cpuModel `"name:count"`,
  primaryMac, bootVolumeUuid, ramBucket, machineModel):
  - Godot covers **cpuModel**, **ramBucket** and **machineModel** natively.
  - It has **no MAC address, board serial or boot-volume UUID API** (`IP.get_local_interfaces`
    has no MACs). Those need `OS.execute` on desktop or a GDExtension.

**GDExtension on Web and iOS (4.4+; checked at 4.7.2):**

- **Web:** export option `variant/extensions_support` selects the `web_dlink_{debug,release}`
  templates (built with `dlink_enabled=yes`, `-sSIDE_MODULE=2`), and `web_dlink_nothreads_*` when
  thread support is off. All ship in the official 4.7.2 `.tpz`.
  - The extension must be built with emscripten as a side module, with a matching Emscripten
    (minimum 4.0.0 for 4.7 builds) and a matching threads/nothreads variant.
  - The engine download is bigger, and `.side.wasm` is listed in `gdextensionLibs`.
  - Works, but it is a separate build matrix per variant.
- **iOS:** `EditorExportPlatformAppleEmbedded` accepts `.xcframework` (all-static `.a`, or dylibs
  converted to `.framework` for App Store compliance), plain `.framework`, `.dylib` (converted to
  `.framework` via `install_name_tool`) and static `.a`. Supported. You still ship per-arch
  (device plus simulator) builds.
- A GDExtension crypto core (libsodium or monocypher) is therefore feasible on every platform, but
  it would multiply the build and release matrix: Windows, macOS universal, Linux x64/arm64,
  Android ×4 ABIs, iOS xcframework, Web dlink ×2. Pure GDScript needs none of that.

## 6. Recommendations

1. **Ship pure GDScript `PKEd25519Fast` + `PKSha512` + `PKJws`.**
   - It is proven against RFC 8032 and all 36 corpus v2 `jwsCases`, with a 68/68 signature
     cross-check.
   - It runs in ~6–9 ms per verify on desktop, and in every export target including `nothreads`
     Web, with zero native build matrix.
   - Keep `PKEd25519Ref` as a differential-test oracle.
   - Add per-`kid` caching of the decompressed key.
   - Offer an optional GDExtension fast path later if profiling on low-end Android demands it.
2. **Divergences to take to the corpus/contract owners before claiming conformance:**
   - (a) U+0000 in strings: this is a Godot `String` limitation. Either add a documented divergence
     entry or have the SDK fail closed on `\u0000`.
   - (b) Godot `JSON` leniency (trailing commas, leading zeros, raw control characters) and
     stricter lone-surrogate handling. All of it applies only after signature verification, but an
     SDK-side strict JSON validator is needed to claim "verifies identically".
   - (c) Windows and macOS raw device-id source (use `MachineGuid` / `IOPlatformUUID` via
     `OS.execute`).
3. **HTTP layer:**
   - Use `HTTPClient` directly, or `HTTPRequest` with `max_redirects = 0` and manual same-origin
     redirect handling, so the `pkeyt_` bearer can never be forwarded cross-host.
   - Set `accept_gzip=false` for Range downloads.
   - Implement resume with `HTTPClient` streaming + append.
   - Consider `TLSOptions.client(pinned_roots)`, since on iOS Godot trusts only its built-in
     Mozilla bundle anyway.
4. **Web exports need Worker CORS support** (preflight + `Expose-Headers: ETag, Content-Range`).
   That is a server feature with an OpenAPI/routeCoverage drift gate (AGENTS.md rule 10).
5. Avoiding Ed25519 by adding ES256 (native 0.84 ms) or RS256 (0.074 ms) would be a
   `PROTOCOL_VERSION` bump, an all-languages event (AGENTS.md rule 2). It is not justified by
   these numbers.

> Research note for [Godot on Polaris Key](../README.md), 2026-09-29. A working paper kept for its
> evidence and sources; the README synthesis is the cross-checked position. Scratch paths in the
> original run are rewritten to `prototype/` where the code was kept.

# E6 - Existing client-side tools to incorporate into the Polaris Key SDKs

Researched 2026-09-29. Scope: which existing libraries and technologies to adopt, wrap, borrow ideas from,
or avoid, for (a) a sixth SDK for Godot 4.x and (b) omni-platform distribution + content packs across all SDKs.

Method and conventions

- Release dates come from GitHub `releases.atom` feeds (ISO timestamps) wherever possible; those are reliable.
  Star counts and licenses come from the GitHub repo pages fetched this session and are approximate.
- Items marked (m) are from memory and were NOT re-verified this session. Everything else was fetched.
- I read (not modified) AGENTS.md, README.md, `packages/shared-jws/src/index.ts` (uses `crypto.subtle`
  Ed25519 today), `sdks/python/pyproject.toml` (`cryptography>=41`, `httpx`) and `sdks/swift/Package.swift`
  (CryptoKit + Sparkle `from: "2.6.4"`, macOS-only PolarisKeyUpdate).
- Latest engine facts: Godot 4.7-stable 2026-06-18, 4.7.2-stable 2026-08-22; godot-cpp 10.0.0-stable
  2026-09-15; gdext 0.5.5 2026-08-09.

---

## 0. Headline recommendations (read this first)

1. **Keep "independent native implementations + shared golden corpus" for the wire contract.** The shared
   surface is small (compact-JWS verify, trust set, clock floor, gate). A Rust/C core buys little there and
   costs the most exactly where Godot is weakest (Web, iOS packaging, no UniFFI-for-Godot). Use native code
   only for (i) platform APIs and (ii) heavy primitives (delta patching, chunk hashing), always with a
   non-native fallback.
2. **Godot SDK = GDScript-first with a pluggable Ed25519 backend.** Godot 4.7 has no Ed25519 (Crypto is
   RSA-only; HashingContext is MD5/SHA-1/SHA-256, no SHA-512). Backend order: Web -> WebCrypto through
   `JavaScriptBridge`; native -> a small `pkey_native` GDExtension (godot-cpp 10 + Monocypher 4.0.3 in
   SHA-512/Ed25519 mode); everywhere -> pure-GDScript TweetNaCl-style fallback (needs a GDScript SHA-512).
   The only ready-made Godot Ed25519 add-on (freehuntx/gd-ed25519, MIT, v1.0.0 on 2026-07-05, 8 stars) is
   two months old and shipped a non-interoperable BLAKE2b variant until 1.0.0; fork/vendor after it passes
   the corpus, do not hard-depend on it.
3. **A GDExtension on Godot Web is a trap for a drop-in SDK.** Official templates ship without dlink
   support; users must build `dlink_enabled=yes` templates and the export needs cross-origin isolation
   headers. Godot C# cannot export to Web at all. gdext Web needs nightly rustc + emscripten and is
   "experimental". Therefore the wire core must never require a GDExtension.
4. **Ed25519 verifiers disagree on edge cases** (small-order keys, non-canonical encodings, S >= L,
   cofactored vs cofactorless). Monocypher's _default_ EdDSA is BLAKE2b, not Ed25519. Add a "verify
   profile" section to the corpus (S >= L, small-order A/R, non-canonical R, wrong-hash variant) and make
   every SDK do a cheap canonical-S pre-check. Never use signature bytes as a dedupe/replay key.
5. **Distribution channel decides what an update may do.** Self-update is prohibited or meaningless on Mac
   App Store (2.4.5(vii)), Google Play (Device & Network Abuse), Microsoft Store MSIX, App Store/TestFlight,
   Steam, Flatpak. Model this as data (channel -> `UpdateCapability`: `none | inform | store-deeplink |
in-app-store-api | self-replace | content-only`) baked into the build, and let the SDK degrade to "inform
   only". This is the single most valuable idea to borrow (Play in-app-update priority/staleness, Sparkle
   informational/critical/minimumAutoupdateVersion).
6. **Code packs need an explicit policy switch.** Data-only packs (scenes, textures, audio, JSON) are safe
   everywhere. Packs containing GDScript are "interpreted code" for Apple (DPLA 3.3.1(B) conditions
   (a)-(c), plus App Review 2.5.2) and fall under Google Play's VM/interpreter exception. Apple is actively
   enforcing (Mar 2026 removal of the "Anything" app citing 2.5.2 and 3.3.1(B)). Ship
   `codePolicy: none | data-only | scripts` per channel; default iOS to `data-only`.
7. **Sparkle floor should be raised.** `Package.swift` has `from: "2.6.4"`. Sparkle 2.9.5 and 2.9.6 (Aug 2026)
   fixed a symlink attack in delta patching, a root privilege-escalation, and "reject package installs when
   signing validation failed". 2.10.0 (2026-09-14) needs macOS 12+, which is fine (package targets macOS 14).
8. **Do not adopt a full TUF stack in the runtime SDKs; borrow its role separation.** Polaris Key already
   has trust/bundle documents with kid selection, expiry and a clock floor. Borrow: threshold signing for
   release keys, snapshot/mix-and-match protection for pack manifests, rollback floors. Use sigstore only in
   the CLI/CI provenance path. Note electron-builder 27 (alpha) is adding Ed25519-signed update manifests
   with trust lists: convergent design, good validation.
9. **OpenFeature: ship providers, but only where the SDK is stable.** Do Web + React + Node first (stable
   JS SDKs). Python (0.10.0), Swift (0.6.0), Kotlin (0.9.0 alpha) are pre-1.0. No Godot/GDScript SDK exists;
   expose an OpenFeature-shaped GDScript API instead. Differentiator: the flag payload is signed and works
   offline, which none of the vendor client models reviewed document.
10. **Telemetry: first-party events + Sentry, not OTLP.** Update/boot lifecycle events are a tiny fixed
    schema; Sentry Godot 2.3.0 (released today) gives crash + release health to gate rollouts. OTLP
    (browser instrumentation still "experimental and mostly unspecified") is an optional exporter.
11. **Kotlin/Android SDK is worth building** (Play integrations, Godot Android v2 plugin can embed it);
    **.NET only if Unity/MAUI is in scope** (BCL still has no Ed25519).
12. **Licensing:** avoid AGPL/GPL cores (libsignal AGPL-3.0, Bitwarden sdk-internal GPL-3.0/commercial).
    MPL-2.0 items (gdext, UniFFI, Capgo updater, lazysodium) are file-level copyleft: fine to link, but keep
    modified MPL files public. Everything on the recommended list is MIT/BSD/ISC/Apache-2.0/CC0.

---

## 1. Crypto for Ed25519 JWS verify, per platform

### 1.1 Library table

| Tool                                     | License                              | Latest release (date) / stars                                                                     | Platforms                                                    | Verdict                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WebCrypto `Ed25519` (crypto.subtle)      | platform                             | Safari 17, Firefox 129 (Aug 2024), Chrome 137 (May 2025); ~79% of web users (IPFS blog, Aug 2025) | Browsers, Node 22, Workers, Deno/Bun                         | **Adopt** (already used in shared-jws). Feature-detect; fall back to noble                                                                                                                                                     |
| @noble/ed25519 3.2.0                     | MIT                                  | 2026-08-27; 522 stars; 3.7 KB gz, zero prod deps                                                  | Browser/Node/Deno/Bun/RN                                     | **Adopt as fallback** for pre-Chrome-137 browsers. Its own docs prefer it over noble-curves for smaller attack surface                                                                                                         |
| @noble/curves 2.4.0                      | MIT                                  | 2026-08-27; 960 stars; audited (Cure53 2024, ToB, self-audit Mar 2026); ESM-only, Node >=20.19    | same                                                         | Adopt only if you need X25519/ristretto etc. Default verify is ZIP215 (permissive)                                                                                                                                             |
| jose 6.2.12 (panva)                      | MIT                                  | 2026-09-05; 7.8k stars; Node/browsers/Workers/Deno/Bun, zero deps                                 | same                                                         | **Do not put in the runtime path** (flexible `crit`/JWK surface vs. our frozen profile). **Use as a differential test oracle** in conformance (`compactVerify`)                                                                |
| TweetNaCl.js                             | Unlicense                            | 1.9k stars; Cure53-audited 2017; effectively frozen                                               | JS                                                           | **Borrow**: reference algorithm to port to GDScript. Not a dependency                                                                                                                                                          |
| Monocypher 4.0.3                         | CC0-1.0 or BSD-2                     | 2026-06-15 (fixes an EdDSA timing leak); <2000 LOC, <50 KB                                        | any C target incl. wasm, iOS, Android                        | **Wrap** inside `pkey_native`. Footgun: default EdDSA = BLAKE2b (NOT Ed25519); SHA-512 Ed25519 is the optional `monocypher-ed25519` file. Verify accepts low-order A/R and non-canonical encodings; rejects S >= L since 2.0.5 |
| libsodium 1.0.22                         | ISC                                  | 2026-04-09; iOS xcframework, Android (API 21+, 16 KB pages), WASM builds                          | everywhere                                                   | Wrap for a native core if ever needed. CVE-2025-69277 (`crypto_core_ed25519_is_valid_point`) fixed Dec 2025; not on the verify path but pin >= 1.0.20-stable rebuild                                                           |
| PyNaCl 1.6.2                             | Apache-2.0                           | 2026-01-01; bundles libsodium                                                                     | CPython/PyPy wheels                                          | Optional fallback for Python                                                                                                                                                                                                   |
| pyca/cryptography 50.0.1                 | Apache-2.0 OR BSD-3                  | 2026-08-25                                                                                        | Py 3.9+; wheels Linux (glibc/musl), macOS arm64, Windows x64 | **Keep**. Note 49.0.0 (2026-06-12) dropped x86_64-macOS and 32-bit-Windows wheels: Intel Macs need a Rust build. Pin an upper bound in CI                                                                                      |
| CryptoKit `Curve25519.Signing`           | platform                             | iOS 13+/macOS 10.15+                                                                              | Apple                                                        | **Keep**                                                                                                                                                                                                                       |
| swift-crypto 5.0.0                       | Apache-2.0                           | 2026-09-16; 1.7k stars; Swift >= 6.2; BoringSSL on Linux/ARM64 Windows                            | Linux, Windows-arm64                                         | Adopt behind `#if canImport(CryptoKit)` to make the Swift SDK testable/usable on Linux. No Android/WASM stated                                                                                                                 |
| Android JCA `Signature("Ed25519")`       | platform                             | API 33+                                                                                           | Android 13+                                                  | Use when available                                                                                                                                                                                                             |
| Tink Java 1.23.0                         | Apache-2.0                           | 2026-07-09                                                                                        | JVM/Android                                                  | **Adopt** for Android < 33 (Ed25519 verify primitive)                                                                                                                                                                          |
| BouncyCastle C# 2.7.0                    | MIT-style                            | 2026-07-30                                                                                        | .NET incl. IL2CPP                                            | Adopt for .NET (BCL has no Ed25519; the API plan was reportedly put on hold)                                                                                                                                                   |
| NSec 26.4.0                              | MIT                                  | maintained 2026; wraps libsodium                                                                  | .NET desktop/server                                          | Alternative for .NET server; native dependency                                                                                                                                                                                 |
| ed25519-dalek (in curve25519-dalek repo) | BSD-3 (m)                            | curve25519-5.0.0 tagged 2026-07-06; 1.2k stars                                                    | Rust, no_std/wasm (m)                                        | Only relevant for a Rust core (rejected). Use `verify_strict` if ever used                                                                                                                                                     |
| ed25519-compact                          | MIT                                  | 147 stars; no_std, WASM/Fastly-friendly                                                           | Rust                                                         | Lighter Rust option if a Rust shim is ever needed                                                                                                                                                                              |
| jsonwebtoken (Rust) 11                   | MIT                                  | 2.1k stars; EdDSA via aws_lc_rs or rust_crypto                                                    | Rust                                                         | n/a                                                                                                                                                                                                                            |
| fenix-hub godot-engine.jwt               | MIT                                  | 58 stars; HS1/HS256/RS256 only                                                                    | Godot                                                        | **Avoid**: no EdDSA                                                                                                                                                                                                            |
| freehuntx/gd-ed25519                     | MIT (Monocypher vendored: BSD-2/CC0) | v1.0.0 2026-07-05; 8 stars; Godot >= 4.4                                                          | Linux, Windows, macOS, Android, iOS, Web (WASM) claimed      | **Fork/vendor candidate** after corpus pass. Web claim implies a dlink template. Earlier releases were non-interoperable                                                                                                       |

### 1.2 What Godot 4.7 gives you

- `Crypto`: RSA sign/verify, `hmac_digest` (SHA-1/SHA-256), `generate_random_bytes`, `constant_time_compare`.
  No Ed25519/ECDSA.
- `HashingContext`: MD5, SHA-1, SHA-256 only. **No SHA-512**, which Ed25519 needs internally, so a pure
  GDScript verifier must include its own SHA-512 (64-bit ints make this feasible). No maintained pure-GDScript
  SHA-512 or Ed25519 was found (NCrypt is SHA-256/AES/ChaCha).
- PKCE S256 and the JWS digest use SHA-256, which is built in: good.
- `JavaScriptBridge` (Web): `eval`, `get_interface`, `create_callback`, `js_buffer_to_packed_byte_array`.
  No documented Promise/await, so bridge `crypto.subtle.verify(...)` with a callback.
- Estimated pure-GDScript verify cost is in the tens to low hundreds of ms on desktop (estimate, benchmark it
  on Web/Android/iOS release builds); fine for boot-time verification of a handful of documents, cache the
  verified result.

### 1.3 Ed25519 verification profile (cross-implementation hazard)

- "Taming the many EdDSAs" (eprint 2020/1244) documents inconsistent verification across implementations,
  the reason ZIP-215 exists. Monocypher documents that `crypto_eddsa_check_equation` allows low-order and
  non-canonical A/R; noble defaults to ZIP215; libsodium is stricter (m); WebCrypto is engine-specific (m).
- Because the signer is our own Worker, legitimate tokens verify everywhere. The risk is attacker-crafted
  alternates being accepted by one SDK and rejected by another, and code that treats signature bytes as
  unique. Mitigation: add negative vectors to `conformance/corpus` (S >= L, small-order key, non-canonical R,
  BLAKE2b-signed variant) and add the S < L pre-check to each SDK so all agree on "reject". Key by `jti` or a
  hash of `signingInput`, never by signature bytes.

### 1.4 Godot GDExtension crypto options

- godot-rust/gdext (MPL-2.0, 5.2k stars): Web/iOS/Android "experimental, tooling lacking". Web needs nightly
  rustc, `wasm32-unknown-emscripten`, `-Zbuild-std`, emscripten 3.1.74, both threaded and `nothreads`
  binaries, and cannot catch panics on Wasm. Not a fit for a drop-in SDK.
- godot-cpp 10.0.0-stable (MIT, 2.7k stars; independent versioning since 10.x) is the lower-risk route for a
  tiny native shim (Monocypher is ~2k LOC of C).
- SwiftGodot (MIT, 1.7k stars, Swift 6.3, Godot 4.7): iOS/macOS/Linux/Windows primary; Android/Web untested.

---

## 2. "One native core, many bindings" vs independent implementations

### 2.1 Precedents

| Project                                  | Core + bindings                                                                                       | License                                       | Lesson                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mozilla application-services (675 stars) | Rust components -> UniFFI -> Kotlin/Swift                                                             | MPL-2.0                                       | Works when the shared logic is large (sync, Nimbus, FxA). Mobile only                                                                                       |
| UniFFI (5.0k stars)                      | official Kotlin, Swift, Python, Ruby; community C#, Go, Dart, JS/WASM, Java                           | MPL-2.0                                       | **No Godot/GDScript generator exists** (search found none). Kotlin path is JNA-based (Android context/JNI_OnLoad caveats; 16 KB page alignment work needed) |
| matrix-rust-sdk (2.3k stars)             | Rust -> Swift, Kotlin, JS/Node, WASM                                                                  | Apache-2.0                                    | Production (Element X); big shared logic (E2EE, sync) justified it                                                                                          |
| Bitwarden sdk-internal                   | Rust: `bitwarden-uniffi` (mobile), `bitwarden-wasm-internal` (web)                                    | GPL-3.0 + commercial dual                     | Excellent precedent, but GPL: borrow the architecture only                                                                                                  |
| Signal libsignal (6.0k stars)            | Rust -> JNI, Swift, Node                                                                              | AGPL-3.0, "use outside Signal is unsupported" | **Avoid** to embed                                                                                                                                          |
| 1Password                                | Rust core; open-sourced Typeshare (3.0k stars, Apache/MIT) to sync types to Swift/Kotlin/TS/Go/Python | Apache/MIT                                    | Typeshare is the reusable piece (types, not logic)                                                                                                          |
| Velopack                                 | Rust core, SDKs C#, C++, JS, Rust, Python                                                             | MIT                                           | Shows an updater is a good native-core candidate (needs to replace a running exe)                                                                           |
| Sentry Godot                             | C++ GDExtension over sentry-native + platform SDKs (Android SDK, Cocoa, JS for Web)                   | MIT                                           | Godot-native crash SDK built exactly this way, incl. Web since 1.4.0                                                                                        |
| Nakama Godot client (776 stars)          | Independent pure-GDScript client per language, REST + WebSocket, works on Web                         | Apache-2.0                                    | Direct precedent for our current model in Godot                                                                                                             |
| napi-rs (8.0k stars)                     | Rust -> Node-API prebuilt binaries (Win/macOS/Linux/Android) + wasm runtime                           | (m) MIT                                       | Would make the Node SDK carry native prebuilds; unnecessary for us                                                                                          |
| wasm-bindgen (9.2k stars)                | Rust -> browser WASM                                                                                  | Apache/MIT                                    | Would add a WASM blob to React for what WebCrypto does natively                                                                                             |

### 2.2 Trade-offs for Polaris Key

Shared native core (Rust: serde + ed25519 + ureq/reqwest)

- Pro: one verification implementation; one place for delta patch/chunk verify; one place for bug fixes.
- Con: five binding layers anyway (UniFFI Swift/Kotlin/Python, napi-rs, wasm-bindgen, plus a hand-written
  gdext shim because UniFFI has no Godot target); per-arch prebuilds and signing; iOS static xcframework and
  Android 16 KB page-size alignment (Google Play requirement in force since 2026-05-01 for Android 15+
  targets); Node and Python wheels matrix; large Web bundle; supply-chain surface (Cargo).
- Con (Godot Web): needs dlink templates and cross-origin isolation; gdext Web needs nightly; panics abort.
- Con (iOS): xcframework static linking works (GodotApplePlugins ships a mergeable xcframework, +2.5 MB), but
  the Godot iOS plugin docs still describe `.gdip` + static `.a`/xcframework, and the GDExtension iOS story is
  less documented; SwiftGodot/gdext iOS are lightly tested.
- The corpus already gives the assurance a shared core would: byte-for-byte agreement across 5 languages
  (2,990 tests). Adding a sixth language is one more runner, not a new architecture.

Independent implementations + corpus (current)

- Pro: idiomatic, dependency-light, uses platform crypto (CryptoKit, WebCrypto, JCA), trivially auditable
  (~150-line verifier), no native packaging on Web/iOS/Android.
- Con: N implementations of trust set / clock floor / gate must be kept equal - which the corpus enforces.

**Recommendation: hybrid.** Wire logic stays independent (add Godot and Kotlin runners). Use a shared native
component only for things that are large, CPU-bound and language-neutral: delta patch apply, chunk hashing,
archive unpack. For those, ship an optional native accelerator (HDiffPatch or zstd `--patch-from`) with a
pure fallback, and gate it behind a capability flag so Web/iOS never depend on it.

---

## 3. Self-update / OTA frameworks: what to embed or emulate

### 3.1 Tool table

| Tool                                                                             | License                                           | Latest release / stars                                                          | Platforms                                      | Feed / signing                                                                                                                                                                                                                                      | Verdict                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sparkle 2                                                                        | MIT + bundled third-party (m)                     | 2.10.0 2026-09-14; 9.8k stars; macOS 12+                                        | macOS (Developer ID; not MAS)                  | Appcast XML; EdDSA `edSignature`; delta enclosures; `phasedRolloutInterval` (7 groups); `channel`; `criticalUpdate`; `minimumAutoupdateVersion`; `informationalUpdate`                                                                              | **Adopt (already)**; raise floor to >= 2.9.6                                                                                    |
| WinSparkle                                                                       | MIT                                               | 0.9.4 2026-09-21; 1.5k stars; EdDSA since 0.9.0 (2025-03-27)                    | Windows x86/x64/arm64, C API                   | Same appcast format as Sparkle; DSA deprecated                                                                                                                                                                                                      | **Adopt** for Windows appcast reuse (our Worker already emits Sparkle appcasts)                                                 |
| Velopack                                                                         | MIT                                               | 1.2.161 2026-09-29; 2.4k stars; SDKs C#, C++, JS, Rust, Python                  | Windows, macOS (.pkg), Linux (AppImage)        | `releases.{channel}.json` (Version, SHA1, Size, Full/Delta); deltas with fallback (max 10 deltas, or when combined > full); no documented staged rollout or feed signature                                                                          | **Wrap/evaluate** as the desktop self-replace executor for Godot; put our signed manifest above it. No Godot integration exists |
| electron-updater 6.8.10                                                          | MIT                                               | 2026-09-26                                                                      | Electron: Win NSIS, macOS, Linux               | `latest*.yml` + blockmap deltas; v27 alpha adds Ed25519 signed manifests + trust lists                                                                                                                                                              | Borrow ideas; validates our design                                                                                              |
| Tauri updater v2                                                                 | MIT/Apache (m)                                    | plugin docs                                                                     | Win NSIS/MSI, macOS app.tar.gz, Linux AppImage | JSON static, or dynamic 200/204; **minisign Ed25519 signature mandatory**; `{{target}}/{{arch}}/{{current_version}}` URL templating; no built-in staged rollout                                                                                     | Borrow: 200/204 semantics + templated endpoint + mandatory signature                                                            |
| AppImageUpdate                                                                   | MIT                                               | 734 stars; beta-quality                                                         | Linux AppImage                                 | zsync delta; update info embedded in ISO9660 descriptor; `libappimageupdate` C++                                                                                                                                                                    | Wrap for AppImage channel (or let Velopack Linux do it)                                                                         |
| Flatpak UpdateMonitor portal                                                     | LGPL (m)                                          | n/a                                                                             | Linux Flatpak                                  | D-Bus `org.freedesktop.portal.Flatpak.UpdateMonitor`: update-available signal + install request                                                                                                                                                     | Use for `inform`/`install` on Flatpak; never self-replace                                                                       |
| MSIX App Installer (`.appinstaller`)                                             | platform                                          | Win10 1709+                                                                     | Windows                                        | Update settings (OnLaunch, HoursBetweenUpdateChecks, ShowPrompt); `ms-appinstaller:` scheme disabled by default since Dec 2023                                                                                                                      | Emit an `.appinstaller` from the Worker for sideloaded MSIX; Store builds update via Store                                      |
| Play In-App Updates                                                              | platform                                          | API 21+, Play-installed only, Kotlin/Java/native/Unity/Unreal; not with OBB     | Android                                        | flexible vs immediate; Play Console priority 0-5 and staleness days                                                                                                                                                                                 | Wrap in the Android plugin; borrow priority/staleness                                                                           |
| AltStore source JSON                                                             | MIT (m)                                           | n/a                                                                             | iOS (Classic sideload, PAL EU)                 | `apps[].versions[]` ordered newest first; `downloadURL`, `size`, `minOSVersion`; PAL needs notarized `marketplaceID`                                                                                                                                | Emit an AltStore source from release data; borrow "ordered versions" model                                                      |
| tufup 0.10.0                                                                     | MIT                                               | 2025-10-03; 147 stars                                                           | PyInstaller apps (Win/macOS; Linux possible)   | TUF via python-tuf, bsdiff patches, PEP440 channels (alpha/beta/rc); no delegations                                                                                                                                                                 | **Avoid** for game SDKs; borrow patch+TUF layering                                                                              |
| python-tuf 7.0.1                                                                 | MIT/Apache (m)                                    | 2026-09-02                                                                      | Python                                         | TUF spec reference                                                                                                                                                                                                                                  | Only if adopting TUF                                                                                                            |
| go-tuf v2.4.2                                                                    | Apache-2.0                                        | 2026-05-19; 717 stars                                                           | Go                                             | v2 client production-ready                                                                                                                                                                                                                          | Only if adopting TUF                                                                                                            |
| tough 0.24.0 / tuftool 0.17.0                                                    | Apache-2.0 or MIT                                 | 2026-07-10; 232 stars                                                           | Rust                                           | Rust TUF client + repo tool                                                                                                                                                                                                                         | Only if a Rust core were chosen                                                                                                 |
| tuf-js                                                                           | MIT                                               | 83 stars; Node ^22.22.2 / ^24.15.0 / >=26                                       | Node                                           | GitHub Package Security team                                                                                                                                                                                                                        | Only if adopting TUF                                                                                                            |
| sigstore-python 4.5.0 / sigstore-js (@sigstore/verify 4.1.2) / sigstore-go 1.3.0 | Apache-2.0 (m)                                    | Jul-Aug 2026                                                                    | Python/Node/Go                                 | Keyless signing + bundle verify (needs TUF-distributed trust root)                                                                                                                                                                                  | Use in CLI/CI provenance checks (`pkey publish`), not in runtime SDKs                                                           |
| Expo Updates protocol / EAS Update                                               | MIT client; custom server sample MIT (535 stars)  | expo-updates 52.5k-star monorepo                                                | RN iOS/Android                                 | Multipart manifest + directives (`rollBackToEmbedded`), `expo-runtime-version`, `expo-channel-name`, SHA-256 asset hashes, optional `expo-signature` RSA-v1_5-SHA256 with embedded cert; per-update % rollouts (one per branch) and branch rollouts | **Borrow heavily** (see 3.3)                                                                                                    |
| Shorebird                                                                        | Apache-2.0/MIT (client, CLI); service proprietary | 3k+ stars                                                                       | Flutter Android/iOS/macOS                      | Patches signed; tracks; % rollouts; iOS uses a custom Dart **interpreter**; native code cannot be patched                                                                                                                                           | Borrow compliance framing; nothing to embed                                                                                     |
| Capgo capacitor-updater 8.51.25                                                  | MPL-2.0                                           | 2026-09-24; 861 stars                                                           | iOS 15+, Android, Electron                     | zip bundles, checksum, optional E2E encryption, manifest delta, channels, self-host                                                                                                                                                                 | Borrow bundle+channel+checksum design                                                                                           |
| Microsoft CodePush                                                               | MIT                                               | **Retired 2025-03-31**; RN repo archived; standalone server archived 2025-05-20 | RN                                             | n/a                                                                                                                                                                                                                                                 | **Avoid** (dead)                                                                                                                |

### 3.2 Platform policy facts that must shape the SDK (verified)

- **Apple App Review 2.5.2**: apps "may not ... download, install, or execute code which introduces or
  changes features or functionality of the app". **4.7** allows downloadable HTML5/JavaScript mini apps and
  mini games and plug-ins but adds 4.7.1-4.7.3 (privacy, content filtering/reporting, no native API exposure
  without permission). **2.4.5(vii)**: Mac App Store apps "must use the Mac App Store to distribute updates;
  other update mechanisms are not allowed".
- **Apple DPLA**: the clause you cite as 3.3.1(B) ("Executable Code") reads, in the versions found, "Interpreted
  code may be downloaded to an Application but only so long as such code: (a) does not change the primary
  purpose of the Application by providing features or functionality that are inconsistent with the intended
  and advertised purpose of the Application as submitted to the App Store, (b) does not create a store or
  storefront for other code or applications, and (c) does not bypass signing, sandbox, or other security
  features of the OS." Older/other write-ups number this 3.3.2, and the pre-2017 text required interpreters
  and scripts to be packaged, not downloaded. I could not retrieve the full current DPLA PDF; **have counsel
  confirm current numbering/text**. Enforcement signal: on 2026-03-31 Apple removed the "Anything" app and
  blocked updates to Replit/Vibecode citing 2.5.2 and 3.3.1(B) (Gigazine).
- **Shorebird's justification**: iOS uses a custom Dart interpreter "to comply with the interpreter-only
  restriction", relies on the same (a)-(c) conditions, and on Google Play's clause that the self-update
  restriction "does not apply to code that runs in a virtual machine or an interpreter where either provides
  indirect access to Android APIs". Native code/assets cannot be patched.
- **Google Play Device & Network Abuse**: "An app distributed via Google Play may not modify, replace, or
  update itself using any method other than Google Play's update mechanism", with the VM/interpreter
  exception. `REQUEST_INSTALL_PACKAGES` may not be used for self-updates (except device management).
  Sideload/F-Droid/direct-APK channels are outside this, but F-Droid rejects apps needing Play Services or
  undisclosed anti-features, so the Android SDK needs a `foss` flavor with no Play dependencies.
- **Microsoft Store**: packages must be installed, serviced and updated only through the Store (search
  snippet of Store Policies; Win32-in-Store apps have different rules). Verify against the policy page.
- **Apple-hosted Background Assets** (WWDC25 session 325): iOS/macOS/tvOS/visionOS 26+, 200 GB hosting included
  in the Developer Program, system-managed downloads via a downloader extension. This is the App-Store-native
  path for large iOS content packs and should be an _optional transport_ for the pack manager.
- **Play Asset Delivery**: install-time / fast-follow / on-demand packs; Java/Kotlin, native, Unity docs;
  Godot not mentioned; no maintained Godot PAD plugin found. Treat as a Kotlin-SDK transport.

### 3.3 Patterns to extract (for all SDKs and the Godot code/content packs)

From Expo Updates v1: (1) `runtimeVersion`-style compatibility key that ties a pack to the native/engine build
that can run it (Godot: engine version + export "pack API level"); (2) request headers carry platform,
runtime version, channel; (3) directives channel for server-driven actions (rollback, "no update");
(4) immutable content-addressed asset URLs with SHA-256, so caching is aggressive; (5) `manifest-filters` and
server-defined headers echoed back by the client; (6) optional manifest signing with an embedded trust anchor.
From Sparkle: phased rollout by client bucket (stable hash of device id into 7 groups), `channel`,
`criticalUpdate` (bypass "skip"), `minimumAutoupdateVersion` (force UI for major upgrades),
`informationalUpdate` (store builds: link, not install). From Play: numeric priority + staleness gate
immediate vs flexible. From Tauri: 200/204 semantic and templated endpoint variables. From Velopack: delta
chain fallback rules (cap N deltas; fall back to full when cumulative delta > full). From TUF: separate
roles/keys for root, release targets, snapshot, timestamp; thresholds; rollback/freeze defenses (already partly
covered by `expiresAt`/clock floor); delegate per-channel keys. From Capgo: zip bundle + checksum +
optional encryption + manifest delta. From Godot itself: delta-encoded patch PCKs (Godot 4.6+) require the base
packs to be byte-identical to those loaded at runtime, so pack manifests must pin base digests.

### 3.4 Godot "code pack" update plan (based on the above)

- Desktop self-update of the engine binary needs a helper process (a running exe cannot replace itself on
  Windows). Options: Velopack (Rust) with a tiny launcher, Sparkle/WinSparkle for the appcast route, or the
  "launcher downloads latest zip/PCK then runs the game" pattern (zip::launcher, MIT, Godot 4.4+). For pure
  content, replace/add PCKs in `user://` and `ProjectSettings.load_resource_pack(path, replace_files)` (PCKs
  cannot be unloaded).
- Godot's own docs advise asymmetric crypto for verifying patch PCKs: sign the pack manifest with the existing
  Ed25519 keys and pin SHA-256 of each pack.
- Mobile store builds: no binary self-update; `content-only` packs, `data-only` by default on iOS.

---

## 4. Godot-specific building blocks

| Need                     | Candidate                                                                                                                                                                                                                                                       | License / status | Verdict                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Distribution of the SDK  | Godot Asset Store (store.godotengine.org): live, integrated in 4.7, supports GDExtensions, multiple versions; old AssetLib deprecated/read-only soon                                                                                                            | n/a              | Publish here + GitHub Releases                                                                                                     |
| HTTP/REST                | Built-in `HTTPRequest`/`HTTPClient` (download_file, download_chunk_size 65536, accept_gzip, body_size_limit, timeout; no documented Range/resume, send `Range` header manually). Web: no threaded/blocking mode, same-origin policy                             | MIT              | **Adopt built-in**; no third-party REST addon needed                                                                               |
| Backend-client peers     | Nakama Godot (Apache-2.0, 776 stars, GDScript, Web OK); Godot-GameBackendSDK (GDScript, Godot 4.4+, includes Remote Config + feature flags); AccelByte SDK for Godot; RuStore Remote Config plugin                                                              | mixed            | Borrow API shape (autoload singleton, retry/backoff, request queue, token store)                                                   |
| JWT                      | fenix-hub godot-engine.jwt                                                                                                                                                                                                                                      | MIT, HS/RS only  | Avoid                                                                                                                              |
| QR generation            | kenyoni QR Code Generator 2.0.0 (pure GDScript, MIT, 2026-07-21, Godot 4.4+, marked unstable)                                                                                                                                                                   | MIT              | **Adopt (vendor)** for device-flow verification QR; native QR plugins exist for scan                                               |
| OAuth (mobile)           | godot-mobile-plugins/godot-oauth2 v2.0-Multi (MIT, 21 stars, 2026-06-18, min Godot 4.7 for v2, Android Custom Tabs + iOS ASWebAuthenticationSession, PKCE, deeplink)                                                                                            | unstable         | Optional integration; build our own thin flow on same primitives                                                                   |
| OAuth (device flow)      | maji-git/godot-oauth2-deviceflow (MIT, 1 star)                                                                                                                                                                                                                  | toy              | **Avoid**; implement device grant ourselves (small)                                                                                |
| OAuth (desktop loopback) | Godot `TCPServer` + `OS.shell_open` (Duende blog uses port 8948 loopback + PKCE; device flow for consoles/VR)                                                                                                                                                   | built-in         | Build ourselves; Web uses redirect/popup via JavaScriptBridge                                                                      |
| Deep links               | godot-mobile-plugins Deeplink (Android App Links, Apple Universal Links; 25 stars, Jun 2026)                                                                                                                                                                    | MIT (m)          | Adopt optionally                                                                                                                   |
| Secure storage           | **No maintained Keychain/Keystore plugin found** (GD Credentials deleted; others are GDScript file encryption)                                                                                                                                                  | n/a              | Build in our Android/iOS plugins (Keystore, Keychain); DPAPI/Keychain via GDExtension on desktop; Web: IndexedDB non-secret only   |
| Android plugin template  | m4gr3d/Godot-Android-Plugin-Template and GDExtension-Android-Plugin-Template (v2 plugins: AAR + `EditorExportPlugin._get_android_libraries`, Gradle build required); Godot 4.7 stabilizes GABE (Godot Android Build Environment)                                | MIT (m)          | **Adopt** as the plugin skeleton                                                                                                   |
| iOS plugin               | godotengine/godot-ios-plugins (MIT, 199 stars; `.gdip`, static lib/xcframework, singletons unavailable in editor); GodotApplePlugins (MIT, 113 stars, mergeable xcframework, StoreKit 2, Sign in with Apple, GameCenter; iOS 17+/macOS 14+; stubs on non-Apple) | MIT              | Adopt as reference; use GodotApplePlugins for Sign in with Apple                                                                   |
| In-app review / share    | godot-mobile-plugins In-App Review (39 stars), Share (35)                                                                                                                                                                                                       | MIT (m)          | Optional                                                                                                                           |
| Play In-App Update       | dcryptoniun/Godot-Android-InAppUpdate v1.1.0 (MIT, Godot 4.5+, rejected from AssetLib: source only)                                                                                                                                                             | fringe           | Build in our Android plugin (Play `AppUpdateManager`)                                                                              |
| Play Asset Delivery      | none found                                                                                                                                                                                                                                                      | n/a              | Build in Android plugin if needed                                                                                                  |
| IAP                      | godotengine/godot-google-play-billing (MIT, 264 stars, Godot 4.2+); godot-iap moved to the OpenIAP monorepo (MIT; StoreKit 2 + Play Billing 8; iOS via native Swift GDExtension); GodotApplePlugins StoreKit 2                                                  | MIT              | Do not wrap; expose receipt-to-license hooks; server-side verify with Apple app-store-server-library (MIT) and Play Integrity      |
| Crash / health           | Sentry Godot 2.3.0 (2026-09-29; MIT; 255 stars; Windows/Linux/macOS/Android/iOS/Web; Godot 4.5+; release health, breadcrumbs, structured logs, tracing)                                                                                                         | MIT              | **Adopt as optional companion**; Godot has no built-in crash upload (crash handler prints a backtrace with a configurable message) |
| Mods / packs             | Godot Mod Loader (CC0, 679 stars; Godot 4 v7.0.1, 2025-08-01; ZIP mods; script extensions; desktop + Android/iOS)                                                                                                                                               | CC0              | Borrow ideas only. No maintained "godot-patch-loader" found                                                                        |
| Delta patching           | NodotProject/godot-binary-patcher (MIT, 0 stars, HDiffPatch GDExtension)                                                                                                                                                                                        | toy              | Avoid as dependency; validates approach                                                                                            |
| Tests                    | GUT 9.7.1 (2026-07-10; MIT; 2.7k stars; CLI, JUnit XML; Godot 4.7); gdUnit4 6.2.1 (2026-08-20; MIT; 1.2k stars; GitHub Action; C#)                                                                                                                              | MIT              | **Adopt GUT** for the corpus runner (headless CLI + JUnit); gdUnit4 acceptable alternative                                         |
| Feature flags            | No OpenFeature or GDScript flag SDK from big vendors; ConfigCat documents Godot via its .NET SDK (C# only, no Web)                                                                                                                                              | n/a              | Build; see section 6                                                                                                               |
| Localization             | Godot built-in `TranslationServer`/`tr()` with CSV or gettext PO import (m)                                                                                                                                                                                     | MIT              | Ship UI strings as `.po`; no library needed                                                                                        |
| Language/engine notes    | Godot 4.7: `GDScript can implement Java interfaces` (AndroidRuntime), `download templates per platform/arch`, GDExtensions listed in Project Settings                                                                                                           | n/a              | Use for Android bridge simplification                                                                                              |

Web-specific Godot notes: single-threaded is the default since 4.3 (avoids SharedArrayBuffer/COOP/COEP);
GDExtension on Web needs the "Extensions Support" export option, dlink templates, and cross-origin-isolation
headers (the Godot docs equate it with thread-support requirements), which conflicts with iframe hosts such as
itch.io; persistence is IndexedDB and needs cookies (fails in incognito / third-party iframes); networking is
HTTP/WebSocket/WebRTC only, so the Worker must serve CORS.

---

## 5. Identity and login libraries

| Library                                     | License        | Latest (date)                                                                             | Verdict                                                                                                                                                                                         |
| ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ASWebAuthenticationSession                  | platform       | iOS 12+                                                                                   | **Adopt** on iOS/macOS (zero dependency) with our own PKCE                                                                                                                                      |
| AppAuth-iOS 3.0.0                           | Apache-2.0     | 2026-08-24 (needs Xcode 27; iOS 15+); 2.1.0 2026-06-12 removed external-browser fallbacks | Optional dependency; for Swift SDK prefer ASWebAuthenticationSession + ~150 lines PKCE to keep zero deps                                                                                        |
| AppAuth-Android                             | Apache-2.0     | **last release 0.11.1 on 2021-12-22**; 3.2k stars                                         | Stale; use Custom Tabs (`androidx.browser`) + own PKCE, or vendor AppAuth knowingly                                                                                                             |
| Credential Manager (`androidx.credentials`) | platform       | passkeys, passwords, Sign in with Google; **not** an OIDC code-flow API                   | Adopt for passkey sign-in only                                                                                                                                                                  |
| oauth4webapi 3.8.8 (panva)                  | MIT            | 2026-09-05                                                                                | **Adopt** for React/browser OIDC (lower-level, spec-strict) if sdk-react does not already hand-roll                                                                                             |
| openid-client 6.8.8 (panva)                 | MIT            | 2026-09-05                                                                                | Adopt in Node SDK/CLI if a general OIDC RP is needed                                                                                                                                            |
| Authlib 1.8.0                               | BSD-3 (m)      | 2026-08-30                                                                                | Optional Python extra for OIDC/device flow                                                                                                                                                      |
| SimpleWebAuthn 14.0.3                       | MIT (m)        | 2026-09-25 (v14: PQC/ML-DSA, Node 22+)                                                    | Adopt for passkeys (server verify in Worker + browser client)                                                                                                                                   |
| Sign in with Apple                          | platform       | via AuthenticationServices; GodotApplePlugins wraps it for Godot                          | Adopt platform API; verify identity tokens server side                                                                                                                                          |
| Duende.IdentityModel / OidcClient           | (m) Apache-2.0 | not verified                                                                              | Candidate for .NET SDK                                                                                                                                                                          |
| Device Authorization Grant (RFC 8628)       | spec           | n/a                                                                                       | Implement directly (poll, `slow_down` backoff, QR of `verification_uri_complete`); the Duende Godot article is the clearest recipe (desktop: code+PKCE with loopback; consoles/VR: device flow) |

Play Integrity API (server-verified verdicts: appIntegrity, deviceIntegrity, accountDetails `LICENSED`) and Apple
App Attest/DeviceCheck (m) are the store-native anti-piracy signals to feed into license activation on the
Worker; Apple's `app-store-server-library-node` (MIT, 383 stars) verifies StoreKit JWS transactions.

---

## 6. Feature flags / remote config interoperability

### 6.1 OpenFeature

- CNCF standard, Apache-2.0. Server SDKs: .NET, C++, Dart, Go, Java, Node.js, NestJS, PHP, Python, Ruby, Rust.
  Client SDKs: Angular, Dart (beta), iOS (Swift), Kotlin, React, Web.
- Versions seen: JS monorepo web-sdk 1.10.0 / server-sdk 1.23.0 / core 1.12.0 (2026-07-28), react-sdk 1.4.1
  (2026-06-19); Python SDK 0.10.0 (3.10+; in-memory provider; hooks; events); Swift SDK 0.6.0 (iOS 15+, macOS 12+,
  tvOS 15+, watchOS 8+, static-context, no third-party deps); Kotlin SDK 0.9.0 (alpha; Android SDK 21+, JVM 11+,
  KMP).
- No Godot/GDScript OpenFeature SDK exists. There is a C++ SDK, but nothing packaged for GDExtension.
- **Recommendation:** ship providers (thin adapters over the verified config document): `@polaris-key/openfeature-web`
  (Web+React), Node (server paradigm: per-request context evaluated in-process from the signed document),
  then Python, Swift, Kotlin as their SDKs reach 1.0 or when customers ask. Static-context paradigm fits our
  per-device signed document naturally. The signed/enforced/default/hidden state maps to resolution
  details (`reason`, `flagMetadata`). Don't block the Godot SDK on OpenFeature; mimic its API shape
  (`get_bool/get_string/get_number/get_object`, `on_ready/on_changed`).

### 6.2 Vendor client models (from vendor docs reviewed)

| Vendor                 | Client evaluation location                                                                                                                                                                                            | Offline                       | Signed payload documented?      | Godot         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- | ------------- |
| LaunchDarkly           | Client-side SDKs get values **evaluated on LD servers** (no rules on device); server SDKs evaluate locally from full ruleset; client-side ID / mobile key / SDK key; "secure mode" signs the _context_, not the flags | bootstrapping / cached values | No (context HMAC only)          | no SDK        |
| ConfigCat              | Config JSON from CDN, **rules evaluated locally in SDK** (auto/lazy/manual polling, 60 s default), local/offline mode                                                                                                 | yes                           | not addressed on pages reviewed | via .NET SDK  |
| Unleash                | Backend SDKs evaluate locally; frontend SDKs call Frontend API / Unleash Edge which evaluates                                                                                                                         | bootstrap from file/env       | not addressed                   | none official |
| Flagsmith              | Client SDKs use public environment key (remote evaluation); server SDKs can do local evaluation from an environment document                                                                                          | offline handler (m)           | not addressed                   | none listed   |
| Firebase Remote Config | fetch + activate from Google; conditions evaluated server-side; SDKs for Apple, Android, Web, Flutter, Unity, C++; throttled fetch (m)                                                                                | cached defaults               | not addressed                   | none          |

Takeaway: none of the reviewed vendor pages document a **server-signed, offline-verifiable flag document**;
that is a real differentiator, and OpenFeature providers let customers keep their application code
vendor-neutral.

---

## 7. Download / transfer / decompression / delta

Godot built-ins (4.7 docs):

- `FileAccess.CompressionMode`: FastLZ, Deflate, Zstd, GZip, Brotli (decompress only).
- `PackedByteArray.compress/decompress` needs the uncompressed size and "is not guaranteed to work with data not
  compressed by Godot"; `decompress_dynamic(max_output_size)` supports **only brotli, gzip and deflate**.
  `FileAccess.open_compressed` reads only Godot-written files. So: prefer gzip/brotli via HTTP
  `Accept-Encoding` (HTTPRequest `accept_gzip`), and for zstd frames pass the exact size from the manifest.
- `HTTPRequest.download_file` streams to disk with `download_chunk_size` 65536 and `body_size_limit` guard;
  resume requires sending a `Range` header yourself; Web cannot use threaded/blocking mode.
- Hashing: SHA-256 is native (`HashingContext`, `FileAccess.get_sha256` (m)). BLAKE3/SHA-512 are not: **use
  SHA-256 for pack, chunk and Merkle digests** so all SDKs (incl. Web) can verify cheaply.
- PCK: `ProjectSettings.load_resource_pack` (PCK or ZIP; `replace_files` default true); Godot 4.6 added
  delta-encoded patch PCKs (compression level default 19; base packs must be identical to those loaded).

Delta tools:

| Tool                          | License                                  | Status                                                                                                                              | Verdict                                                                                                          |
| ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| HDiffPatch                    | MIT                                      | v5.1.3 2026-07-31; 2.1k stars; C/C++; zstd/lzma; streaming; directory diff; Android JNI binding; bsdiff4/xdelta3-compatible formats | **Wrap** as optional native patch applier for Godot desktop/Android and Kotlin; not for Web/iOS v1               |
| zstd `--patch-from`           | BSD-3 (dual GPLv2, choose BSD) (m)       | zstd 1.5.7 (2025-02-28): "substantial `--patch-from` improvements"                                                                  | Good server-side generator; client needs zstd dictionary-as-reference decode (Godot has zstd but not patch-from) |
| bsdiff/bspatch                | BSD-2 (m)                                | classic; Sparkle and tufup use bsdiff-style deltas                                                                                  | Borrow; memory heavy                                                                                             |
| xdelta3                       | Apache-2.0 (m)                           | mature                                                                                                                              | Alternative                                                                                                      |
| Sparkle BinaryDelta           | Sparkle                                  | **2.9.5/2.9.6 fixed symlink attack in delta patching**                                                                              | Lesson: any patch applier must reject symlinks and path traversal, verify base hash before and result hash after |
| Velopack deltas               | MIT                                      | chain cap + fallback to full                                                                                                        | Borrow rules                                                                                                     |
| casync/desync, zsync, FastCDC | LGPL-2.1+ (casync, m), BSD-3 (desync, m) | content-defined chunking                                                                                                            | Borrow chunk-manifest idea; avoid LGPL linking on iOS                                                            |
| AppImageUpdate / zsync        | MIT                                      | Linux only                                                                                                                          | Only for AppImage channel                                                                                        |

Recommendation for content packs: phase 1 = full packs, HTTP Range resume, per-chunk SHA-256 list in the signed
manifest, atomic install (write to temp, verify, rename), zstd/gzip on the wire; phase 2 = chunk-level dedupe
(only fetch chunks whose hash changed; pure GDScript/JS/Swift/Kotlin, no native dependency); phase 3 = optional
HDiffPatch accelerator on desktop/Android. Keep the manifest format channel- and runtimeVersion-aware.

---

## 8. Diagnostics / telemetry

- **Sentry Godot 2.3.0** (2026-09-29): MIT, C++ GDExtension on sentry-native + Android/Cocoa/JS SDKs, Web since 1.4.0,
  Godot >= 4.5 for 1.x/2.x, C#/.NET since 2.0.0, release health (crash-free users/sessions), attachments,
  structured logs, tracing (spans API 2.2.0; `SentryHTTPRequest` 2.3.0). Best available signal to gate/rollback
  rollouts. Adopt as an optional companion; the SDK exposes a hook (`on_release_health(signal)`) rather than a hard
  dependency.
- **Godot built-in**: crash handler prints a backtrace (message settable at Debug > Settings > Crash Handler >
  Message); no upload.
- **OpenTelemetry**: JS traces/metrics stable, logs "development", browser client instrumentation
  "experimental and mostly unspecified"; opentelemetry-swift 2.2.0 traces stable, logs beta, metrics on an
  outdated spec, OTLP/HTTP exporter described as experimental in its README; no Godot SDK. OTLP/HTTP itself is
  simple (`/v1/traces|metrics|logs`, protobuf or JSON, JSON stable, 429/502/503/504 retryable with Retry-After,
  partial-success semantic). A Worker OTLP receiver is cheap, but for update/boot events a fixed first-party
  schema (event, from/to version, channel, capability, result, duration, bytes, device-bucket) is simpler,
  privacy-reviewable and matches PRIVACY.md. **Recommendation:** first-party event endpoint (signed device
  auth already exists) + optional OTLP export adapter + Sentry release health for crash gating.

---

## 9. Per-SDK recommendation table

Legend: Adopt = take as dependency; Wrap = thin binding to platform/native component; Build = our code;
Avoid = do not use.

| SDK                                                                      | Adopt                                                                                                                                                                                                                                                                                                                           | Wrap                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Build ourselves                                                                                                                                                                                                                                                                                                                                                                                            | Avoid                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Godot 4.x** (GDScript-first; iOS, Android, macOS, Windows, Linux, Web) | Godot built-ins (HTTPRequest, HashingContext SHA-256, FileAccess/PackedByteArray gzip/zstd, `load_resource_pack`, TCPServer, JavaScriptBridge, TranslationServer); GUT 9.7.1 for the corpus runner; kenyoni QR (vendored, MIT); Godot Asset Store for distribution; Sentry Godot as optional companion                          | `pkey_native` GDExtension (godot-cpp 10 + Monocypher 4.0.3 Ed25519/SHA-512) or fork of gd-ed25519 after corpus pass; Android v2 plugin (Kotlin AAR: Keystore, Custom Tabs, Play In-App Update, PAD, Play Integrity) from the Android plugin templates; iOS plugin (Keychain, ASWebAuthenticationSession, App Attest; Sign in with Apple via GodotApplePlugins); desktop updater executor: Velopack or Sparkle/WinSparkle helper via launcher; optional HDiffPatch | Wire verifier + fallback GDScript Ed25519/SHA-512; trust set, clock floor, gate, config resolver (enforced/default/hidden), secrets; device registration; OIDC code+PKCE and RFC 8628 device flow; pack manager (manifest verify, Range resume, SHA-256 chunks, atomic install, channels, rollback, pack policy by channel); channel-capability layer; boot/update/loader UI scenes; first-party telemetry | gdext/Rust for the wire core; UniFFI for Godot; fenix-hub JWT; gd-ed25519 as an unvetted hard dependency; C# build for Web; godot-oauth2-deviceflow; relying on Web GDExtension; scripts in iOS packs by default |
| **Node/TS**                                                              | WebCrypto/`node:crypto` Ed25519 (current); @noble/ed25519 3.x fallback; oauth4webapi / openid-client; OpenFeature server/web SDKs; SimpleWebAuthn (browser + Worker)                                                                                                                                                            | electron-updater adapter (optional) for Electron apps; Velopack JS SDK for desktop apps                                                                                                                                                                                                                                                                                                                                                                           | JWS verify (keep tiny), trust/gate, pack client, OpenFeature provider                                                                                                                                                                                                                                                                                                                                      | jose in the hot path (use as test oracle); napi-rs/WASM core; tuf-js unless TUF adopted                                                                                                                          |
| **Python**                                                               | `cryptography` (pin range; watch Intel-mac wheels), `httpx`; Authlib (extra) for OIDC; OpenFeature Python (0.10, pre-1.0) provider optional                                                                                                                                                                                     | PyNaCl optional fallback; tufup only for PyInstaller apps; Velopack Python for desktop apps                                                                                                                                                                                                                                                                                                                                                                       | verify + gate, resumable downloader on httpx, pack manager                                                                                                                                                                                                                                                                                                                                                 | UniFFI-Python core; tufup as a general updater                                                                                                                                                                   |
| **Swift**                                                                | CryptoKit (+ swift-crypto 5.0.0 for Linux via `canImport`); Sparkle **>= 2.9.6** (macOS only, keep link-time conditioning); ASWebAuthenticationSession; OpenFeature Swift 0.6.0 provider (Apple platforms only)                                                                                                                 | Apple-hosted Background Assets as optional pack transport; AppAuth-iOS 3.0.0 optional                                                                                                                                                                                                                                                                                                                                                                             | PKCE + device flow (small), URLSession background downloads with resume data, channel detection (App Store/TestFlight/dev via receipt (m)), pack manager                                                                                                                                                                                                                                                   | Sparkle in iOS/MAS builds; UniFFI-Swift core; self-update outside macOS Developer ID                                                                                                                             |
| **React**                                                                | WebCrypto Ed25519 + @noble/ed25519 fallback; oauth4webapi (browser OIDC); OpenFeature Web + React SDK provider; SimpleWebAuthn browser                                                                                                                                                                                          | Workbox (m) for PWA update flow (optional)                                                                                                                                                                                                                                                                                                                                                                                                                        | Login UI (exists), pack manager on Cache API/IndexedDB, "update available" banner                                                                                                                                                                                                                                                                                                                          | wasm-bindgen core; OTel browser instrumentation (experimental)                                                                                                                                                   |
| **Kotlin/Android (proposed, recommended)**                               | JCA Ed25519 on API 33+, **Tink 1.23** below; OkHttp 5.5.0 (or Ktor 3.6.0); kotlinx.serialization; WorkManager; androidx.browser Custom Tabs; Credential Manager (passkeys); DataStore + Tink/Keystore (EncryptedSharedPreferences is deprecated); Play In-App Updates / Play Asset Delivery / Play Integrity in a `play` flavor | Reuse the AAR as the Godot Android v2 plugin backend; OpenFeature Kotlin (0.9 alpha) provider optional                                                                                                                                                                                                                                                                                                                                                            | Verify/gate, Range-resume downloader, `foss` flavor without Play, pack manager                                                                                                                                                                                                                                                                                                                             | lazysodium-android (MPL, JNA, page-size unknown); AppAuth-Android as sole dependency (stale); UniFFI-Kotlin (JNA)                                                                                                |
| **C#/.NET (proposed, defer)**                                            | BouncyCastle.Cryptography 2.7.0 (pure managed, IL2CPP-safe) or NSec 26.4.0 (needs libsodium); Velopack C# SDK; OpenFeature .NET (stable); Duende.IdentityModel.OidcClient (unverified)                                                                                                                                          | none                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verify/gate + pack manager                                                                                                                                                                                                                                                                                                                                                                                 | Godot-C# for Web (impossible); assuming BCL Ed25519                                                                                                                                                              |

Adoption priority: (1) Godot GDScript core + corpus runner; (2) Kotlin SDK/Android plugin; (3) channel-capability
data model + pack manifest; (4) OpenFeature web/node providers; (5) .NET only on demand.

---

## 10. Licensing concerns for commercial games

| Item                                                                                                                                                                  | License                         | Concern                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| libsignal                                                                                                                                                             | **AGPL-3.0**                    | Do not embed; "use outside Signal is unsupported"                         |
| Bitwarden sdk-internal                                                                                                                                                | **GPL-3.0** (+ commercial dual) | Do not embed; architecture reference only                                 |
| casync (m)                                                                                                                                                            | LGPL-2.1+                       | Avoid static linking (iOS/console); borrow ideas or use desync (BSD-3, m) |
| zstd                                                                                                                                                                  | BSD-3 / GPLv2 dual (m)          | Choose BSD                                                                |
| gdext                                                                                                                                                                 | MPL-2.0                         | File-level copyleft; OK to link; publish modified MPL files               |
| UniFFI, Capgo capacitor-updater, lazysodium-android                                                                                                                   | MPL-2.0                         | Same; generated code is ours                                              |
| Sparkle                                                                                                                                                               | MIT + bundled BSD/other (m)     | Ship third-party notices                                                  |
| WinSparkle, Velopack, HDiffPatch, noble, jose, Sentry Godot, GUT, gdUnit4, SwiftGodot, GodotApplePlugins, godot-iap, Godot Mod Loader (CC0), kenyoni QR, oauth4webapi | MIT/CC0                         | Fine; keep notices                                                        |
| libsodium                                                                                                                                                             | ISC                             | Fine                                                                      |
| Monocypher                                                                                                                                                            | CC0-1.0 or BSD-2                | Fine                                                                      |
| PyNaCl, swift-crypto, Tink, OpenFeature SDKs, AppAuth, opentelemetry-_, sigstore-_, go-tuf                                                                            | Apache-2.0                      | Fine; NOTICE files                                                        |
| cryptography                                                                                                                                                          | Apache-2.0 OR BSD-3             | Fine                                                                      |
| Godot engine                                                                                                                                                          | MIT                             | Fine (export templates bundle third-party licenses; SDK ships notices)    |

Non-license constraints: Apple DPLA 3.3.1(B), App Review 2.5.2/4.7/2.4.5(vii), Google Play Device & Network
Abuse and `REQUEST_INSTALL_PACKAGES`, Microsoft Store update rules, F-Droid inclusion policy.

---

## 11. Risks, unknowns, suggested spikes

1. Benchmark GDScript Ed25519 verify + SHA-512 on Web, low-end Android, iOS release builds (estimate only).
2. Confirm in Godot 4.7.2 whether official Web templates now include dlink builds and whether COOP/COEP is
   truly required for extension support (doc summary says yes; verify empirically; see A5-godot-empirical).
3. Extend the corpus with the Ed25519 verify-profile vectors; run against WebCrypto (Chrome/Firefox/Safari),
   CryptoKit, `cryptography`, JCA/Tink, Monocypher, GDScript port.
4. Fork/vendor gd-ed25519 or write `pkey_native`; check 16 KB page alignment of the Android `.so`.
5. Model `channel -> UpdateCapability + codePolicy` in `.pkey/release` and the update service; add
   "informational/critical/minimumAutoupdateVersion/priority/staleness" fields.
6. Raise Sparkle floor to 2.9.6 in `sdks/swift/Package.swift` (separate change; wire-neutral).
7. Prototype Velopack around a Godot desktop export (no known integration).
8. Have counsel confirm DPLA numbering/text and the Microsoft Store policy wording.
9. Unverified here: ed25519-dalek license/version, bsdiff/xdelta3/zsync/casync licenses, Godot iOS GDExtension
   packaging specifics for 4.7, Flagsmith offline handler, Tauri updater license.

---

## 12. Source URLs

Crypto: https://github.com/freehuntx/gd-ed25519 · https://store.godotengine.org/asset/freehuntx/ed25519/ ·
https://monocypher.org/ · https://monocypher.org/manual/eddsa · https://github.com/LoupVaillant/Monocypher/releases ·
https://github.com/jedisct1/libsodium/releases · https://github.com/paulmillr/noble-curves ·
https://github.com/paulmillr/noble-ed25519 · https://github.com/panva/jose · https://github.com/dchest/tweetnacl-js ·
https://pypi.org/project/cryptography/ · https://pypi.org/project/PyNaCl · https://github.com/apple/swift-crypto ·
https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify · https://blog.ipfs.tech/2025-08-ed25519/ ·
https://eprint.iacr.org/2020/1244 · https://github.com/fenix-hub/godot-engine.jwt ·
https://docs.godotengine.org/en/stable/classes/class_crypto.html ·
https://docs.godotengine.org/en/stable/classes/class_hashingcontext.html ·
https://docs.godotengine.org/en/stable/classes/class_javascriptbridge.html ·
https://github.com/tink-crypto/tink-java · https://github.com/bcgit/bc-csharp · https://github.com/ektrah/nsec ·
https://github.com/dotnet/runtime/issues/14741 · https://github.com/dalek-cryptography/curve25519-dalek ·
https://github.com/jedisct1/rust-ed25519-compact

Native core: https://github.com/mozilla/uniffi-rs · https://github.com/mozilla/application-services ·
https://github.com/matrix-org/matrix-rust-sdk · https://github.com/bitwarden/sdk-internal ·
https://github.com/signalapp/libsignal · https://github.com/1Password/typeshare · https://github.com/napi-rs/napi-rs ·
https://github.com/wasm-bindgen/wasm-bindgen · https://github.com/godot-rust/gdext ·
https://godot-rust.github.io/book/toolchain/export-web.html · https://github.com/godotengine/godot-cpp ·
https://github.com/migueldeicaza/SwiftGodot · https://github.com/heroiclabs/nakama-godot ·
https://github.com/getsentry/sentry-godot · https://developer.android.com/16kb-page-size ·
https://docs.godotengine.org/en/latest/engine_details/development/compiling/compiling_for_web.html ·
https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html

Update frameworks and policy: https://github.com/sparkle-project/Sparkle · https://sparkle-project.org/documentation/publishing/ ·
https://github.com/sparkle-project/Sparkle/releases/tag/2.9.6 · https://github.com/vslavik/winsparkle ·
https://github.com/velopack/velopack · https://docs.velopack.io/ · https://github.com/electron-userland/electron-builder/releases ·
https://v2.tauri.app/plugin/updater/ · https://github.com/AppImageCommunity/AppImageUpdate ·
https://docs.flatpak.org/en/latest/libflatpak-api-reference.html ·
https://learn.microsoft.com/en-us/windows/msix/app-installer/app-installer-file-overview ·
https://developer.android.com/guide/playcore/in-app-updates · https://developer.android.com/guide/playcore/asset-delivery ·
https://faq.altstore.io/developers/make-a-source · https://github.com/dennisvang/tufup ·
https://github.com/theupdateframework/python-tuf · https://github.com/theupdateframework/go-tuf ·
https://github.com/awslabs/tough · https://github.com/theupdateframework/tuf-js · https://github.com/sigstore/sigstore-python ·
https://docs.expo.dev/technical-specs/expo-updates-1/ · https://docs.expo.dev/eas-update/code-signing/ ·
https://docs.expo.dev/eas-update/rollouts/ · https://github.com/expo/custom-expo-updates-server ·
https://github.com/shorebirdtech/shorebird · https://docs.shorebird.dev/code-push/faq/ ·
https://github.com/Cap-go/capacitor-updater · https://expo.dev/blog/how-to-replace-app-center-and-codepush ·
https://developer.apple.com/app-store/review/guidelines/ ·
https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ ·
https://gigazine.net/gsc_news/en/20260331-apple-pulls-vibe-coding-app-anything/ ·
https://forums.solar2d.com/t/apple-allows-lua-scripts-to-be-downloaded-and-run/351804 ·
https://developer.apple.com/videos/play/wwdc2025/325 · https://support.google.com/googleplay/android-developer/answer/9888379 ·
https://support.google.com/googleplay/android-developer/answer/12085295 · https://f-droid.org/docs/Inclusion_Policy ·
https://learn.microsoft.com/windows/uwp/publish/store-policies

Godot building blocks: https://godotengine.org/releases/4.7/ · https://store.godotengine.org/ ·
https://gamefromscratch.com/the-godot-asset-store-is-live/ · https://github.com/godot-mobile-plugins ·
https://store.godotengine.org/asset/cengiz/oauth2-plugin/ · https://store.godotengine.org/asset/kenyoni/qr-code/ ·
https://github.com/maji-git/godot-oauth2-deviceflow · https://github.com/godotengine/godot-ios-plugins ·
https://github.com/migueldeicaza/GodotApplePlugins · https://github.com/hyochan/godot-iap ·
https://github.com/godotengine/godot-google-play-billing · https://github.com/m4gr3d/Godot-Android-Plugin-Template ·
https://github.com/m4gr3d/GDExtension-Android-Plugin-Template ·
https://docs.godotengine.org/en/stable/tutorials/platform/android/android_plugin.html ·
https://docs.godotengine.org/en/stable/tutorials/platform/ios/ios_plugin.html ·
https://github.com/GodotModding/godot-mod-loader · https://github.com/bitwes/Gut · https://github.com/MikeSchulze/gdUnit4 ·
https://github.com/NodotProject/godot-binary-patcher · https://github.com/Joy-less/zip-launcher ·
https://github.com/dcryptoniun/Godot-Android-InAppUpdate · https://configcat.com/blog/how-to-use-feature-flags-in-godot/ ·
https://docs.godotengine.org/en/stable/tutorials/export/exporting_pcks.html ·
https://docs.godotengine.org/en/stable/classes/class_fileaccess.html ·
https://docs.godotengine.org/en/stable/classes/class_packedbytearray.html ·
https://docs.godotengine.org/en/stable/classes/class_httprequest.html ·
https://digitalproduction.com/2025/12/04/godot-4-6-dev5-lands-d3d12-default-delta-patching-android-gradle-2d-boosts ·
https://docs.godotengine.org/en/4.6/tutorials/scripting/logging.html

Identity, flags, telemetry, transfer: https://github.com/openid/AppAuth-iOS · https://github.com/openid/AppAuth-Android ·
https://developer.android.com/identity/sign-in/credential-manager · https://github.com/panva/oauth4webapi ·
https://github.com/panva/openid-client · https://github.com/authlib/authlib · https://github.com/MasterKale/SimpleWebAuthn ·
https://duendesoftware.com/blog/20260804-authenticating-players-in-godot-4-with-oauth ·
https://github.com/apple/app-store-server-library-node · https://developer.android.com/google/play/integrity/overview ·
https://openfeature.dev/docs/reference/sdks/ · https://github.com/open-feature/swift-sdk ·
https://github.com/open-feature/python-sdk · https://github.com/open-feature/kotlin-sdk ·
https://github.com/open-feature/js-sdk · https://configcat.com/docs/advanced/caching/ ·
https://launchdarkly.com/docs/sdk/concepts/client-side-server-side · https://docs.getunleash.io/reference/sdks ·
https://docs.flagsmith.com/clients/overview · https://firebase.google.com/docs/remote-config/get-started ·
https://opentelemetry.io/docs/languages/js/ · https://opentelemetry.io/docs/specs/otlp/ ·
https://github.com/open-telemetry/opentelemetry-swift · https://docs.sentry.io/platforms/godot/ ·
https://github.com/sisong/HDiffPatch · https://github.com/facebook/zstd/releases ·
https://blog.includesecurity.com/2026/08/encryptedsharedpreferences-is-dead-heres-what-you-should-use-instead/ ·
https://github.com/square/okhttp/releases · https://github.com/ktorio/ktor/releases

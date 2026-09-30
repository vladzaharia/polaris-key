# X-02 Optional: a first-party Tauri plugin (Rust) beside the React SDK

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | X: Optional SDKs                                                                                                                                               |
| Size        | 2–3 engineer-weeks                                                                                                                                             |
| Depends on  | [P1b-01](P1b-01-parity-registry.md), [P3-05](P3-05-v4-react.md), [P1b-09](P1b-09-fingerprint-storage-fixes.md), [P1b-04](P1b-04-headers-config-corpora.md)     |
| Unblocks    | none                                                                                                                                                           |
| Role        | `pkey-implementer`                                                                                                                                             |
| Plan mode   | no, except one sub-step: if `shared-jws` has no injectable Ed25519 primitive by then, adding one touches `shared-jws` and `client-core` and needs a plan first |
| Gates       | `pnpm parity:check` with a new manifest; `fingerprint.json`, `headers.json` and the `jwsCases` vectors in `cargo test`; a new CI job                           |
| Human input | the go/no-go on optional work (program README §6); later, crates.io and npm publishing rights. Build and test proceed without them                             |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

This is a **kickoff brief**: scope, layout, the plugin surface and the order of work. Tauri is an
adapter, not a new SDK. The webview runs `@polaris-key/react`, and the plugin supplies only what a
webview lacks ([PARITY §1](../../PARITY.md#1-sdks-runtimes-and-shared-native-backends)).

## Goal

A Rust crate `tauri-plugin-polaris-key` (Tauri 2) and a small JavaScript binding let a Tauri desktop
app use the React SDK with:

- an OS keyring token store;
- a hashed hardware fingerprint and device id, where raw values never enter the webview;
- an Ed25519 fallback when the system webview lacks WebCrypto Ed25519;
- an updater hand-off after the update decision.

A manifest for the `tauri` runtime shows which rows the combination closes that plain `web` cannot,
and `cargo test` passes the corpus vectors the plugin implements.

## Why

- The official Tauri updater plugin is desktop-only and requires minisign signatures.
- No official keyring plugin exists, and the community one is 0.1.0 from 2024.
- The three system webviews (WKWebView, WebView2, WebKitGTK) differ, so WebCrypto Ed25519 cannot be
  assumed ([notes/E9 §0](../../notes/E9-runtime-building-blocks.md#0-headline-findings) item 5,
  [§6](../../notes/E9-runtime-building-blocks.md#6-secure-storage)).
- Without the plugin, a Tauri app is a web app: no keyring, no fingerprint and no keyless enrolment
  ([PARITY §7](../../PARITY.md#7-runtime-limits-that-become-typed-nas)).
- The research's recommendation is a plugin rather than an SDK
  ([PARITY §9](../../PARITY.md#9-new-sdks-order-and-shape) item 5; README decision 22).

## Read first

- `AGENTS.md`, `CLAUDE.md` (a `shared-jws` or `client-core` change is plan-mode).
- [PARITY §1](../../PARITY.md#1-sdks-runtimes-and-shared-native-backends), §2.2, §3, §7, §9.
- notes/E9:
  - [§9](../../notes/E9-runtime-building-blocks.md#9-minimal-native-footprint-per-runtime) (the T
    row: "Do not port the wire core to Rust");
  - the T column of [§10](../../notes/E9-runtime-building-blocks.md#10-runtime--feature-matrix);
  - [§13](../../notes/E9-runtime-building-blocks.md#13-spikes-and-open-questions) item 1 (WebKitGTK
    Ed25519).
- The [P3-05](P3-05-v4-react.md) brief (the v4 `client-core` and React surface this plugs into), and
  the [P1b-09](P1b-09-fingerprint-storage-fixes.md) brief (fingerprint rules and `Store.status()`).
- `packages/sdk-react/src/core/store.ts`, `src/core/adapter.ts`, `src/desktop/desktopAdapter.ts` (the
  existing "privileged host" pattern), `packages/client-core/src/verify.ts`, and
  `packages/shared-jws/src/index.ts:359`, where `verifyJws` calls `crypto.subtle.verify` today.
- `packages/sdk-node/src/devices/fingerprint.ts` and `deviceId.ts` (the reads and formulas the Rust
  side ports); `conformance/corpus/v2/fingerprint.json`.

## Scope

**In:**

- `sdks/tauri/` with:
  - `crates/tauri-plugin-polaris-key/`: Rust commands `token_get`, `token_set`, `token_clear`
    (through the `keyring` crate 4.x), `device_id`, `fingerprint`, `verify_ed25519` (through
    `ed25519-dalek` 3.x), and `platform_info` (canonical platform and arch per `headers.json`);
  - `packages/tauri/`: the `@polaris-key/tauri` guest binding, exposing a React-SDK store and a
    host adapter over those commands, following the desktop adapter's pattern;
  - `parity.json` for runtime `tauri`.
- Desktop only (macOS, Windows, Linux). A CI job running `cargo test` on ubuntu, with Windows and
  macOS if the runners allow it.
- **Update hand-off, Depth A.** Run the update decision in the webview, then open the download or
  store link (notes/E9 §2.3).
- A docs page `build/sdks/tauri.mdx`.

**Out** (and where it belongs instead):

- Porting the wire core to Rust. Verification stays in the webview's `client-core`.
- Tauri mobile (notes/E9 §9: defer), and background transfer.
- Handing off to `tauri-plugin-updater` (Depth B or C). It needs a Worker renderer for Tauri's dynamic
  JSON feed, signed with its own minisign key (notes/E9 §2.2). No work package owns that renderer;
  [P3-09](P3-09-updater-feeds.md) lists Sparkle, WinSparkle, Velopack, `.appinstaller` and zsync. The
  lead should assign it.
- Outlet detection and pack transports in Rust (after [P3-11](P3-11-outlet-detection.md) and
  [P4-06](P4-06-client-core-packs.md); add rows to this manifest then).

## Design notes

**What stays in the webview.** Documents, trust, clock, gate, config, the update decision and packs
are `client-core`, unchanged. The plugin never sees a signed document except to verify a signature
when asked.

**The token store.**

- Keep only the device token (and later one wrapping key) in the keyring. The verified cache stays a
  file under the app's data directory (`app_local_data_dir()`), written by Rust, so webview storage
  loss cannot wipe it (notes/E9 §6, the design consequence).
- Report `Store.status()` from P1b-09, including `degraded` when the keyring errors, for example on
  headless Linux without a Secret Service.

**The fingerprint** is computed in Rust with the same reads and fallbacks as Node after P1b-09 (CIM on
Windows, `machine-id` on Linux, IOKit or `ioreg` on macOS). The hashing formula is pinned by
`fingerprint.json`, so `cargo test` runs its vectors and derivation sections. Only hashes cross into
the webview (AGENTS rule 7).

**Ed25519 fallback.**

- `shared-jws`'s `verifyJws` calls WebCrypto directly (`index.ts:359`), and `client-core` verifies
  through it. To use `verify_ed25519`, the frozen verifier needs an injectable Ed25519 primitive. If
  P3-05 has not added one, adding it touches `shared-jws` and `client-core`: write a short plan first
  (`CLAUDE.md`), and keep the 13-step verification order byte for byte.
- A pure-JS fallback (`@noble/ed25519`, notes/E9 §10 footnote 14) would serve plain browsers as well;
  the plan should compare the two.
- Test the fallback against every `jwsCases` vector in `cargo test`.

**Manifest.** Use a separate `sdks/tauri/parity.json` with runtime `tauri`, not a new runtime inside
React's manifest. It inherits React's implemented rows by testing them through the plugin-backed
adapter. It turns `core.store`, `devices.fingerprint`, `devices.facts` and `license.enroll` from web
N/As into `implemented`.

## Steps

1. Scaffold the crate and binding; add the manifest (everything `planned`) and the CI job.
2. Token store and `Store.status()`; device id and fingerprint with corpus tests.
3. Ed25519 fallback, with the plan step if `client-core` needs a seam.
4. The host adapter over the React SDK; Depth A update hand-off; docs page.
5. Move the manifest rows; run `parity:check` and the green gate.

## Acceptance criteria

- [ ] `cargo test` passes the `fingerprint.json` vectors, the `headers.json` rows for Rust's
      `std::env::consts` inputs, and every `jwsCases` vector through `verify_ed25519`.
- [ ] A Tauri example app (under `sdks/tauri/examples/`) activates, syncs and survives a restart with
      the token in the OS keyring on at least one desktop OS in CI.
- [ ] `sdks/tauri/parity.json` validates; `core.store`, `devices.fingerprint` and `license.enroll` are
      `implemented` for `tauri`; `pnpm parity:check` passes.
- [ ] No raw hardware value is returned by any command (a test asserts the command outputs are
      hashes).
- [ ] The green gate passes (`AGENTS.md`), plus the CI `tauri` job.

## Verify

```sh
( cd sdks/tauri && cargo test )
mise exec node@22 -- pnpm --filter @polaris-key/tauri test
mise exec node@22 -- pnpm parity:check
```

## Hand-off

- **Interfaces:** the command names above; `@polaris-key/tauri`'s store and adapter; the `tauri`
  runtime id in the registry.
- The Tauri feed renderer and updater Depth B or C need an owner beside P3-09. Tauri mobile would
  reuse the Apple plugin package and the Kotlin AAR ([P5-05](P5-05-apple-plugin-package.md),
  [P5-06](P5-06-kotlin-aar.md)).
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set X-02 done`.

# Every feature in every SDK: parity across languages and runtimes

**Extends:** [README §8](README.md#8-carrying-the-concepts-to-the-other-sdks-and-products) and
[`CONTENT.md`](CONTENT.md) §13.
**Evidence:** `notes/A2` (the current SDK surface, per capability), `notes/E9` (what every runtime
can do natively), `notes/A7` (content operations run in six runtimes against shared vectors).
**Status:** research proposal, 2026-09-30; the registry, manifests, corpus and gate (§3–§4) have
since shipped. §5 was reconciled on 2026-10-04 by the SDK parity pass
([`notes/SDK-PARITY-PASS.md`](notes/SDK-PARITY-PASS.md)), which also holds the current gap plan.

---

## 0. Summary

**The rule.** Every Polaris Key feature is available in every SDK. Where a runtime genuinely
cannot do something, the SDK says so with a **typed "unsupported here" result** naming the
feature and the reason. A missing method, a silent no-op or a quiet fallback is a bug.

**Why it needs machinery.** Today four SDKs (Node, React, Python, Swift) agree byte for byte on
the wire because of one corpus, but their _feature_ surfaces have drifted (§4):

- edge-mint exists nowhere;
- re-register-on-401 exists nowhere;
- device-code sign-in exists only in React;
- `entitledChannels` and the catalog fetch exist only in Swift;
- Swift has no release client, and React cannot import an offline bundle.

Godot, packs, the update decision and distribution add more than forty capabilities, and later
SDKs (Kotlin, C#) multiply them. Without a checked inventory the gaps compound.

**Three mechanisms keep parity true:**

1. **A feature registry with stable ids** (`license.channels`, `packs.apply.delta`, …) and a
   **parity manifest per SDK**. CI fails when an SDK neither implements a feature (with a test
   that names the id) nor declares an allowed typed N/A (§3).
2. **Behaviour as data.** Every pure function becomes a generated corpus file that every SDK runs:
   the gate, the update decision, the install planner, content apply, outlet detection, config
   resolution and boot stages. Flows that talk to the server are pinned by recorded **HTTP
   transcripts** that every SDK replays (§4).
3. **Generated constants.** Error codes, header names and values, platform and arch enums,
   feature ids and protocol versions are emitted per language from one source, like the corpus
   and the catalog mirrors are today (§4.4).

**Evidence that this is achievable:**

- notes/A7 ran chunk-index parsing, full/file/chunk/delta apply, path rules and the install
  planner in Python, Node, Chromium, the JVM, .NET and GDScript. All six gave identical verdicts
  on 75 cases, and identical output bytes.
- The JavaScript core ran unchanged in Node and Chromium, with only SHA-256, zstd and `fetch`
  injected.
- notes/E9 shows that native code is needed only at platform edges (keyrings, Apple and Android
  store APIs, Steamworks), never in the core.

**Cost.** About 8–12 engineer-weeks of parity infrastructure and gap-closing (README P1b), in
parallel with the Godot SDK. Everything after that is already priced into the phases that add
the features, because "done" means "done in every SDK".

---

## 1. SDKs, runtimes and shared native backends

| SDK                    | Package                                   | Runtimes                                                              | State                                     | Native backends it uses                                                               |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| **Node**               | `@polaris-key/node`                       | Node servers and CLIs (incl. single-executable builds), Electron main | exists                                    | keyring addon (optional), Steamworks and WinRT bindings where used                    |
| **React / web**        | `@polaris-key/react` over `client-core`   | browsers, Electron renderer, Tauri webview                            | exists                                    | none; WASM zstd                                                                       |
| **Python**             | `polaris-key` (PyPI, CPython ≥ 3.9)       | desktop tools, servers, ML tooling                                    | exists                                    | `keyring`, `cryptography`; `zstandard` below 3.14                                     |
| **Swift**              | SwiftPM, `PolarisKey*` targets            | macOS, iOS and iPadOS                                                 | exists                                    | Sparkle; libzstd; the **Apple plugin package** others reuse                           |
| **Godot**              | `addons/polaris_key` (GDScript)           | every Godot export target                                             | README P1                                 | optional: the Apple plugin package, the Kotlin AAR, GodotSteam                        |
| **Kotlin**             | AAR + JVM artifact                        | Android apps, JVM desktop                                             | P6 (build now, owner decision 2026-10-04) | zstd-jni; is itself the **Android backend** for Godot, Unity and MAUI                 |
| **C# / .NET**          | NuGet, `netstandard2.0` + `net8.0`        | .NET desktop, MAUI, Unity, Godot C#                                   | proposed (later)                          | BouncyCastle or NSec (no Ed25519 in the BCL); `ZstdSharp.Port` below .NET 11          |
| **Tauri** (an adapter) | a first-party Rust plugin + the React SDK | Tauri 2 desktop and mobile                                            | proposed (later)                          | the Rust plugin for keyring, fingerprint and updater hand-off; React SDK for the rest |

- **Build the platform edges once.** Two native packages are shared backends, not per-SDK work:
  - an **Apple plugin package** (Swift): `AppDistributor`, `AppTransaction`, Background Assets
    client, StoreKit 2 and Keychain, exposed through a C/ObjC-callable surface;
  - a **Kotlin AAR**: install-source APIs, In-App Updates, Play Asset Delivery, PackageInstaller,
    Keystore and background transfer.

  Godot, Unity, MAUI and Tauri mobile bind these instead of writing their own (notes/E9 §11).

- **Tauri is not a new SDK.** The webview runs the React SDK. A first-party Rust plugin supplies
  what a webview lacks (OS keyring, hardware fingerprint, updater hand-off, and Ed25519 where the
  system webview has no WebCrypto Ed25519). No official keyring plugin exists, and the community
  one is 0.1.0 (notes/E9).
- **Electron is Node plus React.** The main process runs the Node SDK (`safeStorage` as its token
  store, `autoUpdater` or Velopack as its driver); renderers run the React SDK through the
  existing desktop bridge.

---

## 2. What parity means

### 2.1 The contract

- **Same capability, idiomatic surface.** Names are identical up to casing: `camelCase` in
  TypeScript, Swift, Kotlin and C#, `snake_case` in Python and GDScript. The mapping is
  generated (§4.4), not remembered.
  - **Accepted exception (lead, P3-07):** Swift's signed-feed call is `UpdateClient.channelFeed(channel:)`, not
    `feed(channel:)`, because `feed(channel:arch:entitlements:)` is the Sparkle appcast helper that must keep its
    behaviour. Node, Python and Godot keep `feed`.
  - **Accepted shapes (P1b-10):** `supports()` answers in each language's idiom. Swift returns
    `enum Support { case supported(feature:); case unsupported(Unsupported) }`. Godot returns a
    `PKeyResult` (ok, or code `unsupported` with `detail = {feature, reason, detail}`). Swift's
    `service-unavailable` refusal stays a `PolarisError`, with the same fields in
    `PolarisError.unsupported`.
  - **Accepted shape (P4-07):** Swift's `PackError` is a separate `Error` struct (code, message,
    detail, path, packId), not a `PolarisError`, because a Swift struct cannot subclass one. Its
    `code` is a registry code like every other error's. `update.packs` calls can throw either:
    `PackError` for the pack pipeline and `PolarisError` for `service-unavailable` or
    `local-only`, so Swift callers catch both. Node, Python and Godot raise one error type.
  - **Accepted shape (P4-08):** GDScript has no exceptions, so every `PolarisKey.update.packs` call
    that can fail returns a `PKeyResult` (`ok`, or the registry `code` with `detail = {packId,
path?, step?}`), `estimate` and `mount` return Dictionaries, and the pipeline's progress is the
    `pack_progress`, `set_changed`, `pack_ready` and `pack_failed` signals.
- **Same verdicts.** Wherever a feature has a corpus file, every SDK reproduces its expected
  outcomes and output bytes.
- **Same requests.** Wherever a feature talks to the Worker, every SDK produces the same
  requests (method, path, required headers, body shape) and handles the same responses, as pinned
  by the transcripts.
- **Same failures.** Errors carry a code from the shared registry. A Python `PolarisKeyError`
  and a GDScript error result with the same code mean the same thing.

### 2.2 Typed "unsupported here"

Each SDK exposes one query and one result type:

```text
client.supports(featureId) → Supported | Unsupported{feature, reason, detail}
reason ∈ runtime      the runtime cannot do it at all       (web: no hardware ids, no keyring)
         outlet       the outlet forbids it                  (App Store: no downloaded scripts)
         product      the product disabled the service       (Update off)
         dependency   an optional dependency is missing      (Python 3.12 without zstandard)
         version      the runtime is too old                 (Node < 22.19 without the WASM decoder)
```

- Calling an unsupported feature returns or throws `Unsupported` with the same fields; it never
  hangs, never no-ops and never silently substitutes another path.
- **Allowed `runtime` N/As are declared in the registry**, per feature and runtime, with the reason
  (e.g. `devices.fingerprint` on web). An SDK cannot invent a new one: CI rejects any N/A the
  registry does not allow.
- `outlet`, `product` and `dependency` N/As are decided at runtime. The same code runs everywhere.
- The SDK reports its **capabilities** (`core.caps`) in device telemetry, so the console can show
  what the fleet can actually do (e.g. which share of web devices can apply deltas natively).

### 2.3 Concurrency models, per language

| SDK    | Async calls                   | Progress and change events             |
| ------ | ----------------------------- | -------------------------------------- |
| Node   | `Promise`                     | `EventEmitter` / callbacks             |
| React  | `Promise` + hooks             | reactive state                         |
| Python | sync API + `asyncio` variants | callbacks                              |
| Swift  | `async throws`                | `AsyncStream`, `@Observable` in the UI |
| Godot  | coroutines returning results  | signals                                |
| Kotlin | `suspend`                     | `Flow`                                 |
| C#     | `Task`                        | events, `IObservable` in the UI layers |

The transcripts assert request order only where the protocol requires it, so each language keeps
its natural concurrency.

---

## 3. The feature registry and parity manifests

### 3.1 Files

- **`conformance/parity/features.json`** (hand-written, schema-validated): every feature id, with
  its title, the service that owns it, **how it is proven** (a corpus file, a transcript set, a
  unit test or a device test), and the allowed `runtime` N/As with reasons.
- **`sdks/<sdk>/parity.json`** (or `packages/sdk-*/parity.json`): per feature, `implemented`,
  `na` or `planned`, with the phase for `planned`.
- **Test tags.** Tests declare what they prove with one comment convention in every language,
  e.g. `// @pkey-feature license.reregister` (`#` in Python and GDScript).

### 3.2 The gate: `pnpm parity:check`

It fails when:

- a feature has no entry in some SDK's manifest;
- an `implemented` feature has no tagged test in that SDK, or its proof is a corpus file the SDK's
  runner does not load;
- an `na` is not allowed for that runtime in the registry;
- a `planned` feature's phase has shipped (the manifest must be updated when the phase closes);
- a tagged test names an unknown feature id.

It also renders the **parity matrix docs page** from the manifests. That page is a generated
reference page, so it gets the docs freshness gate like every other generated page (AGENTS rule
3), and `pnpm parity:check -- --check` joins the green gate beside `pnpm gen:corpus -- --check`.

### 3.3 The wave model, extended

The repo's rule is already contract → catalog → corpus → SDKs, "done when all five pass". With the
registry:

- a new feature starts with its **registry entry**, including its allowed N/As, before any code;
- "done" means every SDK's manifest says `implemented` or an allowed `na`;
- a new SDK starts with a manifest in which everything is `planned`. The gate then shows exactly
  how far it is from parity, and that list is its backlog.

---

## 4. How behaviour is pinned

### 4.1 Corpora: behaviour as data

| Corpus file                       | Pins                                                                                                 | Exists?              | Added in       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- | -------------- |
| `cases.json`                      | JWS, documents, trust manifests, clock floor, offline bundles                                        | ✓ (v2)               | —              |
| `gate-matrix.json`                | the licence gate                                                                                     | ✓                    | —              |
| `fingerprint.json`                | fingerprint components and device-id derivation                                                      | ✓                    | —              |
| `headers.json`                    | platform, arch and SDK header values per runtime spelling (fixes README §9.1 #17)                    | new                  | P1b            |
| `config-matrix.json`              | config precedence: enforced, default, local override, environment, hidden                            | new                  | P1b            |
| `feedCases`, `releaseRecordCases` | `pkey-feed+jws` and `pkey-release+jws` (app, pack and revocation kinds, delegation)                  | new, in `cases.json` | P3 (wire v4)   |
| `update-matrix.json`              | the update decision: floors, rollout bucket, outlet capabilities, `blocked(...)`, pre-staging        | new                  | P3             |
| `outlet-matrix.json`              | outlet detection: a set of observed signals → outlet id and confidence                               | new                  | P3             |
| `stage-matrix.json`               | the boot stage machine (shell → guard → sync → gate → decide → fetch → mount → ready) and its events | new                  | P1 (UI kit v1) |
| content corpus (`content/`)       | chunk-index parsing, full/file/chunk/delta apply with negatives, path rules (notes/A7 §2)            | new                  | P4 v1–v2       |
| `plan-matrix.json`                | the install planner (notes/A7 §4; 23 rows to start)                                                  | new                  | P4 v1          |

Rules, as today:

- **One generator.** `tools/sign-corpus.ts` (or a sibling for the content corpus) emits every file;
  `--check` regenerates in memory and fails on any difference.
- **Generator-owned mirrors** where a test target cannot reach the monorepo: Swift's test
  resources today, and Godot's `res://` tests next.
- **The two corpora join by hash.** Pack release records live in the signed corpus and pin the
  SHA-256s of the content vectors, so no signing key enters the content corpus (notes/A7 §11.5).
- **Budget.** The content corpus stays under 5 MB. The 37 MB companion set belongs in performance
  jobs, not the corpus.

### 4.2 HTTP transcripts: flows the corpus cannot express

Registration, activation and sign-in are conversations, not pure functions. They are pinned as
**transcripts**: ordered request expectations and canned responses.

- **Source of truth: the Worker's own tests.** A capture mode records the request/response pairs
  the Worker test-suite already exercises, normalised (ids, timestamps and signatures replaced by
  corpus-signed values), into `conformance/transcripts/*.json`. They are generated and
  drift-checked like the corpus, never hand-written.
- **Replay in every SDK** against a tiny fake server that serves the canned responses and asserts
  each request: method, path, required headers, body shape, and no unexpected calls.
- **First transcript set:**
  - discovery and capabilities (fail-closed on errors);
  - sync with `ETag`/`304`, `429`/`503` backoff and `Retry-After`;
  - activate, enrol, deactivate (remote best-effort, local wipe mandatory);
  - keyless register, then **re-register on 401** for a licence-less device;
  - device-code sign-in with `authorization_pending`, `slow_down` and expiry (RFC 8628);
  - edge-mint;
  - telemetry with allowlisted keys only;
  - later: feed fetch with `seq` rollback refusal, release-record fetch by hash, chunk-bundle
    `Range` with `If-Range`, and the `dcz` negotiation.

### 4.3 Runners

| SDK         | Runner                                                   | Notes                                                                                          |
| ----------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Node        | `conformance/runners/node` (Vitest)                      | also run on the **minimum supported Node**, which is how notes/A7's Node 22.18 zstd trap shows |
| React / web | a new **Chromium job** (Playwright, `client-core`)       | WebCrypto, WASM zstd, OPFS, `dcz`                                                              |
| Python      | pytest, per corpus file                                  | on the lowest and highest supported CPython (3.9 and 3.14 differ in zstd)                      |
| Swift       | `swift test` over the resource mirror                    | macOS runner; iOS simulator for the Apple plugin package                                       |
| Godot       | headless runner on the **editor and a release template** | the template matters: 4.6+ templates ignore `--script`, and `GDDL` is engine-internal          |
| Kotlin, C#  | Gradle / `dotnet test` over mirrors                      | when those SDKs exist                                                                          |
| Worker      | the fingerprint slice today; the transcript capture      | the Worker is a signer, not a verifier, as today                                               |

Every runner reports its library and runtime versions in the test output, so a failure in one
configuration is attributable (notes/A7 found three decoder behaviours that depend on version).

### 4.4 Generated constants

A new `tools/gen-sdk-constants.ts` (beside `gen-mirrors.ts`) emits, per language:

- the **error-code registry** (licence, config, devices, identity, update, `chunks.*`, `files.*`,
  `delta.*`, `plan.*`);
- **header names and canonical values** (`X-PKey-Platform: windows`, not `win32`);
- **enums**: platforms, arches, outlets, transports, pack types, patch strategies, bindings,
  service slugs (fed by the data-driven service table, README §3.2);
- **feature ids** and the `supports()` reason enum;
- **protocol and corpus versions**.

`gen-mirrors.ts` gains GDScript, Kotlin and C# emitters for typed catalog mirrors. Both
generators run with `--check` in the green gate.

---

## 5. The feature inventory

**Reconciled 2026-10-04** by the SDK parity pass
([`notes/SDK-PARITY-PASS.md`](notes/SDK-PARITY-PASS.md)). Six audits graded each cell against
what the server **ships today**, with evidence paths. That note also holds the per-SDK task
lists (`SP-*`), the shared spec for new helpers, and the items that need a wire change. The
2026-09-29 baseline from notes/A2 §9 is superseded: those gaps were closed by P1b to P6.

**Legend:**

- ✓ implemented;
- ◐ partial: works, but with a gap the footnote names;
- ✗ missing against a shipped server feature: a parity gap with a task in the pass;
- N/A typed unsupported by design, with the reason in the registry;
- ○ not built in any SDK because the server part is still planned (⚑ = needs a wire change, see
  the pass §6);
- ⊕ a proposed new id (pass §3), which needs the SP-00 registry plan before any SDK tags a test
  with it.

**Columns.**

- **React** covers both transports. "web" is the browser adapter; "bridge" is the Electron or
  Tauri renderer over the desktop bridge.
- **Kotlin** is Android unless a footnote names the JVM.
- **Godot** covers every export target.

**Kits** is graded separately in §5.9.

### 5.1 Core

| Id              | Capability                                                  | Proven by            | Node | React  | Python | Swift | Kotlin | Godot | Allowed N/A                                                     |
| --------------- | ----------------------------------------------------------- | -------------------- | ---- | ------ | ------ | ----- | ------ | ----- | --------------------------------------------------------------- |
| `core.verify`   | JWS verify, trust manifest (pinning, rotation), clock floor | `cases.json`         | ✓    | ◐ ¹    | ✓      | ✓     | ✓      | ✓     | —                                                               |
| `core.cache`    | verified cache; construct and load offline                  | transcripts + unit   | ✓    | ✗ ²    | ✓      | ✓     | ✓      | ✓     | —                                                               |
| `core.bundle`   | offline bundle import                                       | `cases.json`         | ✓    | ◐ ³    | ✓      | ✓     | ✓      | ✓     | —                                                               |
| `core.discover` | discovery and capabilities, fail-closed                     | transcripts          | ✓    | ◐ ⁴    | ✓ ⁵    | ✓     | ✓      | ✓     | —                                                               |
| `core.sync`     | sync, `ETag`/`304`, backoff, refresh loop, change events    | transcripts          | ◐ ⁶  | ◐ ⁷    | ◐ ⁶    | ◐ ⁶   | ◐ ⁶    | ✓     | —                                                               |
| `core.local`    | local-only client (no network)                              | unit                 | ✓    | ✗      | ✓      | ✓     | ✓      | ✓     | —                                                               |
| `core.headers`  | canonical platform, arch and SDK header values              | `headers.json`       | ✓    | ✓      | ◐ ⁸    | ◐ ⁹ ⚑ | ✓      | ✓     | —                                                               |
| `core.errors`   | shared error codes                                          | generated registry   | ◐ ¹⁰ | ◐ ¹⁰   | ◐ ¹⁰   | ◐ ¹⁰  | ◐ ¹⁰   | ◐ ¹⁰  | —                                                               |
| `core.caps`     | `supports()` and capability telemetry                       | unit + parity gate   | ✓    | ◐ ¹¹   | ✓      | ✓     | ✓      | ✓     | —                                                               |
| `core.store`    | secure token store, surfaced failure, no silent downgrade   | unit                 | ◐ ¹² | N/A ¹³ | ✓      | ◐ ¹⁴  | ◐ ¹⁵   | ◐ ¹⁶  | web, desktop-bridge: `runtime`; node, python, jvm: `dependency` |
| `core.copy` ⊕   | localised message for every registry code and gate status   | `copy.en.json` (new) | ✗    | ◐      | ✗      | ✗     | ◐      | ◐     | —                                                               |

1. The web session document (`/identity/session`) is unsigned legacy JSON, so it is trusted from
   TLS. Bearer mode (pass §3.17) reads the signed documents.
2. Web only. An offline reload loses the licence. On the bridge, the Node host holds the cache.
3. `<PolarisKeyProvider>` cannot pass `trust`, so a browser `importBundle` always refuses unless
   the developer injects a hand-built adapter.
4. The parsed discovery document is private to the adapter, and the URL builders use hard-coded
   aliases.
5. Services must be declared by hand, or `discover()` called explicitly. There is no
   `auto_discover`.
6. Change events cover the licence state only (Swift: one replaceable callback), with no config,
   update or packs events. The refresh loop is off by default and is not lifecycle-aware.
7. No `If-None-Match` and no backoff on the web, and no refresh on focus or `online`.
8. Pyodide (`Emscripten`) maps to no platform.
9. tvOS, visionOS and watchOS send no `X-PKey-Platform`. New canonical values are a wire change
   (pass W8).
10. The codes are mirrored everywhere. Node, Python, Swift and Kotlin collapse every activation
    403 other than `fingerprint_required` into "device limit" or a raw body, which is a bug
    (pass §3.1). Godot maps unknown 403s to a generic error with no code copy.
11. A browser never sends its capability telemetry (no bearer).
12. No Electron `safeStorage` store.
13. A design choice, not a runtime limit: Godot web holds a bearer token in IndexedDB. Bearer mode
    (pass §3.17, owner question Q1) would make this ✓ with surfaced degradation.
14. No keychain access-group or app-group option, and the two keychain classes disagree (Q8).
15. Android ✓. The JVM writes a 0600 file (allowed `dependency` N/A); OS keyrings are pass SP-K12.
16. iOS and Android ✓. Desktop writes a 0600 file with no Keychain, DPAPI or libsecret store, and
    no work package owns that (pass SP-G11). On the web, IndexedDB may be cleared.

### 5.2 License

| Id                     | Capability                                  | Proven by          | Node | React | Python | Swift | Kotlin | Godot | Allowed N/A                    |
| ---------------------- | ------------------------------------------- | ------------------ | ---- | ----- | ------ | ----- | ------ | ----- | ------------------------------ |
| `license.gate`         | gate evaluation, every status               | `gate-matrix.json` | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                              |
| `license.activate`     | activate with a key (+ fingerprint)         | transcripts        | ◐ ¹  | ◐ ²   | ◐ ¹    | ◐ ¹   | ◐ ¹    | ✓ ³   | —                              |
| `license.enroll`       | keyless enrolment                           | transcripts        | ✓    | N/A   | ✓      | ✓     | ◐ ¹    | ✓     | web, desktop-bridge: `runtime` |
| `license.deactivate`   | remote best-effort, local wipe mandatory    | transcripts        | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                              |
| `license.entitlements` | entitlements, profile, licence id           | unit               | ◐ ⁴  | ◐ ⁵   | ◐ ⁴    | ◐ ⁴   | ◐ ⁴    | ◐ ⁴   | —                              |
| `license.channels`     | `entitledChannels()`                        | unit               | ✓    | ✓     | ✓      | ✓     | ✓ ⁶    | ✓ ⁶   | —                              |
| `license.reregister`   | re-register on 401 for licence-less devices | transcripts        | ✓    | N/A   | ✓      | ✓     | ✓      | ✓     | web, desktop-bridge: `runtime` |
| licence document v2    | per-entry expiry, grants, 401 reasons       | —                  | ○ ⚑  | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | LX-17, LX-18, LX-19 (pass W3)  |
| key-entry refusals     | `key_entry_limit`, `license_owned`, attach  | —                  | ○ ⚑  | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | I-09, I-10a, I-10b (pass W1)   |

1. 403s collapse: `enroll_claimed`, `license_disabled` and `attestation_required` read as
   "device limit" or as a raw body. A 429 is an untyped error (pass §3.1).
2. Web: key entry works only on a page served from the Worker's own origin. Device-limit
   remediation is missing. The bridge drops `limit` and `deviceCount`.
3. An unknown 403 falls through to a generic error.
4. `isEntitled` keeps answering from the cached document after revocation or expiry (S-19 G11).
   Confirmed in Kotlin and Godot; assumed in the others until SP-00's gate-matrix row proves
   otherwise. There are no `licenseInfo()` conveniences either (pass §3.3).
5. `useEntitlement` is boolean only. Tier and non-boolean values need the deprecated
   `usePolarisKey()`.
6. Runtime channel switching is not SDK-owned: Kotlin fixes the channel at construction, and
   Godot's dev menu only emits a signal (SP-K09, SP-G08).

### 5.3 Config

| Id               | Capability                                                      | Proven by            | Node | React | Python | Swift | Kotlin | Godot | Allowed N/A                      |
| ---------------- | --------------------------------------------------------------- | -------------------- | ---- | ----- | ------ | ----- | ------ | ----- | -------------------------------- |
| `config.resolve` | precedence (enforced, default, local, environment)              | `config-matrix.json` | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                |
| `config.list`    | user-visible config, enforced rows flagged                      | `config-matrix.json` | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                                |
| `config.secret`  | `getSecret`                                                     | transcripts          | ✓    | N/A   | ✓      | ✓     | ✓      | ✓     | web, desktop-bridge: `runtime`   |
| `config.schema`  | catalog fetch (`/config/schema`)                                | transcripts          | ✓    | ✓     | ✓      | ✓ ²   | ✓ ²    | ✓     | —                                |
| `config.mint`    | edge-mint of third-party tokens                                 | transcripts          | ✓    | ✗ ³   | ✓      | ✓     | ✓      | ✓     | —                                |
| `config.mirror`  | typed catalog mirrors                                           | unit                 | ◐ ⁴  | ◐ ⁴   | ◐ ⁴    | ◐ ⁴   | ◐ ⁴    | ◐ ⁴   | —                                |
| `config.local` ⊕ | persisted local overrides, `set`/`clear`, per-key change events | unit                 | ✗    | ◐ ⁵   | ✗      | ✗     | ✗      | ◐ ⁶   | —                                |
| synced settings  | account layer, Cloud Sync settings                              | —                    | ○ ⚑  | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | U-03, U-06, U-20, U-21 (pass W6) |

1. The environment layer is empty in a browser by definition, which the matrix pins.
2. Returns raw bytes, with no decoded catalog model.
3. No verb on either transport. The bridge could forward to the Node host, and bearer mode
   (pass §3.17) enables it on the web.
4. `pkey mirror` (SP-02) runs the generator outside the monorepo; no typed accessors yet.
5. `ConfigPanel` reports `onOverride(key, string)`. Persistence and type coercion are left to the
   host.
6. `set_override_store` exists, but the default store is in memory.

### 5.4 Devices and identity

| Id                    | Capability                                    | Proven by                 | Node | React | Python | Swift | Kotlin | Godot | Allowed N/A                                 |
| --------------------- | --------------------------------------------- | ------------------------- | ---- | ----- | ------ | ----- | ------ | ----- | ------------------------------------------- |
| `devices.fingerprint` | components, hashing, device id                | `fingerprint.json`        | ✓    | N/A   | ✓      | ◐ ¹   | ✓      | ✓     | web, desktop-bridge: `runtime`              |
| `devices.facts`       | device facts and probes                       | unit                      | ✓    | N/A   | ✓      | ✓     | ✓      | ✓     | web, desktop-bridge: `runtime`              |
| `devices.register`    | keyless registration                          | transcripts               | ✓    | N/A ² | ✓      | ✓     | ✓      | ✓     | web, desktop-bridge: `runtime`              |
| `devices.manage`      | list, rename, deauthorise                     | transcripts               | ✓ ³  | ◐ ²   | ◐ ⁴    | ✓     | ✓      | ✓     | web: `runtime`                              |
| `devices.report`      | telemetry (allowlisted keys)                  | transcripts               | ◐ ⁵  | ◐ ²   | ◐ ⁵    | ◐ ⁵   | ◐ ⁵    | ✓     | web: `runtime`                              |
| `devices.attest`      | App Attest / Play Integrity trust level       | transcripts               | N/A  | N/A   | N/A    | ✗ ⁶   | ✗ ⁶    | ✓     | every non-store runtime: `runtime`/`outlet` |
| `telemetry.updates` ⊕ | update-health funnel events (P6-03)           | `telemetry-report.json`   | ✗    | ✗     | ✗      | ✗     | ✗      | ✓     | —                                           |
| `identity.oidc`       | browser sign-in                               | transcripts               | ○ ⚑  | ◐ ⁷   | ○ ⚑    | ◐ ⁸ ⚑ | ○ ⚑    | ○ ⚑   | —                                           |
| `identity.devicecode` | device-code sign-in (RFC 8628) with QR        | transcripts               | ◐ ⁹  | ◐ ¹⁰  | ◐ ⁹    | ◐ ⁹   | ✓      | ✓     | web: `runtime`                              |
| identity layer 1      | passthrough, native redirect, subject, attach | —                         | ○ ⚑  | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | I-08, I-10a/b, I-13, I-15 (pass W4, W5)     |
| `portal.links` ⊕      | portal URLs for the shipped SPA routes        | `portal-links.json` (new) | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | — (server `manageUrl`: PX-W8, pass W2 ⚑)    |

1. tvOS, visionOS and watchOS fall back to a random id with an almost empty fingerprint.
2. These web N/As and partials are design choices. The cookie-session browser adapter holds no
   bearer, while Godot web registers, manages and reports with one over CORS-covered routes. They
   are closable by bearer mode (pass §3.17, Q1). On the bridge, `devices.report` takes no payload.
3. A device stopped at `device_limit` holds no token, so it cannot free a seat. Recovery needs
   `portal.links` now and `manageUrl` later (W2). This applies in every SDK.
4. Errors collapse to SDK-local codes (`device_list_failed`, …) and drop the server's code.
5. Missing report keys: Node, Python, Swift and Kotlin send no `updates`; Python also omits
   `gate`, `outlet` and `packInstalls`; Swift omits `outlet`.
6. The platform primitives exist (`PolarisKeyPlatform/AppAttest.swift`, Kotlin
   `platform/Integrity.kt`) and Godot attests through them, but neither SDK calls the attest
   routes. macOS and the JVM are allowed N/As.
7. Same-origin only: the session cookie and the auth routes never answer CORS.
8. Only through a host-supplied closure. The gate's Sign in button is a no-op by default.
9. Node, Python and Swift do not send P1-07's `confirmIdentity` and `attachLicense` opt-in, and
   Swift drops `identity` and `attached` from the poll. None of them renders a QR.
10. On the bridge, `PolarisLogin` discards the verification URL and user code. Web device code
    for TV and kiosk browsers would need bearer mode.

Native browser sign-in (○ ⚑) waits on the native redirect token route (I-15). The deprecated,
unadvertised `/identity/auth/poll` (`W/services/identity/index.ts`) is not a completion path for
any SDK. In the meantime, "sign in with browser" is device code opened in the system browser
(pass §3.12).

### 5.5 Release and update

| Id                       | Capability                                                            | Proven by            | Node | React | Python | Swift | Kotlin | Godot | Allowed N/A                     |
| ------------------------ | --------------------------------------------------------------------- | -------------------- | ---- | ----- | ------ | ----- | ------ | ----- | ------------------------------- |
| `release.changelog`      | changelog                                                             | transcripts          | ✓    | ◐ ¹   | ✓      | ✓     | ✓      | ✓     | —                               |
| `release.download`       | download and install URLs                                             | transcripts          | ◐ ²  | ◐ ²   | ◐ ²    | ✓     | ✓      | ✓     | —                               |
| `release.fetch` ⊕        | verified download: bearer, resume, size and sha256 vs record          | transcripts (new)    | ✗    | ✗     | ✗      | ✗     | ◐ ³    | ✓     | —                               |
| `release.distribution` ⊕ | `download.json` model, `client.distribution`                          | transcript (new)     | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | —                               |
| `release.record`         | verify `pkey-release+jws` against pinned release keys                 | `releaseRecordCases` | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                               |
| `update.check`           | today's version check                                                 | transcripts          | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                               |
| `update.feed`            | verify `pkey-feed+jws`: freshness, `seq`                              | `feedCases`          | ✓    | ◐ ¹   | ✓      | ✓     | ✓      | ✓     | —                               |
| `update.feeds` ⊕         | updater feed URLs: appcast, WinSparkle, Velopack, AppInstaller, zsync | discovery transcript | ◐ ⁴  | ✗     | ◐ ⁴    | ◐ ⁴   | ✗      | ✓     | —                               |
| `update.decide`          | the update decision                                                   | `update-matrix.json` | ✓    | ◐ ⁵   | ✓      | ✓     | ✓      | ✓     | —                               |
| `update.content`         | content decision, pack floors, revocations                            | content corpus       | ✓    | ✓     | ✓      | ✓     | ✓      | ✓     | —                               |
| `update.driver`          | hand off to the native updater, or a store link                       | device tests         | ✗    | ✗     | ✗      | ◐ ⁶   | ✓ ⁷    | ◐ ⁸   | iOS: `outlet`; jvm: `runtime` ⁷ |
| `update.bootguard`       | confirm a boot, roll back after N failures                            | `stage-matrix.json`  | ✗    | ✗     | ✗      | ✗     | ✓ ⁹    | ✓     | —                               |
| `outlet.detect`          | outlet detection                                                      | `outlet-matrix.json` | ◐ ¹⁰ | ✓     | ✓      | ✓     | ✓      | ◐ ¹⁰  | —                               |
| `crash.tags` ⊕           | Sentry release, environment and outlet tags for auto-halt             | unit                 | ✗    | ✗     | ✗      | ✗     | ✗      | ✗     | —                               |

1. On the web, entitled or licensed changelogs and feeds are refused because there is no bearer
   (pass §3.17).
2. The builders use the legacy `release/dl` and `release/install.sh` aliases instead of the
   discovery `distribution.endpoints`.
3. Android only (`OkHttpBuildDownload` inside the direct driver). There is no JVM helper.
4. `appcastUrl()` (Sparkle) only.
5. Through the Provider, `decideUpdate` always throws `not-configured`: there is no `update` or
   `trust` prop.
6. Sparkle on macOS needs many manual steps, and nothing hands off to a store on iOS.
7. Android Play and direct drivers. The JVM N/A is questioned by pass SP-K12 and Q3, because the
   server publishes desktop updater feeds.
8. The native bridges are not distributed prebuilt (Q5), so they fall back to the download link.
   The Velopack route under licensed delivery is a wire item (W9).
9. No default `UpdateSlots` on the JVM, and `bootHost()` does not wire it.
10. Node does not read the Windows `SignatureKind` and does not autoload the build stamp. Godot's
    Windows MSIX reader is a stub, and macOS has no `AppTransaction`.

### 5.6 Packs

| Id                                                   | Capability                                          | Proven by                  | Node | React | Python | Swift | Kotlin | Godot | Allowed N/A                                                  |
| ---------------------------------------------------- | --------------------------------------------------- | -------------------------- | ---- | ----- | ------ | ----- | ------ | ----- | ------------------------------------------------------------ |
| `packs.record`, `revoke`, `delegation`, `delta.feed` | signed records, revocation, delegation, feed deltas | content corpus             | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.plan`                                         | the install planner                                 | `plan-matrix.json`         | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.index.files`, `.chunks`                       | chunk and files index parsing, path rules           | content corpus             | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.apply.full`, `.file`, `.chunk`                | full, file and chunk apply                          | content corpus             | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.apply.delta`                                  | raw-prefix delta                                    | content corpus             | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ◐ ²   | `dependency` or `version` only, never `runtime`              |
| `packs.state`, `handlers`, `provides`                | state, journal, switch, handlers, `isAvailable`     | `stage-matrix.json` + unit | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.type.l10n.table`, `data.json`                 | built-in handlers                                   | unit                       | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | ✓     | —                                                            |
| `packs.type.ml.model`                                | model handler                                       | unit                       | ✓    | ✓ ¹   | ✓      | ✓     | ✓      | N/A   | Godot: `runtime`                                             |
| `packs.type.godot.zip`, `audio.bank`                 | engine-only handlers                                | unit                       | N/A  | N/A   | N/A    | N/A   | N/A    | ✓     | every non-Godot runtime: `runtime`                           |
| `packs.transport.apple`                              | Apple Background Assets                             | device tests               | N/A  | N/A   | N/A    | ◐ ³   | N/A    | ✓     | everything except Swift and Godot-iOS (and later Unity/MAUI) |
| `packs.transport.play`                               | Play Asset Delivery                                 | device tests               | N/A  | N/A   | N/A    | N/A   | ✓      | ✓     | everything except Kotlin and Godot-Android                   |
| `packs.transport.steam`                              | Steam depots                                        | device tests               | ✗    | N/A   | ✗      | ✗ ⁴   | ✗ ⁴    | ✓     | web, desktop-bridge, iOS, Android                            |
| `packs.transport.msix`                               | MSIX optional packages                              | device tests               | ✗    | N/A   | ✗      | N/A   | N/A    | ✗     | non-Windows; unpackaged apps; jvm                            |
| `packs.transport.flatpak`                            | Flatpak extensions                                  | device tests               | ✗    | N/A   | ✗      | N/A   | N/A    | ✗     | non-Linux; jvm                                               |

1. On the web, through `createBrowserPacks`, which is wired by hand. On the bridge there is no
   packs surface at all; that is bridge v4 (pass SP-R07).
2. Engines 4.4 and 4.5 never plan a delta (an allowed `version` N/A).
3. `AssetPacks.swift` exists, but there is no `PackObjectTransport` adapter (SP-S08).
4. macOS Steam builds and JVM desktop. No work package owns either yet.

### 5.7 UI and commerce

| Id                 | Capability                                                                         | Proven by             | Node  | React | Python | Swift | Kotlin | Godot | Allowed N/A                            |
| ------------------ | ---------------------------------------------------------------------------------- | --------------------- | ----- | ----- | ------ | ----- | ------ | ----- | -------------------------------------- |
| `ui.stages`        | the boot stage machine: states, events, outcomes (in `client-core` and its ports)  | `stage-matrix.json`   | ◐ ¹   | ◐ ¹   | ✓      | ✓     | ✓      | ✓     | —                                      |
| `ui.boot` ⊕        | one-call boot driver over `ui.stages` (`client.boot()`, `ensureActivated()`)       | transcript (new)      | ✗     | ✗     | ✗      | ✗     | ◐ ²    | ✓     | —                                      |
| `ui.kit`           | gate, activation, sign-in with QR, settings, devices, update banner, pack progress | snapshot tests        | N/A ³ | ◐     | N/A ³  | ◐     | ◐ ⁴    | ◐     | headless SDKs: `runtime` ³             |
| `commerce.receipt` | store purchase → licence entitlement                                               | `commerce-claim.json` | ✗     | ✗     | ✗ ⁵    | ✗     | ✗      | ✓ ⁶   | —                                      |
| commerce v2        | AppTransaction, subscriptions, restore `transferred`, redeem codes                 | —                     | ○ ⚑   | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | LX-11, LX-20, LX-23, LX-25 (pass W7)   |
| Cloud Sync         | saves, collections, live pokes                                                     | —                     | ○ ⚑   | ○ ⚑   | ○ ⚑    | ○ ⚑   | ○ ⚑    | ○ ⚑   | U-09, U-10, U-13, U-14, U-22 (pass W6) |

1. The stage machine lives only in `client-core`; `@polaris-key/node` and `@polaris-key/react`
   neither re-export nor drive it. Manifest corrected to planned (SP-01); export and drive in
   SP-N05/SP-R06.
2. `bootHost()` leaves `fetch` as a no-op and `guard` always `ok`.
3. Pass SP-00 proposes replacing the `headless` N/A with a CLI kit (`ui.cli`) for Node and
   Python. Python's optional Tk kit is owner question Q2.
4. Android Compose only. There is nothing on the JVM; the manifest note says so (SP-01), and a
   `jvm` except waits on a registry `allowedNa` (SP-00). The desktop kit is SP-K12.
5. LX-20 plans a Python `allowedNa`. Pass Q7 recommends reversing it.
6. There is no `purchase()`/`restore()` one-call, no Play Billing or `claim_play()` helper, and
   no StoreKit on macOS.

**Electron and Tauri** are hosts, not SDKs (§1). Neither is served yet:

- **Electron** has no main-process bridge host (`exposePolarisBridge`), no preload and no
  `safeStorage` store (pass SP-N10, SP-N11).
- **Tauri** has no Rust plugin (X-02). Until bearer mode, browser mode cannot authenticate from a
  `tauri://` origin.

### 5.8 Service coverage at a glance

Every shipped service, against how far each SDK reaches it. ✓ means every shipped route of the
service has a client call; ◐ means some are missing (named).

| Service                   | Node                     | React                            | Python                   | Swift                    | Kotlin            | Godot   |
| ------------------------- | ------------------------ | -------------------------------- | ------------------------ | ------------------------ | ----------------- | ------- |
| Core                      | ✓                        | ◐ web: devices, report           | ✓                        | ◐ attest                 | ◐ attest          | ✓       |
| License                   | ✓                        | ✓                                | ✓                        | ✓                        | ✓                 | ✓       |
| Config                    | ✓                        | ◐ mint                           | ✓                        | ✓                        | ✓                 | ✓       |
| Identity                  | ◐ attach opt-in          | ◐ same-origin; no device code UI | ◐ attach opt-in          | ◐ attach, identity       | ✓                 | ✓       |
| Release                   | ✓                        | ◐ entitled on web                | ✓                        | ✓                        | ✓                 | ✓       |
| Update                    | ◐ feed URLs              | ◐ feed URLs                      | ◐ feed URLs              | ◐ feed URLs              | ◐ feed URLs       | ✓       |
| Distribution              | ◐ model, commerce, fetch | ◐ model, commerce, fetch         | ◐ model, commerce, fetch | ◐ model, commerce, fetch | ◐ model, commerce | ◐ model |
| Update health (telemetry) | ✗                        | ✗                                | ✗                        | ✗                        | ✗                 | ✓       |

### 5.9 UI kits and components

The component names and required states are in pass §3.18. The kits are:

- **React:** `@polaris-key/react`, for the web and the Electron or Tauri renderer.
- **SwiftUI:** `PolarisKeyUI`.
- **Compose:** Kotlin `:ui`, Android only today.
- **Godot:** the `ui/` scenes.
- **Node CLI:** `@polaris-key/node/cli`.
- **Python CLI:** `polaris_key.cli`. An optional Tk kit is proposed (Q2).

| Component                                             | React   | SwiftUI | Compose | Godot   | Node CLI     | Python CLI   |
| ----------------------------------------------------- | ------- | ------- | ------- | ------- | ------------ | ------------ |
| Boot shell                                            | ✗       | ✗       | ◐ ¹     | ✓       | ✗            | ✗            |
| Gate (+ grace banner)                                 | ✓       | ✓       | ✓       | ✓       | ◐ status     | ◐ status     |
| Activation (typed refusals, device-limit remediation) | ◐ ²     | ◐ ²     | ◐ ²     | ✓       | ◐ ²          | ◐ ²          |
| Continue free (enrol)                                 | N/A web | ✗       | ✗       | ✓       | ✓            | ✓            |
| Sign-in: device code with QR                          | ✗ ³     | ✗       | ✓       | ✓       | ✗            | ✗            |
| Offline activation                                    | ✗       | ✗       | ✗       | ✓       | ◐ ⁴          | ◐ ⁴          |
| Settings (typed, persisted)                           | ◐ ⁵     | ✗       | ◐ ⁵     | ◐ ⁵     | ◐ get        | ◐ get        |
| Devices                                               | ◐ ⁶     | ✗       | ✓       | ✗       | ✗            | ✗            |
| Account / sign out                                    | ◐ ⁷     | ✗       | ◐ ⁷     | ✗       | ✓ deactivate | ✓ deactivate |
| Entitled gate / badge                                 | ✗       | ✗       | ✓ badge | ◐ badge | ✗            | ✗            |
| Update prompt (notes, progress, install)              | ◐ ⁸     | ✗       | ◐ ⁸     | ◐ ⁸     | ✗            | ✗            |
| What's new                                            | ✗       | ✗       | ✗       | ✗       | ✗            | ✗            |
| Pack progress (runtime)                               | ✗       | ✗       | ✓       | ◐ ⁹     | ✗            | ✗            |
| Channel picker / dev menu                             | ✗       | ✗       | ✗       | ◐ ¹⁰    | ✗            | ✗            |
| Purchase / restore                                    | ✗       | ✗       | ✗       | ✗       | N/A          | N/A          |
| Download button / "also on"                           | ✗       | ✗       | ✗       | ✗       | N/A          | N/A          |
| Status banner                                         | ◐       | ✗       | ✓       | ✓       | N/A          | N/A          |
| Localised copy (beyond English)                       | ✗       | ✗       | ◐ ¹¹    | ◐ ¹¹    | ✗            | ✗            |
| Theming, brand opt-in                                 | ✓       | ✓       | ✓       | ✓       | N/A          | N/A          |

1. `bootHost()` defaults are incomplete (§5.7 note 2).
2. No refusal codes reach the UI, and no "Manage devices" link (`portal.links`). The CLI copy
   covers about 8 codes.
3. The bridge returns a code, but `PolarisLogin` discards it.
4. `import-bundle` exists. There is no `offline-request` verb.
5. React: raw string inputs, no persistence. Compose: read-only. Godot: complete, but in memory
   unless the game sets a store.
6. Desktop bridge only. On the web it points to the portal without a link.
7. React has `PolarisLogout` but no account card. Compose signs out only through the devices row.
8. React: the default action `window.open()`s a link. Compose: `onUpdate` is unwired. Godot: no
   release notes or progress.
9. Boot only.
10. The dev menu exists, but the channel is not persisted.
11. Compose: French is a debug-only fixture. Godot: `tr()` hooks with English only.

**Missing kits:**

- a Compose Desktop target (Q3);
- a Tk kit for Python (Q2);
- an Electron bridge host, which lets the React kit run in Electron;
- the Tauri plugin (X-02);
- Godot C# bindings (X-01).

---

## 6. Content delivery across languages

notes/A7 is the evidence for this section. The design is in [`CONTENT.md`](CONTENT.md) §8–§10.

### 6.1 What is portable with each platform's own primitives

These need nothing beyond the runtime:

- SHA-256 (streaming everywhere except browser WebCrypto, which needs `hash-wasm` or
  `@noble/hashes` for large payloads);
- `pkey-chunks/1` and `pkey-files/1` parsing;
- the path rules, which are ASCII by construction;
- HTTP `Range`, request-run grouping and resume;
- the type-neutral container rebuild (offsets plus a gaps blob);
- the planner, a pure integer function.

### 6.2 zstd: one codec, at most one dependency per SDK

| SDK              | Plain zstd and raw-prefix delta                                                         | Floor, probe and settings                                                   |
| ---------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Node / Electron  | `node:zlib` (zstd from 22.15; the `dictionary` option works from 22.19 and 24.6)        | probe at startup; below the floor use the shared WASM decoder               |
| React / browser  | vendored decoder-only libzstd WASM (69 KB, 24 KB gzipped); `dcz` for deltas in Chromium | OPFS staging from a worker                                                  |
| Python           | stdlib `compression.zstd` on 3.14 (`as_prefix`); `zstandard` on 3.9–3.13                | set the window limit explicitly                                             |
| Swift            | libzstd via the official `facebook/zstd` SwiftPM package (Compression has no zstd)      | CryptoKit for SHA-256                                                       |
| Kotlin / Android | zstd-jni `.aar` (four ABIs, arm64 476 KB); no raw-prefix API                            | depends on the magic-base publish rule                                      |
| C# / .NET, Unity | .NET 11 `ZstandardDecoder.SetPrefix`; `ZstdSharp.Port` on ≤ 10, Unity and Blazor        | not on browser/WASI .NET 11; wrap the prefix call                           |
| Godot            | engine `decompress` plus the `GDDL` delta route (notes/A6)                              | pin the `GDDL` method per engine `major.minor`; every object carries `size` |

**No second codec.** notes/E9 recommended adding `deflate-raw` so that `full`, `file` and `chunk`
need no dependency anywhere. After notes/A7, the recommendation is **zstd only**:

- A second codec doubles the content corpus and every applier, and every SDK would still need
  zstd for deltas.
- The only runtime without a native zstd is the browser. There, deltas already need the WASM
  decoder (or `dcz`), and 24 KB gzipped is a smaller cost than a second format forever.
- Pre-compressed media (Ogg, PNG, KTX) is stored raw, which the chunk index already expresses.

### 6.3 Spec rules found by running six runtimes

Each is now a rule in [`CONTENT.md`](CONTENT.md) §9, with a corpus case:

1. **Node 22.15–22.18 and 24.0–24.5 silently ignore the zstd `dictionary` option**, and deltas
   fail as corruption. The Node SDK must probe (decode a tiny prefix-delta vector) or require
   22.19. The Node runner runs on the minimum supported version.
2. **Bases starting with the zstd dictionary magic `37 A4 30 EC` break every auto-detecting
   decoder.** CI must refuse to publish such deltas; decoders use raw-content prefix mode only.
3. **Streaming decoders cap the window at 128 MiB** unless raised. `--patch-from` windows are at
   least the larger file, so decoders set `windowLogMax` explicitly.
4. **Godot's JSON parser turns U+0000 into U+FFFD**, so a test with a NUL "passed" on both sides of
   a lossy parser. Vectors must not rely on NUL round-trips through GDScript.
5. **Godot's `decompress` needs the exact output size**, so every zstd reference carries `size`.
6. **A `dcz` body is not a portable zstd stream.** Store the bare frame; add the 40-byte header at
   the edge.

### 6.4 What stays platform-bound

These are adapters behind the `platform` strategy. Each is verified afterwards by the same files
index and hashes, so the platform only moves bytes:

- Apple Background Assets: the Apple plugin package (the downloader extension is an Xcode target,
  so only build systems that can add one qualify);
- Play Asset Delivery: the Kotlin AAR (the client library has been 2.3.0 since 2024-12-17);
- Steam depots: GodotSteam, Steamworks.NET, `steamworks-ffi-node` (the older `steamworks.js` is
  stale);
- MSIX optional packages: Windows packaging APIs;
- `dcz`: Chromium browsers; OPFS sync handles: browser workers.

---

## 7. Runtime limits that become typed N/As

From notes/E9 §10. These are product facts to design around, not gaps to close:

| Runtime        | What it cannot do                                                                          | What the SDK does instead                                                         |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Web            | hardware fingerprint, keyring, keyless enrolment, strict device tiers, platform transports | a random id in IndexedDB; licence-key or sign-in activation; `pkey-cdn` and `dcz` |
| iOS            | self-update                                                                                | a store link; `apple-ba` for content                                              |
| Unity          | a built-in updater                                                                         | store, Steam or launcher hand-off                                                 |
| Android        | hardware serials (API 29+)                                                                 | an app-scoped id and the Keystore                                                 |
| Swift, non-iOS | `AppDistributor` (iOS/iPadOS 17.4+ only)                                                   | `AppTransaction` and receipt heuristics on macOS                                  |
| .NET           | Ed25519 in the base library                                                                | BouncyCastle or NSec, a `dependency` that is always present                       |
| Tauri webview  | WebCrypto Ed25519 on every system webview (WebKitGTK unverified)                           | Ed25519 in the Rust plugin                                                        |

Outlet detection is the least portable feature. Only iOS and Android have a first-party API, and
Android's install source is declared by the installer, not proven. Everything else is
environment variables, paths or probing, which is why it gets its own corpus
(`outlet-matrix.json`): the signals differ per runtime, but the mapping from signals to an outlet
must not.

---

## 8. Parity gaps to close now

> **Superseded 2026-10-04.** P1b–P6 closed these rows, except React's edge-mint (now pass SP-R02). The current gap list, grouped
> per SDK as tasks that need no wire change, is
> [`notes/SDK-PARITY-PASS.md`](notes/SDK-PARITY-PASS.md) §5. The items that do need a wire change
> are in its §6. The table is kept as the historical record.

These existed before Godot added anything. Each gets a registry entry, then a fix in every SDK that
lacks it:

| Gap                                                             | SDKs                | Fix                                                                                 | Phase  |
| --------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- | ------ |
| Re-register on 401 for licence-less devices                     | all                 | a transcript, then the flow in each SDK                                             | P1b    |
| Header values differ (`win32`/`x64` vs `windows`/`AMD64`, …)    | all                 | `headers.json` and generated canonical values                                       | P1b    |
| `entitledChannels()` (closed by P1b-07)                         | Node, Python, React | port from Swift                                                                     | P1b    |
| Catalog fetch (`/config/schema`) (closed by P1b-07)             | Node, Python, React | port from Swift                                                                     | P1b    |
| Edge-mint                                                       | all                 | Godot implements it first (P1); port with the transcript                            | P1–P1b |
| Device-code sign-in                                             | Node, Python, Swift | port React's flow; the server's RFC 8628 page lands in P1                           | P1b    |
| Release client (changelog, download URLs) (closed by P1b-07)    | Swift, React        | port from Node/Python                                                               | P1b    |
| Offline bundle import, telemetry (closed by P1b-07)             | React               | expose `client-core`'s bundle import; add reporting                                 | P1b    |
| Windows `wmic`, Linux privilege-dependent anchor                | Node, Python        | CIM/SMBIOS reads; a documented non-root anchor; new `fingerprint.json` cases        | P1b    |
| `~/.config` on every OS                                         | Node, Python, Swift | platform data, cache and state directories with backup exclusion (needed for packs) | P1b    |
| Silent keyring downgrade (Node single-executable builds)        | Node                | a surfaced `degraded` store state; bump `@napi-rs/keyring`                          | P1b    |
| macOS keychain attribute ignored                                | Swift               | `kSecUseDataProtectionKeychain` where entitled, or document the trade-off           | P1b    |
| `AppDistributor` needs iOS 17.4 while the package floor is 17.0 | Swift               | `#available` guards in outlet detection                                             | P3     |
| Node conformance runner's stale build-gate port                 | Node                | fix (README §9.1 #15)                                                               | P0     |

---

## 9. New SDKs: order and shape

1. **Godot (README P1).** The first SDK built parity-first: its manifest starts all `planned`, and
   P1 turns the core, licence, config, devices and identity rows green. It proves the process on a
   language with no crypto primitives (Ed25519 and SHA-512 in pure GDScript, notes/A5).
2. **The Apple plugin package and the Kotlin AAR** (with P5). They serve Godot first, then every
   later runtime on those platforms.
3. **Kotlin (required; owner decision 2026-10-04, P6-05 and its children P6-06 to P6-12).** A
   full-parity SDK for native Android and, where sensible, JVM, plus a Jetpack Compose UI kit; the
   Godot Android binding is rebuilt on its platform module only. Distributed through Polaris Key's
   own Maven feed, never Maven Central.
4. **C# / .NET (optional, about 10–14 weeks).** One package covers .NET desktop, MAUI, Unity and
   Godot C#. Unity adds a Unity-specific layer (UI Toolkit, Addressables provider). Ed25519 needs
   BouncyCastle or NSec; zstd needs `ZstdSharp.Port` below .NET 11.
5. **Tauri plugin (optional, about 2–3 weeks).** Rust: keyring, fingerprint, Ed25519 fallback and
   updater hand-off. Everything else is the React SDK.

For each, the registry makes the backlog explicit, and the corpora and transcripts make the
definition of done mechanical.

---

## 10. Effort and roadmap

| Work                                                                                      | Estimate                | Phase                  |
| ----------------------------------------------------------------------------------------- | ----------------------- | ---------------------- |
| Feature registry, per-SDK manifests, `parity:check`, generated parity page                | 1–1.5 wk                | P1b                    |
| `gen-sdk-constants` (errors, headers, enums, feature ids) for TS, Python, Swift, GDScript | 1 wk                    | P1b                    |
| Transcript capture in the Worker tests and replay harnesses in four SDKs                  | 2–3 wk                  | P1b                    |
| `headers.json`, `config-matrix.json`; the Chromium runner; minimum-version runners        | 1–1.5 wk                | P1b                    |
| Closing the §8 gaps in Node, Python, Swift and React                                      | 3–5 wk                  | P1b                    |
| **P1b total**                                                                             | **8–12 wk**             | parallel with P1       |
| `update-matrix`, `outlet-matrix`, feed and release-record cases in every SDK              | in P3                   | "five SDKs + Godot"    |
| Content corpus, `plan-matrix` and appliers in every SDK                                   | in P4                   | every SDK, per CONTENT |
| `stage-matrix` and `ui.stages` ports                                                      | in P1                   | UI kit v1              |
| Kotlin / C# / Tauri                                                                       | +6–8 / +10–14 / +2–3 wk | optional               |

**Ordering.** Build the registry and the gate first, then declare today's manifests honestly
(including every ✗). From then on, a phase that adds a feature cannot close with a silent gap. The
gate turns "parity" from a review comment into a build failure.

---

## 11. Open questions

1. Should the manifests live beside each SDK or centrally (one file per SDK under
   `conformance/parity/`)? Central is easier to gate; beside the SDK is easier to keep honest in
   review. Recommendation: beside the SDK, gated centrally.
2. Should transcripts assert header order and casing? Recommendation: no. Assert presence and
   canonical values; HTTP stacks differ.
3. Is a GDScript `supports()` result better as a `RefCounted` result type or as an error code
   plus `detail` dictionary? It should match whatever P1 settles for every other GDScript result.
4. Which Firefox and Safari versions join the browser runner, given notes/A7 measured only
   Chromium? At least one WebKit run is needed before the React SDK claims `packs.apply.delta`.
5. Where do device tests (store transports, background transfer) run? They need real hardware or
   device farms, outside the green gate; their results should still feed the parity page.

# @polaris-key/node

The Node/TypeScript client for **Polaris Key** — an always-on **Core** substrate (device
principal, credential, trust, verified cache, sync loop) plus one opt-in sub-client per service
(**License**, **Config**, **Devices**, **Release**, **Update**). **Offline-first**: `init()`
loads and re-verifies the cached signed documents with **no network**. The frozen wire crypto
(Ed25519 compact JWS) is verified through `@polaris-key/client-core`, the isomorphic
package the React SDK shares, and pinned byte-for-byte by the same cross-language conformance
corpus the Python and Swift SDKs run.

## Install

```sh
pnpm add @polaris-key/node
```

Node 22+. The OS keyring is an **optional** dependency (`@napi-rs/keyring` ^2.1); without it the
token falls back to a `0600` file under the config dir, and `await client.storeStatus()` says so.

## Quick start

```ts
import { PolarisKeyClient } from "@polaris-key/node";

// Offline-first: create() loads the token + re-verifies the cached documents, no network.
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version: "1.4.2",
  trust: {
    pinnedKeys: {
      // kid -> raw Ed25519 public key (base64url). Pinned by the caller; NEVER read from
      // the document, and never learnable from the cache.
      "pkey-djdl-prod-2026-06":
        "REPLACE_WITH_DJDL_ED25519_PUBLIC_KEY_BASE64URL",
    },
  },
});

// Gate: true for `ok`, `grace`, and `not-applicable` (a product that runs no License service).
if (!client.isLicensed()) {
  const r = await client.license.activateWithKey(userEnteredKey);
  if (r.kind !== "ok") throw new Error("activation failed");
}

// Layered config: enforced|hidden > local > env > remote-default > fallback.
const concurrency = client.config.getConfig<number>("run.concurrency", 3);
const vpnUrl = client.config.getSecret("proxy.subscriptionUrl");
const hasVpn = client.license.isEntitled("polarisVpn");

// One Core pass: trust refresh -> enabled documents in parallel -> verify -> cache -> report.
await client.sync();
```

## Shape

| Surface           | Subpath                      | What it owns                                                                                                             |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `client.core`     | `@polaris-key/node/core`     | Device id, `pkeyt_` token, trust set, cache v3, monotonic clock floor, `sync()`, telemetry, bundle import                |
| `client.license`  | `@polaris-key/node/license`  | `activateWithKey` / `enroll` / `deactivate` / `status` / entitlements / profile / `entitledChannels`                     |
| `client.config`   | `@polaris-key/node/config`   | `getConfig` / `getConfigSource` / `listUserConfig` / `getSecret` / `fetchSchema` (the catalog) / `mintToken` (edge-mint) |
| `client.devices`  | `@polaris-key/node/devices`  | `register` (keyless mint) / `list` / `rename` / `deauthorize` / `report`, plus the fingerprint + device-id formulas      |
| `client.identity` | `@polaris-key/node/identity` | `beginSignIn` / `pollSignIn` / `waitForSignIn` — device-code sign-in (RFC 8628)                                          |
| `client.release`  | `@polaris-key/node/release`  | `changelog` / `installUrl` / `downloadUrl`                                                                               |
| `client.update`   | `@polaris-key/node/update`   | `decide` / `feed` / `releaseRecord` (wire v4) / `buildUrl` / `check` (version) / `appcastUrl` (from discovery)           |
| —                 | `@polaris-key/node/local`    | The transportless profile: every network-requiring call refuses                                                          |
| —                 | `@polaris-key/node/cli`      | Framework-agnostic commands + commander/yargs adapters                                                                   |

`client.license.entitledChannels()` returns the `channels` entitlement's string grants in order,
or `["stable"]` when the licence carries none — the Worker's own answer, and every SDK's for the
same document. `client.config.fetchSchema()` returns the product's catalog (`ProductCatalog`) or
`null` on any failure; it is unsigned and diagnostic, so it never throws. `client.release`
refuses with `service-unavailable` when the product does not run Release, forwards the device
token when one is held, and surfaces a 401/403 by the refusal body's own code
(`unauthorized`, `channel_not_allowed`, …).

Pure verification logic is **not** re-exported here. `verifyLicenseDoc`, `licenseState`,
`mergeTrust`, `verifyBundle`, `compareSemver` and friends live in `@polaris-key/client-core`; there is
one implementation, and every JS host consumes it.

### `CoreOptions`

| Option             | Notes                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `productSlug`      | The product slug; also the document `aud`. Scopes every route + the cache.                                                                   |
| `version`          | The **host application's** semver. Sent as `X-PKey-Version`; the channel derives from it.                                                    |
| `trust.pinnedKeys` | `{ kid -> rawEd25519PubBase64url }`. Core-owned: it verifies licence documents, config documents, trust manifests and offline bundles alike. |
| `baseUrl`          | Control-plane origin (default `https://key.plrs.im`). Must be `https:` or loopback.                                                          |
| `channel`          | Override `X-PKey-Channel` (default derived from `version`): `stable`, `beta`, `pr`/`pr-<n>`, `dev` or a manual name; `staging` is accepted.  |
| `trustRefresh`     | Refresh the trust manifest on Core's own cadence inside `sync()` (default true).                                                             |
| `store`            | A `Store` (default `KeyringStore`; `InMemoryStore` for tests).                                                                               |
| `configDir`        | Config base; `<product>` is appended. Holds the token file, device id and cache (default `$XDG_CONFIG_HOME` or `~/.config`, on every OS).    |
| `dataDir`          | Data base; `<product>` is appended. Default in the table below.                                                                              |
| `cacheDir`         | Cache base; `<product>` is appended. Default in the table below.                                                                             |
| `stateDir`         | State base; `<product>` is appended. Default in the table below.                                                                             |
| `requestTimeoutMs` | Per-request deadline (default 15000; `0` disables).                                                                                          |
| `expectedServices` | What this build expects the product to run — the capability fallback when discovery has not been fetched.                                    |

Per-service inputs ride their own bags: `config: { localOverrides, envPrefix, env }`,
`license: { fingerprint }`, `devices: { probes, fingerprint }`, and
`update: { pinnedReleaseKeys, outlet, format, buildNumber, methods, … }` (below).

### Directories

`client.core.dirs` holds the four resolved directories (`config`, `data`, `cache`, `state`),
each already ending in `<product>`. Nothing is created until something uses one; the config
directory is where it has always been.

| Base   | Linux and other POSIX                                         | macOS                                             | Windows                            |
| ------ | ------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| config | `$XDG_CONFIG_HOME` or `~/.config`                             | same as Linux                                     | same as Linux (`~\.config`)        |
| data   | `$XDG_DATA_HOME/polaris-key` or `~/.local/share/polaris-key`  | `~/Library/Application Support/polaris-key/data`  | `%LOCALAPPDATA%\polaris-key\data`  |
| cache  | `$XDG_CACHE_HOME/polaris-key` or `~/.cache/polaris-key`       | `~/Library/Caches/polaris-key`                    | `%LOCALAPPDATA%\polaris-key\cache` |
| state  | `$XDG_STATE_HOME/polaris-key` or `~/.local/state/polaris-key` | `~/Library/Application Support/polaris-key/state` | `%LOCALAPPDATA%\polaris-key\state` |

The XDG variables count only when set, non-empty and absolute. `resolveDirs()` is the pure
resolver; `excludeFromBackup(dir)` marks an existing directory (`CACHEDIR.TAG` on POSIX, plus
`tmutil addexclusion` on macOS; `not-applicable` on Windows) and never throws.

### Token store status

`await client.storeStatus()` returns `{ backend, degraded? }`, or `null` for a host store
without `status()`. The default `KeyringStore` reports `keyring`, or `file` with a reason:

- `keyring-unavailable`: `@napi-rs/keyring` cannot load (including inside a Node
  single-executable build, which cannot load the native addon), or, on Linux, there is no
  Secret Service. Linux entries are pinned to the Secret Service, never the in-memory kernel
  keyring, so a headless host keeps its token in the `0600` file across reboots.
- `keyring-error`: the keyring loaded but failed, or an earlier write fell back to the file (the
  next token write moves it to the keyring).

The CLI `status` command prints the same as a `Token store:` line.

### Linux and containers

The fingerprint anchor and the device id read `/etc/machine-id`, else
`/var/lib/dbus/machine-id`; DMI files are never read, so root and non-root agree. A container
with neither file has no anchor and cannot enrol without a licence key: mount the host's
`/etc/machine-id` read-only, or create one and keep it in a volume. Never bake one into an
image.

## Capabilities, fail-closed

`client.capabilities()` resolves **without a network call**, in this precedence:

1. a discovery document loaded this session (`await client.discover()`) — always wins;
2. `expectedServices`;
3. the suite default: **License + Config on**, Release/Update/Identity **off**.

A service that is off refuses its sub-client (`PolarisError` code `service-unavailable`), and a
product with License off reports gate status **`not-applicable`** with `isLicensed() === true` —
a config-only product boots usable rather than sitting on `needs-activation` forever.

## `supports()`: typed "unsupported here"

`client.supports(feature)` says whether a parity feature works in this client, offline and
without side effects. Pass a generated `Feature` constant:

```ts
import { Feature } from "@polaris-key/node";

const s = client.supports(Feature.coreStore);
if (!s.supported) console.warn(`${s.feature}: ${s.reason} (${s.detail})`);
```

The answer is `{ supported: true, feature }` or `{ supported: false, feature, reason, detail }`.
`reason` is one of the generated `UnsupportedReason` values:

- `runtime`: Node cannot do it at all (`ui.kit`, the Apple and Play pack transports).
- `product`: the owning service is off, per discovery or the fail-closed fallback above.
- `dependency`: an optional dependency is missing. For `core.store`, this means
  `@napi-rs/keyring` cannot load, so `storeStatus()` reports `keyring-unavailable` and the token
  is in a `0600` file.
- `version`: this SDK version does not implement the feature yet, or does not know the id.
- `outlet`: the outlet forbids it. Node declares no such N/A.

The answers come from a capability table generated from `parity.json`, so they always match the
parity matrix. A call into an unsupported feature throws `UnsupportedError` (a `PolarisError`
with code `unsupported`) with the same `feature`, `reason` and `detail`.

`client.caps()` lists the feature ids `supports()` answers Supported for. Every device report
sends this list as `caps`, so the console can show what the fleet can do.

## `sync()`

One Core pass, in order: trust refresh (Core's own cadence, not a side effect of any document
fetch) → the **enabled** documents fetched **in parallel** with per-document ETag/304 and the
half-life re-ask → verification through client-core with per-type anti-replay floors → **one**
read-modify-write of the cache record → the clock floor → best-effort telemetry to
`POST /<product>/devices/report`. A 401 gets exactly **one** `POST /<product>/license/token`
re-acquire for the whole pass, then one retry of the failed fetch.

A registered device without a licence **re-registers** instead: when License is off for the
product, or the token came from `devices.register()` in this process, the one attempt is
`POST /<product>/devices/register` (the same request as `register()`: the fingerprint, and no
`Authorization` header). It shares the single-attempt budget, so two parallel 401s still make one
call. A refusal (403 `registration_closed`, 404, 429) spends the attempt and the hard 401 is
recorded. After a restart the token's origin is not persisted, so a product with License on uses
`license/token`. Under the `requires-identity` policy a native device cannot re-register (that
needs a browser session) and lands on the hard 401.

`client.getSyncState()` returns `{ activation, doc, lastSyncUnauthorized, blocked,
lastVerifiedAt, highWaterMark }` — the snapshot the React bridge renders from.

## Device-code sign-in

For a host that cannot complete a browser redirect — a CLI over SSH, a daemon, a game on a TV —
`client.identity` signs in with a device code (RFC 8628). It needs the Identity service
(`expectedServices` or discovery); with it off, every call throws `service-unavailable` before
any request.

```ts
const prompt = await client.identity.beginSignIn({
  deviceName: "Living-room PC",
});
// Show prompt.userCode large; render prompt.verificationUriComplete as a QR code (it is the
// verification page with the code filled in); show prompt.verificationUri as the short URL.
const abort = new AbortController(); // e.g. the player backs out of the sign-in screen
const result = await client.identity.waitForSignIn(prompt, {
  signal: abort.signal,
});
if (result.status === "ready") {
  // The device token is stored and the post-activation sync has already run.
}
```

`waitForSignIn` waits at least `prompt.interval` seconds before each poll; a `slow_down`
lengthens the interval for every later poll (to the server's value, or by five seconds), and a
poll that fails on the network or with a 5xx is retried at the same interval, never faster. It
resolves `expired` once `prompt.expiresAt` has passed without asking the server again, and
rejects with the signal's reason when the signal aborts. `pollSignIn(prompt)` makes exactly one
poll (`pending`, `slow-down` with an `interval`, `ready`, `expired` or `error`) for a host that
paces itself — an Electron bridge, say.

`prompt.deviceCode` is the poll credential: never show it. A sign-in yields the signed-in
identity's **own** licence; it does not attach a licence this device already held.

**After `ready`, show on the device which account signed in.** Anyone holding the user code can
complete the sign-in on the verification page, so the player must be able to see a mis-binding:
`ready` carries no identity itself, but the post-acquisition sync has already run, so
`client.license.getProfile()` returns the signed licence profile (`name`, `email`) to show — for
example "Signed in as Ada Lovelace <ada@example.com>" with a way to sign out.

A prompt from `beginSignIn` and a `MintedToken` print with the credential redacted:
`console.log` and `JSON.stringify` show `deviceCode` / `token` as `[redacted]`, while the
properties themselves read normally.

## Edge-mint

`client.config.mintToken(recipeId)` asks the Worker to sign a short-lived third-party token
through an operator-approved recipe (`GET /<product>/config/mint/<recipeId>/token`, with the
device token) and resolves `{ token, expiresAt }`. The result is cached **in memory only** — never
in the cache file or the keyring — and reused until 30 seconds before `expiresAt`, so asking on
every API call costs one mint per lifetime. A cached token counts only while the client still
holds the device token it was minted with: `deactivate()`, a cleared token or a different sign-in
drops it. A 401 gets the usual single re-acquire, on the same route a document 401 takes (so a registered device without a licence re-registers), and one retry.
Failures throw `PolarisError`: `service-unavailable` (Config off) and `bad_request` (an id
outside `[a-z0-9-]`) before any request, `unauthorized` (no token, or still 401), or the Worker's
`not_found` / `rate_limited` / `misconfigured`.

## Layered config precedence

The signed config document carries, per key, a `ManagedEntry` with a management `state`
(`default` | `enforced` | `hidden`):

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

- **`enforced` / `hidden`** are **locked to the server** — `localOverrides` and env vars are
  ignored for those keys. `hidden` additionally withholds the key from `listUserConfig()` (but
  `getConfig` still applies it).
- A **`default`** (or absent) key can be overridden locally, then by an env var, then falls back
  to the remote value, then to the caller's `fallback`.

### The `PKEY_CONFIG_*` env convention

An override env var is `${envPrefix}${key.replaceAll(".", "__")}` (dots → double underscores):

| Config key        | Env var                        |
| ----------------- | ------------------------------ |
| `run.concurrency` | `PKEY_CONFIG_run__concurrency` |
| `quality.floor`   | `PKEY_CONFIG_quality__floor`   |

The value is the parsed JSON value when the raw string is one strict JSON text (`4` → number,
`true` → boolean, `[…]`/`{…}` → array/object, `"…"` → string), and otherwise the raw string,
unchanged (WIRE-CONTRACT-V3 §2.2.1 rule 2, pinned by `conformance/corpus/v2/config-matrix.json`).
Strict means: no trailing comma, `NaN`, `Infinity`, leading zero or byte order mark; no duplicate
member names and no member name holding U+0000; no lone surrogate; every number zero or of
magnitude 10^−307 up to below 10^308; and at most 64 levels of nesting. Reading a variable never
throws. A set but empty variable counts (its value is `""`).

### What the SDK sends

Every product-scoped request carries the `X-PKey-*` metadata headers. `X-PKey-Platform` and
`X-PKey-Arch` are the canonical values of WIRE-CONTRACT-V3 §5.2 (`macos`, `windows`, `linux`, …;
`arm64`, `x86_64`, …), mapped from `os.platform()` and `os.arch()`; a spelling with no value
(`freebsd`, `ia32`) omits its header. `X-PKey-SDK` is `node` (`SdkId.node`); `SDK_NAME` stays the
npm package name and is not sent.

## Signed update decisions (wire v4)

`client.update.decide()` answers "what should this install do next?" from the signed channel
feed (`pkey-feed+jws`) and the release record it pins (`pkey-release+jws`), with the same
`@polaris-key/client-core` functions every SDK runs against `update-matrix.json`
(`runUpdateCheck`, the React SDK's too). It is what an Electron main process or a CLI acts on:
verify, then stage. `check()` and `appcastUrl()` are unchanged beside it.

```ts
const client = await PolarisKeyClient.create({
  productSlug: "acme",
  version: "1.4.0",
  trust: { pinnedKeys: { "acme-2026": "<raw base64url>" } },
  expectedServices: ["release", "distribution", "update"],
  update: {
    pinnedReleaseKeys: { "acme-release-2026": "<raw base64url>" },
    outlet: "direct", // turns offers on; without an outlet the install is `unknown`
    format: "zip",
  },
});

const check = await client.update.decide({ channel: "latest" });
// { channel: "stable", decision: { action: "binary", method: "download", build, release, … },
//   feed: "network", record: "network", errors: [] }
if (check.decision.action === "binary") {
  const url = client.update.buildUrl(
    check.decision.release.version,
    check.decision.build,
  );
  // download, check `size` and `sha256` against the record's payload artifact, then stage
}
```

The answer is an `UpdateCheck`: `channel` (the canonical channel, the feed's own claim — record it
as `staged.channel` when you stage), `decision`, `feed` (`network` or `committed`), `record`
(`network`, `cache` or `none`) and `errors`.

| `update` option     | Notes                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinnedReleaseKeys` | `{ kid -> raw Ed25519 key, base64url }`: the **only** keys a release record verifies against. Never merged with the trust pins, never persisted, never learned from the network. |
| `outlet`            | A kind (`"direct"`, `"steam"`, …) or `{ id, kind, subkind? }`. Wins over `stamp` and `detected`. A Node CLI is never store-installed: `"direct"` is the usual value.             |
| `stamp`, `detected` | The build stamp's outlet fields (`outlet`, `outletKind`, `outletSubkind`, `outletIds`), and a detection result the host computed itself, through `resolveUpdateOutlet`.          |
| `detect`            | Default `true`: with no `outlet` and no `detected`, the client reads this process's signals (`readOutletSignals`) and runs `detectOutlet` over them and the stamp (below).       |
| `packageName`       | The product's npm package name, so an `npx`, `npm` or `pnpm` launch from `node_modules/<packageName>/` counts as the `node.packageManager` signal.                               |
| `format`            | The installed build's format; a binary build of another format is never offered. Default `null`.                                                                                 |
| `buildNumber`       | Informational in v4. Default `null`.                                                                                                                                             |
| `methods`           | What the host can do with a `binary` answer: a subset of `native`, `download`, `sidecar-pck`. Default `["download"]`.                                                            |
| `binaryVersion`     | The executable's version when it differs from `version` (after a code update). Defaults to `version`.                                                                            |
| `engine`            | `godot-<major>.<minor>` for a host that runs Godot code packs; `null` otherwise.                                                                                                 |
| `platform`, `arch`  | Default to `os.platform()` / `os.arch()`'s canonical values; set them on an OS with none.                                                                                        |

- **Outlet detection** (plans/P3-01.md §2.9). When the host names no `outlet`, the client detects
  one at construction: `readOutletSignals()` reads the environment (Steam's `SteamAppId`, snap,
  AppImage, `ITCHIO_APP`), the executable and script path conventions (a Homebrew `Cellar`
  realpath, WinGet, Scoop and Chocolatey folders, `_npx` and pnpm-store paths), `node:sea`'s
  `isSea()`, Electron's `process.mas` and `process.windowsStore`, and files the product's own
  identities name (the Mac App Store receipt in an `.app`, `Caskroom/<caskToken>/`, the
  `appmanifest_<steamAppId>.acf` of this install, the nearest itch receipt, `/.flatpak-info`). It
  never enumerates installed applications, and raw values never leave the process. Client-core's
  `detectOutlet` maps them, with the stamp, to `{kind, confidence, source, subkind}` (the same
  function every SDK runs over `outlet-matrix.json`), and the result goes to `resolveUpdateOutlet`
  as `detected`. Without a stamp, only attested evidence (a store receipt) selects an outlet:
  declared and heuristic signals only restrict one. `client.update.outlet` and
  `client.update.detected` expose the answer for support diagnostics.
- **Refusals.** A bad option, or a release key whose bytes are also a trust pin, throws
  `invalid-options` from the constructor; an empty `pinnedReleaseKeys` makes `decide()` throw
  `not-configured`. A product that runs no Update service is refused before dialling
  (`service-unavailable`, D-21), and so is a Worker whose discovery document has no
  `update.endpoints.feed` or `release.endpoints.record` — fall back to `check()`.
- **Discovery.** `decide()` loads discovery when this session has not. The feed is
  `GET …/update/{channel}/feed.jws?platform=…` with the channel as requested (`latest` is fine:
  the Worker answers with the canonical `stable` feed); the record is
  `GET …/release/records/{sha256}`, read at most 88 845 bytes, hashed before any signature work.
  The device bearer goes only to the control plane's own origin.
- **After a refusal** it decides from the committed feed and reports the refusal in `errors`
  (`feed-rejected` with the step as `detail`, `feed-rollback`, `record-rejected`,
  `record-mismatch`, `network-error` or the Worker's wire code). It throws an `UpdateError`
  (a `PolarisError` with `detail`) only when nothing committed is left to decide from. Offline,
  the committed feed decides; once it is past `expiresAt + 300` the answer is `none {stale}`.
- **The cache.** The `feeds` slice (keyed by each feed's own `channel` claim) and the
  `releaseRecords` slice (keyed by hash, kept only while a committed feed pins it) hold signed
  JWSs only, through Core's read-modify-write. Every load and every decision re-verifies them;
  each channel's `seq` floor is derived from the committed feed that survives, never stored, so
  it survives a restart and cannot be edited on disk. A deactivation or a bundle import keeps
  them.
- **The clock** is the effective clock, `max(system clock, highWaterMark)`: winding the system
  clock back cannot revive an expired feed.
- **No v4 answer stops play.** `binary`, `store` and `platform` with `mandatory: true`, and every
  `blocked {app-floor}`, are prompts the user cannot dismiss: show them as a persistent notice
  with no dismiss control over an app that keeps running, never as a window that covers it.
- `feed({channel})` returns the verified feed `decide()` would use, without the record;
  `releaseRecord(sha256)` verifies one record by hash (cross-checked and cached when a committed
  feed pins it). Handing off to Velopack, electron-updater or a self-replace is the host's.

## Offline depths

1. **Online with grace** — the default. Documents carry a short `expiresAt` and a long,
   server-signed `graceUntil`.
2. **Bundle-activated** — `await client.importBundle(jws)` verifies an operator-minted
   `pkey-bundle+jws` against the pinned keys, **all-or-nothing**, and writes the cache atomically.
   No token is created; the gate reads `activation: "bundle"`. A rejection throws a
   `PolarisError` naming the step that refused.
3. **Local-only** — `@polaris-key/node/local`'s `createLocalClient` / `createBundleClient`. There is no
   transport at all: config resolution, the gate and bundle import work, and every
   network-requiring call throws `PolarisError` code `local-only`.

## CLI hooks

`@polaris-key/node/cli` exposes a framework-agnostic command core plus thin **commander** and **yargs**
adapters over the same core, so the two front ends never diverge. Verbs are grouped by owning
service — `activate` / `enroll` / `deactivate` / `status` (license), `register` (devices),
`config <key>` (config), `import-bundle <file>` (core):

```ts
import { Command } from "commander";
import { PolarisKeyClient } from "@polaris-key/node";
import { registerPolarisCommands } from "@polaris-key/node/cli";

const program = new Command();
registerPolarisCommands(program, (opts) => PolarisKeyClient.create(opts), {
  pinnedKeys: { "pkey-djdl-prod-2026-06": "…" },
  productSlug: "djdl",
  version: "1.4.2",
});
program.parseAsync(process.argv);
```

## The frozen wire contract

Documents are compact **JWS (EdDSA / Ed25519)**, domain-separated by `typ`
(`pkey-license+jws`, `pkey-config+jws`, `pkey-trust+jws`, `pkey-bundle+jws`, `pkey-feed+jws`,
`pkey-release+jws`). The verifying key is chosen by the header `kid` from the pinned trust set —
never from the document, and never from the cache; a release record verifies against the pinned
release keys only. The encoding and every claim rule are pinned by
`conformance/corpus/v2/cases.json`, which this SDK, the worker, and the other SDKs verify
identically. See `docs/security/WIRE-CONTRACT-V4.md`.

## Develop

```sh
pnpm --filter @polaris-key/node typecheck
pnpm --filter @polaris-key/node test
pnpm --filter @polaris-key/node build
```

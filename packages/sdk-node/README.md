# @polaris-key/node

The Node/TypeScript client for **Polaris Key** — an always-on **Core** substrate (device
principal, credential, trust, verified cache, sync loop) plus one opt-in sub-client per service
(**License**, **Config**, **Devices**, **Release**, **Update**). **Offline-first**: `init()`
loads and re-verifies the cached signed documents with **no network**. The frozen wire crypto
(Ed25519 compact JWS) is verified through `@polaris-key/client-core`, the isomorphic
package the React SDK shares, and pinned byte-for-byte by the same cross-language conformance
corpus the Python and Swift SDKs run.

## Install

The `@polaris-key` packages are published to Polaris Key's npm feed only (not npmjs). Route the
scope to it once, in the project's `.npmrc` (Yarn, Bun and the rest:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/)):

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

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

## One call to a working app

`version` may be omitted: the client reads Electron's `app.getVersion()` or the nearest
`package.json`, and warns when it finds neither. `boot()` then does the whole start-up in order
and reports each stage of client-core's stage machine (`BOOT_STAGES`, re-exported):

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  trust: { pinnedKeys },
});
const { outcome, license, decision } = await client.boot({
  onStage: (step) => render(step.state), // discovery → guard → sync → register/enrol → gate → decide → packs → mount
});
if (outcome === "waiting") showActivation(); // the gate needs the player; boot never prompts
client.startRefresh(); // long-running hosts: hourly sync, at once after a wake, backoff offline
```

`ensureActivated()` runs only the first stages (sync, then `devices/register` or
`license/enroll` where the product allows it). `client.events` is one typed EventEmitter for
what changed: `license`, `config`, `updateAvailable`, `packs` and `store`.

| Need                   | Call                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation refusals    | `activateWithKey` / `enroll` answer a typed `ActivationResult`; every kind carries the server's `code`, an unknown 4xx is `refused{code}` and never `device-limit`. `copy.message(code)` (`core.copy`) is the sentence to show. |
| Entitlements           | `license.isEntitled(name)` is false whenever the gate is not usable (revoked, expired past grace); `entitlementValue(name)`, `licenseInfo()`.                                                                                   |
| Local settings         | `config.set(key, value)` / `config.clear(key)` persist an override in the state directory (refused for operator-locked keys); `config.setting(key)` is one key's handle; `onConfigChange(key \| "*")`.                          |
| Sign-in                | `identity.signInWithBrowser()` opens the device-code page in the system browser; `waitForSignIn(prompt, { confirm })` sends the attach opt-in; `identity.current()`, `identity.signOut()`; `qr.terminal()` / `qr.svg()`.        |
| Store purchases        | `client.commerce`: `binding()`, `claim(store, payload)`, `claimSteam(ticketHex, dlcAppId)`, `claimAppStore(jws)`, `claimPlay(productId, token)`. The host passes what its store gave it.                                        |
| Verified download      | `release.fetch(target, { to, onProgress, signal })`: bearer, `Range` resume, size and SHA-256 checked against the signed record; never leaves a partial file at `to`.                                                           |
| Updater feeds          | `update.feedUrl("appcast" \| "winsparkle" \| "velopack" \| "appInstaller" \| "zsync")` from discovery (typed `Unsupported` when unpublished); `client.distribution.downloadModel()`.                                            |
| Install an update      | `update.install(decision)` through a driver (below), answering `restartRequired`, `handedOff`, `storeOpened` or `unsupported{reason}`.                                                                                          |
| Boot guard             | `update.markBootAttempt()` at start-up, `update.confirmBoot()` once healthy; after `MAX_FAILED_BOOTS` the driver's rollback runs, else `boot_rolled_back` is reported and the version is skipped.                               |
| Update health          | decide, packs, downloads, drivers and the guard journal P6-03 events in the state directory; each device report carries at most 16 and marks them sent.                                                                         |
| Server-side check      | `verifyLicenseDocument(jws, { trust, product, deviceId })` from `@polaris-key/node/server` for a backend a client presents its licence to.                                                                                      |
| Crash reporting        | `client.crashTags()` → `{ release, environment, "pkey.outlet" }` for a Sentry init (`release`, `environment`, and a tag).                                                                                                       |
| Build stamp and outlet | `.polaris_key/build.json` (P1-11) is autoloaded; `readWindowsSignatureKind()` feeds the attested Windows signal.                                                                                                                |

Products whose device-trust policy requires platform attestation refuse a Node client
(`attestation-required`): Node has no attestation service (`devices.attest` is a declared N/A).

## Install drivers

`client.update.install(decision)` hands a signed `binary` or `store` decision to the driver set
with `update: { driver }` or `client.update.useDriver(driver)`. None of them installs its
updater; pass the object you already depend on. Each keeps the verified decision as the
authority (the updater must offer exactly the decided version) and records `update_downloaded`
and `update_applied`.

| Driver                  | Subpath                                             | Notes                                                                                                                                           |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `electronUpdaterDriver` | `@polaris-key/node/update/drivers/electron-updater` | `{ autoUpdater }` from electron-updater; the downloaded file must hash to an artifact of the signed record. `restart()` calls `quitAndInstall`. |
| `velopackDriver`        | `@polaris-key/node/update/drivers/velopack`         | `{ velopackChannel, createManager: (url, ch) => new UpdateManager(url, { ExplicitChannel: ch }) }`, pointed at discovery's Velopack feed.       |
| `seaSelfReplaceDriver`  | `@polaris-key/node/update/drivers/sea`              | A single-executable build replaces itself with `release.fetch`-verified bytes and keeps `<exe>.previous` as the boot guard's rollback.          |
| `storeLinkDriver`       | `@polaris-key/node/update/drivers/store-link`       | Opens the store listing, or `{ downloadPage }` for a direct build.                                                                              |

Without a driver a `store` decision opens its listing and a `binary` one answers
`unsupported{reason: "dependency"}`; a `packs` decision is `update.packs.ensure()`'s.

## Electron

One line on each side, and `@polaris-key/react`'s `DesktopAdapter` works unchanged in the
renderer (PolarisBridge v3: state, refresh, sign-in, key entry, sign-out, `invoke`, schema,
offline bundles, pushed `stateChanged`):

```ts
// main
import { app, ipcMain, safeStorage } from "electron";
import { PolarisKeyClient } from "@polaris-key/node";
import {
  exposePolarisBridge,
  SafeStorageStore,
} from "@polaris-key/node/electron";

await app.whenReady();
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  trust: { pinnedKeys },
  store: new SafeStorageStore("djdl", app.getPath("userData"), { safeStorage }),
});
exposePolarisBridge(client, {
  ipcMain,
  allowSender: (e) => e.senderFrame?.url.startsWith("app://") === true,
});

// preload (bundled: sandboxed preloads load no ES modules from node_modules)
import "@polaris-key/node/electron/preload";
```

The device code of a sign-in never leaves the main process, and `invoke` answers only the verbs
the React adapter uses (devices, update check/decide, release links, report) unless the host adds
more with `invoke: { extra }`. `SafeStorageStore` encrypts the token with Electron's
`safeStorage`; `status()` reports `keyring-unavailable` before `app.whenReady()`, without a
secret store or on Linux's `basic_text`, and `keyring-error` when the stored token no longer
decrypts.

## Shape

| Surface               | Subpath                          | What it owns                                                                                                                |
| --------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `client.core`         | `@polaris-key/node/core`         | Device id, `pkeyt_` token, trust set, cache v3, monotonic clock floor, `sync()`, telemetry, bundle import                   |
| `client.license`      | `@polaris-key/node/license`      | `activateWithKey` / `enroll` / `deactivate` / `status` / entitlements / profile / `entitledChannels`                        |
| `client.config`       | `@polaris-key/node/config`       | `getConfig` / `getConfigSource` / `listUserConfig` / `getSecret` / `fetchSchema` (the catalog) / `mintToken` (edge-mint)    |
| `client.devices`      | `@polaris-key/node/devices`      | `register` (keyless mint) / `list` / `rename` / `deauthorize` / `report`, plus the fingerprint + device-id formulas         |
| `client.identity`     | `@polaris-key/node/identity`     | `beginSignIn` / `pollSignIn` / `waitForSignIn` — device-code sign-in (RFC 8628)                                             |
| `client.release`      | `@polaris-key/node/release`      | `changelog` / `installUrl` / `downloadUrl`                                                                                  |
| `client.update`       | `@polaris-key/node/update`       | `decide` / `feed` / `releaseRecord` (wire v4) / `buildUrl` / `check` (version) / `appcastUrl` (from discovery)              |
| `…update.packs`       | `@polaris-key/node/packs`        | `ensure` / `state` / `path` / `registerHandler` / `on` / `packSetId` / `confirm` / `rollback` / `bootFetch`; the zstd probe |
| —                     | `@polaris-key/node/local`        | The transportless profile: every network-requiring call refuses                                                             |
| —                     | `@polaris-key/node/cli`          | Framework-agnostic commands + commander/yargs adapters                                                                      |
| `client.commerce`     | `@polaris-key/node/commerce`     | `binding` / `claim` / `claimSteam` / `claimAppStore` / `claimPlay`                                                          |
| `client.distribution` | `@polaris-key/node/distribution` | `downloadModel` / `thisPlatform`                                                                                            |
| —                     | `@polaris-key/node/electron`     | `exposePolarisBridge`, `SafeStorageStore`; `/electron/preload` for the renderer side                                        |
| —                     | `@polaris-key/node/server`       | `verifyLicenseDocument` for a backend                                                                                       |

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
parity matrix. A call into an unsupported feature throws `UnsupportedError`, a `PolarisError`
carrying the same `feature`, `reason` and `detail`. Its code is `unsupported`, except for a
sub-client whose service is off. That refusal is the `product` reason and keeps the code
`service-unavailable`, which existing callers match on.

`client.caps()` lists the feature ids `supports()` answers Supported for. Every device report
sends this list as `caps`, so the console can show what the fleet can do.

## Errors

Every error the SDK throws is a `PolarisError`, so `instanceof PolarisError` catches all of them
(`UnsupportedError`, `UpdateError`, `PackError`, `InsecureBaseUrlError` and
`DeviceManagementUnsupportedError` are subclasses). Branch on `code`, a generated `ErrorCode`.

A failed network call reports one of these codes. Most calls throw. Activation, enrolment,
`devices.register()`, commerce, `sync()` and `discover()` put the code in their result instead.

| What happened                             | `code`                                                          | Also set                                                          |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| No answer: offline, refused, the deadline | `network-error`                                                 | `cause`                                                           |
| 429                                       | `rate_limited`                                                  | `retryAfterSeconds`, from `Retry-After`                           |
| 5xx                                       | `server-error`                                                  | `status`, `wireCode` (the server's own code), `retryAfterSeconds` |
| 404                                       | `not_found`                                                     | `status`                                                          |
| Any other refusal                         | the server's code (`unauthorized`, `download_auth_required`, …) | `status`                                                          |
| A 2xx the call cannot read                | `bad_response`                                                  |                                                                   |

The message is the server's when it sent one. Two answers keep their contract meaning: a 429 on a
signed document is the device cap (`sync()` reports `device-cap`), and a 429 on a sign-in poll is
`slow-down`.

A device token never prints. An `ok` activation or registration result keeps `token` readable,
but `console.log`, `util.inspect` and `JSON.stringify` show `[redacted]`. The client itself prints
the same way.

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

## When every seat is taken

A refused activation or enrolment returns `{ kind: "device-limit", limit, deviceCount, manageUrl? }`.
`manageUrl` is the customer-portal link that frees a seat (WIRE-CONTRACT-V4 §5.3), present while
the product's portal is on and already validated. It is never an auth failure: nothing is wiped,
and the app offers it behind a user action.

```ts
const r = await client.license.activateWithKey(key);
if (r.kind === "device-limit" && r.manageUrl) {
  const link = withManageReturn(
    withManageKey(r.manageUrl, key),
    "myapp://activated",
  );
  console.log(`Every seat is taken. Free one up at ${link}`);
}
```

`withManageKey` adds `#key=` only to an `/activate` link (a fragment never reaches a server);
`withManageReturn` adds `return=`, which the portal honours only for a declared return target. The
CLI prints the link on a device-limit refusal.

## Device-code sign-in

For a host that cannot complete a browser redirect — a CLI over SSH, a daemon, a game on a TV —
`client.identity` signs in with a device code (RFC 8628). It needs the Identity service
(`expectedServices` or discovery); with it off, every call throws `service-unavailable` before
any request. When this session's discovery says Identity is on but no sign-in provider is set up,
`beginSignIn` throws `disabled`, the Worker's own code, also before any request.

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
outside `[a-z0-9-]`) before any request, `unauthorized` (no token, or still 401), or one of the
[error codes](#errors): `not_found` for an unknown recipe, `rate_limited`, or `server-error` (a
`misconfigured` recipe arrives as its `wireCode`).

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

| `update` option     | Notes                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinnedReleaseKeys` | `{ kid -> raw Ed25519 key, base64url }`: the **only** keys a release record verifies against. Never merged with the trust pins, never persisted, never learned from the network.              |
| `outlet`            | A kind (`"direct"`, `"steam"`, …) or `{ id, kind, subkind? }`. Wins over `stamp` and `detected`. A Node CLI is never store-installed: `"direct"` (the Polaris Key outlet) is the usual value. |
| `stamp`, `detected` | The build stamp's outlet fields (`outlet`, `outletKind`, `outletSubkind`, `outletIds`), and a detection result the host computed itself, through `resolveUpdateOutlet`.                       |
| `detect`            | Default `true`: with no `outlet` and no `detected`, the client reads this process's signals (`readOutletSignals`) and runs `detectOutlet` over them and the stamp (below).                    |
| `packageName`       | The product's npm package name, so an `npx`, `npm` or `pnpm` launch from `node_modules/<packageName>/` counts as the `node.packageManager` signal.                                            |
| `format`            | The installed build's format; a binary build of another format is never offered. Default `null`.                                                                                              |
| `buildNumber`       | Informational in v4. Default `null`.                                                                                                                                                          |
| `methods`           | What the host can do with a `binary` answer: a subset of `native`, `download`, `sidecar-pck`. Default `["download"]`.                                                                         |
| `binaryVersion`     | The executable's version when it differs from `version` (after a code update). Defaults to `version`.                                                                                         |
| `engine`            | `godot-<major>.<minor>` for a host that runs Godot code packs; `null` otherwise.                                                                                                              |
| `platform`, `arch`  | Default to `os.platform()` / `os.arch()`'s canonical values; set them on an OS with none.                                                                                                     |

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
- **Floors never stop play.** `binary`, `store` and `platform` with `mandatory: true`, every
  `blocked {app-floor}` and every `blocked {content-floor}` are prompts the user cannot dismiss:
  show them as a persistent notice with no dismiss control over an app that keeps running, never
  as a window that covers it.
- **Revoked required content stops the boot.** When CI revokes a pack the build marks
  `required` and no usable replacement exists, the decision is `blocked {revoked-content}` (or an
  offer with `mandatory: true` and `contentBlock: "revoked-content"`) and its boot value is
  `required`. Show the host's own text instead of the generic update copy: "Some of this game's
  content was withdrawn by its developer and can't be used. Update the app to keep playing."
  (with the offer's button when the answer is an offer, none for `blocked`). A revoked optional
  pack is unmounted and play continues; `packs` answers are applied by the boot's fetch.
- `feed({channel})` returns the verified feed `decide()` would use, without the record;
  `releaseRecord(sha256)` verifies one record by hash (cross-checked and cached when a committed
  feed pins it). Handing off to Velopack, electron-updater or a self-replace is the host's.

## Packs (`client.update.packs`)

Downloadable content (plans/P4-01.md §2.6–§2.9): the running build's **content stamp** pins one
pack release per pack, and `client.update.packs` installs those releases into the platform data
directory. **A build without a stamp has no packs** — ship `pkey-content.json` (written by
`pkey release content-stamp`) among the app's own read-only resources, never a user-writable
path, and name it in the options:

```ts
const client = await PolarisKeyClient.create({
  // …
  update: {
    pinnedReleaseKeys: { "diceroll-release-2026": "…" },
    packs: {
      contentStamp: join(appResources, "pkey-content.json"),
      // Optional: packs this build ships, verified once and then used as installed state.
      embedded: [{ path: join(appResources, "pkey_packs", "diceroll.l10n") }],
      axes: { locale: ["fr", "en"] },
    },
  },
});
client.update.packs.on((p) => console.log(p.phase, p.done, p.total));
await client.update.packs.ensure(["diceroll.l10n"]);
const dir = await client.update.packs.path("diceroll.l10n"); // the running tree
```

- **What it trusts.** Each pinned pack record is fetched by hash (`release.endpoints.record`) and
  verified against `pinnedReleaseKeys` only, with `pin.kind: "pack"`; its objects come from
  `distribution.endpoints.blobs` with `Range`/`If-Range`, every stored SHA-256 and length checked
  before a byte is decoded. The device bearer goes only to the control plane's own origin.
- **Types.** `files.tree` is built in: hot, a versioned directory per payload
  (`<data>/packs/store/<packId>/<treeDigest>/`) and an atomic pointer swap in `state.json`.
  `registerHandler` adds others.
- **Strategies.** The planner picks `delta` (a whole-payload or per-file `zstd --patch-from`
  set), `file` (only the files whose hash is not installed) or `full`; a refused strategy falls
  back to the next, `full` last.
- **Feed-offered deltas** (P4-29). The committed channel feed can list lazy deltas (`deltas`, the
  Worker's delta menu). The client keeps the menu of the last feed `update.decide()` or
  `update.feed()` used, fresh or stale, and reads the committed feed from the cache when the
  pack engine starts, so an offline launch still has it. The engine (`feedDeltas`) adds the
  entries for a container's payload beside the record's own deltas; every byte is still checked
  against the CI-signed record, any failure (a 404 included) falls back, and at most one
  feed-offered delta is tried per install. Nothing to configure.
- **Progress events.** `on(listener)` receives `{packId, phase, done, total}` with `phase`
  `download`, `apply`, `done`, `state-issue` (once at load, see State below) or `fallback`
  (P4-18): a strategy failed (`strategy`, and the verdict code in `error`) and the next candidate
  runs, when there is one. A plan that later succeeds still reports the failure it recovered
  from; one with nothing left raises the first failure. (`via: "native"` appears only on the web,
  where the browser's own transport is tried first.)
- **zstd.** `node:zlib` decodes plain frames where it has zstd (22.15+), streaming a whole
  payload; `--patch-from` frames go through it only when a built-in prefix vector decodes at
  start-up (the dictionary option is ignored before 22.19 and in 24.0–24.5), else through
  `@polaris-key/zstd-wasm`. `client.update.packs.zstd()` says which.
- **Resume and state.** A dropped download keeps its journal; the next `ensure` resumes it, the
  staged bytes re-hashed. The state holds each pack record verbatim and is re-verified on every
  load, the payload included: **every load re-hashes the active and previous payloads**, so
  start-up cost grows with installed content. Payload files and `state.json` are fsynced before
  their renames (on macOS that is `fsync(2)`, not `F_FULLFSYNC`, which Node does not expose:
  the drive's own write cache can still lose the last writes on a power cut). "Cannot read" is
  never read as "missing": an EACCES or EIO on a payload keeps the install, out of use, for the
  next load that can read it. If a commit happens meanwhile, that unreadable install becomes
  `previous` (it is the most recent one), replacing an older verified `previous`; `rollback`
  re-verifies it and refuses while it is unreadable. While a torn state is held, the store
  listing taken when the hold began is saved as `state.json.torn.list` and reused at every
  restart, so storage stays bounded; an unreadable list, or a store directory that cannot be
  listed, suspends garbage collection entirely.
- **A state file that cannot be trusted loses nothing.** One that does not parse (a torn write)
  is moved aside as `state.json.torn`, and garbage collection is suspended while it exists:
  `state().stateIssue` is `torn`, and only `recoverState()` (an operator action) clears it and
  resumes collection. One that cannot be read at all (`stateIssue: "unreadable"`) is never
  written over: `ensure`, `confirm` and `rollback` raise `pack-state-unreadable` until a restart
  can read it. A payload whose check fails with an I/O error stays in the state and on disk but
  out of use for that load. `confirm()` marks a healthy boot, `rollback(packId)` restores the
  previous install, and garbage collection keeps active, previous, in-flight and embedded roots.
- **Boot.** `bootOptions()` gives the stage machine its `requiredPacks` and `essentialPacks`;
  `bootFetch({send, consent, metered, answer})` drives the FETCH stage with `fetch.consent`,
  `fetch.progress` and `fetch.done`.
- **Telemetry.** `devices/report` carries `content: {packSetId}`, the id of the pack releases
  running in this process.
- **Errors** are `PackError` (a `PolarisError` with `detail` and `path`): `not-configured`,
  `content-stamp-invalid`, `pack-not-pinned`, `record-rejected`, `record-mismatch`,
  `pack-type-unsupported`, `pack-not-entitled`, `pack-no-variant`, `pack-state-unreadable`, the
  `plan-*` and applier codes, `network-error`. `PackError` is exported from `@polaris-key/node`
  and `@polaris-key/node/packs`. Unlike the rest of the SDK (see [Errors](#errors)), a record or
  object fetch the server refuses, a 5xx included, is `network-error`, not `server-error`.
- **Delegated content** (P4-19). A compatible or standalone pack release signed by a delegated
  content key installs through the same engine: the delegation its `pkd1-` kid names is fetched
  from the record route (at most 16 per check, cached per process), verified against
  `pinnedReleaseKeys` only, and kept with the install for the reload. Every file must pass the
  data-only rule (an extension allow-list over the files index before any payload is fetched,
  then head and tail sniffs as each file is written); a refusal is `pack-not-data-only` with the
  `path`. A release under a revoked delegation is `pack-revoked`, detail `delegation`. Pins,
  holds, replacements and embedded baselines never take the delegated path. A `pinnedReleaseKeys`
  kid matching `pkd1-<64 hex>` is refused as `invalid-options`.

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

## CLI hooks: the terminal kit

`@polaris-key/node/cli` is the Node terminal kit. One call adds every Polaris Key verb to a
**commander** or **yargs** program and draws it on the kit's rail: the product chip in its accent,
masked key entry, sign-in in the browser or with a code (never a QR), the device limit's portal
hand-off, spinners and progress bars, grouped help and shell completion, and `--json` on every
verb. Both adapters build from one verb table (`CLI_VERBS`), so they never diverge.

```sh
npm install @polaris-key/node commander   # or yargs
```

```ts
import { Command } from "commander";
import { PolarisKeyClient } from "@polaris-key/node";
import { registerPolarisCommands } from "@polaris-key/node/cli";

const program = new Command("djdl");
registerPolarisCommands(
  program,
  (o) =>
    PolarisKeyClient.create({
      productSlug: o.productSlug,
      trust: { pinnedKeys: o.pinnedKeys },
    }),
  { productSlug: "djdl", pinnedKeys: { "pkey-djdl-prod-2026-06": "…" } },
);
await program.parseAsync();
```

The verbs, the styled parts and the `@polaris-key/node/terminal` primitives, the headless views,
theming, localisation, the `--json` contract and the fallbacks (`NO_COLOR`, `TERM=dumb`,
`--ascii`, CI, 60 columns) are on [Terminal (Node)](/docs/build/ui/frameworks/terminal-node/).
`kit: false` keeps the plain output, and each verb is also a plain function (`status(client)`,
`devicesList(client)`, …) returning `{ ok, message, data }`.

**Changed in the terminal kit (UK-14).** The adapters' human output is new: the rail, catalog
copy in the active locale (nine languages), colour on a terminal, and new verb names `login` and
`logout` (`sign-in` and `sign-out` still work). Human output is for people and may change between
releases; a script reads `--json`, whose envelope is versioned (`"v": 1`). The exit codes a script
saw before are unchanged: 0 success and 1 failure, with 2 for a usage error and 130 for Ctrl-C.
A key given as an argument to `activate` still works and now warns that it lands in the shell's
history; the prompt or a pipe is the way to pass it. A host that relied on the old plain messages
passes `kit: false`.

## Samples and recipes

Runnable samples live in the repository's `examples/` directory:
`node-express` (verify a client's licence on a backend), `node-cli` (a commander CLI with the full
kit and sign-in), `node-electron` (main, preload and the React kit over the bridge) and
`ui/terminal-node` (`tidewater`, the terminal kit's sample, on fixtures or `--live`).

- **Device limit reached.** `activateWithKey` answers `device-limit` with `limit` and
  `deviceCount`. The new device holds no credential, so a seat is freed from the account portal
  or from a device that holds one (`client.deauthorizeDevice(id)`, `devices deauthorize <id>`),
  then the key is entered again.
- **Attestation-gated products.** A product whose device-trust policy requires platform
  attestation refuses Node clients with `attestation-required`; Node has no attestation service.

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

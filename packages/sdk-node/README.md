# @plrs/node

The Node/TypeScript client for the **Polaris suite** — an always-on **Core** substrate (device
principal, credential, trust, verified cache, sync loop) plus one opt-in sub-client per service
(**License**, **Config**, **Devices**, **Release**, **Update**). **Offline-first**: `init()`
loads and re-verifies the cached signed documents with **no network**. The frozen wire crypto
(Ed25519 compact JWS) is verified through [`@plrs/client-core`](../client-core), the isomorphic
package the React SDK shares, and pinned byte-for-byte by the same cross-language conformance
corpus the Python and Swift SDKs run.

## Install

```sh
pnpm add @plrs/node
```

Node 22+. The OS keyring is an **optional** dependency (`@napi-rs/keyring`); without it the
token falls back to a `0600` file under the config dir.

## Quick start

```ts
import { PolarisClient } from "@plrs/node";

// Offline-first: create() loads the token + re-verifies the cached documents, no network.
const client = await PolarisClient.create({
  productSlug: "djdl",
  version: "1.4.2",
  trust: {
    pinnedKeys: {
      // kid -> raw Ed25519 public key (base64url). Pinned by the caller; NEVER read from
      // the document, and never learnable from the cache.
      "plrs-djdl-prod-2026-06": "REPLACE_WITH_DJDL_ED25519_PUBLIC_KEY_BASE64URL",
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

| Surface           | Subpath              | What it owns                                                                                                 |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `client.core`     | `@plrs/node/core`    | Device id, `plrst_` token, trust set, cache v3, monotonic clock floor, `sync()`, telemetry, bundle import      |
| `client.license`  | `@plrs/node/license` | `activateWithKey` / `enroll` / `deactivate` / `status` / entitlements / profile                              |
| `client.config`   | `@plrs/node/config`  | `getConfig` / `getConfigSource` / `listUserConfig` / `getSecret`                                              |
| `client.devices`  | `@plrs/node/devices` | `register` (keyless mint) / `list` / `rename` / `deauthorize` / `report`, plus the fingerprint + device-id formulas |
| `client.release`  | `@plrs/node/release` | `changelog` / `installUrl` / `downloadUrl`                                                                   |
| `client.update`   | `@plrs/node/update`  | `check` (version) / `appcastUrl` (from discovery)                                                            |
| —                 | `@plrs/node/local`   | The transportless profile: every network-requiring call refuses                                              |
| —                 | `@plrs/node/cli`     | Framework-agnostic commands + commander/yargs adapters                                                       |

Pure verification logic is **not** re-exported here. `verifyLicenseDoc`, `licenseState`,
`mergeTrust`, `verifyBundle`, `compareSemver` and friends live in `@plrs/client-core`; there is
one implementation, and every JS host consumes it.

### `CoreOptions`

| Option              | Notes                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `productSlug`       | The product slug; also the document `aud`. Scopes every route + the cache.                                  |
| `version`           | The **host application's** semver. Sent as `X-Polaris-Version`; the channel derives from it.                |
| `trust.pinnedKeys`  | `{ kid -> rawEd25519PubBase64url }`. Core-owned: it verifies licence documents, config documents, trust manifests and offline bundles alike. |
| `baseUrl`           | Control-plane origin (default `https://key.plrs.im`). Must be `https:` or loopback.                          |
| `channel`           | Override the channel (default derived from `version`).                                                       |
| `trustRefresh`      | Refresh the trust manifest on Core's own cadence inside `sync()` (default true).                             |
| `store`             | A `Store` (default `KeyringStore`; `InMemoryStore` for tests).                                                |
| `configDir`         | Where the file store writes (default `$XDG_CONFIG_HOME` or `~/.config`).                                     |
| `requestTimeoutMs`  | Per-request deadline (default 15000; `0` disables).                                                          |
| `expectedServices`  | What this build expects the product to run — the capability fallback when discovery has not been fetched.    |

Per-service inputs ride their own bags: `config: { localOverrides, envPrefix, env }`,
`license: { fingerprint }`, `devices: { probes, fingerprint }`.

## Capabilities, fail-closed

`client.capabilities()` resolves **without a network call**, in this precedence:

1. a discovery document loaded this session (`await client.discover()`) — always wins;
2. `expectedServices`;
3. the suite default: **License + Config on**, Release/Update/Identity **off**.

A service that is off refuses its sub-client (`PolarisError` code `service-unavailable`), and a
product with License off reports gate status **`not-applicable`** with `isLicensed() === true` —
a config-only product boots usable rather than sitting on `needs-activation` forever.

## `sync()`

One Core pass, in order: trust refresh (Core's own cadence, not a side effect of any document
fetch) → the **enabled** documents fetched **in parallel** with per-document ETag/304 and the
half-life re-ask → verification through client-core with per-type anti-replay floors → **one**
read-modify-write of the cache record → the clock floor → best-effort telemetry to
`POST /<product>/devices/report`. A 401 gets exactly **one** `POST /<product>/license/token`
re-acquire for the whole pass, then one retry of the failed fetch.

`client.getSyncState()` returns `{ activation, doc, lastSyncUnauthorized, blocked,
lastVerifiedAt, highWaterMark }` — the snapshot the React bridge renders from.

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

### The `PLRS_CONFIG_*` env convention

An override env var is `${envPrefix}${key.replaceAll(".", "__")}` (dots → double underscores):

| Config key        | Env var                        |
| ----------------- | ------------------------------ |
| `run.concurrency` | `PLRS_CONFIG_run__concurrency` |
| `quality.floor`   | `PLRS_CONFIG_quality__floor`   |

The value is JSON-parsed when it looks like JSON (`4` → number, `true` → boolean, `[…]`/`{…}` →
array/object, `"…"` → string); otherwise it is the raw string. Malformed JSON-looking values fall
back to the raw string.

## Offline depths

1. **Online with grace** — the default. Documents carry a short `expiresAt` and a long,
   server-signed `graceUntil`.
2. **Bundle-activated** — `await client.importBundle(jws)` verifies an operator-minted
   `plrs-bundle+jws` against the pinned keys, **all-or-nothing**, and writes the cache atomically.
   No token is created; the gate reads `activation: "bundle"`. A rejection throws a
   `PolarisError` naming the step that refused.
3. **Local-only** — `@plrs/node/local`'s `createLocalClient` / `createBundleClient`. There is no
   transport at all: config resolution, the gate and bundle import work, and every
   network-requiring call throws `PolarisError` code `local-only`.

## CLI hooks

`@plrs/node/cli` exposes a framework-agnostic command core plus thin **commander** and **yargs**
adapters over the same core, so the two front ends never diverge. Verbs are grouped by owning
service — `activate` / `enroll` / `deactivate` / `status` (license), `register` (devices),
`config <key>` (config), `import-bundle <file>` (core):

```ts
import { Command } from "commander";
import { PolarisClient } from "@plrs/node";
import { registerPolarisCommands } from "@plrs/node/cli";

const program = new Command();
registerPolarisCommands(program, (opts) => PolarisClient.create(opts), {
  pinnedKeys: { "plrs-djdl-prod-2026-06": "…" },
  productSlug: "djdl",
  version: "1.4.2",
});
program.parseAsync(process.argv);
```

## The frozen wire contract

Documents are compact **JWS (EdDSA / Ed25519)**, domain-separated by `typ`
(`plrs-license+jws`, `plrs-config+jws`, `plrs-trust+jws`, `plrs-bundle+jws`). The verifying key
is chosen by the header `kid` from the pinned trust set — never from the document, and never
from the cache. The encoding and every claim rule are pinned by
`conformance/corpus/v2/cases.json`, which this SDK, the worker, and the other three SDKs verify
identically. See `docs/security/WIRE-CONTRACT-V3.md`.

## Develop

```sh
pnpm --filter @plrs/node typecheck
pnpm --filter @plrs/node test
pnpm --filter @plrs/node build
```

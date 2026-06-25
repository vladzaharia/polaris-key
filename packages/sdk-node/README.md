# @polaris-key/node

The full Node/TypeScript client for **Polaris Key** — product-agnostic licensing +
remotely-managed config. A small facade over enroll → fetch → verify → cache → gate that is
**offline-first**: `create()` applies the cached signed doc with **no network**; `refresh()`
re-pulls and re-applies. The frozen wire crypto (Ed25519 compact JWS) is verified locally and
pinned by the same cross-language conformance corpus as the Python, Swift, and React SDKs.

## Install

```sh
pnpm add @polaris-key/node
```

Node 22+. The OS keyring is an **optional** dependency (`@napi-rs/keyring`); without it the
token falls back to a `0600` file under the config dir.

## Quick start — gate a feature + read layered config

```ts
import { PolarisKeyClient } from "@polaris-key/node";

// Offline-first: create() loads token + cached doc with no network call.
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version: "1.4.2",
  trust: {
    pinnedKeys: {
      // kid -> raw Ed25519 public key (base64url). Pinned by the caller; NEVER read
      // from the document.
      "pkey-djdl-prod-2026-06":
        "REPLACE_WITH_DJDL_ED25519_PUBLIC_KEY_BASE64URL",
    },
  },
});

// Gate: true only when the cached license is usable (ok or grace).
if (!client.isLicensed()) {
  const r = await client.activateWithKey(userEnteredKey); // exchange key -> token, refresh
  if (r.kind !== "ok") throw new Error("activation failed");
}

// Layered config read: enforced|hidden > local > env > remote-default > fallback.
const concurrency = client.getConfig<number>("run.concurrency", 3);
const where = client.getConfigSource("run.concurrency"); // "remote-default" | "env" | ...

// Secrets are delivered redacted-in-UI but usable here; entitlements are boolean flags.
const vpnUrl = client.getSecret("proxy.subscriptionUrl");
const hasVpn = client.isEntitled("polarisVpn");

// Re-pull managed config online (single /token re-acquire on 401), then re-apply.
await client.refresh();
```

## Client API

Construct with `PolarisKeyClient.create(opts)` (async; runs `init()`), or `new
PolarisKeyClient(opts)` then `await client.init()`.

### `PolarisKeyOptions`

| Option             | Notes                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `productSlug`      | The product slug; also the doc `aud`. Scopes every route + cache.                                                            |
| `version`          | This client's semver; sent on `/config` and used to derive the channel.                                                      |
| `trust.pinnedKeys` | `{ kid -> rawEd25519PubBase64url }`. The verifying key is chosen by the header `kid` from this set, never from the document. |
| `baseUrl`          | Control-plane origin (default `https://key.plrs.im`).                                                                        |
| `channel`          | Override the channel (default derived from `version`).                                                                       |
| `store`            | A `Store` (default `FileStore`; `InMemoryStore` for tests).                                                                  |
| `configDir`        | Where the file store writes (default `$XDG_CONFIG_HOME` or `~/.config`).                                                     |
| `localOverrides`   | User/local config overrides (beat a `default`, never an `enforced`/`hidden`).                                                |
| `envPrefix`        | Env-var prefix for overrides (default `PKEY_CONFIG_`).                                                                       |
| `env`              | Env table to read overrides from (default `process.env`).                                                                    |

### Reads (no network)

| Method                        | Returns                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `status(now?)`                | `LicenseState` — gate status (`ok`/`grace`/`login`/`expired`/`revoked`/version-block/…). |
| `isLicensed(now?)`            | `boolean` — true iff the status is usable (`ok` or `grace`).                             |
| `getConfig<T>(key, fallback)` | The effective value per the precedence below.                                            |
| `getConfigSource(key)`        | Where `getConfig` sourced the value (for settings/diagnostics UIs).                      |
| `listUserConfig()`            | Catalog entries minus `hidden` ones, each `{ key, value, enforced }`.                    |
| `getSecret(key)`              | A managed secret string, or `null`.                                                      |
| `isEntitled(name)`            | `boolean` — true iff the `flag` entitlement is present and `=== true`.                   |
| `getEntitlements()`           | `Record<string, JSONValue>` of all entitlement values.                                   |
| `getProfile()`                | The signed `DocProfile` (name/email), or `null`.                                         |

### Enrollment + refresh (network)

| Method                 | Effect                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activateWithKey(key)` | Exchange a `pkey_…` key → device token, persist it, then `refresh({ force })`. Returns an `EnrollResult` (`ok` / device-limit / unauthorized / error).                                         |
| `refresh({ force? })`  | Re-pull `/config` (304-aware via ETag; one `/token` re-acquire on 401), verify, re-apply, and best-effort report a usage snapshot. Returns `{ applied, unauthorized?, blocked?, deviceCap? }`. |
| `deactivate()`         | Best-effort server deauthorize, then wipe the local token + cache.                                                                                                                             |

## Layered config precedence

The signed remote doc carries, per key, a `ManagedEntry` with a management `state`
(`default` | `enforced` | `hidden`). The client honors that state and otherwise layers
local + environment overrides on top of the remote value:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

- **`enforced` / `hidden`** values are **locked to the server** — `localOverrides` and env
  vars are ignored for those keys (the remote value still wins). `hidden` additionally means
  the key is withheld from `listUserConfig()` (but is still applied by `getConfig`).
- A **`default`** (or an absent) key can be overridden by a local override, then by an env
  var, then falls back to the remote value, then to the caller's `fallback`.

### The `PKEY_CONFIG_*` env convention

An override env var is `${envPrefix}${key.replaceAll(".", "__")}` (dots → double
underscores). With the default prefix:

| Config key        | Env var                        |
| ----------------- | ------------------------------ |
| `run.concurrency` | `PKEY_CONFIG_run__concurrency` |
| `quality.floor`   | `PKEY_CONFIG_quality__floor`   |
| `outputDir`       | `PKEY_CONFIG_outputDir`        |

The value is JSON-parsed when it looks like JSON (`4` → number, `true` → boolean, `[…]`/`{…}`
→ array/object, `"…"` → string); otherwise it is taken as the raw string. Malformed
JSON-looking values fall back to the raw string.

## CLI hooks

`@polaris-key/node/cli` exposes a framework-agnostic command **core** (`activate` /
`deactivate` / `status`, each taking a `PolarisKeyClient` and returning a result with an exit
code + output lines) plus thin **commander** and **yargs** adapters that wrap the same core,
so the two front ends never diverge. Register the commands onto your own program:

```ts
import { Command } from "commander";
import { registerPolarisCommands } from "@polaris-key/node/cli";

const program = new Command();
// Adds `activate <key>`, `deactivate`, and `status` subcommands. Trust keys are passed as
// repeatable `--trust kid=rawBase64url` pairs so the CLI stays product-agnostic.
registerPolarisCommands(program, { product: "djdl", version: "1.4.2" });
program.parseAsync(process.argv);
```

The yargs adapter mirrors the same surface for projects already on yargs. Each subcommand
constructs a client, runs the shared core command, prints its lines, and exits with its code.

## The frozen wire contract

The managed-config document is a compact **JWS (EdDSA / Ed25519)**. The verifying key is
chosen by the header `kid` from the pinned trust set (never the document); `alg` is asserted
`EdDSA` before any signature math; the payload (`ManagedConfigDoc`) is product-scoped via
`aud` + `iss`. The encoding is pinned byte-for-byte by `conformance/corpus/v1/cases.json`,
which this SDK and the worker verify identically. See the root `README.md` and
`docs/CONCEPTS.md`.

## Develop

```sh
pnpm --filter @polaris-key/node typecheck
pnpm --filter @polaris-key/node test
pnpm --filter @polaris-key/node build
```

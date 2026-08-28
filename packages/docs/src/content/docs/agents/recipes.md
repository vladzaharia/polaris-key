---
title: "Task recipes"
description: "Six common Polaris Key tasks as task, steps, and verify — each pointing at the deep page and ending in a real command."
sidebar:
  order: 2
---

Six things people most often ask an agent to do. Each recipe is the **shortest correct path**,
not the full explanation — the deep page beside each heading is the explanation, and the command
at the end is what proves the work.

Read [`AGENTS.md`](/docs/agents/) in the repo first. Everything below assumes its hard rules,
especially: products are data, never code; the wire contract is the source of truth; and
generated files are regenerated, never edited.

All `pnpm` commands assume Node 22. If your default is newer, prefix them with
`mise exec node@22 --`.

## 1. Author a `.pkey/` manifest

Deep page: [The `.pkey/` manifest](/docs/build/manifest/) · Skill: `authoring-pkey-manifests`

| #   | Step                    | Detail                                                                                                                                                                                                       |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Scaffold                | `pkey init --product <slug> --name "<Name>" --modules licensing,config` writes `.pkey/product.yaml`, plus `schema.yaml` and `release.yaml` for the modules you selected                                      |
| 2   | Get editor help         | The scaffold's `# yaml-language-server: $schema=…` header points at a **path** into `node_modules/@polaris-key/manifest/schemas/v1/` — the canonical `$id` URLs are on this gated site and cannot be fetched |
| 3   | Fill in the three roles | `schema` = the config catalog · `product` = metadata, `modules`, `devices.registration`, OIDC, tiers, profiles, provisioning · `release` = provider coordinates and edge-mint recipes                        |
| 4   | Avoid a reserved slug   | `docs`, `manage`, `api`, `assets`, `login`, `logout`, `callback`, `magic`, `download`, `webhooks`, `well-known` are refused with `reserved_slug`                                                             |
| 5   | Validate until clean    | Fix every `error`; read the `warning` lines rather than ignoring them                                                                                                                                        |

```sh
pkey validate      # exit 0, no error lines
```

## 2. Enable a service for a product

Deep page: [Service enablement](/docs/admin/services-enablement/)

| #   | Step                          | Detail                                                                                                                                                                                               |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Choose the path               | Manifest baseline (edit `.pkey/product`'s `modules` and push) or a live console toggle in **Product → Services**                                                                                     |
| 2   | Know the ownership cost       | A live toggle claims the column: `services_source` flips `manifest` → `admin`, and later resyncs skip the block. "Revert to manifest" hands ownership back and changes nothing until the next resync |
| 3   | Satisfy coherence             | The set is validated as a set: `update_requires_release`, `registration_requires_identity`, `config_without_activation`. Each is a relationship between two toggles, so no single flag can be blamed |
| 4   | Check registration policy     | `devices.registration` is optional; undeclared derives `requires-license` → `requires-identity` → `open` from the enabled services                                                                   |
| 5   | Confirm the projections agree | Route mounting, discovery, the console nav and portal capabilities all read `services_json`; a disabled service 404s rather than 403s                                                                |

```sh
curl -s https://key.plrs.im/<product>/.well-known/polaris.json | jq .services
```

## 3. Add a catalog entry

Deep page: [The config catalog](/docs/services/config/catalog/) · Skill: `adding-a-catalog-entry`

| #   | Step                      | Detail                                                                                                                                                                                               |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pick the kind             | `config` = plaintext client setting · `secret` = redacted, keyring-delivered · `flag` = an entitlement, which rides the **license** document only                                                    |
| 2   | Write the schema fragment | A Draft-07 **subset**. An unimplemented keyword or format makes the fragment unsupported — a 422 at publish, and a pruned value at request time. Never silently ignored, and `$ref` is not supported |
| 3   | Pick enforcement          | `managementDefault` on config kinds: `default` overridable · `enforced` server wins · `hidden` enforced and withheld from enumeration                                                                |
| 4   | Pick delivery             | `delivery` on secret kinds: `serverOnly` · `clientScoped` · `edgeMint`. Setting it on a non-secret entry is an error                                                                                 |
| 5   | Decide on `schemaVersion` | Bump **only** on an incompatible shape change — adding a key is not one                                                                                                                              |
| 6   | Publish                   | Push `.pkey/schema` (webhook resync, keeps the repo authoritative) or **Catalog → Publish new version** in the console                                                                               |

```sh
pnpm --filter @polaris-key/manifest test
```

## 4. Change a tier's policy

Deep page: [Tiers and the license model](/docs/services/license/model/)

| #   | Step                 | Detail                                                                                                                                                                                                          |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Find the fields      | A tier is `id`, `label`, an optional `profileId`, and policy: `policyExpiryDays`, `policyDeviceLimit`, `policyFingerprint`, `channels`, `minVersion`, `maxVersion`                                              |
| 2   | Choose the path      | Manifest baseline in `.pkey/product`'s `licensing.tiers[]`, or the console's **License → Tiers** editor                                                                                                         |
| 3   | Fingerprint strength | `policyFingerprint` is `off` · `lenient` (4) · `normal` (2) · `strict` (0, and a fingerprint becomes mandatory). `null` inherits the product default — see [fingerprint policy](/docs/services/license/policy/) |
| 4   | Expect no push       | Running clients pick up new entitlements on their next license-document refresh; nothing is pushed to them                                                                                                      |
| 5   | Mind downgrades      | Re-licensing below the active device count **grandfathers** existing devices and refuses new activations until the count drops                                                                                  |

```sh
pkey validate      # after a manifest edit; then resync or push
```

## 5. Integrate the Node SDK, minimally

Deep page: [The Node SDK](/docs/build/sdks/node/)

| #   | Step                            | Detail                                                                                                                                                                                                               |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Construct                       | `PolarisKeyClient.create()` performs **no network** — it loads the device id, token and cached documents and re-verifies them, so an offline-first host can render its gate before it ever reaches the control plane |
| 2   | Pass the required options       | `productSlug`, `version` (the **host app's** semver — what `X-PKey-Version` and the build gate read), `trust.pinnedKeys` (kid → raw Ed25519 public key, compiled in), `expectedServices`                             |
| 3   | Discover, then sync             | `await client.discover()` installs the real capability map; `await client.sync()` does trust refresh → enabled documents in parallel → verify → one cache write → clock floor                                        |
| 4   | Call through sub-clients        | `client.license.*`, `client.config.*`, `client.devices.*`, `client.release.*`, `client.update.*`; facade-level calls stay for what a host does before it knows which service it is talking to                        |
| 5   | Expect fail-closed capabilities | A sub-client whose service is off throws `PolarisError` with `service-unavailable`. With License off, the gate is `not-applicable` and `isLicensed()` is `true`, so a config-only product boots usable               |

```ts
const client = await PolarisKeyClient.create({
  productSlug: "djdl",
  version: appVersion,
  trust: { pinnedKeys },
  expectedServices: ["license", "config"],
});
await client.discover();
await client.sync();
```

```sh
pnpm --filter @polaris-key/node test
```

## 6. Mint an offline bundle

Deep page: [Offline bundles](/docs/build/offline/) · Console: [Bundles](/docs/admin/bundles/)

| #   | Step                  | Detail                                                                                                                                                                                                                                          |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Get an admin session  | The admin API is authenticated by the console's browser session — there is no API token. Export the cookie as `PKEY_ADMIN_COOKIE`. It is short-lived and carries **full admin authority**: never commit it, never export it into a shared shell |
| 2   | Mint                  | `pkey bundle` writes `<product>-<first 8 of device id>.pkeybundle`; `--base-url` defaults to `https://key.plrs.im`                                                                                                                              |
| 3   | Know what rides along | `bundleId`, `deviceId`, `docs` (a license document, a config document, or both — decided **server-side** by the product's enabled services) and the trust manifest                                                                              |
| 4   | Transfer and import   | Copy the file to the air-gapped machine and import it there. A verified bundle satisfies activation with no `pkeyt_` token anywhere                                                                                                             |
| 5   | Expect all-or-nothing | Import verifies against pins, then the trust manifest, then each inner document, and only then writes the cache — there is no partial import                                                                                                    |

```sh
PKEY_ADMIN_COOKIE='__Host-pkey_admin=<value>' \
  pkey bundle --product <slug> --device <deviceId> --grace-days 30
```

Valueless flags (`--no-config`, `--force`) swallow the next bare word — pass them last, or as
`--no-config=true`.

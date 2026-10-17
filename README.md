# Polaris Key

Licensing, remotely managed config and release delivery for apps and games: one Cloudflare Worker
at `key.plrs.im` and SDKs for Node, React, Python, Swift, Godot and Kotlin. Products register as
data (a `.pkey/` manifest, no redeploy) and turn on only the services they use. Every document
the Worker signs is a compact EdDSA JWS that each SDK verifies offline, byte for byte alike.

An always-on **Core** (product registry, device principal, trust and signing, discovery, rate
limiting, audit) carries seven opt-in services: **License**, **Config**, **Release**,
**Distribution**, **Update**, **Identity** and **Cloud Sync**. The concepts page defines the
terms: [Concepts](https://key.plrs.im/docs/start/concepts/).

## Start here

| You want to…                        | Start at                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Use an SDK** in your app          | [Install from the feeds](https://key.plrs.im/docs/build/install/), then your SDK's README: [`sdk-node`](packages/sdk-node), [`sdk-react`](packages/sdk-react), [`sdks/python`](sdks/python), [`sdks/swift`](sdks/swift), [`sdks/godot`](sdks/godot), [`sdks/kotlin`](sdks/kotlin). Runnable samples: [`examples/`](examples) |
| **Run a product** on the platform   | [Your first product](https://key.plrs.im/docs/start/first-product/), the [`.pkey/` manifest](https://key.plrs.im/docs/build/manifest/) and the [`pkey` CLI](packages/cli). Operating the Worker: [`docs/RUNBOOK.md`](docs/RUNBOOK.md), [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)                                            |
| **Change the platform** (this repo) | [`AGENTS.md`](AGENTS.md) (the rules and the green gate), [`CONTRIBUTING.md`](CONTRIBUTING.md), then the README of the directory you are changing                                                                                                                                                                             |

Report a vulnerability through [`SECURITY.md`](SECURITY.md).

## Layout

```
packages/
  shared-protocol/   @polaris-key/protocol     per-service wire types
  shared-jws/        @polaris-key/jws          frozen EdDSA compact-JWS encode/verify
  shared-catalog/    @polaris-key/catalog      config catalog + value validation
  shared-manifest/   @polaris-key/manifest     `.pkey/` manifest parsing, validation, schemas
  client-core/       @polaris-key/client-core  isomorphic verify/trust/gate/clock floor
  ui-core/           @polaris-key/ui-core      the JS UI kits' headless layer
  elements/          @polaris-key/elements     the UI kit as web components
  worker/            @polaris-key/worker       the Worker: platform/, core/, services/<slug>/, console/
  admin/             @polaris-key/admin        the admin SPA and customer portal
  cli/               @polaris-key/cli          the `pkey` CLI
  sdk-node/          @polaris-key/node         Node SDK and CLI adapters
  sdk-react/         @polaris-key/react        React SDK and login UI
  server/            @polaris-key/server       licence-gated routes: Fetch core, Express, Hono, Next.js
  docs/              @polaris-key/docs         the docs site served at /docs
  brand/             @polaris-key/brand        design tokens, fonts, marks, launch-kit assets
  ui-qa/             @polaris-key/ui-qa        UI-kit visual QA and lints
  zstd-wasm/         @polaris-key/zstd-wasm    libzstd for wasm32, decoder and delta encoder
sdks/
  python/            polaris-key (PyPI)
  swift/             PolarisKey (SwiftPM)
  godot/             the Godot addon
  kotlin/            the Gradle build: JVM modules, Android backend and Compose kit
conformance/         corpus/v2 golden vectors, parity registry, HTTP transcripts, runners
tools/               generators (the registry is tools/generators.ts), parity check, corpus signer
products/            per-product catalog and manifest fixtures
actions/publish/     the polaris-key/publish GitHub Action
examples/            runnable samples
docs/                RUNBOOK, DEPLOYMENT, PRIVACY; security/ (threat model, wire contract); research/
```

`pnpm-workspace.yaml` lists the JS workspace. `tools/package-metadata.test.ts` and
`tools/root-readme.test.ts` keep this block and every published package's metadata true.

## Docs by door

| Door       | For                                        | Where                                                                                                |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Developers | Integrating an SDK, writing a manifest, CI | [`key.plrs.im/docs`](https://key.plrs.im/docs/start/): `start/`, `build/`, `features/`, `reference/` |
| Operate    | Console members and platform admins        | `packages/docs/src/content/docs/operate/`, behind a console session                                  |
| Help       | People using an app built on Polaris Key   | `packages/docs/src/content/docs/help/`                                                               |
| Contribute | Working on this repo                       | `packages/docs/src/content/docs/contribute/` (admin tier), and [`AGENTS.md`](AGENTS.md)              |

Every wire-format rule is in [`docs/security/WIRE-CONTRACT-V4.md`](docs/security/WIRE-CONTRACT-V4.md);
the threat model is [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md).

## Develop

```sh
pnpm install
pnpm build
pnpm test
pnpm gen --check    # every generator's drift gate
```

Run the JS suites on **Node 22** (`mise exec node@22 -- pnpm test`): the Worker suite drives D1
through the native `better-sqlite3`, which a newer Node major cannot build. The other toolchains
(Python, Swift, Godot, Kotlin), the full green gate and the rules every change follows are in
[`AGENTS.md`](AGENTS.md).

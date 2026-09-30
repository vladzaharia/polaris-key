# P1b-07 Close licence, config and release gaps: `entitledChannels`, catalog fetch, release client, React bundle import and telemetry

| Field       | Value                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                                                                               |
| Size        | 1–1.5 engineer-weeks (tight: see Design notes for the split point)                                                            |
| Depends on  | [P1b-03](P1b-03-http-transcripts.md)                                                                                          |
| Unblocks    | none                                                                                                                          |
| Role        | `pkey-sdk-porter` (see `.claude/agents/`)                                                                                     |
| Plan mode   | no                                                                                                                            |
| Gates       | all SDKs; new transcripts through P1b-03's harness (`pnpm gen:transcripts -- --check`); `pnpm parity:check`; Swift `Package.swift` |
| Human input | none                                                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                                                     |

## Goal

Five PARITY §8 gaps are closed with one behaviour per capability across SDKs:

1. `entitledChannels()` exists in Node, Python and React with the Worker's semantics, and Swift is
   aligned to them.
2. The catalog fetch (`GET /<p>/config/schema`) exists in Node, Python and React.
3. Swift and React gain the release client Node and Python have (changelog, install URL, download
   URL).
4. React can import an offline bundle, in desktop mode through the host and in the browser through
   `client-core`.
5. React's desktop mode can send device telemetry.

Each is proven by a tagged test or a transcript, and the manifests say `implemented`.

## Why

These are the licence, config and release rows of
[PARITY §8](../../PARITY.md#8-parity-gaps-to-close-now), with current state in
[§5.1–§5.5](../../PARITY.md#5-the-feature-inventory) and
[notes/A2 §9](../../notes/A2-sdk-port.md#9-parity-matrix-scope-addition-a). Each already exists in at
least one SDK, so this is porting, not design, with one semantic fix (`entitledChannels`).

## Read first

- `AGENTS.md`, `CLAUDE.md`; [PARITY §5.2](../../PARITY.md#52-license),
  [§5.3](../../PARITY.md#53-config), [§5.5](../../PARITY.md#55-release-and-update).
- Channels: `sdks/swift/Sources/PolarisKeyLicense/LicenseClient.swift:111-118`,
  `sdks/swift/Sources/PolarisKeyUpdate/UpdateFeed.swift:50-52,81-100`,
  `packages/worker/src/core/entitlements.ts:109-113`, and the [P0-04](P0-04-channel-unification.md)
  brief (the channel vocabulary may change under you).
- Catalog: `sdks/swift/Sources/PolarisKeyConfig/Fetch.swift` (`fetchSchema`),
  `sdks/swift/Sources/PolarisKeyCore/Endpoints.swift:105`,
  `packages/worker/src/services/config/schema.ts`, `packages/shared-catalog` (`ProductCatalog`),
  `packages/sdk-react/src/desktop/bridge.ts:128` (the optional `fetchSchema`).
- Release: `packages/sdk-node/src/release/client.ts` (the reference),
  `sdks/python/src/polaris_key/release/client.py`, `sdks/swift/Sources/PolarisKeyCore/Endpoints.swift:115-116`,
  `sdks/swift/Package.swift` (targets), the [P2-05](P2-05-release-routes.md) brief (these routes grow
  later).
- Bundles: `packages/client-core/src/bundle.ts` (`inspectBundle`, `verifyBundle`),
  `packages/sdk-node/src/core/bundle.ts`, `packages/sdk-react/src/desktop/bridge.ts`
  (`PolarisBridge`, `BRIDGE_VERSION = 2`, `invoke`), `src/core/types.ts` (`PolarisAdapter`),
  `src/browser/browserAdapter.ts` (the header comment says a browser can never be bundle-activated
  today), [PARITY §7](../../PARITY.md#7-runtime-limits-that-become-typed-nas) (a random device id in
  IndexedDB on the web).
- Telemetry: `packages/sdk-node/src/devices/client.ts` (`report()`),
  `packages/worker/src/core/devices.ts:964` (`handleReport`, bearer only), and the report allowlist
  above it.

## Scope

**In:**

- **Channels.**
  - Node `client.license.entitledChannels(): string[]`, Python `license.entitled_channels()`, and
    React `useLicense().entitledChannels` plus the adapter read.
  - Swift keeps its name, but its empty-entitlement answer changes (see Design notes).
  - Unit tests in every SDK over the same fixture set.
- **Catalog fetch.**
  - Node `client.config.fetchSchema(): Promise<ProductCatalog | null>` and Python
    `config.fetch_schema()`.
  - React: an adapter method `fetchSchema()`, desktop through the bridge's `fetchSchema`, browser as a
    direct fetch.
  - All of them are unsigned, unauthenticated and diagnostic: `null` on any failure, never a throw
    for a network error, as Swift does.
- **Release client.**
  - Swift: a new library target `PolarisKeyRelease` (depends on Core, not macOS-only), with
    `changelog()`, `installURL()` and `downloadURL(version:binary:arch:checksum:dmg:)`.
  - React: adapter `changelog()` and `downloadUrl()`, plus a `useChangelog()` hook.
  - Behaviour as Node: `service-unavailable` when Release is off (D-21); the bearer forwarded when
    held; a 403 body's code surfaced.
- **React bundle import.**
  - Desktop: an optional bridge method `importBundle(jws)` (bump `BRIDGE_VERSION` to 3; an older host
    reports it unsupported) that calls the host's Node `client.importBundle`.
  - Browser: `client-core`'s `inspectBundle` against a random device id and a cache record kept in
    IndexedDB, giving `activation: "bundle"` in the gate input.
  - A `useImportBundle()` hook.
- **React telemetry (desktop).** `report()` through `invoke("devices", "report")`.
- **Swift `devices.report`.** Expose the snapshot report as public API (today it runs only inside
  sync, PARITY §5.4 footnote 3).
- **Transcripts** through P1b-03's harness: `config-schema-fetch`, and `release-changelog` covering
  the changelog and the entitled 403.
- Manifests and tags; the SDK docs pages (`build/sdks/*.mdx`).

**Out** (and where it belongs instead):

- CORS for cross-origin browser calls (→ [P0-05](P0-05-cors.md)); browser tests use same-origin
  fakes.
- Browser telemetry. `POST /<p>/devices/report` accepts only a bearer and the browser holds a cookie
  session, so it needs a Worker change with no owner yet; declare it per P1b-01's decision.
- Per-platform and generic release routes (→ [P2-05](P2-05-release-routes.md), which extends every
  SDK's release client).
- A corpus case pinning `entitledChannels`. It is plan-mode, so propose it for P0-04's gate-matrix
  plan or a later corpus plan.
- React `core.local` and React `config.mint` (unowned; see P1b-01), and device-code and edge-mint
  (→ [P1b-08](P1b-08-devicecode-edgemint-ports.md)).

## Design notes

**`entitledChannels` semantics.** The Worker is the authority: `entitledChannels(entitlements)`
returns the `channels` entitlement's string values, or `["stable"]` when it is absent
(`core/entitlements.ts:109-113`). Swift returns `[]` when absent (`LicenseClient.swift:113-118`).

- Every SDK returns the Worker's answer: string values only, in order, deduplicated, and `["stable"]`
  when the entitlement is absent or not an array.
- Swift's `UpdateFeed.allowedChannels(from:)` already treats empty as "stable only", so change
  `LicenseClient.entitledChannels()` and check `SparkleUpdater.swift:45`. Record it in the Swift
  changelog.
- If P0-04 has landed, use its vocabulary.
- **Proof.** The PARITY row says `cases.json`, but no corpus case asserts channels, so the proof is
  unit tests over identical fixtures until a corpus case exists.

**Catalog type.** Return the parsed `ProductCatalog` shape from `@polaris-key/catalog` in TypeScript,
a `dict` in Python, and keep Swift's `Data`. Nothing security-relevant is read from it (Swift's
`Fetch.swift` comment).

**Browser bundle import is the split point.** The browser adapter is online-only today, and its state
comes from the identity session. The bundle path adds a small IndexedDB store (device id, verified
bundle JWS, `importedBundle`) and an offline branch in `projectState`. If that half goes past about
two days, ship everything else and split the browser half into its own PR, recording the size change
for the lead.

**Swift target.** Follow the package's per-service split (`Package.swift` header comment): add
`PolarisKeyRelease` to `products` and `targets`, add it to the test target's dependencies, and
re-export it from the umbrella only if the other service modules are.

## Steps

1. Add the two transcripts with P1b-03's harness and regenerate.
2. Channels: Node, Python, React, then the Swift change; one commit each with tests.
3. Catalog fetch: Node, Python, React.
4. Release client: Swift target, then React.
5. React bundle import (desktop, then browser) and desktop telemetry; Swift public `report()`.
6. Update the manifests, tags and SDK docs pages; run the green gate.

## Acceptance criteria

- [ ] For the same fixtures, every SDK's `entitledChannels` returns identical lists, including
      `["stable"]` when the entitlement is absent.
- [ ] `config-schema-fetch` replays green in Node, Python, Swift and React, and a failed fetch returns
      `null` without throwing.
- [ ] `release-changelog` replays green in Node, Python, Swift and React; Swift's
      `PolarisKeyRelease` builds on macOS and iOS, and a disabled Release raises `service-unavailable`
      in every SDK.
- [ ] React imports a corpus bundle vector in the desktop adapter (bridge fixture) and in the browser
      adapter (fake IndexedDB), and the gate reports `activation: "bundle"`.
- [ ] React's desktop `report()` reaches the bridge's `invoke("devices", "report")`.
- [ ] `parity.json` manifests are updated for every SDK this changes (`license.channels`,
      `config.schema`, `release.changelog`, `release.download`, `core.bundle`, `devices.report`), and
      `pnpm parity:check` passes.
- [ ] The green gate passes (`AGENTS.md`), including `pnpm gen:transcripts -- --check`.

## Verify

```sh
mise exec node@22 -- pnpm gen:transcripts -- --check
mise exec node@22 -- pnpm --filter @polaris-key/node test
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm --filter @polaris-key/conformance-node test
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift build && swift test )
```

## Hand-off

- **Interfaces:** `entitledChannels()` / `entitled_channels()` with the Worker's default; `fetchSchema()`
  / `fetch_schema()`; Swift `PolarisKeyRelease`; React `useChangelog`, `useImportBundle`, adapter
  `fetchSchema`, `changelog`, `downloadUrl`, `importBundle`; bridge protocol v3's `importBundle`.
- [P2-05](P2-05-release-routes.md) extends the release clients in every SDK, including Swift's new
  target. Godot (P1-03, P1-04, P1-08) matches these names in snake_case.
- Set the status: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-07 done`.

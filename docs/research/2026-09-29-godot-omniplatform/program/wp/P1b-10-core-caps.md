# P1b-10 Typed "unsupported here" results and `supports()` in every SDK

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Phase       | P1b: SDK parity                                                        |
| Size        | 0.5–1 engineer-weeks                                                   |
| Depends on  | [P1b-01](P1b-01-parity-registry.md), [P1b-02](P1b-02-sdk-constants.md) |
| Unblocks    | none                                                                   |
| Role        | `pkey-sdk-porter`                                                      |
| Plan mode   | no. It is SDK surface only, with no wire, document or corpus change    |
| Gates       | all SDKs (Node, React/`client-core`, Python, Swift); `parity:check`    |
| Human input | none                                                                   |
| Repo        | `vladzaharia/polaris-key`                                              |

## Goal

Every SDK exposes `supports(featureId)`, which returns `Supported` or
`Unsupported { feature, reason, detail }`. Every call into an unsupported feature fails with the same
typed result instead of a missing method, a silent no-op or a quiet fallback. The SDK also reports
its capability set in device telemetry. The `core.caps` row in each SDK's `parity.json` moves from
`planned` to `implemented`.

## Why

[PARITY §2.2](../../PARITY.md#22-typed-unsupported-here) makes "unsupported here" part of the parity
contract, and the registry from [P1b-01](P1b-01-parity-registry.md) declares which `runtime` N/As
each feature may use. Nothing in the SDKs can express that yet:

- the React SDK drops features silently (e.g. `config.secret` in the browser);
- Node falls back to a file store without saying so (README §9.1 #26);
- the Python keyring is an optional extra that degrades quietly.

P1b-01 and P1b-02 both record `core.caps` as unowned. This package owns it.

## Read first

- `AGENTS.md`, [`../../PARITY.md`](../../PARITY.md) §2 and §5.1, and the P1b-01 and P1b-02 briefs.
  Use their generated `Feature` and `UnsupportedReason` constants, never string literals.
- The error types:
  - `packages/client-core/src/errors.ts`;
  - `packages/sdk-node/src` (its `PolarisKeyError` family);
  - `sdks/python/src/polaris_key` (its exception hierarchy);
  - `sdks/swift/Sources/PolarisKeyCore` (its error enum).
- The store-status work in [P1b-09](P1b-09-fingerprint-storage-fixes.md) (`Store.status()`), which
  reports a degraded store through this mechanism.

## Scope

**In:**

- `supports(feature)` on each SDK's client, backed by one capability table per SDK and runtime.
- An `Unsupported` result or error type in each SDK:
  - it carries `feature`, `reason` (`runtime` | `outlet` | `product` | `dependency` | `version`) and `detail`;
  - it is raised or returned in the language's idiom (thrown error in TS and Swift, exception in Python), with a stable error code from the generated registry.
- The reasons decided at runtime:
  - `product` from discovery (a disabled service);
  - `dependency` (an optional package that is missing, e.g. Python's `keyring`);
  - `version` (a runtime too old);
  - `outlet` stays a hook until outlet detection lands ([P3-11](P3-11-outlet-detection.md)).
- Retrofit today's silent paths so they return `Unsupported`: `config.secret` in the browser, React
  features that the manifests declare `na` for web.
- A `caps` key in device telemetry: a compact list of the feature ids the SDK supports right now. It
  needs an allowlisted report key in `packages/worker/src/core/devices.ts` `REPORT_KEYS`, plus the
  OpenAPI description of the report body.
- Tests tagged `@pkey-feature core.caps` in each SDK, and the `parity.json` updates.

**Out:**

- The Godot SDK. `sdks/godot` gains the same surface when its manifest adopts it; if `sdks/godot`
  exists when this lands, add it here.
- Console views of fleet capabilities (a later console package; see [P6-03](P6-03-update-funnel-autohalt.md)).
- Deciding outlet capabilities (→ [P3-11](P3-11-outlet-detection.md)).

## Design notes

- **The capability table is data.** Generate or hand-write one table per SDK, keyed by the generated
  `Feature` constant and consistent with that SDK's `parity.json`. `parity:check` should fail when the
  two disagree. Extend the check here if P1b-01 did not.
- **Never probe by calling.** `supports()` must be side-effect free and offline. Runtime reasons come
  from cached discovery and from detecting the environment.
- **Names:** camelCase in TS and Swift (`supports`, `Unsupported`), snake_case in Python
  (`supports`, `UnsupportedError`). Keep the reason values as lowercase strings on the wire and in
  telemetry.
- **Telemetry is small.** Send `caps` only when it changes, as the other report keys are sent.

## Steps

1. Add the `Unsupported` type and the error code in `client-core`, then in Node, Python and Swift.
2. Add each SDK's capability table and `supports()`, and wire discovery into the `product` reason.
3. Convert the known silent paths to `Unsupported`, with tests.
4. Allowlist `caps` in `REPORT_KEYS` and update the OpenAPI text; send it from each SDK.
5. Update every `parity.json`, then run `pnpm parity:check` and each SDK's tests.

## Acceptance criteria

- [ ] `supports(Feature.ConfigSecret)` returns `Unsupported{reason: "runtime"}` in the React
      browser adapter and `Supported` in Node, Python and Swift. Tests cover both.
- [ ] Calling `getSecret` in the browser raises the typed `Unsupported`, not `undefined`.
- [ ] With a service disabled in discovery, `supports()` reports `product` for that service's
      features in all four SDKs.
- [ ] A missing optional dependency (Python without `keyring`) reports `dependency` for `core.store`.
- [ ] `caps` is accepted by `/devices/report` and appears in the stored report; the Worker tests
      cover the allowlist change.
- [ ] `core.caps` is `implemented` in each SDK's `parity.json`; `pnpm parity:check` passes.
- [ ] The green gate passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/client-core --filter @polaris-key/sdk-node --filter @polaris-key/sdk-react test
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- register
mise exec node@22 -- pnpm parity:check
( cd sdks/python && .venv/bin/python -m pytest -q )
( cd sdks/swift && swift test )
```

## Hand-off

Later packages declare `na` and `except` rows knowing that the SDK enforces them. The names
`supports`, `Unsupported` / `UnsupportedError` and the `caps` report key are stable from here. Set
the status with
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1b-10 in-review` when handing
off for review.

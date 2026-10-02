---
"@polaris-key/client-core": minor
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Add typed "unsupported here" (PARITY §2.2). Every client answers `supports(feature)` with
`{ supported: true, feature }` or `{ supported: false, feature, reason, detail }`, where `reason`
is `runtime`, `outlet`, `product`, `dependency` or `version`. The answer is read from a capability
table generated from the SDK's `parity.json`. `caps()` lists the supported feature ids, and
every device report now sends that list as `caps`.

- `@polaris-key/client-core`: the shared engine (`evaluateSupport`, `supportedFeatures`,
  `detectorProblems`) and the `Supported`, `Unsupported` and `UnsupportedError` types.
  `UnsupportedError` is a `PolarisError`.
- `@polaris-key/node`: `client.supports()` and `client.caps()`. Without a loadable OS keyring,
  `core.store` reports `dependency`. A sub-client whose service is off (Release, Update,
  Identity, the Config edge-mint) now throws `UnsupportedError` with `reason: "product"`, the
  feature and a detail. It keeps the code `service-unavailable`, so existing checks on `.code`
  still match.
- `@polaris-key/react`: `adapter.supports()` and `adapter.caps()`, also on `usePolarisKey()`.

**Breaking changes in `@polaris-key/react`:**

- `getSecret()` now throws `UnsupportedError` (code `unsupported`) on both transports. It used
  to return `null`. Secrets are never delivered to a browser session or a renderer.
- In the browser adapter, `listDevices()`, `renameDevice()`, `deauthorizeDevice()` (for another
  device) and `report()` now throw `UnsupportedError`. They keep their old `.code` values,
  `device-management-unsupported` and `report-unsupported`.
- The public `PolarisAdapter` interface gains the required members `supports(feature)` and
  `caps()`. Custom adapters and test doubles must add them.

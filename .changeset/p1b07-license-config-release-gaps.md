---
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Close the licence, config and release parity gaps (P1b-07). Every SDK now answers the same way:

- **`entitledChannels`** — the `channels` entitlement's string grants in order, or `["stable"]`
  when the licence carries none (the Worker's own answer). New in Node
  (`client.license.entitledChannels()`), Python (`license.entitled_channels()`) and React
  (`adapter.entitledChannels()`, `useLicense().entitledChannels`). **Swift behaviour change:**
  `LicenseClient.entitledChannels()` answered `[]` for an absent entitlement and now answers
  `["stable"]`.
- **Catalog fetch** — `client.config.fetchSchema()` (Node: `ProductCatalog | null`; Python:
  `fetch_schema()`; React: `adapter.fetchSchema()`; Swift: `client.config.fetchSchema()`):
  `null` on any failure, never a throw, and a product without Config is not probed.
- **Release client** — Swift gains the `PolarisKeyRelease` target (`changelog()`,
  `installURL()`, `downloadURL(version:binary:arch:checksum:dmg:)`, as `client.release`); React
  gains `adapter.changelog()` / `installUrl()` / `downloadUrl()` and `useChangelog()`
  (`@polaris-key/react/release`). A 401 or 403 now surfaces the refusal body's own code in every
  SDK (Node and Python reported a 401 as `not_found`), and a `null` changelog summary stays null
  (`ChangelogEntry.summary` is `string | null`; Python no longer turns it into `"None"`).
- **React offline bundles** — `adapter.importBundle(jws)` and `useImportBundle()`: desktop
  through bridge protocol v3's optional `importBundle` (`BRIDGE_VERSION` is now 3), browser
  verified in-page against a random device id kept in IndexedDB (`trust: { pinnedKeys }`).
- **Telemetry** — React desktop `adapter.report()` through `invoke("devices", "report")` (the
  browser throws `report-unsupported`); Swift exposes `PolarisKeyClient.report()`.

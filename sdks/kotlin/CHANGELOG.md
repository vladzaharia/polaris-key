# Changelog

All notable changes to the Polaris Key Kotlin SDK. Versions follow the monorepo's lockstep `v*`
tags; before 1.0 a minor version may change the API, and a changed API ships as the only API (no
deprecated aliases).

## Unreleased

- **Product presentation** (`core.presentation`, HA-13): `ProductDiscoveryDocument.presentation`,
  `client.presentation()`, `client.presentationIcon(px, scale)` and `client.presentationSource`
  (`im.plrs.key.core.PresentationSource`); the icon verified by SHA-256 and cached by hash.
  `PolarisTheme(presentation = …)` defaults the logo to the verified icon and, branded, the accent
  to the product's. `PolarisRequest.followRedirects` (default true) lets a request see a 3xx.
- **`polaris-key-ui-core` (UK-09).** A Compose-free JVM artifact (`:ui-core`) holds the UI kit's
  state holders, so a desktop or headless integration runs them without Compose or AndroidX:
  `PolarisGateState`, `PolarisSignInState`, `PolarisDevicesState`, `PolarisBootState`,
  `PolarisPackProgressState`, `PolarisSettingsState` and `PolarisUpdateState` with their UI values
  moved there from `polaris-key-ui` (same package; `:ui` re-exports it with `api`). **Breaking:** a
  holder no longer produces user-facing text. `PolarisSettingsUi.error` and `PolarisUpdateUi.error`
  are typed (`PolarisSettingsFailure`, `PolarisUpdateFailure`) and each renderer maps them to catalog
  copy; `PolarisSettingsUi.failed` is `PolarisSettingsUi.loadFailure`; `PolarisSettingsActions.set`
  and `reset` have no default body; `PolarisUpdateState.install` and `follow` take no `PolarisCopy`.
  The presentation core runs `conformance/corpus/v2/ui-matrix.json`: `KitStates.resolve` answers the
  state, the catalog copy lines and the actions of every UI-KITS component,
  `KitIdentity` resolves the product identity and theme, and `KitCopy` formats the generated
  launch-locale catalog (`kit-copy.json`, from `packages/brand/kit-copy`).
- **State is scoped to its control plane** (`core.store`, SP-41). A client whose `baseUrl` is not
  `https://key.plrs.im` (a local `pkey dev` Worker, a staging Worker) keeps its token, device id,
  cache, installers and pack root under `<product>@<host>[_<port>]` (`storeNamespace`,
  `CoreContext.storageNamespace`), its keyring service as `pkey:<product>@<host>` and, on Android,
  its Keystore alias and store directory under the same name, so it never reads or overwrites
  production's; production names are unchanged. `PolarisKeyDesktop.dataDirectory`, `store`, `slots`
  and `bootGuard` take that control plane's `baseUrl` (default: production; `client` reads it from its
  options), so a payload staged for a local control plane is never applied by production's launch.
  **Breaking: an explicit `DesktopOptions.dataDirectory` is production's directory, and every other
  control plane nests `<dataDirectory>/<product>@<host>` beneath it.** A host that ran a local
  control plane out of its explicit directory starts fresh in the nested one (a new local token,
  device id and cache); nothing moves, and production's files stay where they are.

Key-custody and offline-bundle fixes (wire contract v4). Each **breaking** line names what to change.

- **Signed-in user (`license.signedinuser`).** `licenseUser(...)`, `LicenseClient.licenseUser()` and `DocProfile.user` read the pairwise subject from a verified licence document's `profile.user`; a malformed or absent member is null.

- **Pin two keys.** A verified manifest signed by one usable pinned key can revoke another pinned
  key; the revocation is permanent on that install, kept as the signed manifest in the cache's
  `pinRevocations` and re-verified on every load. A manifest that revokes its own signer is refused.
  A product that pins a single key cannot rotate it away.
- **Manifest key statuses outside `active`, `staged` and `retired` are skipped** (exact,
  case-sensitive); a key whose `publicKey` is not canonical base64url is skipped.
- **Non-canonical base64url is refused** in all three JWS segments and in every trust-set key.
- **A rotated product's trust refresh retries `?signer=<kid>`** for each usable pin (ascending kid
  order, at most `MAX_TRUST_SIGNER_ATTEMPTS`) when the default manifest is signed by a key the app
  does not pin.
- **Breaking: a bundle-activated install re-imports after upgrading.** The cache keeps the imported
  bundle's own signed JWS (`bundle`); the old `importedBundle` marker is not read. Activation is
  re-derived on every start from that bundle and the cached licence document.
- **Breaking: an offline bundle past its 30-day import window needs a fresh mint to import**; one
  already imported keeps activating. Each inner document must be newer than the cached one of its
  type, and a byte-identical re-import of the installed bundle succeeds without a write.
- **Breaking: `CoreContext.importBundle` / `PolarisKeyClient.importBundle` return
  `ImportBundleResult`** (the bundle id and the documents that landed); `BundleOptions` takes the
  per-type `floors` and the `profile`; `verifyTrustManifest` takes `tombstones`.
- A hard 401 or a 403 build block deletes the document it answered for, so `licenseInfo()` is null
  after a revocation.

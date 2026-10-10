# Changelog

All notable changes to the Polaris Key Swift SDK. Versions follow the monorepo's lockstep `v*`
tags; before 1.0 a minor version may change the API, and a changed API ships as the only API (no
deprecated aliases).

## Unreleased

Gate and SDK correctness.

- **A blocking gate has a way out.** An expired licence offers Renew or manage (with
  `GateOptions.renewURL`), Try again, Use a different key and Sign in; a revoked one offers Use a
  different key and Sign in; the explanation is worded for the controls it has. Use a different
  key shows the activation form in place and Cancel goes back. `GateOptions.blockedAction` adds
  the host's own action.
- **`.polarisKey(client, theme:, options: GateOptions)`** carries key entry, offline activation
  (off on iOS), the free tier, the return URL for Replace a device and a renewal page.
  `PolarisKeyModel` takes the return URL, which the device-limit link now carries.
- **No activation card before the first read.** The gate draws only its ground until
  `PolarisKeyModel.hasLoaded`.
- **The accent you pass goes through `PolarisAccent.resolve`**, so the fill, its label and the accent
  text clear 4.5:1 in both schemes. A repeated identical refusal is announced again.
- **Sign-in shows who signed in** (Signed in as, Continue, Not you?) before the sheet closes.
- **Removed:** the "or" divider and `PolarisCopy.orDividerLabel`. Mac quiet links take the resolved
  accent, not the system link blue.
- **`ActivationResult` redacts its device token** in `description`, `debugDescription` and `dump`.
  `StoreError` and update refusals are `LocalizedError`s that say what to do (`-34018` names the
  missing keychain entitlement); an update-not-configured error no longer reads as licensing copy.
  `JSONValue` prints as JSON.
- **`client.update` names refused pins** (`invalid-options`) instead of reporting them missing, and
  `client.license.deactivate()` emits the `license` event like `client.deactivate()`.
- **The browser sheet** (`WebAuthenticationSignInBrowser`) takes its presentation anchor on the main
  actor when it opens, and `signInWithBrowser()` throws when the sheet cannot be shown.

Trust custody.

- **A bundle-activated install re-imports after upgrading.** The cache keeps the imported bundle
  itself (`bundle`) instead of an unsigned marker; the old marker is not read. The bundle is
  re-verified at every start and activates only while it carries the cached licence document.
- **A bundle past its 30-day import window needs a fresh mint to import,** but an imported one
  keeps activating on reload. An import must be strictly newer than the documents already held,
  and importing the same bytes again changes nothing.
- **Pin two keys.** A manifest signed by one pinned key can revoke another pinned key; the
  revocation is kept as the signed manifest and re-checked at every start. A manifest cannot
  revoke its own signer.
- **A refused default manifest is retried with `?signer=<kid>`** for each usable pinned key (at
  most `MAX_TRUST_SIGNER_ATTEMPTS`).
- **Manifest keys with a status other than `active`, `staged` or `retired` are skipped.**
- **Non-canonical base64url is refused** in signatures, headers, payloads and trust-set keys.

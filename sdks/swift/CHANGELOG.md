# Changelog

All notable changes to the Polaris Key Swift SDK. Versions follow the monorepo's lockstep `v*`
tags; before 1.0 a minor version may change the API, and a changed API ships as the only API (no
deprecated aliases).

## Unreleased

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

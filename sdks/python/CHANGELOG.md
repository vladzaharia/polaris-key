# Changelog

All notable changes to the Polaris Key Python SDK (`polaris-key`). Versions follow the monorepo's
lockstep `v*` tags; before 1.0 a minor version may change the API, and a changed API ships as the
only API (no deprecated aliases).

## Unreleased

Trust custody and offline bundles.

- **Pin two keys.** A verified manifest signed by one pinned key that lists another pinned key as
  `revoked` (its exact bytes) retires that pin on this install for good. The manifest is stored as
  signed evidence (`pinRevocations`) and re-checked at every start. A manifest that revokes its own
  signer is refused; a retired pin signs nothing.
- **Trust-manifest statuses outside `active`, `staged` and `retired` are skipped.** The match is
  exact and case-sensitive; an entry with no status, or a non-canonical `publicKey`, is skipped, not
  fatal.
- **Non-canonical base64url is refused** in JWS segments and trust keys (`b64url_decode` raises).
- **A rotated product still syncs.** When the default trust manifest is signed by a key you do not
  pin, the client asks for it signed by each pinned key (`?signer=`), up to
  `MAX_TRUST_SIGNER_ATTEMPTS` requests.
- **Breaking: a bundle-activated install re-imports its bundle after upgrading.** The cache keeps
  the signed bundle (`bundle`) instead of an `importedBundle` marker, which is no longer read;
  `ImportedBundle` is gone. `activation == "bundle"` now needs the bundle to re-verify and its
  licence document to be the cached one.
- **A bundle past its 30-day window needs a fresh mint,** and each document in it must be
  newer than the cached one of its type; re-importing the same bundle changes nothing.
  `inspect_bundle` and `verify_bundle` take required `floors=`, plus `tombstones=` and `profile=`;
  `import_bundle` takes the trust manager.

Local-trust fixes.

- **Revocation and a build block end offline use at once.** A hard 401 deletes the document it
  answered for; a 403 build block deletes the licence document. The `blocked` and
  `last_sync_unauthorized` hints are display-only.
- **Discovery can switch the licence gate on, never off.** The gate follows the build's
  `expected_services` (default: licence and config) OR discovery. A config-only product must
  pass `expected_services` without `license`.
- **Breaking: `verify_jws(..., typ=)` and `verify_*_doc(..., last_accepted_issued_at=)` are required
  keyword arguments;** `require_typ` is gone. Pass `None` for "no floor".
- **A desktop device whose stored id differs from its platform anchor re-activates once.** The
  id is re-derived at every start; `ioreg` and `reg.exe` run by absolute path.
- Network-path verification uses the effective clock. `b64url_decode` refuses a trailing newline.

Fail-closed, leak and error-model fixes (SP-48). Each **breaking** line names what to change.

- **Breaking: an unknown `expected_services` slug raises.** `PolarisError("invalid-options")`
  from the constructor, `create()`, `AsyncClient.create()` and `services_from_list()`; the CLI's
  `--service` reports it as a usage error. A misspelt `"licence"` used to turn License off, so
  `is_licensed()` was true on a device never activated. Fix the slug.
- **Credentials are no longer in a `repr`.** `ActivationOk`, `RegisterOk` and
  `Reacquired` hide `token`; `ConfigDoc.secrets` and `ManagedEntry.value` are hidden too; `print(result)` and log lines are safe. The field is unchanged.
- **Breaking: one error model.** A request that gets no answer raises (or returns)
  `network-error` with the httpx exception as `__cause__`; a 5xx is `server-error` with `status`.
  No httpx exception reaches the caller.
  - `update.check()` and `release.changelog()` name each refusal: the server's code, else
    `not_found` only for a real 404, `unauthorized`, `forbidden`, `rate_limited` or
    `http-error`. They used to raise `not_found` for every failure.
  - `devices.list()`, `rename()` and `deauthorize()` raise `network-error` / `server-error`
    instead of `httpx.ConnectError` / `device_*_failed`.
  - `ActivationError.code` for a transport failure is `network-error` (was `network`).
  - `RegisterError`, `DocumentError`, `DiscoveryError` and sync's `DocOutcome` carry `code`
    (and `status`); `RegisterError` is `bad_response` for a malformed 200.
  - The signed-update fetches report a 5xx that names no code as `server-error` (was
    `network-error`); a named code such as `feed_not_composable` still wins. `release.fetch()`
    raises `server-error` for a 5xx.
  - Edge-mint refusals that name no code use the registry codes above (was `http_<status>`).
  - `PolarisError` gains `status`. `InsecureBaseUrlError` and `DeviceManagementUnsupportedError`
    are `PolarisError` subclasses, no longer `ValueError` / `RuntimeError`: catch
    `PolarisError` (or the class itself).
- **An empty or blank licence key** is refused locally as `unauthorized`, with no request.
- **Device sign-in errors carry the server's message** (`PolarisError.message`,
  `SignInPoll.message`).
- **Breaking: `AsyncClient` calls refuse truthiness.** `if client.is_licensed():` without `await`
  raises `TypeError` instead of passing the gate. Awaiting, `create_task`, `gather` and
  `wait_for` are unchanged.
- **`client.license.deactivate()` emits the `license` event**, like `client.deactivate()` and
  `identity.sign_out()`: one event and one `on_change` call per deactivation.
- **A host callback that raises is logged**, with its traceback, on the `polaris_key` logger
  (event listeners, `on_change`, `on_stage`, `on_progress`, pack progress) instead of being
  swallowed. `on_change` no longer propagates out of `sync()`.
- **`import polaris_key` is cheap.** The root re-exports resolve on first use (PEP 562), the
  installed version is read on first use, and the CLI front ends import the client only when a
  verb runs: mounting the verbs on a host CLI no longer loads httpx, cryptography or any
  service.

Product presentation.

- **`core.presentation`.** `client.presentation()`, `client.presentation_icon(px, scale=1.0)` and
  `client.presentation_source` (sync and async): the product's name, developer, accents and
  SHA-256-verified icon from discovery, cached by hash. The terminal kit reads it with no
  integrator code.

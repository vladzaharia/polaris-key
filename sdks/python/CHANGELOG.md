# Changelog

All notable changes to the Polaris Key Python SDK (`polaris-key`). Versions follow the monorepo's
lockstep `v*` tags; before 1.0 a minor version may change the API, and a changed API ships as the
only API (no deprecated aliases).

## Unreleased

- **Peer HELLO display data is bounded (CONNECT-FIX).** In modes `v` and `p` a HELLO over 4 KiB closes `peer_bad_frame`; `app` is cleaned like `label` (NFC, controls and bidi stripped, 64 code points, "Unknown" when nothing is left) and `platform` is shown only when it is at most 32 of `A-Z a-z 0-9 space . _ + -`, else "Unknown". A session holds at most 16 records and 16 KiB of bodies before the person confirms the code, then closes `peer_busy`.

- **Cloud Connect over IPv6 (CC-IPV6.4).** The LAN service listens on one dual-stack `::` socket (`IPV6_V6ONLY` off, one port for both families; `0.0.0.0` where IPv6 is unavailable) and discovers peers with mDNS on `224.0.0.251` and `ff02::fb` (one socket per interface, at most 8; AAAA records; a response from outside the interface's connected subnets is ignored). Every address goes through `lan_verdict` (WIRE-CONTRACT-V5 section 15.4.1): an accepted socket is judged on its own peer and local address before a slot and before any read, a dialled address as text before the connect and on the connected socket before its first byte; unauthenticated sockets are capped at 4 per address, 16 per /64 and 32 in total. A device with several addresses dials them in a 250 ms race, at most 2 in flight. `LanOptions.host` defaults to `None` (was `"0.0.0.0"`). Browsing reads the interface list with `getifaddrs`; where the platform cannot, it raises `MdnsUnavailableError`.

- **Cloud Connect (CC-10.16).** `client.cloud_connect` finds a person's other devices on the LAN (bounded mDNS, TCP channels) and falls back to the relay (ticket, WebSocket, quotas; the optional `websockets` extra), over the `pkey-peer/1` protocol and Noise_XX_25519_AESGCM_SHA256 on `cryptography`. The parity manifest now claims `connect.noise`, `connect.protocol`, `connect.lan`, `connect.relay` and `connect.app`; `connect.links` and `connect.transfer` stay planned.

- **Cloud Sync key ring (U-38.3).** `client.keyring` (and `PolarisKeyClient(device_keys=...)`) creates the end-to-end ring, holds its root in memory only, unlocks from this device's wrap, wraps the root to another device (`wrap_to`), sets the recovery code and recovers from it (`recover`; a bad code is `recovery-code-invalid`), resets, and adopts earlier roots. `client.keyring.codec` seals and opens `pkey-sync-value/1` envelopes and blinds names. The crypto is `polaris_key.core.sync_crypto` over `cryptography`, pinned by `sync-vectors.json`. A wrap is sent with `kem` 32; a read also accepts the earlier `"x25519"`. The root and the code never appear in a `repr`, an error or a pickle, and `deactivate()` and `close()` lock the ring.

- **Device keys (CC-26.3).** `polaris_key.devices.create_device_key_store(product=...)` keeps one Ed25519 signing key and one X25519 agreement key per device in `<state dir>/device-keys.json` (`0600`, in a `0700` directory, under an OS file lock). `ensure()`, `public_keys()`, `sign()`, `dh()`, `rotate()` and `wipe()` never return a private half. A record that exists but cannot be read raises `DeviceKeysUnreadableError` and is never replaced; only `wipe()` resets it. `polaris_key.core.device_keys` has the `pkey-proof/1` signer (`sign_device_proof`, `sign_keys_proof`), and `client.devices.register_keys(store)` sends `PUT /devices/keys`; a memory-only store is refused unless `allow_ephemeral=True`.

- **Sign-in is `identity.sign_in.start()` (I-10a.15).** It answers a `SignInSession` (`user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`, `expires_at`, `device_name`; `reopen()`, `cancel()`, `wait(timeout=None, once=False, confirm=None, cancel_token=None)`). `wait` answers a `SignInOutcome` (`pending`, `choose`, `signed_in`, `cancelled`, `expired`); a refusal raises `sign-in-denied` and a failure after approval `sign-in-failed`. `start` takes `device_name`, `login_hint`, `name_hint`, `purpose`, `scope` and `license_choice`; a 404 on the start is the typed `service-unavailable`. A `signed_in` outcome stores the account subject; `client.events` gains an `identity` kind (`change`: `signed_in`, `signed_out`, `subject_changed`); `license.deactivate()` forgets the stored identity and subject. `begin_sign_in`, `poll_sign_in`, `accept_sign_in`, `wait_for_sign_in` and `sign_in_with_browser` are removed, with no deprecated aliases.

- **Pinned keys are `pinned_keys` (SP-35.21).** `PolarisKeyClient(pinned_keys=...)`, `create()`, `polaris_key.create()`, `AsyncClient.create()` and `server_client(pinned_keys=...)` replace `trust=`. The generated config and the `PolarisKey(config=...)` and CLI-mount dictionaries use the key `pinned_keys`. The CLI flag `--trust` is unchanged. An old `trust=` raises `TypeError` and an old `"trust"` config key is refused as missing pinned_keys; it is never read, so it cannot set, widen or empty the trust set. There are no deprecated aliases.

- **Entitlements have a namespace (SP-35.20).** `client.entitlements.has(name)`, `.value(name)` and `.all()` replace `client.license.is_entitled`, `entitlement_value` and `get_entitlements`. The view reads through the licence gate, so a revoked, expired or never-activated install still answers `False` and `None`. `polaris_key.server` verdicts keep their own `is_entitled`. There are no deprecated aliases.

- **The setting handle follows the shared registry (SP-35.19).** `client.config.setting(key)` takes no fallback: `value` is `None` when no layer has one (source `fallback`), and a default goes through `client.config.get(key, fallback)`. `enforced` is `locked`, `subscribe(fn)` is `on(fn)`, and the new `visibility` reads `editable`, `readonly` or `hidden` (`SettingVisibility`) from the document's state. There are no deprecated aliases.

- **Config names follow the shared registry (SP-35.18).** `client.config.get_config(key, fallback)` is `client.config.get(key, fallback)`, `client.config.on_change(key, fn)` is `client.config.on_config_change(key, fn)`, and `client.config.clear_all()` forgets every value the player chose. `client.get_config` and `client.on_config_change` are removed: use the `client.config` namespace. There are no deprecated aliases.

- **The terminal kit matches the Node kit.** `--no-color` and `NO_COLOR` win over `FORCE_COLOR`: on a pipe no bold or reverse-video escape is written either (a real terminal keeps weight under `NO_COLOR`, as before). The usage result of `activate --json` and `devices` carries `usage` and `message`, and the devices usage line is `devices rename <deviceId> [label...]`. `activate` refuses a malformed or cut-short key on this machine (exit 1, `"kind": "malformed"` or `"cut-short"`) instead of sending it. `status --json` has `tier`. `deactivate` asks `(y/N)` on a terminal, skipped by `-y/--yes`, and never asks off a terminal or under `--json`. `portal.json` is written `0600` in a `0700` directory.

- **The terminal kit's product page link comes from discovery.** `client.portal()` is discovery's `core.portal` (WIRE-CONTRACT-V4 §5.7): the Worker's customer-origin link, or `{"enabled": False}` while the product's portal is off, in which case `status` and the license gate draw "Contact {developer}" and no link. The last member persists as `portal.json` beside the presentation cache, and a refusal screen loads discovery first when the session has none. Against a Worker that sends no member the link is the one printed before. New `polaris_key.core.portal` (`parse_portal`, `portal_link`) and `client.discovery()`.

Kit screens.

- **Kit screens match the shared states.** Version too new keeps Try again as its one action. The offline-activation screen is a numbered two-step form (send the request, then load the response) in every state but done, with the request QR where it fits, labelled for screen readers, and no product line; a rejected response adds its error, and done has a title and a Done button. An expired license offers Renew and Use another license, and never Try again or Reconnect; the Qt kit draws Renew only when the host passes `renew_url=`. The TV QR on the device-limit screen is labelled as the device management page. The Qt kit draws the numbered steps with the request QR.
  Migrating: pass an https `offers.url` in the offers input to get Buy in your browser on the paywall, and `renew_url=` on `run_gate` to get Renew (the press opens it); without one an expired license offers Use another license alone.

- **`polaris_key.server` developer pass.** Brings the drop-ins level with `@polaris-key/server`.
  A bad config (none, no `product_slug`, no or empty `trust`, a pin that is not a 43-character
  base64url Ed25519 key, a `base_url` that is not an http(s) origin, a product twice) raises
  `PolarisKeySetupError` at construction, naming the fix (`pkey sdk --lang python --write`);
  `base_url` defaults to `https://key.plrs.im`, and Django's `POLARIS_KEY` rejects unknown keys.
  New: `require_tier(*tiers)` and `require_all(*requirements)` in every adapter (`has_tier`,
  `has_all` in DRF; `require` stays), the builders `tier()`, `sign_in()`, `entitlement()`;
  `get_polaris_license(...)`, a non-`Optional` accessor that raises on an ungated route; a CORS
  preflight (`OPTIONS` with `Access-Control-Request-Method`) now passes every gate, and
  `preflight="gate"` restores the refusal; a gated response gets `Cache-Control: private` unless it
  has one; `on_refusal` takes `(problem)` or `(problem, request)` in every adapter and DRF's
  `exception_handler` honors it; `Problem.with_status()`, `ProblemBody`, `RefusalCode`,
  `problem_response()`; a failed trust fetch is logged at debug level with its reason and says it
  keeps the last verified keys and the pins (a 404 says to check `base_url` and the slug); Django
  gates accept async views and class-based methods; Flask raises when a gate sits above `@app.get`;
  a DRF permission without `PolarisKeyAuthentication` raises with the fix. New
  `polaris_key.server.testing`: `create_test_kit()` with `options()`, `signed_headers()`,
  `headers_for(verdict)`, a clock and a fake trust service. Verdicts are unchanged (the corpus rows
  replay as before); the default statuses stay 401 and 403.
- **The CLI drop-ins fail at startup with the fix, and never with a traceback.**
  `register_argparse`, `register_click` and `register_typer` refuse a `config=` with no
  `product_slug`, no `trust`, a placeholder pin or a bad `base_url` when they register, with
  `polaris-bad-config` (a `ValueError`) and `pkey sdk --lang python --write`. A client that can't be
  built or an unexpected failure in a verb ends in the generic screen (exit 1, `"error": "internal"`
  under `--json`); `DEBUG=polaris` prints the traceback. A usage error under `--json` is the exit-2
  result line on `GroupedHelpParser`, click and typer hosts. Result lines name the command by its id
  (`devices list`, `login`), as the Node kit does. `on_collision="skip"` is silent unless `on_skip=`,
  `warn=` or `DEBUG=polaris` asks, as in Node (it printed to stderr before; pass `warn=` to keep a
  line), and the collision error names `on_collision="skip"` too. `deactivate` and `logout` take `-y`/`--yes`, as in Node. Migration: a `config=` that was
  a placeholder now fails at registration.

- **The async `wait_for_sign_in` keeps `code`.** `AsyncPolarisKey.identity.wait_for_sign_in` and `sign_in_with_browser` dropped the `code` of an `error` result, so an async caller could not tell `sign-in-denied` from `sign-in-failed`; the sync client already set it. A 503 on the device-code poll (the Worker retrying a transient failure after approval) is a `server-error` the wait loop rides out, as before.
- **The Qt kit's `run_gate` runs activation and sign-in.** The gate shows Welcome, license-key entry
  (Paste, a live verdict, refusals as an info callout with their next step), sign-in in the browser or
  by device code (the code with Copy, the countdown, a QR on a TV or console, the declined and failed
  states) and Replace a device through the portal, calling `client.license` and `client.identity` itself
  off the GUI thread. New: `run_gate(platform=, capabilities=, offers_free_tier=, open_url=,
device_name=)`, `GateController.screen` and `.flow`, `polaris_key.ui.core.ui_signin` (`SignIn` and
  `SignInHandoff`, replaying the `signIn` matrix).
- **The Qt kit honours the whole `Theme`.** `preset="native"`, `colors`, `radius`, `typography`,
  `density`, `ambient` and `service_cues` now take effect (`symbols` is the terminal's and is ignored);
  `color_scheme="system"` reads `QStyleHints.colorScheme` and follows it live (`system_scheme=` is now only
  the fallback when the OS says nothing); `KitView.container()` is the view as a `QWidget`. A settings row
  with no button no longer prints `Cannot read property 'role' of undefined`. Migration: the default
  `ambient=True` now draws the accent's glow behind the card.

- **Device-code sign-in tells a refusal from a failure.** A poll answering `error` with `reason: "access_denied"` (a person pressed Deny, Not you? or Cancel) ends as `sign-in-denied`; a bare `error` (the sign-in failed after approval) now ends as `sign-in-failed`, and the sign-in handoff has a `failed` state. Migration: check `sign-in-failed` as well as `sign-in-denied`. Builds already shipped ignore `reason` and behave as before.

Server drop-ins.

- **`polaris_key.server` (`server.license`, `server.signin`).** `PolarisKey` verifies `X-PKey-License` per WIRE-CONTRACT-V4 §14 (the six-step verdict, the problem body, the signed trust manifest refreshed every 900 s and once a minute on an unknown `kid`), with adapters for FastAPI/Starlette, Django and DRF, and Flask. Extras: `starlette`, `fastapi`, `flask`, `django`, `drf`. Replays `backend-matrix.json`.

Hostile-input fixes.

- **A `blocked` hint outside the block vocabulary can no longer unlock the gate.** The gate returns the hint's reason as the status, and `ok`, `grace` and `not-applicable` are usable, so an unsigned `{"reason": "ok"}` in `managed.json` or in a 403 body would have licensed the client. `polaris_key.core` now exports `BLOCK_REASONS`, `STRICTEST_BLOCK_REASON`, `is_block_reason` and `coerce_block_reason`. A 403 reason that is not a member reads as the stricter `version-too-old` (`channel-not-entitled` for `channel_not_allowed`), `CacheRecord.from_dict` drops a hint whose reason is not a member, and `license_state` coerces at the decision point.
- **State files are read with `O_NOFOLLOW` and a 1 MiB cap.** `FileStore` reads a symlink, a non-regular file (a directory, a FIFO), a file over `MAX_STATE_FILE_BYTES` or a file that is not UTF-8 as absent, never as the planted bytes; a symlink planted at the device path makes `get_device_id()` raise instead of adopting the id. A write repairs a pre-existing loose mode back to 0600.
- **A bundle's import window runs at the effective clock.** `import_bundle` checks the 30-day window at `max(system clock, floor)`, so winding the clock back no longer reopens a lapsed window.

Trust custody and offline bundles.

- **Signed-in user (`license.signedinuser`).** `license_user(doc)`, `client.license.get_license_user()` and `DocProfile.user` read the pairwise subject from a verified licence document's `profile.user`; a malformed or absent member is `None`. The terminal kit's `status` reads "signed in" from it, no longer from the holder's email, so a key-activated device reads as not signed in.

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

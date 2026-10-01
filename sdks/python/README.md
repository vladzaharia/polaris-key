# polaris-key (Python SDK)

A product-agnostic Python client for **Polaris Key** — an always-on **Core**
(device principal, credential, trust, verified cache, clock floor, sync) with opt-in
**License**, **Config**, **Release** and **Update** services layered over it. It mirrors
the Node SDK (`@polaris-key/node`) module for module and verifies the **same** cross-language
conformance corpus byte-for-byte.

The wire crypto is a compact JWS (EdDSA / Ed25519) over per-service signed documents; the
verifying key is selected by the header `kid` from a caller-supplied **trust set**, never
from the document, and the `alg` is asserted before any signature math (no `none`/HMAC
downgrade).

Distribution **`polaris-key`**, import package **`polaris_key`**, console script
**`polaris-key`**.

## Install

```sh
pip install polaris-key
# optional extras: OS keyring + alternate CLI front ends
pip install "polaris-key[keyring,click,typer]"
```

Requires Python ≥ 3.9. Runtime deps: `cryptography`, `httpx`.

## Quickstart

```python
from polaris_key import PolarisKeyClient

# kid -> raw Ed25519 public key (base64url). PLACEHOLDERS — substitute YOUR product's
# real values; see "Where the trust set comes from" below.
TRUST = {"<your-signing-key-id>": "<your-product-signing-key-b64url>"}

client = PolarisKeyClient.create(
    product_slug="djdl",
    version="1.0.0",                 # the HOST APPLICATION's version
    trust=TRUST,                     # pinned signing keys
    base_url="https://key.plrs.im",  # must be https: (or http://localhost)
)

# Activate this device with a license key (then pull the first signed documents).
result = client.license.activate_with_key("PKEY-XXXX-XXXX")
if result.kind == "ok":
    print("status:", client.status().status)

# …or register keylessly, when the product's policy is `open` (a config-only product's
# whole provisioning story).
client.devices.register()

# Offline-first gate.
if client.is_licensed():
    concurrency = client.config.get_config("run.concurrency", 4)
    vpn_url = client.config.get_secret("proxy.subscriptionUrl")
    if client.license.is_entitled("polarisVpn"):
        ...

# One Core pass: trust refresh -> enabled documents -> verify -> cache -> floor -> report.
client.sync()

# Wipe local credentials + deauthorize the device server-side.
client.license.deactivate()
```

`PolarisKeyClient.create(...)` loads the cached documents with **no network**; `sync()`
re-pulls. The default `KeyringStore` stores credentials in the OS keyring when available
(service tag `pkey:<product>`) and uses `0600` files for device/cache data and headless
fallback. Inject an `InMemoryStore` (or your own `Store`) for tests, and an `httpx.Client`
(e.g. with a `MockTransport`) for the transport.

A 401 on a document gets exactly **one** re-acquire per `sync()` pass, then one retry of the
failed fetch. A licensed device rotates its token with `POST /<product>/license/token`. A
registered device without a licence **re-registers** instead: when License is off for the
product, or the token came from `devices.register()` in this process, the one attempt is
`POST /<product>/devices/register` (the same request as `register()`: the fingerprint, and no
`Authorization` header). A refusal (403 `registration_closed`, 404, 429) spends the attempt and
the hard 401 is recorded. After a restart the token's origin is not persisted, so a product
with License on uses `license/token`. Under the `requires-identity` policy a native device
cannot re-register (that needs a browser session) and lands on the hard 401.

### Token store status

`client.store_status()` returns a `StoreStatus` (`backend`, `degraded`; `to_dict()` for JSON), or
`None` for a host store without `status()`. The default `KeyringStore` reports `keyring`, or
`file` with a reason:

- `keyring-unavailable`: the optional `keyring` extra is not installed, or its backend is
  `fail` or `null` (which store nothing);
- `keyring-error`: the keyring raised, or an earlier write fell back to the `0600` file (the next
  token write moves it to the keyring).

Writes are verified by reading back, and reads are file-first: only a write that fell back leaves
a file, so a file token is always the newest copy. The CLI `status` command prints the same as a
`Token store:` line.

### Directories

`client.core.dirs` holds the resolved `config`, `data`, `cache` and `state` directories, each
ending in `<product>`; pass `data_dir`, `cache_dir` or `state_dir` (bases) to override. Nothing
is created until something uses one, and the config directory has not moved.

| Base   | Linux and other POSIX                                         | macOS                                             | Windows                            |
| ------ | ------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| config | `$XDG_CONFIG_HOME` or `~/.config`                             | same as Linux                                     | same as Linux (`~\.config`)        |
| data   | `$XDG_DATA_HOME/polaris-key` or `~/.local/share/polaris-key`  | `~/Library/Application Support/polaris-key/data`  | `%LOCALAPPDATA%\polaris-key\data`  |
| cache  | `$XDG_CACHE_HOME/polaris-key` or `~/.cache/polaris-key`       | `~/Library/Caches/polaris-key`                    | `%LOCALAPPDATA%\polaris-key\cache` |
| state  | `$XDG_STATE_HOME/polaris-key` or `~/.local/state/polaris-key` | `~/Library/Application Support/polaris-key/state` | `%LOCALAPPDATA%\polaris-key\state` |

`polaris_key.core.exclude_from_backup(path)` marks an existing directory (`CACHEDIR.TAG`, plus
`tmutil addexclusion` on macOS; `not-applicable` on Windows) and never raises.

### Linux and containers

The fingerprint anchor and the device id read `/etc/machine-id`, else
`/var/lib/dbus/machine-id` (a blank file and `uninitialized` are skipped); DMI files are never
read, so root and non-root agree. A container with neither file has no anchor and cannot enrol
without a licence key: mount the host's `/etc/machine-id` read-only, or create one and keep it in
a volume. Never bake one into an image. On Windows, `boardSerial` and `machineModel` come from
one PowerShell `Get-CimInstance` call, run with no console window and a null stdin.

## Sub-packages

Every one is importable on its own, so a config-only daemon never pulls the licence module:

| Import                 | Owns                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `polaris_key.core`     | device principal, credential, trust, cache v3, clock floor, sync, telemetry, offline bundles, the frozen wire crypto |
| `polaris_key.license`  | `activate` / `enroll` / `token` / `deauthorize`, the signed grant document, the gate                                 |
| `polaris_key.config`   | the signed config document + layered resolution, edge-mint (`mint_token`)                                            |
| `polaris_key.devices`  | registration, the roster, fingerprint / facts / device-id, the stores                                                |
| `polaris_key.identity` | device-code sign-in (RFC 8628): `begin_sign_in` / `poll_sign_in` / `wait_for_sign_in`                                |
| `polaris_key.release`  | changelog, install script, artifact URLs                                                                             |
| `polaris_key.update`   | version check + the Sparkle appcast URL                                                                              |
| `polaris_key.local`    | the transportless profile                                                                                            |

### Capabilities (fail-closed)

`client.capabilities()` reports which services the product runs. Resolution is: a discovery
document fetched this session (`client.discover()`) > the `expected_services=[…]` your
build was compiled expecting > the suite default (`license` + `config`). Release, Update
and Identity are OFF in that default, so their sub-clients raise
`PolarisError("service-unavailable")` until something says otherwise — a service that is
not advertised must not be reachable. License and Config are ON, because an offline-first
client must not lose its gate to an unreachable control plane.

### Where the trust set comes from

> [!WARNING]
> Every `kid`/public key shown in this repository's docs, tests and
> `conformance/corpus/v2/cases.json` is a **placeholder or a test fixture whose private
> half is committed**. Pinning one means anyone can forge a document your client accepts:
> the verifying key is selected by the header `kid` from whatever map you supply.

Your product's real trust set is minted server-side when the product is registered, and is
never checked into a client repo. Get it from either:

- the **onboarding bundle** the admin portal returns when it mints the product's signing
  key (`kid -> publicKey`), or
- `GET https://key.plrs.im/<product>/.well-known/jwks.json`, over TLS, once — then compile
  the values into your application.

Pins are terminal by design (see
[Trust, caching, and the offline gate](#trust-caching-and-the-offline-gate)), so treat
updating them as a release, not a runtime fetch. Key rotation is handled for you by the
signed trust manifest at `/<product>/.well-known/polaris-trust.jws`, which is verified
against your pins.

## Gate statuses

`status().status` is one of: `ok`, `grace`, `expired`, `revoked`, `needs-activation`,
`not-applicable`, `version-too-old`, `version-too-new`, `channel-not-entitled`.
`is_licensed()` is true for `ok` / `grace` / `not-applicable`.

`not-applicable` is what a product that does not enable the License service reports: it has
no licence to be missing, so it boots **usable** rather than sitting on `needs-activation`
forever.

## Device-code sign-in

For a host that cannot complete a browser redirect — a CLI over SSH, a daemon, a kiosk —
`client.identity` signs in with a device code (RFC 8628). It needs the Identity service
(`expected_services` or discovery); with it off, every call raises
`PolarisError("service-unavailable")` before any request.

```python
prompt = client.identity.begin_sign_in(device_name="Build agent 7")
# Show prompt.userCode; render prompt.verificationUriComplete as a QR code (the verification
# page with the code filled in); show prompt.verificationUri as the short URL.
result = client.identity.wait_for_sign_in(prompt, timeout=300, cancel=stop_event)
if result.status == "ready":
    ...  # the device token is stored and the post-activation sync has already run
```

`wait_for_sign_in` waits at least `prompt.interval` seconds before each poll; a `slow_down`
lengthens the interval for every later poll (to the server's value, or by five seconds), and a
poll that fails on the network or with a 5xx is retried at the same interval, never faster. It
returns `expired` once `prompt.expiresAt` has passed without asking the server again, raises
`TimeoutError` when `timeout` runs out first, and raises `PolarisError("cancelled")` when the
`cancel` event (a `threading.Event`) is set. `poll_sign_in(prompt)` makes exactly one poll
(`pending`, `slow-down` with an `interval`, `ready`, `expired` or `error`).

`prompt.deviceCode` is the poll credential: never show it. A sign-in yields the signed-in
identity's **own** licence; it does not attach a licence this device already held.

**After `ready`, show on the device which account signed in.** Anyone holding the user code can
complete the sign-in on the verification page, so the player must be able to see a mis-binding:
`ready` carries no identity itself, but the post-acquisition sync has already run, so
`client.license.get_profile()` returns the signed licence profile (`name`, `email`) to show — for
example "Signed in as Ada Lovelace <ada@example.com>" with a way to sign out.

The prompt's `repr` leaves out `deviceCode`, and a `MintedToken`'s leaves out `token`, so
logging either object does not leak the credential.

## Edge-mint

`client.config.mint_token(recipe_id)` asks the Worker to sign a short-lived third-party token
through an operator-approved recipe (`GET /<product>/config/mint/<recipe_id>/token`, with the
device token) and returns a `MintedToken(token, expiresAt)`. It is cached **in memory only** —
never in the cache file or the keyring — and reused until 30 seconds before `expiresAt`, and only
while the client still holds the device token it was minted with — `deactivate()`, a cleared
token or a different sign-in drops it. A 401 gets the usual single re-acquire, on the same route a document 401 takes (so a registered device without a licence re-registers), and one retry. Failures raise `PolarisError`:
`service-unavailable` (Config off) and `bad_request` (an id outside `[a-z0-9-]`) before any
request, `unauthorized` (no token, or still 401), or the Worker's `not_found` /
`rate_limited` / `misconfigured`.

## Layered config

`client.config.get_config(key, fallback)` resolves a value through the **same precedence**
as every Polaris Key SDK; `get_config_source(key)` returns which layer won:

```
enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
```

`enforced`/`hidden` remote values are **locked to the server** — `local_overrides` and env
vars are ignored for those keys; `hidden` keys are additionally withheld from
`list_user_config()` (but still applied by `get_config`). A `default` (or absent) key falls
through local → env → remote value → your `fallback`.

```python
client = PolarisKeyClient.create(
    product_slug="djdl", version="1.0.0", trust=TRUST,
    local_overrides={"run.concurrency": 6},  # beats a `default`, never an `enforced`/`hidden`
    env_prefix="PKEY_CONFIG_",               # the default
)
client.config.get_config_source("run.concurrency")  # "local" | "env" | "remote-default" | …
```

### The `PKEY_CONFIG_*` env convention

An override env var is `env_prefix + key.replace(".", "__")` (dots → double underscores):
`run.concurrency` → `PKEY_CONFIG_run__concurrency`, `quality.floor` →
`PKEY_CONFIG_quality__floor`. The value is JSON-parsed when it parses (`"4"` → int,
`"true"` → bool, `"[…]"` → list); otherwise it is taken as the raw string.

The pre-suite `PKEY_CONFIG_*` prefix is **not** read as a fallback.

## Offline

Three depths:

1. **online with grace** (the default) — a cached document keeps working until `graceUntil`.
2. **bundle-activated** — an operator mints a `.pkeybundle` against this device's id and you
   import it with no network at all:

   ```python
   client.import_bundle(open("offline.pkeybundle").read())
   ```

   Verification is all-or-nothing and the error names the step that refused
   (`bundle-jws-rejected` / `bundle-claims-rejected` / `bundle-trust-rejected` /
   `inner-doc-rejected`), because the step is the operator's remedy.

3. **local-only** — a build that must never open a socket:

   ```python
   from polaris_key.local import create_local_client, create_bundle_client

   client = create_local_client(product_slug="djdl", version="1.0.0", trust=TRUST)
   client, imported = create_bundle_client(bundle=jws, product_slug="djdl",
                                           version="1.0.0", trust=TRUST)
   ```

   Every network-requiring call raises `PolarisError` with code `local-only` at the DIAL,
   before a URL is built — so a transportless build cannot make a request even by accident.

## CLI

A framework-agnostic command **core** (`polaris_key.cli.core`) powers a dependency-free
**argparse** front end (`polaris_key.cli.argparse_cli`, the default), plus optional **click**
(`polaris_key.cli.click_cli`) and **typer** (`polaris_key.cli.typer_cli`) adapters under the
matching extras. All three wrap the same core, so they never diverge. Verbs are grouped by
the service that owns them:

| Service   | Verbs                                           |
| --------- | ----------------------------------------------- |
| `license` | `activate` · `enroll` · `deactivate` · `status` |
| `devices` | `register`                                      |
| `config`  | `config <key>`                                  |
| `core`    | `import-bundle`                                 |

Trust keys are passed as repeatable `--trust kid=rawBase64url` pairs so the CLI stays
product-agnostic; `--service <slug>` (repeatable) carries the capability expectation.

```sh
# `--trust` takes YOUR product's real kid=publicKey pair — see "Where the trust set comes
# from" above. The values below are placeholders, not keys.
# Preferred: the key never touches argv (see "Supplying the license key" below).
POLARIS_KEY_ACTIVATION_KEY=PKEY-XXXX-XXXX polaris-key activate \
  --product djdl --version 1.0.0 \
  --trust '<your-signing-key-id>=<your-product-signing-key-b64url>'
polaris-key register --product djdl --trust '<your-signing-key-id>=...'
polaris-key status --product djdl --trust '<your-signing-key-id>=...'
polaris-key import-bundle --product djdl --trust '...' ./offline.pkeybundle
# equivalently: python -m polaris_key …
```

### Supplying the license key

A key passed as `polaris-key activate PKEY-XXXX` is written verbatim to your shell history, is
visible to every user on the machine via `ps auxww` while the command runs, and is readable
from `/proc/<pid>/cmdline` on Linux. The CLI therefore resolves the key from a **non-argv**
source first:

| Order | Source                                                                           |
| ----- | -------------------------------------------------------------------------------- |
| 1     | `--key-file <path>`                                                              |
| 2     | `--key-stdin` (one line from stdin)                                              |
| 3     | `$POLARIS_KEY_ACTIVATION_KEY`                                                    |
| 4     | the positional argument — still supported for scripting, but it prints a warning |
| 5     | an interactive prompt, when stdin is a TTY                                       |

```sh
printf '%s' "$KEY" | polaris-key activate --key-stdin --product djdl
polaris-key activate --key-file ~/.config/djdl/license.key --product djdl
polaris-key activate --product djdl        # prompts when run interactively
```

### `--version`

`--version` defaults to the **installed package version**, not to a `0.0.0-dev` sentinel.
The control plane's build gate short-circuits on a dev version, so defaulting to one meant
the CLI's out-of-the-box invocation requested a document that skipped version _and_ channel
enforcement. Pass your application's real version when you mount these commands into your
own CLI.

To mount the commands onto your own program, import the adapter you use: the click adapter
exposes a `cli` group (`polaris_key.cli.click_cli.cli`) and the typer adapter exposes an `app`
(`polaris_key.cli.typer_cli.app`); both are thin wrappers over `core`. The argparse hook is
`polaris_key.cli.register_argparse(subparsers, client_factory=…)`.

## Trust, caching, and the offline gate

The SDK follows wire contract v3 (`docs/security/WIRE-CONTRACT-V3.md`):

- **Pinned keys are terminal.** The `trust=` map you compile into your application is the
  only root. Keys learned from a signed trust manifest are merged _under_ it, and a
  manifest that presents a pinned `kid` with different key bytes is rejected whole.
- **`key.status` is honoured.** `revoked` keys are refused and removed; a `kid` absent from
  the newest manifest is dropped (absence is revocation).
- **The cache stores only signed artifacts** — the compact JWS of each per-service document
  and of the trust manifest. The trust set, the per-type anti-replay floors,
  `lastVerifiedAt` and the monotonic clock floor are all _derived_ by re-verifying those
  strings against your pins on every load. Nothing security-relevant is read from disk
  unverified, and a cache record from any other version is **discarded**, not migrated.
- **Core owns trust refresh** on its own cadence, before and independently of any document
  fetch — so a product with _any_ service enabled still advances the independent signed
  clock that makes rollback inert.
- **Claim checks** cover `typ` (mandatory in v3), `aud`, `iss` (`key.plrs.im`, host-neutral),
  `deviceId`, monotonic `issuedAt`, `expiresAt` and a bounded `graceUntil` (365 days, at
  verify time), with a 300-second clock skew. An expired document is rejected at
  verification, not merely reported by the gate.
- **A `304` renews freshness, per document.** The content-only ETag is blind to the
  validity window, so once a cached document is past its half-life the client escalates a
  `304` to an unconditional re-request. A continuously online client cannot drift into
  `grace`.
- **A non-HTTPS `base_url` is refused at construction** (`InsecureBaseUrlError`), except
  for loopback hosts.
- **Every request carries a deadline** — including calls on an `httpx.Client` you injected.

## Low-level verification

```python
from polaris_key import verify_jws, verify_license_doc, verify_config_doc, TYP_LICENSE

v = verify_jws(jws, {"kid": "rawBase64urlPubKey"}, require_typ=True)
v = verify_jws(jws, trust, typ=TYP_LICENSE, require_typ=True)  # assert the document type
doc = verify_license_doc(jws, trust, expected_aud="djdl", device_id=device_id)
```

`verify_jws` never raises and never parses an unverified payload: the encoded segments are
size-capped before decoding, base64url decoding is strict (the `-_` alphabet only — no
`+/`, no `=`, no whitespace), duplicate JSON keys are rejected rather than resolved, a
missing `typ` is refused, and the payload is decoded only after the Ed25519 signature checks
out.

## Development

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,keyring]"
pytest
```

The conformance suite reads `../../conformance/corpus/v2/` from the monorepo and asserts
byte-identical verify outcomes alongside the Node / Swift / React runners — JWS cases,
per-document claim cases, trust cases, the clock floor, the gate matrix, the offline
bundle order, and the stage matrix: every row and every probe of the boot stage machine in
`polaris_key.core.stages` (`initial_boot_state`, `boot_transition`, `boot_guard_action`).

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

New versions are published to Polaris Key's PyPI feed only (the releases already on PyPI stay
there). Name the feed as an explicit index for this one project, never as an extra index, so no
other index can answer for `polaris-key`. With uv:

```toml
# pyproject.toml
[[tool.uv.index]]
name = "polaris-key"
url = "https://pkg.plrs.im/pypi/polaris-key/simple/"
explicit = true

[tool.uv.sources]
polaris-key = { index = "polaris-key" }
```

```sh
uv add polaris-key
# optional extras: OS keyring + alternate CLI front ends
uv add "polaris-key[keyring,click,typer]"
```

pip cannot route one project to one index: install the dependencies from your usual index, then
the package alone from the feed. Poetry and the rest:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/).

```sh
pip install "cryptography>=41" "httpx>=0.24" "zstandard>=0.22; python_version < '3.14'"
pip install --no-deps --index-url https://pkg.plrs.im/pypi/polaris-key/simple/ polaris-key
```

Requires Python ≥ 3.9. Runtime deps: `cryptography`, `httpx`, and below Python 3.14 `zstandard`
(packs decode zstd; 3.14 uses the stdlib's `compression.zstd`).

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
| `polaris_key.license`  | `activate` / `enroll` / `token` / `deauthorize`, the signed grant document, the gate, `entitled_channels()`          |
| `polaris_key.config`   | the signed config document + layered resolution, `fetch_schema()` (the catalog), edge-mint (`mint_token`)            |
| `polaris_key.devices`  | registration, the roster, fingerprint / facts / device-id, the stores                                                |
| `polaris_key.identity` | device-code sign-in (RFC 8628): `begin_sign_in` / `poll_sign_in` / `wait_for_sign_in`                                |
| `polaris_key.release`  | changelog, install script, artifact URLs                                                                             |
| `polaris_key.update`   | version check, the Sparkle appcast URL, the signed update decision (`decide`, `feed`, `release_record`, `build_url`) |
| `polaris_key.local`    | the transportless profile                                                                                            |

`client.license.entitled_channels()` returns the `channels` entitlement's string grants in
order, or `["stable"]` when the licence carries none — the Worker's own answer, and every SDK's.
`client.config.fetch_schema()` returns the product's catalog as a `dict`, or `None` on any
failure (it is unsigned and diagnostic, so it never raises). `client.release` raises
`service-unavailable` when the product does not run Release, forwards the device token when one
is held, and raises a 401/403 with the refusal body's own code (`unauthorized`,
`channel_not_allowed`, …); a changelog entry's `summary` is `None` when the release has none.

### Capabilities (fail-closed)

`client.capabilities()` reports which services the product runs. Resolution is: a discovery
document fetched this session (`client.discover()`) > the `expected_services=[…]` your
build was compiled expecting > the suite default (`license` + `config`). Release, Update
and Identity are OFF in that default, so their sub-clients raise
`PolarisError("service-unavailable")` until something says otherwise — a service that is
not advertised must not be reachable. License and Config are ON, because an offline-first
client must not lose its gate to an unreachable control plane.

### supports() and capabilities

`client.supports(feature)` answers whether a feature (a `Feature` id, `Feature.CONFIG_SECRET`)
works here, right now: `Supported(feature)`, or `Unsupported(feature, reason, detail)`. Both
have a `supported` property. `reason` is an `UnsupportedReason` value:

| Reason       | Meaning                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `runtime`    | this runtime cannot do it at all (`ui.kit`: the Python SDK ships no UI toolkit)                  |
| `outlet`     | the outlet the install came from forbids it                                                      |
| `product`    | the product does not run the service that owns it (`client.capabilities()`)                      |
| `dependency` | an optional dependency is missing (`core.store` without the `keyring` extra or a usable backend) |
| `version`    | this SDK version does not implement the feature yet, or does not know the id                     |

The answer comes from the capability table generated from this SDK's parity manifest
(`CAPABILITIES`), the services the client believes the product runs, and the environment. It is
offline and side-effect free: it never calls the network and never reads the keyring. A call
into an unsupported feature raises `UnsupportedError`, a `PolarisError` carrying the same
`feature`, `reason` and `detail`. Its code is `unsupported`, except for a sub-client whose
service is off. That refusal is the `product` reason and keeps the code `service-unavailable`,
which existing callers match on.

Without the `keyring` extra (or with a `fail`/`null` backend) the token still persists, in a
0600 file. `store_status()` then reports `keyring-unavailable`, and
`supports(Feature.CORE_STORE)` reports `dependency`.

`client.caps()` lists the feature ids `supports()` answers Supported for, in registry order.
Every device report (`devices/report`, after each sync) carries it as `caps`, so the console
can see what the fleet can do.

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
`PKEY_CONFIG_quality__floor`. The value is the parsed JSON value when the raw string is one
strict JSON text (`"4"` → int, `"true"` → bool, `"[…]"` → list), and otherwise the raw string,
unchanged (WIRE-CONTRACT-V3 §2.2.1 rule 2, pinned by `conformance/corpus/v2/config-matrix.json`).
Strict means: no `NaN`, `Infinity` or duplicate member names; no member name holding U+0000; no
lone surrogate (which `os.environ` holds for a byte it cannot decode); every number zero or of
magnitude 10^−307 up to below 10^308; and at most 64 levels of nesting. Reading a variable never
raises. A set but empty variable counts (its value is `""`).

The withdrawn interim `PLRS_CONFIG_*` prefix is **not** read as a fallback.

### What the SDK sends

`X-PKey-Platform` and `X-PKey-Arch` carry the canonical values of WIRE-CONTRACT-V3 §5.2, mapped
from `platform.system()` and `platform.machine()` by `canonical_platform` and `canonical_arch`
(`Darwin` → `macos`, `AMD64` → `x86_64`); a spelling with no value omits its header.
`X-PKey-SDK` is `python` (`SDK_NAME`, the generated `SdkId.PYTHON`).

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

## Update decisions (wire v4)

`client.update.decide()` answers "what should this installed app do next?" from two signed
documents: the channel **feed** (`pkey-feed+jws`, signed by the product key) and the **release
record** it pins (`pkey-release+jws`, signed in CI by a release key the Worker never holds). The
host compiles the release keys in, beside its trust pins:

```python
from polaris_key import PolarisKeyClient, UpdateClientOptions, is_undismissable

client = PolarisKeyClient.create(
    product_slug="djdl",
    version="1.2.0",                       # the installed version
    trust=TRUST,
    expected_services=["release", "distribution", "update"],
    update=UpdateClientOptions(
        # kid -> raw Ed25519 release key (base64url). PLACEHOLDER: your product's release key.
        pinned_release_keys={"<your-release-key-id>": "<your-release-key-b64url>"},
        outlet="direct",                   # the Polaris Key outlet (id direct); turns offers on
        format="dmg",                      # only builds of this format are offered (optional)
        methods=("download",),             # what this host can do with a `binary` decision
    ),
)

check = client.update.decide(channel="latest")   # the REQUESTED name; aliases are fine
check.channel             # "stable": the canonical channel, the feed's own claim
check.decision.action     # none | code-ready | binary | store | platform | blocked | packs
check.decision.to_dict()  # exactly the members that action carries
check.feed, check.record  # "network" | "committed";  "network" | "cache" | "none"
check.errors              # (UpdateCheckError(code, detail), ...): what was refused on the way
if check.decision.action == "binary":
    url = client.update.build_url(check.decision.release.version, check.decision.build)
    # download, then check the payload's size and sha256 against the record before staging
```

What it does, in the contract's order (`docs/security/WIRE-CONTRACT-V4.md` §3.4, §3.5 and §4.4):

- It reads `update.endpoints.feed` and `release.endpoints.record` from discovery (fetching
  discovery first when this session has not). A Worker without them is `service-unavailable`:
  fall back to `client.update.check()`.
- The feed verifies against the **effective** trust set (pins plus verified manifest keys) at
  the **effective** clock, `max(system, highWaterMark)`, so winding the system clock back cannot
  revive an expired feed. Its `seq` must not fall below the floor of its own canonical channel:
  a lower `seq` is `feed-rollback`, and the decision then comes from the committed feed.
- The record is fetched by its SHA-256 and **hashed before any signature work**; it verifies
  only against `pinned_release_keys`, and a release key that is also a product key is refused.
- The decision is `decide_update` over both (the rollout bucket uses the device id). A
  `mandatory` decision and every `blocked` one is a prompt the player cannot dismiss
  (`is_undismissable(decision)`): keep it on screen, never cover the running app with it. A
  stale feed (past `expiresAt` + 300 s) answers `none` with reason `stale`: keep running, never
  update automatically.
- With a content stamp (`UpdateClientOptions(packs=...)`), the decision also runs the **content
  decision** (below): pack updates, pack floors and revocations.

It raises `UpdateError` (a `PolarisError` with a `detail`) only when it has nothing to decide
from (`feed-rejected` with the step as `detail`, `network-error`, the Worker's wire code), and
for `not-configured` (no `pinned_release_keys`), `service-unavailable` and `local-only`. Bad
options (an unknown outlet or method, a release key that is also a trust pin) raise
`invalid-options` from the constructor. `client.update.feed()` returns the verified feed alone;
`client.update.release_record(sha256)` one verified record.

The committed feeds and records live in the cache as two more signed slices (`feeds`, keyed by
canonical channel, and `releaseRecords`, keyed by hash). They are re-verified on every load, each
channel's `seq` floor is derived from the feed that survives (never stored), and they survive
`deactivate()` and a bundle import, so a replayed older feed cannot get past the floor. With no
`outlet`, the client detects one (`UpdateClientOptions(detect=True)`, the default):
`read_outlet_signals()` reads the environment (Steam, snap, AppImage, `ITCHIO_APP`),
`sys.executable` and script path conventions (a Homebrew `Cellar`, WinGet, Scoop, Chocolatey),
`GetCurrentPackageFamilyName` through `ctypes` on Windows, and files the product's identities name
(a frozen `.app`'s App Store receipt, `Caskroom/<caskToken>/`, the install's Steam
`appmanifest`, the nearest itch receipt, `/.flatpak-info`); `detect_outlet` maps them with the
stamp exactly as every SDK does (`tests/test_outlet_matrix.py`). With no stamp and no attested
evidence the outlet is `unknown`, which is never offered an update. `client.update.outlet` and
`client.update.detected` expose the answer. The pure functions (`verify_feed`, `verify_release_record`,
`decide_update`, `effective_capabilities`, `resolve_update_outlet`, `rollout_bucket`,
`compare_versions`) are exported for hosts that drive their own transport, and
`tests/test_conformance.py` and `tests/test_update_matrix.py` run every `feedCases`,
`releaseRecordCases` and `update-matrix.json` vector through them.

## Packs (`client.update.packs`)

Packs are content delivered beside the app (plans/P4-01.md; CONTENT §10): each release is a
CI-signed `kind: pack` record, pinned by the app build's **content stamp**
(`pkey-content.json`, written by CI and shipped among the app's own read-only resources). A host
without a stamp has no packs.

```python
from polaris_key import PolarisKeyClient, UpdateClientOptions
from polaris_key import EmbeddedPack, PacksOptions

client = PolarisKeyClient.create(
    product_slug="djdl",
    version="1.2.0",
    trust=TRUST,
    expected_services=["release", "distribution", "update"],
    update=UpdateClientOptions(
        pinned_release_keys={"<your-release-key-id>": "<your-release-key-b64url>"},
        outlet="direct",
        packs=PacksOptions(
            content_stamp="/path/to/app/resources/pkey-content.json",
            embedded=[EmbeddedPack(path="/path/to/app/resources/pkey_packs/djdl.l10n")],
            axes={"locale": ["fr", "en"]},      # variant preferences, best first
        ),
    ),
)
client.discover()

off = client.update.packs.on(lambda e: print(e.phase, e.done, e.total))
client.update.packs.ensure(["djdl.l10n"])          # fetch, verify, commit, activate
client.update.packs.path("djdl.l10n")              # the running tree's directory
client.update.packs.state().active                 # also previous, inflight, running, state_issue
client.update.packs.confirm()                      # this boot is healthy
client.update.packs.rollback("djdl.l10n")          # back to the install it replaced
```

What `ensure` does, per pack: the stamp's pin, the record fetched by hash from
`release.endpoints.record` and verified against `pinned_release_keys` with `pin.kind: "pack"`,
a handler for its `type` (`files.tree` is built in; `register_handler` adds more), the
licence's entitlement, `select_variant`, the files index, `plan_target` and `plan`; then a
journal, each object fetched from `distribution.endpoints.blobs` with `Range`/`If-Range` (a
dropped download resumes on the next `ensure`, the staged bytes re-hashed, never trusted), the
applier (`full`, `file` or a `zstd-patch-from` delta), and the commit: the payload moves into
`<data dir>/packs/store/` (excluded from backups) before an atomic, fsynced pointer swap in
`state.json`. Failures raise `PackError` with a registered code (`not-configured`,
`pack-not-pinned`, `record-rejected`, `pack-type-unsupported`, `pack-not-entitled`,
`pack-no-variant`, a `plan-*` or applier code, `network-error`, `pack-state-unreadable`).

The state is never trusted from disk: every entry's record is re-verified and its payload
re-hashed at load. A `state.json` that does not parse is held aside as `state.json.torn` and
garbage collection waits (`state().state_issue == "torn"`) until `recover_state()`; one that
cannot be read at all (`"unreadable"`) blocks every write until the process restarts with it
readable. The running set's `packSetId` rides on `devices/report` as `content`.

Feed-offered deltas (P4-29): the committed channel feed can list lazy deltas (`deltas`, the
Worker's delta menu). The client keeps the menu of the last feed `update.decide()` or
`update.feed()` used, fresh or stale, and reads the committed feed from the cache when the pack
engine starts, so an offline launch still has it. The engine adds the entries for a container's
payload beside the record's own deltas (`with_feed_deltas`); every byte is still checked against
the CI-signed record, any failure (a 404 included) falls back, and at most one feed-offered delta
is tried per install. Nothing to configure.

zstd comes from the stdlib's `compression.zstd` on 3.14 (`ZstdDict(base, is_raw=True).as_prefix`
for deltas) and from `zstandard` below it (`DICT_TYPE_RAWCONTENT`); a start-up probe gates
`zstd-patch-from` (`client.update.packs.zstd()`), and every delta frame's window is checked from
its header before it is decoded. The pure functions (`parse_files_index`, `check_paths`,
`tree_digest`, `plan`, `select_variant`, `plan_target`, `apply_full`, `apply_file`, `apply_delta`,
`verify_marker`, `pack_set_id`, `parse_content_stamp`, `frame_window`) live in
`polaris_key.update.packs`; `tests/test_content_conformance.py` and `tests/test_plan_matrix.py`
run the content corpus and `plan-matrix.json` through them.

### Content decisions and revocations

With a content stamp, `client.update.decide()` also reads the feed's content members
(`packSets`, `packFloors`, `revocations`; `feed_content`) and the device's stored revocations, and
refines the app answer (plans/P4-13.md §2.5, §2.6):

```python
check = client.update.decide()
d = check.decision
if d.action == "packs":                          # install the named releases, unmount revoked ones
    client.update.packs.ensure_releases(d.install)   # exact releases, not the stamp's pins
    # d.revoke: optional packs revoked without a fix (already unmounted); d.set: the effective set
elif d.action == "blocked" and d.reason == "revoked-content":
    ...  # a REQUIRED pack was revoked by its developer and has no usable replacement
boot = boot_decision(d)                          # "required" only for revoked required content
```

- **Floors never stop play.** A pack below its floor gives `blocked {content-floor}`, or an offer
  made mandatory with `contentBlock: "content-floor"`; its boot value is `optional`.
- **A CI-signed revocation of a required pack does.** `blocked {revoked-content}`, or an offer
  with `contentBlock: "revoked-content"`, gives the boot value `required`: show your own text
  ("Some of this game's content was withdrawn by its developer and can't be used. Update the
  app to keep playing."), with the offer's button when the answer is an offer. A revoked
  **optional** pack is unmounted (`packs.revoke`) and play continues.
- A revocation is a `kind: revocation` release record signed by a pinned release key
  (`verify_revocation`; `newer_revocation` picks the winner among revocations of one target).
  The check fetches at most `MAX_FEED_REVOCATIONS` per call, and the ones it verifies are kept
  by `client.update.packs` in a sibling `revocations.json` beside `state.json` (never inside
  it), re-verified against the pinned release keys on every load. The engine refuses to
  activate, mount or install a revoked release (`PackError` `pack-revoked`). A torn
  `revocations.json` puts the stamp's packs in `relearn` (their embedded copies are refused,
  with `pack-revoked` detail `relearn` when no copy can be fetched) until a fresh feed re-teaches
  them or `recover_state()`; at most 256 targets are kept, the oldest dropped first.
- **A product with no revocations behaves exactly as before**: no `revocations.json`, no
  `revocationsStored` flag in `state.json`, and no refusal of any mount.

`client.update.packs.revocations()` reports what is stored, `content_input()` is what the check
reads, and `boot_fetch(..., install=d.install)` installs a `packs` answer's required and
essential entries before mount. The pure functions (`feed_content`, `revocation_of`,
`verify_revocation`, `newer_revocation`, `holds_of`, `stamp_holds`, `select_pack_rows`) are
exported for hosts that drive their own transport; `tests/test_content_decision.py` runs every
`feedContentCases`, `revocationCases` and `contentRows` vector through them.

### Delegated content (P4-19)

A compatible or standalone pack release signed by a **delegated content key** installs through the
same engine when it arrives as a feed target (`ensure_releases`, a `packs` decision's `install`):

- the delegation its `pkd1-` kid names is fetched from the record route (at most 16 per call,
  kept for the process), verified against `pinned_release_keys` only, and stored with the install
  (`install["delegation"]`), so a reload re-verifies it offline and after its window;
- every file must pass the data-only rule (`dataonly.py`): an extension allow-list over the files
  index before any payload object is fetched, then a head sniff, a tail sniff and, for `json`,
  `csv`, `tsv`, `po` and `txt`, a whole-file text rule as each file is written. A refusal is
  `PackError` `pack-not-data-only` with the `path` and the rule as `detail` (`extension` or
  `content`);
- a release under a revoked delegation is `pack-revoked`, detail `delegation`, and stops running;
- the stamp's pins, holds, a revocation's replacement and embedded baselines never take the
  delegated path (a delegated record there is `record-rejected`, detail `jws`);
- a `pinned_release_keys` kid matching `pkd1-<64 hex>` is refused as `invalid-options`.

Parse delegated text only with a pure JSON or CSV parser, and never write delegated bytes under a
code extension. The pure functions (`verify_release_record(..., delegation=)`,
`verify_delegation`, `delegation_of`, `delegation_hash_of`, `covers_pack`, `record_revoked`,
`data_only_refusal`) are exported; `tests/test_delegation_conformance.py` runs every
`delegationCases` and `dataOnlyCases` vector through them.

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

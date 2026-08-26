# polaris-key (Python SDK)

A product-agnostic Python client for the **Polaris Key** control plane — license
gating + signed managed-config delivery. It mirrors the Node SDK
(`@polaris-key/node`) and verifies the **same** cross-language conformance corpus
byte-for-byte.

The wire crypto is a compact JWS (EdDSA / Ed25519) over a managed-config document; the
verifying key is selected by the header `kid` from a caller-supplied **trust set**,
never from the document, and the `alg` is asserted before any signature math (no
`none`/HMAC downgrade).

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

TRUST = {"pkey-prod-2026": "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"}  # kid -> raw Ed25519 pubkey (base64url)

client = PolarisKeyClient.create(
    product_slug="djdl",
    version="1.0.0",
    trust=TRUST,                 # pinned signing keys
    base_url="https://key.plrs.im",
)

# Activate this device with a license key (then pull the first signed config doc).
result = client.activate_with_key("PKEY-XXXX-XXXX")
if result.kind == "ok":
    print("status:", client.status().status)   # ok | grace | expired | revoked | needs-activation | ...

# Offline-first gate.
if client.is_licensed():
    concurrency = client.get_config("run.concurrency", 4)
    vpn_url = client.get_secret("proxy.subscriptionUrl")
    if client.is_entitled("polarisVpn"):
        ...

# Re-pull the latest config (one /token re-acquire on 401), then re-apply.
client.refresh()

# Wipe local credentials + deauthorize the device server-side.
client.deactivate()
```

`PolarisKeyClient.create(...)` loads the cached doc with **no network**; `refresh()`
re-pulls. The default `KeyringStore` stores credentials in the OS keyring when available
and uses `0600` files for device/cache data and headless fallback. Inject an
`InMemoryStore` (or your own `Store`) for tests, and an `httpx.Client` (e.g. with a
`MockTransport`) for the transport.

## Gate statuses

`status().status` is one of: `ok`, `grace`, `expired`, `revoked`, `needs-activation`,
`version-too-old`, `version-too-new`, `channel-not-entitled`. `is_licensed()` is true
for `ok`/`grace`.

## Layered config

`get_config(key, fallback)` resolves a value through the **same precedence** as every
Polaris Key SDK; `get_config_source(key)` returns which layer won:

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
    local_overrides={"run.concurrency": 6},   # beats a `default`, never an `enforced`/`hidden`
    env_prefix="PKEY_CONFIG_",                  # the default
)
client.get_config_source("run.concurrency")     # "local" | "env" | "remote-default" | ...
```

### The `PKEY_CONFIG_*` env convention

An override env var is `env_prefix + key.replace(".", "__")` (dots → double underscores):
`run.concurrency` → `PKEY_CONFIG_run__concurrency`, `quality.floor` →
`PKEY_CONFIG_quality__floor`. The value is JSON-parsed when it parses (`"4"` → int, `"true"`
→ bool, `"[…]"` → list); otherwise it is taken as the raw string.

## CLI

A framework-agnostic command **core** (`polaris_key.cli.core` — `activate` / `deactivate` /
`status`) powers a dependency-free **argparse** front end (`polaris_key.cli.argparse_cli`, the
default), plus optional **click** (`polaris_key.cli.click_cli`) and **typer**
(`polaris_key.cli.typer_cli`) adapters under the matching extras. All three wrap the same
core, so they never diverge. Trust keys are passed as repeatable `--trust kid=rawBase64url`
pairs so the CLI stays product-agnostic:

```sh
# Preferred: the key never touches argv (see "Supplying the license key" below).
POLARIS_KEY_ACTIVATION_KEY=PKEY-XXXX-XXXX polaris-key activate \
  --product djdl --version 1.0.0 \
  --trust pkey-prod-2026=kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI
polaris-key status --product djdl --trust pkey-prod-2026=...
polaris-key deactivate --product djdl --trust pkey-prod-2026=...
# equivalently: python -m polaris_key ...
```

### Supplying the license key

A key passed as `polaris-key activate PKEY-XXXX` is written verbatim to your shell
history, is visible to every user on the machine via `ps auxww` while the command runs,
and is readable from `/proc/<pid>/cmdline` on Linux. The CLI therefore resolves the key
from a **non-argv** source first:

| Order | Source |
| --- | --- |
| 1 | `--key-file <path>` |
| 2 | `--key-stdin` (one line from stdin) |
| 3 | `$POLARIS_KEY_ACTIVATION_KEY` |
| 4 | the positional argument — still supported for scripting, but it prints a warning |
| 5 | an interactive prompt, when stdin is a TTY |

```sh
printf '%s' "$KEY" | polaris-key activate --key-stdin --product djdl
polaris-key activate --key-file ~/.config/djdl/license.key --product djdl
polaris-key activate --product djdl        # prompts when run interactively
```

### `--version`

`--version` defaults to the **installed package version**, not to a `0.0.0-dev`
sentinel. The control plane's build gate short-circuits on a dev version, so defaulting
to one meant the CLI's out-of-the-box invocation requested a document that skipped
version *and* channel enforcement. Pass your application's real version when you mount
these commands into your own CLI.

To mount the commands onto your own program, import the adapter you use: the click adapter
exposes a `cli` group (`polaris_key.cli.click_cli.cli`) and the typer adapter exposes an
`app` (`polaris_key.cli.typer_cli.app`); both are thin wrappers over `core`.

## Trust, caching, and the offline gate

The SDK follows [wire contract v2](../../docs/security/WIRE-CONTRACT-V2.md):

- **Pinned keys are terminal.** The `trust=` map you compile into your application is the
  only root. Keys learned from a signed trust manifest are merged *under* it, and a
  manifest that presents a pinned `kid` with different key bytes is rejected whole.
- **`key.status` is honoured.** `revoked` keys are refused and removed; a `kid` absent
  from the newest manifest is dropped (absence is revocation).
- **The cache stores only signed artifacts** — the compact JWS of the config document and
  of the trust manifest. The trust set, the anti-replay counters, `lastVerifiedAt` and the
  monotonic clock floor are all *derived* by re-verifying those two strings against your
  pins on every load. Nothing security-relevant is read from disk unverified, and a
  pre-v2 cache record is discarded rather than migrated.
- **Claim checks** cover `typ`, `aud`, `iss`, `deviceId`, monotonic `issuedAt`,
  `expiresAt` and a bounded `graceUntil`, with a 300-second clock skew. An expired
  document is rejected at verification, not merely reported by the gate.
- **A `304` renews freshness.** The content-only ETag is blind to the validity window, so
  once a cached document is past its half-life the client escalates a `304` to a full
  re-request. A continuously online client cannot drift into `grace`.

## Low-level verification

```python
from polaris_key import verify_jws, TYP_CONFIG

v = verify_jws(jws, {"kid": "rawBase64urlPubKey"})   # -> VerifiedJws(kid, payload) | None
v = verify_jws(jws, trust, typ=TYP_CONFIG)           # assert the document type too
```

`verify_jws` never raises and never parses an unverified payload: the encoded segments
are size-capped before decoding, base64url decoding is strict (the `-_` alphabet only —
no `+/`, no `=`, no whitespace), duplicate JSON keys are rejected rather than resolved,
and the payload is decoded only after the Ed25519 signature checks out.

## Development

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[keyring,click,typer]" pytest
pytest
```

The conformance suite reads `../../conformance/corpus/v1/cases.json` from the monorepo
and asserts byte-identical verify outcomes alongside the Node / Swift / React runners.

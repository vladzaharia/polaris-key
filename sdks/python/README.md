# polaris-key (Python SDK)

A product-agnostic Python client for the **Polaris Key** control plane — license
gating + signed managed-config delivery. It mirrors the Node SDK
(`@polaris-key/sdk-node`) and verifies the **same** cross-language conformance corpus
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

Requires Python ≥ 3.9. Runtime deps: `cryptography`, `httpx`, `platformdirs`.

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

# Enroll this device with a license key (then pull the first signed config doc).
result = client.activate_with_key("PKEY-XXXX-XXXX")
if result.kind == "ok":
    print("status:", client.status().status)   # ok | grace | expired | revoked | needs-enroll | ...

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
re-pulls. The default `FileStore` persists the token / device id / config cache as
`0600` files under `<config-dir>/<product>/`. Inject an `InMemoryStore` (or your own
`Store`) for tests, and an `httpx.Client` (e.g. with a `MockTransport`) for the
transport.

## Gate statuses

`status().status` is one of: `ok`, `grace`, `expired`, `revoked`, `needs-enroll`,
`version-too-old`, `version-too-new`, `channel-not-entitled`. `is_licensed()` is true
for `ok`/`grace`.

## CLI

A framework-agnostic command core powers a dependency-free `argparse` front end (plus
optional `click` / `typer` adapters under the matching extras):

```sh
polaris-key activate PKEY-XXXX-XXXX --product djdl --version 1.0.0 \
  --trust pkey-prod-2026=kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI
polaris-key status --product djdl --trust pkey-prod-2026=...
polaris-key deactivate --product djdl --trust pkey-prod-2026=...
# equivalently: python -m polaris_key ...
```

## Low-level verification

```python
from polaris_key import verify_jws

v = verify_jws(jws, {"kid": "rawBase64urlPubKey"})   # -> VerifiedJws(kid, payload) | None
```

## Development

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[keyring,click,typer]" pytest
pytest
```

The conformance suite reads `../../conformance/corpus/v1/cases.json` from the monorepo
and asserts byte-identical verify outcomes alongside the Node / Swift / React runners.

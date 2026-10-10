---
title: "Python"
description: "Integrate polaris-key: install from the feed, generate polaris_config.py, then take the terminal kit or draw your own UI."
sidebar:
  order: 3
---

For desktop tools, servers, CLIs and Ren'Py or Pygame games. Python 3.9 or later.

## Install

Name the feed as an explicit index for this one project, never as an extra index, so no other
index can answer for `polaris-key`:

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
uv add "polaris-key[keyring]"   # desktop apps and games: the token goes in the OS keyring
uv add polaris-key              # servers, containers and CI: a 0600 file
```

pip and Poetry: [Installing the SDKs from the feeds](/docs/build/install-from-feeds/#python-pip-uv-and-poetry).

## Config

`pkey` is the platform CLI; it ships as an npm package and as an image:

```sh
docker run --rm -v "$PWD:/work" pkg.plrs.im/polaris-key/pkey:latest \
  sdk --lang python --product <slug> --write
```

It writes `polaris_config.py`: the slug, base URL, trust pins, advertised services and, when the
product has release keys, `UpdateClientOptions(pinned_release_keys=…)`, all in `CONFIG`. Compare the
printed pin fingerprints with the console before you ship. `pkey dev`, a local Polaris Key to run
against, is planned in SP-41.

## The client

```python
from polaris_key import PolarisKeyClient

import polaris_config

# Offline-first: create() loads the cached documents; no network until discovery or a sync.
client = PolarisKeyClient.create(**polaris_config.CONFIG, version="1.0.0")
```

`CONFIG` has every keyword except `version`, so it carries `base_url`. A client built from the slug
and `trust` alone talks to production.

## Pick a lane

| Host          | Drop-in screens                  | Your own UI                                                                 |
| ------------- | -------------------------------- | --------------------------------------------------------------------------- |
| CLI           | [The terminal kit](#drop-in-cli) | [Screens on `ui.core`](/docs/build/sdks/python/your-own-ui/#headless-views) |
| Qt            | Planned in UK-12                 | [A Qt app on the library](/docs/build/sdks/python/your-own-ui/#qt)          |
| Server, no UI | None: a server has no screens    | [The library](/docs/build/sdks/python/)                                     |

### Drop-in: CLI

One call mounts every Polaris Key verb under your own command.

```python
import argparse

from polaris_key import PolarisKeyClient
from polaris_key.cli import ClientOptions, register_argparse

import polaris_config


def client_factory(opts: ClientOptions) -> PolarisKeyClient:
    # Spread the generated config. A factory built from opts.trust alone drops the base URL and
    # the release keys, and its writes go to production.
    return PolarisKeyClient.create(**{**polaris_config.CONFIG, "version": opts.version})


parser = argparse.ArgumentParser(prog="tidewater")
register_argparse(
    parser.add_subparsers(dest="command", required=True), client_factory, prog="tidewater"
)
args = parser.parse_args()
raise SystemExit(args.func(args))
```

Verbs, theming and `--json`: [Terminal (Python)](/docs/build/ui/frameworks/terminal-python/). Today
every mounted verb still asks for `--product`; binding the client once, with a default verb set for
end users and a `require_license` check for your own commands, is planned in UK-48.

## The same eight checkpoints

| #   | Checkpoint         | Drop-in (CLI)                                      | Your own UI                                                    |
| --- | ------------------ | -------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Install            | above                                              | above                                                          |
| 2   | Config             | above                                              | above                                                          |
| 3   | First activation   | `tidewater activate`                               | `client.license.activate_with_key(key)`                        |
| 4   | Each refusal       | Printed by the kit; a full device list gets a link | `activation_message(r.kind)`, `r.manage_url`                   |
| 5   | Sign-in            | `tidewater login`                                  | `client.identity.sign_in_with_browser()`, then `get_profile()` |
| 6   | Status and offline | `tidewater status`                                 | `client.status()`, `client.is_licensed()`                      |
| 7   | An update offer    | `tidewater update check`                           | `client.update.decide()`                                       |
| 8   | Tests              | `--json` on every verb                             | `InMemoryStore`, an `httpx.MockTransport`, `status(now)`       |

[Your own UI](/docs/build/sdks/python/your-own-ui/) gives each call with its state and its words. The
whole API is the [Python SDK reference](/docs/build/sdks/python/); a full device list has a
[recipe](/docs/build/recipes/device-limit/).

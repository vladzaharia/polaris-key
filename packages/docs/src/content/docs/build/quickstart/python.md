---
title: "Python"
description: "Integrate polaris-key in five minutes: generate polaris_config.py, create the client, gate, read config, sync."
sidebar:
  order: 3
---

For desktop tools, servers, and Ren'Py or Pygame games. Python 3.9 or later.

```sh
uv add "polaris-key[keyring]"       # the feed is an explicit index; see Installing the SDKs
pkey sdk --lang python --write      # writes polaris_config.py
```

```python
from polaris_key import PolarisKeyClient

import polaris_config

# Offline-first: create() loads the cached documents; no network.
client = PolarisKeyClient.create(**polaris_config.CONFIG, version="1.0.0")

if not client.is_licensed():
    result = client.license.activate_with_key(user_entered_key)
    if result.kind != "ok":
        print("activation refused:", result.kind)

concurrency = client.config.get_config("run.concurrency", 4)
client.sync()  # trust refresh, documents, verify, cache, report
```

`CONFIG` carries `update=UpdateClientOptions(pinned_release_keys=...)` when the product declares
release keys. The `keyring` extra stores the device token in the OS keyring; without it the token
falls back to a `0600` file and `client.store_status()` says so. CLI apps get argparse, click and
typer hooks from `polaris_key.cli`.

Next: the full [Python SDK reference](/docs/build/sdks/python/).

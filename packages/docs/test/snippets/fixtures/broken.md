---
title: "Broken on purpose"
---

The lane fails each of these. `NotAnExportAtAll` names no export, and neither do `NotAnExportEither` and `no_such_function()`.

```ts
import { PolarisKeyClient } from "@polaris-key/node";

const client = await PolarisKeyClient.create({ productSlug: "acme" });
client.noSuchMethod();
```

```python
from polaris_key import PolarisKeyClient

def run(client: PolarisKeyClient) -> None:
    client.no_such_method()
```

```ts no-compile
this is not typescript
```

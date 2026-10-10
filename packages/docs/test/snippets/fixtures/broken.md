---
title: "Broken on purpose"
---

The lane fails each of these. `NotAnExportAtAll` names no export.

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

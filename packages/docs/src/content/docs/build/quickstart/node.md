---
title: "Node"
description: "Integrate @polaris-key/node in five minutes: generate polaris.config.ts, create the client, gate, read config, sync."
sidebar:
  order: 1
---

For servers, CLIs and the Electron main process. Node 22 or later.

```sh
pnpm add @polaris-key/node      # with @polaris-key routed to the feed in .npmrc
pkey sdk --lang node --write    # writes polaris.config.ts (--out polaris.config.mjs for JavaScript)
```

```ts
import { PolarisKeyClient } from "@polaris-key/node";
import { polarisConfig } from "./polaris.config.js";

// Offline-first: create() loads the token and re-verifies the cached documents; no network.
const client = await PolarisKeyClient.create({
  ...polarisConfig,
  version: "1.4.2",
});

if (!client.isLicensed()) {
  const r = await client.license.activateWithKey(userEnteredKey);
  if (r.kind !== "ok") console.error(`activation refused: ${r.kind}`);
}

const concurrency = client.config.getConfig<number>("run.concurrency", 3);
await client.sync(); // trust refresh, documents, verify, cache, report
```

`polarisConfig` carries `update.pinnedReleaseKeys` when the product declares release keys, so
`client.update.decide()` works with no further setup. CLI apps get the command verbs from
`@polaris-key/node/cli` (commander and yargs hooks).

Next: the full [Node SDK reference](/docs/build/sdks/node/), and the
[device-limit recovery](/docs/build/recipes/device-limit/) recipe for the activation refusals.

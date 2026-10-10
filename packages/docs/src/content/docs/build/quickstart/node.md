---
title: "Node"
description: "Integrate @polaris-key/node: install from the feed, generate polaris.config.ts, then take the drop-in screens or draw your own UI."
sidebar:
  order: 1
---

For CLIs, the Electron main process and servers. Node 22.13 or later.

## Install

Route the scope to the feed, then install the SDK and, as a dev dependency, the `pkey` CLI:

```ini
# .npmrc
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
pnpm add @polaris-key/node
pnpm add -D @polaris-key/cli
```

Other package managers, and the age gates that delay a new version:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/). Run the CLI as
`pnpm exec pkey`; a bare `npx pkey` resolves the name from npmjs, not the feed.

## Config

```sh
pnpm exec pkey sdk --lang node --product <slug> --write
```

It writes `polaris.config.ts` (`--out polaris.config.mjs` for JavaScript): the slug, base URL,
trust pins, advertised services and, when the product has release keys, `update.pinnedReleaseKeys`.
Compare the printed pin fingerprints with the console before you ship. A local Polaris Key to run
against is planned.

## The client

```ts
import { PolarisKeyClient } from "@polaris-key/node";
import { polarisConfig } from "./polaris.config.js";

// Offline-first: create() loads the token and re-verifies the cached documents; no network.
const client = await PolarisKeyClient.create({
  ...polarisConfig,
  version: "1.4.2", // your app's version; omitted, it is read from package.json
});
```

Every path starts here. The generated file carries `baseUrl`; a client built without it talks to
production.

## Pick a lane

| Host     | Drop-in screens                                    | Your own UI                                                          |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| CLI      | [The terminal kit](#drop-in-cli)                   | [CLI screens on the library](/docs/build/sdks/node/your-own-ui/#cli) |
| Electron | [The React kit over the bridge](#drop-in-electron) | [A plain renderer](/docs/build/sdks/node/your-own-ui/#electron)      |
| Server   | None: a server has no screens                      | [The library](/docs/build/sdks/node/)                                |

### Drop-in: CLI

One call adds every Polaris Key verb to a commander program.

```ts
import { Command } from "commander";
import { PolarisKeyClient } from "@polaris-key/node";
import { registerPolarisCommands } from "@polaris-key/node/cli";
import { polarisConfig } from "./polaris.config.js";

const program = new Command("tidewater");
registerPolarisCommands(
  program,
  // Spread the generated config. A factory that builds from the slug and pins alone drops
  // baseUrl and the release keys, and its writes go to production.
  (o) => PolarisKeyClient.create({ ...polarisConfig, version: o.version }),
  {
    productSlug: polarisConfig.productSlug,
    version: "1.4.2",
    pinnedKeys: polarisConfig.trust.pinnedKeys,
    expectedServices: polarisConfig.expectedServices,
  },
);
await program.parseAsync();
```

Verbs, styling and `--json`: [Terminal (Node)](/docs/build/ui/frameworks/terminal-node/). Mounting
only some verbs and gating your own commands (`verbs`, `polarisGate`) are planned.

### Drop-in: Electron

The main process owns the client and the token. The renderer runs the React kit over a bridge.

```ts
import { app, ipcMain, safeStorage } from "electron";
import { PolarisKeyClient } from "@polaris-key/node";
import {
  exposePolarisBridge,
  SafeStorageStore,
} from "@polaris-key/node/electron";
import { polarisConfig } from "./polaris.config.js";

// Do not await whenReady() at the top level: a CommonJS main has no top-level await.
void app.whenReady().then(async () => {
  const client = await PolarisKeyClient.create({
    ...polarisConfig,
    store: new SafeStorageStore(
      polarisConfig.productSlug,
      app.getPath("userData"),
      { safeStorage },
    ),
  });
  exposePolarisBridge(client, {
    ipcMain,
    allowSender: (e) => e.senderFrame?.url.startsWith("app://") === true,
  });
});
```

```ts
// preload: bundle it, because a sandboxed preload loads no ES modules from node_modules
import "@polaris-key/node/electron/preload";
```

The renderer wraps the app in `<PolarisKeyProvider>` and `<LicenseGate>`:
[the React quickstart](/docs/build/quickstart/react/#drop-in-screens).

## The same eight checkpoints

| #   | Checkpoint         | Drop-in (CLI)                                      | Your own UI                                                               |
| --- | ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Install            | above                                              | above                                                                     |
| 2   | Config             | above                                              | above                                                                     |
| 3   | First activation   | `tidewater activate`                               | `client.license.activateWithKey(key)`                                     |
| 4   | Each refusal       | Printed by the kit; a full device list gets a link | `copy.activation(r.kind)`, `r.manageUrl`                                  |
| 5   | Sign-in            | `tidewater login`                                  | `client.identity.signInWithBrowser()`, then `client.license.getProfile()` |
| 6   | Status and offline | `tidewater status`                                 | `client.status()`, `client.isLicensed()`                                  |
| 7   | An update offer    | `tidewater update check`                           | `client.update.decide()`                                                  |
| 8   | Tests              | `kit: false` prints plain lines                    | `InMemoryStore`, `fetchImpl`, `status(now)`                               |

[Your own UI](/docs/build/sdks/node/your-own-ui/) gives each call with its state and its words.
The whole API is the [Node SDK reference](/docs/build/sdks/node/); a full device list has a
[recipe](/docs/build/recipes/device-limit/).

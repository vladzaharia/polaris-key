// Electron main process (SDK parity pass SP-N18): the privileged side owns the client, the token
// (under safeStorage), the boot and the updater; the renderer gets the PolarisBridge.

import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { autoUpdater } from "electron-updater";
import { join } from "node:path";
import { PolarisKeyClient } from "@polaris-key/node";
import {
  exposePolarisBridge,
  SafeStorageStore,
} from "@polaris-key/node/electron";
import { electronUpdaterDriver } from "@polaris-key/node/update/drivers/electron-updater";
import pkey from "./polaris.config.js"; // written by `pkey sdk --lang node --write`

await app.whenReady();

const client = await PolarisKeyClient.create({
  ...pkey, // productSlug, trust and update.pinnedReleaseKeys
  // version: omitted, read from app.getVersion()
  store: new SafeStorageStore(pkey.productSlug, app.getPath("userData"), {
    safeStorage,
  }),
  update: { ...pkey.update, driver: electronUpdaterDriver({ autoUpdater }) },
});

// Count this launch before anything can crash; confirm once the window is up.
await client.update.markBootAttempt();

exposePolarisBridge(client, {
  ipcMain,
  // Only the app's own pages may use the bridge.
  allowSender: (e) => e.senderFrame?.url.startsWith("file://") === true,
});

const win = new BrowserWindow({
  webPreferences: { preload: join(import.meta.dirname, "preload.js") },
});
await win.loadFile(join(import.meta.dirname, "index.html"));
await client.update.confirmBoot();

// Boot (sync, gate, decide, packs) and keep syncing while the app runs.
const { decision } = await client.boot();
client.startRefresh();
if (decision?.decision.action === "binary") {
  const outcome = await client.update.install(decision.decision);
  if (outcome.kind === "restartRequired") {
    // Ask the user, then: await outcome.restart();
  }
}

// `--live`: the real client from the file `pkey sdk --lang node --write` generates.
import { app, safeStorage } from "electron";
import { autoUpdater } from "electron-updater";
import { PolarisKeyClient } from "@polaris-key/node";
import { SafeStorageStore } from "@polaris-key/node/electron";
import { electronUpdaterDriver } from "@polaris-key/node/update/drivers/electron-updater";
import pkey from "./polaris.config";

export async function createLiveClient(): Promise<PolarisKeyClient> {
  return PolarisKeyClient.create({
    ...pkey, // productSlug, trust and update.pinnedReleaseKeys
    store: new SafeStorageStore(pkey.productSlug, app.getPath("userData"), {
      safeStorage,
    }),
    update: { ...pkey.update, driver: electronUpdaterDriver({ autoUpdater }) },
  });
}

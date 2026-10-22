// `serverClient()`: managed config on a server (framework drop-ins §5.7, SP-63).
//
// A server is a device with its own licence (owner decision 8), for example a `server` tier with
// a high device limit, so it never takes a customer's seat. This is the NORMAL client with five
// settings made for a container, not a second client:
//
//   * a memory store: nothing is written to the container's disk but the device id file, if the
//     host names one;
//   * a device id that stays stable across restarts, from `deviceId`, `PKEY_DEVICE_ID` or a
//     file on a volume (`deviceIdFile`, `PKEY_DEVICE_ID_FILE`), minted there on first start;
//   * the licence key from `licenseKey` or `PKEY_LICENSE_KEY`, activated at start (the memory
//     store holds no token across a restart, so each start re-activates the same device id,
//     which the server coalesces onto one seat);
//   * no device reports (`devices.reports: false`): a server has nothing a customer's device
//     list should show;
//   * a background refresh (`startRefresh()`), so `config.get()` follows the console.
//
// Per-user config is not offered: the device's config document carries `secrets` and is never
// forwarded (§13 Q8).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PolarisError } from "@polaris-key/client-core";
import { PolarisKeyClient, type PolarisKeyClientOptions } from "./client.js";
import { ErrorCode } from "./constants.generated.js";
import { InMemoryStore } from "./core/store.js";
import { deviceIdFromRaw } from "./devices/deviceId.js";

/** The server-side device id shape: 32 base64url characters. */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{32}$/;

export interface ServerClientOptions extends Omit<
  PolarisKeyClientOptions,
  "store" | "refreshIntervalSeconds"
> {
  /** This server's device id. Else `PKEY_DEVICE_ID`, else the file below. */
  deviceId?: string;
  /** A file on a persistent volume that holds the device id; minted there on first start.
   *  Else `PKEY_DEVICE_ID_FILE`. With none of the three, `serverClient()` refuses: a random id
   *  per container start would take a new seat each time. */
  deviceIdFile?: string;
  /** The server licence key. Else `PKEY_LICENSE_KEY`. */
  licenseKey?: string;
  /** Seconds between background refreshes (default 3600, at least 60). */
  refreshIntervalSeconds?: number;
  /** Where the three `PKEY_*` variables are read from (default `process.env`). */
  env?: Record<string, string | undefined>;
}

function bad(message: string): PolarisError {
  return new PolarisError(ErrorCode.invalidOptions, message);
}

function checked(id: string, from: string): string {
  const v = id.trim();
  if (!DEVICE_ID_RE.test(v))
    throw bad(`${from} is not a device id (32 characters of A-Z a-z 0-9 _ -).`);
  return v;
}

/** The device id: the option, `PKEY_DEVICE_ID`, or the volume file (created on first start). */
export function resolveServerDeviceId(
  product: string,
  o: Pick<ServerClientOptions, "deviceId" | "deviceIdFile">,
  env: Record<string, string | undefined>,
): string {
  if (o.deviceId) return checked(o.deviceId, "deviceId");
  if (env.PKEY_DEVICE_ID) return checked(env.PKEY_DEVICE_ID, "PKEY_DEVICE_ID");
  const file = o.deviceIdFile ?? env.PKEY_DEVICE_ID_FILE;
  if (!file)
    throw bad(
      "serverClient() needs a stable device id: set PKEY_DEVICE_ID, or PKEY_DEVICE_ID_FILE to a file on a volume.",
    );
  try {
    return checked(readFileSync(file, "utf8"), file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const id = deviceIdFromRaw(product, randomUUID());
  mkdirSync(dirname(file), { recursive: true });
  // `wx`: a second container racing on the same volume loses and reads the winner's id.
  try {
    writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return checked(readFileSync(file, "utf8"), file);
  }
  return id;
}

/**
 * The normal client for a server: memory store, stable device id, `PKEY_LICENSE_KEY`, no device
 * reports and a background refresh. Resolves once the key is activated and the first sync is
 * done; read config with `client.config.get()`. `close()` stops the refresh.
 *
 * Throws `invalid-options` for a missing or malformed id or key, and a `PolarisError` carrying
 * the server's code when the key is refused (`device_limit`, `unauthorized`, …).
 */
export async function serverClient(
  opts: ServerClientOptions,
): Promise<PolarisKeyClient> {
  const { deviceId, deviceIdFile, licenseKey, env, ...rest } = opts;
  const vars = env ?? process.env;
  const key = licenseKey ?? vars.PKEY_LICENSE_KEY;
  if (!key) throw bad("serverClient() needs PKEY_LICENSE_KEY (or licenseKey).");
  const id = resolveServerDeviceId(
    opts.productSlug,
    { deviceId, deviceIdFile },
    vars,
  );
  const client = await PolarisKeyClient.create({
    ...rest,
    store: new InMemoryStore(opts.productSlug, id),
    // A container's hardware is not a stable anchor; a caller who wants one passes `fingerprint`.
    license: { fingerprint: false, ...rest.license },
    devices: { ...rest.devices, reports: false },
  });
  try {
    const r = await client.license.activateWithKey(key);
    if (r.kind !== "ok") {
      const refused = r as { kind: string; code?: string; message?: string };
      throw new PolarisError(
        refused.code || refused.kind,
        `serverClient() could not activate its licence key: ${refused.message || refused.kind}`,
      );
    }
    client.startRefresh({ intervalSeconds: opts.refreshIntervalSeconds });
  } catch (e) {
    client.close();
    throw e;
  }
  return client;
}

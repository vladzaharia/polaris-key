/// <reference types="@cloudflare/workers-types" />

/**
 * The key ring's minimum SDK build (SYNC-MINSDK, D-39b). Every `devices/keyring*` route runs this
 * before it does anything else: a request whose `X-PKey-SDK` names an SDK with a minimum
 * (`cloudSync.minSdk.<sdk>`, `core/settings/minSdk.ts`) and whose `X-PKey-SDK-Version` is below it
 * is refused with `403 version_blocked`. The read of the ring is the one that matters: an old
 * build opens the served wrap from it.
 *
 * Only a stamped release version is compared, by `major.minor.patch` (`-main.N` and other
 * pre-release tags count by their base). The committed placeholders (`0.0.0`, `0.1.0`, `0.2.0`),
 * an unparseable version, an unknown SDK, a missing header and an unset minimum all pass. An
 * unreadable settings store passes too: this is an update nudge, not an access gate.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
} from "@polaris-key/protocol/core";
import { normalizeSdkHeader } from "../clientMetadata.js";
import { platformSetting } from "../settings/platformRead.js";
import { MIN_SDK_IDS, type MinSdkId } from "../settings/minSdk.js";
import { wireError } from "../errors.js";

/** Versions the SDK sources carry before a release stamps them; they are never gated. */
const PLACEHOLDER_VERSIONS: ReadonlySet<string> = new Set([
  "0.0.0",
  "0.1.0",
  "0.2.0",
]);

const VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `major.minor.patch` of a release version; pre-release and build tags are dropped. */
function base(v: string): [number, number, number] | null {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `version` a stamped release below `minimum`? False for anything it cannot compare. */
export function belowMinimum(version: string, minimum: string): boolean {
  const v = base(version);
  const m = base(minimum);
  if (!v || !m) return false;
  if (PLACEHOLDER_VERSIONS.has(`${v[0]}.${v[1]}.${v[2]}`)) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== m[i]) return v[i]! < m[i]!;
  return false;
}

const isSdk = (id: string | null): id is MinSdkId =>
  id !== null && (MIN_SDK_IDS as readonly string[]).includes(id);

/** The refusal to answer with, or null when the request may go on. */
export async function keyringMinSdkRefusal(
  req: Request,
  env: Env,
  db: Db,
): Promise<Response | null> {
  const sdk = normalizeSdkHeader(req.headers.get(HEADER_SDK_NAME));
  const version = req.headers.get(HEADER_SDK_VERSION);
  if (!isSdk(sdk) || !version) return null;
  let minimum: string | null;
  try {
    minimum = await platformSetting(
      env,
      db,
      `cloudSync.minSdk.${sdk}` as const,
    );
  } catch {
    return null;
  }
  if (!minimum || !belowMinimum(version, minimum)) return null;
  return wireError(403, "version_blocked");
}

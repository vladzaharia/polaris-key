// The Cloud Connect state record, `pkey.connect.v1` (CC-08.1; WIRE-CONTRACT-V5 §15.3, §15.4): the
// held roster and certificate as the compact JWSs the Worker signed, and K_disc, the discovery
// key(s), which is a secret of the same standing as the device keys. It sits in its own file in the
// SDK's state directory, written through the device key store's file storage: `0600` in a `0700`
// directory, replaced atomically, refused when the directory or file is foreign or loose. A host
// whose keys are memory-only gets a memory record, which dies with the process.
//
// Rules this module keeps:
//  - the record is parsed strictly; one that exists but is unusable is an error for the caller to
//    surface, never silently replaced (replacing it would forget the held roster);
//  - K_disc is a field of the record and of nothing else here: no accessor logs, formats or
//    returns it except `discoveryKeys()` on the client, which hands out bytes.

import { join } from "node:path";
import {
  FileDeviceKeyStorage,
  InMemoryDeviceKeyStorage,
  type NodeDeviceKeyStorage,
} from "../devices/deviceKeys.js";

export const CONNECT_STATE_SCHEMA = "pkey.connect.v1";
export const CONNECT_STATE_FILE = "pkey.connect.v1.json";

/** What is held for one device and one product. */
export interface ConnectStateRecord {
  schema: typeof CONNECT_STATE_SCHEMA;
  product: string;
  deviceId: string;
  /** The `pkey-ring+jws` held (verified when it was stored, and again when it is used). */
  ring: string;
  /** This device's `pkey-peer+jws`. */
  certificate: string;
  /** K_disc, newest first: the current key, then at most one previous key (canonical base64url). */
  discKeys: string[];
  /** The latest instant (seconds) the previous key may be used, or null when there is none. */
  prevUntil: number | null;
  /** The epoch of the roster the keys belong to. */
  epoch: number;
  /** The keys this device registered with the Worker, so an unchanged pair is not re-sent. */
  registered: { signKey: string; agreeKey: string } | null;
  storedAt: number;
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseConnectState(raw: Buffer): ConnectStateRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.schema !== CONNECT_STATE_SCHEMA) return null;
  const keys = v.discKeys;
  const reg = v.registered;
  if (
    typeof v.product !== "string" ||
    typeof v.deviceId !== "string" ||
    typeof v.ring !== "string" ||
    typeof v.certificate !== "string" ||
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.every((k) => typeof k === "string" && KEY.test(k)) ||
    !(v.prevUntil === null || Number.isSafeInteger(v.prevUntil)) ||
    !Number.isSafeInteger(v.epoch) ||
    !Number.isSafeInteger(v.storedAt)
  )
    return null;
  let registered: ConnectStateRecord["registered"] = null;
  if (reg !== null && reg !== undefined) {
    if (
      !isRecord(reg) ||
      typeof reg.signKey !== "string" ||
      typeof reg.agreeKey !== "string"
    )
      return null;
    registered = { signKey: reg.signKey, agreeKey: reg.agreeKey };
  }
  return {
    schema: CONNECT_STATE_SCHEMA,
    product: v.product,
    deviceId: v.deviceId,
    ring: v.ring,
    certificate: v.certificate,
    discKeys: keys as string[],
    prevUntil: v.prevUntil as number | null,
    epoch: v.epoch as number,
    registered,
    storedAt: v.storedAt as number,
  };
}

/** The record's home: the file store in the state directory, or memory. */
export function connectStorage(
  stateDir: string,
  persistence: "durable" | "memory",
): NodeDeviceKeyStorage {
  return persistence === "memory"
    ? new InMemoryDeviceKeyStorage()
    : new FileDeviceKeyStorage(join(stateDir, CONNECT_STATE_FILE));
}

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
import { isCanonicalB64url } from "@polaris-key/jws";
import {
  MAX_CONTACTS,
  MAX_CONTACT_CATS,
  MAX_PENDING_CONTACTS,
} from "@polaris-key/client-core/peer";
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
  /** A pushed roster removed a device, so K_disc was replaced at the Worker and this copy is
   *  stale until the next identity fetch. Absent when false. */
  keysStale?: true;
  /**
   * The inter-account links this device holds for the product (WIRE-CONTRACT-V5 §15.10), in the
   * order they are held, at most `MAX_CONTACTS` and `MAX_PENDING_CONTACTS` pending ones. Each
   * carries a contact secret: key material of the same standing as K_disc. Absent when none.
   */
  contacts?: ContactRow[];
}

/** One contact as it rests in the record. `secret` and `agreeKey` are canonical base64url of 32 bytes. */
export interface ContactRow {
  agreeKey: string;
  secret: string;
  label?: string;
  cats: string[];
  createdAt: number;
  /** The host's local "advertise and keep a relay room for this contact" choice. */
  reachable: boolean;
  /** Unix seconds when a re-pair stored this contact pending (§15.10); absent for a held one. */
  pendingSince?: number;
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const CAT = /^[a-z0-9-]{1,32}$/;
export const key32 = (v: unknown): v is string =>
  typeof v === "string" && KEY.test(v) && isCanonicalB64url(v);
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The contact rows of a record, or null when any row breaks a rule (the record is then unusable). */
function parseContacts(v: unknown): ContactRow[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length > MAX_CONTACTS + MAX_PENDING_CONTACTS) return null;
  const out: ContactRow[] = [];
  for (const r of v) {
    if (!isRecord(r)) return null;
    if (!key32(r.agreeKey) || !key32(r.secret)) return null;
    if (
      !Array.isArray(r.cats) ||
      r.cats.length > MAX_CONTACT_CATS ||
      !r.cats.every((c) => typeof c === "string" && CAT.test(c)) ||
      new Set(r.cats).size !== r.cats.length
    )
      return null;
    if (r.label !== undefined && typeof r.label !== "string") return null;
    if (!Number.isSafeInteger(r.createdAt)) return null;
    if (typeof r.reachable !== "boolean") return null;
    if (r.pendingSince !== undefined && !Number.isSafeInteger(r.pendingSince))
      return null;
    out.push({
      agreeKey: r.agreeKey,
      secret: r.secret,
      ...(r.label !== undefined ? { label: r.label } : {}),
      cats: [...(r.cats as string[])],
      createdAt: r.createdAt as number,
      reachable: r.reachable,
      ...(r.pendingSince !== undefined
        ? { pendingSince: r.pendingSince as number }
        : {}),
    });
  }
  return out;
}

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
  let contacts: ContactRow[] | undefined;
  if (v.contacts !== undefined) {
    const c = parseContacts(v.contacts);
    if (c === null) return null;
    if (c.length > 0) contacts = c;
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
    ...(v.keysStale === true ? { keysStale: true as const } : {}),
    ...(contacts !== undefined ? { contacts } : {}),
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

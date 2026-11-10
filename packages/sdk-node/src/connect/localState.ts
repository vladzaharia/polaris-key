// The local-link store, `pkey.connect.local.v1` (CC-29.7; WIRE-CONTRACT-V5 §15.12, "What each side
// stores"): the links this device holds for one product, each with its own link private key and the
// link secret. It sits in its own file in the SDK's state directory, written through the same
// file storage as the Cloud Connect record (`0600` in a `0700` directory, replaced atomically,
// refused when foreign or loose), or in memory for a host whose keys are memory-only. It is not
// account data: a sign-out, a licence deactivation and an account deletion leave it alone.
//
// Rules this module keeps:
//  - the record is parsed strictly; one that exists but is unusable is an error for the caller to
//    surface, never silently replaced (replacing it would forget the held links);
//  - a private key and a secret are fields of the record and of nothing else here: `LocalLinkInfo`
//    carries neither, and no error or print names one;
//  - a link is added under the store's lock, which also holds the cap (`MAX_LOCAL_LINKS`);
//  - a link in use (`LiveLocal`) carries its decoded key and secret: the user of one wipes it.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { PolarisError } from "@polaris-key/client-core";
import {
  MAX_CONTACT_CATS,
  MAX_LIVE_LOCAL_ADVERTS,
  MAX_LOCAL_LINKS,
} from "@polaris-key/client-core/peer";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { ErrorCode } from "../constants.generated.js";
import {
  DeviceKeyStoreError,
  FileDeviceKeyStorage,
  InMemoryDeviceKeyStorage,
  type NodeDeviceKeyStorage,
} from "../devices/deviceKeys.js";
import { serialQueue } from "./channel.js";
import { isRecord, key32 } from "./state.js";

export const LOCAL_STATE_SCHEMA = "pkey.connect.local.v1";
export const LOCAL_STATE_FILE = "pkey.connect.local.v1.json";

/** One link as it rests in the record. Keys and the secret are canonical base64url of 32 bytes. */
export interface LocalLinkRow {
  id: string;
  /** This device's private key for the link: the static key of every session under it. */
  ownKey: string;
  ownPublic: string;
  peerKey: string;
  secret: string;
  /** The peer's label, cleaned; a rename replaces it on this device only. */
  label?: string;
  cats: string[];
  createdAt: number;
  lastSeen?: number;
  /** The host's local "advertise this link on the LAN" choice. */
  reachable: boolean;
}

/** What the host sees of one link. No key, no secret. */
export interface LocalLinkInfo {
  /** Names the link on this device (16 characters). Not the peer's key and not shared. */
  id: string;
  label: string | null;
  /** The data categories both people approved, in byte order. */
  categories: readonly string[];
  /** Unix seconds. */
  createdAt: number;
  lastSeen: number | null;
  reachable: boolean;
}

interface LocalStateRecord {
  schema: typeof LOCAL_STATE_SCHEMA;
  product: string;
  links: LocalLinkRow[];
}

const CAT = /^[a-z0-9-]{1,32}$/;
const ID = /^[A-Za-z0-9_-]{16}$/;

/** At most 8 distinct categories, each matching `^[a-z0-9-]{1,32}$`. */
const catsOk = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= MAX_CONTACT_CATS &&
  new Set(v).size === v.length &&
  v.every((c) => typeof c === "string" && CAT.test(c));

/**
 * The id of a link on this device: `SHA-256("pkey-local/1" 0x00 peerKey)[0..12]` in base64url,
 * 16 characters. Derived from the peer's link key, a public key, and meaningful here only.
 */
export const localLinkId = (peerKey: Uint8Array): string =>
  base64UrlEncodeBytes(
    createHash("sha256")
      .update("pkey-local/1")
      .update(Uint8Array.of(0))
      .update(peerKey)
      .digest()
      .subarray(0, 12),
  );

function parseRows(v: unknown): LocalLinkRow[] | null {
  if (!Array.isArray(v) || v.length > MAX_LOCAL_LINKS) return null;
  const out: LocalLinkRow[] = [];
  for (const r of v) {
    if (!isRecord(r)) return null;
    if (
      typeof r.id !== "string" ||
      !ID.test(r.id) ||
      !key32(r.ownKey) ||
      !key32(r.ownPublic) ||
      !key32(r.peerKey) ||
      !key32(r.secret)
    )
      return null;
    if (!catsOk(r.cats)) return null;
    if (r.label !== undefined && typeof r.label !== "string") return null;
    if (!Number.isSafeInteger(r.createdAt)) return null;
    if (r.lastSeen !== undefined && !Number.isSafeInteger(r.lastSeen))
      return null;
    if (typeof r.reachable !== "boolean") return null;
    out.push({
      id: r.id,
      ownKey: r.ownKey,
      ownPublic: r.ownPublic,
      peerKey: r.peerKey,
      secret: r.secret,
      ...(r.label !== undefined ? { label: r.label } : {}),
      cats: [...r.cats],
      createdAt: r.createdAt as number,
      ...(r.lastSeen !== undefined ? { lastSeen: r.lastSeen as number } : {}),
      reachable: r.reachable,
    });
  }
  return out;
}

/** The rows of a record, or null when it is unusable (not this schema, or any row breaks a rule). */
export function parseLocalState(
  raw: Buffer,
  product: string,
): LocalLinkRow[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(v) || v.schema !== LOCAL_STATE_SCHEMA) return null;
  if (v.product !== product) return null;
  return parseRows(v.links);
}

/** The link a session was made over (mode `l`). No key, no secret. */
export interface LocalRef {
  id: string;
  /** The stored label, or the one the person gave it with `rename`. */
  label: string | null;
  categories: readonly string[];
  /** The peer's link public key, canonical base64url of 32 bytes. */
  peerKey: string;
  /** @internal A one-way tag of the secret the session opened under (not the secret). */
  tag: string;
}

/** A link in use: the row with its key and secret decoded. `wipeLocals` zeroes them. */
export interface LiveLocal {
  readonly id: string;
  readonly ownKey: Uint8Array;
  readonly ownPublic: Uint8Array;
  readonly peerKey: Uint8Array;
  readonly secret: Uint8Array;
  readonly label: string | null;
  readonly cats: readonly string[];
  readonly reachable: boolean;
  readonly tag: string;
}

/** A one-way tag that tells two secrets apart without holding either. */
export const localTag = (secret: Uint8Array): string =>
  createHash("sha256")
    .update("pkey-local-tag/1")
    .update(Uint8Array.of(0))
    .update(secret)
    .digest()
    .subarray(0, 12)
    .toString("base64url");

export const liveOfLocal = (r: LocalLinkRow): LiveLocal => {
  const secret = base64UrlDecode(r.secret);
  return {
    id: r.id,
    ownKey: base64UrlDecode(r.ownKey),
    ownPublic: base64UrlDecode(r.ownPublic),
    peerKey: base64UrlDecode(r.peerKey),
    secret,
    label: r.label ?? null,
    cats: r.cats,
    reachable: r.reachable,
    tag: localTag(secret),
  };
};

export const refOfLocal = (l: LiveLocal): LocalRef => ({
  id: l.id,
  label: l.label,
  categories: l.cats,
  peerKey: base64UrlEncodeBytes(l.peerKey),
  tag: l.tag,
});

export const wipeLocals = (ls: readonly LiveLocal[]): void => {
  for (const l of ls) {
    l.secret.fill(0);
    l.ownKey.fill(0);
  }
};

/** The record's home: the file store in the state directory, or memory. */
export function localStorage(
  stateDir: string,
  persistence: "durable" | "memory",
): NodeDeviceKeyStorage {
  return persistence === "memory"
    ? new InMemoryDeviceKeyStorage()
    : new FileDeviceKeyStorage(join(stateDir, LOCAL_STATE_FILE));
}

export const infoOfLocal = (rows: readonly LocalLinkRow[]): LocalLinkInfo[] =>
  rows.map((r) => ({
    id: r.id,
    label: r.label ?? null,
    categories: [...r.cats],
    createdAt: r.createdAt,
    lastSeen: r.lastSeen ?? null,
    reachable: r.reachable,
  }));

/** The links this device holds for one product. */
export class LocalLinkStore {
  readonly #serial = serialQueue();
  #storage: NodeDeviceKeyStorage | null = null;

  constructor(
    private readonly product: string,
    private readonly open: () => Promise<NodeDeviceKeyStorage>,
  ) {}

  async #store(): Promise<NodeDeviceKeyStorage> {
    this.#storage ??= await this.open();
    return this.#storage;
  }

  #error(e: unknown): PolarisError {
    if (e instanceof PolarisError) return e;
    const what = e instanceof DeviceKeyStoreError ? e.message : "store fault";
    return new PolarisError(
      ErrorCode.storeFailed,
      `The local links could not be used: ${what}`,
      { cause: e },
    );
  }

  async #load(): Promise<LocalLinkRow[]> {
    let raw: Buffer | null;
    try {
      raw = await (await this.#store()).get();
    } catch (e) {
      throw this.#error(e);
    }
    if (raw === null) return [];
    try {
      const rows = parseLocalState(raw, this.product);
      if (rows === null)
        throw new PolarisError(
          ErrorCode.storeFailed,
          "The local links record is unreadable.",
        );
      return rows;
    } finally {
      raw.fill(0);
    }
  }

  /** The rows, with their keys and secrets: they stay inside the SDK. @internal */
  rows(): Promise<LocalLinkRow[]> {
    return this.#serial(() => this.#load());
  }

  /** How many links are held. */
  async count(): Promise<number> {
    return (await this.rows()).length;
  }

  /**
   * Change the rows under the store's lock: `fn` returns the new rows, or null for no change.
   * Resolves with the rows as they are after. @internal
   */
  update(
    fn: (rows: LocalLinkRow[]) => LocalLinkRow[] | null,
  ): Promise<LocalLinkRow[]> {
    return this.#serial(async () => {
      // Read, judge and write inside the file lock, so a second process on this directory cannot
      // pass the cap or overwrite a link between the read and the write.
      let result: LocalLinkRow[] = [];
      try {
        await (
          await this.#store()
        ).update((current) => {
          let base: LocalLinkRow[] = [];
          if (current !== null) {
            const rows = parseLocalState(current, this.product);
            if (rows === null)
              throw new PolarisError(
                ErrorCode.storeFailed,
                "The local links record is unreadable.",
              );
            base = rows;
          }
          const next = fn(base);
          result = next ?? base;
          if (next === null) return null;
          const rec: LocalStateRecord = {
            schema: LOCAL_STATE_SCHEMA,
            product: this.product,
            links: next,
          };
          return Buffer.from(JSON.stringify(rec), "utf8");
        });
      } catch (e) {
        throw this.#error(e);
      }
      return result;
    });
  }

  /**
   * Add a link, unless the device already holds `MAX_LOCAL_LINKS`. The cap is judged under the
   * lock, so two pairings that finish together cannot both pass it. @internal
   */
  async add(link: {
    ownKey: Uint8Array;
    ownPublic: Uint8Array;
    peerKey: Uint8Array;
    secret: Uint8Array;
    label?: string;
    cats: readonly string[];
    now: number;
  }): Promise<{ stored: true; id: string } | { stored: false }> {
    const id = localLinkId(link.peerKey);
    let full = false;
    await this.update((rows) => {
      if (rows.length >= MAX_LOCAL_LINKS) {
        full = true;
        return null;
      }
      const others = rows.filter((r) => r.id !== id);
      // Reachable by default; with the live-advert limit already reached the new link is stored
      // off and the list says so (§15.12, "Reachable by default").
      const reachable =
        others.filter((r) => r.reachable).length < MAX_LIVE_LOCAL_ADVERTS;
      return [
        ...others,
        {
          id,
          ownKey: base64UrlEncodeBytes(link.ownKey),
          ownPublic: base64UrlEncodeBytes(link.ownPublic),
          peerKey: base64UrlEncodeBytes(link.peerKey),
          secret: base64UrlEncodeBytes(link.secret),
          ...(link.label !== undefined ? { label: link.label } : {}),
          cats: [...link.cats],
          createdAt: link.now,
          reachable,
        },
      ];
    });
    return full ? { stored: false } : { stored: true, id };
  }
}

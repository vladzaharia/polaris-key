// WIRE-CONTRACT-V5 §15.4: discovery adverts. Pure functions: the account instance name, the
// product tag, TXT parsing and the browse match. Nothing here does I/O.

import { hmac, sha256 } from "./noise.js";

export const ADVERT_EPOCH_SECONDS = 900;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]): Uint8Array =>
  Uint8Array.from(p.flatMap((x) => Array.from(x)));
const u64be = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

export const advertEpoch = (nowSeconds: number): number =>
  Math.floor(nowSeconds / ADVERT_EPOCH_SECONDS);

/** RFC 4648 base32, lower-case alphabet, no padding. */
export function base32Lower(b: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/** A device id is 32 base64url characters: the 24 bytes the advert and the relay use. */
export function deviceIdBytes(id: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new RangeError("device id");
  const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The mode-a instance name of a device in one epoch under one discovery key. */
export async function accountInstance(
  kDisc: Uint8Array,
  epoch: number,
  deviceId: string,
): Promise<string> {
  const mac = await hmac(
    kDisc,
    cat(
      utf8("pkey-peer/1 disc"),
      Uint8Array.of(0),
      u64be(epoch),
      deviceIdBytes(deviceId),
    ),
  );
  return `p1-${base32Lower(mac).slice(0, 16)}`;
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The `h` TXT value of the approver and pair adverts. */
export async function productTag(slug: string, epoch: number): Promise<string> {
  const salt = await sha256(
    utf8("pkey-peer/1 salt"),
    Uint8Array.of(0),
    utf8(slug),
  );
  const mac = await hmac(
    salt,
    cat(utf8("pkey-peer/1 pair"), Uint8Array.of(0), u64be(epoch)),
  );
  return hex(mac).slice(0, 16);
}

export const isInstanceName = (name: string): boolean =>
  /^p1-[a-z2-7]{16}$/.test(name);

export type TxtResult =
  | { ok: true; mode: "a" | "v" | "p"; h?: string }
  | { ok: false; reason: "duplicate" | "version" | "mode" | "tag" };

/** An entry splits at its first `=`; one without `=` or with an empty key is ignored; a repeated key refuses. */
export function parseTxt(entries: readonly string[]): TxtResult {
  const kv = new Map<string, string>();
  for (const e of entries) {
    const at = e.indexOf("=");
    if (at < 1) continue;
    const k = e.slice(0, at);
    if (kv.has(k)) return { ok: false, reason: "duplicate" };
    kv.set(k, e.slice(at + 1));
  }
  if (kv.get("v") !== "1") return { ok: false, reason: "version" };
  const m = kv.get("m");
  if (m !== "a" && m !== "v" && m !== "p") return { ok: false, reason: "mode" };
  if (m === "a") return { ok: true, mode: m };
  const h = kv.get("h");
  if (h === undefined || !/^[0-9a-f]{16}$/.test(h))
    return { ok: false, reason: "tag" };
  return { ok: true, mode: m, h };
}

export interface BrowseHit {
  deviceId: string;
  /** 0 the current epoch, 1 the previous one. */
  epochBack: 0 | 1;
  /** 0 the newest discovery key, 1 the previous one. */
  keyIndex: 0 | 1;
}

/**
 * Which roster device an account instance belongs to: the current and the previous epoch, the
 * (at most two) delivered keys, newest first. At most 512 HMACs for a 128-device roster.
 */
export async function browseAccountInstance(
  instance: string,
  kDiscs: readonly Uint8Array[],
  nowSeconds: number,
  roster: readonly string[],
): Promise<BrowseHit | null> {
  if (!isInstanceName(instance)) return null;
  const epoch = advertEpoch(nowSeconds);
  for (const epochBack of [0, 1] as const)
    for (let i = 0; i < kDiscs.length && i < 2; i++)
      for (const deviceId of roster.slice(0, 128))
        if (
          (await accountInstance(kDiscs[i]!, epoch - epochBack, deviceId)) ===
          instance
        )
          return { deviceId, epochBack, keyIndex: i as 0 | 1 };
  return null;
}

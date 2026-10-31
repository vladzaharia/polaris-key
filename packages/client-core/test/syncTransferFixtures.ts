// Shared by the transfer engine tests: deterministic filler and reply builders.
import type { FileReply } from "../src/sync/index.js";

export const MIB = 1024 * 1024;
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** xorshift32, so each seed is a different file. */
export const noise = (length: number, seed = 1): Uint8Array => {
  let x = seed * 2_654_435_761 || 1;
  return Uint8Array.from({ length }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 0xff;
  });
};

export const ok = <T>(value: T): FileReply<T> => ({ ok: true, value });
export const fail = (
  status: number,
  code: string,
  extra: object = {},
): FileReply<never> => ({ ok: false, status, code, ...extra });

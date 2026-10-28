// Cloud Sync's `pkey-sync-cdc/1` chunker (client-core, streaming) cuts at the same offsets as the
// pack chunker's `fastcdc` (`packChunks.ts`) at the same parameters (WIRE-CONTRACT-V5 §13.8.3
// names the pack chunker's gear table).

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cdcLengths, cdcParams } from "@polaris-key/client-core/sync";
import { fastcdc } from "../src/packChunks.js";

function stream(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let at = 0, i = 0; at < length; i++, at += 32) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(i);
    const block = createHash("sha256").update(label).update(ctr).digest();
    out.set(block.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

describe("sync cdc matches the pack chunker", () => {
  for (const [avg, length] of [
    [1024, 200_000],
    [65536, 3_000_000],
    [262144, 5_000_003],
  ] as const) {
    it(`avg ${String(avg)}`, () => {
      const data = stream(`parity ${String(avg)}`, length);
      expect(cdcLengths(data, cdcParams(avg))).toEqual(
        fastcdc(data, avg).map(([, n]) => n),
      );
    });
  }
});

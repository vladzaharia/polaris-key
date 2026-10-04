/// <reference types="@cloudflare/workers-types" />
// ── The lazy-delta consumer Worker on workerd (P4-17) ──────────────────────────────────────
//
// What only this runtime can show: the consumer's real entry (`src/deltasEntry.ts`, booted from
// wrangler.deltas.toml) imports `zenc.wasm` as a compiled module and encodes in it, and its
// `queue` handler drains a real `MessageBatch` against real D1 and R2 bindings: a hot pair
// becomes one verified frame at `deltas/<from>/<to>.zstd-patch-from` with its row, the message
// is explicitly acknowledged, and a duplicate does nothing.

import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { patchFrom } from "@polaris-key/zstd-wasm/encoder";
import { decodeWithPrefix } from "@polaris-key/zstd-wasm";
import worker from "../src/deltasEntry.js";
import {
  blobKey,
  deltaKey,
  putVerified,
  recordObject,
} from "../src/core/blobs.js";
import { D1Db } from "../src/db/d1.js";
import { NOW, seedProduct } from "../test-workerd/seed.js";
import { pairMessage } from "../src/services/release/packs/deltas/messages.js";

const LANE = { timeout: 120_000 };
const P = "lazyw";
const PACK = "lazyw.core";

async function sha(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function release(
  db: D1Db,
  version: string,
  seq: number,
  payload: Uint8Array,
): Promise<string> {
  const h = await sha(payload);
  const releaseId = `${PACK}@${version}`;
  const record = {
    schemaVersion: 1,
    aud: P,
    deliverable: PACK,
    kind: "pack",
    version,
    seq,
    issuedAt: NOW,
    type: "godot.pck",
    formatVersion: 4,
    variants: [
      {
        variant: {},
        payload: { size: payload.length, sha256: h },
        full: {
          sha256: h,
          bytes: payload.length,
          size: payload.length,
          codec: "none",
        },
        files: {
          format: "pkey-files/1",
          layout: "container",
          sha256: "c".repeat(64),
          bytes: 10,
          size: 10,
          codec: "none",
          gaps: { sha256: "d".repeat(64), bytes: 1, size: 1, codec: "none" },
        },
      },
    ],
  };
  const jws = `h.${b64url(JSON.stringify(record))}.s`;
  await db.run(
    `INSERT INTO release_metadata (product, release_id, version, created_at, modified_at, deliverable_id, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    P,
    releaseId,
    version,
    NOW,
    NOW,
    PACK,
    seq,
  );
  await db.run(
    `INSERT INTO release_records (product, deliverable_id, release_id, seq, kind, record_sha256, kid, jws, ingested_at)
     VALUES (?, ?, ?, ?, 'pack', ?, 'k', ?, ?)`,
    P,
    PACK,
    releaseId,
    seq,
    await sha(new TextEncoder().encode(jws)),
    jws,
    NOW,
  );
  const key = blobKey(h);
  expect(
    (
      await putVerified(env.BLOBS!, key, payload, {
        sha256: h,
        size: payload.length,
      })
    ).ok,
  ).toBe(true);
  await recordObject(
    db,
    {
      storageKey: key,
      sha256: h,
      size: payload.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  await db.run(
    `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at) VALUES (?, ?, 'pack-object', ?, ?)`,
    P,
    key,
    releaseId,
    NOW,
  );
  return h;
}

describe("the consumer Worker", () => {
  it(
    "encodes in workerd: zenc.wasm compiles as a module and a 32 MiB pair stays under 96 MiB",
    LANE,
    async () => {
      const n = 32 * 1024 * 1024;
      const a = bytes(n, 1);
      const b = a.slice();
      for (let k = 0; k < 64; k++) b[(k * 524287) % n]! ^= 0xff;
      const side = async (raw: Uint8Array) => ({
        size: raw.length,
        bytes: raw.length,
        codec: "none" as const,
        sha256: await sha(raw),
        read: async function* () {
          for (let o = 0; o < raw.length; o += 1 << 20)
            yield raw.subarray(o, o + (1 << 20));
        },
      });
      const r = await patchFrom({
        from: await side(a),
        to: await side(b),
        level: 9,
        maxInputBytes: n,
      });
      expect(r.memoryBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
      expect(r.windowLog).toBe(26);
      await expect(
        patchFrom({
          from: await side(a),
          to: await side(b),
          level: 16,
          maxInputBytes: n,
        }),
      ).rejects.toMatchObject({ code: "level" });
    },
  );

  it(
    "drains a pair message through the real queue handler, once",
    LANE,
    async () => {
      const db = new D1Db(env.DB);
      await seedProduct(
        // The seed seals a signing key; the consumer itself never opens one.
        {
          ...env,
          PLATFORM_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        db,
        P,
        { schemaVersion: 1, entries: [] },
      );
      await db.run(
        "INSERT INTO lazy_delta_settings (product, enabled, hot_devices, daily_cap, updated_at) VALUES (?, 1, 1, 5, ?)",
        P,
        NOW,
      );
      // Over 1 MiB, so a delta can save the 1 MiB the policy asks for against the full object.
      const v1 = bytes(3_000_000, 7);
      const v2 = v1.slice();
      for (let i = 0; i < 20; i++) v2[i * 130001]! ^= 0x33;
      const from = await release(db, "1.0.0", 1, v1);
      const to = await release(db, "1.1.0", 2, v2);
      await db.run(
        `INSERT INTO delta_demand_devices (product, deliverable_id, from_sha256, to_sha256, device_id, strategy, seen_at)
       VALUES (?, ?, ?, ?, 'd1', 'full', ?)`,
        P,
        PACK,
        from,
        to,
        Math.floor(Date.now() / 1000),
      );
      const body = pairMessage(P, PACK, from, to);
      const run = async () => {
        const batch = createMessageBatch("pkey-deltas-test", [
          { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body },
        ]);
        const ctx = createExecutionContext();
        await worker.queue(batch, env);
        return getQueueResult(batch, ctx);
      };
      const first = await run();
      expect(first.explicitAcks).toHaveLength(1);
      expect(first.retryMessages).toEqual([]);
      const key = deltaKey(from, to, "zstd-patch-from");
      const obj = await env.BLOBS!.get(key);
      expect(obj).not.toBeNull();
      const frame = new Uint8Array(await obj!.arrayBuffer());
      expect(await sha(decodeWithPrefix(frame, v1, v2.length, 23))).toBe(to);
      const row = await db.first<{ state: string; descriptor_json: string }>(
        "SELECT state, descriptor_json FROM release_lazy_deltas WHERE product = ? AND to_sha256 = ?",
        P,
        to,
      );
      expect(row?.state).toBe("ready");
      expect(JSON.parse(row!.descriptor_json).artifact.sha256).toBe(
        await sha(frame),
      );
      const uploaded = obj!.uploaded.getTime();
      const second = await run();
      expect(second.explicitAcks).toHaveLength(1);
      expect((await env.BLOBS!.head(key))!.uploaded.getTime()).toBe(uploaded);
    },
  );
});

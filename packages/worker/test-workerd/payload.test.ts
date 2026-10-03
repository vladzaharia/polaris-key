/// <reference types="@cloudflare/workers-types" />
// ── The payload URL's pre-encoded bodies on workerd (P4-18) ───────────────────────────────
//
// The Node lane proves the route. This proves what only workerd has: the dcz body (the 40-byte
// header, then the artifact streamed from R2) through `FixedLengthStream`, and the route end to
// end through the Worker's real entry point (D1, R2, `preEncoded`'s `encodeBody: "manual"`): the
// stored frame and the dcz stream leave byte-exact. (`encodeBody` is not readable on a
// `Response`, and this runtime does not encode `zstd` itself, so the end-to-end check is what
// pins the bytes; the edge step stays so that a runtime that does never encodes them twice.)

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { blobKey, putVerified, recordObject } from "../src/core/blobs.js";
import { D1Db } from "../src/db/d1.js";
import { setServices } from "../src/repo.js";
import { serializeServices } from "../src/core/services.js";
import { packReleaseStatements } from "../src/services/release/packs/ingest.js";
import { NOW, seedProduct } from "./seed.js";
import { prefixed } from "../src/services/distribution/payload.js";
import {
  DCZ_MAGIC,
  dczHeader,
} from "../src/services/distribution/dictionary.js";
import { preEncoded } from "../src/index.js";

const LANE = { timeout: 60_000 };
const PACK = "dczw.core";

function hexBytes(h: string): number[] {
  return Array.from({ length: h.length / 2 }, (_, i) =>
    parseInt(h.slice(i * 2, i * 2 + 2), 16),
  );
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One zstd frame of raw blocks (RFC 8878 §3.1.1.2), single-segment, 4-byte content size. */
function rawZstdFrame(content: Uint8Array): Uint8Array {
  const n = content.length;
  const out: number[] = [
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0xa0,
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ];
  const MAX_BLOCK = 128 * 1024;
  let pos = 0;
  do {
    const size = Math.min(MAX_BLOCK, n - pos);
    const h = (size << 3) | (pos + size >= n ? 1 : 0);
    out.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff);
    for (let i = 0; i < size; i++) out.push(content[pos + i]!);
    pos += size;
  } while (pos < n);
  return Uint8Array.from(out);
}

async function hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("the payload URL on workerd (P4-18)", () => {
  it("streams the dcz header and an R2 artifact through FixedLengthStream, byte-exact", async () => {
    const artifact = new Uint8Array(300_000);
    for (let i = 0; i < artifact.length; i++) artifact[i] = (i * 7 + 3) & 0xff;
    const sha256 = await hex(artifact);
    const key = blobKey(sha256);
    expect(
      await putVerified(env.BLOBS!, key, artifact, {
        sha256,
        size: artifact.length,
      }),
    ).toMatchObject({ ok: true });
    const obj = await env.BLOBS!.get(key);
    const from = await hex(new TextEncoder().encode("the base payload"));
    const length = 40 + artifact.length;
    const res = preEncoded(
      new Response(prefixed(dczHeader(from), obj!.body, length), {
        headers: {
          "content-encoding": "dcz",
          "content-length": String(length),
        },
      }),
    );
    expect(res.headers.get("content-encoding")).toBe("dcz");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(length);
    expect(body.subarray(0, 8)).toEqual(DCZ_MAGIC);
    expect(
      [...body.subarray(8, 40)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe(from);
    expect(await hex(body.subarray(40))).toBe(sha256);
  });

  it("passes every other response through untouched", () => {
    const plain = new Response("x");
    expect(preEncoded(plain)).toBe(plain);
    const gz = new Response("x", { headers: { "content-encoding": "gzip" } });
    expect(preEncoded(gz)).toBe(gz);
  });

  it(
    "serves the payload URL end to end through the real entry point: zstd, then dcz, byte-exact",
    LANE,
    async () => {
      const db = new D1Db(env.DB);
      const slug = "dczw";
      await seedProduct(env, db, slug, { schemaVersion: 1, entries: [] });
      await setServices(
        db,
        slug,
        serializeServices({
          services: {
            license: { enabled: true },
            config: { enabled: true },
            release: { enabled: true },
            distribution: { enabled: true },
            update: { enabled: true },
            identity: { enabled: false },
          },
        }),
        "manifest",
        NOW,
      );
      await db.run(
        `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, beta_branch,
         binary_name, summary_marker, operator_policy_json, metadata_access, artifacts_access)
       VALUES (?, 'acme', 'dczw', 42, 'main', 'dczw', 'pkey:summary', '{}', 'public', 'public')`,
        slug,
      );
      await db.run(
        `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
       VALUES (?, 'app', 'public', NULL, 'admin', ?)`,
        slug,
        NOW,
      );

      // v1 and v2: each payload stored as one zstd frame, v2 with a payload delta from v1.
      const p1 = new Uint8Array(70_000).map((_, i) => (i * 13) & 0xff);
      const p2 = new Uint8Array(70_000).map(
        (_, i) => (i * 13 + (i > 500 ? 1 : 0)) & 0xff,
      );
      const f1 = rawZstdFrame(p1);
      const f2 = rawZstdFrame(p2);
      const artifact = new Uint8Array(1234).map((_, i) => (i * 5 + 1) & 0xff);
      const [s1, s2, sf1, sf2, sa] = (await Promise.all(
        [p1, p2, f1, f2, artifact].map(hex),
      )) as [string, string, string, string, string];
      for (const [bytes, sha256] of [
        [f1, sf1],
        [f2, sf2],
        [artifact, sa],
      ] as const) {
        const key = blobKey(sha256);
        expect(
          await putVerified(env.BLOBS!, key, bytes, {
            sha256,
            size: bytes.length,
          }),
        ).toMatchObject({ ok: true });
        await recordObject(
          db,
          {
            storageKey: key,
            sha256,
            size: bytes.length,
            kind: "blob",
            gated: false,
          },
          NOW,
        );
      }
      const record = (
        version: string,
        seq: number,
        payload: Uint8Array,
        sha256: string,
        frame: Uint8Array,
        frameSha: string,
        from: string | null,
      ) =>
        ({
          schemaVersion: 1,
          aud: slug,
          deliverable: PACK,
          kind: "pack",
          version,
          seq,
          issuedAt: NOW,
          type: "godot.pck",
          formatVersion: 1,
          variants: [
            {
              variant: {},
              payload: { size: payload.length, sha256 },
              full: {
                sha256: frameSha,
                bytes: frame.length,
                size: payload.length,
                codec: "zstd",
              },
              files: {
                format: "pkey-files/1",
                layout: "container",
                sha256: frameSha,
                bytes: frame.length,
                size: payload.length,
                codec: "zstd",
              },
              ...(from
                ? {
                    deltas: [
                      {
                        method: "zstd-patch-from",
                        scope: "payload",
                        from,
                        memBytes: 140_000,
                        artifact: { sha256: sa, bytes: artifact.length },
                      },
                    ],
                  }
                : {}),
            },
          ],
        }) as unknown as PackRecordDoc;
      for (const r of [
        record("1.0.0", 1, p1, s1, f1, sf1, null),
        record("1.1.0", 2, p2, s2, f2, sf2, s1),
      ]) {
        const jws = `${b64url(JSON.stringify({ alg: "EdDSA" }))}.${b64url(JSON.stringify(r))}.c2ln`;
        await db.batch(
          packReleaseStatements({
            product: slug,
            record: r,
            recordSha256: await hex(new TextEncoder().encode(jws)),
            kid: "k",
            jws,
            metadataAccess: "public",
            artifactsAccess: "public",
            now: NOW,
          }),
        );
      }

      const base = `https://key.plrs.im/${slug}/distribution/packs/${PACK}/default/payload`;
      const full = await SELF.fetch(`${base}/${s1}`, {
        headers: { "accept-encoding": "zstd" },
      });
      expect(full.status).toBe(200);
      expect(full.headers.get("content-encoding")).toBe("zstd");
      expect(full.headers.get("use-as-dictionary")).toBe(
        `match="/${slug}/distribution/packs/${PACK}/default/payload/*", match-dest=("")`,
      );
      // The stored frame arrives as it was stored: the runtime neither decodes nor re-encodes it.
      const fullBody = new Uint8Array(await full.arrayBuffer());
      expect(fullBody.length).toBe(f1.length);
      expect(await hex(fullBody)).toBe(sf1);

      const dcz = await SELF.fetch(`${base}/${s2}?via=dcz`, {
        headers: {
          "accept-encoding": "dcz",
          "available-dictionary": `:${btoa(String.fromCharCode(...hexBytes(s1)))}:`,
        },
      });
      expect(dcz.status).toBe(200);
      expect(dcz.headers.get("content-encoding")).toBe("dcz");
      const dczBody = new Uint8Array(await dcz.arrayBuffer());
      expect(dczBody.length).toBe(40 + artifact.length);
      expect(dczBody.subarray(0, 8)).toEqual(DCZ_MAGIC);
      expect(await hex(dczBody.subarray(40))).toBe(sa);

      const miss = await SELF.fetch(`${base}/${s2}?via=dcz`, {
        headers: { "accept-encoding": "zstd" },
      });
      expect(miss.status).toBe(409);
    },
  );
});

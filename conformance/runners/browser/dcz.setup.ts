// The Chromium job's payload-URL server (P4-18), started on the Node side by Vitest's
// `globalSetup` before `dcz.browser.test.ts` runs in the browser. It serves, cross-origin to the
// test page (127.0.0.1 against Vitest's localhost) under a CORS allowlist of that page's origin:
//
//   /<p>/release/records/<sha256>                         signed pack records (the corpus's release key)
//   /<p>/distribution/blobs/sha256/<sha256>               the stored objects, opaque (the blob route)
//   /<p>/distribution/packs/<pack>/default/payload/<sha>  the payload URL, answered by the Worker's
//                                                         own header logic (`dictionary.ts`)
//   /log                                                  what was sent, request by request
//
// over A7's v1 → v2 vector from the content corpus: v1's stored `full` is the corpus's zstd frame,
// v2's a frame of raw blocks, and v2's payload delta is the corpus's own `zstd --patch-from`
// artifact (deltas/v1-v2.pf.zst). One product per scenario, so neither OPFS nor the browser's
// dictionaries cross between them:
//
//   dcz-a  the dictionary offered and used;     dcz-b  the dictionary cleared;
//   dcz-c  the artifact corrupt at the source;  dcz-g  a gated pack (never a dictionary).
//
// The header values and the dcz framing come from `packages/worker/src/services/distribution/
// dictionary.ts`, the module the Worker serves with, so the browser sees the Worker's bytes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { signJws } from "@polaris-key/jws";
import { decode, decodeWithPrefix } from "@polaris-key/zstd-wasm";
// Relative imports of the Worker's source, on purpose: `@polaris-key/worker` exports nothing (it
// is a deployed Worker, not a library), and depending on it would make this job build the whole
// Worker. Both modules are pure: `dictionary.ts` imports nothing, `cors.ts` only workspace
// packages the Worker already resolves.
import {
  corsPreflight,
  withCors,
} from "../../../packages/worker/src/core/cors.js";
import {
  choosePayloadAnswer,
  dczHeader,
  PAYLOAD_VARY,
  useAsDictionary,
} from "../../../packages/worker/src/services/distribution/dictionary.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(here, "..", "..", "corpus", "v2", "content");
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

export const DCZ_PACK = "levels.core";
export const DCZ_PRODUCTS = ["dcz-a", "dcz-b", "dcz-c", "dcz-g"] as const;

/** One zstd frame of raw blocks (RFC 8878 §3.1.1.2), single-segment, 4-byte content size. */
function rawZstdFrame(content: Uint8Array): Uint8Array {
  const MAX_BLOCK = 128 * 1024;
  const n = content.length;
  const parts: Uint8Array[] = [
    Uint8Array.of(
      0x28,
      0xb5,
      0x2f,
      0xfd,
      0xa0,
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff,
    ),
  ];
  let pos = 0;
  do {
    const size = Math.min(MAX_BLOCK, n - pos);
    const h = (size << 3) | (pos + size >= n ? 1 : 0);
    parts.push(Uint8Array.of(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff));
    parts.push(content.subarray(pos, pos + size));
    pos += size;
  } while (pos < n);
  return new Uint8Array(Buffer.concat(parts));
}

interface Stored {
  bytes: Uint8Array;
  sha256: string;
}
interface Release {
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  payloadSha256: string;
  full: Stored & { codec: string };
  deltas: { from: string; artifact: Stored }[];
  gated: boolean;
}

/** What the browser test reads through `inject("dcz")`. */
export interface DczFixture {
  origin: string;
  pack: string;
  releaseKid: string;
  releaseKeyRaw: string;
  productKid: string;
  productKeyRaw: string;
  products: Record<
    string,
    {
      v1: {
        sha256: string;
        seq: number;
        version: string;
        payloadSha256: string;
      };
      v2: {
        sha256: string;
        seq: number;
        version: string;
        payloadSha256: string;
      };
      artifactBytes: number;
      artifactSha256: string;
    }
  >;
}

declare module "vitest" {
  interface ProvidedContext {
    dcz: DczFixture;
  }
}

async function build() {
  const cases = JSON.parse(
    readFileSync(join(here, "..", "..", "corpus", "v2", "cases.json"), "utf8"),
  ) as {
    keys: { kid: string; publicKeyRaw: string; privateKeyPkcs8Pem: string }[];
  };
  const key = (kid: string) => cases.keys.find((k) => k.kid === kid)!;
  const RELEASE_KID = "djdl-release-test-2026";
  const PRODUCT_KID = "pkey-test-prod-2026";

  const v1Frame = new Uint8Array(
    readFileSync(join(CONTENT, "blobs", "payload", "v1.full.zst")),
  );
  const artifact = new Uint8Array(
    readFileSync(join(CONTENT, "blobs", "deltas", "v1-v2.pf.zst")),
  );
  const content = JSON.parse(
    readFileSync(join(CONTENT, "cases.json"), "utf8"),
  ) as { payloads: Record<string, { size: number; sha256: string }> };
  const v1 = await decode(v1Frame, content.payloads.v1!.size);
  const v2 = await decodeWithPrefix(
    artifact,
    v1,
    content.payloads.v2!.size,
    27,
  );
  if (
    sha(v1) !== content.payloads.v1!.sha256 ||
    sha(v2) !== content.payloads.v2!.sha256
  )
    throw new Error("dcz harness: the corpus vector does not decode");
  const v2Frame = rawZstdFrame(v2);

  const objects = new Map<string, Uint8Array>();
  const store = (b: Uint8Array): Stored => {
    objects.set(sha(b), b);
    return { bytes: b, sha256: sha(b) };
  };

  const releasesOf = async (product: string) => {
    const gated = product === "dcz-g";
    const one = async (
      version: string,
      seq: number,
      payload: Uint8Array,
      frame: Uint8Array,
      delta: Uint8Array | null,
    ): Promise<Release> => {
      const index = enc(
        JSON.stringify({
          format: "pkey-files/1",
          layout: "container",
          payload: { size: payload.byteLength, sha256: sha(payload) },
          files: [
            {
              path: "level.bin",
              offset: 0,
              size: payload.byteLength,
              sha256: sha(payload),
              blob: {
                sha256: sha(payload),
                bytes: payload.byteLength,
                codec: "none",
              },
            },
          ],
        }),
      );
      const gaps = new Uint8Array();
      store(index);
      store(gaps);
      store(payload);
      const full = store(frame);
      const art = delta ? store(delta) : null;
      const record = {
        schemaVersion: 1,
        aud: product,
        deliverable: DCZ_PACK,
        kind: "pack",
        version,
        seq,
        issuedAt: 1759300000 + seq,
        type: "custom.level",
        formatVersion: 1,
        handler: { activation: "hot" },
        ...(gated ? { entitlement: "vault" } : {}),
        variants: [
          {
            variant: {},
            payload: { size: payload.byteLength, sha256: sha(payload) },
            full: {
              sha256: full.sha256,
              bytes: frame.byteLength,
              size: payload.byteLength,
              codec: "zstd",
            },
            files: {
              format: "pkey-files/1",
              layout: "container",
              sha256: sha(index),
              bytes: index.byteLength,
              size: index.byteLength,
              codec: "none",
              gaps: { sha256: sha(gaps), bytes: 0, size: 0, codec: "none" },
            },
            ...(art
              ? {
                  deltas: [
                    {
                      method: "zstd-patch-from",
                      scope: "payload",
                      from: sha(v1),
                      memBytes: v1.byteLength + payload.byteLength,
                      artifact: {
                        sha256: art.sha256,
                        bytes: art.bytes.byteLength,
                      },
                    },
                  ],
                }
              : {}),
          },
        ],
      };
      const jws = await signJws(
        record,
        key(RELEASE_KID).privateKeyPkcs8Pem,
        RELEASE_KID,
        "pkey-release+jws",
      );
      return {
        version,
        seq,
        jws,
        recordSha256: sha(jws),
        payloadSha256: sha(payload),
        full: { ...full, codec: "zstd" },
        deltas: art ? [{ from: sha(v1), artifact: art }] : [],
        gated,
      };
    };
    return [
      await one("1.0.0", 1, v1, v1Frame, null),
      await one("1.1.0", 2, v2, v2Frame, artifact),
    ];
  };

  const products = new Map<string, Release[]>();
  for (const p of DCZ_PRODUCTS) products.set(p, await releasesOf(p));
  return {
    products,
    objects,
    artifact,
    keys: {
      releaseKid: RELEASE_KID,
      releaseKeyRaw: key(RELEASE_KID).publicKeyRaw,
      productKid: PRODUCT_KID,
      productKeyRaw: key(PRODUCT_KID).publicKeyRaw,
    },
  };
}

/** One logged request: what the browser sent and what it got. */
interface LogEntry {
  product: string;
  path: string;
  query: string;
  acceptEncoding: string | null;
  availableDictionary: string | null;
  status: number;
  sent: "zstd" | "dcz" | "identity" | "blob" | "record" | "none";
  bytes: number;
  /** The request carried a `Cookie`: an ambient credential, refused with `400`. */
  cookie: boolean;
}

export default async function setup(project: TestProject) {
  const fx = await build();
  const log: LogEntry[] = [];
  const corrupt = (b: Uint8Array) => {
    const c = b.slice();
    c[100] = c[100]! ^ 0xff;
    return c;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = req.headers.origin;
    // The Worker's own CORS (`core/cors.ts`), for a product whose `web.origins` lists the test
    // page: the same allow/expose headers, the same `Vary: Origin`, and never
    // `Access-Control-Allow-Credentials`, so a credentialed fetch fails here as it would there.
    const corsProduct = { webOrigins: origin ? [origin] : [] };
    const asked = new Request(`http://127.0.0.1${url.pathname}`, {
      headers: origin ? { origin } : {},
    });
    const corsHeaders = (res: Response): Record<string, string> =>
      Object.fromEntries(res.headers.entries());
    if (req.method === "OPTIONS")
      return (
        res.writeHead(204, corsHeaders(corsPreflight(corsProduct, asked))),
        res.end()
      );
    const withWorkerCors = (headers: Record<string, string>) =>
      corsHeaders(
        withCors(corsProduct, asked, new Response(null, { headers })),
      );
    if (url.pathname === "/log") {
      res.writeHead(
        200,
        withWorkerCors({
          "content-type": "application/json",
          "cache-control": "no-store",
        }),
      );
      return res.end(JSON.stringify(log));
    }
    const m = /^\/([a-z0-9-]+)\/(.*)$/.exec(url.pathname);
    const product = m?.[1] ?? "";
    const rest = m?.[2] ?? "";
    const releases = fx.products.get(product);
    const entry: LogEntry = {
      product,
      path: url.pathname,
      query: url.search,
      acceptEncoding: req.headers["accept-encoding"] ?? null,
      availableDictionary:
        (req.headers["available-dictionary"] as string | undefined) ?? null,
      status: 404,
      sent: "none",
      bytes: 0,
      cookie: req.headers.cookie !== undefined,
    };
    log.push(entry);
    const send = (
      status: number,
      headers: Record<string, string>,
      body: Uint8Array | null,
      sent: LogEntry["sent"],
    ) => {
      entry.status = status;
      entry.sent = sent;
      entry.bytes = body?.byteLength ?? 0;
      res.writeHead(status, withWorkerCors(headers));
      res.end(body ? Buffer.from(body) : undefined);
    };
    if (!releases) return send(404, {}, null, "none");
    // No pack fetch may carry an ambient credential (the page seeds a cookie for this origin).
    if (entry.cookie)
      return send(400, { "cache-control": "no-store" }, null, "none");

    const rec = /^release\/records\/([0-9a-f]{64})$/.exec(rest);
    if (rec) {
      const r = releases.find((x) => x.recordSha256 === rec[1]);
      return r
        ? send(
            200,
            { "content-type": "application/jose", "cache-control": "no-store" },
            enc(r.jws),
            "record",
          )
        : send(404, {}, null, "none");
    }
    const blob = /^distribution\/blobs\/sha256\/([0-9a-f]{64})$/.exec(rest);
    if (blob) {
      let b = fx.objects.get(blob[1]!);
      if (!b) return send(404, {}, null, "none");
      if (product === "dcz-c" && blob[1] === sha(fx.artifact)) b = corrupt(b);
      return send(
        200,
        {
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
        b,
        "blob",
      );
    }
    const pay =
      /^distribution\/packs\/([^/]+)\/([^/]+)\/payload\/([0-9a-f]{64})$/.exec(
        rest,
      );
    if (pay && pay[1] === DCZ_PACK && pay[2] === "default") {
      const r = releases.find((x) => x.payloadSha256 === pay[3]);
      if (!r) return send(404, {}, null, "none");
      const answer = choosePayloadAnswer({
        acceptEncoding: entry.acceptEncoding,
        availableDictionary: entry.availableDictionary,
        guard: url.searchParams.get("via") === "dcz",
        fullCodec: r.full.codec,
        deltas: r.deltas.map((d) => ({
          from: d.from,
          artifact: {
            sha256: d.artifact.sha256,
            bytes: d.artifact.bytes.byteLength,
          },
        })),
      });
      const headers: Record<string, string> = {
        vary: PAYLOAD_VARY,
        "content-type": "application/octet-stream",
      };
      if (answer.kind === "refuse")
        return send(
          answer.status,
          { vary: headers.vary!, "cache-control": "no-store" },
          null,
          "none",
        );
      headers["cache-control"] = r.gated
        ? "private, no-store, no-transform"
        : "public, max-age=31536000, immutable, no-transform";
      if (!r.gated)
        headers["use-as-dictionary"] = useAsDictionary(
          product,
          DCZ_PACK,
          "default",
        );
      if (answer.kind === "dcz") {
        let art = r.deltas.find((d) => d.from === answer.from)!.artifact.bytes;
        if (product === "dcz-c") art = corrupt(art);
        const body = new Uint8Array(
          Buffer.concat([dczHeader(answer.from), art]),
        );
        return send(
          200,
          { ...headers, "content-encoding": "dcz" },
          body,
          "dcz",
        );
      }
      return send(
        200,
        answer.encoding === "zstd"
          ? { ...headers, "content-encoding": "zstd" }
          : headers,
        r.full.bytes,
        answer.encoding === "zstd" ? "zstd" : "identity",
      );
    }
    return send(404, {}, null, "none");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const products: DczFixture["products"] = {};
  for (const [p, [v1, v2]] of fx.products) {
    products[p] = {
      v1: {
        sha256: v1!.recordSha256,
        seq: v1!.seq,
        version: v1!.version,
        payloadSha256: v1!.payloadSha256,
      },
      v2: {
        sha256: v2!.recordSha256,
        seq: v2!.seq,
        version: v2!.version,
        payloadSha256: v2!.payloadSha256,
      },
      artifactBytes: fx.artifact.byteLength,
      artifactSha256: sha(fx.artifact),
    };
  }
  project.provide("dcz", {
    origin: `http://127.0.0.1:${port}`,
    pack: DCZ_PACK,
    ...fx.keys,
    products,
  });
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

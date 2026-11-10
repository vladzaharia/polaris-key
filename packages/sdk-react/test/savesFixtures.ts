// Shared fakes for the browser saves tests (U-22.6, SAVES.R): a small Worker for /sync and
// /sync/files, a key ring over the memory vault, and ordered Web Locks.

import {
  deriveKid,
  e2eFileCodec,
  webCryptoSyncPort as P,
  type FileCodec,
} from "@polaris-key/client-core/sync";
import { ringCodec } from "../src/browser/ring/codec.js";
import {
  importRootHandle,
  memoryRootVault,
  ringKeysOf,
} from "../src/browser/ring/rootVault.js";
import {
  digestHeader,
  type FileFetch,
} from "../src/browser/cloudSync/files.js";

export const PRODUCT = "djdl";
export const RAW = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const hexOf = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha = async (b: Uint8Array) => hexOf(await P.sha256(b));
export type Body = Record<string, unknown>;

// ── A fake of the Worker's /sync and /sync/files routes ──────────────────────────────────────

export interface Rec {
  version: number;
  value?: unknown;
  ct?: string;
  file?: { version: number; size: number; sha256: string; format: "whole" };
}

export class FakeWorker {
  /** The person the Worker says it serves. */
  subject = "ps_x";
  seq = 0;
  encryption: "e2e" | "server";
  recs = new Map<string, Rec>();
  bodies = new Map<string, Uint8Array>(); // by file version
  uploads = new Map<
    string,
    {
      id: string;
      size: number;
      base: number | "*" | undefined;
      sha256: string;
      body?: Uint8Array;
    }
  >();
  tombstones: string[] = [];
  seen: string[] = [];
  /** Answers a route instead of the truth: `[method path-suffix]` to a response. */
  hook: (key: string) => Response | undefined = () => undefined;
  rawFileBodies: Uint8Array[] = [];

  constructor(encryption: "e2e" | "server") {
    this.encryption = encryption;
  }

  private j = (
    b: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  private err = (status: number, code: string, extra: Body = {}, h = {}) =>
    this.j({ error: { code }, ...extra }, status, h);

  /** `ProductRequest`: the sync routes, JSON in and out. */
  request = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> => {
    const url = new URL(`https://k.test/${PRODUCT}/${path}`);
    const body = init.body ? (JSON.parse(init.body) as Body) : undefined;
    return this.route(init.method, url, body, undefined);
  };

  /** `FileFetch`: the file routes, bytes in and out. */
  files: FileFetch = async (path, init) => {
    const url = new URL(`https://k.test/${PRODUCT}/${path}`);
    const raw =
      init.body instanceof Uint8Array
        ? init.body
        : init.body === undefined
          ? undefined
          : new TextEncoder().encode(init.body);
    const json =
      init.headers["content-type"] === "application/json" && raw
        ? (JSON.parse(new TextDecoder().decode(raw)) as Body)
        : undefined;
    if (raw && !json) this.rawFileBodies.push(raw);
    return this.route(init.method, url, json, raw, init.headers);
  };

  private async route(
    method: string,
    url: URL,
    body: Body | undefined,
    raw: Uint8Array | undefined,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const rel = url.pathname.slice(`/${PRODUCT}/`.length);
    this.seen.push(`${method} ${rel}`);
    const hooked = this.hook(`${method} ${rel}`);
    if (hooked) return hooked;
    if (rel === "sync" && method === "GET") return this.pull();
    if (rel === "sync/ops") return this.push(body!);
    const m = /^sync\/files\/saves\/([^/]+)(?:\/(.*))?$/.exec(rel);
    if (!m) return this.err(404, "not_found");
    const [, id, rest = ""] = m as unknown as [string, string, string?];
    if (rest === "begin") return this.begin(id, body!);
    if (rest === "finalize") return this.finalize(id, body!);
    if (rest === "revisions") return this.revisions(id);
    const up = /^upload\/([^/]+)$/.exec(rest);
    if (up && method === "PUT") return this.put(up[1]!, raw!, headers);
    if (up && method === "DELETE") {
      this.uploads.delete(up[1]!);
      return new Response(null, { status: 204 });
    }
    if (rest === "" && method === "GET")
      return this.download(id, url.searchParams.get("version"), headers.range);
    return this.err(404, "not_found");
  }

  private begin(id: string, b: Body): Response {
    const cur = this.recs.get(id);
    const base = b.baseVersion as number | "*" | undefined;
    if (
      (base === "*" && cur) ||
      (typeof base === "number" && cur?.version !== base)
    )
      return this.err(409, "revision_conflict", {
        server: { version: cur?.version ?? 0 },
      });
    const uploadId = `up_${this.uploads.size + 1}`;
    this.uploads.set(uploadId, {
      id,
      size: b.size as number,
      base,
      sha256: b.sha256 as string,
    });
    return this.j({
      uploadId,
      mode: "single",
      expiresAt: Date.now() + 86_400_000,
    });
  }

  private async put(
    uploadId: string,
    raw: Uint8Array,
    headers: Record<string, string>,
  ): Promise<Response> {
    const u = this.uploads.get(uploadId);
    if (!u) return this.err(404, "not_found");
    const digest = digestHeader(await sha(raw));
    if (headers["content-digest"] !== digest)
      return this.err(400, "upload_mismatch");
    u.body = raw;
    return new Response(null, { status: 204 });
  }

  private async finalize(id: string, b: Body): Promise<Response> {
    const u = this.uploads.get(b.uploadId as string);
    if (!u?.body) return this.err(409, "upload_incomplete", { missing: [1] });
    const cur = this.recs.get(id);
    if (
      (u.base === "*" && cur) ||
      (typeof u.base === "number" && cur?.version !== u.base)
    )
      return this.err(409, "revision_conflict", {
        server: { version: cur?.version ?? 0 },
      });
    const version = ++this.seq;
    const file = {
      version,
      size: u.body.length,
      sha256: await sha(u.body),
      format: "whole" as const,
    };
    this.bodies.set(String(version), u.body);
    this.recs.set(id, { ...(cur ?? {}), version, file });
    this.uploads.delete(b.uploadId as string);
    return this.j(file);
  }

  private download(
    id: string,
    version: string | null,
    range?: string,
  ): Response {
    const rec = this.recs.get(id);
    const v = version ?? String(rec?.file?.version);
    const data = this.bodies.get(v);
    if (!rec || !data) return this.err(404, "not_found");
    const etag = `"${[...this.bodies.keys()].indexOf(v)}"`;
    const rg = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (rg) {
      const a = Number(rg[1]);
      const z = Math.min(Number(rg[2]) + 1, data.length);
      return new Response(data.slice(a, z), {
        status: 206,
        headers: {
          etag,
          "content-range": `bytes ${a}-${z - 1}/${data.length}`,
        },
      });
    }
    return new Response(data.slice(), { status: 200, headers: { etag } });
  }

  private revisions(id: string): Response {
    const rec = this.recs.get(id);
    return this.j({
      revisions: [...this.bodies.entries()]
        .reverse()
        .filter(([v]) => rec?.file && Number(v) <= rec.file.version)
        .map(([v, data]) => ({
          version: Number(v),
          size: data.length,
          sha256: "",
          format: "whole",
          createdAt: 0,
        })),
    });
  }

  private pull(): Response {
    return this.j(
      this.envelope({
        changes: [...this.recs.entries()].map(([id, r]) => ({
          record: ["saves", id],
          version: r.version,
          ...(r.ct !== undefined ? { ct: r.ct } : {}),
          ...(r.value !== undefined ? { value: r.value } : {}),
          ...(r.file ? { file: r.file } : {}),
        })),
        tombstones: this.tombstones.map((id) => ({
          record: ["saves", id],
          editedHlc: "x",
        })),
      }),
    );
  }

  private envelope(over: Body): Body {
    return {
      subject: this.subject,
      serverNow: Date.now(),
      cursor: this.seq,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      usage: { files: 0, records: 0, settings: 0, bytes: 0 },
      quota: { files: true, bytes: 2 ** 28 },
      encryption: this.encryption,
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }

  private push(b: Body): Response {
    const changes: Body[] = [];
    const tombstones: Body[] = [];
    const results = (b.mutations as Array<Body>).map((m) => {
      const [, id] = (m.target as { record: [string, string] }).record;
      const cur = this.recs.get(id);
      const base = m.baseVersion as number | "*" | undefined;
      if (
        (base === "*" && cur) ||
        (typeof base === "number" && cur?.version !== base)
      )
        return {
          mutationId: m.mutationId,
          status: "conflict",
          server: cur
            ? {
                version: cur.version,
                ...(cur.ct !== undefined ? { ct: cur.ct } : {}),
                ...(cur.value !== undefined ? { value: cur.value } : {}),
                ...(cur.file ? { file: cur.file } : {}),
              }
            : { version: 0 },
        };
      const version = ++this.seq;
      if (m.op === "delete") {
        this.recs.delete(id);
        this.tombstones.push(id);
        tombstones.push({ record: ["saves", id], version });
        return { mutationId: m.mutationId, status: "ok", version };
      }
      const next: Rec = {
        ...(cur ?? {}),
        version,
        ...(m.ct !== undefined ? { ct: m.ct as string } : { value: m.value }),
      };
      this.recs.set(id, next);
      // The Worker echoes the change with its file pointer, as a pull would.
      changes.push({
        record: ["saves", id],
        version,
        ...(next.ct !== undefined ? { ct: next.ct } : {}),
        ...(next.value !== undefined ? { value: next.value } : {}),
        ...(next.file ? { file: next.file } : {}),
      });
      return { mutationId: m.mutationId, status: "ok", version };
    });
    return this.j(this.envelope({ results, changes, tombstones }));
  }
}

// ── The key ring and the locks ───────────────────────────────────────────────────────────────

export async function makeRing(root: Uint8Array = RAW) {
  const vault = memoryRootVault();
  await vault.put({
    v: 1 as const,
    ringId: "rg_AAAAAAAAAAAAAAAAAAAAAA",
    epoch: 1,
    kid: hexOf(await deriveKid(P, root)),
    key: await importRootHandle(root),
  });
  let held = true;
  const keys = async () => {
    const rec = await vault.get();
    return rec ? ringKeysOf(rec, P) : null;
  };
  const codec = ringCodec({ hasRoot: () => held, ringKeys: keys });
  return {
    keys,
    codec: () => (held ? codec : null),
    fileCodec: async (c: string): Promise<FileCodec | null> => {
      const k = held ? await keys() : null;
      return k ? k.withRoot(async (p, r) => e2eFileCodec(p, r, c)) : null;
    },
    lock: () => void (held = false),
  };
}

export class FakeLocks {
  order: string[] = [];
  private tails = new Map<string, Promise<unknown>>();
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const fn = (typeof a === "function" ? a : b) as (l: unknown) => unknown;
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(async () => {
      this.order.push(`+${name}`);
      try {
        return await fn({ name });
      } finally {
        this.order.push(`-${name}`);
      }
    });
    this.tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }
}

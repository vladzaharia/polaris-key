/**
 * P4-03 fixtures: PCK payloads (a test-side writer ported from the prototype's
 * `content/gen/pck.py`, independent of `src/pck.ts`), a product repository that declares packs,
 * and a fake Polaris Key that speaks the pack publish (the uploads preflight, tickets with
 * `present`, stage rounds, the record submit, discovery's `release.packs`).
 *
 * The fixture PCKs model what `--export-pack` writes for a script-free data pack (notes/S-05
 * §4.6): in-prefix resources with their `.import` / `.remap` files, the `.godot/imported/` and
 * `.godot/exported/` files those name, `.godot/uid_cache.bin`, and — unstripped — the
 * `project.binary` and `.godot/global_script_class_cache.cfg` every export adds. P4-08's
 * device-side directory check reuses the same fixtures.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  actionsEnv,
  BASE,
  BUCKET,
  CI_TOKEN,
  json,
  OIDC_URL,
  R2_ENDPOINT,
  SECRET_KEY,
  SESSION_TOKEN,
  SLUG,
  tempDir,
  type Recorded,
} from "./publishFixture.js";

export { actionsEnv, BASE, SLUG };

export const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

// ── A PCK writer (prototype/content/gen/pck.py `write_pck`) ───────────────────

const MAGIC = 0x43504447;

function padTo(n: number, a: number): number {
  const r = n % a;
  return r === 0 ? 0 : a - r;
}

export interface PckOptions {
  version?: number;
  engine?: [number, number, number];
  flags?: number;
  /** Per-entry flags by path. */
  entryFlags?: Record<string, number>;
  /** Store paths with a `res://` prefix (Godot ≤ 4.3's v2 layout). */
  resPrefix?: boolean;
}

/**
 * A PCK of `files` (in the given order, directory in the same order): header, file base and
 * (v3/v4) directory offset, 16 reserved words, 16-byte-aligned file data, then the directory;
 * v2 puts the directory straight after the reserved words and the data after it.
 */
export function writeTestPck(
  files: readonly (readonly [string, Uint8Array])[],
  opts: PckOptions = {},
): Uint8Array {
  const version = opts.version ?? 4;
  const [maj, min, pat] = opts.engine ?? [4, 7, 2];
  const flags = opts.flags ?? 2;
  const enc = new TextEncoder();
  const recs = files.map(([p, data]) => {
    const raw = enc.encode(opts.resPrefix ? `res://${p}` : p);
    const pathBytes = new Uint8Array(raw.length + padTo(raw.length, 4));
    pathBytes.set(raw);
    return {
      pathBytes,
      data,
      md5: createHash("md5").update(data).digest(),
      fl: opts.entryFlags?.[p] ?? 0,
    };
  });
  const dirSize = 4 + recs.reduce((a, r) => a + 4 + r.pathBytes.length + 36, 0);
  const head = version === 2 ? 32 + 64 : 40 + 64;
  let pos = version === 2 ? head + dirSize : head;
  pos += padTo(pos, 16);
  const fileBase = pos;
  const offs: number[] = [];
  for (const r of recs) {
    offs.push(pos - fileBase);
    pos += r.data.length;
    pos += padTo(pos, 16);
  }
  const dirOff = version === 2 ? head : pos;
  const total = version === 2 ? pos : pos + dirSize;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  [MAGIC, version, maj, min, pat, flags].forEach((v, i) =>
    dv.setUint32(i * 4, v, true),
  );
  dv.setBigUint64(24, BigInt(fileBase), true);
  if (version !== 2) dv.setBigUint64(32, BigInt(dirOff), true);
  recs.forEach((r, i) => out.set(r.data, fileBase + offs[i]!));
  let p = dirOff;
  dv.setUint32(p, recs.length, true);
  p += 4;
  recs.forEach((r, i) => {
    dv.setUint32(p, r.pathBytes.length, true);
    p += 4;
    out.set(r.pathBytes, p);
    p += r.pathBytes.length;
    dv.setBigUint64(p, BigInt(offs[i]!), true);
    dv.setBigUint64(p + 8, BigInt(r.data.length), true);
    out.set(r.md5, p + 16);
    dv.setUint32(p + 32, r.fl, true);
    p += 36;
  });
  return out;
}

// ── Contents ──────────────────────────────────────────────────────────────────

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Compressible, deterministic level data. */
export function levelJson(n: number, edit = 0): Uint8Array {
  const rows: string[] = [];
  for (let i = 0; i < 60 + (n % 5) * 20; i++)
    rows.push(
      `{"id":${i},"x":${(i * 37 + n) % 97},"y":${(i * 11 + n * 3) % 89},"tile":"t${(i + n) % 13}"}`,
    );
  if (edit) rows[7] = `{"id":7,"x":${edit},"y":${edit},"tile":"edited"}`;
  return utf8(`{"level":${n},"rows":[${rows.join(",")}]}\n`);
}

/** Pseudo-random (incompressible) bytes, with `edits` bytes flipped from offset 100. */
export function noiseBytes(n: number, seed: number, edits = 0): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 + 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  for (let i = 0; i < edits; i++) out[100 + i * 13] = out[100 + i * 13]! ^ 0xff;
  return out;
}

/** `uid_cache.bin`: u32 count, then per entry i64 uid, u32 length and the path. */
export function uidCache(entries: readonly [bigint, string][]): Uint8Array {
  const parts = entries.map(([uid, p]) => {
    const b = utf8(p);
    const e = new Uint8Array(12 + b.length);
    const dv = new DataView(e.buffer);
    dv.setBigInt64(0, uid, true);
    dv.setUint32(8, b.length, true);
    e.set(b, 12);
    return e;
  });
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, entries.length, true);
  return new Uint8Array(Buffer.concat([head, ...parts]));
}

export const PREFIX = "res://assets/kaykit/";
const CTEX = ".godot/imported/dice.png-0123456789abcdef.s3tc.ctex";
const SCN = ".godot/exported/133200997/export-0123abcd-board.scn";
const UIDS: [bigint, string][] = [
  [1111n, "res://assets/kaykit/dice.png"],
  [2222n, "res://assets/kaykit/board.tscn"],
  [3333n, "res://assets/kaykit/data/level_000.json"],
];

const importFile = (ctex: string) =>
  utf8(
    `[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="uid://b1"\npath.s3tc="res://${ctex}"\nmetadata={\n"imported_formats": ["s3tc_bptc"],\n"vram_texture": true\n}\n\n[deps]\n\nsource_file="res://assets/kaykit/dice.png"\ndest_files=["res://${ctex}"]\n`,
  );
/** A Godot binary resource's length-prefixed string (`ResourceFormatSaverBinary`). */
function binString(s: string): Uint8Array {
  const b = utf8(`${s}\0`);
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true);
  out.set(b, 4);
  return out;
}

/**
 * A minimal uncompressed binary resource: `RSRC`, the header words, the property-name string
 * table and each internal resource's type, as length-prefixed strings, then opaque data. Enough
 * for the lint's embedded-script scan; `magic` `RSCC` models a compressed one.
 */
export function binaryResource(
  types: readonly string[],
  props: readonly string[],
  seed: number,
  magic = "RSRC",
): Uint8Array {
  const head = new Uint8Array(20);
  head.set(utf8(magic));
  new DataView(head.buffer).setUint32(8, 4, true); // ver_major
  return new Uint8Array(
    Buffer.concat([
      head,
      binString(types[0] ?? "Resource"),
      ...props.map(binString),
      ...types.map(binString),
      noiseBytes(512, seed),
    ]),
  );
}

const remapFile = (target: string) =>
  utf8(`[remap]\n\npath="res://${target}"\n`);

/** v1 of the kaykit data pack, as `--export-pack` lays it out minus the two always-added files. */
export function kaykitV1(): [string, Uint8Array][] {
  const files: [string, Uint8Array][] = [
    ["assets/kaykit/dice.png.import", importFile(CTEX)],
    [CTEX, noiseBytes(8192, 1)],
    ["assets/kaykit/board.tscn.remap", remapFile(SCN)],
    [
      SCN,
      binaryResource(
        ["PackedScene", "Texture2D"],
        ["nodes", "names", "_bundled"],
        2,
      ),
    ],
  ];
  for (let i = 0; i < 10; i++)
    files.push([`assets/kaykit/data/level_00${i}.json`, levelJson(i)]);
  files.push([".godot/uid_cache.bin", uidCache(UIDS)]);
  return files;
}

/**
 * v2: level_003 edited (a per-entry delta), level_007 removed, level_010 added (a blob entry),
 * the texture changed in a few bytes, and the uid cache rewritten in another order (re-import
 * noise).
 */
export function kaykitV2(): [string, Uint8Array][] {
  const files = kaykitV1()
    .filter(([p]) => p !== "assets/kaykit/data/level_007.json")
    .map(([p, b]): [string, Uint8Array] => {
      if (p === "assets/kaykit/data/level_003.json")
        return [p, levelJson(3, 99)];
      if (p === CTEX) return [p, noiseBytes(8192, 1, 3)];
      if (p === ".godot/uid_cache.bin")
        return [p, uidCache([...UIDS].reverse())];
      return [p, b];
    });
  files.splice(files.length - 1, 0, [
    "assets/kaykit/data/level_010.json",
    levelJson(10),
  ]);
  return files;
}

/** v1 as `--export-pack` writes it: with `project.binary` and the class cache. */
export function kaykitUnstripped(): [string, Uint8Array][] {
  return [
    ...kaykitV1(),
    ["project.binary", noiseBytes(600, 9)],
    [".godot/global_script_class_cache.cfg", utf8("list=[]\n")],
  ];
}

/** v1 plus a script, a native library, an out-of-prefix path and an orphaned import. */
export function kaykitForbidden(): [string, Uint8Array][] {
  return [
    ...kaykitV1(),
    ["assets/kaykit/roll.gd", utf8("extends Node\n")],
    ["assets/kaykit/bin/libdice.so", noiseBytes(64, 4)],
    ["other/thing.png", noiseBytes(64, 5)],
    [".godot/imported/orphan.png-ffff.s3tc.ctex", noiseBytes(64, 6)],
  ];
}

/** A pack of `n` small in-prefix entries (the entry-count limits). */
export function manyEntries(n: number): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  for (let i = 0; i < n; i++)
    out.push([
      `assets/kaykit/m/f${String(i).padStart(5, "0")}.txt`,
      utf8(`${i}\n`),
    ]);
  return out;
}

// ── The repository ────────────────────────────────────────────────────────────

/** A placeholder release key, generated per run (never a real key). */
export function testReleaseKey(kid = "diceroll-release-test") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    kid,
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: (publicKey.export({ format: "jwk" }) as { x: string }).x,
  };
}

const PRODUCT_YAML = `apiVersion: pkey.dev/v1
product:
  slug: ${SLUG}
  name: Diceroll
modules:
  license:
    enabled: true
  config:
    enabled: false
  release:
    enabled: true
  distribution:
    enabled: true
  update:
    enabled: true
  identity:
    enabled: false
`;

const SCHEMA_YAML = `apiVersion: pkey.dev/v1
schemaVersion: 1
catalog:
  - key: hd
    kind: flag
    category: Content
    label: HD textures
    description: The HD texture pack.
    schema:
      type: boolean
    default: false
`;

export interface PackRepoOptions {
  /** Extra YAML under `deliverables:` (indented 4). */
  extraPacks?: string;
  core3dVariants?: string;
  deltaBases?: number;
  /** core3d's `patch.strategies` flow list (default: absent, so every strategy). */
  strategies?: string;
  /** The app artifact map's web entry `embeds:` line value (default unset). */
  webEmbeds?: string;
}

export function releaseYaml(
  key: { kid: string; publicKey: string },
  o: PackRepoOptions = {},
) {
  return `apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: vladzaharia
    repo: diceroll
  binaryName: diceroll
  releaseKeys:
    - kid: ${key.kid}
      publicKey: ${key.publicKey}
  publishing:
    trustedPublisher:
      workflow: .github/workflows/release.yml
  deliverables:
    app:
      kind: app
      versioning:
        scheme: semver
      content:
        contentApi: 4
      artifacts:
        - { id: macos, platform: macos, arch: universal, format: zip, match: "Diceroll-*-macos.zip" }
        - { id: web, platform: web, arch: wasm32, format: zip, match: "Diceroll-*-web.zip"${o.webEmbeds !== undefined ? `, embeds: ${o.webEmbeds}` : ""} }
    diceroll.core3d:
      kind: pack
      type: godot.pck
      baseline: embedded
      required: true
      delivery: essential
      handler:
        mountOrder: 2
        prefixes: ["${PREFIX}"]
      requires:
        engine: godot-4.7
${o.core3dVariants ?? ""}      patch:
        deltaBases: ${o.deltaBases ?? 1}
${o.strategies !== undefined ? `        strategies: ${o.strategies}\n` : ""}    diceroll.l10n:
      kind: pack
      type: files.tree
      variants:
        locale: [en, fr]
${o.extraPacks ?? ""}`;
}

/** A repo with `.pkey/` and the given files under `dist/`. */
export async function packRepo(
  key: { kid: string; publicKey: string },
  files: Record<string, Uint8Array>,
  o: PackRepoOptions = {},
): Promise<string> {
  const cwd = await tempDir();
  await mkdir(path.join(cwd, ".pkey"), { recursive: true });
  await writeFile(path.join(cwd, ".pkey/product.yaml"), PRODUCT_YAML);
  await writeFile(path.join(cwd, ".pkey/schema.yaml"), SCHEMA_YAML);
  await writeFile(path.join(cwd, ".pkey/release.yaml"), releaseYaml(key, o));
  await writeFiles(path.join(cwd, "dist"), files);
  return cwd;
}

export async function writeFiles(
  root: string,
  files: Record<string, Uint8Array>,
) {
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

/** The l10n tree variants: `locale=en/…` and `locale=fr/…`. */
export function l10nTrees(edit = 0): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const locale of ["en", "fr"]) {
    out[`locale=${locale}/strings/main.json`] = levelJson(
      locale === "en" ? 20 : 21,
      edit,
    );
    out[`locale=${locale}/strings/menu.json`] = levelJson(
      locale === "en" ? 22 : 23,
    );
    out[`locale=${locale}/fonts/ui.bin`] = noiseBytes(
      2048,
      locale === "en" ? 7 : 8,
    );
  }
  return out;
}

// ── The fake server ───────────────────────────────────────────────────────────

export interface PackServer {
  fetchImpl: typeof fetch;
  calls: Recorded[];
  /** Objects R2 holds (staging keys). */
  r2: Map<string, Uint8Array>;
  /** Stored object SHA-256s the product references (after stage rounds). */
  referenced: Set<string>;
  /** `<pack>:<sha256>`: which pack uploaded each object (a pack ticket's `present`, P4-22). */
  packUploads: Set<string>;
  /** The pack's delivery gate the preflight reports. */
  gate: string | null;
  /** Discovery's `release.packs`. */
  packs: boolean;
  /** Discovery's `release.revocations` (P4-13). */
  revocations: boolean;
  /** Discovery's `release.chunks` (P4-22). */
  chunks: boolean;
  /** Submitted revocation records (P4-13), in order. */
  revoked: string[];
  /** Discovery's `release.delegations` (P4-19). */
  delegations: boolean;
  /** Stored delegations (P4-19): what `…/publish/delegations` lists. */
  delegationRows: {
    sha256: string;
    deliverable: string;
    seq: number;
    keyFingerprint: string;
    issuedAt: number;
    expiresAt: number;
    origin: "submit" | "revocation";
    revoked: boolean;
    version: string;
    jws: string;
  }[];
  /** Records the record route serves, by hash (P4-19). */
  records: Map<string, string>;
  /** Submit bodies (P4-19 adds the supplied `delegation`), in order. */
  submits: Record<string, unknown>[];
  /** Answer the next submit with this status (consumed). */
  failSubmit: number | null;
  /** Stored releases: `<deliverable>@<version>` → seq and record hash. */
  stored: Map<string, { seq: number; recordSha256: string; jws?: string }>;
  /** Stage-round failures to inject (consumed one per stage call). */
  failStage: number;
  /** Leave the last requested object out of the next ticket answer. */
  dropFromTicket: boolean;
  to(fragment: string): Recorded[];
  puts(): Recorded[];
}

async function readBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  const chunks: Uint8Array[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(c);
  return new Uint8Array(Buffer.concat(chunks));
}

export function packServer(): PackServer {
  const calls: Recorded[] = [];
  const r2 = new Map<string, Uint8Array>();
  const referenced = new Set<string>();
  const packUploads = new Set<string>();
  const tickets = new Map<
    string,
    { sha256: string; size: number; key: string }[]
  >();
  const stored: PackServer["stored"] = new Map();
  let ticketN = 0;
  let oidc = 0;
  const nextSeq = (deliverable: string) =>
    1 +
    Math.max(
      0,
      ...[...stored.entries()]
        .filter(([k]) => k.startsWith(`${deliverable}@`))
        .map(([, v]) => v.seq),
    );
  const server: PackServer = {
    fetchImpl: undefined as unknown as typeof fetch,
    calls,
    r2,
    referenced,
    packUploads,
    gate: null,
    packs: true,
    revocations: true,
    chunks: true,
    revoked: [],
    delegations: true,
    delegationRows: [],
    records: new Map(),
    submits: [],
    failSubmit: null,
    stored,
    failStage: 0,
    dropFromTicket: false,
    to: (f) => calls.filter((c) => c.url.includes(f)),
    puts: () => calls.filter((c) => c.method === "PUT"),
  };
  server.fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const rec: Recorded = { method, url, headers };
    calls.push(rec);
    if (url.startsWith(OIDC_URL.split("?")[0]!))
      return json({ value: `h.oidc-${++oidc}.s` });
    if (url.startsWith(R2_ENDPOINT)) {
      const bytes = await readBytes(init?.body);
      rec.bytes = bytes;
      if (
        Buffer.from(sha(bytes), "hex").toString("base64") !==
        headers["x-amz-checksum-sha256"]
      )
        return new Response("<Error><Code>BadDigest</Code></Error>", {
          status: 400,
        });
      r2.set(new URL(url).pathname.slice(`/${BUCKET}/`.length), bytes);
      return new Response(null, { status: 200 });
    }
    const route = url.slice(`${BASE}/${SLUG}`.length);
    if (method === "GET" && route === "/.well-known/polaris.json")
      return json({
        version: 2,
        services: {
          release: {
            enabled: true,
            ...(server.packs ? { packs: true } : {}),
            ...(server.revocations ? { revocations: true } : {}),
            ...(server.delegations ? { delegations: true } : {}),
            ...(server.chunks ? { chunks: true } : {}),
          },
        },
      });
    if (method === "GET" && route.startsWith("/release/records/")) {
      const jws = server.records.get(route.slice("/release/records/".length));
      return jws === undefined
        ? json({ error: "not_found" }, 404)
        : new Response(jws, { status: 200 });
    }
    rec.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const body = rec.body as Record<string, unknown>;
    switch (route) {
      case "/release/publish/token":
        return json({
          token: CI_TOKEN,
          expiresAt: 1_900_000_000,
          scopes: ["release:publish"],
        });
      case "/release/publish/uploads": {
        const releases =
          (body.releases as { deliverable: string; version: string }[]) ?? [];
        const pending: Record<string, number> = {};
        const seqs = releases.map((r) => {
          const s = stored.get(`${r.deliverable}@${r.version}`);
          const gate =
            r.deliverable === "app" ? {} : { entitlement: server.gate };
          if (s)
            return { ...r, seq: s.seq, recordSha256: s.recordSha256, ...gate };
          pending[r.deliverable] ??= nextSeq(r.deliverable);
          return { ...r, seq: pending[r.deliverable]!++, ...gate };
        });
        if (body.objects === undefined) return json({ seqs });
        const id = `t${++ticketN}`;
        const objects = (
          body.objects as { sha256: string; size: number; gated?: boolean }[]
        ).map((o) => ({
          ...o,
          gated: o.gated === true,
          key: `staging/${SLUG}/${id}/${o.sha256}`,
          target: `${o.gated ? "gated/" : ""}blobs/sha256/${o.sha256}`,
          present:
            referenced.has(o.sha256) &&
            (body.deliverable === undefined ||
              packUploads.has(`${String(body.deliverable)}:${o.sha256}`)),
        }));
        if (server.dropFromTicket) {
          server.dropFromTicket = false;
          objects.pop();
        }
        tickets.set(`pkeyup_${id}`, objects);
        return json({
          ticket: `pkeyup_${id}`,
          expiresAt: 1_900_000_000,
          credentials: {
            endpoint: R2_ENDPOINT,
            bucket: BUCKET,
            accessKeyId: "parent-akid",
            secretAccessKey: SECRET_KEY,
            sessionToken: SESSION_TOKEN,
          },
          prefix: `staging/${SLUG}/${id}/`,
          objects,
          seqs,
        });
      }
      case "/release/publish/stage": {
        if (server.failStage > 0) {
          server.failStage--;
          return json(
            {
              error: "bad_request",
              reason: "staged_object_missing",
              message: "x",
            },
            400,
          );
        }
        const objects = tickets.get(body.ticket as string);
        if (!objects)
          return json({ error: "bad_request", reason: "unknown_ticket" }, 400);
        tickets.delete(body.ticket as string);
        const staged: string[] = [];
        for (const o of objects) {
          const mine = `${String(body.deliverable)}:${o.sha256}`;
          if (referenced.has(o.sha256) && packUploads.has(mine)) continue;
          const bytes = r2.get(o.key);
          if (!bytes || sha(bytes) !== o.sha256)
            return json(
              {
                error: "bad_request",
                reason: "staged_object_missing",
                key: o.key,
              },
              400,
            );
          referenced.add(o.sha256);
          packUploads.add(mine);
          staged.push(o.sha256);
        }
        return json({
          ok: true,
          deliverable: body.deliverable,
          staged,
          present: [],
        });
      }
      case "/release/publish/delegations": {
        const d = body.deliverable as string | undefined;
        const rows = server.delegationRows;
        return json({
          delegations: rows,
          ...(d !== undefined
            ? {
                nextSeq:
                  1 +
                  Math.max(
                    0,
                    ...rows
                      .filter(
                        (r) => r.deliverable === d && r.origin === "submit",
                      )
                      .map((r) => r.seq),
                  ),
              }
            : {}),
        });
      }
      case "/release/publish/submit": {
        server.submits.push(body);
        if (server.failSubmit !== null) {
          const status = server.failSubmit;
          server.failSubmit = null;
          return json(
            { error: "conflict", reason: "seq", message: "x" },
            status,
          );
        }
        const jws = body.record as string | undefined;
        if (body.descriptor === undefined && jws) {
          const payload = JSON.parse(
            Buffer.from(jws.split(".")[1]!, "base64url").toString(),
          ) as {
            deliverable: string;
            version: string;
            seq: number;
            kind?: string;
          };
          const id = `${payload.deliverable}@${payload.version}`;
          if (payload.kind === "delegation") {
            const p = payload as unknown as {
              seq: number;
              issuedAt: number;
              expiresAt: number;
              delegate: { publicKey: string };
            };
            server.records.set(sha(jws), jws);
            server.delegationRows.push({
              sha256: sha(jws),
              deliverable: payload.deliverable,
              seq: p.seq,
              keyFingerprint: sha(
                new Uint8Array(Buffer.from(p.delegate.publicKey, "base64url")),
              ),
              issuedAt: p.issuedAt,
              expiresAt: p.expiresAt,
              origin: "submit",
              revoked: false,
              version: payload.version,
              jws,
            });
            return json({
              ok: true,
              releaseId: id,
              outcome: "created",
              record: { sha256: sha(jws), stored: true },
            });
          }
          if (payload.kind === "revocation") {
            server.revoked.push(jws);
            return json({
              ok: true,
              releaseId: id,
              outcome: "revoked",
              record: { sha256: sha(jws), stored: true },
            });
          }
          stored.set(id, { seq: payload.seq, recordSha256: sha(jws), jws });
          return json({
            ok: true,
            dryRun: false,
            releaseId: id,
            outcome: "created",
            record: { sha256: sha(jws), stored: true },
          });
        }
        const d = body.descriptor as { version: string; tag?: string };
        return json({
          ok: true,
          dryRun: body.dryRun === true,
          releaseId: d.tag ?? `app@${d.version}`,
          outcome: "created",
          ...(body.dryRun ? { unverified: [] } : {}),
        });
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  }) as typeof fetch;
  return server;
}

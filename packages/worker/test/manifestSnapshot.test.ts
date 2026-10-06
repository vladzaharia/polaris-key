/**
 * ST-01a (notes/S-18 §2.1, §4.3): the manifest snapshot and the pinned-commit fetch.
 *
 *   - each of the three apply paths (`linkRepo`, `resyncRepo`, `linkSystemProduct` for the deploy
 *     hook) writes exactly one `product_manifest_snapshot` row, IN the batch that applies the
 *     manifest, and the table keeps the latest row only;
 *   - every document of one apply is read at ONE commit, the default-branch head GitHub resolved,
 *     and `applied_sha` is that commit — even when the branch moves between calls;
 *   - a failed head lookup applies nothing (no unpinned fallback);
 *   - a snapshot built from four maximum-size documents is stored and read back.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct, TEST_KEK } from "./seed.js";
import { envFor } from "./releaseRoutesFixture.js";
import { HEAD_SHA, isHeadLookup, withDefaultHead } from "./githubHead.js";
import type { Db, DbStatement } from "../src/db/types.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { parseManifest } from "../src/services/release/manifest.js";
import { MAX_REPO_FILE_BYTES } from "../src/services/release/github.js";
import {
  ensureSystemProduct,
  linkSystemProduct,
} from "../src/admin/systemProduct.js";
import {
  getManifestSnapshot,
  manifestFilesSha256,
  manifestSnapshotStatement,
} from "../src/core/manifestSnapshot.js";
import { getProduct } from "../src/repo.js";

const SLUG = "snap";
const SNAPSHOT_INSERT = /INSERT INTO product_manifest_snapshot/;

const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });
const product = (name: string) =>
  JSON.stringify({
    slug: SLUG,
    name,
    tiers: [{ id: "pro", label: "Pro" }],
  });

/** The documents as the snapshot keys them (by document name). */
const DOCS = { schema: SCHEMA, product: product("Snap") };

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

/**
 * GitHub, stubbed: installation + token, an empty release list, and `.pkey/` documents chosen by
 * `doc(path, ref)` (`ref` is the `?ref=` the read carried, `null` when it carried none).
 */
function github(
  doc: (path: string, ref: string | null) => string | undefined,
  head: string | (() => string) = HEAD_SHA,
): { fetchImpl: FetchImpl; contentRefs: (string | null)[] } {
  const contentRefs: (string | null)[] = [];
  const inner: FetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.pathname.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.pathname.includes("/releases"))
      return new Response("[]", { status: 200 });
    const m = /\/contents\/(.+)$/.exec(url.pathname);
    if (m) {
      const ref = url.searchParams.get("ref");
      contentRefs.push(ref);
      const body = doc(decodeURIComponent(m[1]!), ref);
      return body === undefined
        ? new Response("not found", { status: 404 })
        : contents(body);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl: withDefaultHead(inner, head), contentRefs };
}

/** A stub serving `docs` at every ref. */
function serving(docs: { schema: string; product: string }) {
  return github((path) =>
    path === ".pkey/schema.json"
      ? docs.schema
      : path === ".pkey/product.json"
        ? docs.product
        : undefined,
  );
}

/** Wrap `db` so every `batch` call's SQL is recorded, in order. */
function recording(db: Db): { db: Db; batches: string[][] } {
  const batches: string[][] = [];
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "batch")
        return async (stmts: DbStatement[]) => {
          batches.push(stmts.map((s) => s.sql));
          return target.batch(stmts);
        };
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function"
        ? (v as (...a: unknown[]) => unknown).bind(target)
        : v;
    },
  });
  return { db: proxy, batches };
}

/** The batches that wrote a snapshot. */
function snapshotBatches(batches: string[][]): string[][] {
  return batches.filter((b) => b.some((sql) => SNAPSHOT_INSERT.test(sql)));
}

async function snapshotCount(db: Db): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM product_manifest_snapshot",
  );
  return row?.n ?? 0;
}

async function linked() {
  const base = makeTestDb();
  const rec = recording(base);
  const env = envFor();
  const linkedRes = await linkRepo(
    env,
    rec.db,
    "acme/snap",
    NOW,
    serving(DOCS).fetchImpl,
  );
  expect(linkedRes.ok).toBe(true);
  return { env, ...rec, base };
}

describe("the manifest snapshot: one row per apply, in the apply's batch (ST-01a)", () => {
  it("linkRepo writes it in the batch that creates the product", async () => {
    const { db, batches } = await linked();
    const written = snapshotBatches(batches);
    expect(written).toHaveLength(1);
    expect(written[0]!.filter((sql) => SNAPSHOT_INSERT.test(sql))).toHaveLength(
      1,
    );
    expect(written[0]!.some((sql) => /INSERT INTO products/.test(sql))).toBe(
      true,
    );

    const row = (await getManifestSnapshot(db, SLUG))!;
    expect(row).toMatchObject({
      product: SLUG,
      origin: "link",
      applied_sha: HEAD_SHA,
      applied_at: NOW,
      files_sha256: await manifestFilesSha256(DOCS),
    });
    const manifest = JSON.parse(row.manifest_json) as {
      product: { slug: string; name: string };
      tiers: { id: string }[];
    };
    expect(manifest.product).toMatchObject({ slug: SLUG, name: "Snap" });
    expect(manifest.tiers.map((t) => t.id)).toEqual(["pro"]);
    expect(await snapshotCount(db)).toBe(1);
  });

  it("resyncRepo writes it in the batch that replaces the manifest rows, latest only", async () => {
    const { env, db, batches } = await linked();
    batches.length = 0;
    const next = { schema: SCHEMA, product: product("Snap Two") };
    const first = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 10,
      serving(next).fetchImpl,
    );
    expect(first.ok).toBe(true);
    // Bookkeeping, not a manifest section: `updated` is unchanged by the snapshot.
    if (first.ok) expect(first.updated).not.toContain("snapshot");
    const written = snapshotBatches(batches);
    expect(written).toHaveLength(1);
    expect(written[0]!.filter((sql) => SNAPSHOT_INSERT.test(sql))).toHaveLength(
      1,
    );
    // ST-01b: the manifest's tiers are upserted per row in the same batch (no blanket DELETE).
    expect(written[0]!.some((sql) => /INSERT INTO tiers/.test(sql))).toBe(true);

    expect(await getManifestSnapshot(db, SLUG)).toMatchObject({
      origin: "resync",
      applied_sha: HEAD_SHA,
      applied_at: NOW + 10,
      files_sha256: await manifestFilesSha256(next),
    });

    const second = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 20,
      serving(next).fetchImpl,
    );
    expect(second.ok).toBe(true);
    expect(snapshotBatches(batches)).toHaveLength(2);
    expect(await snapshotCount(db)).toBe(1);
    expect((await getManifestSnapshot(db, SLUG))!.applied_at).toBe(NOW + 20);
  });

  it("linkSystemProduct (the deploy hook) writes it in the batch that links the system product", async () => {
    const base = makeTestDb();
    const env = envFor();
    env.PLATFORM_KEK = TEST_KEK;
    expect((await ensureSystemProduct(env, base, "u1", NOW)).ok).toBe(true);
    const root = join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "..",
      ".pkey",
    );
    const files = {
      product: readFileSync(join(root, "product.yaml"), "utf8"),
      schema: readFileSync(join(root, "schema.yaml"), "utf8"),
      release: readFileSync(join(root, "release.yaml"), "utf8"),
    };
    const parsed = parseManifest(files);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const repo = {
      repository: "vladzaharia/polaris-key",
      repositoryId: 1,
      repositoryOwnerId: 2,
    };
    const rec = recording(base);
    const deploySha = "c".repeat(40);
    const res = await linkSystemProduct(
      rec.db,
      parsed.manifest,
      repo,
      { files, sha: deploySha },
      NOW + 1,
    );
    expect(res.ok).toBe(true);
    const written = snapshotBatches(rec.batches);
    expect(written).toHaveLength(1);
    expect(written[0]!.filter((sql) => SNAPSHOT_INSERT.test(sql))).toHaveLength(
      1,
    );
    expect(
      written[0]!.some((sql) => /INSERT INTO release_config/.test(sql)),
    ).toBe(true);
    const row = (await getManifestSnapshot(base, SYSTEM_PRODUCT_SLUG))!;
    expect(row).toMatchObject({
      origin: "deploy-hook",
      applied_sha: deploySha,
      applied_at: NOW + 1,
      files_sha256: await manifestFilesSha256(files),
    });
    expect(
      (JSON.parse(row.manifest_json) as { product: { slug: string } }).product
        .slug,
    ).toBe(SYSTEM_PRODUCT_SLUG);

    // No `PKEY_GIT_SHA` (a hand deploy, `wrangler dev`) — or a malformed one — is stored as NULL.
    for (const sha of [null, "not-a-sha"]) {
      const again = await linkSystemProduct(
        base,
        parsed.manifest,
        repo,
        { files, sha },
        NOW + 2,
      );
      expect(again.ok).toBe(true);
      expect(
        (await getManifestSnapshot(base, SYSTEM_PRODUCT_SLUG))!.applied_sha,
      ).toBeNull();
    }
    expect(await snapshotCount(base)).toBe(1);
  });
});

describe("the pinned fetch: one commit per apply (ST-01a)", () => {
  it("reads every document at the head resolved once, while the branch moves between calls", async () => {
    const { env, db } = await linked();
    const SHA_A = "a".repeat(40);
    const SHA_B = "b".repeat(40);
    const heads = [SHA_A, SHA_B];
    let unpinned = 0;
    const stub = github(
      (path, ref) => {
        // An UNPINNED read would see the branch move after its first document (a push landing
        // mid-sync): the second document would come from B.
        const at = ref ?? (unpinned++ === 0 ? SHA_A : SHA_B);
        if (path === ".pkey/schema.json") return SCHEMA;
        if (path === ".pkey/product.json")
          return product(at === SHA_A ? "Snap A" : "Snap B");
        return undefined;
      },
      () => heads.shift() ?? SHA_B,
    );

    const first = await resyncRepo(env, db, SLUG, NOW + 10, stub.fetchImpl);
    expect(first.ok).toBe(true);
    expect(stub.contentRefs.length).toBeGreaterThan(1);
    expect(stub.contentRefs.every((r) => r === SHA_A)).toBe(true);
    expect((await getProduct(db, SLUG))!.name).toBe("Snap A");
    expect((await getManifestSnapshot(db, SLUG))!.applied_sha).toBe(SHA_A);

    // The branch has moved: the next apply resolves the new head and reads everything there.
    stub.contentRefs.length = 0;
    const second = await resyncRepo(env, db, SLUG, NOW + 20, stub.fetchImpl);
    expect(second.ok).toBe(true);
    expect(stub.contentRefs.every((r) => r === SHA_B)).toBe(true);
    expect((await getProduct(db, SLUG))!.name).toBe("Snap B");
    expect((await getManifestSnapshot(db, SLUG))!.applied_sha).toBe(SHA_B);
  });

  it("a failed head lookup applies nothing and leaves the snapshot alone", async () => {
    const { env, db } = await linked();
    const before = await getManifestSnapshot(db, SLUG);
    const inner = serving({ schema: SCHEMA, product: product("Changed") });
    const noHead: FetchImpl = async (input, init) =>
      isHeadLookup(String(input))
        ? new Response("not found", { status: 404 })
        : inner.fetchImpl(input, init);
    const res = await resyncRepo(env, db, SLUG, NOW + 10, noHead);
    expect(res).toMatchObject({
      ok: false,
      error: "default branch head lookup failed: 404",
    });
    // No document was read unpinned as a fallback.
    expect(inner.contentRefs).toEqual([]);
    expect((await getProduct(db, SLUG))!.name).toBe("Snap");
    expect(await getManifestSnapshot(db, SLUG)).toEqual(before);
  });

  it("a malformed head answer is refused the same way", async () => {
    const { env, db } = await linked();
    const stub = github(() => undefined, "refs/heads/main");
    const res = await resyncRepo(env, db, SLUG, NOW + 10, stub.fetchImpl);
    expect(res).toMatchObject({
      ok: false,
      error: "default branch head: unexpected shape",
    });
    expect(stub.contentRefs).toEqual([]);
  });
});

describe("snapshot size (ST-01a, D1's value limit)", () => {
  it("stores and reads back a snapshot built from four maximum-size documents", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    // Each document at the fetch cap (`MAX_REPO_FILE_BYTES`, twice the parser's 64 KiB), i.e. an
    // upper bound on anything the parser could accept, for all four documents at once.
    const files = Object.fromEntries(
      ["schema", "product", "release", "distribution"].map((name, i) => [
        name,
        String.fromCharCode(97 + i).repeat(MAX_REPO_FILE_BYTES),
      ]),
    );
    const stmt = await manifestSnapshotStatement(
      SLUG,
      "backfill",
      null,
      files,
      files,
      NOW,
    );
    // D1 caps a string, BLOB or row at 2,000,000 bytes; the largest snapshot stays well under.
    const bytes = new TextEncoder().encode(
      stmt.params.filter((p) => typeof p === "string").join(""),
    ).length;
    expect(bytes).toBeGreaterThan(4 * MAX_REPO_FILE_BYTES);
    expect(bytes).toBeLessThan(1_000_000);
    await db.batch([stmt]);

    const row = (await getManifestSnapshot(db, SLUG))!;
    expect(row.origin).toBe("backfill");
    expect(row.applied_sha).toBeNull();
    expect(row.files_sha256).toBe(await manifestFilesSha256(files));
    expect(JSON.parse(row.manifest_json)).toEqual(files);
  });

  it("the files digest ignores read order and separates names from contents", async () => {
    expect(await manifestFilesSha256({ a: "1", b: "2" })).toBe(
      await manifestFilesSha256({ b: "2", a: "1" }),
    );
    expect(await manifestFilesSha256({ a: "1b", c: "" })).not.toBe(
      await manifestFilesSha256({ a: "1", bc: "" }),
    );
    expect(await manifestFilesSha256({ a: "x" })).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * P0-03 — the GitHub `release` webhook refreshes the release truth store.
 *
 * Every case posts a signed delivery (recorded-shape payload, real HMAC over the exact bytes)
 * through `handleGithubWebhook` against a stubbed GitHub, and then reads the four truth-store
 * tables back. What is pinned:
 *
 *   - any release action re-runs the ordinary, paginated, floor-aware store sync for each product
 *     linked to the repo — and nothing else: no `.pkey/` read, no `product_sync_state` write;
 *   - the signature check and the delivery-GUID replay guard (R6-06, filed under R6-07) still run
 *     first, and the installation binding (R6-05) still gates every product;
 *   - a release that has gone upstream keeps its rows and is marked `absentUpstream`, but only
 *     when the list was read to its end.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import {
  getProductSyncState,
  upsertProductSyncState,
} from "../src/core/repo.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import {
  listReleaseArtifacts,
  listReleaseChannels,
  listReleaseHealth,
  listReleaseMetadata,
} from "../src/services/release/store.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { withDefaultHead } from "./githubHead.js";

const SLUG = "djdl";
const OWNER = "acme";
const REPO = "djdl";
const INSTALLATION = 42;
const SECRET = "webhook-secret";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function asset(tag: string, name: string, id: number): ReleaseAsset {
  return {
    id,
    name,
    size: 2048,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${name}`,
  };
}

function release(tag: string, over: Partial<Release> = {}): Release {
  return {
    tag_name: tag,
    name: tag,
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    assets: [asset(tag, `djdl-${tag}-arm64.dmg`, tag.length * 1000 + 1)],
    ...over,
  };
}

/** A product linked to `acme/djdl` through installation 42, with a manifest sync on record. */
async function seed(db: Db): Promise<void> {
  await seedProduct(db, SLUG);
  // `listProductsByGithubRepo` only matches GitHub-sourced products.
  await db.run(
    "UPDATE products SET release_source = 'github' WHERE slug = ?",
    SLUG,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name,
        summary_marker, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    SLUG,
    OWNER,
    REPO,
    INSTALLATION,
    "main",
    "djdl",
    "pkey:summary",
    "public",
    "public",
  );
  await upsertProductSyncState(db, {
    product: SLUG,
    source: "webhook",
    status: "error",
    last_checked_at: NOW - 100,
    last_synced_at: null,
    commit_sha: "deadbeef",
    changed_paths_json: JSON.stringify([".pkey/product.yaml"]),
    updated_json: null,
    errors_json: JSON.stringify(["a failed manifest sync must stay visible"]),
    message: "manifest sync failed",
  });
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.GITHUB_WEBHOOK_SECRET = SECRET;
  return env;
}

/** A paginating GitHub stub over mutable state; `calls` records every URL requested. */
function github(state: { releases: Release[] }): {
  fetchImpl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    const list = url.match(/\/releases\?per_page=(\d+)(?:&page=(\d+))?$/);
    if (list) {
      const per = Number(list[1]);
      const page = Number(list[2] ?? "1");
      const body = state.releases.slice((page - 1) * per, page * per);
      const headers: Record<string, string> = {};
      if (page * per < state.releases.length)
        headers.Link = `<${API}/releases?per_page=${per}&page=${page + 1}>; rel="next"`;
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    return new Response("nf", { status: 404 });
  };
  return { fetchImpl: withDefaultHead(fetchImpl), calls };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body) as BufferSource,
    ),
  );
  return `sha256=${hex(sig)}`;
}

/**
 * A `release` delivery in GitHub's recorded shape. The `release` object is deliberately
 * nonsense — a tag, URL and asset that exist nowhere upstream — because the handler must never
 * write from it: the sync re-reads GitHub with the installation token.
 */
function releasePayload(
  action: string,
  over: { installationId?: number } = {},
): Record<string, unknown> {
  return {
    action,
    release: {
      tag_name: "v9.9.9-forged",
      html_url: "https://evil.example/releases/v9.9.9-forged",
      draft: false,
      prerelease: false,
      assets: [
        {
          id: 666,
          name: "djdl-forged.dmg",
          browser_download_url: "https://evil.example/djdl-forged.dmg",
        },
      ],
    },
    repository: {
      name: REPO,
      full_name: `${OWNER}/${REPO}`,
      owner: { login: OWNER },
    },
    installation: { id: over.installationId ?? INSTALLATION },
    sender: { login: "octocat" },
  };
}

interface Delivery {
  body: string;
  signature: string;
  deliveryId: string;
}

async function delivery(payload: unknown): Promise<Delivery> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { body, signature: await sign(body), deliveryId: crypto.randomUUID() };
}

function request(d: Delivery, event = "release"): Request {
  return new Request("https://key.plrs.im/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": d.signature,
      "x-github-delivery": d.deliveryId,
    },
    body: d.body,
  });
}

interface ReleaseEventBody {
  ok: boolean;
  event?: string;
  action?: string | null;
  ignored?: string;
  results?: Array<{
    product: string;
    ok: boolean;
    statements: number;
    error?: string;
  }>;
}

async function post(
  env: Env,
  db: Db,
  fetchImpl: FetchImpl,
  d: Delivery,
  now = NOW + 60,
): Promise<{ status: number; body: ReleaseEventBody }> {
  const res = await handleGithubWebhook(request(d), env, db, now, fetchImpl);
  return { status: res.status, body: (await res.json()) as ReleaseEventBody };
}

/** Everything the four truth-store tables hold, for "wrote nothing" comparisons. */
async function snapshot(db: Db) {
  const metadata = await listReleaseMetadata(db, SLUG);
  const artifacts = await Promise.all(
    metadata.map((m) => listReleaseArtifacts(db, SLUG, m.release_id)),
  );
  return {
    metadata,
    artifacts,
    channels: await listReleaseChannels(db, SLUG),
    health: await listReleaseHealth(db, SLUG),
  };
}

/** A product whose store already holds v1.0.0, synced at NOW. */
async function linkedWithV1(): Promise<{
  db: Db;
  env: Env;
  state: { releases: Release[] };
  gh: ReturnType<typeof github>;
}> {
  const db = makeTestDb();
  await seed(db);
  const env = envFor();
  const state = { releases: [release("v1.0.0")] };
  const gh = github(state);
  expect(
    await syncReleaseStore(env, db, SLUG, NOW, gh.fetchImpl),
  ).toBeGreaterThan(0);
  gh.calls.length = 0;
  return { db, env, state, gh };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GitHub release webhook refreshes the truth store (P0-03)", () => {
  it("a signed release/published delivery inserts the new release and moves the channel", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    expect(
      (await listReleaseChannels(db, SLUG)).find((c) => c.channel === "stable")
        ?.release_id,
    ).toBe("v1.0.0");

    // GitHub publishes v1.1.0; the delivery tells us only that something changed.
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    const { status, body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("published")),
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      event: "release",
      action: "published",
    });
    expect(body.results).toHaveLength(1);
    expect(body.results![0]).toMatchObject({ product: SLUG, ok: true });
    expect(body.results![0]!.statements).toBeGreaterThan(0);

    const ids = (await listReleaseMetadata(db, SLUG)).map((r) => r.release_id);
    expect(ids).toEqual(expect.arrayContaining(["v1.0.0", "v1.1.0"]));
    const artifacts = await listReleaseArtifacts(db, SLUG, "v1.1.0");
    expect(artifacts.map((a) => a.name)).toEqual(["djdl-v1.1.0-arm64.dmg"]);
    expect(artifacts[0]!.source_url).toBe(
      "https://github.com/acme/djdl/releases/download/v1.1.0/djdl-v1.1.0-arm64.dmg",
    );
    expect(
      (await listReleaseChannels(db, SLUG)).find((c) => c.channel === "stable")
        ?.release_id,
    ).toBe("v1.1.0");

    // Nothing from the payload's `release` object landed: the sync read GitHub, not the body.
    expect(ids).not.toContain("v9.9.9-forged");
    // And it read ONLY the release list — never `.pkey/` contents.
    expect(gh.calls.some((u) => u.includes("/contents/"))).toBe(false);
    expect(gh.calls.some((u) => u.includes("/releases?per_page=100"))).toBe(
      true,
    );
  });

  it.each([
    "published",
    "unpublished",
    "created",
    "edited",
    "deleted",
    "prereleased",
    "released",
  ])("handles action %s with the same store sync", async (action) => {
    const { db, env, gh } = await linkedWithV1();
    const { body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload(action)),
      NOW + 120,
    );
    expect(body).toMatchObject({ ok: true, event: "release", action });
    expect(body.results![0]!.ok).toBe(true);
    // The sync ran: the release's health row carries the delivery's clock.
    const health = await listReleaseHealth(db, SLUG);
    expect(
      health.find(
        (h) => h.subject_kind === "release" && h.subject_id === "v1.0.0",
      )?.checked_at,
    ).toBe(NOW + 120);
  });

  it("the same delivery replayed is answered duplicate-delivery and writes nothing", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    const d = await delivery(releasePayload("published"));
    expect((await post(env, db, gh.fetchImpl, d)).body.ok).toBe(true);

    // Upstream moves on; a replay of the captured delivery must not trigger a sync of it.
    state.releases = [release("v1.2.0"), release("v1.1.0"), release("v1.0.0")];
    const before = await snapshot(db);
    gh.calls.length = 0;
    const replay = await post(env, db, gh.fetchImpl, d, NOW + 3600);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ok: true,
      ignored: "duplicate-delivery",
    });
    expect(gh.calls).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  });

  it("a product with no installation binding refuses the delivery", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    await db.run(
      "UPDATE release_config SET gh_installation_id = NULL WHERE product = ?",
      SLUG,
    );
    const { body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("published")),
    );
    expect(body.results).toEqual([
      {
        product: SLUG,
        ok: false,
        statements: 0,
        error: "installation id does not match the linked repo",
      },
    ]);
    expect(gh.calls).toEqual([]);
  });

  it("a captured body replayed under a fresh delivery id is a duplicate", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    const first = await delivery(releasePayload("published"));
    expect(
      (await post(env, db, gh.fetchImpl, first)).body.ignored,
    ).toBeUndefined();
    const replay = { ...first, deliveryId: crypto.randomUUID() };
    const { body } = await post(env, db, gh.fetchImpl, replay);
    expect(body.ignored).toBe("duplicate-delivery");
  });

  it("a delivery whose installation id is not the product's writes nothing for it and reports ok:false", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    const before = await snapshot(db);

    const { status, body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("published", { installationId: 999 })),
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      {
        product: SLUG,
        ok: false,
        statements: 0,
        error: "installation id does not match the linked repo",
      },
    ]);
    // Refused before any GitHub read — no installation token minted, no list fetched.
    expect(gh.calls).toEqual([]);
    expect(await snapshot(db)).toEqual(before);
  });

  it("a signed body replayed under a fresh delivery id is ignored", async () => {
    const { db, env, gh } = await linkedWithV1();
    const first = await delivery(releasePayload("published"));
    await post(env, db, gh.fetchImpl, first);
    const replay = { ...first, deliveryId: crypto.randomUUID() };
    const { body } = await post(env, db, gh.fetchImpl, replay);
    expect(body).toMatchObject({ ok: true, ignored: "duplicate-delivery" });
  });

  it("a delivery whose processing throws gives its claims back, so GitHub's redelivery runs", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    let failing = true;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (failing) throw new Error("D1 unavailable");
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const first = await delivery(releasePayload("published"));
    await expect(post(env, flaky, gh.fetchImpl, first)).rejects.toThrow(
      "D1 unavailable",
    );
    failing = false;
    // GitHub's redelivery: the same GUID and the same signed body.
    const { body } = await post(env, flaky, gh.fetchImpl, first);
    expect(body.ignored).toBeUndefined();
    expect(body.results).toEqual([expect.objectContaining({ ok: true })]);
    // Processed once, it is a duplicate from then on.
    const again = await post(env, flaky, gh.fetchImpl, first);
    expect(again.body.ignored).toBe("duplicate-delivery");
  });

  it("a deleted delivery keeps the release row and marks its health absentUpstream", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("published")),
    );

    // v1.1.0 is deleted upstream.
    state.releases = [release("v1.0.0")];
    const { body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("deleted")),
      NOW + 120,
    );
    expect(body).toMatchObject({ ok: true, action: "deleted" });

    // The row stays: download tokens reference it (store.ts IDEMPOTENCE).
    expect(
      (await listReleaseMetadata(db, SLUG)).map((r) => r.release_id),
    ).toContain("v1.1.0");
    expect(await listReleaseArtifacts(db, SLUG, "v1.1.0")).toHaveLength(1);
    const health = await listReleaseHealth(db, SLUG);
    expect(
      health.find(
        (h) => h.subject_kind === "release" && h.subject_id === "v1.1.0",
      ),
    ).toMatchObject({
      status: "degraded",
      checked_at: NOW + 120,
      details_json: JSON.stringify({ absentUpstream: true }),
    });
    // The surviving release is not marked.
    expect(
      health.find(
        (h) => h.subject_kind === "release" && h.subject_id === "v1.0.0",
      )?.status,
    ).toBe("healthy");

    // Re-published: the next sync clears the mark through the ordinary health row.
    state.releases = [release("v1.1.0"), release("v1.0.0")];
    await post(
      env,
      db,
      gh.fetchImpl,
      // A real delivery differs from the first in its timestamps; a byte-identical body is a replay.
      await delivery({ ...releasePayload("published"), sentAt: NOW + 180 }),
      NOW + 180,
    );
    expect(
      (await listReleaseHealth(db, SLUG)).find(
        (h) => h.subject_kind === "release" && h.subject_id === "v1.1.0",
      ),
    ).toMatchObject({ status: "healthy", checked_at: NOW + 180 });
  });

  it("marks nothing absent when the paginated list hit the page cap", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    // 1,001 newer releases: the sync's 10-page cap reads 1,000 of them and stops with a `next`
    // link unread, so v1.0.0's absence from what was read proves nothing.
    state.releases = Array.from({ length: 1001 }, (_, i) =>
      release(`v2.0.${1001 - i}`, { assets: [] }),
    );
    const { body } = await post(
      env,
      db,
      gh.fetchImpl,
      await delivery(releasePayload("published")),
      NOW + 120,
    );
    expect(body.ok).toBe(true);
    expect(
      gh.calls.filter((u) => u.includes("/releases?per_page=")).length,
    ).toBe(10);
    const v1 = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_kind === "release" && h.subject_id === "v1.0.0",
    );
    expect(v1?.details_json).not.toContain("absentUpstream");
    expect(v1?.checked_at).toBe(NOW);
  });

  it("leaves product_sync_state (the MANIFEST sync's record) untouched", async () => {
    const { db, env, state, gh } = await linkedWithV1();
    const before = await getProductSyncState(db, SLUG);
    expect(before?.status).toBe("error");

    state.releases = [release("v1.1.0"), release("v1.0.0")];
    for (const action of ["published", "deleted", "edited"]) {
      expect(
        (
          await post(
            env,
            db,
            gh.fetchImpl,
            await delivery(releasePayload(action)),
          )
        ).body.ok,
      ).toBe(true);
    }
    expect(await getProductSyncState(db, SLUG)).toEqual(before);
  });

  it("refuses a bad signature before any JSON parse, and records no delivery", async () => {
    const db = makeTestDb();
    await seed(db);
    const env = envFor();
    const gh = github({ releases: [release("v1.0.0")] });
    // The body is not JSON at all: a parse would answer 400, a signature refusal 401.
    const d: Delivery = {
      body: "{not json",
      signature: await sign("{not json", "wrong-secret"),
      deliveryId: crypto.randomUUID(),
    };
    const res = await handleGithubWebhook(
      request(d),
      env,
      db,
      NOW,
      gh.fetchImpl,
    );
    expect(res.status).toBe(401);
    expect(gh.calls).toEqual([]);
    // The replay guard records only AFTER verification, so the GUID is still unused.
    const good = await delivery("{not json");
    good.deliveryId = d.deliveryId;
    const res2 = await handleGithubWebhook(
      request(good),
      env,
      db,
      NOW,
      gh.fetchImpl,
    );
    expect(res2.status).toBe(400);
  });

  it("reads only the repository and installation from the payload", async () => {
    const { db, env, gh } = await linkedWithV1();
    const noRepo = releasePayload("published");
    delete noRepo.repository;
    const res = await post(env, db, gh.fetchImpl, await delivery(noRepo));
    expect(res.status).toBe(400);
    expect(gh.calls).toEqual([]);

    // A repo nobody linked is a clean no-op.
    const other = releasePayload("published");
    other.repository = { name: "other", owner: { login: OWNER } };
    const none = await post(env, db, gh.fetchImpl, await delivery(other));
    expect(none.body).toEqual({
      ok: true,
      event: "release",
      action: "published",
      results: [],
    });
  });

  it("reports a sync that could not reach GitHub as ok:false without writing", async () => {
    const { db, env, gh } = await linkedWithV1();
    const before = await snapshot(db);
    const down: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) return gh.fetchImpl(input);
      return new Response("upstream", { status: 502 });
    };
    const { body } = await post(
      env,
      db,
      down,
      await delivery(releasePayload("published")),
    );
    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      {
        product: SLUG,
        ok: false,
        statements: 0,
        error: "release store sync did not run",
      },
    ]);
    expect(await snapshot(db)).toEqual(before);
  });
});

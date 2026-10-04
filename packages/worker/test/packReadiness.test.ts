/**
 * P4-14 — outlet readiness holds and per-outlet pack rollouts and halts, through the real routes:
 *
 *   - readiness per transport: `embedded` ready at once; `pkey-cdn` ready only once every object
 *     of the pack release is stored and held; `apple-ba` blocked until a CI report approves the
 *     level's asset pack (`foes-c4`, CONTENT §6.8 row 1); an operator override flips the state
 *     and is audited; an `entitled` pack with no gate blocks (P4-05 N4);
 *   - while blocked on a self-hosted outlet, the composed feed and the storefront selection do not
 *     offer the app release there; on the App Store outlet the matrix shows the blocker and a
 *     warning (Polaris Key cannot hold a store release);
 *   - a pack release at 25% on one outlet appears in that outlet's feed gates with its rollout and
 *     the previous release as fallback; a halt turns the gate halted; other outlets carry none.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { driveRollout, reportDistribution } from "@polaris-key/cli";
import { feedContent } from "@polaris-key/client-core/feed";
import { dispatch } from "../src/dispatch.js";
import {
  appContent,
  CONSOLE,
  FOES,
  L10N,
  NOW,
  packWorld,
  SLUG,
  type PackWorld,
  type Published,
} from "./packWorld.js";
import { readinessReader } from "../src/services/distribution/readiness.js";
import { HOLDABLE_OUTLET_KINDS } from "../src/services/distribution/readiness.js";
import { DERIVED_OUTLET_KINDS } from "../src/services/distribution/availability.js";

afterEach(() => vi.useRealTimers());

interface World {
  w: PackWorld;
  foes: Published;
  l10n: Published;
  app: string;
}

/** foes 1.0.0 (required, compatible), l10n 1.0.0, app 1.4.0 at contentApi 4; three outlets. */
async function world(): Promise<World> {
  const w = await packWorld();
  await w.addOutlet("web", "web");
  await w.addOutlet("app-store", "app-store", {
    appleId: "1234567890",
    bundleId: "gg.acme.djdl",
  });
  await w.setTransport(FOES, "app-store", "apple-ba");
  const foes = await w.publishPack(FOES, "1.0.0");
  const l10n = await w.publishPack(L10N, "1.0.0", { contentApi: null });
  const app = await w.submitApp("1.4.0", 14, appContent());
  expect(app.status, JSON.stringify(app.body)).toBe(200);
  return { w, foes, l10n, app: "1.4.0" };
}

async function appReleaseId(w: PackWorld): Promise<string> {
  const row = await w.db.first<{ release_id: string }>(
    "SELECT release_id FROM release_metadata WHERE product = ? AND deliverable_id = 'app'",
    SLUG,
  );
  return row!.release_id;
}

async function readiness(w: PackWorld, appId: string, outlet: string) {
  const r = await readinessReader({
    db: w.db,
    product: SLUG,
    hooks: await w.hooks(),
  }).forRelease(appId);
  return r!.find((o) => o.outletId === outlet)!;
}

/** Take away this product's refs to one object of `p` (as if it was never uploaded). */
async function unpublishOne(
  w: PackWorld,
  p: Published,
): Promise<() => Promise<void>> {
  const one = await w.db.first<{ storage_key: string }>(
    `SELECT storage_key FROM blob_refs WHERE product = ? AND ref_kind = 'pack-object' AND ref_id = ?
      ORDER BY storage_key LIMIT 1`,
    SLUG,
    p.releaseId,
  );
  expect(one).not.toBeNull();
  const rows = await w.db.all<Record<string, unknown>>(
    "SELECT * FROM blob_refs WHERE product = ? AND storage_key = ?",
    SLUG,
    one!.storage_key,
  );
  await w.db.run(
    "DELETE FROM blob_refs WHERE product = ? AND storage_key = ?",
    SLUG,
    one!.storage_key,
  );
  return async () => {
    for (const row of rows)
      await w.db.run(
        `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        row.product as string,
        row.storage_key as string,
        row.ref_kind as string,
        row.ref_id as string,
        row.created_at as number,
      );
  };
}

/** The web platform's target of a composed feed. */
function webTarget(doc: Record<string, any>): Record<string, any> {
  return (doc.app.targets as Record<string, any>[]).find(
    (t) => t.platform === "web",
  )!;
}

function cli(w: PackWorld) {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => dispatch(new Request(input, init), w.env, w.db)) as typeof fetch;
  return {
    product: SLUG,
    baseUrl: CONSOLE,
    env: { PKEY_CI_TOKEN: w.token },
    stdout: { write: () => true },
    stderr: { write: () => true },
    fetchImpl,
    sleep: async () => {},
  };
}

describe("readiness per transport (CONTENT §6.4)", () => {
  it("HOLDABLE_OUTLET_KINDS covers every self-hosted (derived) outlet kind", () => {
    for (const k of DERIVED_OUTLET_KINDS)
      expect(HOLDABLE_OUTLET_KINDS).toContain(k);
  });

  it("pkey-cdn is ready only once every object of the pack release is stored and held", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    expect((await readiness(w, id, "web")).state).toBe("ready");
    const restore = await unpublishOne(w, foes);
    const blocked = await readiness(w, id, "web");
    expect(blocked).toMatchObject({
      state: "blocked",
      computed: "blocked",
      holds: true,
      holdable: true,
      blockingPackReleaseId: foes.releaseId,
      warning: null,
    });
    expect(blocked.blockers[0]).toMatchObject({
      pack: FOES,
      reason: "objects-missing",
      transport: "pkey-cdn",
    });
    // l10n is not required: it never blocks.
    expect(blocked.required.map((r) => r.pack)).toEqual([FOES]);
    await restore();
    expect((await readiness(w, id, "web")).state).toBe("ready");
  });

  it("embedded is ready at once, objects or not", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    await unpublishOne(w, foes);
    await w.setTransport(FOES, "web", "embedded");
    expect(await readiness(w, id, "web")).toMatchObject({
      state: "ready",
      holds: false,
      blockers: [],
    });
  });

  it("apple-ba is blocked until CI reports the level's asset pack (foes-c4) approved", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    const before = await readiness(w, id, "app-store");
    expect(before).toMatchObject({
      state: "blocked",
      holdable: false,
      holds: false,
    });
    expect(before.blockers[0]).toMatchObject({
      reason: "awaiting-approval",
      assetPack: "foes-c4",
      transport: "apple-ba",
    });
    expect(before.warning).toMatch(/cannot hold a release on app-store/);

    // The wrong level's asset pack does not count.
    await reportDistribution({
      ...cli(w),
      type: "availability",
      outlet: "app-store",
      releaseId: foes.releaseId,
      state: "approved",
      platformRef: '{"assetPackIdentifier":"foes-c3"}',
    });
    expect((await readiness(w, id, "app-store")).state).toBe("blocked");

    const r = await reportDistribution({
      ...cli(w),
      type: "availability",
      outlet: "app-store",
      releaseId: foes.releaseId,
      state: "approved",
      platformRef: '{"assetPackIdentifier":"foes-c4"}',
    });
    expect(r.ok).toBe(true);
    expect(await readiness(w, id, "app-store")).toMatchObject({
      state: "ready",
      warning: null,
    });
    // The report refreshed the snapshot (a Distribution-side trigger), and audited the change.
    expect(
      await w.db.first(
        "SELECT state, source FROM dist_readiness WHERE product = ? AND app_release_id = ? AND outlet_id = 'app-store'",
        SLUG,
        id,
      ),
    ).toEqual({ state: "ready", source: "computed" });
    expect(
      await w.db.first(
        "SELECT actor_sub FROM audit WHERE product = ? AND action = 'distribution.readiness.ready' AND target_id = ?",
        SLUG,
        `${id}:app-store`,
      ),
    ).toEqual({ actor_sub: "system:ci" });
  });

  it("an entitled pack with no delivery gate blocks pkey-cdn (P4-05 N4)", async () => {
    const { w } = await world();
    const id = await appReleaseId(w);
    await w.db.run(
      `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
       VALUES (?, ?, 'entitled', NULL, 'admin', ?)
       ON CONFLICT DO UPDATE SET mode = 'entitled', entitlement = NULL`,
      SLUG,
      FOES,
      NOW,
    );
    expect((await readiness(w, id, "web")).blockers[0]?.reason).toBe(
      "entitlement-missing",
    );
  });

  it("an operator override releases the hold, is audited, survives a refresh, and clears", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    await unpublishOne(w, foes);
    expect(
      (await w.admin("POST", `/distribution/readiness/${id}/web/override`, {}))
        .status,
    ).toBe(422);
    const res = await w.admin(
      "POST",
      `/distribution/readiness/${id}/web/override`,
      { reason: "packs ship in the web build this time" },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { readiness: Record<string, unknown> };
    expect(body.readiness).toMatchObject({
      state: "overridden",
      computed: "blocked",
      holds: false,
    });
    expect(
      await w.db.first(
        "SELECT actor_sub, summary FROM audit WHERE product = ? AND action = 'distribution.readiness.override'",
        SLUG,
      ),
    ).toEqual({
      actor_sub: "u1",
      summary: `Overrode the readiness hold of ${id} on web: packs ship in the web build this time`,
    });
    // A refresh keeps the operator's row.
    expect(
      (await w.admin("POST", "/distribution/readiness/refresh")).status,
    ).toBe(200);
    expect(
      await w.db.first(
        "SELECT state, source FROM dist_readiness WHERE product = ? AND app_release_id = ? AND outlet_id = 'web'",
        SLUG,
        id,
      ),
    ).toEqual({ state: "overridden", source: "admin" });
    // The feed offers it on the web outlet while overridden.
    expect(webTarget(await w.feed("web")).outlets.web.live).toEqual({
      version: "1.4.0",
      seq: 14,
    });
    const cleared = await w.admin(
      "POST",
      `/distribution/readiness/${id}/web/clear`,
    );
    expect(cleared.status).toBe(200);
    expect((await readiness(w, id, "web")).holds).toBe(true);
    expect(
      await w.db.first(
        "SELECT state, source FROM dist_readiness WHERE product = ? AND app_release_id = ? AND outlet_id = 'web'",
        SLUG,
        id,
      ),
    ).toEqual({ state: "blocked", source: "computed" });
    expect(
      (await w.admin("POST", `/distribution/readiness/${id}/web/clear`)).status,
    ).toBe(409);
  });

  it("keeps the reason on an override's 404 (A-9)", async () => {
    const { w } = await world();
    const id = await appReleaseId(w);
    const unknownRelease = await w.admin(
      "POST",
      "/distribution/readiness/rel_nope/web/override",
      { reason: "x" },
    );
    expect(unknownRelease.status).toBe(404);
    expect(await unknownRelease.json()).toMatchObject({
      code: "not_found",
      reason: "unknown_release",
    });
    const unknownOutlet = await w.admin(
      "POST",
      `/distribution/readiness/${id}/nowhere/override`,
      { reason: "x" },
    );
    expect(unknownOutlet.status).toBe(404);
    expect(await unknownOutlet.json()).toMatchObject({
      code: "not_found",
      reason: "unknown_outlet",
    });
  });
});

describe("the hold (README §3.8)", () => {
  it("while blocked on the web outlet, neither the feed nor the storefront selection offers it there", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    const restore = await unpublishOne(w, foes);

    const target = webTarget(await w.feed("web"));
    expect(target.release.version).toBe("1.4.0");
    expect(target.outlets.web.live).toBeNull();

    const hooks = await w.hooks();
    const records = await hooks.delivery()!.availability(id);
    const web = records.filter((r) => r.outletId === "web");
    expect(web.length).toBeGreaterThan(0);
    expect(web.every((r) => r.state === "pending")).toBe(true);
    expect(web[0]!.detail).toMatchObject({
      readiness: { state: "blocked", blockingPackReleaseId: foes.releaseId },
    });
    const selection = await hooks.delivery()!.feedSelection({
      channel: "stable",
      origin: CONSOLE,
      kinds: ["web"],
      platform: "web",
      liveness: "availability",
    });
    expect(selection?.entries).toEqual([]);

    await restore();
    expect(webTarget(await w.feed("web")).outlets.web.live).toEqual({
      version: "1.4.0",
      seq: 14,
    });
    const after = await (await w.hooks()).delivery()!.feedSelection({
      channel: "stable",
      origin: CONSOLE,
      kinds: ["web"],
      platform: "web",
      liveness: "availability",
    });
    expect(after?.entries.map((e) => e.version)).toEqual(["1.4.0"]);
  });

  it("the matrix shows the App Store blocker with a warning, and the web hold, as availabilityFor does", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    await unpublishOne(w, foes);
    const res = await w.admin("GET", "/distribution/matrix?deliverable=app");
    expect(res.status).toBe(200);
    const m = (await res.json()) as {
      cells: Array<{
        releaseId: string;
        outletId: string;
        availability: string | null;
        readiness: Record<string, any> | null;
      }>;
    };
    const store = m.cells.find(
      (c) => c.releaseId === id && c.outletId === "app-store",
    )!;
    expect(store.readiness).toMatchObject({ state: "blocked", holds: false });
    expect(store.readiness!.blockers[0].reason).toBe("awaiting-approval");
    expect(store.readiness!.warning).toMatch(/do not release 1\.4\.0/);
    const web = m.cells.find(
      (c) => c.releaseId === id && c.outletId === "web",
    )!;
    expect(web.readiness).toMatchObject({ state: "blocked", holds: true });
    expect(web.availability).toBe("pending");
  });
});

describe("pack rollouts and halts per outlet (plans/P4-13.md rows C11–C13)", () => {
  it("a pack release at 25% on one outlet appears in that outlet's gates; a halt turns it halted; other outlets carry none", async () => {
    const { w, foes: old } = await world();
    const next = await w.publishPack(FOES, "1.0.1");
    // The ios target's outlet entries (app-store) must stay gate-free.
    await reportDistribution({
      ...cli(w),
      type: "availability",
      outlet: "app-store",
      releaseId: next.releaseId,
      state: "approved",
    });
    const set = await driveRollout({
      ...cli(w),
      command: "rollout",
      outlet: "web",
      channel: "stable",
      releaseId: next.releaseId,
      bp: "2500",
      deliverable: FOES,
    });
    const salt = (set.rollout as { rolloutSalt: string }).rolloutSalt;

    const doc = await w.feed("web");
    const content = feedContent(doc);
    expect(content.packSets).not.toBeNull();
    expect(content.packSets!.outlets?.web?.gates).toEqual({
      [next.sha256]: {
        halted: false,
        rollout: { bp: 2500, salt },
        fallback: old.sha256,
      },
    });
    expect(content.packSets!.releases[old.sha256]).toEqual({
      pack: FOES,
      version: "1.0.0",
      seq: 1,
    });
    // Rows still name the newest release; the fallback is only a gate's.
    expect(
      Object.values(content.packSets!.sets).some((m) => m.includes(old.sha256)),
    ).toBe(false);
    const ios = feedContent(await w.feed("ios"));
    expect(ios.packSets!.outlets?.["app-store"]?.gates).toBeUndefined();

    await driveRollout({
      ...cli(w),
      command: "halt",
      outlet: "web",
      channel: "stable",
      deliverable: FOES,
    });
    const halted = feedContent(await w.feed("web"));
    expect(halted.packSets!.outlets?.web?.gates).toEqual({
      [next.sha256]: { halted: true, fallback: old.sha256 },
    });

    await driveRollout({
      ...cli(w),
      command: "resume",
      outlet: "web",
      channel: "stable",
      deliverable: FOES,
    });
    await driveRollout({
      ...cli(w),
      command: "complete",
      outlet: "web",
      channel: "stable",
      deliverable: FOES,
    });
    const done = feedContent(await w.feed("web"));
    expect(done.packSets!.outlets?.web?.gates).toBeUndefined();
    expect(done.packSets!.releases[old.sha256]).toBeUndefined();
  });

  it("a gate whose release no row offers is not composed", async () => {
    const { w, foes: old } = await world();
    await w.publishPack(FOES, "1.0.1");
    await driveRollout({
      ...cli(w),
      command: "rollout",
      outlet: "web",
      channel: "stable",
      releaseId: old.releaseId,
      bp: "2500",
      deliverable: FOES,
    });
    expect(
      feedContent(await w.feed("web")).packSets!.outlets?.web,
    ).toBeUndefined();
  });
});

describe("review fixes: readiness (P4-14 S3, S6, nits)", () => {
  it("is pending (and holds) while the release's level has no resolved set", async () => {
    const { w } = await world();
    const id = await appReleaseId(w);
    await w.db.run("DELETE FROM release_sets WHERE product = ?", SLUG);
    const r = await readiness(w, id, "web");
    expect(r).toMatchObject({ state: "pending", holds: true });
    expect(r.pendingReason).toMatch(/no resolved pack set for contentApi 4/);
  });

  it("msix-optional and flatpak-ext wait for a reported approval", async () => {
    for (const transport of ["msix-optional", "flatpak-ext"]) {
      const { w, foes } = await world();
      const id = await appReleaseId(w);
      await w.setTransport(FOES, "web", transport);
      const before = await readiness(w, id, "web");
      expect(before.blockers[0]).toMatchObject({
        reason: "awaiting-approval",
        transport,
      });
      expect(before.blockers[0]!.assetPack).toBeUndefined();
      await reportDistribution({
        ...cli(w),
        type: "availability",
        outlet: "web",
        releaseId: foes.releaseId,
        state: "live",
      });
      expect((await readiness(w, id, "web")).state).toBe("ready");
      vi.useRealTimers();
    }
  });

  it("apple-ba matches the asset pack name exactly", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    await reportDistribution({
      ...cli(w),
      type: "availability",
      outlet: "app-store",
      releaseId: foes.releaseId,
      state: "approved",
      platformRef: '{"assetPackIdentifier":"badfoes-c4"}',
    });
    expect((await readiness(w, id, "app-store")).state).toBe("blocked");
  });

  it("an override or a clear changes the storefront cache stamp at once", async () => {
    const { w, foes } = await world();
    const id = await appReleaseId(w);
    await unpublishOne(w, foes);
    const stamp = async () => (await w.hooks()).delivery()!.feedStamp();
    const before = await stamp();
    await w.admin("POST", `/distribution/readiness/${id}/web/override`, {
      reason: "shipping anyway",
    });
    const overridden = await stamp();
    expect(overridden).not.toBe(before);
    vi.setSystemTime((NOW + 60) * 1000);
    await w.admin("POST", `/distribution/readiness/${id}/web/clear`);
    expect(await stamp()).not.toBe(overridden);
  });
});

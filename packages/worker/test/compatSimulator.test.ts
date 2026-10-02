/**
 * P4-15 — the console's compatibility matrix (`GET …/release/compat`) and the "what does this
 * device get?" simulator (`GET …/update/simulate`), through the real admin API.
 *
 * The world is CONTENT §6.8 row 1: the App Store serves app 1.4 (contentApi 3), direct and Play
 * serve 1.5 (contentApi 4); `djdl.foes` has a 1.x line for level 3 and a 2.x line for level 4.
 * Around it: a revoked foes release (1.0.1), 1.4 holding foes 1.0.0, and foes delivered by `play-pad`
 * on Play, which cannot float.
 *
 * The equivalence test runs an SDK's own path — the signed feed from the feed route, every record
 * from the record route, client-core's `runUpdateCheck` — and asserts the simulator's packSetId is
 * the one client-core reaches for the same selector.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdateCheck } from "@polaris-key/client-core/check";
import { packSetId } from "@polaris-key/client-core/packs";
import type { ReleasePin } from "@polaris-key/protocol/update";
import {
  appContent,
  FOES,
  L10N,
  NOW,
  noFetch,
  packWorld,
  pinOf,
  SLUG,
  CONSOLE,
  type PackWorld,
  type Published,
} from "./packWorld.js";
import { RELEASE_KID, RELEASE_PUB, signRecord } from "./releaseKeysFixture.js";
import { sha } from "./packFixture.js";
import { call } from "./releaseRoutesFixture.js";
import { loadProduct } from "../src/core/products.js";
import {
  ephemeralSigner,
  parseSimulateQuery,
  simulate as runSimulate,
} from "../src/services/update/simulate.js";

afterEach(() => {
  vi.useRealTimers();
});

interface World {
  w: PackWorld;
  foes1: Published;
  foes101: Published;
  foes2: Published;
  l10n: Published;
  app14: string;
  app15: string;
}

function content(level: number, holds: Published[] = []) {
  return {
    ...appContent(),
    contentApi: level,
    ...(holds.length > 0
      ? { holds: holds.map((h) => ({ ...pinOf(h), reason: "keeps saves" })) }
      : {}),
  };
}

async function releaseIdOf(w: PackWorld, version: string): Promise<string> {
  const row = await w.db.first<{ release_id: string }>(
    "SELECT release_id FROM release_metadata WHERE product = ? AND deliverable_id = 'app' AND version = ?",
    SLUG,
    version,
  );
  return row!.release_id;
}

async function live(w: PackWorld, releaseId: string, outlet: string) {
  await w.db.run(
    `INSERT INTO dist_availability
       (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
     VALUES (?, ?, '', ?, 'pkey-cdn', 'live', ?, 'ci', ?)`,
    SLUG,
    releaseId,
    outlet,
    NOW,
    NOW,
  );
}

async function world(): Promise<World> {
  const w = await packWorld({ android: true });
  await w.addOutlet("direct", "direct");
  await w.addOutlet("app-store", "app-store", {
    appleId: "1234567890",
    bundleId: "gg.acme.djdl",
  });
  await w.addOutlet("play", "play", { packageName: "gg.acme.djdl" });
  await w.setTransport(FOES, "play", "play-pad");

  const foes1 = await w.publishPack(FOES, "1.0.0", { contentApi: ">=3 <4" });
  const foes101 = await w.publishPack(FOES, "1.0.1", { contentApi: ">=3 <4" });
  const l10n = await w.publishPack(L10N, "1.0.0", { contentApi: null });
  await w.declareContentApi(3);
  const a14 = await w.submitApp("1.4.0", 14, content(3, [foes1]));
  expect(a14.status, JSON.stringify(a14.body)).toBe(200);
  const foes2 = await w.publishPack(FOES, "2.0.0", { contentApi: ">=4" });
  await w.declareContentApi(4);
  const a15 = await w.submitApp("1.5.0", 15, content(4));
  expect(a15.status, JSON.stringify(a15.body)).toBe(200);

  // foes 1.0.1 is revoked with no replacement: level 3 falls back to 1.0.0.
  const rev = await signRecord({
    schemaVersion: 1,
    aud: SLUG,
    deliverable: FOES,
    kind: "revocation",
    version: foes101.version,
    seq: foes101.seq,
    issuedAt: Math.floor(Date.now() / 1000),
    revokes: foes101.sha256,
    reason: "Exploit in foes spawn tables",
  });
  const r = await w.post("release/publish/submit", { record: rev });
  expect(r.status, await r.clone().text()).toBe(200);

  const app14 = await releaseIdOf(w, "1.4.0");
  const app15 = await releaseIdOf(w, "1.5.0");
  await live(w, app14, "app-store");
  await live(w, app15, "play");
  return { w, foes1, foes101, foes2, l10n, app14, app15 };
}

async function compat(w: PackWorld, q = "") {
  const res = await w.admin("GET", `/release/compat${q}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, any>;
}

async function simulate(w: PackWorld, q: Record<string, string>) {
  const res = await w.admin(
    "GET",
    `/update/simulate?${new URLSearchParams(q).toString()}`,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function cell(view: Record<string, any>, app: string, pack: string) {
  return view.cells.find(
    (c: any) => c.appReleaseId === app && c.packReleaseId === pack,
  );
}

describe("GET …/release/compat (P4-15)", () => {
  it("CONTENT §6.8 row 1: cell states, the current members and live levels {3, 4}", async () => {
    const { w, foes1, foes101, foes2, l10n, app14, app15 } = await world();
    const v = await compat(w);
    expect(v.liveLevels.stable).toEqual([3, 4]);
    expect(v.levels).toEqual([3, 4]);
    expect(
      v.appReleases.map((a: any) => [a.version, a.contentApi, a.live]),
    ).toEqual([
      ["1.5.0", 4, true],
      ["1.4.0", 3, true],
    ]);

    // 1.4 holds foes 1.0.0, which is also its set member.
    expect(cell(v, app14, foes1.releaseId)).toMatchObject({
      state: "held",
      current: true,
    });
    expect(cell(v, app14, foes2.releaseId)).toMatchObject({
      state: "incompatible",
      current: false,
    });
    expect(cell(v, app14, foes2.releaseId).reason).toMatch(/excludes level 3/);
    expect(cell(v, app15, foes2.releaseId)).toMatchObject({
      state: "compatible",
      current: true,
    });
    expect(cell(v, app15, foes1.releaseId).state).toBe("incompatible");
    // Revoked wins over compatible, and yanked rides along as a modifier.
    expect(cell(v, app14, foes101.releaseId)).toMatchObject({
      state: "revoked",
      yanked: true,
      current: false,
    });
    // l10n is standalone: compatible with both, the set member of both.
    expect(cell(v, app14, l10n.releaseId)).toMatchObject({
      state: "compatible",
      current: true,
    });
    expect(cell(v, app15, l10n.releaseId)).toMatchObject({
      state: "compatible",
      current: true,
    });

    const p101 = v.packReleases.find(
      (p: any) => p.releaseId === foes101.releaseId,
    );
    expect(p101.revoked).toMatchObject({
      kind: "record",
      reason: "Exploit in foes spawn tables",
      replacement: null,
    });
    expect(
      v.packReleases.find((p: any) => p.releaseId === foes1.releaseId),
    ).toMatchObject({ current: true, requires: { contentApi: [">=3 <4"] } });
    expect(v.packs.map((p: any) => [p.id, p.binding])).toEqual([
      [FOES, "compatible"],
      [L10N, "standalone"],
    ]);
  });

  it("pages by `limit`: live releases always, then the last N per channel and deliverable", async () => {
    const { w, foes101 } = await world();
    const v = await compat(w, "?limit=1");
    // Both app releases are live, so both stay; foes keeps its two set members (1.0.0, 2.0.0)
    // and hides the rest (1.0.1).
    expect(v.appReleases).toHaveLength(2);
    expect(
      v.packReleases.some((p: any) => p.releaseId === foes101.releaseId),
    ).toBe(false);
    expect(v.hidden).toEqual({ appReleases: 0, packReleases: 1 });
    const bad = await w.admin("GET", "/release/compat?limit=0");
    expect(bad.status).toBe(400);
    expect((await w.admin("POST", "/release/compat")).status).toBe(405);
  });
});

describe("GET …/update/simulate (P4-15)", () => {
  it("1.4 on the App Store and 1.5 on direct get different sets", async () => {
    const { w, foes1, foes2, l10n, app14, app15 } = await world();
    const a = await simulate(w, {
      appRelease: app14,
      platform: "ios",
      outlet: "app-store",
    });
    expect(a.selector).toMatchObject({
      version: "1.4.0",
      contentApi: 3,
      channel: "stable",
      outlet: { id: "app-store", kind: "app-store", servesPlatform: true },
    });
    // The App Store has 1.4 live: the device is up to date, and takes its content.
    expect(a.decision.action).toBe("packs");
    expect(a.set.map((s: any) => [s.pack, s.version])).toEqual([
      [FOES, "1.0.0"],
    ]);
    expect(a.set[0].sha256).toBe(foes1.sha256);
    const foesRow = a.packs.find((p: any) => p.pack === FOES);
    expect(foesRow).toMatchObject({
      declared: { binding: "compatible" },
      effectiveBinding: "pinned",
      reason: { kind: "app-hold" },
      feedTarget: { version: "1.0.0" },
      install: { version: "1.0.0" },
    });
    // No app release pins or holds foes 1.0.1 and no row lists it, so the feed drops its
    // revocation (P4-13 decision 14) and the simulator shows none for this device.
    expect(foesRow.revocations).toEqual([]);
    const l10nRow = a.packs.find((p: any) => p.pack === L10N);
    expect(l10nRow.reason).toMatchObject({ kind: "declared" });
    expect(l10nRow.effectiveBinding).toBe("standalone");
    expect(l10nRow.install).toBeNull(); // prefetch, optional and not active: not installed

    const b = await simulate(w, {
      appRelease: app15,
      platform: "ios",
      outlet: "direct",
    });
    expect(b.decision.action).toBe("packs");
    expect(b.set.map((s: any) => [s.pack, s.version])).toEqual([
      [FOES, "2.0.0"],
    ]);
    expect(b.set[0].sha256).toBe(foes2.sha256);
    expect(a.packSetId).not.toBe(b.packSetId);
    expect(l10n.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a play-pad outlet pins the pack, with the transport as the reason", async () => {
    const { w, app15 } = await world();
    const r = await simulate(w, {
      appRelease: app15,
      platform: "android",
      outlet: "play",
    });
    const foes = r.packs.find((p: any) => p.pack === FOES);
    expect(foes.declared.binding).toBe("compatible");
    expect(foes.effectiveBinding).toBe("pinned");
    expect(foes.reason).toMatchObject({
      kind: "transport",
      transport: "play-pad",
    });
    expect(foes.reason.detail).toMatch(/pinned by play-pad on play/);
    // Narrowed: no feed target is taken, so nothing is installed for foes on Play.
    expect(foes.install).toBeNull();
    expect(r.set).toEqual([]);
  });

  it("a revoked held release with no fix blocks the required pack: revoked-content", async () => {
    const { w, foes1, app14 } = await world();
    const rev = await signRecord({
      schemaVersion: 1,
      aud: SLUG,
      deliverable: FOES,
      kind: "revocation",
      version: foes1.version,
      seq: foes1.seq,
      issuedAt: Math.floor(Date.now() / 1000),
      revokes: foes1.sha256,
      reason: "Corrupt spawn table",
    });
    const res = await w.post("release/publish/submit", { record: rev });
    expect(res.status, await res.clone().text()).toBe(200);
    const r = await simulate(w, {
      appRelease: app14,
      platform: "ios",
      outlet: "app-store",
    });
    expect(r.decision).toMatchObject({
      action: "blocked",
      reason: "revoked-content",
    });
    expect(r.boot).toBe("required");
    expect(r.block).toBe("revoked-content");
    const foes = r.packs.find((p: any) => p.pack === FOES);
    expect(foes.revocations).toEqual([
      expect.objectContaining({
        target: foes1.sha256,
        reason: "Corrupt spawn table",
        replacement: null,
      }),
    ]);
    const v = await compat(w);
    expect(cell(v, app14, foes1.releaseId)).toMatchObject({ state: "revoked" });
    expect(cell(v, app14, foes1.releaseId).reason).toMatch(/holds it/);
  });

  it("support: a reported packSetId is compared with the simulated one", async () => {
    const { w, app15 } = await world();
    const first = await simulate(w, {
      appRelease: app15,
      platform: "web",
      outlet: "direct",
    });
    const again = await simulate(w, {
      appRelease: app15,
      platform: "web",
      outlet: "direct",
      packSetId: first.packSetId,
    });
    expect(again.reported).toEqual({
      packSetId: first.packSetId,
      matches: true,
    });
  });

  it("refuses a bad selector (400) and an unknown app release or outlet (404)", async () => {
    const { w, app15 } = await world();
    const q = (o: Record<string, string>) =>
      w.admin("GET", `/update/simulate?${new URLSearchParams(o).toString()}`);
    expect((await q({ appRelease: app15, platform: "amiga" })).status).toBe(
      400,
    );
    expect(
      (await q({ appRelease: app15, platform: "ios", variant: "Bad=x" }))
        .status,
    ).toBe(400);
    expect(
      (await q({ appRelease: app15, platform: "ios", methods: "magic" }))
        .status,
    ).toBe(400);
    expect((await q({ appRelease: "nope", platform: "ios" })).status).toBe(404);
    expect(
      (await q({ appRelease: app15, platform: "ios", outlet: "nowhere" }))
        .status,
    ).toBe(404);
    expect((await w.admin("POST", "/update/simulate")).status).toBe(405);
  });

  it("never reads the product signing key: an ephemeral key signs, the decision is the same", async () => {
    const { w, app15 } = await world();
    const viaRoute = await simulate(w, {
      appRelease: app15,
      platform: "ios",
      outlet: "direct",
    });
    // No `env` (nothing that could unseal a key) and a product exposing only its slug; every other
    // property read is recorded.
    const reads: string[] = [];
    const product = new Proxy({ slug: SLUG } as { readonly slug: string }, {
      get(target, key) {
        if (key !== "slug") reads.push(String(key));
        return Reflect.get(target, key);
      },
    });
    const direct = await runSimulate(
      {
        db: w.db,
        hooks: await w.hooks(),
        now: Math.floor(Date.now() / 1000),
        product,
      },
      parseSimulateQuery(
        new URLSearchParams({
          appRelease: app15,
          platform: "ios",
          outlet: "direct",
        }),
      ),
    );
    expect(reads).toEqual([]);
    expect(direct.decision).toEqual(viaRoute.decision);
    expect(direct.packSetId).toBe(viaRoute.packSetId);
    expect(direct.decision?.action).toBe("packs");
    // Two signers are two keys: nothing persists between requests.
    const [a, b] = await Promise.all([ephemeralSigner(), ephemeralSigner()]);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.kid).toMatch(/^sim-[0-9a-f]{16}$/);
    const productKey = (await loadProduct(w.env, w.db, SLUG))!;
    expect([a.publicKey, b.publicKey]).not.toContain(productKey.signingPub);
  });

  it("equivalence: the simulator's packSetId is client-core's for the same feed and selector", async () => {
    const { w, app14, app15 } = await world();
    const product = (await loadProduct(w.env, w.db, SLUG))!;
    const cases = [
      { app: app14, version: "1.4.0", platform: "ios", outlet: "app-store" },
      { app: app15, version: "1.5.0", platform: "ios", outlet: "direct" },
      { app: app15, version: "1.5.0", platform: "android", outlet: "play" },
      { app: app14, version: "1.4.0", platform: "web", outlet: "direct" },
    ];
    for (const c of cases) {
      const sim = await simulate(w, {
        appRelease: c.app,
        platform: c.platform,
        outlet: c.outlet,
      });
      // An SDK's path: the signed feed and the records, over HTTP, into client-core.
      const record = await w.db.first<{ jws: string }>(
        "SELECT jws FROM release_records WHERE product = ? AND release_id = ?",
        SLUG,
        c.app,
      );
      const doc = JSON.parse(
        Buffer.from(record!.jws.split(".")[1]!, "base64url").toString(),
      ) as Record<string, any>;
      const build = doc.builds.find((b: any) => b.platform === c.platform);
      const outletKind = c.outlet === "direct" ? "direct" : c.outlet;
      const check = await runUpdateCheck({
        channel: "stable",
        expectedAud: SLUG,
        trust: { [product.signingKid]: product.signingPub! },
        releaseKeys: { [RELEASE_KID]: RELEASE_PUB },
        now: Math.floor(Date.now() / 1000),
        installId: null,
        installed: {
          version: c.version,
          buildNumber: null,
          platform: c.platform,
          arch: build.arch,
          format: build.format,
          engine: null,
        },
        outlet: { id: c.outlet, kind: outletKind as "direct" },
        subkind: null,
        methods: ["download"],
        cache: {},
        fetchFeed: async (channel) => {
          const res = await call(
            w.env,
            w.db,
            noFetch,
            `${CONSOLE}/${SLUG}/update/${channel}/feed.jws?platform=${c.platform}`,
          );
          return res.ok
            ? { ok: true, body: await res.text() }
            : { ok: false, code: String(res.status) };
        },
        fetchRecord: async (h) => {
          const res = await call(
            w.env,
            w.db,
            noFetch,
            `${CONSOLE}/${SLUG}/release/records/${h}`,
          );
          return res.ok
            ? { ok: true, body: await res.text() }
            : { ok: false, code: String(res.status) };
        },
        content: {
          stamp: doc.content,
          holds: doc.content.holds ?? [],
          active: {},
          engine: null,
          axes: {},
          revoked: {},
        },
      });
      expect(check.ok).toBe(true);
      if (!check.ok) continue;
      const d = check.check.decision;
      const after = new Map<string, ReleasePin>();
      if (d.action === "packs")
        for (const i of d.install) after.set(i.pack, i.release);
      const expected = await packSetId(
        [...after].map(([packId, r]) => ({ packId, releaseSha256: r.sha256 })),
      );
      expect(sim.decision, `${c.app} ${c.platform} ${c.outlet}`).toEqual(d);
      expect(sim.packSetId, `${c.app} ${c.platform} ${c.outlet}`).toBe(
        expected,
      );
    }
    expect(sha("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

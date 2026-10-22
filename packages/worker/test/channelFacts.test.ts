import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { ascP8 } from "./ascWorld.js";
import { putOutletCredential } from "../src/core/outletCredentials.js";
import { channelFacts } from "../src/services/distribution/public.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { CatalogBuild, ServiceHooks } from "../src/core/hooks.js";

const SLUG = "diceroll";
const ISSUER = "69a6de7f-0000-47e3-e053-5b8c7c11a4d1";
const KEY_ID = "TEAMKEY123";

interface Rel {
  id: string;
  yanked?: boolean;
  builds: [string, string, string | null][]; // platform, arch, format
}

function hooksOf(channels: Record<string, Rel[]>): ServiceHooks {
  const all = Object.values(channels).flat();
  return {
    releaseCatalog: () => ({
      deliverables: async () => [{ id: "app", kind: "app", packType: null }],
      declaredBuilds: async () => [],
      knownChannels: async () => Object.keys(channels),
      channelReleases: async (_d: string, channel: string) => ({
        channel,
        releases: (channels[channel] ?? []).map((r) => ({
          releaseId: r.id,
          yanked: r.yanked === true,
        })),
      }),
      builds: async (id: string): Promise<CatalogBuild[]> =>
        (all.find((r) => r.id === id)?.builds ?? []).map(
          ([platform, arch, format], i) => ({
            releaseId: id,
            buildId: `b${i}`,
            platform,
            arch,
            format,
            buildNumber: null,
            minOs: null,
            metadata: null,
          }),
        ),
    }),
  } as unknown as ServiceHooks;
}

const releaseOf = (...builds: [string, string, string | null][]): Rel => ({
  id: "v1",
  builds,
});

async function world(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  return { db, env: makeEnv(new KvMock(), [SLUG]) };
}

const teamKey = (env: Env) =>
  ((env as Record<string, unknown>).PLATFORM_ASC_API_KEY = JSON.stringify({
    keyId: KEY_ID,
    issuerId: ISSUER,
    p8: ascP8(),
  }));

const facts = (w: { db: Db; env: Env }, hooks: ServiceHooks) =>
  channelFacts(w.env, w.db, SLUG, hooks, NOW);

const ids = (f: { channel: string }[]) => f.map((x) => x.channel);

async function outlet(
  db: Db,
  id: string,
  kind: string,
  identity: unknown = {},
) {
  await db.run(
    `INSERT INTO dist_outlets (product, outlet_id, kind, identity_json, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    SLUG,
    id,
    kind,
    JSON.stringify(identity),
    NOW,
    NOW,
  );
}

async function setup(db: Db, value: unknown) {
  await db.run(
    `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
     VALUES (?, 'core.setup', ?, 'console', 1, ?, 'test')`,
    SLUG,
    JSON.stringify(value),
    NOW,
  );
}

const winOnly = hooksOf({ stable: [releaseOf(["windows", "x86_64", "msi"])] });

describe("channelFacts: scope (A-20.3)", () => {
  it("a Windows-only product lists no App Store, TestFlight, AltStore or Homebrew", async () => {
    const w = await world();
    const out = await facts(w, winOnly);
    for (const gone of ["app-store", "testflight", "altstore", "homebrew"])
      expect(ids(out)).not.toContain(gone);
    expect(ids(out)).toEqual(
      expect.arrayContaining([
        "polaris-key",
        "winget",
        "scoop",
        "microsoft-store",
      ]),
    );
  });

  it("Release off and nothing planned: no channel is in scope", async () => {
    const w = await world();
    expect(
      await facts(w, { releaseCatalog: () => null } as unknown as ServiceHooks),
    ).toEqual([]);
  });

  it("a planned platform alone brings its channels in scope, not set up", async () => {
    const w = await world();
    await w.db.run(
      `INSERT INTO product_settings (product, key, value_json, source, version, updated_at, updated_by)
       VALUES (?, 'distribution.intendedPlatforms', '["linux"]', 'console', 1, ?, 'test')`,
      SLUG,
      NOW,
    );
    const out = await facts(w, {
      releaseCatalog: () => null,
    } as unknown as ServiceHooks);
    expect(ids(out)).toEqual(expect.arrayContaining(["flathub", "snap"]));
    expect(out.every((f) => f.state === "not_set_up")).toBe(true);
  });

  it("arm64-only Windows: winget and Scoop are in scope and the chip shows arm64 only", async () => {
    const w = await world();
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["windows", "arm64", "zip"])] }),
    );
    for (const id of ["winget", "scoop"]) {
      const f = out.find((x) => x.channel === id)!;
      expect(f.inScope).toBe(true);
      expect(f.platforms).toEqual([{ platform: "windows", arches: ["arm64"] }]);
    }
  });
});

describe("channelFacts: notUsing and oneClick (A-20.3)", () => {
  it("reads notUsing from core.setup and leaves the state alone", async () => {
    const w = await world();
    await setup(w.db, {
      integrationHidden: null,
      notUsing: ["scoop"],
      runnerConsent: null,
      skipped: [],
    });
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["windows", "x86_64", "zip"])] }),
    );
    expect(out.find((f) => f.channel === "scoop")).toMatchObject({
      notUsing: true,
      state: "not_set_up",
    });
    expect(out.find((f) => f.channel === "winget")!.notUsing).toBe(false);
  });

  it("an invalid core.setup row reads as nobody opted out", async () => {
    const w = await world();
    await setup(w.db, { notUsing: "scoop" });
    expect((await facts(w, winOnly)).some((f) => f.notUsing)).toBe(false);
  });

  const mac = hooksOf({ stable: [releaseOf(["macos", "arm64", "pkg"])] });

  it("oneClick is false without the team key and true with it, and never for a keyless channel", async () => {
    const w = await world();
    const before = await facts(w, mac);
    expect(before.find((f) => f.channel === "app-store")!.oneClick).toBe(false);
    teamKey(w.env);
    const after = await facts(w, mac);
    expect(after.find((f) => f.channel === "app-store")!.oneClick).toBe(true);
    expect(after.find((f) => f.channel === "homebrew")!.oneClick).toBe(false);
    expect(after.find((f) => f.channel === "polaris-key")!.oneClick).toBe(
      false,
    );
  });

  it("an active own credential of the kind also makes it one click; a revoked one does not", async () => {
    const w = await world();
    const put = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "own-asc",
      kind: "asc-api-key",
      outletId: null,
      value: { keyId: KEY_ID, issuerId: ISSUER, p8: ascP8() },
      expiresAt: null,
      actor: "t",
      now: NOW,
    });
    expect(put.ok).toBe(true);
    expect(
      (await facts(w, mac)).find((f) => f.channel === "app-store")!.oneClick,
    ).toBe(true);
    await w.db.run(
      "UPDATE outlet_credentials SET status = 'revoked' WHERE product = ?",
      SLUG,
    );
    expect(
      (await facts(w, mac)).find((f) => f.channel === "app-store")!.oneClick,
    ).toBe(false);
  });

  it("a declared channel is not one click", async () => {
    const w = await world();
    teamKey(w.env);
    await outlet(w.db, "as", "app-store", { appleId: "1" });
    expect(
      (await facts(w, mac)).find((f) => f.channel === "app-store")!.oneClick,
    ).toBe(false);
  });

  it("no credential value or id leaves the module", async () => {
    const w = await world();
    teamKey(w.env);
    await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "own-asc",
      kind: "asc-api-key",
      outletId: null,
      value: { keyId: KEY_ID, issuerId: ISSUER, p8: ascP8() },
      expiresAt: NOW + 3600,
      actor: "t",
      now: NOW,
    });
    await outlet(w.db, "as", "app-store", { appleId: "1" });
    const text = JSON.stringify(await facts(w, mac));
    for (const secret of [KEY_ID, ISSUER, "own-asc", "BEGIN PRIVATE"])
      expect(text).not.toContain(secret);
  });
});

describe("channelFacts: states (A-20.3)", () => {
  it("Polaris Key is not set up before a release and live after the first", async () => {
    const w = await world();
    const none = await facts(w, hooksOf({}));
    expect(none.find((f) => f.channel === "polaris-key")).toBeUndefined();
    const planned = await facts(
      w,
      hooksOf({
        stable: [
          { id: "v0", yanked: true, builds: [["windows", "x86_64", "msi"]] },
        ],
      }),
    );
    expect(planned.find((f) => f.channel === "polaris-key")).toBeUndefined();
    const out = await facts(w, winOnly);
    expect(out.find((f) => f.channel === "polaris-key")!.state).toBe("live");
  });

  it("a declared outlet with nothing reported is ready; a live availability record makes it live", async () => {
    const w = await world();
    await outlet(w.db, "wg", "winget", { packageId: "Acme.Dice" });
    const win = hooksOf({ stable: [releaseOf(["windows", "x86_64", "msi"])] });
    expect(
      (await facts(w, win)).find((f) => f.channel === "winget"),
    ).toMatchObject({ declared: true, state: "ready" });
    await w.db.run(
      `INSERT INTO dist_availability (product, release_id, build_id, outlet_id, transport, state, since, source, updated_at)
       VALUES (?, 'v1', '', 'wg', 'store', 'live', ?, 'ci', ?)`,
      SLUG,
      NOW,
      NOW,
    );
    expect(
      (await facts(w, win)).find((f) => f.channel === "winget")!.state,
    ).toBe("live");
  });

  it("a feed channel is live with a declared outlet and a fitting release", async () => {
    const w = await world();
    await outlet(w.db, "ob", "obtainium");
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["android", "arm64", "apk"])] }),
    );
    expect(out.find((f) => f.channel === "obtainium")!.state).toBe("live");
  });

  it("a macOS x86_64-only build makes the App Store attention for the arch", async () => {
    const w = await world();
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["macos", "x86_64", "pkg"])] }),
    );
    expect(out.find((f) => f.channel === "app-store")).toMatchObject({
      state: "attention",
      attention: [{ code: "no_fitting_build", reasons: ["arch"] }],
    });
  });

  it("a build in a format the channel does not take is attention for the format", async () => {
    const w = await world();
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["macos", "arm64", "dmg"])] }),
    );
    expect(out.find((f) => f.channel === "app-store")!.attention).toEqual([
      { code: "no_fitting_build", reasons: ["format"] },
    ]);
  });

  it("a declared outlet outside the product's platforms is listed with out_of_scope", async () => {
    const w = await world();
    await outlet(w.db, "as", "app-store", { appleId: "1" });
    teamKey(w.env);
    const out = await facts(w, winOnly);
    expect(out.find((f) => f.channel === "app-store")).toMatchObject({
      inScope: false,
      declared: true,
      state: "attention",
      attention: [{ code: "out_of_scope" }],
    });
  });

  it("a declared store with no team or own key is credential_missing", async () => {
    const w = await world();
    await outlet(w.db, "as", "app-store", { appleId: "1" });
    const out = await facts(
      w,
      hooksOf({ stable: [releaseOf(["macos", "arm64", "pkg"])] }),
    );
    expect(out.find((f) => f.channel === "app-store")!.attention).toEqual([
      { code: "credential_missing" },
    ]);
  });

  it("an expiring own credential raises credential_expiring; a far one does not", async () => {
    const w = await world();
    teamKey(w.env);
    const put = await putOutletCredential(w.env, w.db, {
      product: SLUG,
      credentialId: "own-asc",
      kind: "asc-api-key",
      outletId: null,
      value: { keyId: KEY_ID, issuerId: ISSUER, p8: ascP8() },
      expiresAt: null,
      actor: "t",
      now: NOW,
    });
    expect(put.ok).toBe(true);
    const expire = (at: number) =>
      w.db.run(
        "UPDATE outlet_credentials SET expires_at = ? WHERE product = ?",
        at,
        SLUG,
      );
    const mac = hooksOf({ stable: [releaseOf(["macos", "arm64", "pkg"])] });
    const attention = async () =>
      (await facts(w, mac)).find((f) => f.channel === "app-store")!.attention;
    await expire(NOW + 5 * 86_400);
    expect(await attention()).toEqual([{ code: "credential_expiring" }]);
    await expire(NOW + 90 * 86_400);
    expect(await attention()).toEqual([]);
    await expire(NOW - 1);
    expect(await attention()).toEqual([{ code: "credential_expiring" }]);
  });
});

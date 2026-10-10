/**
 * P2b-02 — `.pkey/distribution` applied by Distribution's `manifestIngest`, through Core's ingest
 * pipeline, into `dist_outlets` / `dist_transports`; the `outletCapabilities` hook; and the
 * operator's narrow-only capability override.
 *
 * Every ingest here runs the real `linkRepo` / `resyncRepo` against a stubbed GitHub (Contents
 * API + installation token), with the composition root's `SERVICES` registry handed down — and
 * three cases drive the production wiring itself: the console's link and resync routes and the
 * GitHub webhook.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, mkReq, NOW } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { handleGithubWebhook } from "../src/githubWebhook.js";
import { handleAdmin } from "../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/core/console/session.js";
import { SERVICES } from "../src/mount.js";
import {
  manifestIngestFor,
  manifestIngestStatements,
  type ServiceRegistry,
} from "../src/core/registry.js";
import { buildHooks } from "../src/core/hooks.js";
import { loadProduct } from "../src/core/products.js";
import { setServices } from "../src/core/repo.js";
import { distributionService } from "../src/services/distribution/index.js";
import {
  CAPABILITY_KEYS,
  DEFAULT_CAPABILITIES,
  effectiveCapabilities,
  kindChangeNarrows,
  kindsNarrowableTo,
  narrows,
  overrideProblem,
} from "../src/services/distribution/capabilities.js";
import { manifestIngestStatements as distributionIngestStatements } from "../src/services/distribution/outlets.js";
import { OUTLET_KINDS, parseManifest } from "@polaris-key/manifest";
import { OUTLET_CAPABILITY_DEFAULTS } from "@polaris-key/protocol/distribution";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDefaultHead } from "./githubHead.js";

const SLUG = "dice";
const INGEST = manifestIngestFor(SERVICES);

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

/** A GitHub stub serving `.pkey/` files from `files` (path → body); everything else 404s. */
function github(files: Record<string, string>): FetchImpl {
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(body);
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

const PRODUCT = (modules?: Record<string, unknown>) =>
  JSON.stringify({
    slug: SLUG,
    name: "Dice",
    modules: modules ?? {
      license: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
    },
  });
const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });
const RELEASE = JSON.stringify({
  release: {
    provider: { type: "github", owner: "vlad", repo: "dice" },
    binaryName: "dice",
    deliverables: {
      app: {
        kind: "app",
        channels: { beta: { includes: ["stable"] } },
        artifacts: [
          {
            id: "apk",
            platform: "android",
            arch: "any",
            format: "apk",
            match: "Dice-*.apk",
          },
          {
            id: "ipa-sideload",
            platform: "ios",
            arch: "arm64",
            format: "ipa",
            match: "Dice-*.ipa",
          },
        ],
      },
    },
  },
});

/** A Diceroll-shaped distribution document (README §3.12), in YAML. */
const DISTRIBUTION_YAML = `outlets:
  direct:
    platforms: [macos, windows, linux]
    homebrewCask: dice
  app-store:
    appleId: "1234567890"
    bundleId: gg.vlad.dice
  altstore:
    artifact: ipa-sideload
  play:
    packageName: gg.vlad.dice
    tracks: { stable: production, beta: beta }
  obtainium:
    artifact: apk
  steam:
    appId: 480
    branches: { beta: beta }
  itch:
    target: vlad/dice
    gameId: 1001
  web: {}
transports:
  default: pkey-cdn
  packs:
    app-store: apple-ba
    steam: steam-depot
  deliverables:
    app:
      web: web
listing:
  name: Dice
  subtitle: A cozy dice-rolling roguelite
  tintColor: "#3b1f1f"
`;

function files(over: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    ".pkey/product.json": PRODUCT(),
    ".pkey/schema.json": SCHEMA,
    ".pkey/release.json": RELEASE,
    ".pkey/distribution.yaml": DISTRIBUTION_YAML,
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

async function linked(over: Record<string, string | undefined> = {}) {
  const db = makeTestDb();
  const env = envFor();
  const res = await linkRepo(
    env,
    db,
    "https://github.com/vlad/dice",
    NOW,
    github(files(over)),
    INGEST,
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return { db, env };
}

type OutletRow = {
  outlet_id: string;
  kind: string;
  identity_json: string;
  listing_json: string | null;
  capabilities_json: string | null;
  capabilities_source: string;
  removed_at: number | null;
  created_at: number;
  modified_at: number;
};

const outlets = (db: Db) =>
  db.all<OutletRow>(
    "SELECT * FROM dist_outlets WHERE product = ? ORDER BY outlet_id",
    SLUG,
  );
const transports = (db: Db) =>
  db.all<{ deliverable_id: string; outlet_id: string; transport: string }>(
    `SELECT deliverable_id, outlet_id, transport FROM dist_transports
      WHERE product = ? ORDER BY deliverable_id, outlet_id`,
    SLUG,
  );

async function consoleCall(
  env: Env,
  db: Db,
  method: string,
  path: string,
  body?: unknown,
  now = NOW + 300,
): Promise<Response> {
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
    NOW,
  );
  const headers: Record<string, string> = {
    cookie: `${ADMIN_COOKIE}=${token}`,
    [CSRF_HEADER]: session.csrf,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return handleAdmin(mkReq(method, headers, body), env, db, path, { now });
}

async function hooksFor(env: Env, db: Db) {
  const product = (await loadProduct(env, db, SLUG))!;
  return buildHooks(SERVICES, product.services, {
    env,
    db,
    product,
    now: NOW,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("link and resync write dist_outlets and dist_transports", () => {
  it("link writes every declared outlet, its normalised identity and merged listing", async () => {
    const { db } = await linked();
    const rows = await outlets(db);
    expect(rows.map((r) => [r.outlet_id, r.kind])).toEqual([
      ["altstore", "altstore"],
      ["app-store", "app-store"],
      ["direct", "direct"],
      ["itch", "itch"],
      ["obtainium", "obtainium"],
      ["play", "play"],
      ["steam", "steam"],
      ["web", "web"],
    ]);
    const steam = rows.find((r) => r.outlet_id === "steam")!;
    // The integer app id is stored as its digits; the operator columns start at the default.
    expect(JSON.parse(steam.identity_json)).toEqual({
      appId: "480",
      branches: { beta: "beta" },
    });
    expect(steam.capabilities_json).toBeNull();
    expect(steam.capabilities_source).toBe("default");
    expect(steam.removed_at).toBeNull();
    expect(JSON.parse(steam.listing_json!)).toEqual({
      name: "Dice",
      subtitle: "A cozy dice-rolling roguelite",
      tintColor: "#3b1f1f",
    });
    expect(
      JSON.parse(rows.find((r) => r.outlet_id === "itch")!.identity_json),
    ).toEqual({ target: "vlad/dice", gameId: "1001" });
  });

  it("link resolves one transport per deliverable per outlet", async () => {
    const { db } = await linked();
    const rows = await transports(db);
    expect(rows).toHaveLength(8);
    const t = (o: string) => rows.find((r) => r.outlet_id === o)!.transport;
    // The app is not a pack, so `packs` does not apply to it; its own override does.
    expect(t("app-store")).toBe("pkey-cdn");
    expect(t("steam")).toBe("pkey-cdn");
    expect(t("web")).toBe("web");
    expect(rows.every((r) => r.deliverable_id === "app")).toBe(true);
  });

  it("a second resync of the same manifest is a no-op", async () => {
    const { db, env } = await linked();
    const first = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 10,
      github(files()),
      INGEST,
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.updated).toContain("distribution");
    const before = {
      outlets: await outlets(db),
      transports: await transports(db),
    };
    const second = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 20,
      github(files()),
      INGEST,
    );
    expect(second.ok).toBe(true);
    expect({
      outlets: await outlets(db),
      transports: await transports(db),
    }).toEqual(before);
    // No row's modified_at moved: the upsert touches only rows that changed.
    expect(before.outlets.every((r) => r.modified_at === NOW)).toBe(true);
  });

  it("a changed identity moves only that row; a removed outlet gets removed_at; re-adding clears it", async () => {
    const { db, env } = await linked();
    const changed = DISTRIBUTION_YAML.replace(
      "appId: 480",
      "appId: 481",
    ).replace(/  itch:\n    target: vlad\/dice\n    gameId: 1001\n/, "");
    expect(
      (
        await resyncRepo(
          env,
          db,
          SLUG,
          NOW + 30,
          github(files({ ".pkey/distribution.yaml": changed })),
          INGEST,
        )
      ).ok,
    ).toBe(true);
    const rows = await outlets(db);
    const steam = rows.find((r) => r.outlet_id === "steam")!;
    expect(JSON.parse(steam.identity_json).appId).toBe("481");
    expect(steam.modified_at).toBe(NOW + 30);
    expect(steam.created_at).toBe(NOW);
    const itch = rows.find((r) => r.outlet_id === "itch")!;
    expect(itch.removed_at).toBe(NOW + 30);
    expect(rows.find((r) => r.outlet_id === "play")!.modified_at).toBe(NOW);
    // A removed outlet keeps its row but leaves the transport table.
    expect((await transports(db)).map((r) => r.outlet_id)).not.toContain(
      "itch",
    );

    expect(
      (await resyncRepo(env, db, SLUG, NOW + 40, github(files()), INGEST)).ok,
    ).toBe(true);
    const back = (await outlets(db)).find((r) => r.outlet_id === "itch")!;
    expect(back.removed_at).toBeNull();
    expect(back.modified_at).toBe(NOW + 40);
  });

  it("no .pkey/distribution means one implicit direct outlet by pkey-cdn", async () => {
    const { db } = await linked({ ".pkey/distribution.yaml": undefined });
    expect((await outlets(db)).map((r) => r.outlet_id)).toEqual(["direct"]);
    expect(await transports(db)).toEqual([
      { deliverable_id: "app", outlet_id: "direct", transport: "pkey-cdn" },
    ]);
  });

  it("the .json spelling wins over YAML, exactly as for the other documents", async () => {
    const { db } = await linked({
      ".pkey/distribution.json": JSON.stringify({
        outlets: { snap: { name: "dice" } },
      }),
    });
    expect((await outlets(db)).map((r) => r.outlet_id)).toEqual(["snap"]);
  });

  it("a manifest declaring capabilities fails validation and writes nothing", async () => {
    const db = makeTestDb();
    const env = envFor();
    const res = await linkRepo(
      env,
      db,
      "https://github.com/vlad/dice",
      NOW,
      github(
        files({
          ".pkey/distribution.yaml": `${DISTRIBUTION_YAML.replace(
            "  web: {}\n",
            "  web:\n    capabilities:\n      codeUpdates: true\n",
          )}`,
        }),
      ),
      INGEST,
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.errors).toEqual([
        expect.stringMatching(/^distribution\/outlets\/web\/capabilities: /),
      ]);
    expect(await db.all("SELECT * FROM dist_outlets")).toEqual([]);
  });
});

describe("the document's own listing (PX-W1, dist_listing and delivery().listing())", () => {
  const listingRow = (db: Db) =>
    db.first<{ listing_json: string; modified_at: number }>(
      "SELECT listing_json, modified_at FROM dist_listing WHERE product = ?",
      SLUG,
    );

  it("link stores the ROOT listing, never an outlet's override, and the hook reads it", async () => {
    const yaml = DISTRIBUTION_YAML.replace(
      "  web: {}\n",
      "  web:\n    listing: { subtitle: Play in the browser }\n",
    ).replace(
      '  tintColor: "#3b1f1f"\n',
      '  tintColor: "#3b1f1f"\n  supportUrl: https://dice.example/help\n  supportEmail: help@dice.example\n',
    );
    const { db, env } = await linked({ ".pkey/distribution.yaml": yaml });
    const root = {
      name: "Dice",
      subtitle: "A cozy dice-rolling roguelite",
      tintColor: "#3b1f1f",
      supportUrl: "https://dice.example/help",
      supportEmail: "help@dice.example",
    };
    expect(JSON.parse((await listingRow(db))!.listing_json)).toEqual(root);
    // The outlet keeps its merged copy; the product's listing is untouched by the override.
    const web = (await outlets(db)).find((r) => r.outlet_id === "web")!;
    expect(JSON.parse(web.listing_json!).subtitle).toBe("Play in the browser");
    expect(await (await hooksFor(env, db)).delivery()!.listing()).toEqual(root);
  });

  it("an identical resync leaves the row alone; a removed listing deletes it", async () => {
    const { db, env } = await linked();
    const ok = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 10,
      github(files()),
      INGEST,
    );
    expect(ok.ok).toBe(true);
    expect((await listingRow(db))!.modified_at).toBe(NOW);
    const bare = DISTRIBUTION_YAML.slice(
      0,
      DISTRIBUTION_YAML.indexOf("listing:"),
    );
    const gone = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 20,
      github(files({ ".pkey/distribution.yaml": bare })),
      INGEST,
    );
    expect(gone.ok, JSON.stringify(gone)).toBe(true);
    expect(await listingRow(db)).toBeNull();
    expect(await (await hooksFor(env, db)).delivery()!.listing()).toBeNull();
  });
});

describe("enablement gates the ingest and the hook", () => {
  it("with Distribution disabled its manifestIngest does not run (spy) and the hook answers null", async () => {
    const spy = vi.fn(distributionService.manifestIngest!);
    const registry: ServiceRegistry = new Map(SERVICES);
    registry.set("distribution", {
      ...distributionService,
      manifestIngest: spy,
    });
    const db = makeTestDb();
    const env = envFor();
    const res = await linkRepo(
      env,
      db,
      "https://github.com/vlad/dice",
      NOW,
      github(
        files({
          ".pkey/product.json": PRODUCT({
            license: { enabled: true },
            release: { enabled: true },
          }),
        }),
      ),
      manifestIngestFor(registry),
    );
    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(await db.all("SELECT * FROM dist_outlets")).toEqual([]);
    const hooks = await hooksFor(env, db);
    expect(await hooks.outletCapabilities("direct")).toBeNull();
  });

  it("resync follows the STORED enablement: an operator's live off keeps the hook from running", async () => {
    const { db, env } = await linked();
    await setServices(
      db,
      SLUG,
      JSON.stringify({
        license: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: false },
      }),
      "admin",
      NOW + 5,
    );
    const spy = vi.fn(distributionService.manifestIngest!);
    const registry: ServiceRegistry = new Map(SERVICES);
    registry.set("distribution", {
      ...distributionService,
      manifestIngest: spy,
    });
    const res = await resyncRepo(
      env,
      db,
      SLUG,
      NOW + 10,
      github(files({ ".pkey/distribution.yaml": "outlets: { web: {} }\n" })),
      manifestIngestFor(registry),
    );
    expect(res.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect((await outlets(db)).every((r) => r.removed_at === null)).toBe(true);
  });

  it("Core runs only enabled services' hooks, in canonical order", () => {
    const calls: string[] = [];
    const registry: ServiceRegistry = new Map(SERVICES);
    for (const slug of ["identity", "distribution", "license"] as const)
      registry.set(slug, {
        ...SERVICES.get(slug)!,
        manifestIngest: () => {
          calls.push(slug);
          return [{ sql: "SELECT 1", params: [] }];
        },
      });
    const services = {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: false },
      identity: { enabled: false },
      sync: { enabled: false },
    };
    const out = manifestIngestStatements(
      registry,
      {} as never,
      SLUG,
      services,
      NOW,
    );
    expect(calls).toEqual(["license", "distribution"]);
    // Identity is off, so its `manifestIngest` never ran; it is listed for its
    // `manifestIngestAlways` (LX-06's row-backed settings), which is not behind enablement.
    expect(out.slugs).toEqual(["license", "distribution", "identity"]);
    // The two `manifestIngest` statements ran; identity's did not.
    expect(out.statements.filter((st) => st.sql === "SELECT 1")).toHaveLength(
      2,
    );
  });

  it("manifestIngestAlways runs whatever the enablement; manifestIngest does not", () => {
    const calls: string[] = [];
    const registry: ServiceRegistry = new Map(SERVICES);
    registry.set("distribution", {
      ...distributionService,
      manifestIngest: () => {
        calls.push("ingest");
        return [{ sql: "SELECT 1", params: [] }];
      },
      manifestIngestAlways: () => {
        calls.push("always");
        return [{ sql: "SELECT 2", params: [] }];
      },
    });
    const services = {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: false },
      update: { enabled: false },
      identity: { enabled: false },
      sync: { enabled: false },
    };
    const out = manifestIngestStatements(
      registry,
      {} as never,
      SLUG,
      services,
      NOW,
    );
    expect(calls).toEqual(["always"]);
    // License's and Identity's `manifestIngestAlways` (LX-06's row-backed settings) run too.
    expect(out.slugs).toEqual(["license", "distribution", "identity"]);
    expect(out.statements).toContainEqual({ sql: "SELECT 2", params: [] });
    expect(out.statements).not.toContainEqual({ sql: "SELECT 1", params: [] });
  });
});

describe("outletCapabilities", () => {
  it("answers the kind's default for a declared outlet, null for an undeclared or removed one", async () => {
    const { db, env } = await linked();
    const hooks = await hooksFor(env, db);
    expect(await hooks.outletCapabilities("steam")).toEqual({
      outletId: "steam",
      ...DEFAULT_CAPABILITIES.steam,
    });
    expect(await hooks.outletCapabilities("direct")).toEqual({
      outletId: "direct",
      binaryUpdates: "self",
      codeUpdates: true,
      dataUpdates: true,
      channelSwitch: true,
      commerce: "own",
      downloadedScripts: true,
    });
    expect(await hooks.outletCapabilities("ms-store")).toBeNull();
    await db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE outlet_id = 'steam'",
      NOW,
    );
    expect(await hooks.outletCapabilities("steam")).toBeNull();
  });

  it("a stored override wider than the default is clamped, never honoured", async () => {
    const { db, env } = await linked();
    await db.run(
      `UPDATE dist_outlets SET capabilities_source = 'admin', capabilities_json = ?
        WHERE outlet_id = 'app-store'`,
      JSON.stringify({
        codeUpdates: true,
        binaryUpdates: "self",
        dataUpdates: false,
      }),
    );
    const caps = await (
      await hooksFor(env, db)
    ).outletCapabilities("app-store");
    expect(caps).toEqual({
      outletId: "app-store",
      ...DEFAULT_CAPABILITIES["app-store"],
      dataUpdates: false,
    });
  });
});

describe("a push cannot widen capabilities by changing an outlet's kind", () => {
  const withBeta = (kind: string) =>
    DISTRIBUTION_YAML.replace(
      "  web: {}\n",
      `  web: {}\n  altstore-beta:\n    kind: ${kind}\n`,
    );
  const resync = (
    env: Env,
    db: Db,
    yaml: string,
    now: number,
  ): ReturnType<typeof resyncRepo> =>
    resyncRepo(
      env,
      db,
      SLUG,
      now,
      github(files({ ".pkey/distribution.yaml": yaml })),
      INGEST,
    );
  const kindOf = async (db: Db, id: string) =>
    (await outlets(db)).find((r) => r.outlet_id === id)!.kind;

  it("an id that is itself a kind cannot be re-kinded: the push is refused, nothing written", async () => {
    const { db, env } = await linked();
    const before = await outlets(db);
    const res = await resync(
      env,
      db,
      DISTRIBUTION_YAML.replace(
        '    appleId: "1234567890"\n',
        '    kind: web\n    appleId: "1234567890"\n',
      ),
      NOW + 10,
    );
    expect(res.ok).toBe(false);
    expect(await outlets(db)).toEqual(before);
    expect(
      await (await hooksFor(env, db)).outletCapabilities("app-store"),
    ).toEqual({ outletId: "app-store", ...DEFAULT_CAPABILITIES["app-store"] });
  });

  it("a custom outlet keeps its kind when a push would widen it, and the push is otherwise applied", async () => {
    const { db, env } = await linked({
      ".pkey/distribution.yaml": withBeta("altstore"),
    });
    expect(await kindOf(db, "altstore-beta")).toBe("altstore");

    const widened = withBeta("direct").replace("appId: 480", "appId: 481");
    expect((await resync(env, db, widened, NOW + 10)).ok).toBe(true);
    // The steam change landed; the kind change did not.
    expect(await kindOf(db, "altstore-beta")).toBe("altstore");
    const steam = (await outlets(db)).find((r) => r.outlet_id === "steam")!;
    expect(JSON.parse(steam.identity_json).appId).toBe("481");
    const caps = await (
      await hooksFor(env, db)
    ).outletCapabilities("altstore-beta");
    expect(caps).toEqual({
      outletId: "altstore-beta",
      ...DEFAULT_CAPABILITIES.altstore,
    });
    expect(caps!.codeUpdates).toBe(false);

    // Re-pushing the held change is a no-op: the row does not churn.
    const beta = (await outlets(db)).find(
      (r) => r.outlet_id === "altstore-beta",
    )!;
    expect((await resync(env, db, widened, NOW + 20)).ok).toBe(true);
    expect(
      (await outlets(db)).find((r) => r.outlet_id === "altstore-beta"),
    ).toEqual(beta);
  });

  it("a removed custom outlet coming back with a wider kind keeps its old kind", async () => {
    const { db, env } = await linked({
      ".pkey/distribution.yaml": withBeta("altstore"),
    });
    expect((await resync(env, db, DISTRIBUTION_YAML, NOW + 10)).ok).toBe(true);
    expect((await resync(env, db, withBeta("web"), NOW + 20)).ok).toBe(true);
    const row = (await outlets(db)).find(
      (r) => r.outlet_id === "altstore-beta",
    )!;
    expect(row.removed_at).toBeNull();
    expect(row.kind).toBe("altstore");
  });

  it("a narrowing kind change is applied", async () => {
    // direct → altstore narrows every capability (self → store, code and scripts to false,
    // commerce stays own). P2b-02's table used web → altstore; wire v4's web updates through
    // the platform (`binaryUpdates: none`), so moving it to altstore would widen.
    const { db, env } = await linked({
      ".pkey/distribution.yaml": withBeta("direct"),
    });
    expect(await kindOf(db, "altstore-beta")).toBe("direct");
    expect((await resync(env, db, withBeta("altstore"), NOW + 10)).ok).toBe(
      true,
    );
    expect(await kindOf(db, "altstore-beta")).toBe("altstore");
    expect(
      (await outlets(db)).find((r) => r.outlet_id === "altstore-beta")!
        .modified_at,
    ).toBe(NOW + 10);
  });

  it("kindChangeNarrows compares every default capability", () => {
    expect(kindChangeNarrows("app-store", "web")).toBe(false);
    expect(kindChangeNarrows("altstore", "direct")).toBe(false);
    // store-iap → own is a different commerce channel, not a narrowing.
    expect(kindChangeNarrows("app-store", "altstore")).toBe(false);
    expect(kindChangeNarrows("app-store", "testflight")).toBe(true);
    expect(kindChangeNarrows("direct", "altstore")).toBe(true);
    // Wire v4's table (P3-12): web installs update through the platform, so web → altstore
    // widens binaryUpdates (none → store), and altstore → web widens downloadedScripts.
    expect(kindChangeNarrows("web", "altstore")).toBe(false);
    expect(kindChangeNarrows("altstore", "web")).toBe(false);
    expect(kindChangeNarrows("winget", "app-installer")).toBe(true);
    expect(kindChangeNarrows("steam", "itch")).toBe(false);
    for (const kind of OUTLET_KINDS)
      expect(kindsNarrowableTo(kind)).toContain(kind);
  });
});

describe("the capability table is wire contract v4's (P3-12, plans/P3-01.md §2.9)", () => {
  const matrix = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "conformance",
        "corpus",
        "v2",
        "outlet-matrix.json",
      ),
      "utf8",
    ),
  ) as { kinds: Record<string, Record<string, unknown>> };

  it("the Worker's table, OUTLET_CAPABILITY_DEFAULTS and outlet-matrix.json#/kinds are equal", () => {
    const fromMatrix = Object.fromEntries(
      Object.entries(matrix.kinds)
        // `unknown` is a detection result with no outlet row; `platforms` is not a capability.
        .filter(([kind]) => kind !== "unknown")
        .map(([kind, row]) => {
          const { platforms: _platforms, ...caps } = row;
          return [kind, caps];
        }),
    );
    const fromProtocol = Object.fromEntries(
      OUTLET_KINDS.map((kind) => [kind, OUTLET_CAPABILITY_DEFAULTS[kind]]),
    );
    expect(DEFAULT_CAPABILITIES).toEqual(fromProtocol);
    expect(DEFAULT_CAPABILITIES).toEqual(fromMatrix);
    expect(Object.keys(DEFAULT_CAPABILITIES)).toEqual([...OUTLET_KINDS]);
    for (const kind of OUTLET_KINDS)
      expect(Object.keys(DEFAULT_CAPABILITIES[kind])).toEqual([
        ...CAPABILITY_KEYS,
      ]);
  });

  it("a stored override wider than a newly narrowed default reads back narrowed", async () => {
    // Written under P2b-02's table, where web updated itself and loaded code: an operator could
    // store exactly that. Wire v4 narrows web to the platform's updates, and the read clamps.
    const { db, env } = await linked();
    await db.run(
      `UPDATE dist_outlets SET capabilities_source = 'admin', capabilities_json = ?
        WHERE outlet_id = 'web'`,
      JSON.stringify({
        binaryUpdates: "self",
        codeUpdates: true,
        channelSwitch: true,
        downloadedScripts: false,
      }),
    );
    const caps = await (await hooksFor(env, db)).outletCapabilities("web");
    expect(caps).toEqual({
      outletId: "web",
      ...OUTLET_CAPABILITY_DEFAULTS.web,
      // The one field that genuinely narrows the new default is kept.
      downloadedScripts: false,
    });
    expect(caps!.binaryUpdates).toBe("none");
    expect(caps!.codeUpdates).toBe(false);
    expect(caps!.channelSwitch).toBe(false);
  });
});

describe("the ingest's cost is bounded for untrusted input (R10)", () => {
  it("thousands of declared packs are refused, and 64 across 32 outlets cost at most 84 transport inserts", () => {
    const outletsDoc: Record<string, unknown> = {};
    for (let i = 0; i < 32; i++) outletsDoc[`site-${i}`] = { kind: "web" };
    const parse = (packs: number) => {
      const deliverables: Record<string, unknown> = {
        app: {
          ...JSON.parse(RELEASE).release.deliverables.app,
          content: { contentApi: 1 },
        },
      };
      for (let i = 0; i < packs; i++)
        deliverables[`p${i}`] = { kind: "pack", type: "files.tree" };
      return parseManifest({
        product: PRODUCT(),
        schema: SCHEMA,
        release: JSON.stringify({
          release: { ...JSON.parse(RELEASE).release, deliverables },
        }),
        distribution: JSON.stringify({ outlets: outletsDoc }),
      });
    };
    // P4-02's MAX_PACK_DELIVERABLES: an oversized map is refused whole, before any routing.
    const spam = parse(1000);
    expect(spam.ok).toBe(false);
    if (spam.ok) return;
    expect(spam.errors.join("\n")).toContain("at most 64 pack deliverables");
    const parsed = parse(64);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const stmts = distributionIngestStatements(parsed.manifest, SLUG, NOW);
    // 32 outlet upserts + 1 removal sweep + 1 listing write (PX-W1: upsert, or delete when the
    // document declares none) + 1 transport delete + the (1 + 64) × 32 = 2,080 transport rows
    // P4-05 routes, 25 to an INSERT (four parameters each, inside D1's 100): 84.
    expect(stmts).toHaveLength(32 + 1 + 1 + 1 + 84);
    const inserts = stmts.filter((s) =>
      s.sql.includes("INSERT INTO dist_transports"),
    );
    expect(inserts.reduce((n, s) => n + s.params.length / 4, 0)).toBe(65 * 32);
    expect(
      Math.max(...inserts.map((s) => s.params.length)),
    ).toBeLessThanOrEqual(100);
  });
});

describe("the operator's capability override (console)", () => {
  it("lists the outlets with their effective capabilities and transports", async () => {
    const { db, env } = await linked();
    const res = await consoleCall(
      env,
      db,
      "GET",
      `/api/products/${SLUG}/distribution/outlets`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outlets: Array<{
        outletId: string;
        capabilities: unknown;
        capabilitiesSource: string;
        transports: unknown[];
      }>;
    };
    const web = body.outlets.find((o) => o.outletId === "web")!;
    expect(web.capabilitiesSource).toBe("default");
    expect(web.capabilities).toEqual(DEFAULT_CAPABILITIES.web);
    expect(web.transports).toEqual([
      { deliverableId: "app", transport: "web", supported: true },
    ]);
  });

  it("refuses a widening, accepts a narrowing that survives a resync, and revert restores the default", async () => {
    const { db, env } = await linked();
    const path = `/api/products/${SLUG}/distribution/outlets/steam/capabilities`;

    const widen = await consoleCall(env, db, "PUT", path, {
      capabilities: { codeUpdates: true },
    });
    expect(widen.status).toBe(422);
    expect(((await widen.json()) as { fields: string[] }).fields).toEqual([
      "codeUpdates",
    ]);
    const steamCommerce = await consoleCall(env, db, "PUT", path, {
      capabilities: { commerce: "own" },
    });
    expect(steamCommerce.status).toBe(422);
    const unknown = await consoleCall(env, db, "PUT", path, {
      capabilities: { teleport: false },
    });
    expect(unknown.status).toBe(422);

    const narrow = await consoleCall(env, db, "PUT", path, {
      capabilities: { binaryUpdates: "none", commerce: "none" },
    });
    expect(narrow.status).toBe(200);
    const narrowed = {
      outletId: "steam",
      ...DEFAULT_CAPABILITIES.steam,
      binaryUpdates: "none",
      commerce: "none",
    };
    expect(await (await hooksFor(env, db)).outletCapabilities("steam")).toEqual(
      narrowed,
    );
    const audit = await db.all<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit WHERE product = ? ORDER BY at",
      SLUG,
    );
    expect(audit.map((a) => a.action)).toContain(
      "distribution.outlet.capabilities",
    );

    // A push rewrites the manifest-owned columns but never the operator's.
    const changed = DISTRIBUTION_YAML.replace("appId: 480", "appId: 481");
    expect(
      (
        await resyncRepo(
          env,
          db,
          SLUG,
          NOW + 400,
          github(files({ ".pkey/distribution.yaml": changed })),
          INGEST,
        )
      ).ok,
    ).toBe(true);
    const steam = (await outlets(db)).find((r) => r.outlet_id === "steam")!;
    expect(steam.capabilities_source).toBe("admin");
    expect(JSON.parse(steam.identity_json).appId).toBe("481");
    expect(await (await hooksFor(env, db)).outletCapabilities("steam")).toEqual(
      narrowed,
    );

    const revert = await consoleCall(env, db, "POST", `${path}/revert`);
    expect(revert.status).toBe(200);
    expect(await (await hooksFor(env, db)).outletCapabilities("steam")).toEqual(
      {
        outletId: "steam",
        ...DEFAULT_CAPABILITIES.steam,
      },
    );
    const after = (await outlets(db)).find((r) => r.outlet_id === "steam")!;
    expect([after.capabilities_source, after.capabilities_json]).toEqual([
      "default",
      null,
    ]);
    expect(
      (
        await db.all<{ action: string }>(
          "SELECT action FROM audit WHERE product = ?",
          SLUG,
        )
      ).map((a) => a.action),
    ).toContain("distribution.outlet.capabilities.revert");
  });

  it("404s an undeclared or removed outlet", async () => {
    const { db, env } = await linked();
    expect(
      (
        await consoleCall(
          env,
          db,
          "PUT",
          `/api/products/${SLUG}/distribution/outlets/ms-store/capabilities`,
          { capabilities: { codeUpdates: false } },
        )
      ).status,
    ).toBe(404);
    await db.run(
      "UPDATE dist_outlets SET removed_at = ? WHERE outlet_id = 'web'",
      NOW,
    );
    expect(
      (
        await consoleCall(
          env,
          db,
          "POST",
          `/api/products/${SLUG}/distribution/outlets/web/capabilities/revert`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("the production wiring", () => {
  it("the console's link and resync routes run the ingest", async () => {
    const db = makeTestDb();
    const env = envFor();
    vi.stubGlobal("fetch", github(files()));
    const link = await consoleCall(env, db, "POST", "/api/products/link-repo", {
      repoUrl: "https://github.com/vlad/dice",
    });
    expect(link.status).toBe(201);
    expect((await outlets(db)).length).toBe(8);

    vi.stubGlobal(
      "fetch",
      github(files({ ".pkey/distribution.yaml": "outlets: { web: {} }\n" })),
    );
    const resync = await consoleCall(
      env,
      db,
      "POST",
      `/api/products/${SLUG}/release/resync`,
    );
    expect(resync.status).toBe(200);
    expect(((await resync.json()) as { updated: string[] }).updated).toContain(
      "distribution",
    );
    expect(
      (await outlets(db))
        .filter((r) => r.removed_at === null)
        .map((r) => r.outlet_id),
    ).toEqual(["web"]);
  });

  it("the GitHub webhook's resync runs the ingest", async () => {
    const { db, env } = await linked();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      installation: { id: 4242 },
      repository: {
        name: "dice",
        full_name: "vlad/dice",
        default_branch: "main",
        owner: { login: "vlad" },
      },
      head_commit: { modified: [".pkey/distribution.yaml"] },
      commits: [],
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    ).toString("hex");
    const req = new Request("https://key.plrs.im/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig}`,
        "x-github-delivery": crypto.randomUUID(),
      },
      body: payload,
    }) as unknown as Request;
    const res = await handleGithubWebhook(
      req,
      env,
      db,
      NOW + 50,
      github(
        files({
          ".pkey/distribution.yaml": "outlets: { snap: { name: dice } }\n",
        }),
      ),
    );
    expect(res.status).toBe(200);
    expect(
      (await outlets(db))
        .filter((r) => r.removed_at === null)
        .map((r) => r.outlet_id),
    ).toEqual(["snap"]);
  });
});

describe("capability narrowing rules", () => {
  it("every outlet kind has a default", () => {
    expect(Object.keys(DEFAULT_CAPABILITIES).sort()).toEqual(
      [...OUTLET_KINDS].sort(),
    );
  });

  it("binaryUpdates narrows self > store > none; booleans to false; commerce only to none", () => {
    const direct = DEFAULT_CAPABILITIES.direct;
    const store = DEFAULT_CAPABILITIES["app-store"];
    expect(narrows("binaryUpdates", "store", direct)).toBe(true);
    expect(narrows("binaryUpdates", "none", store)).toBe(true);
    expect(narrows("binaryUpdates", "self", store)).toBe(false);
    expect(narrows("codeUpdates", false, direct)).toBe(true);
    expect(narrows("codeUpdates", true, store)).toBe(false);
    expect(narrows("codeUpdates", "false", direct)).toBe(false);
    expect(narrows("commerce", "none", store)).toBe(true);
    expect(narrows("commerce", "own", store)).toBe(false);
    expect(narrows("commerce", "store-iap", store)).toBe(true);
    expect(overrideProblem(store, {})?.message).toMatch(/at least one/);
    expect(overrideProblem(store, [])?.message).toMatch(/object/);
    expect(effectiveCapabilities(store, "garbage")).toEqual(store);
  });
});

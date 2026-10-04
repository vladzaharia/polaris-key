/**
 * P2b-01 — Core's descriptor hooks (`src/core/hooks.ts`) and the `distribution` service.
 *
 *   1. The accessors fail CLOSED: with the providing service off for the product, the accessor is
 *      `null` and the provider's hook code never runs (a spy proves it), the same rule
 *      `dispatchService` and `authorizeRegistration` follow.
 *   2. They are what a service actually receives: inside Distribution's handler with Release off,
 *      `hooks.releaseCatalog()` is null; inside Update's with Distribution off, `hooks.delivery()`
 *      and `hooks.outletCapabilities()` are null. Discovery and the admin API get the same gate.
 *   3. The composition root has exactly one provider per hook, and two providers fail closed.
 *   4. Release's catalog reads P2-03's model as plain, deterministically ordered records.
 *   5. Distribution's skeleton: no routes, an "on, not configured" fragment, `pkey-cdn` delivery
 *      with empty availability, and no outlet capabilities yet.
 */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import {
  buildHooks,
  DEFAULT_TRANSPORT,
  hookProvider,
  type HookName,
  type ServiceHooks,
} from "../src/core/hooks.js";
import {
  dispatchService,
  type ServiceDescriptor,
  type ServiceRegistry,
} from "../src/core/registry.js";
import {
  DEFAULT_SERVICES,
  SERVICE_SLUGS,
  type ServiceSlug,
  type ServicesMap,
} from "../src/core/services.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { SERVICES } from "../src/mount.js";
import { setServices } from "../src/repo.js";
import { releaseService } from "../src/services/release/index.js";
import { distributionService } from "../src/services/distribution/index.js";
import { updateService } from "../src/services/update/index.js";
import {
  setChannelPolicy,
  upsertBuild,
  upsertDeliverable,
  yankRelease,
} from "../src/services/release/model.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";

const SLUG = "djdl";
const HOOKS: readonly HookName[] = [
  "releaseCatalog",
  "delivery",
  "outletCapabilities",
];

function servicesWith(on: readonly ServiceSlug[]): ServicesMap {
  return Object.fromEntries(
    SERVICE_SLUGS.map((s) => [s, { enabled: on.includes(s) }]),
  ) as ServicesMap;
}

const CHAIN: readonly ServiceSlug[] = [
  "license",
  "config",
  "release",
  "distribution",
  "update",
];

/** The mounted registry with each hook provider replaced by a spy around the real hook. */
function spiedRegistry(): {
  registry: ServiceRegistry;
  spies: {
    releaseCatalog: ReturnType<typeof vi.fn>;
    delivery: ReturnType<typeof vi.fn>;
    outletCapabilities: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    releaseCatalog: vi.fn(releaseService.releaseCatalog!),
    delivery: vi.fn(distributionService.delivery!),
    outletCapabilities: vi.fn(distributionService.outletCapabilities!),
  };
  const registry: ServiceRegistry = new Map(SERVICES);
  registry.set("release", {
    ...releaseService,
    releaseCatalog: spies.releaseCatalog,
  });
  registry.set("distribution", {
    ...distributionService,
    delivery: spies.delivery,
    outletCapabilities: spies.outletCapabilities,
  });
  return { registry, spies };
}

/** Replace one service's `handle` with one that records the hooks it was given. */
function capturing(
  registry: ServiceRegistry,
  slug: ServiceSlug,
): { seen: ServiceHooks[] } {
  const seen: ServiceHooks[] = [];
  const base = registry.get(slug)!;
  registry.set(slug, {
    ...base,
    handle: async (ctx) => {
      seen.push(ctx.hooks);
      return new Response("ok");
    },
  });
  return { seen };
}

async function world(): Promise<{ db: Db; env: Env; product: Product }> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), [SLUG]);
  await seedProduct(db, SLUG);
  const product = (await loadProduct(env, db, SLUG))!;
  return { db, env, product };
}

function request(
  env: Env,
  db: Db,
  product: Product,
  rest: string[] = [],
): Parameters<typeof dispatchService>[3] {
  return {
    req: new Request(`https://key.plrs.im/${SLUG}/x`) as unknown as Request,
    env,
    db,
    product,
    rest,
    now: NOW,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1–2. Fail closed, as a service sees it
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("descriptor hooks fail closed", () => {
  it("inside distribution, releaseCatalog() is null while Release is off — and Release's hook never runs", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    const { seen } = capturing(registry, "distribution");
    // Distribution on, Release off: incoherent for the validators, but the gate must hold on
    // its own (a hand-edited row, a rollback) — it is the last line, not a redundant one.
    const services = servicesWith(["license", "config", "distribution"]);
    const res = await dispatchService(
      registry,
      "distribution",
      services,
      request(env, db, product),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.releaseCatalog()).toBeNull();
    expect(spies.releaseCatalog).not.toHaveBeenCalled();
  });

  it("inside distribution, releaseCatalog() is Release's reader while Release is on", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    const { seen } = capturing(registry, "distribution");
    await dispatchService(
      registry,
      "distribution",
      servicesWith(CHAIN),
      request(env, db, product),
    );
    const catalog = seen[0]!.releaseCatalog();
    expect(catalog).not.toBeNull();
    expect(spies.releaseCatalog).toHaveBeenCalledTimes(1);
    // Memoised per request: asking twice does not build a second reader.
    expect(seen[0]!.releaseCatalog()).toBe(catalog);
    expect(spies.releaseCatalog).toHaveBeenCalledTimes(1);
  });

  it("inside update, delivery() and outletCapabilities() are null while Distribution is off — and Distribution's hooks never run", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    const { seen } = capturing(registry, "update");
    const services = servicesWith(["license", "config", "release", "update"]);
    await dispatchService(
      registry,
      "update",
      services,
      request(env, db, product),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.delivery()).toBeNull();
    expect(await seen[0]!.outletCapabilities("app-store")).toBeNull();
    expect(spies.delivery).not.toHaveBeenCalled();
    expect(spies.outletCapabilities).not.toHaveBeenCalled();
    // Release is on, so its hook still answers inside Update: the gate is per PROVIDER.
    expect(seen[0]!.releaseCatalog()).not.toBeNull();
  });

  it("inside update, delivery() is Distribution's default while Distribution is on", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    const { seen } = capturing(registry, "update");
    await dispatchService(
      registry,
      "update",
      servicesWith(CHAIN),
      request(env, db, product),
    );
    const delivery = seen[0]!.delivery();
    expect(delivery?.defaultTransport).toBe("pkey-cdn");
    expect(await delivery!.availability("v1.0.0")).toEqual([]);
    // This product has no dist_outlets rows (nothing ingested): the hook runs and answers null.
    expect(await seen[0]!.outletCapabilities("app-store")).toBeNull();
    expect(spies.delivery).toHaveBeenCalledTimes(1);
    expect(spies.outletCapabilities).toHaveBeenCalledWith(
      expect.anything(),
      "app-store",
    );
  });

  it("gates on the map the caller dispatched on, not on a stale product.services", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    // The product as loaded runs the defaults (Release off), but the dispatcher was handed a set
    // with Release on — and the reverse. The hooks follow the dispatcher's map both ways.
    const on = buildHooks(registry, servicesWith(CHAIN), {
      env,
      db,
      product,
      now: NOW,
    });
    expect(on.releaseCatalog()).not.toBeNull();
    const off = buildHooks(
      registry,
      { ...servicesWith(CHAIN), release: { enabled: false } },
      {
        env,
        db,
        product: { ...product, services: servicesWith(CHAIN) },
        now: NOW,
      },
    );
    expect(off.releaseCatalog()).toBeNull();
    expect(spies.releaseCatalog).toHaveBeenCalledTimes(1);
  });

  it("a disabled service is not dispatched, so it never sees hooks at all", async () => {
    const { db, env, product } = await world();
    const { registry } = spiedRegistry();
    const { seen } = capturing(registry, "distribution");
    const res = await dispatchService(
      registry,
      "distribution",
      DEFAULT_SERVICES,
      request(env, db, product),
    );
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("discovery fragments get the same gate", async () => {
    const { db, env, product } = await world();
    const { registry, spies } = spiedRegistry();
    let seen: ServiceHooks | undefined;
    registry.set("distribution", {
      ...registry.get("distribution")!,
      discoveryFragment: async (ctx) => {
        seen = ctx.hooks;
        return { enabled: true };
      },
    });
    const onlyDistribution = {
      ...product,
      services: servicesWith(["license", "config", "distribution"]),
    };
    await handleDiscovery(
      new Request(
        `https://key.plrs.im/${SLUG}/.well-known/polaris.json`,
      ) as unknown as Request,
      env,
      db,
      onlyDistribution,
      registry,
      NOW,
    );
    expect(seen).toBeDefined();
    expect(seen!.releaseCatalog()).toBeNull();
    expect(spies.releaseCatalog).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 3. One provider per hook
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("hook providers", () => {
  it("the composition root has exactly one provider for each hook", () => {
    const expected: Record<HookName, ServiceSlug> = {
      releaseCatalog: "release",
      delivery: "distribution",
      outletCapabilities: "distribution",
    };
    for (const name of HOOKS) {
      const providers = [...SERVICES.values()].filter(
        (d) => typeof d[name] === "function",
      );
      expect(
        providers.map((d) => d.slug),
        `exactly one mounted service implements ${name}`,
      ).toEqual([expected[name]]);
      expect(hookProvider(SERVICES, name)?.slug).toBe(expected[name]);
    }
  });

  it("two providers for one hook fail closed rather than first-wins", async () => {
    const { db, env, product } = await world();
    const rogue = vi.fn(releaseService.releaseCatalog!);
    const registry: ServiceRegistry = new Map(SERVICES);
    registry.set("identity", {
      ...(registry.get("identity") as ServiceDescriptor),
      releaseCatalog: rogue,
    });
    expect(hookProvider(registry, "releaseCatalog")).toBeNull();
    const hooks = buildHooks(registry, servicesWith([...CHAIN, "identity"]), {
      env,
      db,
      product,
      now: NOW,
    });
    expect(hooks.releaseCatalog()).toBeNull();
    expect(rogue).not.toHaveBeenCalled();
  });

  it("no provider answers null", async () => {
    const { db, env, product } = await world();
    const registry: ServiceRegistry = new Map(SERVICES);
    registry.delete("distribution");
    const hooks = buildHooks(registry, servicesWith(CHAIN), {
      env,
      db,
      product,
      now: NOW,
    });
    expect(hooks.delivery()).toBeNull();
    expect(await hooks.outletCapabilities("steam")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 4. Release's catalog
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function seedModel(db: Db): Promise<void> {
  await upsertDeliverable(
    db,
    { product: SLUG, deliverableId: "app", kind: "app" },
    NOW,
  );
  await upsertDeliverable(
    db,
    {
      product: SLUG,
      deliverableId: "dice.core3d",
      kind: "pack",
      packType: "godot.pck",
    },
    NOW,
  );
  const releases: [string, string, string, number][] = [
    ["v1.0.0", "1.0.0", "app", 1],
    ["v1.1.0", "1.1.0", "app", 2],
    ["core3d-1", "1", "dice.core3d", 1],
  ];
  for (const [id, version, deliverable, seq] of releases) {
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, published_at,
          created_at, modified_at, deliverable_id, seq, channel)
       VALUES (?, ?, ?, 'public', 'public', ?, ?, ?, ?, ?, 'stable')`,
      SLUG,
      id,
      version,
      NOW + seq,
      NOW,
      NOW,
      deliverable,
      seq,
    );
  }
  await upsertBuild(
    db,
    {
      product: SLUG,
      releaseId: "v1.1.0",
      buildId: "macos",
      platform: "macos",
      arch: "universal",
      format: "dmg",
      buildNumber: "110",
      minOs: "13.0",
    },
    NOW,
  );
  for (const [id, name, role, build] of [
    ["1", "djdl-1.1.0.dmg", "payload", "macos"],
    ["2", "djdl-1.1.0.dmg.sig", "signature", "macos"],
    ["3", "notes.txt", "payload", null],
  ] as const) {
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at, build_id, role)
       VALUES (?, 'v1.1.0', ?, ?, NULL, 'macos', 'universal', 'application/octet-stream',
               7, 'ab', NULL, NULL, NULL, 'public', NULL, ?, ?, ?)`,
      SLUG,
      id,
      name,
      NOW,
      build,
      role,
    );
  }
  await setChannelPolicy(
    db,
    { product: SLUG, deliverableId: "app", channel: "stable" },
    {
      pointerReleaseId: "v1.1.0",
      pinned: true,
      includes: ["beta"],
      minSupported: "1.0.0",
      critical: true,
    },
    { source: "admin", by: "admin:test", now: NOW },
  );
  await yankRelease(db, SLUG, "v1.0.0", "broken", "admin:test", NOW + 10);
}

describe("releaseCatalog (Release)", () => {
  async function catalogFor(db: Db, env: Env, product: Product) {
    const catalog = buildHooks(SERVICES, servicesWith(CHAIN), {
      env,
      db,
      product,
      now: NOW,
    }).releaseCatalog();
    expect(catalog).not.toBeNull();
    return catalog!;
  }

  it("reads P2-03's model as plain records", async () => {
    const { db, env, product } = await world();
    await seedModel(db);
    const catalog = await catalogFor(db, env, product);

    expect(await catalog.deliverables()).toEqual([
      { id: "app", kind: "app", packType: null },
      { id: "dice.core3d", kind: "pack", packType: "godot.pck" },
    ]);
    expect(await catalog.releases("app")).toEqual([
      {
        deliverableId: "app",
        releaseId: "v1.1.0",
        version: "1.1.0",
        seq: 2,
        channel: "stable",
        publishedAt: NOW + 2,
        yanked: false,
      },
      {
        deliverableId: "app",
        releaseId: "v1.0.0",
        version: "1.0.0",
        seq: 1,
        channel: "stable",
        publishedAt: NOW + 1,
        yanked: true,
      },
    ]);
    // Keyed by deliverable: a pack's releases are its own.
    expect(
      (await catalog.releases("dice.core3d")).map((r) => r.releaseId),
    ).toEqual(["core3d-1"]);
    expect(await catalog.builds("v1.1.0")).toEqual([
      {
        releaseId: "v1.1.0",
        buildId: "macos",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        buildNumber: "110",
        minOs: "13.0",
        metadata: null,
      },
    ]);
    expect(
      (await catalog.artifacts("v1.1.0")).map((a) => [
        a.name,
        a.buildId,
        a.role,
      ]),
    ).toEqual([
      ["notes.txt", null, "payload"],
      ["djdl-1.1.0.dmg", "macos", "payload"],
      ["djdl-1.1.0.dmg.sig", "macos", "signature"],
    ]);
    expect(
      (await catalog.artifacts("v1.1.0", "macos")).map((a) => a.name),
    ).toEqual(["djdl-1.1.0.dmg", "djdl-1.1.0.dmg.sig"]);
    expect(await catalog.channelPolicies("app")).toEqual([
      {
        deliverableId: "app",
        channel: "stable",
        pointerReleaseId: "v1.1.0",
        pinned: true,
        includes: ["beta"],
        minSupported: "1.0.0",
        critical: true,
      },
    ]);
    expect(await catalog.yanks()).toEqual([
      { releaseId: "v1.0.0", reason: "broken", at: NOW + 10 },
    ]);
  });

  it("exposes no Release row shape and no writer", async () => {
    const { db, env, product } = await world();
    await seedModel(db);
    const catalog = await catalogFor(db, env, product);
    // P2b-04 added the five byte-delivery methods: still readers. `openSource` answers with
    // bytes (Release's GitHub-located ones) rather than records, and writes nothing either.
    // P2b-05 added `channelReleases`, the feeds' history read. P4-02 added the six pack reads.
    // P6-03 added `knownChannels`, P4-12 the five pack-set reads, P4-13 `revocations`, P4-18
    // `packPayload` (the payload URL's read), P4-29 `lazyDeltas` (the feed's delta menu).
    expect(Object.keys(catalog).sort()).toEqual([
      "accessSelector",
      "artifacts",
      "builds",
      "channelPolicies",
      "channelReleases",
      "deliverables",
      "embeds",
      "embedsOf",
      "heldBy",
      "holdsFor",
      "installScript",
      "knownChannels",
      "lazyDeltas",
      "liveLevels",
      "metadataAccess",
      "openSource",
      "packChunks",
      "packDeliverables",
      "packFiles",
      "packFloors",
      "packPayload",
      "packRelease",
      "packSets",
      "pinnedBy",
      "pinnedByMany",
      "pins",
      "release",
      "releases",
      "resolve",
      "revocations",
      "yanks",
    ]);
    const [artifact] = await catalog.artifacts("v1.1.0", "macos");
    // Core's record shape, not the table's: no snake_case column leaks through the hook.
    for (const key of Object.keys(artifact!)) expect(key).not.toMatch(/_/);
    // Reading is all it does: the tables are byte-identical afterwards.
    const before = await db.all("SELECT * FROM release_metadata");
    await catalog.releases("app");
    await catalog.yanks();
    await catalog.channelReleases("app", "beta");
    await catalog.liveLevels("app", "stable");
    await catalog.packSets("stable");
    expect(await db.all("SELECT * FROM release_metadata")).toEqual(before);
  });

  it("reads only this product's rows", async () => {
    const { db, env } = await world();
    await seedModel(db);
    await seedProduct(db, "other");
    const other = (await loadProduct(env, db, "other"))!;
    const catalog = await catalogFor(db, env, other);
    expect(await catalog.deliverables()).toEqual([]);
    expect(await catalog.releases("app")).toEqual([]);
    expect(await catalog.channelPolicies()).toEqual([]);
    expect(await catalog.yanks()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 5. The distribution skeleton
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("the distribution service (P2b-01 skeleton, P2b-04 routes)", () => {
  it("answers no path outside its routes: Core's not-found, enabled or not", async () => {
    const { db, env, product } = await world();
    for (const services of [servicesWith(CHAIN), DEFAULT_SERVICES]) {
      for (const rest of [[], ["feeds"], ["altstore", "source.json"]]) {
        const res = await dispatchService(
          SERVICES,
          "distribution",
          services,
          request(env, db, product, rest),
        );
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "not_found" } });
      }
    }
  });

  it("advertises the canonical byte routes, configured once Release is (P2b-04)", async () => {
    const { db, env } = await world();
    await setServices(
      db,
      SLUG,
      JSON.stringify({
        license: { enabled: true },
        config: { enabled: true },
        release: { enabled: true },
        distribution: { enabled: true },
        update: { enabled: true },
        identity: { enabled: false },
      }),
      "manifest",
      NOW,
    );
    const product = (await loadProduct(env, db, SLUG))!;
    const res = await handleDiscovery(
      new Request(
        `https://key.plrs.im/${SLUG}/.well-known/polaris.json`,
      ) as unknown as Request,
      env,
      db,
      product,
      SERVICES,
      NOW,
    );
    const body = (await res.json()) as {
      services: Record<string, unknown>;
    };
    // No release configuration yet: on, but nothing to download.
    expect(body.services.distribution).toEqual({
      enabled: true,
      configured: false,
      endpoints: {
        download: `https://key.plrs.im/${SLUG}/distribution/dl`,
        install: `https://key.plrs.im/${SLUG}/distribution/install.sh`,
        builds: `https://key.plrs.im/${SLUG}/distribution/builds/{selector}/{buildId}`,
        blobs: `https://key.plrs.im/${SLUG}/distribution/blobs/sha256/{sha256}`,
      },
    });
    expect(Object.keys(body.services)).toEqual([...SERVICE_SLUGS]);
  });

  it("delivers by pkey-cdn with no availability, and knows no outlet", async () => {
    const { db, env, product } = await world();
    const hooks = buildHooks(SERVICES, servicesWith(CHAIN), {
      env,
      db,
      product,
      now: NOW,
    });
    expect(DEFAULT_TRANSPORT).toBe("pkey-cdn");
    expect(hooks.delivery()?.defaultTransport).toBe(DEFAULT_TRANSPORT);
    expect(await hooks.delivery()!.availability("v1.0.0")).toEqual([]);
    for (const outlet of ["direct", "app-store", "play", "steam"])
      expect(await hooks.outletCapabilities(outlet)).toBeNull();
  });

  it("update's descriptor does not implement a Distribution hook", () => {
    // Update consumes delivery; it never provides it.
    for (const name of HOOKS) expect(updateService[name]).toBeUndefined();
  });
});

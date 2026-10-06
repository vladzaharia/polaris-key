/**
 * Discovery and enforcement agree (ST-04, notes/S-18 §4.11): for EVERY live registry entry whose
 * value devices see in the discovery document (`wire: ["discovery", …]`), a write through
 * `writeSetting()` is published by `/.well-known/polaris.json`, answered by the resolver and read
 * by the enforcement path as the same value, at once. The discovery document's SHAPE does not
 * change (no wire effect: `gen:transcripts --check` stays green).
 *
 * `PROBES` must name every such entry: a new discovery-carried setting fails here until it says
 * how discovery publishes it and which reader enforces it.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { loadProduct, type Product } from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import { writeSetting } from "../src/core/settings/write.js";
import { resolveProductSetting } from "../src/core/settings/resolve.js";

interface Probe {
  /** A value to write that differs from the seeded product's. */
  value: unknown;
  /** The value as the discovery document publishes it. */
  published(doc: Record<string, any>): unknown;
  /** The value as the enforcement path reads it (the product the router and documents load). */
  enforced(product: Product): unknown;
}

const servicesFrom = (enabled: (slug: string) => boolean) =>
  Object.fromEntries(SERVICE_SLUGS.map((s) => [s, { enabled: enabled(s) }]));

const PROBES: Readonly<Record<string, Probe>> = {
  "core.name": {
    value: "Acme Renamed",
    published: (doc) => doc.name,
    enforced: (p) => p.name,
  },
  // Which services exist from outside: discovery's per-service `enabled`, and the router's gate.
  "core.services": {
    value: servicesFrom((s) => s === "license" || s === "release"),
    published: (doc) =>
      Object.fromEntries(
        SERVICE_SLUGS.map((s) => [s, { enabled: doc.services[s].enabled }]),
      ),
    enforced: (p) =>
      Object.fromEntries(
        SERVICE_SLUGS.map((s) => [
          s,
          { enabled: p.services[s]?.enabled === true },
        ]),
      ),
  },
  // The version window every grant is intersected with: discovery's `core.compat`, and the
  // window the licence document and the build gate read.
  "release.compatWindow": {
    value: { min: "2.0.0", max: "3.5.0" },
    published: (doc) => doc.core.compat,
    enforced: (p) => ({ min: p.compatMin, max: p.compatMax }),
  },
  // Who may mint a device token: discovery's `core.registration`, and the policy
  // `core/register.ts` enforces (the product's resolved registration).
  "core.registration": {
    value: "open",
    published: (doc) => doc.core.registration,
    enforced: (p) => p.registration,
  },
};

/**
 * Probes for entries a package building in parallel registers (its probe and column adapter land
 * here first, so the two meet at integration with nothing left to write). Each key names that
 * package; a probe for any other unregistered key fails.
 */
const AHEAD_OF_REGISTRY: Readonly<Record<string, string>> = {
  "core.registration": "ST-19b",
};

const registered = (key: string) =>
  SETTINGS.entries.some((e) => e.key === key && !e.pending);

/** The resolver's value in the shape the probe compares. */
function resolvedShape(key: string, value: unknown): unknown {
  if (key === "core.services")
    return Object.fromEntries(
      SERVICE_SLUGS.map((s) => [
        s,
        {
          enabled:
            (value as Record<string, { enabled?: boolean }>)[s]?.enabled ===
            true,
        },
      ]),
    );
  return value;
}

async function discovery(
  env: Env,
  db: Db,
  slug: string,
): Promise<Record<string, any>> {
  const product = (await loadProduct(env, db, slug))!;
  const res = await handleDiscovery(
    new Request(
      `https://key.plrs.im/${slug}/.well-known/polaris.json`,
    ) as unknown as Request,
    env,
    db,
    product,
    SERVICES,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

/** Every key path of a JSON value (array indexes collapsed), for the shape comparison. */
function shape(v: unknown, path = ""): string[] {
  if (Array.isArray(v))
    return [path, ...v.flatMap((x) => shape(x, `${path}[]`))];
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) =>
      shape(x, path ? `${path}.${k}` : k),
    );
  return [path];
}

describe("discovery and enforcement agree after a write (ST-04)", () => {
  it("has a probe for every live entry carried in discovery", () => {
    const carried = SETTINGS.entries
      .filter((e) => !e.pending && e.wire?.includes("discovery"))
      .map((e) => e.key)
      .sort();
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.filter((k) => !PROBES[k])).toEqual([]);
    // A probe names a carried entry, or one a parallel package is about to register.
    expect(
      Object.keys(PROBES).filter(
        (k) =>
          !carried.includes(k) && !(k in AHEAD_OF_REGISTRY && !registered(k)),
      ),
    ).toEqual([]);
  });

  for (const [key, probe] of Object.entries(PROBES))
    (registered(key) ? it : it.skip)(
      `${key}: published, resolved and enforced as the written value`,
      async () => {
        const db = makeTestDb();
        const env = makeEnv(new KvMock(), ["acme"]);
        await seedProduct(db, "acme");
        await db.run(
          "UPDATE products SET release_source = 'github' WHERE slug = 'acme'",
        );
        const before = await discovery(env, db, "acme");
        expect(probe.published(before)).not.toEqual(
          resolvedShape(key, probe.value),
        );

        const res = await writeSetting(
          { env, db, registry: SETTINGS },
          { key, value: probe.value },
          {
            actor: { sub: "u1", name: null, email: null },
            origin: "console",
            now: NOW,
            product: "acme",
            strict: false,
          },
        );
        expect(res.ok, JSON.stringify(res)).toBe(true);

        const after = await discovery(env, db, "acme");
        const resolved = await resolveProductSetting(
          { env, db, registry: SETTINGS },
          "acme",
          key,
        );
        const enforced = probe.enforced((await loadProduct(env, db, "acme"))!);
        const expected = resolvedShape(key, probe.value);
        expect(probe.published(after)).toEqual(expected);
        expect(resolvedShape(key, resolved!.value)).toEqual(expected);
        expect(enforced).toEqual(expected);

        // No wire effect: the document's shape is what it was (values only). A service turned on
        // publishes its own fragment, so `core.services` compares the core and top level only;
        // `core.endpoints.register` is advertised exactly when registration is not
        // `requires-license` (`core/discovery.ts`), a member the value decides, not a new shape.
        const coreShape = (doc: Record<string, any>) =>
          shape({ ...doc, services: Object.keys(doc.services) })
            .filter((p) => p !== "core.endpoints.register")
            .sort();
        expect(coreShape(after)).toEqual(coreShape(before));
      },
    );
});

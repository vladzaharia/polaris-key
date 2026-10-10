/**
 * Discovery and enforcement agree (ST-04, notes/S-18 §4.11): for EVERY live registry entry whose
 * value devices see in the discovery document (`wire: ["discovery", …]`), a write through
 * `writeSetting()` is published by `/.well-known/polaris.json`, answered by the resolver and read
 * by the enforcement path as the same value, at once. The discovery document's SHAPE does not
 * change (no wire effect: `gen transcripts --check` stays green).
 *
 * `PROBES` must name every such entry: a new discovery-carried setting fails here until it says
 * how discovery publishes it and which reader enforces it. A manifest-only entry has no console
 * write: its probe writes the storage as the manifest writer (link, resync) does, and the three
 * readers must still agree.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import {
  loadProduct,
  serializePresentation,
  type Product,
} from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { SERVICES, SETTINGS } from "../src/mount.js";
import { SERVICE_SLUGS } from "../src/core/services.js";
import { writeSetting } from "../src/core/settings/write.js";
import { resolveProductSetting } from "../src/core/settings/resolve.js";
import { getReleaseConfig } from "../src/services/release/config.js";
import { parseManualChannels } from "../src/services/release/channels.js";
import { setServices } from "../src/core/repo.js";
import { keyEntryLimit } from "../src/core/licensing/keyEntries.js";

interface Probe {
  /** A value to write that differs from the seeded product's. */
  value: unknown;
  /**
   * A manifest-only entry: write the storage as the manifest writer does (the console cannot).
   * Absent: the value is written through `writeSetting()`.
   */
  seed?(db: Db, slug: string): Promise<void>;
  /** The value as the discovery document publishes it. */
  published(doc: Record<string, any>): unknown;
  /** The value as the enforcement path reads it (the product the router loads, or its rows). */
  enforced(product: Product, db: Db): unknown;
  /** The resolver's value in the shape the probe compares (default: as is). */
  resolved?(value: unknown): unknown;
}

/** Release and Update on, with the release row link and resync write (`.pkey/release`). */
async function seedRelease(
  db: Db,
  slug: string,
  row: {
    owner?: string;
    repo?: string;
    binary?: string | null;
    manual?: string;
    sparkle?: string | null;
  },
): Promise<void> {
  await setServices(
    db,
    slug,
    JSON.stringify(
      servicesFrom((s) =>
        ["license", "config", "release", "update"].includes(s),
      ),
    ),
    "manifest",
    NOW,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    slug,
    row.owner ?? "acme-org",
    row.repo ?? "acme-app",
    42,
    "release.yml",
    "main",
    row.manual ?? "[]",
    row.binary ?? null,
    null,
    row.sparkle ?? null,
    "pkey:summary",
  );
}

/** The update channels a release row offers (`services/update/index.ts`). */
const channelsOf = (manualJson: string | null | undefined) => [
  "stable",
  "beta",
  "dev",
  ...parseManualChannels(manualJson).map((c) => c.name),
];

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

  // ── ST-19b's `.pkey/release` entries: manifest-only, written by link and resync ──────────
  "release.github": {
    value: { owner: "acme-org", name: "acme-app" },
    seed: (db, slug) => seedRelease(db, slug, {}),
    published: (doc) => doc.services.release.repository,
    enforced: async (p, db) => {
      const cfg = await getReleaseConfig(db, p.slug);
      return { owner: cfg?.gh_owner, name: cfg?.gh_repo };
    },
    resolved: (v) => {
      const r = v as { owner: string; repo: string };
      return { owner: r.owner, name: r.repo };
    },
  },
  "release.binaryName": {
    value: "acme-cli",
    seed: (db, slug) => seedRelease(db, slug, { binary: "acme-cli" }),
    published: (doc) => doc.services.release.binaryName,
    enforced: async (p, db) =>
      (await getReleaseConfig(db, p.slug))?.binary_name ?? p.slug,
  },
  "release.manualChannels": {
    value: ["stable", "beta", "dev", "nightly"],
    seed: (db, slug) =>
      seedRelease(db, slug, {
        manual: JSON.stringify([{ name: "nightly", regex: "^v.*-nightly$" }]),
      }),
    published: (doc) => doc.services.update.channels,
    enforced: async (p, db) =>
      channelsOf((await getReleaseConfig(db, p.slug))?.manual_channels_json),
    resolved: (v) => channelsOf(JSON.stringify(v)),
  },
  // HA-12: `.pkey/product` `presentation`, manifest-only in `products.presentation_json`. The
  // probe writes the column as link and resync do (`serializePresentation`); discovery publishes
  // the accent in `core.presentation`, and the router's product carries it.
  "core.presentation": {
    value: { accent: "#123456" },
    seed: async (db, slug) => {
      await db.run(
        "UPDATE products SET presentation_json = ? WHERE slug = ?",
        serializePresentation({ accent: "#123456" }),
        slug,
      );
    },
    published: (doc) => ({ accent: doc.core.presentation?.accent }),
    enforced: (p) => ({ accent: p.presentation?.accent }),
  },
  // I-09 (WIRE-CONTRACT-V4 §12.6): the Identity fragment's `keyEntryLimit` is the limit key entry
  // enforces (`core/licensing/keyEntries.ts` `keyEntryLimit()`). The probe turns Identity on and writes the
  // row the manifest's `identity.keyEntry.limit` seeds at link and resync.
  "identity.keyEntry.limit": {
    value: 7,
    seed: async (db, slug) => {
      await setServices(
        db,
        slug,
        JSON.stringify(
          servicesFrom((s) => ["license", "config", "identity"].includes(s)),
        ),
        "manifest",
        NOW,
      );
      await db.run(
        `INSERT INTO product_settings (product, key, value_json, source, updated_at, updated_by)
         VALUES (?, 'identity.keyEntry.limit', '7', 'manifest', ?, 'resync')`,
        slug,
        NOW,
      );
    },
    published: (doc) => doc.services.identity.keyEntryLimit,
    enforced: (p, db) =>
      keyEntryLimit(
        { env: makeEnv(new KvMock(), [p.slug]), db, registry: SETTINGS },
        p.slug,
      ),
  },
  "release.sparkleEd25519Pub": {
    value: "SPARKLEPUB",
    seed: (db, slug) => seedRelease(db, slug, { sparkle: "SPARKLEPUB" }),
    published: (doc) => doc.services.update.sparkleEd25519PublicKey,
    enforced: async (p, db) =>
      (await getReleaseConfig(db, p.slug))?.sparkle_ed25519_pub,
  },
};

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
    expect(Object.keys(PROBES).sort()).toEqual(carried);
  });

  for (const [key, probe] of Object.entries(PROBES))
    it(`${key}: published, resolved and enforced as the written value`, async () => {
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

      if (probe.seed) await probe.seed(db, "acme");
      else {
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
      }

      const after = await discovery(env, db, "acme");
      const resolved = await resolveProductSetting(
        { env, db, registry: SETTINGS },
        "acme",
        key,
      );
      const enforced = await probe.enforced(
        (await loadProduct(env, db, "acme"))!,
        db,
      );
      const expected = resolvedShape(key, probe.value);
      expect(probe.published(after)).toEqual(expected);
      expect(
        probe.resolved
          ? probe.resolved(resolved!.value)
          : resolvedShape(key, resolved!.value),
      ).toEqual(expected);
      expect(enforced).toEqual(expected);

      // No wire effect: the document's shape is what it was (values only). A service turned on
      // publishes its own fragment, so `core.services` compares the core and top level only;
      // `core.endpoints.register` is advertised exactly when registration is not
      // `requires-license` (`core/discovery.ts`), a member the value decides, not a new shape.
      // Likewise `core.presentation` (HA-12) is present exactly when something beyond the name
      // resolves (WIRE-CONTRACT-V4 §5.5): the value decides it.
      const coreShape = (doc: Record<string, any>) =>
        shape({ ...doc, services: Object.keys(doc.services) })
          .filter(
            (p) =>
              p !== "core.endpoints.register" &&
              !p.startsWith("core.presentation"),
          )
          .sort();
      expect(coreShape(after)).toEqual(coreShape(before));
    });
});

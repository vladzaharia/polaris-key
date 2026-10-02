/// <reference types="@cloudflare/workers-types" />
// ── Pack-set resolution on workerd (P4-12) ───────────────────────────────────────────────────
//
// The Node lane proves the resolver and its triggers. This proves the parts that depend on the
// runtime that ships: the resolver and client-core's `packSetId` (WebCrypto) inside the isolate,
// and the multi-row `release_sets` replacement (100 bound parameters per statement) in one D1
// batch, read back as the hook answers it.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import {
  PackResolver,
  type PackInput,
  type ResolutionInput,
} from "../src/services/release/packs/resolve.js";
import {
  readStoredSets,
  storeResolution,
  withSetIds,
} from "../src/services/release/packs/sets.js";
import { NOW, seedProduct } from "./seed.js";

const SLUG = "sets-w";

function input(): ResolutionInput {
  const platforms = ["android", "ios", "linux", "macos", "web", "windows"];
  const appReleases = new Map(
    [3, 4].map((level) => [
      `app@1.${level}.0`,
      {
        contentApi: level,
        builds: platforms.map((p) => ({ platform: p, engine: null })),
        packChannels: null,
        holds: [],
      },
    ]),
  );
  const packs: PackInput[] = ["w.foes", "w.l10n"].map((id, i) => ({
    id,
    binding: i === 0 ? "compatible" : "standalone",
    required: false,
    scheme: "semver",
    axes: (i === 1 ? { locale: ["en", "fr"] } : {}) as Record<string, string[]>,
    candidates: [1, 2, 3].map((n) => ({
      releaseId: `${id}@${n}.0.0`,
      version: `${n}.0.0`,
      seq: n,
      channel: null,
      prerelease: false,
      tag: null,
      builds: [],
    })),
    policies: new Map(),
    minSupported: new Map(),
    floors: new Map(),
    releases: new Map(
      [1, 2, 3].map((n) => [
        `${id}@${n}.0.0`,
        {
          releaseId: `${id}@${n}.0.0`,
          version: `${n}.0.0`,
          seq: n,
          recordSha256: String(n).repeat(64).slice(0, 64),
          variants: (i === 1 ? ["locale=en", "locale=fr"] : [""]).map(
            (variantKey) => ({
              variantKey,
              engine: null,
              contentApi: i === 0 ? { app: `>=${n + 1}` } : null,
              packs: null,
              conflicts: [],
            }),
          ),
        },
      ]),
    ),
  }));
  return {
    app: {
      scheme: "semver",
      candidates: [...appReleases.keys()].map((id, i) => ({
        releaseId: id,
        version: id.slice(4),
        seq: i + 1,
        channel: "stable",
        prerelease: false,
        tag: null,
        builds: platforms.map((p) => ({
          buildId: p,
          platform: p,
          arch: "any",
        })),
      })),
      policies: new Map(),
      minSupported: new Map(),
      manual: [],
      stableTagPattern: null,
      ignoreTags: new Set(),
      releases: appReleases,
    },
    packs,
    channels: ["stable", "beta"],
    yanked: new Set(),
  };
}

describe("pack-set resolution on workerd (P4-12)", () => {
  it("resolves, computes packSetIds and replaces release_sets in one guarded D1 batch", async () => {
    const db = new D1Db(env.DB);
    await seedProduct(env, db, SLUG, { schemaVersion: 1, entries: [] });
    const { sets } = new PackResolver(input()).resolve();
    // 2 channels × 2 levels × 6 platforms × (foes' row + 2 l10n locale rows).
    expect(sets).toHaveLength(72);
    const withIds = await withSetIds(sets);
    expect(
      await storeResolution(db, SLUG, { sets: withIds, generation: 0 }, NOW),
    ).toBe(true);
    const stable = await readStoredSets(db, SLUG, "stable");
    expect(stable).toHaveLength(36);
    const at = (level: number, variant: string) =>
      stable.find(
        (s) =>
          s.contentApi === level &&
          s.platform === "ios" &&
          s.variant === variant,
      )!;
    // foes n.0.0 supports contentApi ≥ n + 1: level 3 resolves 2.0.0, level 4 resolves 3.0.0.
    expect(at(3, "").packs.map((p) => [p.pack, p.version])).toEqual([
      ["w.foes", "2.0.0"],
    ]);
    expect(at(4, "").packs.map((p) => [p.pack, p.version])).toEqual([
      ["w.foes", "3.0.0"],
    ]);
    expect(at(3, "locale=fr").packs.map((p) => [p.pack, p.version])).toEqual([
      ["w.l10n", "3.0.0"],
    ]);
    expect(at(3, "").packSetId).toMatch(/^[0-9a-f]{64}$/);
    expect(at(3, "").packSetId).not.toBe(at(4, "").packSetId);
    // A write from the generation already moved past writes nothing.
    expect(
      await storeResolution(
        db,
        SLUG,
        { sets: withIds, generation: 0 },
        NOW + 1,
      ),
    ).toBe(false);
    expect(
      await storeResolution(
        db,
        SLUG,
        { sets: withIds, generation: 1 },
        NOW + 1,
      ),
    ).toBe(true);
    expect(await readStoredSets(db, SLUG, "stable")).toHaveLength(36);
  });
});

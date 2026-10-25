import { describe, expect, it } from "vitest";
import {
  distributionOutletIds,
  normalizeDistribution,
  outletListing,
  parseManifest,
  validateIngestDocuments,
} from "./index.js";

const product = {
  slug: "dice",
  name: "Dice",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
  },
};
const schema = { schemaVersion: 1, entries: [] };
const release = {
  release: {
    provider: { type: "github", owner: "acme", repo: "dice" },
    deliverables: {
      app: {
        kind: "app",
        artifacts: [
          {
            id: "apk",
            platform: "android",
            arch: "any",
            format: "apk",
            match: "Dice-*.apk",
          },
        ],
      },
    },
  },
};

function parse(distribution?: unknown, rel: unknown = release) {
  const files: Record<string, string> = {
    product: JSON.stringify(product),
    schema: JSON.stringify(schema),
    release: JSON.stringify(rel),
  };
  if (distribution !== undefined)
    files.distribution =
      typeof distribution === "string"
        ? distribution
        : JSON.stringify(distribution);
  return parseManifest(files);
}

describe("normalizeDistribution", () => {
  it("the absent document is one implicit direct outlet by pkey-cdn", () => {
    const d = normalizeDistribution(undefined);
    expect(d.declared).toBe(false);
    expect(d.outlets).toEqual([
      { id: "direct", kind: "direct", identity: {}, listing: null },
    ]);
    expect(d.routes).toEqual([
      {
        deliverableId: "app",
        outletId: "direct",
        transport: "pkey-cdn",
        origin: "default",
      },
    ]);
  });

  it("numeric ids become digit strings, foreign fields are dropped, ids are sorted", () => {
    const d = normalizeDistribution({
      outlets: {
        steam: { appId: 480, bundleId: "ignored.on.steam" },
        itch: { target: "a/b", gameId: 1001 },
        "app-store": { appleId: "123", bundleId: "gg.vlad.dice" },
      },
    });
    expect(d.outlets.map((o) => o.id)).toEqual(["app-store", "itch", "steam"]);
    expect(d.outlets.find((o) => o.id === "steam")!.identity).toEqual({
      appId: "480",
    });
    expect(d.outlets.find((o) => o.id === "itch")!.identity).toEqual({
      target: "a/b",
      gameId: "1001",
    });
  });

  it("resolves a transport per deliverable: override, then packs (packs only), then default", () => {
    const d = normalizeDistribution(
      {
        outlets: { "app-store": {}, play: {}, web: {} },
        transports: {
          default: "embedded",
          packs: { "app-store": "apple-ba", play: "play-pad" },
          deliverables: {
            app: { web: "web" },
            "dice.levels": { play: "embedded" },
          },
        },
      },
      [
        { id: "app", kind: "app" },
        { id: "dice.levels", kind: "pack" },
      ],
    );
    const t = (deliverable: string, outlet: string) =>
      d.routes.find(
        (r) => r.deliverableId === deliverable && r.outletId === outlet,
      )!.transport;
    expect(t("app", "app-store")).toBe("embedded");
    expect(t("app", "web")).toBe("web");
    expect(t("dice.levels", "app-store")).toBe("apple-ba");
    expect(t("dice.levels", "play")).toBe("embedded");
    expect(t("dice.levels", "web")).toBe("embedded");
    expect(d.routes).toHaveLength(6);
  });

  it("transports.packs: auto derives each pack's transport per outlet kind (P4-33)", () => {
    const d = normalizeDistribution(
      {
        outlets: {
          "app-store": {},
          testflight: {},
          steam: { appId: 480, depots: { "dice.levels": 481 } },
          "steam-beta": { kind: "steam", appId: 481 },
          play: {},
          itch: {},
          web: {},
        },
        transports: {
          default: "embedded",
          packs: "auto",
          deliverables: { "dice.levels": { itch: "embedded" } },
        },
      },
      [
        { id: "app", kind: "app" },
        { id: "dice.levels", kind: "pack" },
        { id: "dice.mods", kind: "pack" },
      ],
    );
    expect(d.transports.packs).toBe("auto");
    expect(d.outlets.find((o) => o.id === "steam")!.identity.depots).toEqual({
      "dice.levels": "481",
    });
    const r = (deliverable: string, outlet: string) => {
      const { transport, origin } = d.routes.find(
        (x) => x.deliverableId === deliverable && x.outletId === outlet,
      )!;
      return [transport, origin];
    };
    expect(r("dice.levels", "app-store")).toEqual(["apple-ba", "auto"]);
    expect(r("dice.levels", "testflight")).toEqual(["apple-ba", "auto"]);
    expect(r("dice.levels", "steam")).toEqual(["steam-depot", "auto"]);
    // A pack the outlet has no depot for goes by the CDN, as does another steam outlet.
    expect(r("dice.mods", "steam")).toEqual(["pkey-cdn", "auto"]);
    expect(r("dice.levels", "steam-beta")).toEqual(["pkey-cdn", "auto"]);
    // Never play-pad.
    expect(r("dice.levels", "play")).toEqual(["pkey-cdn", "auto"]);
    expect(r("dice.levels", "web")).toEqual(["pkey-cdn", "auto"]);
    // A deliverable override wins and is declared.
    expect(r("dice.levels", "itch")).toEqual(["embedded", "declared"]);
    // The app is untouched by packs: the default applies.
    expect(r("app", "app-store")).toEqual(["embedded", "default"]);
  });

  it("marks a route's origin: declared (override or packs map) or default (P4-33)", () => {
    const d = normalizeDistribution(
      {
        outlets: { "app-store": {}, web: {} },
        transports: { packs: { "app-store": "apple-ba" } },
      },
      [
        { id: "app", kind: "app" },
        { id: "dice.levels", kind: "pack" },
      ],
    );
    const origins = d.routes.map((x) => [
      x.deliverableId,
      x.outletId,
      x.origin,
    ]);
    expect(origins).toEqual([
      ["app", "app-store", "default"],
      ["app", "web", "default"],
      ["dice.levels", "app-store", "declared"],
      ["dice.levels", "web", "default"],
    ]);
  });

  it("never re-kinds an id that is itself a kind (outlet_kind_mismatch)", () => {
    const d = normalizeDistribution({
      outlets: {
        "app-store": { kind: "web" },
        steam: { kind: "direct" },
        play: { kind: "play" },
      },
    });
    // The mismatched entries are refused by the validator; normalising them anyway yields
    // nothing rather than a self-hosted outlet under a store's id.
    expect(d.outlets.map((o) => [o.id, o.kind])).toEqual([["play", "play"]]);
  });

  it("merges a per-outlet listing over the document's", () => {
    const d = normalizeDistribution({
      outlets: {
        altstore: {},
        "altstore-beta": { kind: "altstore", listing: { subtitle: "Beta" } },
      },
      listing: { name: "Dice", subtitle: "Roll" },
    });
    expect(outletListing(d, "altstore")).toEqual({
      name: "Dice",
      subtitle: "Roll",
    });
    expect(outletListing(d, "altstore-beta")).toEqual({
      name: "Dice",
      subtitle: "Beta",
    });
  });
});

describe("distributionOutletIds", () => {
  const d = normalizeDistribution({
    outlets: {
      direct: { homebrewCask: "dice", homebrewFormula: "dice-cli" },
      steam: { appId: 480 },
      "app-store": { appleId: "1234567890", bundleId: "gg.vlad.dice" },
      altstore: { artifact: "ipa", bundleId: "gg.vlad.dice.alt" },
      "steam-playtest": { kind: "steam", appId: "481" },
      itch: { target: "vlad/dice", gameId: 1001 },
      flathub: { appId: "gg.vlad.Dice" },
      snap: { name: "dice" },
      "ms-store": { packageFamilyName: "Vlad.Dice_abcdefghjkmnp" },
      "app-installer": { packageFamilyName: "Vlad.Dice_1a2b3c4d5e6f7" },
    },
  });

  it("maps every id to a string, keys sorted, msixFamilyName from the build's own entry", () => {
    const ids = distributionOutletIds(d, "ms-store")!;
    expect(JSON.stringify(ids)).toBe(
      JSON.stringify({
        bundleId: "gg.vlad.dice",
        caskToken: "dice",
        flatpakId: "gg.vlad.Dice",
        homebrewFormula: "dice-cli",
        itchGameId: "1001",
        msixFamilyName: "Vlad.Dice_abcdefghjkmnp",
        snapName: "dice",
        steamAppId: "480",
      }),
    );
    expect(distributionOutletIds(d, "app-installer")!.msixFamilyName).toBe(
      "Vlad.Dice_1a2b3c4d5e6f7",
    );
    expect(distributionOutletIds(d, "direct")!.msixFamilyName).toBeUndefined();
  });

  it("takes bundleId from the build's own Apple entry, else the first Apple entry (P3-11)", () => {
    expect(distributionOutletIds(d, "altstore")!.bundleId).toBe(
      "gg.vlad.dice.alt",
    );
    expect(distributionOutletIds(d, "app-store")!.bundleId).toBe(
      "gg.vlad.dice",
    );
    expect(distributionOutletIds(d, "steam")!.bundleId).toBe("gg.vlad.dice");
  });

  it("prefers the build's own entry for its kind", () => {
    expect(distributionOutletIds(d, "steam-playtest")!.steamAppId).toBe("481");
    expect(distributionOutletIds(d, "itch")!.steamAppId).toBe("480");
  });

  it("is null for an outlet the document does not declare", () => {
    expect(distributionOutletIds(d, "play")).toBeNull();
  });
});

describe("parseManifest and .pkey/distribution", () => {
  it("parses the document (YAML too) into ParsedManifest.distribution", () => {
    const res = parse(
      "outlets:\n  obtainium:\n    artifact: apk\n  steam:\n    appId: 480\n",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.distribution?.declared).toBe(true);
    expect(res.manifest.distribution?.outlets.map((o) => o.id)).toEqual([
      "obtainium",
      "steam",
    ]);
  });

  it("refuses an explicit kind that differs from a kind-named id", () => {
    const res = parse({ outlets: { "app-store": { kind: "web" } } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      expect.stringMatching(/^distribution\/outlets\/app-store\/kind: /),
    ]);
  });

  it("bounds the pack count, so pack spam cannot multiply rows (R10)", () => {
    const outlets: Record<string, unknown> = {};
    for (let i = 0; i < 32; i++) outlets[`web-${i}`] = { kind: "web" };
    const withPacks = (n: number) => {
      const packs: Record<string, unknown> = {};
      for (let i = 0; i < n; i++)
        packs[`pack-${i}`] = { kind: "pack", type: "files.tree" };
      return {
        release: {
          ...release.release,
          deliverables: {
            ...release.release.deliverables,
            app: {
              ...(release.release.deliverables as Record<string, any>).app,
              content: { contentApi: 1 },
            },
            ...packs,
          },
        },
      };
    };
    // 200 packs: refused outright (P4-02's `too_many_pack_deliverables`), one error.
    const spam = parse(
      {
        outlets,
        transports: { deliverables: { "pack-7": { "web-0": "web" } } },
      },
      withPacks(200),
    );
    expect(spam.ok).toBe(false);
    if (spam.ok) return;
    expect(spam.errors).toEqual([
      expect.stringContaining("at most 64 pack deliverables"),
    ]);
    // 64 packs: accepted, and every deliverable is routed (P4-05): (1 + 64) × 32 rows, with the
    // per-deliverable transport applied and the default elsewhere.
    const res = parse(
      {
        outlets,
        transports: { deliverables: { "pack-7": { "web-0": "web" } } },
      },
      withPacks(64),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const routes = res.manifest.distribution!.routes;
    expect(routes).toHaveLength(65 * 32);
    expect(routes.filter((r) => r.deliverableId === "app")).toHaveLength(32);
    expect(
      routes.find((r) => r.deliverableId === "pack-7" && r.outletId === "web-0")
        ?.transport,
    ).toBe("web");
  });

  it("carries the implicit document when Distribution is on and the file is absent", () => {
    const res = parse();
    expect(res.ok && res.manifest.distribution?.declared).toBe(false);
  });

  it("carries no distribution when the service is off and the file is absent", () => {
    const res = parseManifest({
      product: JSON.stringify({ slug: "dice", name: "Dice" }),
      schema: JSON.stringify(schema),
    });
    expect(res.ok && res.manifest.distribution).toBeUndefined();
  });

  it("reports distribution errors with the file name", () => {
    const res = parse({
      outlets: { steam: { capabilities: { codeUpdates: true } } },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      expect.stringMatching(/^distribution\/outlets\/steam\/capabilities: /),
    ]);
  });

  it("checks artifact refs against the release document's map", () => {
    const res = validateIngestDocuments({
      product,
      schema,
      release,
      distribution: { outlets: { altstore: { artifact: "ipa" } } },
    });
    expect(res.errors.map((e) => [e.file, e.code])).toEqual([
      ["distribution", "unknown_artifact_ref"],
    ]);
  });

  it("reads a direct outlet's own tap and bucket, and refuses the official ones (A-18i)", () => {
    const ok = validateIngestDocuments({
      product,
      schema,
      release,
      distribution: {
        outlets: {
          direct: {
            platforms: ["windows", "macos"],
            homebrewCask: "dice",
            homebrewTap: "vlad/homebrew-games",
            scoop: { bin: "Dice.exe" },
            scoopBucket: "vlad/scoop-games",
          },
        },
      },
    });
    expect(ok.errors).toEqual([]);
    expect(
      normalizeDistribution({
        outlets: {
          direct: {
            homebrewTap: "vlad/homebrew-games",
            scoopBucket: "vlad/scoop-games",
          },
        },
      }).outlets[0]!.identity,
    ).toEqual({
      homebrewTap: "vlad/homebrew-games",
      scoopBucket: "vlad/scoop-games",
    });
    for (const [homebrewTap, scoopBucket] of [
      ["Homebrew/homebrew-cask", "ScoopInstaller/Main"],
      ["homebrew/homebrew-core", "scoopinstaller/extras"],
      ["vlad/games", "vlad/.hidden"],
      ["vlad/homebrew-games/extra", "vlad"],
    ]) {
      const bad = validateIngestDocuments({
        product,
        schema,
        release,
        distribution: {
          outlets: {
            direct: { platforms: ["windows"], homebrewTap, scoopBucket },
          },
        },
      });
      expect(bad.errors.map((e) => [e.path, e.code])).toEqual([
        ["/outlets/direct/homebrewTap", "invalid_outlet_identity"],
        ["/outlets/direct/scoopBucket", "invalid_outlet_identity"],
      ]);
    }
  });

  it("validates transports.packs: auto and a steam outlet's depots (P4-33)", () => {
    const withPacks = {
      ...release,
      release: {
        ...release.release,
        deliverables: {
          ...release.release.deliverables,
          "dice.levels": { kind: "pack", type: "godot.pck" },
        },
      },
    };
    const run = (distribution: unknown) =>
      validateIngestDocuments({
        product,
        schema,
        release: withPacks,
        distribution,
      })
        .errors.filter((e) => /^\/(outlets|transports)\//.test(e.path))
        .map((e) => [e.path, e.code]);
    expect(
      run({
        outlets: { steam: { appId: 480, depots: { "dice.levels": "481" } } },
        transports: { packs: "auto" },
      }),
    ).toEqual([]);
    expect(run({ transports: { packs: "always" } })).toEqual([
      ["/transports/packs", "invalid_transport"],
    ]);
    expect(
      run({
        outlets: { steam: { appId: 480, depots: { "dice.levels": "x" } } },
      }),
    ).toEqual([["/outlets/steam/depots", "invalid_outlet_identity"]]);
    // The app is not a pack; an undeclared id is no deliverable at all.
    expect(
      run({
        outlets: { steam: { appId: 480, depots: { app: 1, "dice.nope": 2 } } },
      }),
    ).toEqual([
      ["/outlets/steam/depots/app", "unknown_deliverable_ref"],
      ["/outlets/steam/depots/dice.nope", "unknown_deliverable_ref"],
    ]);
  });

  it("reads a snap outlet's channels: declared channels onto snap channels (A-18h)", () => {
    const ok = validateIngestDocuments({
      product,
      schema,
      release,
      distribution: {
        outlets: {
          snap: {
            name: "dice",
            channels: { stable: "latest/stable", beta: "beta/hotfix-1" },
          },
        },
      },
    });
    expect(ok.errors).toEqual([]);
    expect(
      normalizeDistribution({
        outlets: { snap: { name: "dice", channels: { beta: "edge" } } },
      }).outlets[0]!.identity,
    ).toEqual({ name: "dice", channels: { beta: "edge" } });
    const bad = validateIngestDocuments({
      product,
      schema,
      release,
      distribution: {
        outlets: {
          snap: { name: "dice", channels: { stable: "production" } },
          "snap-2": { kind: "snap", channels: { nightly: "edge" } },
        },
      },
    });
    expect(bad.errors.map((e) => [e.path, e.code])).toEqual([
      ["/outlets/snap/channels", "invalid_outlet_identity"],
      ["/outlets/snap-2/channels/nightly", "unknown_channel_ref"],
    ]);
  });

  it("refuses an oversized distribution document before parsing it", () => {
    const res = parse(`# ${"x".repeat(70 * 1024)}\n`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0]).toMatch(/^distribution: larger than/);
  });
});

describe("the v4 move to @polaris-key/protocol (P3-02)", () => {
  it("re-exports OUTLET_KINDS and OUTLET_ID_PATTERN unchanged, as the same objects", async () => {
    const protocol = await import("@polaris-key/protocol/distribution");
    const manifest = await import("./index.js");
    expect(manifest.OUTLET_KINDS).toBe(protocol.OUTLET_KINDS);
    expect(manifest.OUTLET_ID_PATTERN).toBe(protocol.OUTLET_ID_PATTERN);
    expect([...manifest.OUTLET_KINDS]).toEqual([
      "direct",
      "app-store",
      "testflight",
      "altstore",
      "altstore-pal",
      "play",
      "play-testing",
      "obtainium",
      "fdroid-repo",
      "ms-store",
      "app-installer",
      "steam",
      "itch",
      "flathub",
      "snap",
      "winget",
      "web",
    ]);
  });

  it("the feed's version schemes equal the manifest's", async () => {
    const update = await import("@polaris-key/protocol/update");
    const manifest = await import("./index.js");
    expect([...update.FEED_VERSION_SCHEMES]).toEqual([
      ...manifest.VERSION_SCHEMES,
    ]);
  });
});

describe("package deliverables never get a transport (F-03, plans/F-01.md §3.3)", () => {
  it("routes skip a package, and a transport naming one is refused", () => {
    const releaseDoc = {
      release: {
        ghOwner: "acme",
        ghRepo: "desktop",
        binaryName: "acme",
        deliverables: {
          "npm.sdk": {
            kind: "package",
            ecosystem: "npm",
            name: "@acme/sdk",
            artifacts: { tarball: { match: "*.tgz" } },
          },
        },
      },
    };
    const base = {
      product: JSON.stringify({
        slug: "dice",
        name: "Dice",
        modules: {
          release: { enabled: true },
          distribution: { enabled: true },
        },
      }),
      schema: JSON.stringify(schema),
      release: JSON.stringify(releaseDoc),
    };
    const ok = parseManifest({
      ...base,
      distribution: JSON.stringify({ outlets: { web: { kind: "web" } } }),
    });
    expect(ok.ok ? [] : ok.errors).toEqual([]);
    if (!ok.ok) return;
    expect(
      ok.manifest.distribution!.routes.map((r) => r.deliverableId),
    ).not.toContain("npm.sdk");
    const refused = parseManifest({
      ...base,
      distribution: JSON.stringify({
        outlets: { web: { kind: "web" } },
        transports: { deliverables: { "npm.sdk": { web: "pkey-cdn" } } },
      }),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors.join("\n")).toContain(
      "packages are served only by package feeds",
    );
  });
});

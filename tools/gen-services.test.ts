import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TABLE_PATH,
  TARGETS,
  legacyModuleMap,
  loadTable,
  renderAdminTs,
  renderAll,
  renderDocsTs,
  renderGdscript,
  renderKotlin,
  kotlinCase,
  renderManifestTs,
  renderPython,
  renderSwift,
  run,
  swiftCase,
  validateTable,
  type ServiceRow,
  type ServiceTable,
} from "./gen-services.js";

const TABLE = loadTable();

function withRow(extra: Partial<ServiceRow> = {}): ServiceTable {
  return {
    features: TABLE.features,
    services: [
      ...TABLE.services,
      {
        slug: "telemetry",
        label: "Telemetry",
        summary: "A hypothetical ninth service.",
        defaultEnabled: false,
        requires: [],
        legacyModules: [],
        console: { accent: "telemetry", icon: "Activity", group: "commerce" },
        docs: "/docs/features/telemetry/",
        ...extra,
      },
    ],
  };
}

describe("tools/services.json", () => {
  it("is valid and lists the eight services in canonical order", () => {
    expect(validateTable(TABLE)).toEqual([]);
    expect(TABLE.services.map((r) => r.slug)).toEqual([
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
      "commerce",
    ]);
  });

  it("maps the legacy module vocabulary onto the services it always meant", () => {
    expect(Object.fromEntries(legacyModuleMap(TABLE))).toEqual({
      licensing: ["license"],
      edgeMint: ["config"],
      // P2b-01: the old module meant "this product distributes software", now three services.
      releases: ["release", "distribution", "update"],
      oidc: ["identity"],
    });
  });
});

describe("validateTable", () => {
  it("accepts a ninth row", () => {
    expect(validateTable(withRow())).toEqual([]);
  });

  it.each([
    [{ slug: "license" }, 'duplicate "license"'],
    [{ slug: "Bad_Slug" }, ".slug: must match"],
    [{ slug: "core", docs: "/docs/features/core/" }, '"core" is reserved'],
    [{ requires: ["nope"] }, 'unknown slug "nope"'],
    [{ requires: ["telemetry"] }, "cannot require itself"],
    [{ legacyModules: ["config"] }, "is a service slug"],
    [
      { console: { accent: "license", icon: "Boxes", group: "cloud-sync" } },
      'duplicate "license"',
    ],
    [
      {
        console: { accent: "distribution", icon: "Boxes", group: "cloud-sync" },
      },
      'duplicate "distribution"',
    ],
    [
      { console: { accent: "core", icon: "Boxes", group: "cloud-sync" } },
      "platform section",
    ],
    [
      { console: { accent: "tele", icon: "boxes", group: "cloud-sync" } },
      "lucide-react icon",
    ],
    [
      { console: { accent: "tele", icon: "Boxes", group: "nowhere" } },
      '"nowhere" is not a feature id',
    ],
    [
      { console: { accent: "tele", icon: "Boxes", group: "licensing" } },
      'the "licensing" feature\'s rows are not contiguous',
    ],
    [
      { docs: "/docs/services/telemetry/" },
      'must be a "/docs/features/<section>/" path',
    ],
    [{ defaultEnabled: "yes" as unknown as boolean }, "must be a boolean"],
    [{ label: "" }, ".label: must be a non-empty string"],
  ] as [Partial<ServiceRow>, string][])("rejects %j", (extra, message) => {
    const errors = validateTable(withRow(extra));
    expect(errors.join("\n")).toContain(message);
  });

  it("rejects a table that is not a table", () => {
    expect(validateTable(null)).not.toEqual([]);
    expect(validateTable({ features: [], services: [] })).toEqual([
      "the table has no services",
      "`features` must be a non-empty array",
    ]);
  });

  const withFeatures = (
    edit: (f: ServiceTable["features"]) => void,
  ): ServiceTable => {
    const features = structuredClone(TABLE.features);
    edit(features);
    return { ...TABLE, features };
  };

  it.each([
    [
      (f: ServiceTable["features"]) =>
        f.push({ id: "empty", label: "Empty", switches: [] }),
      'no service row names "empty"',
    ],
    [
      (f: ServiceTable["features"]) => (f[0]!.id = "managed-config"),
      'duplicate "managed-config"',
    ],
    [
      (f: ServiceTable["features"]) =>
        f[0]!.switches.push({
          id: "x",
          label: "X",
          kind: "service",
          service: "update",
        }),
      'a slug whose console.group is "licensing"',
    ],
    [
      (f: ServiceTable["features"]) =>
        f[0]!.switches.push({
          id: "y",
          label: "Y",
          kind: "service",
          service: "license",
        }),
      "the feature's switch writes nothing",
    ],
    [
      (f: ServiceTable["features"]) =>
        f[0]!.switches.push({ id: "packages", label: "P", kind: "setting" }),
      'duplicate "packages"',
    ],
    [
      (f: ServiceTable["features"]) =>
        f[0]!.switches.push({
          id: "z",
          label: "Z",
          kind: "fact",
          service: "license",
        }),
      'only a "service" switch names a slug',
    ],
    [(f: ServiceTable["features"]) => f.reverse(), "the order must match"],
  ] as [(f: ServiceTable["features"]) => void, string][])(
    "rejects a bad feature table (%#)",
    (edit, message) => {
      expect(validateTable(withFeatures(edit)).join("\n")).toContain(message);
    },
  );
});

describe("renderers", () => {
  it("carry the GENERATED banner on every target", async () => {
    for (const content of (await renderAll(TABLE)).values()) {
      expect(content).toMatch(
        /^(\/\/|#) GENERATED FILE — do not edit by hand\./,
      );
    }
  });

  it("a ninth row reaches every language", async () => {
    const table = withRow({
      requires: ["release"],
      legacyModules: ["beacons"],
    });
    const manifest = renderManifestTs(table);
    expect(manifest).toContain('"commerce" | "telemetry"');
    expect(manifest).toContain('"telemetry": ["release"]');
    expect(manifest).toContain('beacons: ["telemetry"]');
    expect(renderAdminTs(table)).toContain('accent: "telemetry"');
    expect(renderPython(table)).toContain(
      '("license", "config", "release", "distribution", "update", "identity", "sync", "commerce", "telemetry")',
    );
    expect(renderSwift(table)).toContain("    case telemetry\n");
    expect(renderSwift(table)).toContain(
      "case .release, .distribution, .update, .identity, .sync, .commerce, .telemetry: return false",
    );
    expect(renderGdscript(table)).toContain(
      'const SLUGS := ["license", "config", "release", "distribution", "update", "identity", "sync", "commerce", "telemetry"]',
    );
    expect(renderKotlin(table)).toContain(
      '    telemetry("telemetry", false),\n',
    );
  });

  it("the real table renders distribution between release and update (P2b-01)", () => {
    const manifest = renderManifestTs(TABLE);
    expect(manifest).toContain('"distribution": ["release"]');
    expect(manifest).toContain('"update": ["distribution"]');
    expect(manifest).toContain(
      'releases: ["release", "distribution", "update"]',
    );
    expect(renderSwift(TABLE)).toContain("    case distribution\n");
  });

  it("the features reach the console and the docs, and no SDK target", async () => {
    const admin = renderAdminTs(TABLE);
    expect(admin).toContain(
      '  {\n    id: "ship-builds",\n    label: "Ship builds",\n    accent: "release",\n    icon: "Package",\n    services: ["release", "distribution", "update"],\n    primary: ["release", "distribution"],',
    );
    expect(admin).toContain('group: "ship-builds",');
    expect(renderDocsTs(TABLE)).toContain(
      '"ship-builds": {\n    id: "ship-builds",\n    label: "Ship builds",\n    services: ["release", "distribution", "update"],\n    accent: "release",',
    );
    const rendered = await renderAll(TABLE);
    for (const [path, content] of rendered) {
      if (
        path.startsWith("packages/admin/") ||
        path.startsWith("packages/docs/")
      )
        continue;
      expect(content, path).not.toContain("ship-builds");
      expect(content, path).not.toContain("Ship builds");
    }
  });

  it("defaults are generated from defaultEnabled", () => {
    expect(renderManifestTs(TABLE)).toContain(
      'DEFAULT_ENABLED_SERVICES: readonly ServiceSlug[] = ["license", "config"]',
    );
    expect(renderPython(TABLE)).toContain(
      'DEFAULT_ENABLED_SERVICES: Tuple[str, ...] = ("license", "config")',
    );
    expect(renderSwift(TABLE)).toContain("case .license, .config: return true");
    expect(renderGdscript(TABLE)).toContain(
      'const DEFAULT_ENABLED := ["license", "config"]',
    );
    expect(renderKotlin(TABLE)).toContain('    license("license", true),\n');
    expect(renderKotlin(TABLE)).toContain('    release("release", false),\n');
  });

  it("names a hyphenated or keyword slug as a valid Kotlin enum entry (P6-06)", () => {
    expect(kotlinCase("content-packs")).toBe("contentPacks");
    expect(kotlinCase("object")).toBe("`object`");
    expect(
      renderKotlin(
        withRow({
          slug: "content-packs",
          docs: "/docs/features/content-packs/",
        }),
      ),
    ).toContain('    contentPacks("content-packs", false),');
  });

  it("names a hyphenated or keyword slug as a valid Swift case", () => {
    expect(swiftCase("content-packs")).toBe("contentPacks");
    expect(swiftCase("default")).toBe("`default`");
    expect(
      renderSwift(
        withRow({
          slug: "content-packs",
          docs: "/docs/features/content-packs/",
        }),
      ),
    ).toContain('case contentPacks = "content-packs"');
  });
});

describe("gen services --check", () => {
  it("the committed files are up to date", async () => {
    expect(await run({ check: true })).toEqual([]);
  });

  it("reports a hand edit to any generated file, and does not write under --check", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-services-"));
    const rendered = await renderAll(TABLE);
    for (const [path, content] of rendered) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    expect(await run({ check: true, root, table: TABLE })).toEqual([]);

    for (const target of TARGETS) {
      const abs = join(root, target.path);
      const original = readFileSync(abs, "utf8");
      writeFileSync(abs, original.replace("identity", "identiti"));
      expect(await run({ check: true, root, table: TABLE })).toEqual([
        target.path,
      ]);
      expect(readFileSync(abs, "utf8")).not.toBe(original);
      // Without --check the same call repairs it.
      expect(await run({ check: false, root, table: TABLE })).toEqual([
        target.path,
      ]);
      expect(readFileSync(abs, "utf8")).toBe(original);
    }
  }, 30_000);
});

describe("the service table, as the parity registry sees it", () => {
  it("conformance/parity/features.schema.json accepts every table slug as a feature's service", () => {
    // The registry may name a service ahead of its table row (as it named `distribution` before
    // P2b-01 added the row), so this is a subset check, not equality: a row the registry cannot name is what it catches.
    const schema = JSON.parse(
      readFileSync(
        join(
          dirname(TABLE_PATH),
          "..",
          "conformance",
          "parity",
          "features.schema.json",
        ),
        "utf8",
      ),
    ) as {
      $defs: Record<string, { properties?: { service?: { enum?: string[] } } }>;
    };
    const services = Object.values(schema.$defs).find(
      (d) => d.properties?.service?.enum,
    )?.properties?.service?.enum;
    expect(services).toBeDefined();
    for (const row of TABLE.services) {
      expect(
        services,
        `conformance/parity/features.schema.json's feature "service" enum is missing "${row.slug}"`,
      ).toContain(row.slug);
    }
  });
});

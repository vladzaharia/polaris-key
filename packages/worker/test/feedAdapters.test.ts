/**
 * THE FEED ADAPTER CONFORMANCE SUITE (`services/distribution/registry/adapter.ts`).
 *
 * Every package feed is one `FeedAdapter`, listed in `FEED_ADAPTERS`. This suite runs the same
 * checks against each, so a new feed that skips a piece of the contract fails CI here, not in
 * review. The checklist it enforces is `/docs/contribute/package-feeds/`:
 *
 *   1. REGISTERED: every manifest ecosystem (`PACKAGE_ECOSYSTEMS`) has exactly one adapter, and
 *      every adapter points at its ecosystem's ONE ingest declaration in `@polaris-key/manifest`.
 *   2. ROUTES THROUGH THE LADDER: every route is built by `feedRoute` (the `FEED_READ_ROUTE`
 *      mark), names Distribution and the adapter's ecosystem, and answers under `hostPrefix`.
 *   3. OPENAPI + ROUTECOVERAGE: every route has a row in `openapi`; every row is in the spec on the
 *      registry server with tag `registry`, and a sample of its path is matched by the route it
 *      names (`routeCoverage` reads the same rows as its registry table).
 *   4. STANDARD REFUSALS: on every route, an unknown owner and a feed that is off answer the
 *      host's one not-found byte for byte, and a non-public feed answers an anonymous client with
 *      the challenge the adapter declares.
 *   5. CAPABILITIES CONSISTENT: with the routes (search), the settings (`yankHidesFromIndex`,
 *      `requireSigned`), the access ladder (the challenge), the renders (channels) and the
 *      console's model (`admin/lib/feedModel.ts` exposes exactly the adapter's declaration).
 *   6. DETERMINISTIC RENDERS: a sample package renders non-empty, twice to the same bytes, under
 *      keys and types the host admits; a renderer stamped `package` ignores the feed settings.
 *   7. SETUP INPUTS: named clients, and only namespace keys the ingest rules declare.
 *   8. HARNESS: every client the adapter names is a `registry-clients/clients/<name>.sh` script
 *      and a row of its ecosystem in `.github/workflows/registry-clients.yml`; every client
 *      script there belongs to exactly one adapter (or is the host's `curl` smoke).
 *
 * A NEW ADAPTER ALSO ADDS its sample package (`SAMPLES`) and its path parameters (`PARAMS`) below:
 * without them the suite fails, by design.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import {
  FEED_READ_ROUTE,
  PYPI_HTML_TYPE,
  REGISTRY_HOST_TYPES,
  RESERVED_ECOSYSTEMS,
  dispatchRegistryHost,
  isRegistryEcosystem,
  registryEcosystemOf,
  registryNotFound,
} from "../src/core/registryHost.js";
import { REGISTRY_ROUTES, SERVICES } from "../src/mount.js";
import {
  DISTRIBUTION_REGISTRY_ROUTES,
  FEED_ADAPTERS,
  RENDERERS,
  feedAdapter,
  type FeedAdapter,
} from "../src/services/distribution/registry/index.js";
import { challengeFor } from "../src/services/distribution/registry/authorize.js";
import {
  isRenderKey,
  type PackageFile,
  type RegistryPackage,
  type RenderFeed,
  type RenderedObject,
} from "../src/services/distribution/registry/materialise.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import {
  ECOSYSTEM_LABELS,
  FEED_CAPABILITIES,
  feedBaseUrl,
  namespaceEmpty,
  parseExtPatch,
  parseNamespace,
  verbSupported,
} from "../src/admin/lib/feedModel.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..");
const REPO = join(WORKER, "..", "..");
const PKG = "https://pkg.example.test";
const OWNER = "acme";

const spec = parseYaml(
  readFileSync(join(WORKER, "openapi", "polaris-key.v3.yaml"), "utf8"),
) as { paths: Record<string, Record<string, unknown>> };
const workflow = parseYaml(
  readFileSync(
    join(REPO, ".github", "workflows", "registry-clients.yml"),
    "utf8",
  ),
) as {
  jobs: {
    client: {
      strategy: {
        matrix: { include: Array<{ client: string; ecosystem: string }> };
      };
    };
  };
};
const CLIENTS_DIR = join(WORKER, "scripts", "registry-clients", "clients");
/** The host's own smoke client: not an ecosystem's. */
const HOST_CLIENTS = ["curl"];

// ── Per-adapter test data (a new adapter adds its rows) ──────────────────────────────────────

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

function version(
  v: string,
  files: PackageFile[],
  metadata: Record<string, unknown>,
): RegistryPackage["versions"][number] {
  return {
    version: v,
    state: "live",
    stateMessage: null,
    files,
    metadata,
    publishedAt: NOW + (v === "1.0.0" ? 0 : 60),
  };
}

function pkg(
  ecosystem: PackageEcosystem,
  name: string,
  versions: RegistryPackage["versions"],
): RegistryPackage {
  return {
    product: OWNER,
    ecosystem,
    deliverableId: `${ecosystem}.sample`,
    name,
    nameNorm: PACKAGE_ECOSYSTEM_RULES[ecosystem].name.norm(name),
    versions,
    tags: { latest: "1.0.0" },
  };
}

const V = ["1.0.0", "1.1.0"];
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

/** One sample package per ecosystem, two live versions, `latest` on the first. */
const SAMPLES: Record<string, RegistryPackage> = {
  npm: pkg(
    "npm",
    "@acme/sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `sdk-${v}.tgz`,
            type: "npm-tarball",
            sha256: hex(`npm ${v}`),
            size: 100,
            sha512: createHash("sha512").update(v).digest("hex"),
            sha1: createHash("sha1").update(v).digest("hex"),
          },
        ],
        { name: "@acme/sdk", version: v, description: "Sample" },
      ),
    ),
  ),
  pypi: pkg(
    "pypi",
    "acme-sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `acme_sdk-${v}-py3-none-any.whl`,
            type: "wheel",
            sha256: hex(`whl ${v}`),
            size: 100,
          },
        ],
        { name: "acme-sdk", version: v, summary: "Sample" },
      ),
    ),
  ),
  swift: pkg(
    "swift",
    "acme.Sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `Sdk-${v}.zip`,
            type: "source-archive",
            sha256: hex(`zip ${v}`),
            size: 100,
          },
          {
            name: "Package.swift",
            type: "manifest",
            sha256: hex(`manifest ${v}`),
            size: 50,
          },
        ],
        { name: "acme.Sdk", version: v },
      ),
    ),
  ),
  maven: pkg(
    "maven",
    "com.acme:sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `sdk-${v}.jar`,
            type: "maven-file",
            sha256: hex(`jar ${v}`),
            size: 100,
            extension: "jar",
          },
          {
            name: `sdk-${v}.pom`,
            type: "maven-file",
            sha256: hex(`pom ${v}`),
            size: 50,
            extension: "pom",
          },
        ],
        {
          name: "com.acme:sdk",
          version: v,
          groupId: "com.acme",
          artifactId: "sdk",
          packaging: "jar",
        },
      ),
    ),
  ),
  oci: pkg(
    "oci",
    "app",
    V.map((v) =>
      version(
        v,
        [
          {
            name: "manifest.json",
            type: "oci-manifest",
            sha256: hex(`manifest ${v}`),
            size: 500,
            mediaType: OCI_MANIFEST,
          },
        ],
        {
          name: "app",
          version: v,
          mediaType: OCI_MANIFEST,
          root: `sha256:${hex(`manifest ${v}`)}`,
        },
      ),
    ),
  ),
  godot: pkg(
    "godot",
    "acme_tool",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `acme_tool-${v}.zip`,
            type: "godot-zip",
            sha256: hex(`godot ${v}`),
            size: 100,
          },
        ],
        {
          name: "acme_tool",
          version: v,
          displayName: "Acme Tool",
          author: "Acme",
          description: "Sample",
        },
      ),
    ),
  ),
};

/** Two feed-settings values a render can be given; a `package`-stamped renderer ignores both. */
const FEED_A: RenderFeed = { namespace: { publisher: "acme" }, ext: {} };
const FEED_B: RenderFeed = {
  namespace: { publisher: "acme" },
  ext: { supportLevel: "testing", license: "MIT" },
};

/** Sample values for the OpenAPI path parameters, per ecosystem where one differs. */
const COMMON_PARAMS: Record<string, string> = {
  owner: OWNER,
  sha256: "a".repeat(64),
  version: "1.0.0",
};
const PARAMS: Record<string, Record<string, string>> = {
  npm: {
    escapedName: "@acme%2fsdk",
    scope: "@acme",
    name: "sdk",
    tarball: "sdk-1.0.0.tgz",
  },
  pypi: { project: "acme-sdk", filename: "acme_sdk-1.0.0-py3-none-any.whl" },
  swift: { scope: "acme", name: "Sdk" },
  maven: {
    groupPath: "com/acme",
    artifactId: "sdk",
    checksum: "sha1",
    file: "sdk-1.0.0.jar",
  },
  oci: {
    repository: "app",
    reference: "latest",
    digest: `sha256:${"a".repeat(64)}`,
  },
  godot: { id: "1", publisher: "acme", asset: "acme_tool", file: "a.zip" },
};

/**
 * The query a protocol requires before any answer, keyed by OpenAPI path (Swift's identifiers:
 * without `url`, `finish` answers the protocol's 400 whatever the ladder said).
 */
const QUERIES: Record<string, string> = {
  "/swift/{owner}/identifiers": "?url=https://github.com/acme/sdk",
};

function sampleRequestPath(eco: string, template: string): string {
  return samplePath(eco, template) + (QUERIES[template] ?? "");
}

function samplePath(eco: string, template: string): string {
  return template.replace(/\{([A-Za-z0-9]+)\}/g, (_, name: string) => {
    const v = PARAMS[eco]?.[name] ?? COMMON_PARAMS[name];
    if (v === undefined)
      throw new Error(`${eco}: no sample value for {${name}} in ${template}`);
    return v;
  });
}

/** The rows of an adapter's own routes (not the dispatcher's fixed answers). */
const routeRows = (a: FeedAdapter) =>
  a.openapi.filter(([, , owner]) => owner !== "host");

async function render(
  a: FeedAdapter,
  p: RegistryPackage,
  feed: RenderFeed | null = FEED_A,
): Promise<readonly RenderedObject[]> {
  return a.renderer.render(p, { origin: PKG, feed });
}

/** A render as comparable text: every key, type and body, in key order. */
function asText(objects: readonly RenderedObject[]): string {
  return JSON.stringify(
    [...objects]
      .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      .map((o) => [
        o.key,
        o.contentType,
        typeof o.body === "string" ? o.body : [...o.body],
      ]),
  );
}

// ── 1. Registration ──────────────────────────────────────────────────────────────────────────

describe("feed adapters: registration", () => {
  it("every manifest ecosystem has exactly one adapter, and nothing else does", () => {
    const ecos = FEED_ADAPTERS.map((a) => a.ecosystem);
    expect(new Set(ecos).size, "one adapter per ecosystem").toBe(ecos.length);
    expect([...ecos].sort()).toEqual([...PACKAGE_ECOSYSTEMS].sort());
    for (const e of ecos) {
      expect(isRegistryEcosystem(e), e).toBe(true);
      expect(RESERVED_ECOSYSTEMS.has(e), e).toBe(false);
      expect(feedAdapter(e)?.ecosystem).toBe(e);
    }
  });

  it("the materialiser's renderers and the host's routes are derived from the adapters", () => {
    expect([...RENDERERS.keys()]).toEqual(
      FEED_ADAPTERS.map((a) => a.ecosystem),
    );
    for (const a of FEED_ADAPTERS) {
      expect(RENDERERS.get(a.ecosystem)?.stamp).toBe(a.renderer.stamp);
      expect(RENDERERS.get(a.ecosystem)?.routes).toBe(a.routes);
    }
    expect(DISTRIBUTION_REGISTRY_ROUTES).toEqual(
      FEED_ADAPTERS.flatMap((a) => a.routes),
    );
    for (const route of DISTRIBUTION_REGISTRY_ROUTES)
      expect(REGISTRY_ROUTES, route.name).toContain(route);
  });

  it("route names are unique across every feed", () => {
    const names = FEED_ADAPTERS.flatMap((a) => a.routes.map((r) => r.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("every adapter has its conformance samples (a new adapter adds them here)", () => {
    for (const a of FEED_ADAPTERS) {
      expect(SAMPLES[a.ecosystem], `${a.ecosystem}: SAMPLES`).toBeDefined();
      expect(PARAMS[a.ecosystem], `${a.ecosystem}: PARAMS`).toBeDefined();
    }
  });
});

// ── 2 to 8, per adapter ──────────────────────────────────────────────────────────────────────

describe.each(FEED_ADAPTERS.map((a) => [a.ecosystem, a] as const))(
  "feed adapter %s",
  (eco, a) => {
    it("points at its ecosystem's one ingest declaration", () => {
      expect(a.ingest).toBe(
        PACKAGE_ECOSYSTEM_RULES[eco as PackageEcosystem] as unknown,
      );
      expect(a.ingest.ecosystem).toBe(eco);
    });

    it("lives under its host prefix", () => {
      expect(a.hostPrefix.startsWith("/") && a.hostPrefix.endsWith("/")).toBe(
        true,
      );
      expect(registryEcosystemOf(`${a.hostPrefix}x`)).toBe(eco);
      expect(a.feedPath(OWNER).startsWith(a.hostPrefix)).toBe(true);
      for (const [path] of a.openapi)
        expect(path.startsWith(a.hostPrefix), path).toBe(true);
    });

    it("builds every route through the ladder (feedRoute)", () => {
      expect(a.routes.length).toBeGreaterThan(0);
      for (const r of a.routes) {
        expect(r[FEED_READ_ROUTE], `${r.name} is not built by feedRoute`).toBe(
          true,
        );
        expect(r.service, r.name).toBe("distribution");
        expect(r.ecosystem, r.name).toBe(eco);
      }
    });

    it("documents every route in OpenAPI, and each row's path reaches the route it names", () => {
      const names = new Set(a.routes.map((r) => r.name));
      const documented = new Set(routeRows(a).map(([, , o]) => o));
      for (const n of names)
        expect(documented.has(n), `route ${n} has no openapi row`).toBe(true);
      for (const [path, methods, owner] of a.openapi) {
        const entry = spec.paths[path];
        expect(entry, `${path} is not in the spec`).toBeDefined();
        expect(entry!.servers, path).toEqual([
          expect.objectContaining({ url: "https://pkg.plrs.im" }),
        ]);
        for (const m of methods)
          expect(
            (entry![m] as { tags?: string[] } | undefined)?.tags,
            `${m} ${path}`,
          ).toEqual(["registry"]);
        if (owner === "host") continue;
        expect(names.has(owner), `${path} names unknown route ${owner}`).toBe(
          true,
        );
        const sample = samplePath(eco, path);
        const first = a.routes.find((r) => r.match(sample) !== null);
        expect(first?.name, `${sample} (${path})`).toBe(owner);
        expect(first!.match(sample)!.owner).toBe(OWNER);
      }
    });

    describe("standard refusals", () => {
      let db: Db;
      let env: Env;

      beforeEach(async () => {
        forgetRegistrySettings();
        db = makeTestDb();
        env = makeEnv(new KvMock(), []);
        env.PKG_ORIGIN = PKG;
        env.BLOB_ORIGIN = "https://dl.example.test";
        await seedProduct(db, OWNER);
        await setServices(
          db,
          OWNER,
          serializeServices({
            services: {
              license: { enabled: true },
              config: { enabled: true },
              release: { enabled: true },
              distribution: { enabled: true },
              update: { enabled: false },
              identity: { enabled: false },
            },
          }),
          "manifest",
          NOW,
        );
      });

      const get = (path: string) =>
        dispatchRegistryHost(
          new Request(PKG + path),
          env,
          db,
          REGISTRY_ROUTES,
          SERVICES,
        );

      async function expectNotFound(res: Response, at: string) {
        const want = registryNotFound(eco as PackageEcosystem);
        expect(res.status, at).toBe(want.status);
        expect(res.headers.get("content-type"), at).toBe(
          want.headers.get("content-type"),
        );
        expect(await res.text(), at).toBe(await want.text());
      }

      it("an unknown owner and a feed that is off answer the host's one not-found", async () => {
        for (const [path, methods] of routeRows(a)) {
          if (!methods.includes("get")) continue;
          const sample = sampleRequestPath(eco, path);
          await expectNotFound(
            await get(sample.replace(`/${OWNER}/`, "/nobody/")),
            `unknown owner: ${sample}`,
          );
          // The owner exists with Distribution on, but has no packageFeeds and no feed row.
          await expectNotFound(await get(sample), `feed off: ${sample}`);
        }
      });

      it("a non-public feed answers an anonymous client with the declared challenge", async () => {
        await db.run(
          `INSERT INTO dist_registry_owners (product, enabled, version, updated_at, updated_by)
           VALUES (?, 1, 1, ?, 'test')`,
          OWNER,
          NOW,
        );
        await db.run(
          `INSERT INTO dist_registry_feeds
             (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes,
              upstream, claims_json, ext_json, version, updated_at, updated_by)
           VALUES (?, ?, 1, 'authenticated', '{}', 1024, 'none', '[]', '{}', 1, ?, 'test')`,
          OWNER,
          eco,
          NOW,
        );
        for (const [path, methods] of routeRows(a)) {
          if (!methods.includes("get")) continue;
          const sample = sampleRequestPath(eco, path);
          const res = await get(sample);
          expect(res.status, sample).toBe(401);
          const challenge = res.headers.get("www-authenticate") ?? "";
          expect(challenge, sample).toMatch(
            a.capabilities.authChallenge === "oci-bearer"
              ? /^Bearer realm="[^"]+\/v2\/token",service="[^"]+",scope="repository:acme\/[^"]+:pull"$/
              : /^Basic realm="[^"]+"$/,
          );
          expect(res.headers.get("cache-control"), sample).toContain(
            "no-store",
          );
        }
      });
    });

    it("declares every capability, consistently with its routes, settings and the ladder", () => {
      const c = a.capabilities;
      for (const key of [
        "yank",
        "deprecate",
        "yankPolicy",
        "signing",
        "immutableVersions",
        "delete",
        "search",
      ] as const)
        expect(typeof c[key], key).toBe("boolean");
      expect(["dist-tags", "tags", "latest", "none"]).toContain(c.channels);
      // A yank policy is a choice about what a yank does: no yank, no policy.
      if (c.yankPolicy) expect(c.yank).toBe(true);
      expect("yankHidesFromIndex" in a.settings.ext).toBe(c.yankPolicy);
      // Signing is enforced at ingest through the feed's `requireSigned` setting.
      expect("requireSigned" in a.settings.ext).toBe(c.signing);
      // Search is a route.
      expect(a.routes.some((r) => /search/i.test(r.name))).toBe(c.search);
      // Tier 1: a version is never deleted or rewritten through a feed; a yank changes state.
      expect(c.delete).toBe(false);
      expect(c.immutableVersions).toBe(true);
      // The challenge the console shows is the one the ladder sends.
      expect(challengeFor(eco as PackageEcosystem)).toBe(c.authChallenge);
    });

    it("is what the admin API and the console's model expose", () => {
      const e = eco as PackageEcosystem;
      expect(FEED_CAPABILITIES[e]).toBe(a.capabilities);
      expect(ECOSYSTEM_LABELS[e]).toBe(a.label);
      expect(feedBaseUrl(PKG, e, OWNER)).toBe(`${PKG}${a.feedPath(OWNER)}`);
      expect(feedBaseUrl(null, e, OWNER)).toBeNull();
      expect(verbSupported(e, "yank")).toBe(a.capabilities.yank);
      expect(verbSupported(e, "deprecate")).toBe(a.capabilities.deprecate);
      // Settings validation reads the adapter: its own ext keys pass, any other is refused.
      for (const key of Object.keys(a.settings.ext))
        expect(parseExtPatch(e, { [key]: null })).toEqual({
          ok: true,
          patch: { [key]: null },
        });
      expect(parseExtPatch(e, { notASetting: true })).toEqual({
        ok: false,
        key: "notASetting",
      });
      // ... and so does namespace validation, from the ingest rules' fields.
      const fields = Object.keys(a.ingest.namespace.fields);
      expect(parseNamespace(e, { notAKey: "x" })).toBeNull();
      expect(namespaceEmpty(e, {})).toBe(fields.length > 0);
    });

    it("renders its sample deterministically, under keys and types the host admits", async () => {
      const sample = SAMPLES[eco]!;
      const first = await render(a, sample);
      expect(first.length, "the sample renders nothing").toBeGreaterThan(0);
      expect(asText(await render(a, sample))).toBe(asText(first));
      const inert = a.routes.some((r) => r.inertDocument);
      for (const o of first) {
        expect(isRenderKey(o.key), o.key).toBe(true);
        const admitted =
          REGISTRY_HOST_TYPES.has(o.contentType) ||
          (inert && o.contentType === PYPI_HTML_TYPE);
        expect(admitted, `${o.key}: ${o.contentType}`).toBe(true);
      }
    });

    it("stamps exactly what its render reads", async () => {
      const sample = SAMPLES[eco]!;
      const same =
        asText(await render(a, sample, FEED_A)) ===
        asText(await render(a, sample, FEED_B));
      // A `package` stamp must not miss a settings change the documents show; a
      // `package+feed` stamp must be needed.
      expect(same, `stamp ${a.renderer.stamp}`).toBe(
        a.renderer.stamp === "package",
      );
    });

    it("surfaces channels as declared", async () => {
      const sample = SAMPLES[eco]!;
      const base = asText(await render(a, sample));
      const moved = asText(
        await render(a, { ...sample, tags: { latest: "1.1.0" } }),
      );
      const extra = asText(
        await render(a, {
          ...sample,
          tags: { latest: "1.0.0", beta: "1.1.0" },
        }),
      );
      if (a.capabilities.channels === "none") {
        expect(moved, "channels none, but latest shows").toBe(base);
        expect(extra, "channels none, but a tag shows").toBe(base);
      } else {
        expect(moved, `channels ${a.capabilities.channels}`).not.toBe(base);
      }
      if (a.capabilities.channels === "dist-tags")
        expect(extra, "every dist-tag shows").not.toBe(base);
      if (a.capabilities.channels === "latest")
        expect(extra, "only latest shows").toBe(base);
    });

    it("declares its setup inputs and clients", () => {
      expect(a.setup.clients.length).toBeGreaterThan(0);
      expect(
        a.setup.inputs.includes("baseUrl") ||
          a.setup.inputs.includes("registryHost"),
      ).toBe(true);
      for (const input of a.setup.inputs) {
        const ns = /^namespace\.(.+)$/.exec(input)?.[1];
        if (ns !== undefined)
          expect(
            Object.hasOwn(a.ingest.namespace.fields, ns),
            `${input} is not a namespace key of the ingest rules`,
          ).toBe(true);
      }
    });

    it("has its registry-clients harness clients, each a matrix row of its ecosystem", () => {
      expect(a.harness.clients.length).toBeGreaterThan(0);
      const rows = workflow.jobs.client.strategy.matrix.include;
      for (const client of a.harness.clients) {
        expect(
          existsSync(join(CLIENTS_DIR, `${client}.sh`)),
          `clients/${client}.sh`,
        ).toBe(true);
        expect(
          rows.some((r) => r.client === client && r.ecosystem === eco),
          `workflow row for ${client}`,
        ).toBe(true);
      }
    });
  },
);

describe("feed adapters: the harness", () => {
  it("every client script and matrix row belongs to exactly one adapter (or the host)", () => {
    const owned = new Map<string, string>();
    for (const a of FEED_ADAPTERS)
      for (const c of a.harness.clients) {
        expect(owned.has(c), `${c} claimed twice`).toBe(false);
        owned.set(c, a.ecosystem);
      }
    const rows = workflow.jobs.client.strategy.matrix.include;
    for (const r of rows) {
      if (HOST_CLIENTS.includes(r.client)) continue;
      expect(owned.get(r.client), `matrix row ${r.client}`).toBe(r.ecosystem);
    }
    for (const f of readdirSync(CLIENTS_DIR).filter((s) => s.endsWith(".sh"))) {
      const name = f.slice(0, -3);
      if (HOST_CLIENTS.includes(name)) continue;
      expect(owned.has(name), `clients/${f} belongs to no adapter`).toBe(true);
    }
  });
});

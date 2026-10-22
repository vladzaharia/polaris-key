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
 *      console's model (`console/lib/feedModel.ts` exposes exactly the adapter's declaration).
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  FEED_SETUP,
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  feedSetupBaseUrl,
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
} from "../src/core/registry/registryHost.js";
import {
  REGISTRY_OWNERLESS_ROUTES,
  REGISTRY_ROUTES,
  SERVICES,
} from "../src/mount.js";
import {
  DISTRIBUTION_REGISTRY_ROUTES,
  FEED_ADAPTERS,
  RENDERERS,
  feedAdapter,
  feedCapabilityView,
  type FeedAdapter,
} from "../src/services/distribution/registry/index.js";
import { FEED_OPS } from "../src/services/distribution/registry/adapter.js";
import { supports } from "../src/core/adapters/contract.js";
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
} from "../src/console/lib/feedModel.js";
import { serializeServices } from "../src/core/services.js";
import { setServices } from "../src/core/products/store.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import { mintCompat } from "./helpers/legacyOwnerToken.js";
import { asR2, R2Mock } from "./r2Mock.js";
import { envFor, seedReleaseProduct } from "./releaseRoutesFixture.js";
import { mintAccountToken } from "../src/core/accounts/personalTokens.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../src/services/identity/portal/repo.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { blobKey, recordObject } from "../src/core/assets/blobs.js";
import { PACKAGES_READ_SCOPE } from "../src/core/accounts/personalTokens.js";
import {
  forgetRegistryTokens,
  mintRegistryToken,
} from "../src/core/registry/registryTokens.js";
import { forgetLicenceHolds } from "../src/services/distribution/registry/authorize.js";
import { stmtUpsertDeliverable } from "../src/services/release/model.js";
import { ingestPackageDescriptor } from "../src/services/release/packages/ingest.js";

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
  cargo: pkg(
    "cargo",
    "acme-sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `acme-sdk-${v}.crate`,
            type: "crate",
            sha256: hex(`crate ${v}`),
            size: 100,
          },
        ],
        {
          name: "acme-sdk",
          version: v,
          deps: [{ name: "serde", req: "^1", kind: "normal", registry: null }],
          features: { default: ["std"], std: [] },
        },
      ),
    ),
  ),
  go: pkg(
    "go",
    "go.acme.dev/Sdk",
    V.map((v) =>
      version(
        v,
        [
          {
            name: `v${v}.zip`,
            type: "go-zip",
            sha256: hex(`go zip ${v}`),
            size: 100,
          },
          {
            name: "go.mod",
            type: "go-mod",
            sha256: hex(`go mod ${v}`),
            size: 30,
          },
        ],
        { name: "go.acme.dev/Sdk", version: v, h1: `h1:${v}` },
      ),
    ),
  ),
};

/** Two feed-settings values a render can be given; a `package`-stamped renderer ignores both. */
const FEED_A: RenderFeed = { namespace: { publisher: "acme" }, ext: {} };
const FEED_B: RenderFeed = {
  namespace: { publisher: "acme" },
  ext: {
    supportLevel: "testing",
    license: "MIT",
    yankHidesFromIndex: false,
  },
};

// B-097: Maven's metadata shows a yank only when the feed's switch is explicitly false (absent
// and true hide it), so its sample has one: FEED_A (absent) hides it, FEED_B (false) lists it.
Object.assign(SAMPLES.maven!.versions[1]!, { state: "yanked" });

/** Sample values for the OpenAPI path parameters, per ecosystem where one differs. */
const COMMON_PARAMS: Record<string, string> = {
  owner: OWNER,
  // F-21: Godot's tokenised URLs (`/t/{token}/`); a well-formed token nobody minted.
  token: `pkeyr_${"t".repeat(43)}`,
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
  cargo: {
    name: "acme-sdk",
    first: "a",
    prefix1: "ac",
    prefix2: "me",
    file: "acme-sdk-1.0.0.crate",
  },
  // The module path case-encoded as the go command sends it; a canonical version.
  go: { module: "go.acme.dev/!sdk", version: "v1.0.0" },
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

/** Every route name an adapter owns: reads, credential routes (F-21) and owner-less routes. */
const allRouteNames = (a: FeedAdapter): string[] => [
  ...a.routes.map((r) => r.name),
  ...(a.authRoutes ?? []).map((r) => r.name),
  ...(a.ownerlessRoutes ?? []).map((r) => r.name),
];

/** The rows of an adapter's own read routes (not the dispatcher's fixed answers, F-21's
 *  credential routes or its owner-less routes, which have suites of their own). */
const routeRows = (a: FeedAdapter) => {
  const reads = new Set(a.routes.map((r) => r.name));
  return a.openapi.filter(([, , owner]) => reads.has(owner));
};

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
    // Read routes, then F-21's credential routes; owner-less routes are their own list.
    expect(DISTRIBUTION_REGISTRY_ROUTES).toEqual(
      FEED_ADAPTERS.flatMap((a) => [...a.routes, ...(a.authRoutes ?? [])]),
    );
    for (const route of DISTRIBUTION_REGISTRY_ROUTES)
      expect(REGISTRY_ROUTES, route.name).toContain(route);
    expect(REGISTRY_OWNERLESS_ROUTES).toEqual(
      FEED_ADAPTERS.flatMap((a) => a.ownerlessRoutes ?? []),
    );
  });

  it("route names are unique across every feed", () => {
    const names = FEED_ADAPTERS.flatMap((a) => allRouteNames(a));
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
      const names = new Set(allRouteNames(a));
      const documented = new Set(a.openapi.map(([, , o]) => o));
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
        const ownerless = (a.ownerlessRoutes ?? []).find((r) =>
          r.matches(sample),
        );
        if (ownerless) {
          expect(ownerless.name, `${sample} (${path})`).toBe(owner);
          continue;
        }
        // A POST row reaches the credential route declaring it; a read row a read route.
        const pool = methods.includes("post")
          ? (a.authRoutes ?? []).filter((r) => r.methods?.includes("POST"))
          : a.routes;
        const first = pool.find((r) => r.match(sample) !== null);
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
              sync: { enabled: false },
              commerce: { enabled: false },
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

    it("extends the shared adapter base: id, one Support per operation, rate and limits", () => {
      expect(a.id).toBe(eco);
      const ops = a.capabilities.ops;
      expect(Object.keys(ops).sort()).toEqual([...FEED_OPS].sort());
      for (const op of FEED_OPS) {
        const s = ops[op];
        if (s.mode === "unsupported")
          expect(s.reason.length, `${op} needs a reason`).toBeGreaterThan(0);
        else expect(s.mode, op).toBe("api");
      }
      // Serving is the access ladder, and its rules are exactly the feed's routes.
      expect(ops.serve).toEqual({
        mode: "api",
        plane: "worker",
        rules: a.routes.map((r) => r.name),
      });
      expect(supports(a.capabilities, "render")).toBe(true);
      expect(ops.unyank).toEqual(ops.yank);
      // F-21: registry tokens, judged by the same ladder; the rules are the credential routes.
      expect(ops.auth).toEqual({
        mode: "api",
        plane: "worker",
        rules: [
          ...(a.authRoutes ?? []).map((r) => r.name),
          ...(a.ownerlessRoutes ?? []).map((r) => r.name),
        ],
      });
      expect(a.capabilities.rate).toEqual({ kind: "none" });
      expect(a.capabilities.limits).toEqual({
        maxFiles: a.ingest.maxFiles,
        maxNameLength: a.ingest.name.maxLength,
      });
    });

    it("declares every capability, consistently with its routes, settings and the ladder", () => {
      const c = feedCapabilityView(a);
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
      expect(FEED_CAPABILITIES[e]).toEqual(feedCapabilityView(a));
      expect(ECOSYSTEM_LABELS[e]).toBe(a.label);
      expect(feedBaseUrl(PKG, e, OWNER)).toBe(`${PKG}${a.feedPath(OWNER)}`);
      expect(feedBaseUrl(null, e, OWNER)).toBeNull();
      expect(verbSupported(e, "yank")).toBe(supports(a.capabilities, "yank"));
      expect(verbSupported(e, "deprecate")).toBe(
        supports(a.capabilities, "deprecate"),
      );
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
      // The one declaration in @polaris-key/manifest that renderFeedSetup (console and CLI) reads.
      expect(a.setup).toBe(FEED_SETUP[eco as PackageEcosystem]);
      expect(a.setup.feedPath(OWNER)).toBe(a.feedPath(OWNER));
      expect(
        feedSetupBaseUrl(eco as PackageEcosystem, PKG, OWNER),
        "the snippets' base URL is the admin API's",
      ).toBe(feedBaseUrl(PKG, eco as PackageEcosystem, OWNER));
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
      for (const c of [...a.harness.clients, ...(a.harness.local ?? [])]) {
        expect(owned.has(c), `${c} claimed twice`).toBe(false);
        owned.set(c, a.ecosystem);
      }
    const rows = workflow.jobs.client.strategy.matrix.include;
    for (const r of rows) {
      if (HOST_CLIENTS.includes(r.client)) continue;
      expect(owned.get(r.client), `matrix row ${r.client}`).toBe(r.ecosystem);
    }
    // A local-only client has its script and no matrix row (CI lacks its tool).
    for (const a of FEED_ADAPTERS)
      for (const c of a.harness.local ?? []) {
        expect(
          existsSync(join(CLIENTS_DIR, `${c}.sh`)),
          `clients/${c}.sh`,
        ).toBe(true);
        expect(
          rows.some((r) => r.client === c),
          `${c} is local-only but has a matrix row`,
        ).toBe(false);
      }
    for (const f of readdirSync(CLIENTS_DIR).filter((s) => s.endsWith(".sh"))) {
      const name = f.slice(0, -3);
      if (HOST_CLIENTS.includes(name)) continue;
      expect(owned.has(name), `clients/${f} belongs to no adapter`).toBe(true);
    }
  });
});

describe("maven yank policy default (B-097)", () => {
  it("hides a yanked version when the key is absent or true, lists it only for false", async () => {
    const a = FEED_ADAPTERS.find((x) => x.ecosystem === "maven")!;
    const sample = SAMPLES.maven!;
    const text = async (ext: Record<string, unknown>) =>
      asText(await render(a, sample, { namespace: {}, ext }));
    const absent = await text({});
    expect(absent).not.toContain("<version>1.1.0</version>");
    expect(await text({ yankHidesFromIndex: true })).toBe(absent);
    expect(await text({ yankHidesFromIndex: false })).toContain(
      "<version>1.1.0</version>",
    );
  });
});

// ── Owner-level list documents: a per-principal conformance pin (F-33b.5) ─────────────────────
//
// A list document runs the ladder with `deliverableId: () => null`, so only the feed's mode
// decides the request; the names it lists must then be filtered to what the PRESENTING principal
// may read, or one reader sees (and caches) packages another may not. Every route the adapters
// mark `listDocument: true` is run over the principals below against a feed holding one open and
// one `entitled` package.

const markedRoutes = FEED_ADAPTERS.flatMap((a) =>
  a.routes.filter((r) => r.listDocument).map((r) => ({ a, r })),
);

/** The routes that run the ladder with `deliverableId: () => null` but are not list documents
 *  because their body names no package. Each is checked by the matrix below; the list only
 *  shrinks. */
const NULL_DELIVERABLE_WITHOUT_NAMES: Record<string, string> = {
  "cargo.config":
    "config.json carries the download and API URLs only, never a crate name",
};

describe("feed adapters: list documents", () => {
  it("the marked routes are exactly the list documents of pypi, swift and godot", () => {
    expect(markedRoutes.map(({ r }) => r.name).sort()).toEqual(
      [
        "godotIndex",
        "godotLegacyConfigure",
        "godotLegacySearch",
        "godotStoreLicenses",
        "godotStoreOverview",
        "godotStoreSearch",
        "godotStoreTags",
        "pypi.simple.index",
        "swift.identifiers",
      ].sort(),
    );
  });

  it("every route that answers a null deliverable is marked, or named as carrying no package name", () => {
    const routesDir = join(
      WORKER,
      "src",
      "services",
      "distribution",
      "registry",
    );
    const nullRoutes: Array<{ eco: string; file: string; count: number }> = [];
    for (const a of FEED_ADAPTERS) {
      const file = join(routesDir, a.ecosystem, "routes.ts");
      const src = readFileSync(file, "utf8");
      const count = src.split("deliverableId: () => null").length - 1;
      if (count > 0) nullRoutes.push({ eco: a.ecosystem, file, count });
    }
    // Every adapter that answers a null deliverable owns at least one marked route or one named
    // exception (a new unmarked list document in a fresh adapter fails here).
    for (const { eco } of nullRoutes) {
      const marked = markedRoutes.filter(({ a }) => a.ecosystem === eco);
      const named = Object.keys(NULL_DELIVERABLE_WITHOUT_NAMES).filter((n) =>
        n.startsWith(`${eco}.`),
      );
      expect(
        marked.length + named.length,
        `${eco} answers a null deliverable but marks no list document`,
      ).toBeGreaterThan(0);
    }
    // Godot builds all of its list routes through one helper (`listRoute`): every call is marked.
    const godot = readFileSync(join(routesDir, "godot", "routes.ts"), "utf8");
    const calls = (godot.match(/\n {2}listRoute\(/g) ?? []).length;
    expect(
      markedRoutes.filter(({ a }) => a.ecosystem === "godot"),
    ).toHaveLength(calls);
    // Within an adapter the unmarked null routes are only the named ones, and each name exists.
    for (const name of Object.keys(NULL_DELIVERABLE_WITHOUT_NAMES)) {
      const route = FEED_ADAPTERS.flatMap((a) => a.routes).find(
        (r) => r.name === name,
      );
      expect(route, `${name} no longer exists: delete its entry`).toBeDefined();
      expect(route!.listDocument, `${name} is marked: delete its entry`).toBe(
        undefined,
      );
    }
    const pypi = nullRoutes.find((n) => n.eco === "pypi");
    expect(pypi?.count).toBe(1);
    const unmarkedPypi = FEED_ADAPTERS.find(
      (a) => a.ecosystem === "pypi",
    )!.routes.filter((r) => !r.listDocument && r.name === "pypi.simple.index");
    expect(unmarkedPypi).toEqual([]);
    const cargo = nullRoutes.find((n) => n.eco === "cargo");
    expect(cargo?.count).toBe(1);
  });
});

const LIST_PKG = "https://pkg.example.test";
const LIST_KEY = "registry-token-key-for-tests";
const OPEN = "zzopen";
const GATED = "zzgated";
/** The names each ecosystem's two packages go by (matched case-insensitively in a body). */
const LIST_NAMES: Record<string, { open: string; gated: string }> = {
  pypi: { open: `${OPEN}-sdk`, gated: `${GATED}-sdk` },
  swift: { open: `acme.${OPEN}`, gated: `acme.${GATED}` },
  godot: { open: `${OPEN}_addon`, gated: `${GATED}_addon` },
};
const SWIFT_URL = "https://github.com/acme/sdk";

interface ListWorld {
  db: Db;
  env: Env;
  tokens: Record<string, string | null>;
}

const lw = {} as ListWorld;

async function listBlob(r2: R2Mock, data: Uint8Array): Promise<string> {
  const digest = hex(new TextDecoder().decode(data));
  await r2.put(blobKey(digest), data, { sha256: digest });
  await recordObject(
    lw.db,
    {
      storageKey: blobKey(digest),
      sha256: digest,
      size: data.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  return digest;
}

async function setListFeeds(mode: "public" | "licensed"): Promise<void> {
  const rows: Array<[string, object, object]> = [
    ["pypi", { prefixes: [OPEN, GATED] }, {}],
    [
      "swift",
      { scope: "acme" },
      {
        repositoryUrls: {
          [LIST_NAMES.swift!.open]: [SWIFT_URL],
          [LIST_NAMES.swift!.gated]: [SWIFT_URL],
        },
      },
    ],
    [
      "godot",
      { publisher: "acme" },
      { categoryId: "6", license: "MIT", minGodotVersion: "4.4" },
    ],
  ];
  for (const [eco, namespace, ext] of rows)
    await lw.db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json,
         max_package_bytes, ext_json, updated_at)
       VALUES (?, ?, 1, ?, ?, 52428800, ?, ?)
       ON CONFLICT(product, ecosystem) DO UPDATE SET access_mode = excluded.access_mode`,
      OWNER,
      eco,
      mode,
      JSON.stringify(namespace),
      JSON.stringify(ext),
      NOW,
    );
  forgetRegistrySettings();
}

/** Two packages per ecosystem: `<eco>.open` (the feed's mode) and `<eco>.gated` (`entitled`,
 *  needing the `pro` flag), published through Release's real package ingest. */
async function seedListWorld(): Promise<void> {
  lw.db = makeTestDb();
  lw.env = envFor({ kv: new KvMock() });
  lw.env.KEY_HASH_PEPPER = "pepper";
  lw.env.PKG_ORIGIN = LIST_PKG;
  lw.env.REGISTRY_TOKEN_KEY = LIST_KEY;
  const r2 = new R2Mock();
  lw.env.BLOBS = asR2(r2);
  await seedReleaseProduct(lw.db, {}, OWNER);
  await lw.db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    OWNER,
    NOW,
  );
  await setListFeeds("licensed");
  for (const [eco, names] of Object.entries(LIST_NAMES))
    for (const [kind, name] of Object.entries(names)) {
      const id = `${eco}.${kind}`;
      const artifacts =
        eco === "pypi"
          ? { wheel: { match: "*.whl" } }
          : eco === "godot"
            ? { zip: { match: "*.zip" } }
            : { "source-archive": { match: "*.zip" } };
      const st = stmtUpsertDeliverable(
        {
          product: OWNER,
          deliverableId: id,
          kind: "package",
          defJson: JSON.stringify({
            kind: "package",
            id,
            ecosystem: eco,
            name,
            artifacts,
          }),
          ecosystem: eco,
          packageName: name,
        },
        NOW,
      );
      await lw.db.run(st.sql, ...st.params);
      if (kind === "gated")
        await lw.db.run(
          `INSERT INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
           VALUES (?, ?, 'entitled', 'pro', 'admin', ?)`,
          OWNER,
          id,
          NOW,
        );
      if (eco === "swift") continue; // the identifiers route reads only the deliverables
      const bytes = new TextEncoder().encode(`${eco} ${name} 1.0.0`);
      const sha = await listBlob(r2, bytes);
      const file =
        eco === "pypi"
          ? {
              name: `${name.replace(/-/g, "_")}-1.0.0-py3-none-any.whl`,
              type: "wheel",
            }
          : { name: `${name}-1.0.0.zip`, type: "godot-zip" };
      const res = await ingestPackageDescriptor(
        lw.db,
        lw.env,
        OWNER,
        {
          descriptorVersion: 1,
          product: OWNER,
          deliverable: id,
          kind: "package",
          version: "1.0.0",
          channel: "stable",
          package: {
            ecosystem: eco,
            name,
            files: [
              {
                ...file,
                role: "payload",
                sha256: sha,
                size: bytes.length,
                locations: [{ provider: "r2", key: blobKey(sha) }],
              },
            ],
            metadata:
              eco === "pypi"
                ? { name, version: "1.0.0" }
                : {
                    name,
                    version: "1.0.0",
                    displayName: name,
                    author: "Acme",
                    description: "Sample",
                  },
          },
        },
        {
          now: NOW,
          promoted: [blobKey(sha)],
          feed: {
            ecosystem: eco,
            enabled: true,
            ownerEnabled: true,
            policyEnabled: true,
            namespace:
              eco === "pypi"
                ? { prefixes: [OPEN, GATED] }
                : { publisher: "acme" },
            maxPackageBytes: 52428800,
            ext: {},
          },
          source: { kind: "static" },
          digests: async () => new Map(),
        } as never,
      );
      expect(res.ok, JSON.stringify(res)).toBe(true);
    }
}

async function seedListPrincipals(): Promise<void> {
  const { db, env } = lw;
  const person = async (email: string, withFlag: boolean) => {
    const acct = (await getOrCreateAccountByEmail(db, email, NOW)).id;
    const { licenseId } = await seedLicenseWithKey(db, OWNER, {
      id: `lic_${withFlag ? "pro" : "plain"}`,
      ...(withFlag
        ? {
            entitlements: {
              pro: { state: "enforced", value: true, updatedAt: NOW },
            },
          }
        : {}),
    });
    await linkLicense(db, acct, OWNER, licenseId, "admin", NOW);
    await db.run(
      "UPDATE licenses SET account_id = ? WHERE product = ? AND id = ?",
      acct,
      OWNER,
      licenseId,
    );
    const res = await mintAccountToken(
      env,
      db,
      {
        accountId: acct,
        label: "laptop",
        scope: PACKAGES_READ_SCOPE,
        createdBy: `portal:${acct}`,
      },
      NOW,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    return { token: res.token, licenseId };
  };
  const plain = await person("plain@example.com", false);
  const pro = await person("pro@example.com", true);
  const bound = await mintRegistryToken(
    env,
    db,
    {
      product: OWNER,
      label: "bound",
      binding: "license",
      licenseId: plain.licenseId,
      createdBy: "admin:test",
    },
    NOW,
  );
  if (!bound.ok) throw new Error(JSON.stringify(bound));
  const legacy = await mintCompat(
    env,
    db,
    {
      product: OWNER,
      label: "legacy",
      binding: "owner",
      createdBy: "admin:test",
    },
    NOW,
  );
  if (!legacy.ok) throw new Error(JSON.stringify(legacy));
  const ci = (scopes: string[]) =>
    issueStaticCiToken(env, db, {
      product: OWNER,
      scopes,
      expiresAt: NOW + 3600,
      label: null,
      createdBy: "u1",
      now: NOW,
    }).then((t) => t.token);
  lw.tokens = {
    anonymous: null,
    "person, usable licence, no flag": plain.token,
    "person, usable licence, holds the flag": pro.token,
    "licence-bound pkeyr_, no flag": bound.token,
    "legacy owner pkeyr_": legacy.token,
    "pkeyci_ packages:read": await ci(["packages:read"]),
    "pkeyci_ without a read scope": await ci(["distribution:report"]),
  };
  forgetRegistryTokens();
}

describe("feed adapters: what a list document names (per principal)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    forgetRegistrySettings();
    forgetRegistryTokens();
    forgetLicenceHolds();
    await seedListWorld();
    await seedListPrincipals();
  });
  afterEach(() => vi.useRealTimers());

  /** Which of an ecosystem's two package names a response body mentions. */
  async function listed(
    eco: string,
    res: Response,
  ): Promise<{ status: number; names: string[] }> {
    const body = (await res.text()).toLowerCase();
    const n = LIST_NAMES[eco]!;
    const names = (["open", "gated"] as const).filter((k) =>
      body.includes(n[k].toLowerCase()),
    );
    return { status: res.status, names };
  }

  function pathOf(a: FeedAdapter, route: string): string {
    const row = a.openapi.find(
      ([path, , owner]) => owner === route && !path.includes("{token}"),
    );
    if (!row) throw new Error(`${route}: no tokenless openapi row`);
    return sampleRequestPath(a.ecosystem, row[0]);
  }

  async function read(
    a: FeedAdapter,
    route: string,
    token: string | null,
  ): Promise<{ status: number; names: string[] }> {
    const res = await dispatchRegistryHost(
      new Request(`${LIST_PKG}${pathOf(a, route)}`, {
        headers: {
          accept: "application/vnd.pypi.simple.v1+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
      lw.env,
      lw.db,
      REGISTRY_ROUTES,
      SERVICES,
      undefined,
      REGISTRY_OWNERLESS_ROUTES,
    );
    return listed(a.ecosystem, res);
  }

  const REFUSED = ["anonymous", "pkeyci_ without a read scope"] as const;
  const OPEN_ONLY = [
    "person, usable licence, no flag",
    "licence-bound pkeyr_, no flag",
  ] as const;
  const ALL = [
    "person, usable licence, holds the flag",
    "legacy owner pkeyr_",
    "pkeyci_ packages:read",
  ] as const;

  /** The routes that name packages at all, per route: what the full reader (`pro`) sees. */
  async function fullView(a: FeedAdapter, route: string): Promise<string[]> {
    const got = await read(
      a,
      route,
      lw.tokens["person, usable licence, holds the flag"]!,
    );
    expect(got.status, route).toBe(200);
    return got.names;
  }

  it("on a licensed feed each principal sees only the packages it may read", async () => {
    const naming = new Set<string>();
    for (const { a, r } of markedRoutes) {
      if (LIST_NAMES[a.ecosystem] === undefined)
        throw new Error(`${r.name}: add ${a.ecosystem} to the list world`);
      const full = await fullView(a, r.name);
      // A list that names packages names both to the reader who holds the flag.
      if (full.length > 0) {
        expect(full, r.name).toEqual(["open", "gated"]);
        naming.add(a.ecosystem);
      }
      const at = (who: string) => read(a, r.name, lw.tokens[who] ?? null);
      for (const who of REFUSED) {
        // No credential, or a CI token with no read scope (anonymous): refused, nothing named.
        const got = await at(who);
        expect(got.names, `${r.name} / ${who}`).toEqual([]);
        expect(got.status, `${r.name} / ${who}`).not.toBe(200);
      }
      for (const who of OPEN_ONLY) {
        const got = await at(who);
        expect(got.status, `${r.name} / ${who}`).toBe(200);
        expect(got.names, `${r.name} / ${who}`).toEqual(
          full.length > 0 ? ["open"] : [],
        );
      }
      for (const who of ALL) {
        const got = await at(who);
        expect(got.status, `${r.name} / ${who}`).toBe(200);
        expect(got.names, `${r.name} / ${who}`).toEqual(full);
      }
    }
    // The pin is not vacuous: every ecosystem with a marked route has one that names packages.
    expect([...naming].sort()).toEqual(["godot", "pypi", "swift"]);
  });

  it("on a public feed every principal, anonymous included, sees only what is public", async () => {
    const naming = new Set<string>();
    for (const { a, r } of markedRoutes)
      if ((await fullView(a, r.name)).length > 0) naming.add(r.name);
    await setListFeeds("public");
    for (const { a, r } of markedRoutes)
      for (const who of Object.keys(lw.tokens)) {
        const got = await read(a, r.name, lw.tokens[who] ?? null);
        expect(got.status, `${r.name} / ${who}`).toBe(200);
        // The answer is public-cached for every reader, so the entitled package is in none of
        // them, whoever asked (a swift list once named it for a credentialed reader).
        expect(got.names, `${r.name} / ${who}`).toEqual(
          naming.has(r.name) ? ["open"] : [],
        );
      }
    expect(naming.size).toBeGreaterThan(0);
  });
});

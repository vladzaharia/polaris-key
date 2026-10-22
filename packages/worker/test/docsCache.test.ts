// LK-09 (docs plan §3.1 "Caching"): only tier-public docs files are shared-cacheable, on either
// host; every gated response stays no-store (HTML, redirects, refusals) or private (assets). Also
// the Help `/docs/help/code/<id>/` redirect pages as the customer host serves them, and the
// customer host's robots.txt and Help sitemap.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../src/dispatch.js";
import {
  DOCS_PUBLIC_HTML_CACHE,
  DOCS_TIERS,
  docsCacheControl,
  docsTierOf,
} from "../src/docs.js";
import { DOCS_ASSET_TIERS } from "../src/docsTiers.generated.js";
import { ADMIN_COOKIE } from "../src/core/console/session.js";
import type { Env } from "../src/platform/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { consoleTestSession } from "./consoleSessionHelper.js";

const API = "https://key.plrs.im";
const CUSTOMER = "https://polaris.locker";
const dist = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "dist",
);

const FILES: Record<string, string> = {
  "/docs/help/index.html": "<html>help home</html>",
  "/docs/help/activate/index.html": "<html>help activate</html>",
  "/docs/start/index.html": "<html>start</html>",
  "/docs/operate/console/members/index.html": "<html>members</html>",
  "/docs/contribute/index.html": "<html>contribute</html>",
  "/docs/_astro/app.abc.css": "body{}",
  "/docs/pagefind/pagefind.js": "export{}",
  "/docs/pagefind/index/en_a.pf_index": "shard",
  "/docs/pagefind-member/index/en_m1.pf_index": "shard",
  "/docs/pagefind-help/index/en_h.pf_index": "shard",
  "/docs/pagefind-admin/pagefind.js": "export{}",
  "/docs/sitemap-help.xml": "<urlset/>",
  "/docs/404.html": "<html>404</html>",
};
for (const path of Object.keys(DOCS_ASSET_TIERS)) FILES[path] = "gated";

const shared = (cc: string | null): boolean =>
  /\bpublic\b/.test(cc ?? "") || /s-maxage/.test(cc ?? "");

describe("docsCacheControl", () => {
  it("is shared-cacheable only for the public tier, whole 200s only", () => {
    expect(docsCacheControl("/docs/help/x/index.html", "public", 200)).toBe(
      DOCS_PUBLIC_HTML_CACHE,
    );
    expect(docsCacheControl("/docs/_astro/a.css", "public", 200)).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(docsCacheControl("/docs/pagefind/pagefind.js", "public", 200)).toBe(
      "public, no-cache",
    );
    expect(docsCacheControl("/docs/help/x/index.html", "public", 404)).toBe(
      "no-store",
    );
    // A range answer is partial content: never shared, not even for a public immutable asset.
    expect(docsCacheControl("/docs/_astro/a.css", "public", 206)).toBe(
      "no-store",
    );
    for (const tier of ["member", "admin"] as const) {
      expect(docsCacheControl("/docs/x/index.html", tier, 200)).toBe(
        "no-store",
      );
      expect(docsCacheControl("/docs/_astro/a.css", tier, 200)).toBe(
        "private, max-age=31536000, immutable",
      );
      expect(docsCacheControl("/docs/x.json", tier, 200)).toBe(
        "private, no-cache",
      );
    }
  });

  it("never says public for any path the tier table does not call public", () => {
    const paths = [
      ...DOCS_TIERS.map(([p]) => (p.endsWith("/") ? `${p}x.html` : p)),
      ...Object.keys(DOCS_ASSET_TIERS),
    ];
    for (const p of paths) {
      const tier = docsTierOf(p);
      const cc = docsCacheControl(p, tier, 200);
      if (tier !== "public") expect(shared(cc), `${p}: ${cc}`).toBe(false);
    }
  });
});

describe("docs cache headers through the Worker, on both hosts", () => {
  let db: SqliteDb;
  let env: Env;
  beforeEach(() => {
    db = makeTestDb();
    env = makeEnv(new KvMock(), []);
    env.CONSOLE_ORIGIN = API;
    env.CUSTOMER_ORIGIN = CUSTOMER;
    env.ADMIN_SESSION_SECRET = "docs-cache-secret";
    env.PLATFORM_ADMIN_GROUP = "admins";
    env.ASSETS = {
      fetch: async (input: RequestInfo | URL) => {
        const u = new URL(
          typeof input === "string" || input instanceof URL
            ? String(input)
            : input.url,
        );
        const body = FILES[u.pathname];
        return body === undefined
          ? new Response("no", { status: 404 })
          : new Response(body);
      },
    } as unknown as Fetcher;
  });
  const get = (url: string, cookie?: string) =>
    dispatchWith(
      new Request(url, { headers: cookie ? { cookie } : {} }),
      env,
      db,
      NOW,
    );
  const admin = async () => {
    const { token } = await consoleTestSession(
      env,
      db,
      { sub: "op", name: "Op", email: "op@example.com", groups: ["admins"] },
      NOW,
    );
    return `${ADMIN_COOKIE}=${token}`;
  };

  it("caches public HTML briefly with revalidation and hashed assets as immutable", async () => {
    for (const host of [API, CUSTOMER]) {
      // key.plrs.im 301s Help to the customer host, so its public page is one outside Help.
      const html = await get(
        `${host}${host === API ? "/docs/start/" : "/docs/help/activate/"}`,
      );
      expect(html.headers.get("cache-control"), host).toBe(
        DOCS_PUBLIC_HTML_CACHE,
      );
      const css = await get(`${host}/docs/_astro/app.abc.css`);
      expect(css.headers.get("cache-control"), host).toBe(
        "public, max-age=31536000, immutable",
      );
      // polaris.locker serves only Help's own search bundle (FP-help); /docs/pagefind/ 302s there.
      const shard = await get(
        host === API
          ? `${host}/docs/pagefind/index/en_a.pf_index`
          : `${host}/docs/pagefind-help/index/en_h.pf_index`,
      );
      expect(shard.headers.get("cache-control"), host).toBe(
        "public, max-age=31536000, immutable",
      );
    }
    const sitemap = await get(`${CUSTOMER}/docs/sitemap-help.xml`);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("cache-control")).toBe("public, no-cache");
  });

  it("keeps the styled 404 no-store", async () => {
    const res = await get(`${CUSTOMER}/docs/help/nope/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never lets a gated page or asset be shared-cached, with or without a session", async () => {
    const cookie = await admin();
    const gated = [
      "/docs/operate/console/members/",
      "/docs/contribute/",
      "/docs/pagefind-member/index/en_m1.pf_index",
      "/docs/pagefind-admin/pagefind.js",
      ...Object.keys(DOCS_ASSET_TIERS).slice(0, 3),
    ];
    for (const path of gated) {
      for (const host of [API, CUSTOMER]) {
        for (const c of [undefined, cookie]) {
          const res = await get(`${host}${path}`, c);
          expect(
            shared(res.headers.get("cache-control")),
            `${host}${path} ${res.status} ${c ? "session" : "anon"}: ${res.headers.get("cache-control")}`,
          ).toBe(false);
          // The customer host never serves a gated path itself.
          if (host === CUSTOMER && !c) expect(res.status, path).toBe(302);
        }
      }
    }
    // With a session the console host serves them, privately.
    const page = await get(`${API}/docs/operate/console/members/`, cookie);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
  });
});

describe("customer host robots.txt", () => {
  it("opens Help, closes the redirects, sign-in and API, and names its own sitemap", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), []);
    env.CONSOLE_ORIGIN = API;
    env.CUSTOMER_ORIGIN = CUSTOMER;
    for (const host of [CUSTOMER, "https://polaris.locker"]) {
      const res = await dispatchWith(
        new Request(`${host}/robots.txt`),
        env,
        db,
        NOW,
      );
      const body = await res.text();
      expect(body).toContain("Allow: /docs/help/");
      expect(body).toContain("Disallow: /docs/help/code/");
      expect(body).toContain("Disallow: /api/");
      expect(body).toContain(`Sitemap: ${CUSTOMER}/docs/sitemap-help.xml`);
      for (const gated of ["/docs/operate", "/docs/contribute", "/manage"])
        expect(body).not.toContain(gated);
    }
  });
});

describe.skipIf(!existsSync(join(dist, "help", "code")))(
  "Help code redirects on the customer host (built site)",
  () => {
    it("land on the message's own anchor, public and cacheable, and key.plrs.im 301s there", async () => {
      const db = makeTestDb();
      const env = makeEnv(new KvMock(), []);
      env.CONSOLE_ORIGIN = API;
      env.CUSTOMER_ORIGIN = CUSTOMER;
      env.ASSETS = {
        fetch: async (input: RequestInfo | URL) => {
          const u = new URL(
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input.url,
          );
          const file = join(dist, u.pathname.replace(/^\/docs\//, ""));
          return existsSync(file) && !file.endsWith("/")
            ? new Response(readFileSync(file))
            : new Response("no", { status: 404 });
        },
      } as unknown as Fetcher;
      for (const [id, url] of [
        ["activation.device-limit", "/docs/help/messages/devices/#"],
        ["code_expired", "/docs/help/messages/"],
      ] as const) {
        const res = await dispatchWith(
          new Request(`${CUSTOMER}/docs/help/code/${id}/index.html`),
          env,
          db,
          NOW,
        );
        // The extension-less form is what readers use.
        const pretty = await dispatchWith(
          new Request(`${CUSTOMER}/docs/help/code/${id}/`),
          env,
          db,
          NOW,
        );
        expect(pretty.status, id).toBe(200);
        expect(res.status, id).toBe(200);
        const html = await pretty.text();
        expect(html).toContain(`${url.endsWith("#") ? url : url}`);
        expect(html).toContain(`#${id}"`);
        expect(pretty.headers.get("cache-control")).toBe(
          DOCS_PUBLIC_HTML_CACHE,
        );
      }
      const old = await dispatchWith(
        new Request(`${API}/docs/help/code/code_expired/`),
        env,
        db,
        NOW,
      );
      expect(old.status).toBe(301);
      expect(old.headers.get("location")).toBe(
        `${CUSTOMER}/docs/help/code/code_expired/`,
      );
    });
  },
);

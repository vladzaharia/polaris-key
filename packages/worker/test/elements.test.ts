/**
 * The Elements CDN module route (UK-04b): `/elements/<major|version>/<file>`.
 *
 * Pinned here: which paths match, the headers per kind (immutable exact version, short-lived
 * major, MIME type, nosniff, CORS for module scripts, no cookie), that only a whole 200 from the
 * assets root is served, and that the bytes `bundle:cdn` writes are stable and match the
 * integrity.json the route serves (the SRI story).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ELEMENTS_IMMUTABLE_CACHE,
  handleElements,
  parseElementsPath,
} from "../src/core/elements.js";
import { dispatch } from "../src/dispatch.js";
import { matchRoute } from "../src/router.js";
import type { Env } from "../src/platform/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

const FILES: Record<string, { body: string; extra?: Record<string, string> }> =
  {
    "/elements/1/pk.js": { body: 'export * from "../1.4.2/pk.js";\n' },
    "/elements/1.4.2/pk.js": { body: "console.log('pk')" },
    "/elements/1.4.2/chunks/en-ABC123.js": { body: "export default {}" },
    "/elements/1.4.2/fonts/rubik.woff2": { body: "wOF2" },
    "/elements/1.4.2/fonts/fonts.css": { body: "@font-face{}" },
    "/elements/1.4.2/integrity.json": { body: "{}" },
    "/elements/0.0.0/pk.js": { body: "unstamped" },
    "/elements/1.4.2/evil.html": { body: "<script>alert(1)</script>" },
  };

function assets(seen: string[] = []): Fetcher {
  return {
    async fetch(input: Request | string | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      seen.push(url.pathname + url.search);
      const f = FILES[url.pathname];
      return f
        ? new Response(f.body, {
            headers: {
              etag: '"abc"',
              "set-cookie": "x=1",
              "content-type": "text/html",
            },
          })
        : new Response("nope", { status: 404 });
    },
  } as unknown as Fetcher;
}

function envWith(a: Fetcher | undefined): Env {
  return { ...makeEnv(new KvMock(), []), ASSETS: a } as Env;
}

async function get(
  path: string,
  init: RequestInit = {},
  env = envWith(assets()),
) {
  const req = new Request(`https://key.plrs.im${path}`, init);
  return handleElements(req, env, new URL(req.url));
}

describe("parseElementsPath", () => {
  it("accepts a major and an exact version, with nested chunk and font files", () => {
    expect(parseElementsPath("/elements/1/pk.js")).toMatchObject({
      version: "1",
      exact: false,
      file: "pk.js",
      ext: "js",
    });
    expect(
      parseElementsPath("/elements/1.4.2-beta.3/chunks/a-B.js"),
    ).toMatchObject({ exact: true, file: "chunks/a-B.js" });
  });
  it("refuses everything else", () => {
    for (const p of [
      "/elements",
      "/elements/",
      "/elements/1",
      "/elements/1/",
      "/elements/latest/pk.js",
      "/elements/1.4/pk.js",
      "/elements/1/../pk.js",
      "/elements/1/./pk.js",
      "/elements/1//pk.js",
      "/elements/1/.hidden.js",
      "/elements/1/a%2fb.js",
      "/elements/1/pk.js/",
      "/elements/1/pk.map",
      "/elements/1/pk.html",
      "/elements/1/pk",
      "/elements/1.4.2-/pk.js",
      "/elements/99999/pk.js",
    ])
      expect(parseElementsPath(p), p).toBeNull();
  });
  it("is a route of its own, ahead of product slugs", () => {
    expect(matchRoute("/elements/1/pk.js")).toEqual({ kind: "elements" });
    expect(matchRoute("/elements")).toEqual({ kind: "elements" });
  });
});

describe("handleElements", () => {
  it("serves an exact version immutable, as JavaScript, with CORS and nosniff", async () => {
    const res = await get("/elements/1.4.2/pk.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log('pk')");
    expect(res.headers.get("cache-control")).toBe(ELEMENTS_IMMUTABLE_CACHE);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(res.headers.get("etag")).toBe('"abc"');
  });

  it("never serves the unstamped 0.0.0 build as immutable", async () => {
    const res = await get("/elements/0.0.0/pk.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a matching If-None-Match with 304 and the same cache headers", async () => {
    const hit = await get("/elements/1.4.2/pk.js", {
      headers: { "if-none-match": '"abc"' },
    });
    expect(hit.status).toBe(304);
    expect(await hit.text()).toBe("");
    expect(hit.headers.get("cache-control")).toBe(ELEMENTS_IMMUTABLE_CACHE);
    const weak = await get("/elements/1.4.2/pk.js", {
      headers: { "if-none-match": 'W/"abc", "zzz"' },
    });
    expect(weak.status).toBe(304);
    const miss = await get("/elements/1.4.2/pk.js", {
      headers: { "if-none-match": '"other"' },
    });
    expect(miss.status).toBe(200);
  });

  it("serves the floating major briefly, never immutable", async () => {
    const res = await get("/elements/1/pk.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toContain("../1.4.2/pk.js");
  });

  it("types chunks, fonts, css and integrity.json by extension, ignoring the assets layer's type", async () => {
    const types: Record<string, string> = {
      "/elements/1.4.2/chunks/en-ABC123.js": "text/javascript; charset=utf-8",
      "/elements/1.4.2/fonts/rubik.woff2": "font/woff2",
      "/elements/1.4.2/fonts/fonts.css": "text/css; charset=utf-8",
      "/elements/1.4.2/integrity.json": "application/json; charset=utf-8",
    };
    for (const [p, t] of Object.entries(types))
      expect((await get(p)).headers.get("content-type"), p).toBe(t);
  });

  it("sets no cookie, drops the query string and asks the assets root for the exact path", async () => {
    const seen: string[] = [];
    const res = await get(
      "/elements/1.4.2/pk.js?x=1",
      {},
      envWith(assets(seen)),
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen).toEqual(["/elements/1.4.2/pk.js"]);
  });

  it("answers HEAD without a body and OPTIONS as a preflight", async () => {
    const head = await get("/elements/1.4.2/pk.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const pre = await get("/elements/1.4.2/pk.js", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
  });

  it("refuses other methods", async () => {
    expect(
      (await get("/elements/1.4.2/pk.js", { method: "POST" })).status,
    ).toBe(405);
  });

  it("404s uncached for a missing file, a bad path, a type it does not serve and no assets binding", async () => {
    for (const [p, env] of [
      ["/elements/9.9.9/pk.js", envWith(assets())],
      ["/elements/1.4.2/evil.html", envWith(assets())],
      ["/elements/latest/pk.js", envWith(assets())],
      ["/elements/1.4.2/pk.js", envWith(undefined)],
    ] as const) {
      const res = await get(p, {}, env);
      expect(res.status, p).toBe(404);
      expect(res.headers.get("cache-control"), p).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin"), p).toBe("*");
    }
  });

  it("goes through the dispatcher with no session, and is hidden on the customer host", async () => {
    const env = { ...envWith(assets()) } as Env;
    const res = await dispatch(
      new Request("https://key.plrs.im/elements/1.4.2/pk.js"),
      env,
      makeTestDb(),
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(ELEMENTS_IMMUTABLE_CACHE);
    const onCustomer = await dispatch(
      new Request("https://polaris.locker/elements/1.4.2/pk.js"),
      {
        ...env,
        CUSTOMER_ORIGIN: "https://polaris.locker",
        CONSOLE_ORIGIN: "https://key.plrs.im",
      } as Env,
      makeTestDb(),
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    expect(onCustomer.status).toBe(404);
  });
});

describe("the built bundle", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = join(here, "..", "..", "elements");
  const built = existsSync(join(pkg, "dist", "index.js"));

  it.skipIf(!built)(
    "is byte-stable, and integrity.json matches the files and the shim",
    () => {
      const a = mkdtempSync(join(tmpdir(), "elements-a-"));
      const b = mkdtempSync(join(tmpdir(), "elements-b-"));
      try {
        const script = join(pkg, "scripts", "bundle-cdn.mjs");
        const env = { ...process.env, PKEY_ELEMENTS_UNSTAMPED_OK: "1" };
        execFileSync(process.execPath, [script, a], { stdio: "pipe", env });
        execFileSync(process.execPath, [script, b], { stdio: "pipe", env });
        const version = JSON.parse(
          readFileSync(join(pkg, "package.json"), "utf8"),
        ).version as string;
        const major = version.split(".")[0]!;
        const read = (root: string, rel: string) =>
          readFileSync(join(root, rel));
        const sri = (buf: Buffer) =>
          "sha384-" + createHash("sha384").update(buf).digest("base64");
        const ia = JSON.parse(read(a, `${version}/integrity.json`).toString());
        const ib = JSON.parse(read(b, `${version}/integrity.json`).toString());
        expect(ia).toEqual(ib);
        for (const [file, hash] of Object.entries(
          ia.files as Record<string, string>,
        ))
          expect(sri(read(a, `${version}/${file}`)), file).toBe(hash);
        expect(ia.files["pk.js"]).toBeDefined();
        // The floating URL is only the shim onto the exact version.
        expect(read(a, `${major}/pk.js`).toString()).toBe(
          `export * from "../${version}/pk.js";\n`,
        );
        const im = JSON.parse(read(a, `${major}/integrity.json`).toString());
        expect(im.files["pk.js"]).toBe(sri(read(a, `${major}/pk.js`)));
        // Every file the module loads is a path the route accepts.
        for (const file of Object.keys(ia.files))
          expect(
            parseElementsPath(`/elements/${version}/${file}`),
            file,
          ).not.toBeNull();
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("bundle:cdn stamping and the major", () => {
  const pkg = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "elements",
  );
  const built = existsSync(join(pkg, "dist", "index.js"));
  const script = join(pkg, "scripts", "bundle-cdn.mjs");
  const base = { ...process.env } as Record<string, string | undefined>;
  delete base.PKEY_ELEMENTS_VERSION;
  delete base.PKEY_ELEMENTS_FLOAT;
  delete base.PKEY_ELEMENTS_UNSTAMPED_OK;
  const run = (out: string, env: Record<string, string>) =>
    execFileSync(process.execPath, [script, out], {
      stdio: "pipe",
      env: { ...base, ...env },
    });

  it.skipIf(!built)(
    "refuses the unstamped 0.0.0 under CI, and names the bundle for PKEY_ELEMENTS_VERSION",
    () => {
      const out = mkdtempSync(join(tmpdir(), "elements-s-"));
      try {
        expect(() => run(out, { CI: "true" })).toThrow();
        run(out, { CI: "true", PKEY_ELEMENTS_VERSION: "3.2.1" });
        expect(existsSync(join(out, "3.2.1", "pk.js"))).toBe(true);
        expect(readFileSync(join(out, "3", "pk.js"), "utf8")).toBe(
          'export * from "../3.2.1/pk.js";\n',
        );
        // The import map carries every module (pk.js and each chunk) keyed by absolute URL.
        const ints = JSON.parse(
          readFileSync(join(out, "3.2.1", "integrity.json"), "utf8"),
        );
        const js = Object.keys(ints.files).filter((f) => f.endsWith(".js"));
        expect(js).toContain("pk.js");
        expect(Object.keys(ints.importMap.integrity).sort()).toEqual(
          js.map((f) => `https://key.plrs.im/elements/3.2.1/${f}`).sort(),
        );
        for (const f of js)
          expect(
            ints.importMap.integrity[`https://key.plrs.im/elements/3.2.1/${f}`],
          ).toBe(ints.files[f]);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!built)(
    "a prerelease deploy (PKEY_ELEMENTS_FLOAT=0) writes the exact version and no major",
    () => {
      const out = mkdtempSync(join(tmpdir(), "elements-p-"));
      try {
        run(out, {
          PKEY_ELEMENTS_VERSION: "3.3.0-rc.1",
          PKEY_ELEMENTS_FLOAT: "0",
        });
        expect(existsSync(join(out, "3.3.0-rc.1", "pk.js"))).toBe(true);
        expect(existsSync(join(out, "3"))).toBe(false);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

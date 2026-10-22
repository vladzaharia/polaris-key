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
        execFileSync(process.execPath, [script, a], { stdio: "pipe" });
        execFileSync(process.execPath, [script, b], { stdio: "pipe" });
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

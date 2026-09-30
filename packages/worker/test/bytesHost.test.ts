import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  BYTE_ROUTES,
  bytesHostname,
  dispatchBytesHost,
  isBytesHost,
  type ByteRoute,
} from "../src/core/bytesHost.js";
import { BLOB_CSP } from "../src/core/blobs.js";
import { ADMIN_COOKIE } from "../src/admin/session.js";
import { PORTAL_COOKIE } from "../src/services/identity/portal/session.js";
import type { Env } from "../src/env.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const BYTES = "https://dl.example.test";
const CONSOLE = "https://key.example.test";

function env(blobOrigin?: string): Env {
  const e = makeEnv(new KvMock(), []);
  if (blobOrigin !== undefined) e.BLOB_ORIGIN = blobOrigin;
  return e;
}

/** Paths that, on the console, reach the admin SPA, the docs gate, the portal, discovery, a
 *  service route, the webhook and the alias table. None of them may answer on the bytes host. */
const CONSOLE_PATHS = [
  "/",
  "/index.html",
  "/manage",
  "/manage/api/me",
  "/manage/login",
  "/docs",
  "/docs/start/concepts/",
  "/login",
  "/api/me",
  "/download/abc",
  "/djdl/.well-known/polaris.json",
  "/djdl/.well-known/jwks.json",
  "/djdl/release/dl/x",
  "/djdl/appcast.xml",
  "/webhooks/github",
  "/blobs/sha256/" + "a".repeat(64),
];

async function snapshot(res: Response): Promise<unknown> {
  return {
    status: res.status,
    headers: [...res.headers].filter(([k]) => k !== "date"),
    body: await res.text(),
  };
}

async function outcome(req: Request, e: Env): Promise<unknown> {
  try {
    return await snapshot(await worker.fetch(req, e));
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

describe("bytes host: configuration", () => {
  it("resolves BLOB_ORIGIN to a lowercase hostname, and nothing for unset or junk", () => {
    expect(bytesHostname({ BLOB_ORIGIN: "https://DL.plrs.im" })).toBe(
      "dl.plrs.im",
    );
    expect(bytesHostname({ BLOB_ORIGIN: "https://dl.plrs.im/" })).toBe(
      "dl.plrs.im",
    );
    expect(bytesHostname({})).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "" })).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "not a url" })).toBeNull();
    expect(bytesHostname({ BLOB_ORIGIN: "ftp://dl.plrs.im" })).toBeNull();
    expect(isBytesHost(new URL("https://dl.plrs.im/x"), {})).toBe(false);
  });

  it("the committed wrangler.toml points each environment's BLOB_ORIGIN at its own dl host", () => {
    const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
    for (const [envName, host] of [
      ["prod", "dl.plrs.im"],
      ["staging", "dl-staging.plrs.im"],
      ["dev", "dl-dev.plrs.im"],
    ] as const) {
      const block = toml
        .split(`[env.${envName}]`)[1]!
        .split(/\n\[env\.(?!\w+\.)/)[0]!;
      expect(block, envName).toContain(`BLOB_ORIGIN = "https://${host}"`);
      expect(block, envName).toMatch(
        new RegExp(
          `pattern = "${host.replace(/\./g, "\\.")}"\\s*\\ncustom_domain = true`,
        ),
      );
      expect(block, envName).toContain(
        `bucket_name = "polaris-key-blobs-${envName}"`,
      );
    }
  });

  it("P2-01 registers no byte route: the allowlist is empty until P2-05/P2b-04", () => {
    expect(BYTE_ROUTES).toEqual([]);
  });
});

describe("bytes host: isolation", () => {
  it("every console, portal, docs and product path answers the plain not-found there", async () => {
    for (const path of CONSOLE_PATHS) {
      for (const method of ["GET", "POST"]) {
        const res = await worker.fetch(
          new Request(BYTES + path, { method }),
          env(BYTES),
        );
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json(), path).toEqual({ error: "not_found" });
        expect(res.headers.get("set-cookie"), path).toBeNull();
        expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
        expect(res.headers.get("content-security-policy"), path).toBe(BLOB_CSP);
        expect(res.headers.get("content-security-policy"), path).toMatch(
          /\bsandbox\b/,
        );
        // The dispatcher's HSTS backstop still applies to the bytes host.
        expect(res.headers.get("strict-transport-security"), path).toContain(
          "max-age=",
        );
      }
    }
  });

  it("the host match is case-insensitive and ignores the port", async () => {
    const res = await worker.fetch(
      new Request("https://DL.EXAMPLE.TEST:443/manage"),
      env(BYTES),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);
  });

  it("with BLOB_ORIGIN unset, routing is byte-identical to today — on any host", async () => {
    for (const path of CONSOLE_PATHS) {
      for (const host of [CONSOLE, BYTES]) {
        const without = await outcome(new Request(host + path), env());
        const junk = await outcome(new Request(host + path), env("not a url"));
        expect(junk, host + path).toEqual(without);
      }
    }
  });

  it("with BLOB_ORIGIN set, the console host is unchanged", async () => {
    for (const path of CONSOLE_PATHS) {
      const without = await outcome(new Request(CONSOLE + path), env());
      const withIt = await outcome(new Request(CONSOLE + path), env(BYTES));
      expect(withIt, path).toEqual(without);
    }
  });
});

describe("bytes host: dispatch", () => {
  const seen: Request[] = [];
  const echo = (
    body: BodyInit | null,
    headers: Record<string, string>,
    status = 200,
  ): ByteRoute => ({
    name: "fake",
    match: (p) => (p.startsWith("/fake/") ? { rest: p.slice(6) } : null),
    handle: async (req) => {
      seen.push(req);
      return new Response(body, { status, headers });
    },
  });

  it("only allowlisted routes answer; the Cookie header never reaches them", async () => {
    seen.length = 0;
    const route = echo("bytes", {
      "content-type": "application/octet-stream",
      "set-cookie": "pkey_x=1; Path=/",
    });
    const res = await dispatchBytesHost(
      new Request(BYTES + "/fake/a", {
        headers: { cookie: `${ADMIN_COOKIE}=forged; ${PORTAL_COOKIE}=forged` },
      }),
      env(BYTES),
      [route],
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.get("cookie")).toBeNull();
    // ...and no cookie is set on the host, whatever a route tried.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(BLOB_CSP);

    const other = await dispatchBytesHost(
      new Request(BYTES + "/nope"),
      env(BYTES),
      [route],
    );
    expect(other.status).toBe(404);
  });

  it("a route that answers with an executable or renderable type is replaced by not-found", async () => {
    for (const type of [
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "application/javascript",
      "text/javascript",
      "application/xml",
      "text/plain",
      "application/json",
    ]) {
      const res = await dispatchBytesHost(
        new Request(BYTES + "/fake/x"),
        env(BYTES),
        [echo("<script>alert(1)</script>", { "content-type": type })],
      );
      expect(res.status, type).toBe(404);
      expect(await res.json(), type).toEqual({ error: "not_found" });
    }
  });

  it("a JSON error body from a route is allowed through (it is not a payload)", async () => {
    const res = await dispatchBytesHost(
      new Request(BYTES + "/fake/x"),
      env(BYTES),
      [
        echo(
          '{"error":"forbidden"}',
          { "content-type": "application/json" },
          403,
        ),
      ],
    );
    expect(res.status).toBe(403);
  });

  it("CORS: none yet — the TODO(P0-05) marker sits at the point P0-05 must wire", async () => {
    const res = await dispatchBytesHost(
      new Request(BYTES + "/fake/x", {
        headers: { origin: "https://evil.example" },
      }),
      env(BYTES),
      [echo("b", { "content-type": "application/octet-stream" })],
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const src = readFileSync(join(SRC, "core", "bytesHost.ts"), "utf8");
    expect(src).toContain("TODO(P0-05): CORS.");
  });
});

describe("console session cookies cannot reach the bytes host", () => {
  // The bytes host is a *.plrs.im sibling (owner decision; THREAT-MODEL §3). What keeps the
  // console's sessions off it is that every session cookie is HOST-ONLY: no Domain attribute.
  // `__Host-` makes the browser enforce that for the admin and portal cookies.
  it("admin and portal cookies are __Host- prefixed", () => {
    expect(ADMIN_COOKIE.startsWith("__Host-")).toBe(true);
    expect(PORTAL_COOKIE.startsWith("__Host-")).toBe(true);
  });

  it("no Set-Cookie anywhere in src/ carries a Domain attribute", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          // Code only: comment lines are dropped (session.ts quotes an attacker's
          // `Domain=plrs.im` cookie in prose to explain why `__Host-` is used).
          const code = readFileSync(p, "utf8")
            .split("\n")
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
            .join("\n");
          if (/Domain=/i.test(code)) offenders.push(p);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});

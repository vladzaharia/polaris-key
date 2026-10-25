/**
 * The service route tables (P0-25, `core/http/routes.ts`): the mechanism, and every row of the
 * real tables.
 *
 * `serviceRouteOracle.test.ts` proves the move changed no answer; this file proves the table
 * cannot be written to loosen one. A row never reaches its handler by a method it does not list,
 * a CI row never reaches it without a `pkeyci_` token, an unmatched path is `null`, and the
 * descriptors serve exactly the tables the spec is checked against.
 */

import { describe, expect, it } from "vitest";
import {
  serviceRoutes,
  type ServiceRouteDecl,
} from "../../src/core/http/routes.js";
import { CI_SCOPES } from "../../src/core/ciScope.js";
import { SERVICES } from "../../src/mount.js";
import type { ServiceContext } from "../../src/core/registry.js";
import { LICENSE_ROUTES } from "../../src/services/license/routes.js";
import { CONFIG_ROUTES } from "../../src/services/config/routes.js";
import { UPDATE_ROUTES } from "../../src/services/update/routes.js";
import { IDENTITY_ROUTES } from "../../src/services/identity/routes.js";
import { RELEASE_ROUTES } from "../../src/services/release/routes.js";
import { DISTRIBUTION_ROUTES } from "../../src/services/distribution/routes.js";
import { COMMERCE_ROUTES } from "../../src/services/commerce/routes.js";
import { SYNC_ROUTES } from "../../src/services/sync/routes.js";

const TABLES = {
  license: LICENSE_ROUTES,
  config: CONFIG_ROUTES,
  update: UPDATE_ROUTES,
  identity: IDENTITY_ROUTES,
  release: RELEASE_ROUTES,
  distribution: DISTRIBUTION_ROUTES,
  sync: SYNC_ROUTES,
  commerce: COMMERCE_ROUTES,
} as const;

const ALL = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** A context that explodes if a handler (or anything past the gate) touches it. */
function ctxFor(method: string, rest: string[]): ServiceContext {
  const trap = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`the table let a ${method} reach for ${String(prop)}`);
      },
    },
  );
  return {
    req: new Request(`https://key.plrs.im/p/x/${rest.join("/")}`, { method }),
    env: trap,
    db: trap,
    product: { slug: "p", services: { license: { enabled: true } } },
    rest,
    now: 0,
    storeGrants: () => undefined,
    storeHook: true,
  } as unknown as ServiceContext;
}

describe("serviceRoutes mechanism", () => {
  const seen: string[] = [];
  const spy = async () => {
    seen.push("ran");
    return new Response("ok");
  };
  const table = serviceRoutes("license", [
    { path: "a", methods: ["GET"], auth: { kind: "none" }, handler: spy },
    {
      path: "b/:id",
      methods: ["POST"],
      auth: { kind: "none" },
      other: "none",
      params: { id: /^[0-9]+$/ },
      handler: spy,
    },
    {
      path: "c",
      methods: ["GET"],
      alsoHead: true,
      auth: { kind: "none" },
      other: () => new Response("no", { status: 418 }),
      handler: spy,
    },
    {
      path: "ci",
      methods: ["POST"],
      auth: { kind: "ci", scope: "release:yank" },
      bodyCap: 10,
      handler: spy,
    },
    {
      path: "x/:k",
      methods: ["GET"],
      auth: { kind: "none" },
      accept: (_c, p) => p.k === "yes",
      handler: spy,
    },
    {
      path: "x/lit",
      methods: ["POST"],
      auth: { kind: "none" },
      other: "none",
      handler: spy,
    },
  ]);

  it("is deny-by-default: no row, no response, no handler", async () => {
    seen.length = 0;
    for (const rest of [[], ["nope"], ["a", "extra"], ["b"], ["b", "1", "2"]])
      expect(await table.handle(ctxFor("GET", rest))).toBeNull();
    expect(seen).toEqual([]);
  });

  it("refuses an unlisted method before the handler, per the row's policy", async () => {
    seen.length = 0;
    const plain = await table.handle(ctxFor("POST", ["a"]));
    expect(plain?.status).toBe(405);
    expect(await plain?.text()).toBe("Method Not Allowed");
    expect(await table.handle(ctxFor("GET", ["b", "1"]))).toBeNull();
    expect((await table.handle(ctxFor("POST", ["c"])))?.status).toBe(418);
    expect(seen).toEqual([]);
  });

  it("serves HEAD only where the row declares it", async () => {
    seen.length = 0;
    expect((await table.handle(ctxFor("HEAD", ["c"])))?.status).toBe(200);
    expect((await table.handle(ctxFor("HEAD", ["a"])))?.status).toBe(405);
    expect(seen).toEqual(["ran"]);
  });

  it("a constrained segment that fails is no match, ahead of the method gate", async () => {
    seen.length = 0;
    expect(await table.handle(ctxFor("POST", ["b", "x"]))).toBeNull();
    expect(await table.handle(ctxFor("GET", ["b", "x"]))).toBeNull();
    expect(seen).toEqual([]);
    expect((await table.handle(ctxFor("POST", ["b", "7"])))?.status).toBe(200);
  });

  it("a CI row refuses a request without a pkeyci_ token before its handler runs", async () => {
    seen.length = 0;
    const res = await table.handle(ctxFor("POST", ["ci"]));
    expect(res?.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("the most specific row wins, and `accept` is checked before the method", async () => {
    seen.length = 0;
    expect((await table.handle(ctxFor("POST", ["x", "lit"])))?.status).toBe(
      200,
    );
    // The literal row owns `x/lit`: a GET there is its `none`, not the parameter row's answer.
    expect(await table.handle(ctxFor("GET", ["x", "lit"]))).toBeNull();
    expect(await table.handle(ctxFor("GET", ["x", "no"]))).toBeNull();
    expect((await table.handle(ctxFor("GET", ["x", "yes"])))?.status).toBe(200);
  });

  it("refuses a malformed table", () => {
    const row = {
      auth: { kind: "none" },
      methods: ["GET"],
      handler: spy,
    } as const;
    expect(() =>
      serviceRoutes("license", [
        { ...row, path: "a" },
        { ...row, path: "a" },
      ]),
    ).toThrow(/twice/);
    expect(() =>
      serviceRoutes("license", [{ ...row, path: "a", methods: [] }]),
    ).toThrow(/no method/);
    expect(() => serviceRoutes("license", [{ ...row, path: "a/**" }])).toThrow(
      /doc/,
    );
    expect(() =>
      serviceRoutes("license", [
        {
          ...row,
          path: "a",
          methods: ["POST"],
          auth: { kind: "ci", scope: "release:yank" },
        },
      ]),
    ).toThrow(/bodyCap/);
  });
});

describe("the real tables", () => {
  const rows: Array<[string, ServiceRouteDecl]> = Object.entries(
    TABLES,
  ).flatMap(([slug, t]) =>
    t.rows.map((r): [string, ServiceRouteDecl] => [slug, r]),
  );

  it("each service descriptor serves its table, and the spec surface is derived from it", () => {
    for (const [slug, table] of Object.entries(TABLES)) {
      const d = SERVICES.get(slug as keyof typeof TABLES)!;
      expect(d.handle, slug).toBe(table.handle);
      expect(d.surface, slug).toBe(table.surface);
    }
  });

  it("every CI row names a real scope and a body cap, and no non-CI row claims a cap", () => {
    const scopes = new Set<string>(CI_SCOPES);
    const cis = rows.filter(([, r]) => r.auth.kind === "ci");
    expect(cis.length).toBeGreaterThanOrEqual(8);
    for (const [slug, r] of cis) {
      const auth = r.auth as Extract<ServiceRouteDecl["auth"], { kind: "ci" }>;
      for (const s of typeof auth.scope === "string"
        ? [auth.scope]
        : auth.scope)
        expect(scopes.has(s), `${slug} ${r.path}: ${s}`).toBe(true);
      if (r.methods.some((m) => m !== "GET" && m !== "HEAD"))
        expect(r.bodyCap, `${slug} ${r.path}`).toBeGreaterThan(0);
    }
    for (const [slug, r] of rows)
      if (r.auth.kind !== "ci")
        expect(r.bodyCap, `${slug} ${r.path}`).toBeUndefined();
  });

  /** A segment that satisfies a row's own checks, found by trying a few shapes. */
  const SAMPLES = [
    "a1",
    "stable",
    "a".repeat(64),
    "x.AppImage.zsync",
    "google-play",
    "asc",
    "winget",
    "1.2.3",
  ];

  function pathsFor(r: ServiceRouteDecl, method: string): string[][] {
    const out: string[][] = [];
    for (const sample of SAMPLES) {
      const rest = r.path
        .split("/")
        .flatMap((s) =>
          s === "**" ? ["x"] : [s.startsWith(":") ? sample : s],
        );
      out.push(rest);
    }
    void method;
    return out;
  }

  it("no row reaches its handler by a method it does not list", async () => {
    let checked = 0;
    for (const [slug, r] of rows) {
      if (r.other === "handler") continue;
      const unlisted = ALL.filter(
        (m) =>
          !(r.methods as readonly string[]).includes(m) &&
          !(r.alsoHead && m === "HEAD"),
      );
      // Find a path this row owns (its own `accept` and `params` pass), then every other method.
      let owned: string[] | undefined;
      for (const rest of pathsFor(r, r.methods[0]!)) {
        const probe = await TABLES[slug as keyof typeof TABLES]
          .handle(ctxFor("DELETE", rest))
          .then(
            (res) => res,
            () => "threw" as const,
          );
        // 405 or null ("none") from the gate means the row matched; a throw means it ran.
        if (
          probe !== "threw" &&
          (probe === null || probe.status === 405 || probe.status === 418)
        ) {
          // Distinguish "no row" (null) from "row said none" via the row's own policy.
          if (probe === null && r.other !== "none") continue;
          owned = rest;
          break;
        }
      }
      if (!owned) continue;
      for (const m of unlisted) {
        const res = await TABLES[slug as keyof typeof TABLES].handle(
          ctxFor(m, owned),
        );
        if (r.other === "none")
          expect(res, `${slug} ${r.path} ${m}`).toBeNull();
        else
          expect(res?.status, `${slug} ${r.path} ${m}`).toBeGreaterThanOrEqual(
            405,
          );
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("every CI row refuses its listed method without a token, before its handler", async () => {
    let checked = 0;
    for (const [slug, r] of rows) {
      if (r.auth.kind !== "ci") continue;
      for (const rest of pathsFor(r, r.methods[0]!)) {
        const res = await TABLES[slug as keyof typeof TABLES]
          .handle(ctxFor(r.methods[0]!, rest))
          .catch(() => "threw" as const);
        if (res === null) continue; // an `accept` that wants another sample
        expect(res, `${slug} ${r.path}`).not.toBe("threw");
        expect((res as Response).status, `${slug} ${r.path}`).toBe(401);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

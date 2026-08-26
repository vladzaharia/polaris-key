/// <reference types="@cloudflare/workers-types" />
// ── The workerd smoke lane ───────────────────────────────────────────────────────────────
//
// Every assertion here exists because it would pass in Node and could fail in workerd. The
// lane is small on purpose: R10-01 (`docs/security/findings/R10-dos.md`, verified in
// `docs/security/findings/VERIFY-R10-01.md`) was a 100%-down release blocker that hundreds of
// Node tests could not see, because `environment: "node"` permits the runtime code generation
// workerd forbids. Broad coverage lives in the Node lane; what lives here is runtime truth.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Catalog } from "@plrs/catalog";
import { signJws, verifyJws } from "@plrs/jws";
import type {
  ManagedConfigDoc,
  ManagedEntry,
  ManagedPayload,
} from "@plrs/protocol";
import djdlCatalog from "../../../products/djdl/catalog.json";
import { D1Db } from "../src/db/d1.js";
import { validatePayload } from "../src/configDoc.js";
import {
  TEST_KID,
  TEST_PEM,
  TEST_PUB,
  seedLicenseWithKey,
  seedProduct,
} from "./seed.js";

const SLUG = "djdl";
const TRUST = { [TEST_KID]: TEST_PUB };

/** A fresh `Catalog` over the real djdl catalog (28 entries, 16 defaulted config keys). */
function djdl(): Catalog {
  return new Catalog(djdlCatalog as never);
}

describe("workerd runtime control", () => {
  // THE CANARY. If this ever stops throwing, either the lane silently fell back to a
  // permissive runtime or workerd relaxed the restriction — and in both cases every other
  // assertion in this file has quietly stopped proving anything. VERIFY-R10-01 §E1 recorded
  // exactly this on real workerd at compat dates 2024-01-01 through 2026-04-07: codegen is
  // legal at module scope and throws `EvalError` in request phase.
  it("forbids code generation from strings at request time", () => {
    // Deliberately reached indirectly: the point is to observe the runtime refusing, and a
    // literal call site would be flagged by the very lint this restriction exists to enforce.
    const compileFromSource = Function as unknown as (src: string) => unknown;
    expect(() => compileFromSource("return 1")).toThrowError(
      /[Cc]ode generation/,
    );
    const indirectEval = globalThis.eval as (src: string) => unknown;
    expect(() => indirectEval("1")).toThrowError(/[Cc]ode generation/);
  });

  it("refuses the exact construction Ajv's compile() used", () => {
    // Ajv built validator SOURCE and handed it to the `Function` constructor with named
    // parameters. This is that shape, reduced to one line. It is the thing that turned every
    // `GET /<product>/config` into a 500, so the lane asserts the runtime still forbids it —
    // if workerd ever permitted this again, the catalog assertions below would stop being
    // evidence of anything and this test says so first.
    const ajvShapedCompile = (): unknown =>
      (Function as unknown as (...args: string[]) => unknown)(
        "data",
        'return typeof data === "string";',
      );
    expect(ajvShapedCompile).toThrowError(/[Cc]ode generation/);
  });

  it("exposes WebCrypto Ed25519 at the worker's compatibility date", async () => {
    // `wrangler.toml` pins compatibility_date = 2026-04-07 with this as the stated reason.
    // The Node lane proves nothing about it: Node's WebCrypto has had Ed25519 for years.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    expect(pair.privateKey.algorithm.name).toBe("Ed25519");
  });
});

describe("catalog validation under workerd (R10-01 regression)", () => {
  // The defect: `Catalog` validated by generating JavaScript and handing it to the `Function`
  // constructor, so *any* value check threw `EvalError` mid-request. One config key sufficed.
  it("validates a value against the real djdl catalog without generating code", () => {
    const catalog = djdl();
    const entry = catalog
      .entriesByKind("config")
      .find((e) => e.default !== undefined);
    expect(entry).toBeTruthy();
    expect(catalog.validateKeyValue(entry!.key, entry!.default).ok).toBe(true);
    expect(catalog.validateKeyValue("no.such.key", 1).ok).toBe(false);
  });

  it("analyses every djdl fragment at publish time without generating code", () => {
    // `compileAll()` is what `PUT /manage/api/products/<slug>/schema` runs. Under Ajv this
    // threw, which is why VERIFY-R10-01 §E2 recorded a 422 on every admin publish.
    expect(() => djdl().compileAll()).not.toThrow();
  });

  it("prunes a defaulted payload through validatePayload without generating code", () => {
    // `licensing.ts`'s composition: seed catalog defaults, then re-validate before signing.
    // §E2b: djdl has 16 defaulted keys, and a single one was enough to 500 the request.
    const catalog = djdl();
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    for (const entry of catalog.entries) {
      if (entry.kind !== "config" || entry.default === undefined) continue;
      payload.config[entry.key] = {
        state: entry.managementDefault ?? "default",
        value: entry.default as ManagedEntry["value"],
        updatedAt: 1_700_000_000,
      };
    }
    expect(Object.keys(payload.config).length).toBeGreaterThan(0);
    const pruned = validatePayload(payload, djdl());
    // Nothing was silently dropped: a throw here used to become 500 `catalog_unavailable`,
    // and a fail-open catch elsewhere used to drop keys instead.
    expect(Object.keys(pruned.config)).toEqual(Object.keys(payload.config));
  });

  it("answers a ReDoS-prone pattern in bounded time (R10-09)", () => {
    // `(x+x+)+y` is the 8-character pattern measured at ~54 s on the host `RegExp`. The
    // linear matcher must answer immediately and must never fall back to `RegExp`.
    const catalog = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "redos",
          kind: "config",
          category: "c",
          label: "l",
          description: "",
          schema: { type: "string", pattern: "(x+x+)+y" },
        },
      ],
    } as never);
    const started = Date.now();
    expect(catalog.validateKeyValue("redos", "x".repeat(41)).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("JWS signing on workerd WebCrypto", () => {
  it("signs and verifies with the committed Ed25519 test key", async () => {
    const jws = await signJws({ hello: "world" }, TEST_PEM, TEST_KID);
    const verified = await verifyJws<{ hello: string }>(jws, TRUST);
    expect(verified?.payload.hello).toBe("world");
  });
});

describe("GET /<product>/config end to end on workerd", () => {
  it("activates a key and returns a signed, verifiable config doc", async () => {
    // Real D1 (migrated in `setup.ts`), real KV, real Durable Object rate limiter, and the
    // real `src/index.ts` module graph — driven over HTTP, not by calling handlers directly.
    const db = new D1Db(env.DB);
    await seedProduct(env, db, SLUG, djdlCatalog);
    const { key, licenseId } = await seedLicenseWithKey(db, SLUG);

    const activated = await SELF.fetch(`https://key.plrs.im/${SLUG}/activate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "workerd-smoke-1",
      },
    });
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };
    expect(token).toBeTruthy();

    const res = await SELF.fetch(`https://key.plrs.im/${SLUG}/config`, {
      headers: { authorization: `Bearer ${token}`, "x-pkey-version": "1.2.3" },
    });
    // THE R10-01 ASSERTION. Before the interpreting validator this was
    // `500 {"error":"catalog_unavailable"}` on every poll, for every device, warm or cold.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/jwt");

    const jws = await res.text();
    const verified = await verifyJws<ManagedConfigDoc>(jws, TRUST);
    expect(verified).not.toBeNull();
    expect(verified!.kid).toBe(TEST_KID);
    expect(verified!.payload.aud).toBe(SLUG);
    expect(verified!.payload.licenseId).toBe(licenseId);
    // Catalog defaults survived the pre-signing prune rather than being dropped fail-closed.
    expect(
      Object.keys(verified!.payload.payload.config).length,
    ).toBeGreaterThan(0);
  });
});

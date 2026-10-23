/**
 * The requirements evaluator (P0-27.3): `core/stores/requirements.ts`.
 *
 * Credential rows are inserted with a sealed-looking placeholder that cannot be opened: the
 * evaluator must answer from metadata alone, so an attempt to open one would fail loudly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/platform/env.js";
import { STORE_ADAPTERS } from "../src/core/stores/adapters.js";
import {
  credentialAvailable,
  storeRequirements,
} from "../src/core/stores/requirements.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const OPAQUE = "not-a-sealed-value";

let db: Db;
let env: Env;
/** Every SQL statement the evaluator issued. */
let sql: string[];

function spied(inner: Db): Db {
  return new Proxy(inner, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r) as unknown;
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        if (typeof a[0] === "string") sql.push(a[0]);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

async function own(
  product: string,
  id: string,
  kind: string,
  status = "active",
  pin?: Record<string, string>,
): Promise<void> {
  await db.run(
    `INSERT INTO outlet_credentials (product, credential_id, kind, outlet_id, enc_value_json, meta_json, status, created_at, created_by)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'x')`,
    product,
    id,
    kind,
    OPAQUE,
    JSON.stringify({ keyId: "SECRETKEYID", ...pin }),
    status,
    NOW,
  );
}

async function pinPlatform(
  id: string,
  product: string,
  pin: string,
): Promise<void> {
  await db.run(
    "INSERT INTO platform_credential_pins (credential_id, product, pin, pinned_at, pinned_by) VALUES (?, ?, ?, 0, 'x')",
    id,
    product,
    pin,
  );
}

async function platform(id: string, status = "active"): Promise<void> {
  const [store, slot] = id.split(".") as [string, string];
  const kinds: Record<string, string> = {
    "app-store.api-key": "asc-api-key",
    "app-store.in-app-purchase-key": "app-store-server-key",
    "google-play.service-account": "google-service-account",
    "microsoft-store.partner-center": "ms-partner-center",
    "steam.publisher-key": "steam-publisher-key",
  };
  await db.run(
    `INSERT INTO platform_credentials (credential_id, store, slot, kind, enc_value_json, meta_json, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'x')`,
    id,
    store,
    slot,
    kinds[id],
    OPAQUE,
    status,
    NOW,
  );
}

async function count(table: string): Promise<number> {
  return (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!
    .n;
}

beforeEach(async () => {
  const raw = makeTestDb();
  db = raw;
  env = makeEnv(new KvMock(), []);
  await seedProduct(db, "djdl");
  await seedProduct(db, "other");
  db = spied(raw);
  sql = [];
});

const ask = (store: string, facet?: "delivery" | "commerce", p = "djdl") =>
  storeRequirements(env, db, p, store, facet);

describe("storeRequirements", () => {
  it("answers missing slots when nothing is set, per facet", async () => {
    expect(await ask("google-play")).toEqual({
      store: "google-play",
      facet: null,
      met: false,
      missing: [
        { kind: "credential", slot: "google-play.service-account" },
        { kind: "app", field: "packageName" },
      ],
    });
    expect(await ask("app-store", "commerce")).toMatchObject({
      facet: "commerce",
      met: false,
      missing: [
        { kind: "credential", slot: "app-store.in-app-purchase-key" },
        { kind: "app", field: "bundleId" },
      ],
    });
    expect(await ask("app-store", "delivery")).toMatchObject({
      missing: [{ kind: "credential", slot: "app-store.api-key" }],
    });
    expect(await ask("app-store")).toMatchObject({
      missing: [
        { kind: "credential", slot: "app-store.api-key" },
        { kind: "credential", slot: "app-store.in-app-purchase-key" },
        { kind: "app", field: "bundleId" },
      ],
    });
  });

  it("lists a slot once when two facets share it (Steam)", async () => {
    expect((await ask("steam"))!.missing).toEqual([
      { kind: "credential", slot: "steam.publisher-key" },
      { kind: "app", field: "appId" },
    ]);
  });

  it("is met by a configured platform slot", async () => {
    await platform("microsoft-store.partner-center");
    expect(await ask("microsoft-store")).toMatchObject({
      met: true,
      missing: [],
    });
  });

  it("the app requirement is met by a platform pin, and by an own credential's pin", async () => {
    await platform("google-play.service-account");
    expect(await ask("google-play", "commerce")).toMatchObject({
      met: false,
      missing: [{ kind: "app", field: "packageName" }],
    });
    await pinPlatform(
      "google-play.service-account",
      "djdl",
      "com.example.game",
    );
    expect(await ask("google-play", "commerce")).toMatchObject({ met: true });
    // another product's pin is not this product's assignment
    expect(await ask("google-play", "commerce", "other")).toMatchObject({
      met: false,
    });
    await own("djdl", "c1", "steam-publisher-key", "active", { appId: "480" });
    expect(await ask("steam", "commerce")).toMatchObject({
      met: true,
      missing: [],
    });
  });

  it("an own credential with no pin leaves the app missing, with no fall-through to the platform pin", async () => {
    await platform("steam.publisher-key");
    await pinPlatform("steam.publisher-key", "djdl", "480");
    expect(await ask("steam", "commerce")).toMatchObject({ met: true });
    await own("djdl", "c1", "steam-publisher-key");
    expect(await ask("steam", "commerce")).toMatchObject({
      met: false,
      missing: [{ kind: "app", field: "appId" }],
    });
  });

  it("an ambiguous binding is still met", async () => {
    await own("djdl", "c1", "steam-publisher-key", "active", { appId: "480" });
    await own("djdl", "c2", "steam-publisher-key", "active", { appId: "481" });
    expect(await ask("steam", "commerce")).toMatchObject({ met: true });
  });

  it("delivery never asks for an app (oneClick outcomes are unchanged)", async () => {
    await platform("app-store.api-key");
    expect(await ask("app-store", "delivery")).toMatchObject({ met: true });
  });

  it("fails closed: an unknown facet, or commerce on a store with none, answers null", async () => {
    const bad = (f: string) => ask("steam", f as "delivery");
    expect(await bad("nope")).toBeNull();
    expect(await bad("")).toBeNull();
    expect(await bad("__proto__")).toBeNull();
    for (const a of STORE_ADAPTERS.filter((x) => x.commerce === null)) {
      expect(await ask(a.id, "commerce"), a.id).toBeNull();
      // the other facets of the same store still answer
      expect(await ask(a.id, "delivery"), a.id).not.toBeNull();
      expect(await ask(a.id), a.id).not.toBeNull();
    }
  });

  it("is met by an own active credential of the slot's kind", async () => {
    await own("djdl", "c1", "steam-publisher-key", "active", { appId: "480" });
    expect(await ask("steam")).toMatchObject({ met: true, missing: [] });
    expect(await ask("steam", "delivery")).toMatchObject({ met: true });
  });

  it("is not met by a disabled or revoked own credential, nor a disabled platform row", async () => {
    await own("djdl", "c1", "google-service-account", "disabled");
    await own("djdl", "c2", "google-service-account", "revoked");
    await platform("google-play.service-account", "disabled");
    expect(await ask("google-play")).toMatchObject({ met: false });
  });

  it("is not met by an own credential of another kind", async () => {
    await own("djdl", "c1", "asc-api-key");
    expect(await ask("google-play")).toMatchObject({ met: false });
    expect(await ask("app-store", "delivery")).toMatchObject({ met: true });
    expect(await ask("app-store", "commerce")).toMatchObject({ met: false });
  });

  it("never counts another product's credential", async () => {
    await own("other", "c1", "google-service-account");
    expect(await ask("google-play")).toMatchObject({ met: false });
    expect(await ask("google-play", "delivery", "other")).toMatchObject({
      met: true,
    });
  });

  it("treats an invalid Worker secret as not configured", async () => {
    (env as unknown as Record<string, string>).PLATFORM_STEAM_PUBLISHER_KEY =
      "garbage";
    expect(await ask("steam")).toMatchObject({ met: false });
  });

  it("answers met with nothing missing for keyless channels, and null for an unknown id", async () => {
    for (const a of STORE_ADAPTERS.filter((x) => x.requirements.length === 0))
      expect(await ask(a.id)).toEqual({
        store: a.id,
        facet: null,
        met: true,
        missing: [],
      });
    expect(await ask("not-a-store")).toBeNull();
  });

  it("exposes the one seam", async () => {
    expect(
      await credentialAvailable(env, db, "djdl", "steam.publisher-key"),
    ).toBe(false);
    expect(await credentialAvailable(env, db, "djdl", "no.such")).toBe(false);
  });

  it("derives the own kind from the slot: another slot's kind never satisfies it", async () => {
    await own("djdl", "c1", "sentry-integration");
    await own("djdl", "c2", "steam-publisher-key");
    expect(
      await credentialAvailable(env, db, "djdl", "app-store.api-key"),
    ).toBe(false);
    expect(
      await credentialAvailable(env, db, "djdl", "steam.publisher-key"),
    ).toBe(true);
  });

  it("names no key id, issuer, pin or app in its answer", async () => {
    await own("djdl", "c1", "asc-api-key");
    const text = JSON.stringify(await ask("app-store"));
    expect(text).not.toContain("SECRETKEYID");
    expect(text).not.toContain("c1");
  });
});

describe("storeRequirements custody", () => {
  it("only reads, never selects an own credential's sealed value, and writes no audit row", async () => {
    await own("djdl", "c1", "asc-api-key");
    await platform("steam.publisher-key");
    const before = [await count("audit"), await count("platform_audit")];
    sql = [];
    for (const a of STORE_ADAPTERS) {
      await ask(a.id);
      await ask(a.id, "commerce");
    }
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      expect(s.trim()).toMatch(/^SELECT/i);
      if (/outlet_credentials/.test(s)) expect(s).not.toMatch(/enc_value_json/);
    }
    expect([await count("audit"), await count("platform_audit")]).toEqual(
      before,
    );
  });

  it("imports no opener, token helper, store client or audit writer", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../src/core/stores/requirements.ts",
      ),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of [
      "openOutletCredential",
      "openPlatformCredential",
      "outletTokens",
      "audit",
      "fetch",
      "recordOutletCredentialResult",
      "putOutletCredential",
      // REV-P027: the four credential functions the reach suite also refuses here.
      "outletCredentialVersion",
      "listOutletCredentialPins",
      "recordPlatformCredentialResult",
    ])
      expect(code).not.toContain(bad);
  });
});

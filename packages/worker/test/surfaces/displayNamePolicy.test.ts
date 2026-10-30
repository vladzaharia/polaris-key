/**
 * PX-W13b: the display-name policy on the presentation name. An extra platform term
 * (`identity.reservedDisplayTerms`) is reserved at manifest ingest, on a console listing claim and
 * in the sign-in card's render-time re-check; an operator's approval of one product
 * (`identity.displayNameApproved`) clears all three for that product and no other. The approval is
 * operator-only, audited and L1 to grant; the terms only ever add to the code's floor.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { NOW, seedProduct } from "../seed.js";
import { CONSOLE, enableServices, envFor } from "../releaseRoutesFixture.js";
import { PRINCIPALS, ROOT_PRINCIPAL } from "../rbacFixtures.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { handleAdmin } from "../../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../../src/core/console/session.js";
import { consoleTestSession } from "../consoleSessionHelper.js";
import { SETTINGS } from "../../src/mount.js";
import {
  confirmLevelFor,
  writeSetting,
  type WriteOptions,
} from "../../src/core/settings/write.js";
import {
  displayCheckOptions,
  displayNameOptions,
} from "../../src/core/accounts/reservedDisplayNames.js";
import { clientRecordFor } from "../../src/services/identity/passthrough/client.js";
import { withDefaultHead } from "../githubHead.js";
import { TEST_RSA_PKCS8 } from "../releaseFixtures.js";
import { prepareLink } from "../../src/services/release/linkExisting.js";
import { createFromDocuments } from "../../src/core/ingest/fromDocuments.js";
import { ingestFor } from "../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../src/mount.js";
import { loadProductPublic } from "../../src/core/products.js";

let db: Db;
let env: Env;
const ACME = "acme";
const OTHER = "other";
const ACTOR = { sub: "u1", name: "Una", email: "una@example.test" };
const wopts = (over: Partial<WriteOptions> = {}): WriteOptions => ({
  actor: ACTOR,
  origin: "console",
  principal: ROOT_PRINCIPAL,
  now: NOW,
  ...over,
});
const ctx = () => ({ env, db, registry: SETTINGS });

async function addTerm(terms: string[]): Promise<void> {
  const res = await writeSetting(
    ctx(),
    {
      key: "identity.reservedDisplayTerms",
      value: terms,
      expectedVersion: 0,
      reason: "test",
    },
    wopts({ confirm: "identity.reservedDisplayTerms" }),
  );
  expect(res).toMatchObject({ ok: true });
}

async function approve(slug: string): Promise<void> {
  const res = await writeSetting(
    ctx(),
    {
      key: "identity.displayNameApproved",
      value: true,
      expectedVersion: 0,
      reason: "licensed partner",
    },
    wopts({ product: slug }),
  );
  expect(res).toMatchObject({ ok: true });
}

const manifestFiles = (name: string, slug = ACME) => ({
  product: JSON.stringify({ slug, name }),
  schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
  release: JSON.stringify({
    release: {
      ghOwner: "o",
      ghRepo: "r",
      binaryName: "b",
      channelWorkflow: "c.yml",
      betaBranch: "main",
      summaryMarker: "m",
      sparkleEd25519Pub: "K==",
    },
  }),
});

async function ingestErrors(name: string, slug: string): Promise<string[]> {
  const r = parseManifest(manifestFiles(name, slug), {
    ...(await displayNameOptions(
      { ...env, IDENTITY_RESERVED_DISPLAY_NAMES: "error" } as Env,
      db,
      slug,
    )),
  });
  return r.ok ? [] : r.errors;
}

async function claim(slug: string, name: string): Promise<Response> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api/products/${slug}/distribution/listing`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method: "PUT",
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        app: {
          defaultLocale: "en-US",
          name,
          developerName: "Dev",
          contactEmail: "s@x.example",
          urls: { support: "https://x.example/s" },
        },
      }),
    }),
    env,
    db,
    full,
    { now: NOW },
  ) as Promise<Response>;
}

async function card(slug: string, name: string) {
  await db.run("UPDATE products SET name = ? WHERE slug = ?", name, slug);
  const product = (await loadProductPublic(db, slug))!;
  return clientRecordFor(env, db, product, "web" as never, NOW, undefined);
}

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.IDENTITY_RESERVED_DISPLAY_NAMES = "error";
  for (const s of [ACME, OTHER]) {
    await seedProduct(db, s);
    await enableServices(db, true, s);
  }
});

describe("an extra platform term", () => {
  it("is not reserved until added, then is at ingest, on a listing claim and on the card", async () => {
    expect(await ingestErrors("Zephyr Launcher", ACME)).toEqual([]);
    expect((await claim(ACME, "Zephyr Launcher")).status).toBe(200);
    expect((await card(ACME, "Zephyr Launcher")).nameVerified).toBe(true);

    await addTerm(["zephyr"]);

    expect((await ingestErrors("Zephyr Launcher", ACME)).join()).toContain(
      "reserved platform or store name",
    );
    const res = await claim(ACME, "Zephyr Launcher");
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("reserved platform");
    const c = await card(ACME, "Zephyr Launcher");
    expect(c.nameVerified).toBe(false);
    expect(c.appName).toBe(ACME);
  });

  it("only adds: the code's floor stays", async () => {
    await addTerm(["zephyr"]);
    expect((await ingestErrors("Steam Link", ACME)).join()).toContain(
      "reserved platform or store name",
    );
  });
});

describe("an approved product", () => {
  it("passes ingest, a listing claim and the card; an unapproved one does not", async () => {
    await approve(ACME);
    expect(await ingestErrors("Steam Deck Companion", ACME)).toEqual([]);
    expect((await claim(ACME, "Steam Deck Companion")).status).toBe(200);
    const ok = await card(ACME, "Steam Deck Companion");
    expect(ok.nameVerified).toBe(true);
    expect(ok.appName).toBe("Steam Deck Companion");

    expect((await ingestErrors("Steam Deck Companion", OTHER)).length).toBe(1);
    expect((await claim(OTHER, "Steam Deck Companion")).status).toBe(422);
    expect((await card(OTHER, "Steam Deck Companion")).nameVerified).toBe(
      false,
    );
  });

  it("clears the reserved check only, never invalid text", async () => {
    await approve(ACME);
    const opts = await displayCheckOptions(env, db, ACME);
    expect(opts.approved).toBe(true);
    expect((await displayCheckOptions(env, db, OTHER)).approved).toBe(false);
    expect((await claim(ACME, "Steam‮")).status).toBe(422);
  });

  it("is operator-only, audited and L1 to grant", async () => {
    const def = SETTINGS.get("identity.displayNameApproved", "product")!;
    expect(def.ownership).toBe("operator");
    expect(confirmLevelFor(def, false, true)).toBe("L1");

    // Not an operator's: a console caller without the area cannot grant it.
    const refused = await writeSetting(
      ctx(),
      {
        key: "identity.displayNameApproved",
        value: true,
        expectedVersion: 0,
        reason: "x",
      },
      wopts({ product: ACME, principal: PRINCIPALS.consoleOnly }),
    );
    expect(refused.ok).toBe(false);
    expect((await displayCheckOptions(env, db, ACME)).approved).toBe(false);

    // PX-W13c: nor can the product's own admin, with every area: only the platform's admins.
    const own = await writeSetting(
      ctx(),
      {
        key: "identity.displayNameApproved",
        value: true,
        expectedVersion: 0,
        reason: "x",
      },
      wopts({
        product: ACME,
        principal: {
          memberId: "m-own",
          grants: [
            {
              role: "product_admin",
              scope: `product:${ACME}`,
              areas: null,
              source: "grant",
            },
          ],
        },
      }),
    );
    expect(own).toMatchObject({ ok: false, status: 403, reason: "no_access" });
    expect((await displayCheckOptions(env, db, ACME)).approved).toBe(false);

    await approve(ACME);
    const audit = await db.all<{ action: string; setting_key: string }>(
      "SELECT action, setting_key FROM audit WHERE setting_key = ?",
      "identity.displayNameApproved",
    );
    expect(audit).toEqual([
      { action: "setting.update", setting_key: "identity.displayNameApproved" },
    ]);
  });
});

/** A GitHub that serves `.pkey/` for acme/acme: the installation, a token, the three documents. */
function repoFetch(name: string) {
  const docs: Record<string, string> = {
    "product.json": JSON.stringify({
      slug: ACME,
      name,
      compatMin: "1.0.0",
      compatMax: "9.0.0",
      defaultMaxOfflineDays: 14,
      defaultDeviceLimit: 3,
    }),
    "schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    "release.json": JSON.stringify({
      release: { ghOwner: "acme", ghRepo: "acme", binaryName: "acme" },
    }),
  };
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    for (const [f, body] of Object.entries(docs))
      if (url.includes(`/contents/.pkey/${f}`))
        return new Response(
          JSON.stringify({
            content: Buffer.from(body, "utf8").toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        );
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("linking an existing product to a repository", () => {
  const link = (name: string) => {
    env.GITHUB_APP_ID = "12345";
    env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
    return prepareLink(
      env,
      db,
      ACME,
      "https://github.com/acme/acme",
      NOW,
      repoFetch(name),
      ingestFor(SERVICES),
    );
  };

  it("refuses an extra term at error severity, and the product's approval lets it through", async () => {
    expect((await link("Zephyr Launcher")).ok).toBe(true);
    await addTerm(["zephyr"]);
    const refused = await link("Zephyr Launcher");
    expect(refused).toMatchObject({ ok: false, check: "manifest" });
    expect(JSON.stringify(refused)).toContain("reserved platform or store");
    await approve(ACME);
    expect((await link("Zephyr Launcher")).ok).toBe(true);
  });
});

describe("creating a product from documents", () => {
  const create = (name: string) =>
    createFromDocuments(env, db, ingestFor(SERVICES), {
      slug: "fresh",
      name,
      choices: {
        services: [],
        intendedPlatforms: [],
        starterTier: null,
        trustReleaseWorkflow: false,
      },
      author: "ada",
      now: NOW,
    });

  it("judges the name by the floor and the extra terms, with no approval", async () => {
    const floor = await create("Steam Deck Companion");
    expect(floor).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify(floor)).toContain("reserved platform or store");
    expect(await create("Zephyr Launcher")).not.toMatchObject({ status: 422 });
    await addTerm(["zephyr"]);
    const refused = await create("Zephyr Launcher");
    expect(refused).toMatchObject({ ok: false, status: 422 });
    expect(JSON.stringify(refused)).toContain("reserved platform or store");
  });
});

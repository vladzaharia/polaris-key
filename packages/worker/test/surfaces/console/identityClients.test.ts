/**
 * I-21.14: the console's registered clients (`…/identity/clients`) and Platform → Issuer keys.
 * Step-up where the route table says so, the manifest's own rules on every member, a secret shown
 * once and never listed, manifest-owned clients read-only, disable revoking families, and the
 * rotation behind a Superadmin and a typed slug.
 */
import { describe, expect, it } from "vitest";
import { NOW, seedProduct } from "../../seed.js";
import { adminWorld } from "../../adminWorld.js";
import { listAudit } from "../../../src/core/audit.js";
import { setServices } from "../../../src/core/products/store.js";
import { serializeServices } from "../../../src/core/services.js";
import { servicesOn } from "../../transcripts/world.js";
import {
  enableIssuer,
  ingestIdentity,
} from "../../services/identity/issuer/issuerHelpers.js";
import { ensureIssuerKeys } from "../../../src/services/identity/issuer/keys.js";

const SLUG = "djdl";
const BASE = `/api/products/${SLUG}/identity/clients`;
const good = {
  key: "forum",
  name: "Community forum",
  type: "web",
  redirectUris: ["https://forum.example.com/cb"],
  scopes: ["openid", "profile"],
  claimsRequired: ["name"],
};

async function setup() {
  const w = await adminWorld({ products: [SLUG] });
  (w.env as unknown as Record<string, unknown>).KEY_HASH_PEPPER = "pepper";
  await setServices(
    w.db,
    SLUG,
    serializeServices({ services: servicesOn("identity") }),
    "admin",
    NOW,
  );
  await enableIssuer(w.db, SLUG);
  const fresh = await w.login({
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: ["platform-admins"],
    authTime: NOW,
    stepUp: true,
  });
  // A second operator with no recent sign-in: the step-up routes refuse it.
  const plain = await w.login({
    sub: "u2",
    name: "Bob",
    email: "bob@x.io",
    groups: ["platform-admins"],
  });
  const json = async (r: Response) => (await r.json()) as Record<string, any>;
  const call = (
    method: string,
    path: string,
    o: { body?: unknown; as?: typeof fresh } = {},
  ) => w.call(method, path, { as: fresh, ...o });
  const create = async (over: Record<string, unknown> = {}) => {
    const res = await w.call("POST", BASE, {
      as: fresh,
      body: { ...good, ...over },
    });
    return { res, body: await json(res) };
  };
  return { w, call, fresh, plain, json, create };
}

describe("registered clients in the console", () => {
  it("creating, minting, enabling and deleting need a fresh step-up", async () => {
    const { call, plain, create } = await setup();
    const made = await create();
    const id = made.body.client.id as string;
    for (const [method, path] of [
      ["POST", BASE],
      ["POST", `${BASE}/${id}/secrets`],
      ["POST", `${BASE}/${id}/enable`],
      ["DELETE", `${BASE}/${id}`],
    ] as const) {
      const res = await call(method, path, {
        as: plain,
        body: { ...good, key: "x1" },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as any).error.code).toBe("step_up_required");
    }
  });

  it("lists the issuer, its URLs and the clients; creates one and audits it", async () => {
    const { call, w, create, json } = await setup();
    const { res, body } = await create({
      developerName: "Example Partner Ltd",
    });
    expect(res.status).toBe(201);
    expect(body.client).toMatchObject({
      key: "forum",
      origin: "console",
      status: "active",
      partner: true,
      people30d: 0,
    });
    expect(body.client.id).toMatch(/^cl_[A-Za-z0-9_-]{22}$/);
    const page = await json(await call("GET", BASE));
    expect(page.issuer).toMatchObject({
      enabled: true,
      url: `https://key.plrs.im/${SLUG}/identity`,
      discoveryUrl: `https://key.plrs.im/${SLUG}/identity/.well-known/openid-configuration`,
    });
    expect(page.limit).toBe(20);
    expect(page.clients).toHaveLength(1);
    const actions = (await listAudit(w.db, SLUG)).map((a) => a.action);
    expect(actions).toContain("identity.client.created");
  });

  it("refuses with the manifest's rules, field by field", async () => {
    const { create } = await setup();
    for (const [over, field] of [
      [{ key: "A" }, "key"],
      [{ redirectUris: ["http://forum.example.com/cb"] }, "redirectUris"],
      [{ scopes: ["profile"] }, "scopes"],
      [{ claimsRequired: ["email"] }, "claimsRequired"],
      [{ type: "server" }, "type"],
      [{ name: "" }, "name"],
    ] as const) {
      const { res, body } = await create(over);
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(body.fields, JSON.stringify(over)).toContain(field);
    }
  });

  it("refuses a duplicate key, and every client past the cap, and a client while the issuer is off", async () => {
    const { w, create } = await setup();
    expect((await create()).res.status).toBe(201);
    const dup = await create();
    expect(dup.res.status).toBe(409);
    expect(dup.body.reason).toBe("key_exists");
    for (let i = 1; i < 20; i++)
      expect((await create({ key: `app-${i}` })).res.status).toBe(201);
    const over = await create({ key: "one-more" });
    expect(over.body.reason).toBe("client_limit");
    await w.db.run(
      "DELETE FROM product_settings WHERE product = ? AND key = 'identity.issuer.enabled'",
      SLUG,
    );
    const off = await create({ key: "late" });
    expect(off.res.status).toBe(409);
    expect(off.body.reason).toBe("issuer_off");
  });

  it("shows a secret once, lists only its last four, caps at two and revokes", async () => {
    const { call, w, fresh, create, json } = await setup();
    const id = (await create()).body.client.id as string;
    const one = await json(
      await call("POST", `${BASE}/${id}/secrets`, { as: fresh }),
    );
    expect(one.secret.value).toMatch(/^pkeycs_[A-Za-z0-9_-]{43}$/);
    const two = await call("POST", `${BASE}/${id}/secrets`, { as: fresh });
    expect(two.status).toBe(201);
    const three = await call("POST", `${BASE}/${id}/secrets`, { as: fresh });
    expect(three.status).toBe(409);
    const rec = await call("GET", `${BASE}/${id}`);
    const text = await rec.text();
    expect(text).not.toContain(one.secret.value);
    const parsed = JSON.parse(text);
    expect(parsed.secrets).toHaveLength(2);
    expect(parsed.secrets.map((x: { hint: string }) => x.hint)).toContain(
      `pkeycs_…${one.secret.value.slice(-4)}`,
    );
    const gone = await call("DELETE", `${BASE}/${id}/secrets/${one.secret.id}`);
    expect(gone.status).toBe(200);
    expect(
      (await json(await call("GET", `${BASE}/${id}`))).secrets,
    ).toHaveLength(1);
    const audit = JSON.stringify(await listAudit(w.db, SLUG));
    expect(audit).not.toContain(one.secret.value);
  });

  it("a spa client holds no secret", async () => {
    const { call, fresh, create } = await setup();
    const id = (await create({ key: "site", type: "spa" })).body.client.id;
    const res = await call("POST", `${BASE}/${id}/secrets`, { as: fresh });
    expect(res.status).toBe(409);
  });

  it("edits a console client and keeps its key", async () => {
    const { call, create, json } = await setup();
    const id = (await create()).body.client.id as string;
    const ok = await call("PATCH", `${BASE}/${id}`, {
      body: { name: "Forum", redirectUris: ["https://forum.example.com/new"] },
    });
    expect(ok.status).toBe(200);
    expect((await json(ok)).client).toMatchObject({
      name: "Forum",
      redirectUris: ["https://forum.example.com/new"],
    });
    const bad = await call("PATCH", `${BASE}/${id}`, {
      body: { redirectUris: ["http://nope.example.com"] },
    });
    expect(bad.status).toBe(422);
    const rekey = await call("PATCH", `${BASE}/${id}`, {
      body: { key: "other" },
    });
    expect(rekey.status).toBe(422);
  });

  it("a widening edit needs a fresh step-up; a name change or a narrowing does not", async () => {
    const { call, create, json, plain } = await setup();
    const id = (
      await create({
        redirectUris: [
          "https://forum.example.com/cb",
          "https://b.example.com/cb",
        ],
      })
    ).body.client.id as string;
    const stale = (body: unknown) =>
      call("PATCH", `${BASE}/${id}`, { body, as: plain });
    for (const body of [
      {
        redirectUris: [
          "https://forum.example.com/cb",
          "https://c.example.com/cb",
        ],
      },
      { postLogoutRedirectUris: ["https://forum.example.com/bye"] },
      { type: "spa" },
      { scopes: ["openid", "profile", "email"] },
      { claimsRequired: ["name", "picture"] },
    ]) {
      const res = await stale(body);
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("step_up_required");
    }
    expect((await stale({ name: "Forum" })).status).toBe(200);
    expect(
      (await stale({ redirectUris: ["https://forum.example.com/cb"] })).status,
    ).toBe(200);
    // Nothing the refused edits asked for was stored.
    const after = (await json(await call("GET", `${BASE}/${id}`))).client;
    expect(after.type).toBe("web");
    expect(after.redirectUris).toEqual(["https://forum.example.com/cb"]);
    expect(after.postLogoutRedirectUris).toEqual([]);
  });

  it("a client that leaves web loses its live secrets for good", async () => {
    const { call, create, json } = await setup();
    const id = (await create()).body.client.id as string;
    await call("POST", `${BASE}/${id}/secrets`);
    await call("PATCH", `${BASE}/${id}`, { body: { type: "spa" } });
    await call("PATCH", `${BASE}/${id}`, { body: { type: "web" } });
    expect((await json(await call("GET", `${BASE}/${id}`))).secrets).toEqual(
      [],
    );
  });

  it("a manifest client is read-only here, but can be disabled", async () => {
    const { call, w, fresh, json } = await setup();
    await ingestIdentity(w.db, SLUG, {
      issuer: { enabled: true },
      clients: [
        {
          key: "docs",
          name: "Docs",
          type: "spa",
          redirectUris: ["https://docs.example.com/cb"],
          scopes: ["openid"],
          postLogoutRedirectUris: [],
          claimsRequired: [],
        },
      ],
    });
    const list = await json(await call("GET", BASE));
    const c = list.clients.find((x: any) => x.key === "docs");
    expect(c.origin).toBe("manifest");
    const patch = await call("PATCH", `${BASE}/${c.id}`, {
      body: { name: "X" },
    });
    expect(patch.status).toBe(409);
    expect((await json(patch)).reason).toBe("manifest_owned");
    const del = await call("DELETE", `${BASE}/${c.id}`, {
      as: fresh,
      body: { confirmKey: "docs" },
    });
    expect(del.status).toBe(409);
    const off = await call("POST", `${BASE}/${c.id}/disable`);
    expect(off.status).toBe(200);
    expect((await json(off)).client.status).toBe("disabled");
  });

  it("disable revokes refresh families; delete needs the key and removes the rest", async () => {
    const { call, w, fresh, create } = await setup();
    const id = (await create()).body.client.id as string;
    await w.db.run(
      `INSERT INTO identity_client_grants (account_id, client_id, product, scope_hash, granted_at, changed_at, last_used_at)
       VALUES ('a1', ?, ?, 'h', ?, ?, ?)`,
      id,
      SLUG,
      NOW,
      NOW,
      NOW - 86_400,
    );
    const page = (await (await call("GET", BASE)).json()) as any;
    expect(page.clients[0].people30d).toBe(1);
    expect((await call("POST", `${BASE}/${id}/disable`)).status).toBe(200);
    const wrong = await call("DELETE", `${BASE}/${id}`, {
      as: fresh,
      body: { confirmKey: "nope" },
    });
    expect(wrong.status).toBe(422);
    const del = await call("DELETE", `${BASE}/${id}`, {
      as: fresh,
      body: { confirmKey: "forum" },
    });
    expect(del.status).toBe(200);
    const left = await w.db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM identity_client_grants WHERE client_id = ?",
      id,
    );
    expect(left!.n).toBe(0);
    expect((await call("GET", `${BASE}/${id}`)).status).toBe(404);
  });

  it("is absent while Identity is off", async () => {
    const { call, w } = await setup();
    await setServices(
      w.db,
      SLUG,
      serializeServices({ services: servicesOn("config") }),
      "admin",
      NOW,
    );
    expect((await call("GET", BASE)).status).toBe(404);
  });
});

describe("Platform → Issuer keys", () => {
  it("lists rings without sealed material, and rotates behind a typed slug and a step-up", async () => {
    const { call, w, plain, fresh, json } = await setup();
    await seedProduct(w.db, "other");
    await ensureIssuerKeys(w.env, w.db, SLUG, NOW);
    const list = await call("GET", "/api/platform/issuer-keys");
    const text = await list.text();
    expect(text).not.toContain("sealed");
    const body = JSON.parse(text);
    expect(body.products).toHaveLength(1);
    expect(body.products[0].keys[0]).toMatchObject({ state: "active" });
    const old = body.products[0].keys[0].kid as string;

    const path = `/api/platform/issuer-keys/${SLUG}/rotate`;
    const noStep = await call("POST", path, {
      as: plain,
      body: { confirmSlug: SLUG },
    });
    expect(noStep.status).toBe(403);
    const wrong = await call("POST", path, {
      as: fresh,
      body: { confirmSlug: "x" },
    });
    expect(wrong.status).toBe(422);
    const ok = await call("POST", path, {
      as: fresh,
      body: { confirmSlug: SLUG, reason: "leaked" },
    });
    expect(ok.status).toBe(200);
    const out = await json(ok);
    expect(out.dropped).toBe(1);
    expect(out.keys).toHaveLength(1);
    expect(out.keys[0].kid).not.toBe(old);
    const rec = (await listAudit(w.db, SLUG)).find(
      (a) => a.action === "identity.issuer.key.emergency_rotated",
    );
    expect(rec?.reason).toBe("leaked");
    expect(rec?.actor_name).toBe("Ada");
    expect(
      (
        await call("POST", `/api/platform/issuer-keys/other/rotate`, {
          as: fresh,
          body: { confirmSlug: "other" },
        })
      ).status,
    ).toBe(404);
  });
});

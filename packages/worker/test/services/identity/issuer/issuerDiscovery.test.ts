/**
 * I-21.5: `/.well-known/openid-configuration` and `/jwks` (V5 §12.13.1, §12.13.5) and the form
 * `POST` to `authorize` (§12.4, §12.13.3). The documents answer only while the issuer is on, carry
 * their fixed headers, and `/jwks` never creates a key.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { dispatchWith } from "../../../../src/dispatch.js";
import { ensureIssuerKeys } from "../../../../src/services/identity/issuer/keys.js";
import { NOW } from "../../../seed.js";
import { BASE, SLUG, world, type World } from "../../connect/connectFixture.js";
import { enableIssuer, ingestIdentity } from "./issuerHelpers.js";

let w: World;
beforeEach(async () => {
  w = await world();
});

const get = (path: string, init: RequestInit = {}) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/${path}`, init),
    w.env,
    w.db,
    NOW,
  );
const ISSUER = `${BASE}/${SLUG}/identity`;
const keyCount = async () =>
  (await w.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM identity_issuer_keys",
  ))!.n;

describe("issuer off", () => {
  it("answers the registry's 404 for both documents, and writes nothing", async () => {
    for (const path of [".well-known/openid-configuration", "jwks"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("not_found");
    }
    expect(await keyCount()).toBe(0);
  });

  it("answers 404 again after the manifest turns it off", async () => {
    await enableIssuer(w.db, SLUG);
    expect((await get("jwks")).status).toBe(200);
    await ingestIdentity(w.db, SLUG, {}, NOW + 1);
    expect((await get("jwks")).status).toBe(404);
  });
});

describe("openid-configuration", () => {
  beforeEach(() => enableIssuer(w.db, SLUG));

  it("names this issuer and only the endpoints served", async () => {
    const res = await get(".well-known/openid-configuration");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      scopes_supported: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "pkey:entitlements",
      ],
      response_types_supported: ["code"],
      subject_types_supported: ["pairwise"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      request_parameter_supported: false,
    });
    expect(meta).toMatchObject({
      userinfo_endpoint: `${ISSUER}/userinfo`,
      revocation_endpoint: `${ISSUER}/revoke`,
    });
    // Not served yet: discovery does not name it.
    expect(meta).not.toHaveProperty("end_session_endpoint");
  });

  it("takes GET only, and creates no key", async () => {
    expect(
      (await get(".well-known/openid-configuration", { method: "POST" }))
        .status,
    ).toBe(405);
    expect(await keyCount()).toBe(0);
  });
});

describe("jwks", () => {
  beforeEach(() => enableIssuer(w.db, SLUG));

  it("is an empty set before the first token, and never creates a key", async () => {
    const res = await get("jwks");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [] });
    expect(await keyCount()).toBe(0);
  });

  it("lists the ring's public keys with a short cache and open CORS", async () => {
    const kid = await ensureIssuerKeys(w.env, w.db, SLUG, NOW);
    const res = await get("jwks");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { keys: Record<string, string>[] };
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0]!).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
    expect(body.keys[0]).toMatchObject({
      kid,
      kty: "RSA",
      use: "sig",
      alg: "RS256",
    });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|sealed/);
  });

  it("takes GET only", async () => {
    expect((await get("jwks", { method: "DELETE" })).status).toBe(405);
  });
});

describe("authorize POST", () => {
  const form = (params: Record<string, string>, init: RequestInit = {}) =>
    get("authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      ...init,
    });

  it("reads parameters from the body alone: the query is ignored", async () => {
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/authorize?client_id=${SLUG}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "client_id=nobody",
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(401); // invalid_client from the body's client_id
  });

  it("refuses a body that is not a form, with a page and no redirect", async () => {
    const res = await form(
      {},
      { headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an over-long form body", async () => {
    const res = await form({}, { body: "x=" + "a".repeat(9 * 1024) });
    expect(res.status).toBe(400);
  });

  it("with Identity off, a form POST navigation lands on the friendly card; a script gets the 404", async () => {
    await w.db.run(
      `UPDATE products SET services_json = ? WHERE slug = ?`,
      JSON.stringify({ identity: { enabled: false } }),
      SLUG,
    );
    const nav = await form(
      { client_id: SLUG },
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-mode": "navigate",
        },
      },
    );
    expect(nav.status).toBe(303);
    expect(nav.headers.get("location")).toContain("error=identity_disabled");
    expect((await form({ client_id: SLUG })).status).toBe(404);
    expect((await get("jwks")).status).toBe(404);
  });

  it("a GET still works, and PUT is 405", async () => {
    expect((await get("authorize", { method: "PUT" })).status).toBe(405);
    expect((await get(`authorize?client_id=nobody`)).status).toBe(401);
  });
});

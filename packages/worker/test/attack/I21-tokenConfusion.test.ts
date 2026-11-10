/**
 * I-21.11 attack suite, IS-6 (token confusion and cross-product replay): what stands in for an access
 * token at `userinfo`, and what cannot. Tokens are crafted with the issuer's real key where a valid
 * signature is the point, so each case isolates the one claim or header that must refuse it.
 */
import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { dispatchWith } from "../../src/dispatch.js";
import {
  signIssuerJwt,
  ensureIssuerKeys,
} from "../../src/services/identity/issuer/keys.js";
import { deleteClient } from "../../src/services/identity/issuer/clientsRepo.js";
import { NOW, seedProduct } from "../seed.js";
import { BASE, SLUG } from "../services/connect/connectFixture.js";
import { enableIssuer } from "../services/identity/issuer/issuerHelpers.js";
import { issuerSuite } from "../services/identity/issuer/issuerFlow.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
const { s, codeFor, token, grantForm } = issuerSuite("confusion-pepper");

const userinfo = (t: string, at = NOW) =>
  dispatchWith(
    new Request(`${ISSUER}/userinfo`, {
      headers: { authorization: `Bearer ${t}` },
    }),
    s.w.env,
    s.w.db,
    at,
  );
const base = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: ISSUER,
  sub: s.w.subject,
  client_id: s.spa.clientId,
  scope: "openid profile",
  iat: NOW,
  exp: NOW + 600,
  ...over,
});
const real = async () => {
  const body = (await (
    await token(grantForm(s.spa, await codeFor(s.spa)))
  ).json()) as Record<string, string>;
  return body;
};
const denied = async (t: string, at = NOW) => {
  const res = await userinfo(t, at);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  expect(res.headers.get("cache-control")).toBe("no-store");
};

describe("token confusion (IS-6)", () => {
  it("the genuine access token works; nothing else of the same shape does", async () => {
    const t = await real();
    expect((await userinfo(t.access_token!)).status).toBe(200);
    await denied(t.id_token!);
    await denied(t.refresh_token!);
  });

  it("a validly signed token with one wrong claim or header is refused", async () => {
    await real(); // a person with a grant, so the genuine claims have something to read
    const sign = (typ: "JWT" | "at+jwt", claims: Record<string, unknown>) =>
      signIssuerJwt(s.w.env, s.w.db, SLUG, typ, claims, NOW);
    await denied(await sign("JWT", base()), NOW); // right claims, id_token typ
    await denied(await sign("at+jwt", base({ aud: s.spa.clientId }))); // an id_token's audience
    await denied(
      await sign("at+jwt", base({ aud: "https://evil.example.com" })),
    );
    await denied(
      await sign(
        "at+jwt",
        base({ iss: "https://evil.example.com/acme/identity" }),
      ),
    );
    await denied(await sign("at+jwt", base({ scope: "profile" }))); // no openid
    await denied(await sign("at+jwt", base({ scope: undefined })));
    await denied(await sign("at+jwt", base({ exp: NOW }))); // expired this second
    await denied(await sign("at+jwt", base({ exp: "soon" })));
    await denied(
      await sign("at+jwt", base({ client_id: "cl_" + "z".repeat(22) })),
    ); // unknown client
    await denied(await sign("at+jwt", base({ sub: "ps_" + "n".repeat(22) }))); // a subject of nobody
    await denied(await sign("at+jwt", base({ sub: undefined })));
    expect((await userinfo(await sign("at+jwt", base()))).status).toBe(200);
  });

  it("a token whose client or grant is gone is refused even though it verifies", async () => {
    const t = await real();
    await s.w.db.run("DELETE FROM identity_client_grants");
    await denied(t.access_token!);
    await deleteClient(s.w.db, SLUG, s.spa.clientId);
    await denied(t.access_token!);
  });

  it("another product's token is refused, even claiming this issuer, and a forged key is too", async () => {
    await seedProduct(s.w.db, "rival");
    await enableIssuer(s.w.db, "rival");
    const foreign = await signIssuerJwt(
      s.w.env,
      s.w.db,
      "rival",
      "at+jwt",
      base(),
      NOW,
    );
    await denied(foreign);
    const { privateKey } = await generateKeyPair("RS256", {
      modulusLength: 2048,
    });
    const kid = await ensureIssuerKeys(s.w.env, s.w.db, SLUG, NOW);
    const forged = await new SignJWT(base())
      .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid })
      .sign(privateKey);
    await denied(forged);
  });

  it("alg none, HS256 under any key material and EdDSA are refused before any key is chosen", async () => {
    const t = await real();
    const [, payload] = t.access_token!.split(".");
    const h = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const kid = await ensureIssuerKeys(s.w.env, s.w.db, SLUG, NOW);
    await denied(`${h({ alg: "none", typ: "at+jwt" })}.${payload}.`);
    await denied(
      `${h({ alg: "HS256", typ: "at+jwt", kid })}.${payload}.${Buffer.from("sig").toString("base64url")}`,
    );
    await denied(
      `${h({ alg: "EdDSA", typ: "at+jwt", kid })}.${payload}.${Buffer.from("sig").toString("base64url")}`,
    );
    await denied(
      `${h({ alg: "RS256", typ: "at+jwt", kid: "nope" })}.${payload}.${t.access_token!.split(".")[2]}`,
    );
    await denied(
      `${h({ alg: "RS256", kid })}.${payload}.${t.access_token!.split(".")[2]}`,
    ); // no typ
  });

  it("a tampered payload, a truncated token and an oversized one are refused", async () => {
    const t = await real();
    const [h, , s] = t.access_token!.split(".");
    const evil = Buffer.from(
      JSON.stringify(base({ sub: "ps_" + "e".repeat(22) })),
    ).toString("base64url");
    await denied(`${h}.${evil}.${s}`);
    await denied(t.access_token!.slice(0, -4));
    await denied("a".repeat(9000));
  });

  it("an access token is not an id_token_hint, and an id_token is not a bearer", async () => {
    const t = await real();
    const p = new URLSearchParams({
      response_type: "code",
      client_id: s.spa.clientId,
      redirect_uri: "https://spa.example.com/cb",
      scope: "openid",
      code_challenge: s.pair.challenge,
      code_challenge_method: "S256",
      id_token_hint: t.access_token!,
    });
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
      s.w.env,
      s.w.db,
      NOW,
    );
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error"),
    ).toBe("invalid_request");
    await denied(t.id_token!);
  });
});

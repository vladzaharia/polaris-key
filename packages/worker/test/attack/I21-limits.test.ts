/**
 * I-21.16, IS-14 (cost and denial of service) and the audit rows of the issuer's routes (IS-2):
 * every limit of V5 §12.13.11 fails closed and is its own, and the revoke endpoint leaves a trail.
 * Time is the injected `now`.
 */
import { describe, expect, it } from "vitest";
import { dispatchWith } from "../../src/dispatch.js";
import { putClientGrant } from "../../src/services/identity/issuer/grantsRepo.js";
import { signIssuerJwt } from "../../src/services/identity/issuer/keys.js";
import { NOW } from "../seed.js";
import { BASE, SLUG } from "../services/connect/connectFixture.js";
import { issuerSuite } from "../services/identity/issuer/issuerFlow.js";

const { s, codeFor, token, basic, err } = issuerSuite("limits-pepper");
const ISSUER = `${BASE}/${SLUG}/identity`;

const revoke = (
  headers: Record<string, string>,
  body: Record<string, string>,
) =>
  dispatchWith(
    new Request(`${ISSUER}/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
    }),
    s.w.env,
    s.w.db,
    NOW,
  );

describe("authorize (IS-14)", () => {
  const nav = (ip: string, at: number) => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: s.spa.clientId,
      redirect_uri: s.spa.redirectUris[0]!,
      scope: "openid",
      state: "st",
      code_challenge: s.pair.challenge,
      code_challenge_method: "S256",
    });
    return dispatchWith(
      new Request(`${ISSUER}/authorize?${q}`, {
        headers: { "cf-connecting-ip": ip },
      }),
      s.w.env,
      s.w.db,
      at,
    );
  };

  it("is 60 navigations a minute per client network, and the window reopens", async () => {
    for (let i = 0; i < 60; i++)
      expect((await nav("198.51.100.1", NOW)).status).toBe(303);
    expect((await nav("198.51.100.1", NOW)).status).toBe(429);
    // Another network has its own budget.
    expect((await nav("203.0.113.9", NOW)).status).toBe(303);
    expect((await nav("198.51.100.1", NOW + 61)).status).toBe(303);
  });
});

describe("revoke (IS-14, IS-2)", () => {
  it("is 60 a minute per public client and network, failing closed, and another network or client has its own", async () => {
    const spa = (ip: string) =>
      revoke(
        { "cf-connecting-ip": ip },
        { token: "pkeyo_" + "A".repeat(43), client_id: s.spa.clientId },
      );
    for (let i = 0; i < 60; i++)
      expect((await spa("198.51.100.1")).status).toBe(200);
    const limited = await spa("198.51.100.1");
    expect(limited.status).toBe(429);
    expect(await err(limited)).toBe("rate_limited");
    // A stranger who knows the public client_id cannot use up the client's budget elsewhere.
    expect((await spa("203.0.113.9")).status).toBe(200);
    expect(
      (
        await revoke(basic(s.web.clientId, s.secret), {
          token: "pkeyo_" + "A".repeat(43),
        })
      ).status,
    ).toBe(200);
  });

  it("is 60 a minute per confidential client from anywhere", async () => {
    const web = (n: number) =>
      revoke(
        {
          ...basic(s.web.clientId, s.secret),
          "cf-connecting-ip": `198.51.100.${n}`,
        },
        { token: "pkeyo_" + "A".repeat(43) },
      );
    for (let i = 0; i < 60; i++) expect((await web(i)).status).toBe(200);
    expect((await web(61)).status).toBe(429);
  });

  it("audits a family it revokes, naming the client and holding no token", async () => {
    const code = await codeFor(s.spa);
    const out = (await (
      await token({
        grant_type: "authorization_code",
        client_id: s.spa.clientId,
        code,
        redirect_uri: s.spa.redirectUris[0]!,
        code_verifier: s.pair.verifier,
      })
    ).json()) as { refresh_token: string };
    expect(
      (
        await revoke(
          {},
          { token: out.refresh_token, client_id: s.spa.clientId },
        )
      ).status,
    ).toBe(200);
    const row = await s.w.db.first<{
      target_id: string;
      summary: string;
      actor_sub: string | null;
    }>(
      "SELECT target_id, summary, actor_sub FROM audit WHERE action = 'identity.client.revoke'",
    );
    expect(row?.target_id).toBe(s.spa.clientId);
    expect(JSON.stringify(row)).not.toContain(out.refresh_token);
    // A token that is unknown revokes nothing and audits nothing.
    await revoke(
      {},
      { token: "pkeyo_" + "B".repeat(43), client_id: s.spa.clientId },
    );
    expect(
      (await s.w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'identity.client.revoke'",
      ))!.n,
    ).toBe(1);
  });
});

describe("userinfo (IS-14)", () => {
  it("is 120 a minute per subject and client however many networks it comes from", async () => {
    await putClientGrant(
      s.w.db,
      {
        accountId: s.accountId,
        clientId: s.spa.clientId,
        product: SLUG,
        claimsGranted: ["name"],
        claimsDeclined: [],
        scopes: [],
        scopeHash: "h",
      },
      NOW,
    );
    const at = await signIssuerJwt(
      s.w.env,
      s.w.db,
      SLUG,
      "at+jwt",
      {
        iss: ISSUER,
        aud: ISSUER,
        sub: s.w.subject,
        client_id: s.spa.clientId,
        scope: "openid profile",
        iat: NOW,
        exp: NOW + 600,
        jti: "j",
      },
      NOW,
    );
    const read = (n: number) =>
      dispatchWith(
        new Request(`${ISSUER}/userinfo`, {
          headers: {
            authorization: `Bearer ${at}`,
            "cf-connecting-ip": `203.0.113.${n}`,
          },
        }),
        s.w.env,
        s.w.db,
        NOW,
      );
    // 120 reads from 120 networks: each is far under the network budget.
    for (let i = 0; i < 120; i++) expect((await read(i)).status).toBe(200);
    const limited = await read(130);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });
});

describe("token (IS-14)", () => {
  it("a confidential client's server is not held to a public client's 30 a minute", async () => {
    const bogus = () =>
      token(
        { grant_type: "bogus", client_id: s.web.clientId },
        {
          headers: {
            ...basic(s.web.clientId, s.secret),
            "cf-connecting-ip": "198.51.100.77",
          },
        },
      );
    for (let i = 0; i < 100; i++) expect((await bogus()).status).toBe(400);
  });
});

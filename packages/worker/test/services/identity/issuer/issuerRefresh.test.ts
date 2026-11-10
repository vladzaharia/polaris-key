/**
 * I-21.10 and I-21.11: refresh, revoke and userinfo for a registered client (V5 §12.13.4 rule 2,
 * §12.13.7, §12.13.8). Rotation, reuse revoking the family, another client's token, every re-check a
 * live token passes before it is spent, the code tombstone, RFC 7009, and the live userinfo.
 */
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { dispatchWith } from "../../../../src/dispatch.js";
import {
  setClientStatus,
  updateClient,
  type ClientRecord,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { issuerJwks } from "../../../../src/services/identity/issuer/keys.js";
import {
  ISSUER_REFRESH_IDLE_SECONDS,
  ISSUER_REFRESH_MAX_SECONDS,
} from "@polaris-key/protocol/identity";
import { NOW } from "../../../seed.js";
import { BASE, SLUG } from "../../connect/connectFixture.js";
import { issuerSuite } from "./issuerFlow.js";
import { mkClient } from "./issuerWorld.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
const SPA_CB = "https://spa.example.com/cb";
const { s, codeFor, token, basic, grantForm, err } =
  issuerSuite("refresh-pepper");

type Tokens = {
  access_token: string;
  id_token: string;
  refresh_token: string;
  scope: string;
};
const signIn = async (
  c: ClientRecord = s.spa,
  extra: Record<string, string> = {},
): Promise<Tokens> => {
  const res = await token(
    grantForm(
      c,
      await codeFor(c),
      c.type === "web" ? { client_secret: s.secret, ...extra } : extra,
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
};
/** Another client's attempt on a token is `unauthorized_client`, and the owner's token still works. */
const expectNotTheirs = async (
  res: Response,
  mine: { refresh_token: string },
): Promise<void> => {
  expect(res.status).toBe(400);
  expect(await err(res)).toBe("unauthorized_client");
  expect((await refresh(s.spa, mine.refresh_token)).status).toBe(200);
};
const refresh = (
  c: ClientRecord,
  rt: string,
  over: Record<string, string> = {},
  at = NOW,
) =>
  token(
    {
      grant_type: "refresh_token",
      client_id: c.clientId,
      refresh_token: rt,
      ...(c.type === "web" ? { client_secret: s.secret } : {}),
      ...over,
    },
    { at },
  );
const claimsOf = async (jwt: string) =>
  (
    await jwtVerify(jwt, createLocalJWKSet(await issuerJwks(s.w.db, SLUG)), {
      algorithms: ["RS256"],
      currentDate: new Date(NOW * 1000),
    })
  ).payload;

describe("refresh rotates", () => {
  it("answers new tokens for the same person, a new refresh token, and no nonce", async () => {
    const first = await signIn();
    const res = await refresh(s.spa, first.refresh_token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const next = (await res.json()) as Tokens;
    expect(Object.keys(next).sort()).toEqual([
      "access_token",
      "expires_in",
      "id_token",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(next.scope).toBe(first.scope);
    const [a, b] = [
      await claimsOf(first.id_token),
      await claimsOf(next.id_token),
    ];
    expect(b).toMatchObject({
      sub: a.sub,
      aud: a.aud,
      azp: a.azp,
      auth_time: a.auth_time,
    });
    expect(b.nonce).toBeUndefined();
    expect((await claimsOf(next.access_token)).client_id).toBe(s.spa.clientId);
  });

  it("a s.web client refreshes with its s.secret, and not without it", async () => {
    const first = await signIn(s.web);
    expect(
      (
        await refresh(s.web, first.refresh_token, {
          client_secret: "pkeycs_" + "A".repeat(43),
        })
      ).status,
    ).toBe(401);
    expect((await refresh(s.web, first.refresh_token)).status).toBe(200);
  });

  it("a spent token presented again is invalid_grant and revokes the whole family, with no grace", async () => {
    const first = await signIn();
    const next = (await (
      await refresh(s.spa, first.refresh_token)
    ).json()) as Tokens;
    const replay = await refresh(s.spa, first.refresh_token);
    expect(await err(replay)).toBe("invalid_grant");
    expect(await err(await refresh(s.spa, next.refresh_token))).toBe(
      "invalid_grant",
    );
    const a = await s.w.db.first(
      "SELECT 1 FROM audit WHERE action = 'identity.refresh.reuse'",
    );
    expect(a).not.toBeNull();
  });

  it("scope may narrow and must keep openid; it never widens", async () => {
    const first = await signIn();
    const narrow = await refresh(s.spa, first.refresh_token, {
      scope: "openid profile",
    });
    expect(((await narrow.json()) as Tokens).scope).toBe("openid profile");
    const again = (await signIn()).refresh_token;
    for (const scope of [
      "profile",
      "openid profile bogus",
      "openid pkey:licenses",
      "",
    ]) {
      const res = await refresh(s.spa, again, { scope });
      expect(res.status, scope).toBe(400);
      expect(await err(res), scope).toBe("invalid_scope");
    }
    // Refused scopes spent nothing.
    expect((await refresh(s.spa, again)).status).toBe(200);
  });

  it("refuses unknown, malformed and missing tokens", async () => {
    expect(await err(await refresh(s.spa, "pkeyo_" + "A".repeat(43)))).toBe(
      "invalid_grant",
    );
    expect(await err(await refresh(s.spa, "nonsense"))).toBe("invalid_grant");
    const f = { grant_type: "refresh_token", client_id: s.spa.clientId };
    expect(await err(await token(f))).toBe("invalid_request");
  });

  it("ends 30 days after its last use and 90 days after the family opened", async () => {
    const first = await signIn();
    expect(
      await err(
        await refresh(
          s.spa,
          first.refresh_token,
          {},
          NOW + ISSUER_REFRESH_IDLE_SECONDS,
        ),
      ),
    ).toBe("invalid_grant");
    let rt = (await signIn()).refresh_token;
    let at = NOW;
    while (at + 25 * 86_400 < NOW + ISSUER_REFRESH_MAX_SECONDS) {
      at += 25 * 86_400;
      const r = await refresh(s.spa, rt, {}, at);
      if (r.status !== 200) throw new Error(await err(r));
      rt = ((await r.json()) as Tokens).refresh_token;
    }
    expect(
      await err(await refresh(s.spa, rt, {}, NOW + ISSUER_REFRESH_MAX_SECONDS)),
    ).toBe("invalid_grant");
  });
});

describe("another client's token", () => {
  it("is unauthorized_client and revokes nothing", async () => {
    const mine = await signIn(s.spa);
    const other = await mkClient(s.w, {
      key: "spa-two",
      type: "spa",
      redirectUris: ["https://two.example.com/cb"],
    });
    const res = await refresh(other, mine.refresh_token);
    await expectNotTheirs(res, mine);
  });
});

describe("a live token is checked again before it is spent", () => {
  const stays = async (rt: string, code: string, c: ClientRecord = s.spa) => {
    const res = await refresh(c, rt);
    expect(await err(res)).toBe(code);
  };

  it("the grant must exist and still cover the scope", async () => {
    const t1 = await signIn();
    await s.w.db.run("UPDATE identity_client_grants SET scopes_json = '[]'");
    await stays(t1.refresh_token, "invalid_grant");
    await s.w.db.run("DELETE FROM identity_client_grants");
    await stays(t1.refresh_token, "invalid_grant");
  });

  it("the redirect URI and the scopes the family was issued for must still be registered", async () => {
    const t1 = await signIn();
    await updateClient(
      s.w.db,
      SLUG,
      s.spa.clientId,
      { redirectUris: ["https://moved.example.com/cb"] },
      NOW,
    );
    await stays(t1.refresh_token, "invalid_grant");
    await updateClient(
      s.w.db,
      SLUG,
      s.spa.clientId,
      { redirectUris: [SPA_CB] },
      NOW,
    );
    expect((await refresh(s.spa, t1.refresh_token)).status).toBe(200);
    const t2 = await signIn();
    await updateClient(
      s.w.db,
      SLUG,
      s.spa.clientId,
      { scopes: ["openid", "profile"] },
      NOW,
    );
    await stays(t2.refresh_token, "invalid_grant");
  });

  it("the client must be active and the issuer on", async () => {
    const t1 = await signIn();
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "disabled", NOW);
    expect((await refresh(s.spa, t1.refresh_token)).status).toBe(401);
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "active", NOW);
    const t2 = await signIn();
    await s.w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect((await refresh(s.spa, t2.refresh_token)).status).toBe(401);
  });

  it("the account must be live", async () => {
    const t1 = await signIn();
    await s.w.db.run(
      "UPDATE accounts SET status = 'disabled' WHERE id = ?",
      s.accountId,
    );
    await stays(t1.refresh_token, "invalid_grant");
  });

  it("the claims follow the grant as it stands now", async () => {
    const t1 = await signIn();
    await s.w.db.run(
      'UPDATE identity_client_grants SET claims_granted_json = \'["name"]\', claims_declined_json = \'["picture","email"]\'',
    );
    const next = (await (
      await refresh(s.spa, t1.refresh_token)
    ).json()) as Tokens;
    const p = await claimsOf(next.id_token);
    expect(p.email).toBeUndefined();
    expect(p.name).toBeTruthy();
  });
});

describe("the code tombstone (RFC 6749 §4.1.2)", () => {
  it("a code presented again after redemption revokes the family it opened", async () => {
    const code = await codeFor(s.spa);
    const res = await token(grantForm(s.spa, code));
    const tokens = (await res.json()) as Tokens;
    expect((await refresh(s.spa, tokens.refresh_token)).status).toBe(200);
    const again = await token(grantForm(s.spa, code));
    expect(await err(again)).toBe("invalid_grant");
    // Every token of the family is dead, the one just rotated included.
    const rows = await s.w.db.all<{ revoked_at: number | null }>(
      "SELECT revoked_at FROM identity_refresh_tokens",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect(
      await s.w.db.first(
        "SELECT 1 FROM audit WHERE action = 'identity.refresh.code_reuse'",
      ),
    ).not.toBeNull();
  });

  it("another client presenting the code revokes nothing, and a code that opened no family does nothing", async () => {
    const code = await codeFor(s.spa);
    const tokens = (await (
      await token(grantForm(s.spa, code))
    ).json()) as Tokens;
    const other = await mkClient(s.w, {
      key: "spa-two",
      type: "spa",
      redirectUris: ["https://two.example.com/cb"],
    });
    await token(
      grantForm(other, code, { redirect_uri: "https://two.example.com/cb" }),
    );
    expect((await refresh(s.spa, tokens.refresh_token)).status).toBe(200);
    const plain = await codeFor(s.spa, { scope: "openid profile" }, ["name"]);
    expect((await token(grantForm(s.spa, plain))).status).toBe(200);
    expect(await err(await token(grantForm(s.spa, plain)))).toBe(
      "invalid_grant",
    );
  });
});

describe("revoke (RFC 7009)", () => {
  const revoke = (
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(form).toString(),
      }),
      s.w.env,
      s.w.db,
      NOW,
    );

  it("ends the family of the client's own refresh token with a bare 200", async () => {
    const t1 = await signIn();
    const next = (await (
      await refresh(s.spa, t1.refresh_token)
    ).json()) as Tokens;
    const res = await revoke({
      token: next.refresh_token,
      client_id: s.spa.clientId,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await err(await refresh(s.spa, next.refresh_token))).toBe(
      "invalid_grant",
    );
  });

  it("a s.web client authenticates, and an access, unknown or malformed token is a quiet 200", async () => {
    const t1 = await signIn(s.web);
    expect(
      (await revoke({ token: t1.refresh_token, client_id: s.web.clientId }))
        .status,
    ).toBe(401);
    expect(
      (
        await revoke(
          { token: t1.access_token },
          basic(s.web.clientId, s.secret),
        )
      ).status,
    ).toBe(200);
    expect((await refresh(s.web, t1.refresh_token)).status).toBe(200);
    for (const t of ["pkeyo_" + "Z".repeat(43), "junk", "pkeyo_short"])
      expect(
        (await revoke({ token: t }, basic(s.web.clientId, s.secret))).status,
      ).toBe(200);
  });

  it("another client's token is unauthorized_client and revokes nothing", async () => {
    const mine = await signIn(s.spa);
    const other = await mkClient(s.w, {
      key: "spa-two",
      type: "spa",
      redirectUris: ["https://two.example.com/cb"],
    });
    const res = await revoke({
      token: mine.refresh_token,
      client_id: other.clientId,
    });
    await expectNotTheirs(res, mine);
  });

  it("needs a token, a form, a POST and the issuer on", async () => {
    expect((await revoke({ client_id: s.spa.clientId })).status).toBe(400);
    const json = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      s.w.env,
      s.w.db,
      NOW,
    );
    expect(json.status).toBe(400);
    const get = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/revoke`),
      s.w.env,
      s.w.db,
      NOW,
    );
    expect(get.status).toBe(405);
    await s.w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect(
      (await revoke({ token: "x", client_id: s.spa.clientId })).status,
    ).toBe(404);
  });

  it("answers a s.spa client's own origin with CORS and no credentials", async () => {
    const t1 = await signIn();
    const res = await revoke(
      { token: t1.refresh_token, client_id: s.spa.clientId },
      { origin: "https://spa.example.com" },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("userinfo", () => {
  const info = (init: RequestInit = {}, at = NOW) =>
    dispatchWith(new Request(`${ISSUER}/userinfo`, init), s.w.env, s.w.db, at);
  const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

  it("answers the granted claims, read live, and the entitlement keys", async () => {
    const t1 = await signIn();
    const res = await info(bearer(t1.access_token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sub).toBe(s.w.subject);
    expect(body.email).toBe("ada@example.com");
    expect("picture" in body).toBe(false);
    expect(Array.isArray(body["pkey:entitlements"])).toBe(true);
    await s.w.db.run(
      "UPDATE accounts SET display_name = 'Ada Renamed' WHERE id = ?",
      s.accountId,
    );
    expect(
      ((await (await info(bearer(t1.access_token))).json()) as { name: string })
        .name,
    ).toBe("Ada Renamed");
  });

  it("takes the token in a POST form, and answers a s.spa client's origin", async () => {
    const t1 = await signIn();
    const res = await info({
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://spa.example.com",
      },
      body: `access_token=${t1.access_token}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.com",
    );
  });

  it("refuses with one invalid_token: no token, an id_token, an expired token, a gone grant or client", async () => {
    const t1 = await signIn();
    const bare = await info();
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe("Bearer");
    for (const t of [
      t1.id_token,
      "junk",
      t1.refresh_token,
      "pkeyt_" + "A".repeat(43),
    ]) {
      const res = await info(bearer(t));
      expect(res.status, t.slice(0, 8)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer error="invalid_token"',
      );
      expect(await err(res)).toBe("invalid_token");
    }
    expect((await info(bearer(t1.access_token), NOW + 600)).status).toBe(401);
    expect((await info(bearer(t1.access_token), NOW + 599)).status).toBe(200);
    await s.w.db.run("DELETE FROM identity_client_grants");
    expect((await info(bearer(t1.access_token))).status).toBe(401);
    const t2 = await signIn();
    await setClientStatus(s.w.db, SLUG, s.spa.clientId, "disabled", NOW);
    expect((await info(bearer(t2.access_token))).status).toBe(401);
  });

  it("answers the registry's 404 while the issuer is off", async () => {
    const t1 = await signIn();
    await s.w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect((await info(bearer(t1.access_token))).status).toBe(404);
  });
});

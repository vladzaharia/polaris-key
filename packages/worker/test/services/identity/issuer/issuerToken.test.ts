/**
 * I-21.9: `token` for a registered client (V5 §12.13.4). Client authentication, the code (PKCE, the
 * nonce-only code and its fixed proof), the tokens (RS256 under the product's issuer key, claims only
 * as granted), per-client CORS, and `resolveSubjectEntitlements`. Time is the injected `now`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  compactVerify,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import { dispatchWith } from "../../../../src/dispatch.js";
import { SETTINGS } from "../../../../src/mount.js";
import {
  addClientSecret,
  revokeClientSecret,
  type ClientRecord,
} from "../../../../src/services/identity/issuer/clientsRepo.js";
import { deleteClient } from "../../../../src/services/identity/issuer/clientsRepo.js";
import { issuerJwks } from "../../../../src/services/identity/issuer/keys.js";
import { handleSignInContinue } from "../../../../src/services/identity/passthrough/continue.js";
import { resolveSubjectEntitlements } from "../../../../src/core/licensing/subjectEntitlements.js";
import {
  getOrCreateAccountByEmail,
  linkLicense,
} from "../../../../src/services/identity/portal/repo.js";
import { subjectFor } from "../../../../src/core/accounts/accountSubjects.js";
import { NOW, seedLicenseWithKey, seedProduct } from "../../../seed.js";
import { BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
const SPA_CB = "https://spa.example.com/cb";
const WEB_CB = "https://forum.example.com/cb";
let w: World;
let accountId: string;
let spa: ClientRecord;
let web: ClientRecord;
let secret: string;
let pair: { verifier: string; challenge: string };

const mk = (
  key: string,
  type: "web" | "spa" | "native",
  redirectUris: string[],
) => mkClient(w, { key, type, redirectUris });

beforeEach(async () => {
  ({ w, accountId, pair } = await issuerWorld());
  (w.env as unknown as Record<string, unknown>).KEY_HASH_PEPPER =
    "token-pepper";
  spa = await mk("spa-app", "spa", [SPA_CB]);
  web = await mk("forum", "web", [WEB_CB]);
  secret = (await addClientSecret(w.env, w.db, SLUG, web.clientId, NOW))!
    .secret;
});

/** A code for `client` through authorize and Continue, the way a person gets one. */
async function codeFor(
  client: ClientRecord,
  extra: Record<string, string> = {},
  consent: string[] = ["name", "email"],
): Promise<string> {
  const redirect = client.redirectUris[0]!;
  const p = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirect,
    scope: "openid profile email offline_access pkey:entitlements",
    state: "s",
    ...(client.type === "web"
      ? { nonce: "n-1" }
      : { code_challenge: pair.challenge, code_challenge_method: "S256" }),
    ...extra,
  });
  const auth = await dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/authorize?${p}`),
    w.env,
    w.db,
    NOW,
  );
  expect(auth.status).toBe(303);
  const handle = /request=(rq_[A-Za-z0-9_-]{22})/.exec(
    auth.headers.get("location")!,
  )![1]!;
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const res = await handleSignInContinue(
    new Request(`${BASE}/api/x`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ consent: { claims: consent } }),
    }),
    w.env,
    w.db,
    { accountId },
    handle,
    NOW,
    SETTINGS,
    NOW,
  );
  expect(res.status).toBe(200);
  return new URL(
    ((await res.json()) as { redirect: string }).redirect,
  ).searchParams.get("code")!;
}

type Form = Record<string, string>;
const token = (
  form: Form,
  init: { headers?: Record<string, string>; at?: number } = {},
) =>
  dispatchWith(
    new Request(`${BASE}/${SLUG}/identity/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...init.headers,
      },
      body: new URLSearchParams(form).toString(),
    }),
    w.env,
    w.db,
    init.at ?? NOW,
  );
const basic = (id: string, sec: string) => ({
  authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(sec)}`).toString("base64")}`,
});
const grantForm = (c: ClientRecord, code: string, over: Form = {}): Form => ({
  grant_type: "authorization_code",
  client_id: c.clientId,
  code,
  redirect_uri: c.redirectUris[0]!,
  ...(c.type === "web" ? {} : { code_verifier: pair.verifier }),
  ...over,
});
const err = async (res: Response) =>
  ((await res.json()) as { error: string }).error;

describe("a public client redeems its code", () => {
  it("answers exactly the §12.13.4 members, signed RS256 under the product's key, no-store", async () => {
    const res = await token(grantForm(spa, await codeFor(spa)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, string | number>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token",
      "expires_in",
      "id_token",
      "refresh_token",
      "scope",
      "token_type",
    ]);
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 600,
      scope: "openid profile email offline_access pkey:entitlements",
    });
    expect(body.refresh_token).toMatch(/^pkeyo_[A-Za-z0-9_-]{43}$/);
    const keys = createLocalJWKSet(await issuerJwks(w.db, SLUG));
    const id = await jwtVerify(body.id_token as string, keys, {
      algorithms: ["RS256"],
      typ: "JWT",
      issuer: ISSUER,
      audience: spa.clientId,
      currentDate: new Date(NOW * 1000),
    });
    expect(id.payload).toMatchObject({
      sub: w.subject,
      azp: spa.clientId,
      auth_time: NOW,
      iat: NOW,
      exp: NOW + 600,
      email: "ada@example.com",
    });
    expect(id.payload.nonce).toBeUndefined();
    expect(typeof id.payload.email_verified).toBe("boolean");
    // picture was not granted: absent, never null.
    expect("picture" in id.payload).toBe(false);
    const at = await jwtVerify(body.access_token as string, keys, {
      algorithms: ["RS256"],
      typ: "at+jwt",
      issuer: ISSUER,
      audience: ISSUER,
      currentDate: new Date(NOW * 1000),
    });
    expect(at.payload).toMatchObject({
      sub: w.subject,
      client_id: spa.clientId,
      scope: body.scope,
      auth_time: NOW,
      exp: NOW + 600,
    });
    expect(at.payload.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(decodeProtectedHeader(body.id_token as string).typ).toBe("JWT");
    expect(decodeProtectedHeader(body.access_token as string).typ).toBe(
      "at+jwt",
    );
    // The id_token and the access token never stand in for each other.
    await expect(
      jwtVerify(body.id_token as string, keys, {
        algorithms: ["RS256"],
        typ: "at+jwt",
        currentDate: new Date(NOW * 1000),
      }),
    ).rejects.toThrow();
  });

  it("at_hash is the left half of SHA-256 of the access token", async () => {
    const body = (await (
      await token(grantForm(spa, await codeFor(spa)))
    ).json()) as Record<string, string>;
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(body.access_token),
      ),
    );
    const want = Buffer.from(digest.slice(0, 16)).toString("base64url");
    const keys = createLocalJWKSet(await issuerJwks(w.db, SLUG));
    const { payload } = await compactVerify(body.id_token!, keys, {
      algorithms: ["RS256"],
    });
    expect(JSON.parse(new TextDecoder().decode(payload)).at_hash).toBe(want);
  });

  it("carries only the claims granted, the nonce when sent, and no refresh token without offline_access", async () => {
    const code = await codeFor(spa, { scope: "openid profile", nonce: "n-9" }, [
      "name",
    ]);
    const body = (await (await token(grantForm(spa, code))).json()) as Record<
      string,
      string
    >;
    expect(body.refresh_token).toBeUndefined();
    expect(body.scope).toBe("openid profile");
    const keys = createLocalJWKSet(await issuerJwks(w.db, SLUG));
    const { payload } = await jwtVerify(body.id_token!, keys, {
      algorithms: ["RS256"],
      currentDate: new Date(NOW * 1000),
    });
    expect(payload.nonce).toBe("n-9");
    expect(payload.email).toBeUndefined();
    expect(payload["pkey:entitlements"]).toBeUndefined();
    expect(payload.name).toBeTruthy();
  });

  it("refuses a wrong, missing or malformed verifier, a wrong redirect, and a replay", async () => {
    const attempts: [string, (c: string) => Form][] = [
      [
        "wrong verifier",
        (c) => grantForm(spa, c, { code_verifier: "B".repeat(43) }),
      ],
      [
        "no verifier",
        (c) => {
          const f = grantForm(spa, c);
          delete f.code_verifier;
          return f;
        },
      ],
      [
        "wrong redirect",
        (c) => grantForm(spa, c, { redirect_uri: SPA_CB + "/" }),
      ],
    ];
    for (const [name, build] of attempts) {
      const code = await codeFor(spa);
      const res = await token(build(code));
      expect(res.status, name).toBe(400);
      expect(await err(res), name).toBe("invalid_grant");
      // The attempt spent the code: the right request now finds nothing.
      expect(await err(await token(grantForm(spa, code))), name).toBe(
        "invalid_grant",
      );
    }
    const code = await codeFor(spa);
    expect((await token(grantForm(spa, code))).status).toBe(200);
    expect(await err(await token(grantForm(spa, code)))).toBe("invalid_grant");
  });

  it("the fixed no-challenge string is never accepted as a verifier, and a malformed one spends nothing", async () => {
    const code = await codeFor(spa);
    const res = await token(
      grantForm(spa, code, { code_verifier: "pkey:no-challenge" }),
    );
    expect(res.status).toBe(400);
    expect(await err(res)).toBe("invalid_grant");
    expect((await token(grantForm(spa, code))).status).toBe(200);
  });

  it("a missing redirect_uri or code is invalid_request and spends nothing", async () => {
    const code = await codeFor(spa);
    const f = grantForm(spa, code);
    delete f.redirect_uri;
    const res = await token(f);
    expect(res.status).toBe(400);
    expect(await err(res)).toBe("invalid_request");
    expect((await token(grantForm(spa, code))).status).toBe(200);
  });

  it("a code is the client's own, and a deleted grant or client voids it", async () => {
    const other = await mk("spa-two", "spa", ["https://two.example.com/cb"]);
    const code = await codeFor(spa);
    expect(
      await err(await token(grantForm(other, code, { redirect_uri: SPA_CB }))),
    ).toBe("invalid_grant");
    const c2 = await codeFor(spa);
    await w.db.run("DELETE FROM identity_client_grants");
    expect(await err(await token(grantForm(spa, c2)))).toBe("invalid_grant");
    const c3 = await codeFor(spa);
    await deleteClient(w.db, SLUG, spa.clientId);
    const res = await token(grantForm(spa, c3));
    expect(res.status).toBe(401);
  });
});

describe("a web client authenticates before anything else", () => {
  it("accepts Basic and post, and a nonce-only code redeems without a verifier", async () => {
    const a = await token(
      grantForm(web, await codeFor(web), { client_id: web.clientId }),
      { headers: basic(web.clientId, secret) },
    );
    expect(a.status).toBe(200);
    const f = grantForm(web, await codeFor(web), { client_secret: secret });
    expect((await token(f)).status).toBe(200);
  });

  it("refuses both methods, neither, a wrong, revoked or short secret, and a header/body id mismatch", async () => {
    const attempt = async (
      form: Form,
      headers: Record<string, string> = {},
    ) => {
      const code = await codeFor(web);
      const res = await token(
        { ...grantForm(web, code), ...form },
        { headers },
      );
      expect(res.status, JSON.stringify(form)).toBe(401);
      expect(await err(res)).toBe("invalid_client");
      return { res, code };
    };
    await attempt({}); // neither
    await attempt({ client_secret: secret }, basic(web.clientId, secret)); // both
    await attempt({ client_secret: "pkeycs_" + "A".repeat(43) });
    await attempt({ client_secret: "" });
    const wrongBasic = await attempt(
      {},
      basic(web.clientId, "pkeycs_" + "A".repeat(43)),
    );
    expect(wrongBasic.res.headers.get("www-authenticate")).toMatch(/^Basic/);
    await attempt({ client_id: spa.clientId }, basic(web.clientId, secret)); // mismatch
    await attempt({}, { authorization: "Basic !!!notbase64" });
    await attempt({}, { authorization: "Bearer " + secret });
    const live = (await addClientSecret(w.env, w.db, SLUG, web.clientId, NOW))!;
    await revokeClientSecret(w.db, SLUG, web.clientId, live.id, NOW);
    await attempt({ client_secret: live.secret });
  });

  it("a failed authentication does not burn the code", async () => {
    const code = await codeFor(web);
    expect((await token(grantForm(web, code))).status).toBe(401);
    expect(
      (await token(grantForm(web, code, { client_secret: secret }))).status,
    ).toBe(200);
  });

  it("the fixed proof string as a verifier is refused for a nonce-only code", async () => {
    const code = await codeFor(web);
    const res = await token(
      grantForm(web, code, {
        client_secret: secret,
        code_verifier: "pkey:no-challenge",
      }),
    );
    expect(await err(res)).toBe("invalid_grant");
    expect(
      (await token(grantForm(web, code, { client_secret: secret }))).status,
    ).toBe(200);
  });

  it("a verifier for a nonce-only code, even the fixed proof string, is invalid_grant and ends the code", async () => {
    for (const verifier of [pair.verifier, "A".repeat(43)]) {
      const code = await codeFor(web);
      const res = await token(
        grantForm(web, code, {
          client_secret: secret,
          code_verifier: verifier,
        }),
      );
      expect(res.status, verifier).toBe(400);
      expect(await err(res)).toBe("invalid_grant");
      expect(
        await err(await token(grantForm(web, code, { client_secret: secret }))),
      ).toBe("invalid_grant");
    }
  });

  it("a code with a challenge needs its verifier, and a web client's PKCE code redeems with it", async () => {
    const withPkce = await codeFor(web, {
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
    });
    const noVerifier = await token(
      grantForm(web, withPkce, { client_secret: secret }),
    );
    expect(await err(noVerifier)).toBe("invalid_grant");
    const again = await codeFor(web, {
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
    });
    expect(
      (
        await token(
          grantForm(web, again, {
            client_secret: secret,
            code_verifier: pair.verifier,
          }),
        )
      ).status,
    ).toBe(200);
  });
});

describe("public clients and unknown clients", () => {
  it("a public client sending a secret anywhere, or an unknown client, is invalid_client", async () => {
    const code = await codeFor(spa);
    expect(
      (await token(grantForm(spa, code, { client_secret: secret }))).status,
    ).toBe(401);
    expect(
      (
        await token(grantForm(spa, code), {
          headers: basic(spa.clientId, secret),
        })
      ).status,
    ).toBe(401);
    expect(
      (await token(grantForm(spa, code, { client_id: "cl_" + "z".repeat(22) })))
        .status,
    ).toBe(401);
    expect((await token(grantForm(spa, code))).status).toBe(200);
  });

  it("the issuer off makes a registered client unknown", async () => {
    const code = await codeFor(spa);
    await w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect((await token(grantForm(spa, code))).status).toBe(401);
  });
});

describe("grants and shapes", () => {
  it("token exchange and restore are unauthorized_client; refresh and client_credentials are not served yet", async () => {
    for (const grant of [
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "urn:polaris-key:grant-type:restore",
    ]) {
      const res = await token({ grant_type: grant, client_id: spa.clientId });
      expect(res.status, grant).toBe(400);
      expect(await err(res)).toBe("unauthorized_client");
    }
    for (const grant of [
      "client_credentials",
      "refresh_token",
      "password",
      "bogus",
    ]) {
      const res = await token({ grant_type: grant, client_id: spa.clientId });
      expect(await err(res), grant).toBe("unsupported_grant_type");
    }
  });

  it("a JSON body or a repeated parameter is invalid_request", async () => {
    const json = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: spa.clientId,
        }),
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(await err(json)).toBe("invalid_request");
    const dup = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=authorization_code&client_id=${spa.clientId}&client_id=${spa.clientId}`,
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(await err(dup)).toBe("invalid_request");
  });

  it("never reads X-PKey-Device", async () => {
    const res = await token(grantForm(spa, await codeFor(spa)), {
      headers: { "x-pkey-device": "!!" },
    });
    expect(res.status).toBe(200);
  });
});

describe("CORS (§12.13.4)", () => {
  const withOrigin = (origin: string) => ({ origin });
  it("a spa client's answer is readable from its own redirect origin, never with credentials", async () => {
    const res = await token(grantForm(spa, await codeFor(spa)), {
      headers: withOrigin("https://spa.example.com"),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.com",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("x-pkey-client-cors")).toBeNull();
    const other = await token(grantForm(spa, await codeFor(spa)), {
      headers: withOrigin("https://evil.example.com"),
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(other.headers.get("x-pkey-client-cors")).toBeNull();
  });

  it("another client's origin, a web client and a failed authentication get no allow-origin", async () => {
    await mk("spa-two", "spa", ["https://two.example.com/cb"]);
    const cross = await token(grantForm(spa, await codeFor(spa)), {
      headers: withOrigin("https://two.example.com"),
    });
    expect(cross.headers.get("access-control-allow-origin")).toBeNull();
    const webRes = await token(
      grantForm(web, await codeFor(web), { client_secret: secret }),
      { headers: withOrigin("https://forum.example.com") },
    );
    expect(webRes.status).toBe(200);
    expect(webRes.headers.get("access-control-allow-origin")).toBeNull();
    const bad = await token(
      grantForm(spa, "x".repeat(43), { client_id: "cl_" + "z".repeat(22) }),
      { headers: withOrigin("https://spa.example.com") },
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("a preflight allows a spa client's origin and no other", async () => {
    const pre = (origin: string) =>
      dispatchWith(
        new Request(`${BASE}/${SLUG}/identity/token`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST" },
        }),
        w.env,
        w.db,
        NOW,
      );
    const ok = await pre("https://spa.example.com");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://spa.example.com",
    );
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(
      (await pre("https://evil.example.com")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
    // Issuer off: no extra origin.
    await w.db.run(
      "DELETE FROM product_settings WHERE key = 'identity.issuer.enabled'",
    );
    expect(
      (await pre("https://spa.example.com")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });
});

describe("resolveSubjectEntitlements (LX-01 §2.2)", () => {
  const flag = (key: string, userGrant: boolean) => ({
    key,
    kind: "flag",
    category: "Plan",
    label: key,
    schema: { type: "boolean" },
    default: false,
    ...(userGrant ? { userGrant: true, grantLabel: key } : {}),
  });
  const CATALOG = {
    schemaVersion: 1,
    entries: [flag("vpn", true), flag("studio", true), flag("beta", false)],
  };
  async function holder(
    over: {
      expiresAt?: number | null;
      entitlements?: Record<string, unknown>;
    } = {},
  ) {
    await seedProduct(w.db, "ent", { catalog: CATALOG });
    const { licenseId } = await seedLicenseWithKey(w.db, "ent", {
      expiresAt: over.expiresAt ?? null,
      entitlements: (over.entitlements ?? {
        vpn: { state: "enforced", value: true, updatedAt: NOW },
        studio: { state: "enforced", value: true, updatedAt: NOW },
        beta: { state: "enforced", value: true, updatedAt: NOW },
      }) as never,
    });
    const account = await getOrCreateAccountByEmail(
      w.db,
      "grace@example.com",
      NOW,
    );
    await linkLicense(w.db, account.id, "ent", licenseId, "admin", NOW);
    return subjectFor(w.db, account.id, "ent", NOW);
  }

  it("lists the userGrant flags that are on, sorted, and nothing else", async () => {
    const sub = await holder();
    expect(await resolveSubjectEntitlements(w.db, "ent", sub, NOW)).toEqual([
      "studio",
      "vpn",
    ]);
  });

  it("is empty for an unknown subject, an expired licence, a false flag and a product with no catalog", async () => {
    const sub = await holder({ expiresAt: NOW - 10 });
    expect(await resolveSubjectEntitlements(w.db, "ent", sub, NOW)).toEqual([]);
    expect(
      await resolveSubjectEntitlements(
        w.db,
        "ent",
        "ps_" + "u".repeat(22),
        NOW,
      ),
    ).toEqual([]);
    expect(
      await resolveSubjectEntitlements(w.db, SLUG, w.subject, NOW),
    ).toBeInstanceOf(Array);
    expect(
      await resolveSubjectEntitlements(w.db, "nobody", w.subject, NOW),
    ).toEqual([]);
  });

  it("an access token carries the claim only when pkey:entitlements was granted", async () => {
    const withIt = (await (
      await token(grantForm(spa, await codeFor(spa)))
    ).json()) as Record<string, string>;
    const keys = createLocalJWKSet(await issuerJwks(w.db, SLUG));
    const { payload } = await jwtVerify(withIt.access_token!, keys, {
      algorithms: ["RS256"],
      currentDate: new Date(NOW * 1000),
    });
    expect(Array.isArray(payload["pkey:entitlements"])).toBe(true);
    const without = (await (
      await token(grantForm(spa, await codeFor(spa, { scope: "openid" }, [])))
    ).json()) as Record<string, string>;
    const p2 = (
      await jwtVerify(without.access_token!, keys, {
        algorithms: ["RS256"],
        currentDate: new Date(NOW * 1000),
      })
    ).payload;
    expect(p2["pkey:entitlements"]).toBeUndefined();
  });
});

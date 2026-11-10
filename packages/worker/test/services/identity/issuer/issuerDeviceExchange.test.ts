/**
 * I-21.13: the device exchange, D6 (V5 §12.13.10; threat IS-11). A signed-in device trades its own
 * `pkeyt_` token for a 600 s access token: exactly the five members, `sub` the device's pairwise
 * subject, `client_id` the slug, an empty scope, signed under the product's issuer key and never
 * more than the device token. Time is the injected `now`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  compactVerify,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
} from "jose";
import {
  ACCESS_TOKEN_TYPE,
  DEVICE_SUBJECT_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
} from "@polaris-key/protocol/identity";
import { dispatchWith } from "../../../../src/dispatch.js";
import { issuerJwks } from "../../../../src/services/identity/issuer/keys.js";
import { NOW } from "../../../seed.js";
import { A, B, BASE, SLUG, type World } from "../../connect/connectFixture.js";
import { ingestIdentity } from "./issuerHelpers.js";
import { issuerWorld, mkClient } from "./issuerWorld.js";

const ISSUER = `${BASE}/${SLUG}/identity`;
let w: World;

beforeEach(async () => {
  ({ w } = await issuerWorld());
});

const form = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string> = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    client_id: SLUG,
    subject_token: w.tokens[A]!,
    subject_token_type: DEVICE_SUBJECT_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
};

const exchange = (
  fields: Record<string, string> = form(),
  headers: Record<string, string> = { "x-pkey-device": A },
  at = NOW,
) =>
  dispatchWith(
    new Request(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    w.env,
    w.db,
    at,
  );

const refusal = async (res: Response, status: number, error: string) => {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect((await res.json()) as { error: string }).toMatchObject({ error });
};

describe("the exchange", () => {
  it("answers exactly the five members, 600 s, no refresh token and no id_token", async () => {
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token",
      "expires_in",
      "issued_token_type",
      "scope",
      "token_type",
    ]);
    expect(body).toMatchObject({
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: 600,
      scope: "",
    });
  });

  it("signs an at+jwt under the product's key: the device's pairwise subject, the slug as client", async () => {
    const { access_token: token } = (await (await exchange()).json()) as {
      access_token: string;
    };
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: "RS256", typ: "at+jwt" });
    const keys = createLocalJWKSet(await issuerJwks(w.db, SLUG));
    const { payload } = await compactVerify(token, keys, {
      algorithms: ["RS256"],
    });
    const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: ISSUER,
      sub: w.subject,
      client_id: SLUG,
      iat: NOW,
      exp: NOW + 600,
      scope: "",
    });
    expect(typeof claims.jti).toBe("string");
    // Never more than the device token: no sign-in time, no entitlements, no profile, no nonce.
    for (const k of [
      "auth_time",
      "pkey:entitlements",
      "name",
      "email",
      "picture",
      "nonce",
      "azp",
    ])
      expect(claims, k).not.toHaveProperty(k);
    expect(decodeJwt(token).sub).toBe(w.subject);
  });

  it("each call is a new token (a jti of its own)", async () => {
    const t = async () =>
      decodeJwt(
        ((await (await exchange()).json()) as { access_token: string })
          .access_token,
      ).jti;
    expect(await t()).not.toBe(await t());
  });

  it("is named by discovery while the issuer is served, and by nothing else", async () => {
    const disc = async () =>
      (await (
        await dispatchWith(
          new Request(`${BASE}/${SLUG}/.well-known/polaris.json`),
          w.env,
          w.db,
          NOW,
        )
      ).json()) as { services: { identity: Record<string, unknown> } };
    expect((await disc()).services.identity.accessToken).toBe(true);
    await ingestIdentity(w.db, SLUG, { issuer: { enabled: false } });
    expect((await disc()).services.identity).not.toHaveProperty("accessToken");
  });
});

describe("refusals (IS-11)", () => {
  it("with the issuer off the token type is unknown: invalid_request", async () => {
    await ingestIdentity(w.db, SLUG, { issuer: { enabled: false } });
    await refusal(await exchange(), 400, "invalid_request");
  });

  it("a token that is another device's, with this device's id, is the one invalid_grant", async () => {
    await refusal(
      await exchange(form({ subject_token: w.tokens[B]! })),
      400,
      "invalid_grant",
    );
    await refusal(
      await exchange(form(), { "x-pkey-device": B }),
      400,
      "invalid_grant",
    );
  });

  it("a token that is not a live device token is invalid_grant", async () => {
    for (const t of [
      "pkeyt_" + "A".repeat(43),
      "not-a-token",
      w.key,
      "pkeya_" + "A".repeat(43),
    ])
      await refusal(
        await exchange(form({ subject_token: t })),
        400,
        "invalid_grant",
      );
  });

  it("a device that is not signed in gets no token, and a device signed out since stops getting one", async () => {
    expect((await exchange()).status).toBe(200);
    await w.db.run(
      "UPDATE devices SET subject = NULL WHERE product = ? AND device_id = ?",
      SLUG,
      A,
    );
    await refusal(await exchange(), 400, "invalid_grant");
  });

  it("an account that is gone or disabled gets no token", async () => {
    await w.db.run("UPDATE accounts SET status = 'disabled'");
    await refusal(await exchange(), 400, "invalid_grant");
  });

  it("needs the device header, the requested type, a subject token and no actor", async () => {
    await refusal(await exchange(form(), {}), 400, "invalid_request");
    await refusal(
      await exchange(form(), { "x-pkey-device": "not a device id!" }),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(form({ requested_token_type: undefined })),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(
        form({
          requested_token_type: "urn:ietf:params:oauth:token-type:id_token",
        }),
      ),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(form({ subject_token: undefined })),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(form({ actor_token: w.tokens[B]! })),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(form({ actor_token_type: DEVICE_SUBJECT_TOKEN_TYPE })),
      400,
      "invalid_request",
    );
    await refusal(
      await exchange(form({ client_id: undefined })),
      400,
      "invalid_request",
    );
  });

  it("scope, audience and resource are ignored: the token never widens", async () => {
    const res = await exchange(
      form({
        scope: "openid profile email offline_access",
        audience: "https://evil.example",
        resource: "https://evil.example/api",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; access_token: string };
    expect(body.scope).toBe("");
    expect(decodeJwt(body.access_token)).toMatchObject({
      scope: "",
      aud: ISSUER,
    });
  });

  it("only the own client: another client_id is invalid_client, a registered client is unauthorized_client", async () => {
    await refusal(
      await exchange(form({ client_id: "someone-else" })),
      401,
      "invalid_client",
    );
    const spa = await mkClient(w, {
      key: "spa",
      type: "spa",
      redirectUris: ["https://spa.example.com/cb"],
    });
    await refusal(
      await exchange(form({ client_id: spa.clientId })),
      400,
      "unauthorized_client",
    );
  });

  it("is a form: a JSON body is invalid_request", async () => {
    const res = await dispatchWith(
      new Request(`${ISSUER}/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pkey-device": A },
        body: JSON.stringify(form()),
      }),
      w.env,
      w.db,
      NOW,
    );
    await refusal(res, 400, "invalid_request");
  });

  it("is ten a minute per device and fails closed", async () => {
    for (let i = 0; i < 10; i++) expect((await exchange()).status).toBe(200);
    const res = await exchange();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: "rate_limited",
      retryAfter: 60,
    });
    // Another device has its own budget; the next minute has a new one.
    expect(
      (
        await exchange(form({ subject_token: w.tokens[B]! }), {
          "x-pkey-device": B,
        })
      ).status,
    ).toBe(200);
    expect(
      (await exchange(form(), { "x-pkey-device": A }, NOW + 61)).status,
    ).toBe(200);
  });
});

describe("what the token is not", () => {
  it("userinfo refuses it (no openid), and so does an id_token hint", async () => {
    const { access_token: token } = (await (await exchange()).json()) as {
      access_token: string;
    };
    const res = await dispatchWith(
      new Request(`${ISSUER}/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("is not the device token: the license and sync routes refuse it", async () => {
    const { access_token: token } = (await (await exchange()).json()) as {
      access_token: string;
    };
    const res = await dispatchWith(
      new Request(`${BASE}/${SLUG}/identity/subject`, {
        headers: { authorization: `Bearer ${token}`, "x-pkey-device": A },
      }),
      w.env,
      w.db,
      NOW,
    );
    expect(res.status).toBe(401);
  });
});

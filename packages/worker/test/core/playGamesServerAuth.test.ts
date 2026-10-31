/**
 * `core/stores/playGames/serverAuth.ts` (I-14.4): the server auth code redeemed at Google's token
 * endpoint and verified for the application, against a fake fetch. No network. The client secret
 * below is an obviously fake value.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { NOW } from "../seed.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { listAudit } from "../../src/core/audit.js";
import {
  PGS_CLIENT_ID as CLIENT_ID,
  PGS_FAKE_SECRET as FAKE_SECRET,
  pgsTestWorld,
  putPgsServerCredential,
} from "../pgsServerCredential.js";
import {
  PGS_REDEEM_LIMIT,
  PGS_SECRET_CACHE_SECONDS,
  pgsServerCredentialReady,
  redeemAndVerify,
  resetPgsSecretCache,
  type PgsResult,
} from "../../src/core/stores/playGames/serverAuth.js";

const APP_ID = "123456789012";
const CODE = "4/0FakeServerAuthCode";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VERIFY_URL = `https://games.googleapis.com/games/v1/applications/${APP_ID}/verify`;
const ME_URL = "https://games.googleapis.com/games/v1/players/me";

let db: Db;
let env: Env;

beforeEach(async () => {
  ({ db, env } = await pgsTestWorld());
});

function putCred(
  value?: unknown,
  pin?: string | undefined,
  credentialId?: string,
) {
  return putPgsServerCredential(env, db, {
    ...(value === undefined ? {} : { value }),
    ...(pin === undefined ? {} : { pin }),
    ...(credentialId === undefined ? {} : { credentialId }),
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  url: string;
  init: RequestInit;
}

function fake(
  routes: Record<string, () => Response | Promise<Response>>,
  calls: Call[] = [],
) {
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) throw new Error(`unexpected URL ${url}`);
    return r();
  };
  return { fetchImpl, calls };
}

const GOOD_TOKEN = () =>
  json(200, {
    access_token: "fake-access",
    token_type: "Bearer",
    refresh_token: "fake-refresh",
    id_token: "fake-id",
    expires_in: 3599,
  });
const GOOD_VERIFY = () =>
  json(200, {
    kind: "games#applicationVerifyResponse",
    player_id: "pl-1",
    alternate_player_id: "alt-1",
  });

const run = (
  fetchImpl: ReturnType<typeof fake>["fetchImpl"],
  over: { now?: number; code?: string; applicationId?: string } = {},
): Promise<PgsResult> =>
  redeemAndVerify(env, db, {
    product: "djdl",
    applicationId: over.applicationId ?? APP_ID,
    serverClientId: CLIENT_ID,
    code: over.code ?? CODE,
    now: over.now ?? NOW,
    fetchImpl,
  });

const useRows = async () =>
  (await listAudit(db, "djdl", { limit: 100 })).filter(
    (r) => r.action === "outlet_credential.use",
  );

describe("the pgs-server-client kind", () => {
  it("stores a secret of 8 to 512 printable characters, pinned to a client id", async () => {
    expect((await putCred()).ok).toBe(true);
  });

  it.each([
    ["too short", "short12"],
    ["too long", "x".repeat(513)],
    ["has a space", "has a space inside"],
    ["has a control character", "abcdefgh\u0007ijk"],
    ["has a non-ASCII character", "abcdefghéijk"],
  ])("refuses a secret that %s without echoing it", async (_n, secret) => {
    const r = await putCred({ clientSecret: secret });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("clientSecret");
      expect(r.message).not.toContain(secret);
    }
  });

  it("refuses a missing or non-string secret", async () => {
    expect((await putCred({})).ok).toBe(false);
    expect((await putCred({ clientSecret: 12345678 })).ok).toBe(false);
  });

  it("refuses a pin that is not a Google client id", async () => {
    const r = await putCred(undefined, "not-a-client-id");
    expect(r.ok).toBe(false);
  });
});

describe("pgsServerCredentialReady", () => {
  it("is false with no credential, true with a pinned one, false for another client id", async () => {
    expect(await pgsServerCredentialReady(db, "djdl", CLIENT_ID)).toBe(false);
    await putCred();
    expect(await pgsServerCredentialReady(db, "djdl", CLIENT_ID)).toBe(true);
    expect(
      await pgsServerCredentialReady(
        db,
        "djdl",
        "999-other.apps.googleusercontent.com",
      ),
    ).toBe(false);
    expect(await pgsServerCredentialReady(db, "djdl", "junk")).toBe(false);
  });

  it("never opens the credential: no audit row", async () => {
    await putCred();
    await pgsServerCredentialReady(db, "djdl", CLIENT_ID);
    expect(await useRows()).toHaveLength(0);
  });
});

describe("redeemAndVerify", () => {
  it("redeems, verifies and returns the player and the alternate id", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    expect(await run(fetchImpl)).toEqual({
      ok: true,
      playerId: "pl-1",
      alternatePlayerId: "alt-1",
    });
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, VERIFY_URL]);
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: CODE,
      client_id: CLIENT_ID,
      client_secret: FAKE_SECRET,
      redirect_uri: "",
    });
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(
      (calls[1]!.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer fake-access");
  });

  it("carries no secret, token or code in the result or in audit rows", async () => {
    await putCred();
    const { fetchImpl } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    const out = JSON.stringify(await run(fetchImpl));
    const audit = JSON.stringify(await listAudit(db, "djdl", { limit: 100 }));
    for (const v of [
      FAKE_SECRET,
      "fake-access",
      "fake-refresh",
      "fake-id",
      CODE,
    ]) {
      expect(out).not.toContain(v);
      expect(audit).not.toContain(v);
    }
  });

  it("omits an alternate id equal to the player id or absent", async () => {
    await putCred();
    const { fetchImpl } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: () =>
        json(200, {
          kind: "games#applicationVerifyResponse",
          player_id: "pl-1",
          alternate_player_id: "pl-1",
        }),
    });
    expect(await run(fetchImpl)).toMatchObject({
      ok: true,
      alternatePlayerId: null,
    });
  });

  it("is invalid_grant with no credential, and makes no call", async () => {
    const { fetchImpl, calls } = fake({});
    expect(await run(fetchImpl)).toEqual({
      ok: false,
      reason: "invalid_grant",
      detail: "no_credential",
    });
    expect(calls).toHaveLength(0);
  });

  it("stops calling Google once the product's redemption budget is spent", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    for (let i = 0; i < PGS_REDEEM_LIMIT.limit; i++)
      expect((await run(fetchImpl)).ok).toBe(true);
    const before = calls.length;
    expect(await run(fetchImpl)).toEqual({
      ok: false,
      reason: "rate_limited",
      detail: "rate_limited",
    });
    expect(calls).toHaveLength(before);
  });

  it("fails closed when the limiter is unavailable", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    env.RL = {
      idFromName: (n: string) => ({ name: n }),
      get: () => ({
        fetch: async () => {
          throw new Error("limiter down");
        },
      }),
    } as unknown as Env["RL"];
    expect(await run(fetchImpl)).toMatchObject({
      ok: false,
      reason: "rate_limited",
      detail: "rate_limited",
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a code with a space", { code: "bad code" }],
    ["an empty code", { code: "" }],
    ["a long code", { code: "c".repeat(513) }],
    ["a non-digit application id", { applicationId: "12/../x" }],
  ])("refuses %s before any call", async (_n, over) => {
    await putCred();
    const { fetchImpl, calls } = fake({});
    expect(await run(fetchImpl, over)).toMatchObject({
      ok: false,
      reason: "invalid_grant",
      detail: "bad_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("is invalid_grant when Google refuses the code (4xx)", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: () => json(400, { error: "invalid_grant" }),
    });
    expect(await run(fetchImpl)).toMatchObject({
      reason: "invalid_grant",
      detail: "redeem_refused",
    });
    expect(calls).toHaveLength(1);
  });

  it("is unavailable on a 5xx or a network failure at the token endpoint", async () => {
    await putCred();
    expect(
      await run(fake({ [TOKEN_URL]: () => json(503, {}) }).fetchImpl),
    ).toMatchObject({ reason: "unavailable", detail: "server" });
    expect(
      await run(
        fake({
          [TOKEN_URL]: () => {
            throw new Error("boom");
          },
        }).fetchImpl,
      ),
    ).toMatchObject({ reason: "unavailable", detail: "network" });
  });

  it("is unavailable on a redirect and never follows it", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    });
    expect(await run(fetchImpl)).toMatchObject({ reason: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no access token", { token_type: "Bearer" }],
    ["a non-Bearer type", { access_token: "t", token_type: "MAC" }],
    ["an empty token", { access_token: "", token_type: "Bearer" }],
  ])("is invalid_grant for a 200 with %s", async (_n, body) => {
    await putCred();
    expect(
      await run(fake({ [TOKEN_URL]: () => json(200, body) }).fetchImpl),
    ).toMatchObject({ reason: "invalid_grant", detail: "redeem_malformed" });
  });

  it("is invalid_grant when verify answers 4xx other than 403", async () => {
    await putCred();
    for (const status of [400, 401, 404]) {
      resetPgsSecretCache();
      const { fetchImpl, calls } = fake({
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: () => json(status, {}),
      });
      expect(await run(fetchImpl)).toMatchObject({
        reason: "invalid_grant",
        detail: "verify_refused",
      });
      expect(calls.map((c) => c.url)).not.toContain(ME_URL);
    }
  });

  it("is unavailable when verify answers 5xx", async () => {
    await putCred();
    expect(
      await run(
        fake({ [TOKEN_URL]: GOOD_TOKEN, [VERIFY_URL]: () => json(500, {}) })
          .fetchImpl,
      ),
    ).toMatchObject({ reason: "unavailable", detail: "server" });
  });

  it.each([
    ["the wrong kind", { kind: "games#other", player_id: "p" }],
    ["no player id", { kind: "games#applicationVerifyResponse" }],
    [
      "a player id with a space",
      { kind: "games#applicationVerifyResponse", player_id: "a b" },
    ],
    [
      "a player id over 128 characters",
      { kind: "games#applicationVerifyResponse", player_id: "p".repeat(129) },
    ],
  ])("is invalid_grant when verify answers 200 with %s", async (_n, body) => {
    await putCred();
    expect(
      await run(
        fake({ [TOKEN_URL]: GOOD_TOKEN, [VERIFY_URL]: () => json(200, body) })
          .fetchImpl,
      ),
    ).toMatchObject({ reason: "invalid_grant", detail: "verify_malformed" });
  });

  describe("the 403 fallback to players/me", () => {
    it("reads the player behind the token when verify is refused for scope", async () => {
      await putCred();
      const { fetchImpl, calls } = fake({
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: () => json(403, { error: { code: 403 } }),
        [ME_URL]: () => json(200, { kind: "games#player", playerId: "pl-9" }),
      });
      expect(await run(fetchImpl)).toEqual({
        ok: true,
        playerId: "pl-9",
        alternatePlayerId: null,
      });
      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, VERIFY_URL, ME_URL]);
    });

    it("is invalid_grant when players/me is refused or malformed, unavailable on 5xx", async () => {
      await putCred();
      const base = {
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: () => json(403, {}),
      };
      expect(
        await run(fake({ ...base, [ME_URL]: () => json(401, {}) }).fetchImpl),
      ).toMatchObject({ reason: "invalid_grant", detail: "verify_refused" });
      expect(
        await run(
          fake({ ...base, [ME_URL]: () => json(200, { playerId: "p" }) })
            .fetchImpl,
        ),
      ).toMatchObject({ reason: "invalid_grant", detail: "verify_malformed" });
      expect(
        await run(fake({ ...base, [ME_URL]: () => json(503, {}) }).fetchImpl),
      ).toMatchObject({ reason: "unavailable" });
    });
  });

  describe("the opened-secret cache (D-9)", () => {
    const ok = () =>
      fake({ [TOKEN_URL]: GOOD_TOKEN, [VERIFY_URL]: GOOD_VERIFY }).fetchImpl;

    it("opens once for a run of exchanges: one audit row, then hits", async () => {
      await putCred();
      await run(ok());
      await run(ok(), { now: NOW + 30 });
      await run(ok(), { now: NOW + 120 });
      expect(await useRows()).toHaveLength(1);
    });

    it("opens again after the cache lifetime", async () => {
      await putCred();
      await run(ok());
      await run(ok(), { now: NOW + PGS_SECRET_CACHE_SECONDS + 1 });
      expect(await useRows()).toHaveLength(2);
    });

    it("misses after a rotation and sends the new secret", async () => {
      await putCred();
      await run(ok());
      await putCred({ clientSecret: "FAKE-rotated-secret-1" });
      const { fetchImpl, calls } = fake({
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: GOOD_VERIFY,
      });
      await run(fetchImpl, { now: NOW + 1 });
      expect(
        new URLSearchParams(calls[0]!.init.body as string).get("client_secret"),
      ).toBe("FAKE-rotated-secret-1");
      expect(await useRows()).toHaveLength(2);
    });

    it("does not serve a secret after the credential is disabled", async () => {
      await putCred();
      await run(ok());
      await db.run(
        "UPDATE outlet_credentials SET status = 'disabled' WHERE product = 'djdl'",
      );
      expect(await run(ok(), { now: NOW + 1 })).toMatchObject({
        detail: "no_credential",
      });
    });
  });

  it("refuses a pin for another client id", async () => {
    await putCred(undefined, "999-other.apps.googleusercontent.com");
    expect(await run(fake({}).fetchImpl)).toMatchObject({
      detail: "no_credential",
    });
  });
});

describe("the gated hosts", () => {
  it("dials only oauth2.googleapis.com and games.googleapis.com, over https", async () => {
    await putCred();
    const { fetchImpl, calls } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    await run(fetchImpl);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(u.protocol).toBe("https:");
      expect(["oauth2.googleapis.com", "games.googleapis.com"]).toContain(
        u.hostname,
      );
    }
  });

  it("refuses a host outside the gate without dialling it", async () => {
    const { gatedFetch } = await import("../../src/core/oidc/client.js");
    const { PGS_HOSTS } =
      await import("../../src/core/stores/playGames/serverAuth.js");
    const calls: string[] = [];
    await expect(
      gatedFetch(
        "pgs",
        "https://evil.example/token",
        { method: "POST" },
        PGS_HOSTS,
        async (u) => {
          calls.push(u);
          return json(200, {});
        },
      ),
    ).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(0);
  });
});

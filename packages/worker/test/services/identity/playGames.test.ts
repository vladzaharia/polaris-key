/**
 * The Play Games verifier (I-14.7, WIRE-CONTRACT-V5 §12.11.7) over Core's redeemer, against a fake
 * fetch. No network. Every secret, code and token below is an obviously fake value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, NOW, seedProduct } from "../../seed.js";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import { listAudit } from "../../../src/core/audit.js";
import { putOutletCredential } from "../../../src/core/outletCredentials.js";
import { resetPgsSecretCache } from "../../../src/core/stores/playGames/serverAuth.js";
import {
  findPgsLink,
  pgsScope,
  verifyPlayGamesCode,
} from "../../../src/services/identity/providers/playGames.js";
import type { PlatformSignInAudiences } from "../../../src/services/identity/platformSignIn.js";

const CLIENT_ID = "123456789012-fakeserverclient.apps.googleusercontent.com";
const FAKE_SECRET = "FAKE-secret-not-real-0000";
const APP_ID = "123456789012";
const CODE = "4/0FakeServerAuthCode";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const VERIFY_URL = `https://games.googleapis.com/games/v1/applications/${APP_ID}/verify`;
const ME_URL = "https://games.googleapis.com/games/v1/players/me";

const AUD = (
  over: Partial<PlatformSignInAudiences["playGames"]> = {},
): PlatformSignInAudiences => ({
  google: { serverClientId: null, clientIds: [] },
  apple: { teamId: null, bundleIds: [], outletBundleIds: [] },
  gameCenter: false,
  playGames: { applicationId: APP_ID, serverClientId: CLIENT_ID, ...over },
  nearby: false,
});

let db: Db;
let env: Env;

beforeEach(async () => {
  resetPgsSecretCache();
  db = makeTestDb();
  env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl");
});
afterEach(() => vi.restoreAllMocks());

const putCred = () =>
  putOutletCredential(env, db, {
    product: "djdl",
    credentialId: "pgs-server",
    kind: "pgs-server-client",
    outletId: null,
    value: { clientSecret: FAKE_SECRET },
    expiresAt: null,
    pin: CLIENT_ID,
    actor: "admin-1",
    now: NOW,
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function fake(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected URL ${url}`);
    return r();
  };
  return { fetchImpl, urls };
}

const GOOD_TOKEN = () =>
  json(200, {
    access_token: "fake-access",
    token_type: "Bearer",
    refresh_token: "fake-refresh",
    id_token: "fake-id",
  });
const GOOD_VERIFY = () =>
  json(200, {
    kind: "games#applicationVerifyResponse",
    player_id: "pl-1",
    alternate_player_id: "alt-1",
  });

const run = (
  fetchImpl: ReturnType<typeof fake>["fetchImpl"],
  audiences = AUD(),
) =>
  verifyPlayGamesCode(env, db, "djdl", audiences, CODE, {
    now: NOW,
    fetchImpl,
  });

describe("verifyPlayGamesCode", () => {
  it("returns the developer-scoped identity for a valid code", async () => {
    await putCred();
    const { fetchImpl, urls } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    expect(await run(fetchImpl)).toEqual({
      ok: true,
      identity: {
        kind: "pgs",
        issuerKey: "pgs",
        subject: "pl-1",
        alternateSubject: "alt-1",
        tenantScopes: ["pgs-app:123456789012"],
        email: null,
        emailVerified: false,
        reach: "developer",
      },
    });
    expect(urls).toEqual([TOKEN_URL, VERIFY_URL]);
    expect(pgsScope(APP_ID)).toBe("pgs-app:123456789012");
  });

  it("is invalid_grant when Google refuses the code (400)", async () => {
    await putCred();
    const { fetchImpl, urls } = fake({
      [TOKEN_URL]: () => json(400, { error: "invalid_grant" }),
    });
    expect(await run(fetchImpl)).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
    expect(urls).toEqual([TOKEN_URL]);
  });

  it("is invalid_grant when verify answers 404", async () => {
    await putCred();
    const { fetchImpl } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: () => json(404, {}),
    });
    expect(await run(fetchImpl)).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
  });

  describe("verify 403", () => {
    it("falls back to players/me and keeps the same identity shape", async () => {
      await putCred();
      const { fetchImpl, urls } = fake({
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: () => json(403, {}),
        [ME_URL]: () => json(200, { kind: "games#player", playerId: "pl-9" }),
      });
      const r = await run(fetchImpl);
      expect(r).toMatchObject({
        ok: true,
        identity: {
          subject: "pl-9",
          alternateSubject: null,
          tenantScopes: ["pgs-app:123456789012"],
        },
      });
      expect(urls).toEqual([TOKEN_URL, VERIFY_URL, ME_URL]);
    });

    it("is invalid_grant when the fallback is refused", async () => {
      await putCred();
      const { fetchImpl } = fake({
        [TOKEN_URL]: GOOD_TOKEN,
        [VERIFY_URL]: () => json(403, {}),
        [ME_URL]: () => json(401, {}),
      });
      expect(await run(fetchImpl)).toEqual({
        ok: false,
        reason: "invalid_grant",
      });
    });
  });

  it("is unavailable for a Google 5xx and for a network failure", async () => {
    await putCred();
    const cases: Record<string, () => Response>[] = [
      { [TOKEN_URL]: () => json(503, {}) },
      { [TOKEN_URL]: GOOD_TOKEN, [VERIFY_URL]: () => json(500, {}) },
    ];
    for (const routes of cases) {
      expect(await run(fake(routes).fetchImpl)).toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
    const down = async () => {
      throw new Error("offline");
    };
    expect(await run(down)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is invalid_grant, with no call, when the product has no credential or no settings", async () => {
    const { fetchImpl, urls } = fake({});
    expect(await run(fetchImpl)).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
    await putCred();
    expect(await run(fetchImpl, AUD({ applicationId: null }))).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
    expect(await run(fetchImpl, AUD({ serverClientId: null }))).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
    expect(urls).toEqual([]);
  });

  it("drops the refresh token and logs and audits nothing sensitive", async () => {
    await putCred();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { fetchImpl } = fake({
      [TOKEN_URL]: GOOD_TOKEN,
      [VERIFY_URL]: GOOD_VERIFY,
    });
    const r = await run(fetchImpl);
    const blob = JSON.stringify([
      r,
      spies.map((s) => s.mock.calls),
      await listAudit(db, "djdl", { limit: 100 }),
    ]);
    for (const secret of [
      "fake-refresh",
      "fake-access",
      "fake-id",
      FAKE_SECRET,
      CODE,
    ])
      expect(blob).not.toContain(secret);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("findPgsLink", () => {
  const id = { subject: "pl-1", alternateSubject: "alt-1" };

  it("prefers the player id", async () => {
    const seen: string[] = [];
    const r = await findPgsLink(id, async (s) => (seen.push(s), "acct"));
    expect(r).toEqual({ subject: "pl-1", found: "acct" });
    expect(seen).toEqual(["pl-1"]);
  });

  it("falls back to the alternate id, and misses when neither has a link", async () => {
    const hit = await findPgsLink(id, async (s) =>
      s === "alt-1" ? "acct" : null,
    );
    expect(hit).toEqual({ subject: "alt-1", found: "acct" });
    expect(await findPgsLink(id, async () => null)).toBeNull();
  });

  it("looks up a missing or identical alternate id once", async () => {
    const seen: string[] = [];
    const find = async (s: string) => (seen.push(s), null);
    await findPgsLink({ subject: "a", alternateSubject: null }, find);
    await findPgsLink({ subject: "a", alternateSubject: "a" }, find);
    expect(seen).toEqual(["a", "a"]);
  });
});

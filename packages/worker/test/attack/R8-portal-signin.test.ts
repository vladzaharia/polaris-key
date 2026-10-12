/**
 * The portal's own sign-in legs: `/callback` and `/magic/verify` are metered and fail CLOSED, and
 * the address a magic link and its flow name is sealed at rest, bound to the record it lives in.
 *
 * `/callback` runs a token exchange and an ID-token verification for anyone who names a `state`,
 * and `/magic/verify` is a bearer-token redemption endpoint: the exact shape a guessing loop
 * wants. Their start surfaces (`portalLogin`, `portalMagic`) were limited and these were not.
 */
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { artefacts, singleUseMock } from "../singleUseMock.js";
import type { Env } from "../../src/platform/env.js";
import type { Db } from "../../src/db/types.js";
import {
  handleMagicStart,
  handleMagicVerify,
  handlePortalCallback,
  portalMagicKey,
} from "../../src/services/identity/portal/auth.js";

const ORIGIN = "https://key.plrs.im";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init) as unknown as Request;
}

/** A limiter whose Durable Object is unavailable (every deploy resets one). */
const DEAD_LIMITER = {
  idFromName: (name: string) => ({ name }),
  get: () => ({ fetch: () => Promise.reject(new Error("DO reset")) }),
} as unknown as Env["RL"];

function portalEnv(): Env {
  const env = makeEnv(new KvMock(), ["djdl"]);
  env.PORTAL_SESSION_SECRET = "s";
  return env;
}

describe("the portal's sign-in legs are metered and fail closed", () => {
  const callback = () => req(`${ORIGIN}/callback?code=c&state=nope`);

  it("/callback throttles a flood of attempts, and the first is still served", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push(
        (await handlePortalCallback(callback(), env, db, NOW)).status,
      );
    expect(statuses[0]).not.toBe(429);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("/callback with the limiter unavailable answers 429 instead of running unmetered", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    env.RL = DEAD_LIMITER;
    const res = await handlePortalCallback(callback(), env, db, NOW);
    expect(res.status).toBe(429);
  });

  it("/magic/verify with the limiter unavailable answers 429 for the landing and the confirmation", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    env.RL = DEAD_LIMITER;
    for (const init of [
      { method: "GET" },
      { method: "POST", body: new URLSearchParams({ token: "t" }).toString() },
    ]) {
      const res = await handleMagicVerify(
        req(`${ORIGIN}/magic/verify?token=t`, init),
        env,
        db,
        NOW,
      );
      expect(res.status).toBe(429);
    }
    // A method the route does not serve is a 405 whatever the limiter's state.
    expect(
      (
        await handleMagicVerify(
          req(`${ORIGIN}/magic/verify`, { method: "PUT" }),
          env,
          db,
          NOW,
        )
      ).status,
    ).toBe(405);
  });
});

describe("the address a magic link names is sealed at rest", () => {
  /** Start an email sign-in for `email`; answers the emailed token and the browser's flow cookie. */
  async function start(env: Env, db: Db, email: string) {
    let text = "";
    env.EMAIL = {
      send: async (m: { text: string }) => {
        text = m.text;
      },
    } as unknown as Env["EMAIL"];
    const res = await handleMagicStart(
      req(`${ORIGIN}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
      db,
    );
    const link = text.split(/\s+/).find((w) => w.startsWith("https://"));
    return {
      status: res.status,
      token: link ? new URL(link).searchParams.get("token")! : "",
      cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!,
    };
  }

  const landing = (env: Env, db: Db, s: { token: string; cookie: string }) =>
    handleMagicVerify(
      req(`${ORIGIN}/magic/verify?token=${encodeURIComponent(s.token)}`, {
        headers: { cookie: s.cookie },
      }),
      env,
      db,
      NOW,
    );

  it("a record that names a plaintext address, or an address sealed for another record, is not a live link", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    const mine = await start(env, db, "victim@corp.com");
    const other = await start(env, db, "other@corp.com");
    const mineKey = await portalMagicKey(env, mine.token);
    const record = JSON.parse((await artefacts(env).get(mineKey))!) as Record<
      string,
      unknown
    >;

    // Control: the untouched record serves the landing page for the browser that asked.
    const ok = await landing(env, db, mine);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("victim@corp.com");

    // A record written before the address was sealed (or planted by someone with store access)
    // is not trusted: it reads as an expired link, not as a sign-in for the address it names.
    await artefacts(env).put(
      mineKey,
      JSON.stringify({ ...record, email: "attacker-chosen@evil.example" }),
    );
    const plain = await landing(env, db, mine);
    expect(plain.status).toBe(400);
    expect(await plain.text()).not.toContain("attacker-chosen");

    // A sealed blob lifted out of another link's record fails its auth tag: the AAD names the
    // record it was written for, so it cannot point this link at somebody else's account.
    const otherRecord = JSON.parse(
      (await artefacts(env).get(await portalMagicKey(env, other.token)))!,
    ) as { email: string };
    await artefacts(env).put(
      mineKey,
      JSON.stringify({ ...record, email: otherRecord.email }),
    );
    const moved = await landing(env, db, mine);
    expect(moved.status).toBe(400);
    expect(await moved.text()).not.toContain("other@corp.com");
  });

  it("with no usable KEK nothing is stored: the start answers 503 and the address is never written in the clear", async () => {
    const db = makeTestDb();
    const env = portalEnv();
    await seedProduct(db, "djdl");
    delete env.PLATFORM_KEK;
    const started = await start(env, db, "victim@corp.com");
    expect(started.status).toBe(503);
    expect(
      singleUseMock(env)
        .keys()
        .filter(
          (k) => k.startsWith("signin-flow:") || k.startsWith("portal-magic:"),
        ),
    ).toEqual([]);
  });
});

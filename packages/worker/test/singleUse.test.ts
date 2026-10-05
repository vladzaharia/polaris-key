import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artefactLocked,
  artefactRef,
  attemptArtefact,
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  redeemArtefact,
  SINGLE_USE_SHARDS,
  singleUseShard,
  strikeArtefact,
  updateArtefact,
} from "../src/core/singleUse.js";
import { SingleUseDO } from "../src/singleUseDo.js";
import type { Env } from "../src/env.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { makeTestDb } from "./helpers.js";
import { singleUseMock } from "./singleUseMock.js";
import { StorageMock } from "./updateHealthMock.js";
import {
  handleMagicStart,
  handleMagicVerify,
  portalFlowKey,
} from "../src/services/identity/portal/auth.js";
import { upsertPortalProductSettings } from "../src/services/identity/portal/repo.js";
import { artefacts } from "./singleUseMock.js";

// I-02: the atomic single-use store (S-16 §3.2 G15). These run the REAL SingleUseDO class over
// an in-memory storage with each object's requests serialised, as the runtime's input gate
// serialises them; `test-workerd/singleUse.test.ts` repeats the race against real workerd.

const env = (): Env => makeEnv(new KvMock(), []);
const ref = artefactRef("portal-magic", "abc123");

afterEach(() => {
  vi.useRealTimers();
});

describe("single-use store: consume", () => {
  it("hands a record out once, then answers null", async () => {
    const e = env();
    await putArtefact(e, ref, "payload", 600);
    expect(await getArtefact(e, ref)).toBe("payload");
    expect(await consumeArtefact(e, ref)).toBe("payload");
    expect(await consumeArtefact(e, ref)).toBeNull();
    expect(await getArtefact(e, ref)).toBeNull();
  });

  it("two concurrent consumes of one artefact: exactly one succeeds", async () => {
    const e = env();
    await putArtefact(e, ref, "once", 600);
    const [a, b] = await Promise.all([
      consumeArtefact(e, ref),
      consumeArtefact(e, ref),
    ]);
    expect([a, b].filter((v) => v === "once")).toHaveLength(1);
    expect([a, b].filter((v) => v === null)).toHaveLength(1);
  });

  it("a burst of concurrent consumes: exactly one succeeds", async () => {
    const e = env();
    await putArtefact(e, ref, "once", 600);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeArtefact(e, ref)),
    );
    expect(results.filter((v) => v === "once")).toHaveLength(1);
  });

  it("an expired record is gone (and deleted on read)", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const e = env();
    await putArtefact(e, ref, "p", 10);
    vi.setSystemTime(NOW * 1000 + 9_999);
    expect(await getArtefact(e, ref)).toBe("p");
    vi.setSystemTime(NOW * 1000 + 10_000);
    expect(await consumeArtefact(e, ref)).toBeNull();
    expect(singleUseMock(e).keys()).toEqual([]);
  });

  it("put replaces: a new artefact at one address invalidates the old", async () => {
    const e = env();
    await putArtefact(e, ref, "old", 600);
    await putArtefact(e, ref, "new", 600);
    expect(await consumeArtefact(e, ref)).toBe("new");
  });

  it("ifAbsent claims an address once while it is live", async () => {
    const e = env();
    const [a, b] = await Promise.all([
      putArtefact(e, ref, "a", 600, { ifAbsent: true }),
      putArtefact(e, ref, "b", 600, { ifAbsent: true }),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    await deleteArtefact(e, ref);
    expect(await putArtefact(e, ref, "c", 600, { ifAbsent: true })).toBe(true);
  });

  it("kinds and ids are separate namespaces", async () => {
    const e = env();
    await putArtefact(e, artefactRef("oidc-flow", "x"), "flow", 600);
    expect(await getArtefact(e, artefactRef("device-flow", "x"))).toBeNull();
    expect(await getArtefact(e, artefactRef("oidc-flow", "y"))).toBeNull();
  });
});

describe("single-use store: attempts", () => {
  it("attempt kills the artefact at its cap", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600, { maxAttempts: 3 });
    expect(await attemptArtefact(e, ref)).toEqual({ alive: true });
    expect(await attemptArtefact(e, ref)).toEqual({ alive: true });
    expect(await attemptArtefact(e, ref)).toEqual({ alive: false });
    expect(await getArtefact(e, ref)).toBeNull();
    expect(await attemptArtefact(e, ref)).toEqual({ alive: false });
  });

  it("redeem consumes on the right proof and counts the wrong ones", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600, { maxAttempts: 2, proof: "aa11" });
    expect(await redeemArtefact(e, ref, "bb22")).toEqual({ ok: false });
    expect(await redeemArtefact(e, ref, "aa11")).toEqual({
      ok: true,
      payload: "p",
    });
    expect(await redeemArtefact(e, ref, "aa11")).toEqual({ ok: false });
  });

  it("redeem: the cap kills the artefact even for the right proof afterwards", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600, { maxAttempts: 2, proof: "aa11" });
    await redeemArtefact(e, ref, "x");
    await redeemArtefact(e, ref, "y");
    expect(await redeemArtefact(e, ref, "aa11")).toEqual({ ok: false });
  });

  it("redeem never matches an artefact stored without a proof", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600);
    expect(await redeemArtefact(e, ref, "")).toEqual({ ok: false });
    expect(await getArtefact(e, ref)).toBe("p");
  });

  it("concurrent redeems with the right proof: exactly one succeeds", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600, { proof: "aa11" });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redeemArtefact(e, ref, "aa11")),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("single-use store: update (compare-and-set)", () => {
  const flow = artefactRef("oidc-flow", "djdl:f");

  it("applies set/unset only when every expectation holds", async () => {
    const e = env();
    await putArtefact(e, flow, JSON.stringify({ a: 1, csrf: "t" }), 600);
    const miss = await updateArtefact(e, flow, {
      expect: { csrf: "wrong" },
      set: { confirmedAt: 5 },
    });
    expect(miss.ok).toBe(false);
    const hit = await updateArtefact(e, flow, {
      expect: { csrf: "t", confirmedAt: null },
      set: { confirmedAt: 5 },
      unset: ["csrf"],
    });
    expect(hit.ok).toBe(true);
    expect(JSON.parse(hit.payload!)).toEqual({ a: 1, confirmedAt: 5 });
  });

  it("two racing claims: exactly one wins", async () => {
    const e = env();
    await putArtefact(e, flow, JSON.stringify({ verifier: "v" }), 600);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateArtefact(e, flow, {
          expect: { consumedAt: null },
          set: { consumedAt: i + 1 },
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("never creates an artefact (no resurrection after a consume)", async () => {
    const e = env();
    expect((await updateArtefact(e, flow, { set: { x: 1 } })).ok).toBe(false);
    expect(await getArtefact(e, flow)).toBeNull();
  });

  it("refuses a payload that is not a JSON object", async () => {
    const e = env();
    await putArtefact(e, flow, "not json", 600);
    expect((await updateArtefact(e, flow, { set: { x: 1 } })).ok).toBe(false);
    expect(await getArtefact(e, flow)).toBe("not json");
  });
});

describe("single-use store: strikes", () => {
  const who = artefactRef("email-strikes", "djdl:r");
  const policy = { windowSec: 3600, threshold: 3, lockSec: 900 };

  it("locks at the threshold inside the window, and unlocks after lockSec", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const e = env();
    expect(await strikeArtefact(e, who, policy)).toEqual({ locked: false });
    expect(await strikeArtefact(e, who, policy)).toEqual({ locked: false });
    expect(await artefactLocked(e, who)).toBe(false);
    expect(await strikeArtefact(e, who, policy)).toEqual({ locked: true });
    expect(await artefactLocked(e, who)).toBe(true);
    vi.setSystemTime(NOW * 1000 + 900_000);
    expect(await artefactLocked(e, who)).toBe(false);
  });

  it("forgets strikes older than the window (sliding)", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const e = env();
    await strikeArtefact(e, who, policy);
    await strikeArtefact(e, who, policy);
    vi.setSystemTime(NOW * 1000 + 3_600_000);
    expect(await strikeArtefact(e, who, policy)).toEqual({ locked: false });
  });
});

describe("single-use store: sharding and failure", () => {
  it("spreads addresses over SINGLE_USE_SHARDS objects; one address, one object", () => {
    const shards = new Set<string>();
    for (let i = 0; i < 4000; i++)
      shards.add(singleUseShard(artefactRef("oidc-flow", `djdl:${i}`)));
    expect(shards.size).toBe(SINGLE_USE_SHARDS);
    expect(singleUseShard(ref)).toBe(singleUseShard({ ...ref }));
  });

  it("fails closed: reads answer absent, writes throw", async () => {
    const e = env();
    await putArtefact(e, ref, "p", 600, { proof: "aa" });
    singleUseMock(e).failing = true;
    expect(await getArtefact(e, ref)).toBeNull();
    expect(await consumeArtefact(e, ref)).toBeNull();
    expect(await redeemArtefact(e, ref, "aa")).toEqual({ ok: false });
    expect(await attemptArtefact(e, ref)).toEqual({ alive: false });
    expect((await updateArtefact(e, ref, { set: {} })).ok).toBe(false);
    expect(await artefactLocked(e, ref)).toBe(true);
    await expect(putArtefact(e, ref, "q", 600)).rejects.toThrow();
    singleUseMock(e).failing = false;
    // Nothing was consumed while the store was unreachable.
    expect(await getArtefact(e, ref)).toBe("p");
  });

  it("an unbound store fails closed too", async () => {
    const e = env();
    (e as { SINGLE_USE?: unknown }).SINGLE_USE = undefined;
    expect(await consumeArtefact(e, ref)).toBeNull();
    await expect(putArtefact(e, ref, "q", 600)).rejects.toThrow();
  });

  it("the alarm sweep deletes expired records and stops arming when empty", async () => {
    vi.useFakeTimers({ now: NOW * 1000 });
    const storage = new StorageMock();
    const obj = new SingleUseDO(
      { storage } as unknown as DurableObjectState,
      {} as Env,
    );
    const op = (body: unknown) =>
      obj.fetch(
        new Request("https://single-use/op", {
          method: "POST",
          body: JSON.stringify(body),
        }) as unknown as Request,
      );
    await op({ op: "put", key: "a", value: "1", ttlSec: 60 });
    await op({ op: "put", key: "b", value: "2", ttlSec: 3600 });
    expect(storage.alarm).not.toBeNull();
    vi.setSystemTime(NOW * 1000 + 120_000);
    storage.alarm = null;
    await obj.alarm();
    expect([...storage.m.keys()]).toEqual(["b"]);
    expect(storage.alarm).not.toBeNull();
    vi.setSystemTime(NOW * 1000 + 7_200_000);
    storage.alarm = null;
    await obj.alarm();
    expect(storage.m.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });

  it("refuses a malformed operation", async () => {
    const obj = new SingleUseDO(
      { storage: new StorageMock() } as unknown as DurableObjectState,
      {} as Env,
    );
    for (const body of [
      "nope",
      JSON.stringify({ op: "get" }),
      JSON.stringify({ op: "x", key: "k" }),
    ]) {
      const res = await obj.fetch(
        new Request("https://single-use/op", {
          method: "POST",
          body,
        }) as unknown as Request,
      );
      expect(res.status).toBe(400);
    }
  });
});

// The migrated artefacts, end to end through the real handlers.
describe("portal magic links and flows are consumed atomically (G15)", () => {
  async function magicSetup() {
    const db = makeTestDb();
    const e = makeEnv(new KvMock(), ["acme"]);
    e.PORTAL_SESSION_SECRET = "portal-secret";
    e.PORTAL_EMAIL_FROM = "Polaris Key <noreply@plrs.im>";
    const sent: string[] = [];
    e.EMAIL = {
      send: async (m: { text: string }) => {
        sent.push(m.text);
      },
    } as never;
    await seedProduct(db, "acme");
    await upsertPortalProductSettings(
      db,
      "acme",
      { portalEnabled: true, magicEnabled: true },
      NOW,
    );
    const res = await handleMagicStart(
      new Request("https://key.plrs.im/api/magic/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      }) as unknown as Request,
      e,
      db,
    );
    expect(res.status).toBe(200);
    const link = /https:\/\/\S+/.exec(sent[0] ?? "")![0];
    // I-07: the link is bound to the browser that asked, by its flow cookie.
    const flowCookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return { db, e, link, flowCookie };
  }

  it("two concurrent clicks on one magic link: exactly one signs in", async () => {
    const { db, e, link, flowCookie } = await magicSetup();
    // I-07: opening the link (GET) consumes nothing; its button POSTs the token back.
    const token = new URL(link).searchParams.get("token")!;
    const click = () =>
      handleMagicVerify(
        new Request("https://key.plrs.im/magic/verify", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: flowCookie,
          },
          body: new URLSearchParams({ token }).toString(),
        }) as unknown as Request,
        e,
        db,
        NOW,
      );
    const [a, b] = await Promise.all([click(), click()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([302, 400]);
    expect(
      [a, b].filter((r) =>
        r.headers.get("set-cookie")?.includes("pkey_portal="),
      ),
    ).toHaveLength(1);
  });

  it("the magic link never touches KV", async () => {
    const { e } = await magicSetup();
    expect((e.HOT as unknown as KvMock).keys()).toEqual([]);
    expect(
      singleUseMock(e)
        .keys()
        .filter((k) => k.startsWith("portal-magic:")),
    ).toHaveLength(1);
  });

  it("a planted portal flow is single-use through the store", async () => {
    const e = env();
    const key = await portalFlowKey(e, "state-1");
    await artefacts(e).put(key, JSON.stringify({ verifier: "v" }));
    const [a, b] = await Promise.all([
      artefacts(e).consume(key),
      artefacts(e).consume(key),
    ]);
    expect([a, b].filter((v) => v !== null)).toHaveLength(1);
  });
});

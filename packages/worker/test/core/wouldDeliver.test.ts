import { describe, expect, it } from "vitest";
import {
  deliverEmail,
  suppressEmail,
  wouldDeliver,
} from "../../src/core/notify/emailDelivery.js";
import { securityNoticeDeliverable } from "../../src/core/notify/send.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW } from "../seed.js";

// I-49.5: the dry run of the send choke point. It answers what steps 1 to 4 of `deliverEmail`
// would, and sends and counts nothing.

function setup(): { env: Env; db: Db; sent: string[] } {
  const env = makeEnv(new KvMock(), []);
  env.KEY_HASH_PEPPER = "would-deliver-pepper";
  env.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
  const sent: string[] = [];
  env.EMAIL = {
    send: async (m: { to: string }) => {
      sent.push(m.to);
      return { messageId: "m" };
    },
  } as unknown as Env["EMAIL"];
  return { env, db: makeTestDb(), sent };
}

describe("wouldDeliver", () => {
  it("is true for an ordinary address and sends nothing", async () => {
    const { env, db, sent } = setup();
    expect(await wouldDeliver(env, db, "ada@example.com", NOW)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("is false with no binding", async () => {
    const { env, db } = setup();
    env.EMAIL = undefined as unknown as Env["EMAIL"];
    expect(await wouldDeliver(env, db, "ada@example.com", NOW)).toBe(false);
  });

  it("is false for something that is not a bare address", async () => {
    const { env, db } = setup();
    for (const to of ["", "not an address", "Ada <ada@example.com>"])
      expect(await wouldDeliver(env, db, to, NOW), to).toBe(false);
  });

  it("refuses an Apple private-relay address until the relay sender is registered", async () => {
    const { env, db } = setup();
    const relay = "abc123@privaterelay.appleid.com";
    expect(await wouldDeliver(env, db, relay, NOW)).toBe(false);
    env.EMAIL_APPLE_RELAY = "registered";
    expect(await wouldDeliver(env, db, relay, NOW)).toBe(true);
  });

  it("is false for a suppressed address, and for a store that cannot be read", async () => {
    const { env, db } = setup();
    await suppressEmail(env, db, "Gone@Example.com", "complaint", NOW);
    expect(await wouldDeliver(env, db, "gone@example.com", NOW)).toBe(false);
    const broken = {
      ...db,
      first: async () => {
        throw new Error("store down");
      },
    } as unknown as Db;
    expect(await wouldDeliver(env, broken, "ada@example.com", NOW)).toBe(false);
  });

  it("agrees with deliverEmail on every case above", async () => {
    const { env, db } = setup();
    await suppressEmail(env, db, "gone@example.com", "complaint", NOW);
    for (const to of [
      "ada@example.com",
      "gone@example.com",
      "x@privaterelay.appleid.com",
      "nope",
    ]) {
      const sent = await deliverEmail(
        env,
        db,
        { to, subject: "s", text: "t", sender: { kind: "platform" } },
        NOW,
      );
      expect(await wouldDeliver(env, db, to, NOW), to).toBe(sent.ok);
    }
  });
});

describe("securityNoticeDeliverable", () => {
  it("is true when any address passes, false when none does", async () => {
    const { env, db } = setup();
    const relay = "abc@privaterelay.appleid.com";
    // The account row set is empty in this db: only `alsoTo` counts.
    expect(
      await securityNoticeDeliverable(env, db, "acc_none", [relay], NOW),
    ).toBe(false);
    expect(
      await securityNoticeDeliverable(
        env,
        db,
        "acc_none",
        [relay, "ada@example.com"],
        NOW,
      ),
    ).toBe(true);
    expect(
      await securityNoticeDeliverable(env, db, "acc_none", null, NOW),
    ).toBe(false);
  });
});

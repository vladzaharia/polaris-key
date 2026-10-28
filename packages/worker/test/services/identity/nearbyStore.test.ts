/// <reference types="@cloudflare/workers-types" />

// The nearby request's store (I-40.2): the claim race, a stale claim, a sticky decision, the
// third key mismatch, the 300 s lifetime, and that nothing raw is stored.

import { afterEach, describe, expect, it, vi } from "vitest";
import { newKeys, world, type World } from "../../deviceKeyFixtures.js";
import {
  claimNearby,
  createNearby,
  decideNearby,
  dropNearby,
  mismatchNearby,
  nearbyNetHash,
  nearbyRef,
  readNearby,
  releaseNearby,
  takeNearbyPollSlot,
  type NearbyStartMembers,
} from "../../../src/services/identity/passthrough/nearbyStore.js";

const HANDLE = "nr_AAAAAAAAAAAAAAAAAAAAAA";
const T0 = 1_800_000_000;
const APPROVAL = {
  approvedBy: "acct_m",
  subject: "sub_1",
  licenseId: "lic_1",
  tokenHash: "h".repeat(43),
};

afterEach(() => vi.useRealTimers());

async function open(w: World, handle = HANDLE) {
  const ref = await nearbyRef(w.env, "djdl", handle);
  if (!ref) throw new Error("handle has no address");
  const k = await newKeys();
  const members: NearbyStartMembers = {
    product: "djdl",
    deviceId: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
    signKey: k.signKey,
    agreeKey: k.agreeKey,
    label: "Kitchen TV",
    meta: { platform: "tvos" },
    netHash: await nearbyNetHash(
      w.env,
      new Request("https://x/", {
        headers: { "cf-connecting-ip": "203.0.113.9" },
      }),
    ),
    startedAt: T0,
    proven: false,
  };
  expect(await createNearby(w.env, ref, members)).toBe(true);
  return { ref, members };
}

describe("nearby request store", () => {
  it("addresses by product and the hash of the handle; a bad shape has none", async () => {
    const w = await world();
    expect(await nearbyRef(w.env, "djdl", "nr_short")).toBeNull();
    expect(
      await nearbyRef(w.env, "djdl", "xx_AAAAAAAAAAAAAAAAAAAAAA"),
    ).toBeNull();
    const a = await nearbyRef(w.env, "djdl", HANDLE);
    const b = await nearbyRef(w.env, "other", HANDLE);
    expect(a!.kind).toBe("nearby-request");
    expect(a!.id.startsWith("djdl:")).toBe(true);
    expect(a!.id).not.toContain(HANDLE);
    expect(b!.id).not.toBe(a!.id);
  });

  it("creates pending, once per address, with no raw network address", async () => {
    const w = await world();
    const { ref, members } = await open(w);
    const rec = await readNearby(w.env, ref);
    expect(rec).toMatchObject({ ...members, state: "pending" });
    expect(await createNearby(w.env, ref, members)).toBe(false);
    const stored = JSON.stringify(rec);
    expect(stored).not.toContain("203.0.113.9");
    expect(stored).not.toContain(HANDLE);
    expect(rec!.netHash).toMatch(/\S{20,}/);
  });

  it("lets one of two racing claims win", async () => {
    const w = await world();
    const { ref } = await open(w);
    const [a, b] = await Promise.all([
      claimNearby(w.env, ref, "m1", T0 + 1),
      claimNearby(w.env, ref, "m2", T0 + 1),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const winner = a.ok ? "m1" : "m2";
    expect((await readNearby(w.env, ref))!.claimedBy).toBe(winner);
    // The loser is told the current record.
    expect((a.ok ? b : a).record!.claimedBy).toBe(winner);
  });

  it("keeps a fresh claim and retakes one at 30 s", async () => {
    const w = await world();
    const { ref } = await open(w);
    expect((await claimNearby(w.env, ref, "m1", T0 + 10)).ok).toBe(true);
    expect((await claimNearby(w.env, ref, "m2", T0 + 39)).ok).toBe(false);
    expect((await claimNearby(w.env, ref, "m1", T0 + 39)).ok).toBe(false);
    const taken = await claimNearby(w.env, ref, "m2", T0 + 40);
    expect(taken.ok && taken.record).toMatchObject({
      state: "claimed",
      claimedBy: "m2",
      claimedAt: T0 + 40,
    });
    // The first claimant can no longer decide.
    expect(
      (await decideNearby(w.env, ref, "m1", { deny: true }, T0 + 41)).ok,
    ).toBe(false);
  });

  it("lets two racing takeovers of a stale claim produce one winner", async () => {
    const w = await world();
    const { ref } = await open(w);
    await claimNearby(w.env, ref, "m1", T0);
    const [a, b] = await Promise.all([
      claimNearby(w.env, ref, "m2", T0 + 60),
      claimNearby(w.env, ref, "m3", T0 + 60),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("decides only for the claimant, and the decision is sticky", async () => {
    const w = await world();
    const { ref } = await open(w);
    // Not claimed yet.
    expect(
      (await decideNearby(w.env, ref, "m1", { deny: true }, T0 + 1)).ok,
    ).toBe(false);
    await claimNearby(w.env, ref, "m1", T0 + 1);
    expect(
      (await decideNearby(w.env, ref, "m2", { deny: true }, T0 + 2)).ok,
    ).toBe(false);
    const done = await decideNearby(
      w.env,
      ref,
      "m1",
      { approve: APPROVAL },
      T0 + 3,
    );
    expect(done.ok && done.record).toMatchObject({
      state: "approved",
      decidedAt: T0 + 3,
      ...APPROVAL,
    });
    // Nothing moves it afterwards.
    expect(
      (await decideNearby(w.env, ref, "m1", { deny: true }, T0 + 4)).ok,
    ).toBe(false);
    expect((await claimNearby(w.env, ref, "m2", T0 + 500)).ok).toBe(false);
    expect((await releaseNearby(w.env, ref, "m1")).ok).toBe(false);
    expect((await readNearby(w.env, ref))!.state).toBe("approved");
  });

  it("keeps only a token hash after an approval", async () => {
    const w = await world();
    const { ref } = await open(w);
    await claimNearby(w.env, ref, "m1", T0);
    await decideNearby(w.env, ref, "m1", { approve: APPROVAL }, T0 + 1);
    const rec = await readNearby(w.env, ref);
    expect(Object.keys(rec!).filter((k) => /token/i.test(k))).toEqual([
      "tokenHash",
    ]);
  });

  it("records a deny as sticky", async () => {
    const w = await world();
    const { ref } = await open(w);
    await claimNearby(w.env, ref, "m1", T0);
    const done = await decideNearby(w.env, ref, "m1", { deny: true }, T0 + 1);
    expect(done.ok && done.record.state).toBe("denied");
    expect((await claimNearby(w.env, ref, "m1", T0 + 99)).ok).toBe(false);
  });

  it("releases a claim back to pending, for the claimant only", async () => {
    const w = await world();
    const { ref } = await open(w);
    await claimNearby(w.env, ref, "m1", T0);
    expect((await releaseNearby(w.env, ref, "m2")).ok).toBe(false);
    const back = await releaseNearby(w.env, ref, "m1");
    expect(back.ok && back.record.state).toBe("pending");
    const rec = (await readNearby(w.env, ref))!;
    expect(rec.claimedBy).toBeUndefined();
    expect(rec.claimedAt).toBeUndefined();
    expect((await claimNearby(w.env, ref, "m2", T0 + 1)).ok).toBe(true);
  });

  it("ends the request on the third key mismatch", async () => {
    const w = await world();
    const { ref } = await open(w);
    expect((await mismatchNearby(w.env, ref)).alive).toBe(true);
    expect((await mismatchNearby(w.env, ref)).alive).toBe(true);
    expect(await readNearby(w.env, ref)).not.toBeNull();
    expect((await mismatchNearby(w.env, ref)).alive).toBe(false);
    expect(await readNearby(w.env, ref)).toBeNull();
    expect((await claimNearby(w.env, ref, "m1", T0)).ok).toBe(false);
  });

  it("does not count claims, decisions or polls as attempts", async () => {
    const w = await world();
    const { ref } = await open(w);
    for (let i = 0; i < 5; i++) {
      await claimNearby(w.env, ref, "m1", T0 + i);
      await releaseNearby(w.env, ref, "m1");
      await takeNearbyPollSlot(w.env, ref, undefined, T0 + i);
    }
    expect(await readNearby(w.env, ref)).not.toBeNull();
  });

  it("takes the poll slot once per read of lastPollAt", async () => {
    const w = await world();
    const { ref } = await open(w);
    const [a, b] = await Promise.all([
      takeNearbyPollSlot(w.env, ref, undefined, T0 + 1),
      takeNearbyPollSlot(w.env, ref, undefined, T0 + 1),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect((await readNearby(w.env, ref))!.lastPollAt).toBe(T0 + 1);
    expect((await takeNearbyPollSlot(w.env, ref, T0 + 1, T0 + 6)).ok).toBe(
      true,
    );
    const gone = await takeNearbyPollSlot(
      w.env,
      (await nearbyRef(w.env, "djdl", "nr_BBBBBBBBBBBBBBBBBBBBBB"))!,
      undefined,
      T0,
    );
    expect(gone).toEqual({ ok: false, record: null });
  });

  it("expires 300 s after start, whatever was decided since", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0 * 1000));
    const w = await world();
    const { ref } = await open(w);
    vi.setSystemTime(new Date((T0 + 200) * 1000));
    await claimNearby(w.env, ref, "m1", T0 + 200);
    await decideNearby(w.env, ref, "m1", { approve: APPROVAL }, T0 + 201);
    vi.setSystemTime(new Date((T0 + 299) * 1000));
    expect(await readNearby(w.env, ref)).not.toBeNull();
    vi.setSystemTime(new Date((T0 + 301) * 1000));
    expect(await readNearby(w.env, ref)).toBeNull();
    expect((await claimNearby(w.env, ref, "m2", T0 + 301)).ok).toBe(false);
  });

  it("drops a request", async () => {
    const w = await world();
    const { ref } = await open(w);
    await dropNearby(w.env, ref);
    await dropNearby(w.env, ref);
    expect(await readNearby(w.env, ref)).toBeNull();
  });
});

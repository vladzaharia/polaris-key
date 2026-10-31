// @pkey-feature connect.identity connect.lan
// Custody of Cloud Connect state (WIRE-CONTRACT-V5 §15.4, §15.6): deactivation leaves Cloud
// Connect before the credential goes, and a roster this device stores re-admits every open
// session. Two clients, a LAN session between them, a fake Worker and a fake relay room.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { ErrorCode } from "../src/constants.generated.js";
import { PolarisError } from "@polaris-key/client-core";
import type { ConnectSession } from "../src/connect/session.js";
import { MemoryMdnsNetwork, devId, loopLan, until } from "./lanFixtures.js";
import { relayHarness } from "./relayFixtures.js";

const { world } = relayHarness();
const A = devId("1");
const B = devId("2");

/** A LAN session from A to B, with both sides running Cloud Connect. */
async function lanPair() {
  const w = await world();
  const net = new MemoryMdnsNetwork();
  const lan = loopLan(net);
  const relay = { webSocket: w.room.webSocket };
  await w.a.cloudConnect.start({ lan, relay });
  await w.b.cloudConnect.start({ lan, relay });
  await until(() => w.a.cloudConnect.peers().some((p) => p.lan));
  const session: ConnectSession = await w.a.cloudConnect.open(B);
  return { ...w, session };
}

const keys = (): { signKey: string; agreeKey: string } => {
  const raw = (k: Buffer): string =>
    base64UrlEncodeBytes(new Uint8Array(k.subarray(k.length - 32)));
  const opts = { format: "der", type: "spki" } as const;
  return {
    signKey: raw(generateKeyPairSync("ed25519").publicKey.export(opts)),
    agreeKey: raw(generateKeyPairSync("x25519").publicKey.export(opts)),
  };
};

describe("deactivation", () => {
  it("deactivation leaves Cloud Connect", async () => {
    for (const via of ["deactivate", "deauthorizeDevice"] as const) {
      const { a, session } = await lanPair();
      expect(await a.connect.discoveryKeys()).not.toBeNull();
      if (via === "deactivate") await a.license.deactivate();
      else await a.deauthorizeDevice(A);
      expect(session.closed).not.toBeNull();
      expect(a.cloudConnect.status().running).toBe(false);
      expect(await a.connect.current()).toBeNull();
      expect(await a.connect.discoveryKeys()).toBeNull();
    }
  });

  it("deactivation stops when Connect state cannot be cleared", async () => {
    const { a } = await lanPair();
    const license = a.license as unknown as {
      tokens: { current: string | null };
      ctx: { fetcher(): unknown };
    };
    const fetcher = vi.spyOn(license.ctx, "fetcher");
    vi.spyOn(a.connect, "leave").mockRejectedValue(
      new PolarisError(ErrorCode.storeFailed, "cannot clear"),
    );
    await expect(a.license.deactivate()).rejects.toMatchObject({
      code: ErrorCode.storeFailed,
    });
    expect(license.tokens.current).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("a stored roster", () => {
  it("a stored roster closes open sessions with a device it drops", async () => {
    // Pushed: adopted outside the session that carried it.
    {
      const { a, worker, session } = await lanPair();
      worker.members.delete(B);
      worker.epoch++;
      const sub = (await a.connect.current())!.sub;
      expect(await a.connect.adoptRing(await worker.ring(sub))).toMatchObject({
        stored: true,
      });
      await until(() => session.closed !== null);
      expect(session.closed).toEqual({ code: "peer_revoked", byPeer: false });
    }
    // Fetched: an identity refresh at a higher epoch.
    {
      const { a, worker, session } = await lanPair();
      worker.members.delete(B);
      worker.epoch++;
      await a.connect.identity({ refresh: true });
      await until(() => session.closed !== null);
      expect(session.closed).toEqual({ code: "peer_revoked", byPeer: false });
    }
  });

  it("a stored roster that only adds a device keeps open sessions", async () => {
    const { a, worker, session } = await lanPair();
    worker.members.set(devId("3"), keys());
    worker.epoch++;
    const sub = (await a.connect.current())!.sub;
    expect(await a.connect.adoptRing(await worker.ring(sub))).toMatchObject({
      stored: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(session.closed).toBeNull();
  });
});

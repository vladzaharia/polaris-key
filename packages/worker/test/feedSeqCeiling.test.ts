/**
 * P3-03 — the `feed:seq-ceiling` recovery script against a local D1 (the test database runs every
 * migration). After a suspected signer compromise the operator runs it for the product: the next
 * feed of a channel that had a `seq` row, and the FIRST feed of a manual channel that had none
 * before the script ran, both carry `seq` 2^53 − 1, verify, pass the v4 claims, and pass §2.5
 * step 8 against the old floor — the honest one and an attacker's fast-forward alike.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyJws } from "@polaris-key/jws";
import { feedClaims } from "@polaris-key/client-core/feed";
import { MAX_WIRE_INTEGER as PROTOCOL_MAX } from "@polaris-key/protocol/core";
import { installDigestStream } from "./r2Mock.js";
import { NOW, TEST_KID, TEST_PUB } from "./seed.js";
import { SLUG } from "./releaseRoutesFixture.js";
import { feedWorld, getFeed, publish, type FeedWorld } from "./feedWorld.js";
import {
  MAX_WIRE_INTEGER,
  seqCeilingStatements,
} from "../scripts/feed-seq-ceiling.mjs";

installDigestStream();

let w: FeedWorld;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  w = await feedWorld();
});
afterEach(() => vi.useRealTimers());

function tick(seconds: number): void {
  w.now += seconds;
  vi.setSystemTime(w.now * 1000);
}

/** WIRE-CONTRACT-V4 §2.5 step 8: accept a strictly higher seq, or the same seq signed later. */
function step8(
  feed: { seq: number; issuedAt: number },
  floor: { seq: number; issuedAt: number },
): "accept" | "not-newer" | "rollback" {
  if (feed.seq > floor.seq) return "accept";
  if (feed.seq === floor.seq)
    return feed.issuedAt > floor.issuedAt ? "accept" : "not-newer";
  return "rollback";
}

async function runScript(): Promise<void> {
  const stmts = seqCeilingStatements(SLUG, w.now);
  await w.db.batch(stmts.map((sql) => ({ sql, params: [] })));
}

async function verified(channel: string, requested = channel) {
  const { res, jws } = await getFeed(w, requested);
  expect(res.status).toBe(200);
  const v = await verifyJws(
    jws,
    { [TEST_KID]: TEST_PUB },
    { typ: "pkey-feed+jws" },
  );
  expect(v).not.toBeNull();
  expect(
    feedClaims(v!.payload, {
      expectedAud: SLUG,
      channel: requested,
      platform: "macos",
      nonWire: v!.nonWireIntegers,
    }),
  ).toBeNull();
  const p = v!.payload as { channel: string; seq: number; issuedAt: number };
  expect(p.channel).toBe(channel);
  return p;
}

describe("feed:seq-ceiling", () => {
  it("the script's ceiling is the protocol's MAX_WIRE_INTEGER, and it refuses a non-slug", () => {
    expect(MAX_WIRE_INTEGER).toBe(PROTOCOL_MAX);
    expect(() =>
      seqCeilingStatements("x'; DROP TABLE products; --", NOW),
    ).toThrow();
  });

  it("recovers a channel that had a row and a manual channel that had none", async () => {
    await publish(w, "1.3.0");
    await publish(w, "1.3.1-qa", { channel: "qa" });
    // Before: `stable` has been served (a row at seq 1); `qa` has never been requested.
    const before = await verified("stable", "latest");
    expect(before.seq).toBe(1);
    const rowsBefore = await w.db.all<{ channel: string }>(
      "SELECT channel FROM update_feed_state WHERE product = ?",
      SLUG,
    );
    expect(rowsBefore.map((r) => r.channel)).toEqual(["stable"]);
    // The attacker's fast-forward a client may have committed: seq at the ceiling, issued
    // shortly before recovery (no more than 300 s ahead of the client's clock).
    const attackerFloor = { seq: MAX_WIRE_INTEGER, issuedAt: w.now + 200 };

    tick(60);
    await runScript();
    // The stored documents are gone and the flag is set.
    expect(
      (await w.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM update_feed_docs WHERE product = ?",
        SLUG,
      ))!.n,
    ).toBe(0);
    await runScript(); // idempotent

    // Real time passes the attacker's issuedAt (a client whose clock ran ahead waits for it).
    tick(300);
    const stable = await verified("stable", "latest");
    expect(stable.seq).toBe(MAX_WIRE_INTEGER);
    expect(step8(stable, before)).toBe("accept");
    expect(step8(stable, attackerFloor)).toBe("accept");

    const qa = await verified("qa");
    expect(qa.seq).toBe(MAX_WIRE_INTEGER);
    expect(step8(qa, attackerFloor)).toBe("accept");

    // A change of content afterwards re-signs at the ceiling with a newer issuedAt.
    tick(30);
    await publish(w, "1.3.2");
    const later = await verified("stable");
    expect(later.seq).toBe(MAX_WIRE_INTEGER);
    expect(step8(later, stable)).toBe("accept");
  });
});

/**
 * I-11 (S-16 §5.5): the request-time erasure fence, `core/accounts/erasureFence.ts`.
 *
 * A D1 restore rewinds the account, its sessions and its tokens to before an erasure; the R2
 * ledger is what it does not rewind. `erasureVerdict` is the one read of it on the request path:
 * `erased` when the ledger holds the id, `unavailable` when that cannot be read (fail closed), and
 * `clear` otherwise. These tests pin its contract; the gates that act on it are pinned where they
 * live (`accountErasure.test.ts`, `portalErasureFence.test.ts`, `identityErasureFence.test.ts`,
 * `registryErasureFence.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { KvMock } from "./kvMock.js";
import { asR2 } from "./r2Mock.js";
import { LedgerBucket } from "./eraseRestore.js";
import { makeEnv, NOW } from "./seed.js";
import {
  ERASURE_CLEAR_TTL_SECONDS,
  ERASURE_PREFIX,
  erasureKey,
  erasureVerdict,
  noteErased,
} from "../src/core/accounts/erasureFence.js";
import { recordErasure } from "../src/services/identity/accounts/erasureLedger.js";

function world(bucket = new LedgerBucket()) {
  const env = makeEnv(new KvMock(), []);
  env.BLOBS = asR2(bucket);
  return { env, bucket };
}

/** The ledger holds `acct_a` and no other account. */
async function ledgerWithA(bucket: LedgerBucket) {
  await bucket.put(erasureKey("acct_a"), "{}");
}

describe("erasureFence: the verdict", () => {
  it("names the ledger key by the opaque account id and nothing else", () => {
    expect(ERASURE_PREFIX).toBe("erasures/");
    expect(erasureKey("acct_a")).toBe("erasures/acct_a");
  });

  it("is `erased` when the ledger holds the account and `clear` when it does not", async () => {
    const { env, bucket } = world();
    await ledgerWithA(bucket);
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("erased");
    expect(await erasureVerdict(env, NOW, "acct_b")).toBe("clear");
    expect(bucket.heads).toEqual(["erasures/acct_a", "erasures/acct_b"]);
  });

  it("asks about nothing, and reads nothing, when there is no account to ask about", async () => {
    const { env, bucket } = world();
    expect(await erasureVerdict(env, NOW)).toBe("clear");
    expect(await erasureVerdict(env, NOW, null, undefined, "")).toBe("clear");
    expect(bucket.heads).toEqual([]);
    // Not even a missing bucket matters when no account is named.
    delete env.BLOBS;
    expect(await erasureVerdict(env, NOW)).toBe("clear");
  });

  it("fails closed: an unbound bucket is `unavailable`", async () => {
    const { env } = world();
    delete env.BLOBS;
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("unavailable");
  });

  it("fails closed: a failing read is `unavailable`, is never remembered, and recovers", async () => {
    const { env, bucket } = world();
    bucket.down = true;
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("unavailable");
    expect(await erasureVerdict(env, NOW + 1, "acct_a")).toBe("unavailable");
    expect(bucket.heads).toHaveLength(2);
    // R2 is back: the very next request is answered truthfully, not from a remembered failure.
    bucket.down = false;
    await ledgerWithA(bucket);
    expect(await erasureVerdict(env, NOW + 2, "acct_a")).toBe("erased");
  });

  it("with several accounts: `erased` outranks `unavailable`, which outranks `clear`", async () => {
    class BrokenForB extends LedgerBucket {
      override async head(key: string) {
        if (key === erasureKey("acct_b")) throw new Error("R2 5xx");
        return super.head(key);
      }
    }
    const { env, bucket } = world(new BrokenForB());
    await ledgerWithA(bucket);
    // `acct_a` is on the ledger, `acct_b` cannot be read: erased still wins.
    expect(await erasureVerdict(env, NOW, "acct_b", "acct_a")).toBe("erased");
    // With only the unreadable one beside a clear one, nothing can be said.
    expect(await erasureVerdict(env, NOW, "acct_b", "acct_c")).toBe(
      "unavailable",
    );
    expect(await erasureVerdict(env, NOW, "acct_c", "acct_d")).toBe("clear");
  });

  it("asks once per distinct account, however many times it is named", async () => {
    const { env, bucket } = world();
    expect(
      await erasureVerdict(env, NOW, "acct_a", "acct_a", null, "acct_a"),
    ).toBe("clear");
    expect(bucket.heads).toEqual(["erasures/acct_a"]);
  });
});

describe("erasureFence: what an isolate remembers", () => {
  it("keeps `erased` for the isolate's life, whatever the clock says", async () => {
    const { env, bucket } = world();
    await ledgerWithA(bucket);
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("erased");
    expect(await erasureVerdict(env, NOW + 10 * 365 * 86_400, "acct_a")).toBe(
      "erased",
    );
    // Not even a failing R2 can make an erased account answer anything else.
    bucket.down = true;
    expect(await erasureVerdict(env, NOW + 1, "acct_a")).toBe("erased");
    expect(bucket.heads).toHaveLength(1);
  });

  it(`believes \`clear\` for ${ERASURE_CLEAR_TTL_SECONDS} seconds, then reads again`, async () => {
    const { env, bucket } = world();
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("clear");
    // An erasure another isolate recorded meanwhile is unseen inside the window ...
    await ledgerWithA(bucket);
    expect(
      await erasureVerdict(env, NOW + ERASURE_CLEAR_TTL_SECONDS - 1, "acct_a"),
    ).toBe("clear");
    expect(bucket.heads).toHaveLength(1);
    // ... and seen the moment it ends.
    expect(
      await erasureVerdict(env, NOW + ERASURE_CLEAR_TTL_SECONDS, "acct_a"),
    ).toBe("erased");
    expect(bucket.heads).toHaveLength(2);
  });

  it("knows an erasure this isolate recorded at once: the write-ahead is written through", async () => {
    const { env, bucket } = world();
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("clear");
    expect(await recordErasure(env, "acct_a", NOW)).toBe("created");
    expect(await erasureVerdict(env, NOW + 1, "acct_a")).toBe("erased");
    expect(bucket.heads).toHaveLength(1);
    // A record that already existed is just as erased.
    expect(await erasureVerdict(env, NOW, "acct_b")).toBe("clear");
    await bucket.put(erasureKey("acct_b"), "{}");
    expect(await recordErasure(env, "acct_b", NOW)).toBe("exists");
    expect(await erasureVerdict(env, NOW + 1, "acct_b")).toBe("erased");
    expect(bucket.heads).toHaveLength(2);
  });

  it("`noteErased` needs a bucket and writes nothing to it", async () => {
    const { env, bucket } = world();
    noteErased(env, "acct_a");
    expect(await erasureVerdict(env, NOW, "acct_a")).toBe("erased");
    expect(bucket.keys()).toEqual([]);
    expect(bucket.heads).toEqual([]);
    delete env.BLOBS;
    expect(() => noteErased(env, "acct_z")).not.toThrow();
  });

  it("never shares an answer between two buckets", async () => {
    const a = world();
    const b = world();
    await ledgerWithA(a.bucket);
    expect(await erasureVerdict(a.env, NOW, "acct_a")).toBe("erased");
    expect(await erasureVerdict(b.env, NOW, "acct_a")).toBe("clear");
    expect(await erasureVerdict(b.env, NOW, "acct_a")).toBe("clear");
    expect(b.bucket.heads).toEqual(["erasures/acct_a"]);
  });

  it("holds at most 5,000 answers of each kind: a full memory is emptied, and answers stay true", async () => {
    const { env, bucket } = world();
    for (let i = 0; i < 5_000; i++) await erasureVerdict(env, NOW, `acct_${i}`);
    expect(bucket.heads).toHaveLength(5_000);
    // Still remembered: no read.
    expect(await erasureVerdict(env, NOW, "acct_0")).toBe("clear");
    expect(bucket.heads).toHaveLength(5_000);
    // One more distinct account empties the map first; the earliest is read again, correctly.
    expect(await erasureVerdict(env, NOW, "acct_5000")).toBe("clear");
    expect(await erasureVerdict(env, NOW, "acct_0")).toBe("clear");
    expect(bucket.heads).toHaveLength(5_002);
    await ledgerWithA(bucket);
    expect(await erasureVerdict(env, NOW + 31, "acct_a")).toBe("erased");
  });
});

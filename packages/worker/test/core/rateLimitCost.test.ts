/** A limiter call can count for more than one unit (a byte budget charges by size). */
import { describe, expect, it } from "vitest";
import { rateLimitOk } from "../../src/core/rateLimit.js";
import type { Env } from "../../src/platform/env.js";
import { makeRlNamespace } from "../rlMock.js";

describe("limiter cost", () => {
  it("counts a call for its cost and refuses once the budget is reached", async () => {
    const env = { RL: makeRlNamespace() } as unknown as Env;
    const rl = {
      bucket: "adminSyncDownloadMiB",
      id: "m",
      limit: 10,
      windowSec: 3600,
    };
    expect(await rateLimitOk(env, "_admin", { ...rl, cost: 6 }, 100)).toBe(
      true,
    );
    // 6 of 10 used: another large call is let in once, and takes the counter past the budget.
    expect(await rateLimitOk(env, "_admin", { ...rl, cost: 6 }, 100)).toBe(
      true,
    );
    expect(await rateLimitOk(env, "_admin", { ...rl, cost: 1 }, 100)).toBe(
      false,
    );
    expect(
      await rateLimitOk(env, "_admin", { ...rl, cost: 1 }, 100 + 3600),
    ).toBe(true);
  });

  it("a call without a cost counts one", async () => {
    const env = { RL: makeRlNamespace() } as unknown as Env;
    const rl = {
      bucket: "adminSyncDownload",
      id: "m",
      limit: 2,
      windowSec: 60,
    };
    expect(await rateLimitOk(env, "_admin", rl, 5)).toBe(true);
    expect(await rateLimitOk(env, "_admin", rl, 5)).toBe(true);
    expect(await rateLimitOk(env, "_admin", rl, 5)).toBe(false);
  });
});

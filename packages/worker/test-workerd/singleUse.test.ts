/// <reference types="@cloudflare/workers-types" />
// I-02: the atomic single-use store on the REAL Durable Object (wrangler.toml's `SINGLE_USE`
// binding, migration `v3`). The Node lane models the input gate with a serialising mock; this
// lane is the runtime truth that two concurrent consumes of one artefact cannot both win.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  redeemArtefact,
  updateArtefact,
} from "../src/core/singleUse.js";
import {
  issueEmailCode,
  verifyEmailCode,
} from "../src/core/notify/emailLimits.js";
import { rateLimitOk } from "../src/core/rateLimit.js";
import type { Env as WorkerEnv } from "../src/platform/env.js";

const workerEnv = env as unknown as WorkerEnv;

describe("single-use store on workerd", () => {
  it("two concurrent consume calls for one artefact: exactly one succeeds", async () => {
    const ref = artefactRef("portal-magic", `race-${crypto.randomUUID()}`);
    await putArtefact(workerEnv, ref, "once", 600);
    const [a, b] = await Promise.all([
      consumeArtefact(workerEnv, ref),
      consumeArtefact(workerEnv, ref),
    ]);
    expect([a, b].filter((v) => v === "once")).toHaveLength(1);
    expect([a, b].filter((v) => v === null)).toHaveLength(1);
    expect(await getArtefact(workerEnv, ref)).toBeNull();
  });

  it("a burst of concurrent consumes: exactly one succeeds", async () => {
    const ref = artefactRef("oidc-flow", `djdl:burst-${crypto.randomUUID()}`);
    await putArtefact(workerEnv, ref, "once", 600);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeArtefact(workerEnv, ref)),
    );
    expect(results.filter((v) => v === "once")).toHaveLength(1);
  });

  it("concurrent compare-and-set claims: exactly one wins", async () => {
    const ref = artefactRef("oidc-flow", `djdl:claim-${crypto.randomUUID()}`);
    await putArtefact(workerEnv, ref, JSON.stringify({ verifier: "v" }), 600);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateArtefact(workerEnv, ref, {
          expect: { consumedAt: null },
          set: { consumedAt: i + 1 },
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("concurrent redeems of one right proof: exactly one succeeds", async () => {
    const ref = artefactRef("email-code", `djdl:redeem-${crypto.randomUUID()}`);
    await putArtefact(workerEnv, ref, "p", 600, {
      proof: "aa11",
      maxAttempts: 5,
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => redeemArtefact(workerEnv, ref, "aa11")),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("an email code verifies once end to end", async () => {
    const addr = {
      product: "djdl",
      recipient: "workerd@example.com",
      flowId: crypto.randomUUID(),
    };
    const req = new Request("https://key.plrs.im/");
    const { code } = await issueEmailCode(workerEnv, addr, "payload");
    const results = await Promise.all([
      verifyEmailCode(workerEnv, { ...addr, code, req }),
      verifyEmailCode(workerEnv, { ...addr, code, req }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("a sharded _portal limiter stays exact under a burst", async () => {
    const rl = {
      bucket: "portalLogin",
      id: `203.0.113.${Math.floor(Math.random() * 200)}-${crypto.randomUUID()}`,
      limit: 3,
      windowSec: 60,
    };
    const now = Math.floor(Date.now() / 1000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        rateLimitOk(workerEnv, "_portal", rl, now),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});

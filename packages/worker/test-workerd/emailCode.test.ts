/// <reference types="@cloudflare/workers-types" />
// PX-W4: the account sign-in's email code on the REAL single-use object and the real D1. The
// Node lane races the verify route over a serialising model of the object; this lane races the
// same handler in the runtime, where one code must still open exactly one account session.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db } from "../src/db/d1.js";
import { issueEmailCode } from "../src/core/emailLimits.js";
import { putArtefact } from "../src/core/singleUse.js";
import { SIGNIN_FLOW_COOKIE } from "../src/core/accountCookies.js";
import {
  handleSigninEmailVerify,
  PORTAL_EMAIL_SCOPE,
  signinFlowRef,
} from "../src/services/identity/card/emailSignIn.js";
import type { Env as WorkerEnv } from "../src/env.js";

const workerEnv = {
  ...env,
  KEY_HASH_PEPPER: "workerd-email-code-pepper",
  PORTAL_SESSION_SECRET: "workerd-email-code-session",
} as unknown as WorkerEnv;

describe("email code on workerd", () => {
  it("five racing verifications of one right code: exactly one signs in", async () => {
    const db = new D1Db(env.DB);
    const now = Math.floor(Date.now() / 1000);
    const email = `race-${crypto.randomUUID()}@example.com`;
    const secret = crypto.randomUUID();
    const ref = await signinFlowRef(workerEnv, secret);
    await putArtefact(
      workerEnv,
      ref,
      JSON.stringify({
        v: 1,
        email,
        createdAt: now,
        place: "an unknown location",
        status: "pending",
        attempts: 0,
      }),
      600,
    );
    const { code } = await issueEmailCode(
      workerEnv,
      { product: PORTAL_EMAIL_SCOPE, recipient: email, flowId: ref.id },
      JSON.stringify({ flow: ref.id }),
    );

    const verify = () =>
      handleSigninEmailVerify(
        new Request("https://key.plrs.im/api/signin/email/verify", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${SIGNIN_FLOW_COOKIE}=${secret}`,
            "cf-connecting-ip": "203.0.113.77",
          },
          body: JSON.stringify({ code }),
        }),
        workerEnv,
        db,
        now,
      );
    const results = await Promise.all(Array.from({ length: 5 }, verify));

    expect(results.map((r) => r.status).sort()).toEqual([
      200, 400, 400, 400, 400,
    ]);
    const sessions = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM account_sessions s
         JOIN account_links l ON l.account_id = s.account_id
        WHERE l.subject = ?`,
    )
      .bind(email)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
  });
});

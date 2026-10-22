// @vitest-environment node
//
// @pkey-feature identity.devicecode
//
// I-37d: approved, but the Worker could not finish the sign-in yet. The device-code poll answers
// `503 {"error":"unavailable"}` with `Retry-After` (WIRE-CONTRACT-V4 §12.10 rule 5). Bearer
// mode's wait loop treats the 5xx as transient, keeps polling, and ends on the `ready` that
// follows; the single poll surfaces it as a thrown `server-error`.

import { describe, expect, it } from "vitest";
import type { CacheRecordV3, Store } from "@polaris-key/client-core";
import {
  BearerSession,
  type SignInPrompt,
} from "../src/browser/bearer/session.js";

const NOW = 1_700_000_000;

class MemStore implements Store {
  private cache: CacheRecordV3 | null = null;
  private token: string | null = null;
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return "RETRYDEVICE000000000000000000001";
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
}

const unavailable = () =>
  new Response(JSON.stringify({ error: "unavailable", message: "try again" }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "2" },
  });
const ready = () =>
  new Response(
    JSON.stringify({
      status: "ready",
      token: "pkeyt_retry",
      schemaVersion: 1,
      identity: { name: "Player" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const PROMPT: SignInPrompt = {
  deviceCode: "dc",
  userCode: "BCDF-GHJK",
  verificationUri: "https://key.plrs.im/acme/identity/auth/device",
  verificationUriComplete:
    "https://key.plrs.im/acme/identity/auth/device?user_code=BCDF-GHJK",
  expiresIn: 600,
  interval: 2,
  expiresAt: NOW + 600,
  deviceName: null,
};

function harness(answers: Response[]) {
  let polls = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (!String(input).includes("/identity/auth/device/poll"))
      return new Response("", { status: 404 });
    polls += 1;
    return answers.shift() ?? ready();
  }) as typeof fetch;
  const session = new BearerSession({
    baseUrl: "https://key.plrs.im",
    product: "acme",
    version: "1.0.0",
    fetchImpl,
    now: () => NOW,
    pinned: { k: "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI" },
    store: new MemStore(),
    enabled: (slug) => slug === "license" || slug === "identity",
  });
  return { session, polls: () => polls };
}

describe("the device-code poll rides out a 503 (I-37d)", () => {
  it("a single poll reports a thrown server-error", async () => {
    const h = harness([unavailable()]);
    await expect(h.session.pollSignIn(PROMPT)).rejects.toMatchObject({
      code: "server-error",
    });
  });

  it("waitForSignIn keeps polling after a 503 and ends ready", async () => {
    const h = harness([unavailable(), unavailable()]);
    const slept: number[] = [];
    const done = await h.session.waitForSignIn(PROMPT, {
      sleep: async (s) => {
        slept.push(s);
      },
    });
    expect(done.status).toBe("ready");
    expect(h.polls()).toBe(3);
    // The interval does not change: the Worker enforces the spacing (D5).
    expect(slept).toEqual([2, 2, 2]);
  });
});

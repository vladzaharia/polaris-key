// @pkey-feature identity.devicecode
// Device-code sign-in (RFC 8628): the pacing rules `waitForSignIn` owns, which a transcript
// cannot show because a recorded conversation has no clock between its requests.
//
//   * no poll comes earlier than `interval` after the previous one (or after the prompt);
//   * a `slow_down` lengthens the interval for every later poll — to the server's value, or by
//     five seconds when it names none — and never shortens it;
//   * a failed poll is retried at the SAME interval, never faster;
//   * repeated interval-less `slow_down`s each add five seconds to the CURRENT interval;
//   * the sleep is clamped to [1, expiresIn] seconds — a negative, fractional or huge interval
//     neither spins nor outlives the code;
//   * the prompt's expiry and the caller's AbortSignal both stop polling;
//   * a printed prompt never shows the device code;
//   * Identity off ⇒ `service-unavailable` before any request (D-21).
//
// The clock is Vitest's fake one (Date AND setTimeout), so every sleep is exact and instant.

import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";
import type { ServiceSlug } from "../src/discovery.js";
import type { SignInPrompt } from "../src/identity/client.js";

const PRODUCT = "djdl";
const BASE_URL = "https://k.test";
const T0 = 1_700_000_000;
const START = `/${PRODUCT}/identity/auth/device/start`;
const POLL = `/${PRODUCT}/identity/auth/device/poll`;

interface Call {
  method: string;
  path: string;
  at: number;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = Response | (() => Response) | Error;

/** A control plane that answers each path from a queue (the last answer repeats). */
function plane(answers: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const text = req.method === "GET" ? "" : await req.text();
    calls.push({
      method: req.method,
      path: url.pathname,
      at: Date.now() / 1000,
      headers,
      body: text ? JSON.parse(text) : null,
    });
    const queue = answers[url.pathname];
    if (!queue?.length) return new Response("{}", { status: 404 });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const started = (over: Record<string, unknown> = {}) =>
  json({
    status: "pending",
    deviceCode: "device-code-1",
    userCode: "WDJB-MJHT",
    verificationUri: `${BASE_URL}/${PRODUCT}/identity/auth/device`,
    verificationUriComplete: `${BASE_URL}/${PRODUCT}/identity/auth/device?user_code=WDJB-MJHT`,
    expiresIn: 600,
    interval: 2,
    ...over,
  });

const pending = () => json({ status: "pending" });
const ready = () =>
  json({ status: "ready", token: "pkeyt_signed_in", schemaVersion: 1 });

async function client(
  fetchImpl: typeof fetch,
  services: ServiceSlug[] = ["identity"],
) {
  const store = new InMemoryStore();
  const c = new PolarisKeyClient({
    productSlug: PRODUCT,
    baseUrl: BASE_URL,
    version: "1.0.0",
    trust: { pinnedKeys: {} },
    trustRefresh: false,
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    expectedServices: services,
    devices: { fingerprint: false },
  });
  await c.init();
  return { c, store };
}

/** Drive `waitForSignIn` to completion under fake timers. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 1000 && !done; i += 1)
    await vi.advanceTimersByTimeAsync(500);
  return p;
}

const polls = (calls: Call[]) => calls.filter((c) => c.path === POLL);
const gaps = (times: number[], from: number) =>
  times.map((t, i) => t - (i === 0 ? from : times[i - 1]!));

beforeEach(() => {
  vi.useFakeTimers({ now: T0 * 1000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("beginSignIn", () => {
  it("refuses with service-unavailable before any request when Identity is off", async () => {
    const p = plane({ [START]: [started()] });
    const { c } = await client(p.fetchImpl, ["license", "config"]);
    await expect(c.identity.beginSignIn()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(p.calls).toEqual([]);
  });

  it("posts the device id and name with no bearer, and returns the prompt", async () => {
    const p = plane({ [START]: [started()] });
    const { c, store } = await client(p.fetchImpl);
    await store.setToken("pkeyt_anonymous");
    await c.init();
    const prompt = await c.identity.beginSignIn({ deviceName: " Deck " });
    expect(p.calls[0]!.body).toEqual({
      deviceId: c.core.deviceId,
      deviceName: "Deck",
    });
    expect(p.calls[0]!.headers.authorization).toBeUndefined();
    expect(prompt).toMatchObject({
      userCode: "WDJB-MJHT",
      verificationUriComplete: `${BASE_URL}/${PRODUCT}/identity/auth/device?user_code=WDJB-MJHT`,
      expiresIn: 600,
      interval: 2,
      expiresAt: T0 + 600,
    });
  });
});

describe("waitForSignIn", () => {
  async function begin(answers: Record<string, Answer[]>) {
    const p = plane({ [START]: [started()], ...answers });
    const { c, store } = await client(p.fetchImpl);
    const prompt = await c.identity.beginSignIn();
    return { p, c, store, prompt };
  }

  it("never polls earlier than the interval, and stores the token on ready", async () => {
    const { p, c, store, prompt } = await begin({
      [POLL]: [pending(), pending(), ready()],
    });
    const result = await settle(c.identity.waitForSignIn(prompt));
    expect(result).toEqual({ status: "ready" });
    const times = polls(p.calls).map((x) => x.at);
    expect(times).toHaveLength(3);
    for (const gap of gaps(times, T0)) expect(gap).toBeGreaterThanOrEqual(2);
    expect(await store.getToken()).toBe("pkeyt_signed_in");
    // The post-acquisition sync ran on the new token (Identity alone: just the report).
    const report = p.calls.find((x) => x.path.endsWith("/devices/report"));
    expect(report?.headers.authorization).toBe("Bearer pkeyt_signed_in");
  });

  it("lengthens the interval to the one slow_down names, for every later poll", async () => {
    const { p, c, prompt } = await begin({
      [POLL]: [
        json({ status: "slow_down", interval: 7 }, 429),
        pending(),
        pending(),
        ready(),
      ],
    });
    await settle(c.identity.waitForSignIn(prompt));
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([2, 7, 7, 7]);
  });

  it("adds five seconds when slow_down names no interval, and never shortens it", async () => {
    const { p, c, prompt } = await begin({
      [POLL]: [
        json({ error: "rate_limited" }, 429),
        json({ status: "slow_down", interval: 1 }, 429),
        ready(),
      ],
    });
    await settle(c.identity.waitForSignIn(prompt));
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([2, 7, 7]);
  });

  it("adds five seconds to the CURRENT interval on each interval-less slow_down (RFC 8628 §3.5)", async () => {
    const { p, c, prompt } = await begin({
      [POLL]: [
        json({ error: "rate_limited" }, 429),
        json({ error: "rate_limited" }, 429),
        json({ error: "rate_limited" }, 429),
        ready(),
      ],
    });
    await settle(c.identity.waitForSignIn(prompt));
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([2, 7, 12, 17]);
  });

  it("clamps a negative interval to one second", async () => {
    const { p, c, prompt } = await begin({ [POLL]: [pending(), ready()] });
    await settle(c.identity.waitForSignIn({ ...prompt, interval: -3 }));
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([1, 1]);
  });

  it("clamps a 0.5-second interval up to one second", async () => {
    const p = plane({
      [START]: [started({ interval: 0.5 })],
      [POLL]: [pending(), ready()],
    });
    const { c } = await client(p.fetchImpl);
    const prompt = await c.identity.beginSignIn();
    await settle(c.identity.waitForSignIn(prompt));
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([1, 1]);
  });

  it("clamps a huge interval to the code's lifetime instead of a tight loop", async () => {
    const p = plane({
      [START]: [started({ interval: 1e12, expiresIn: 60 })],
      [POLL]: [pending()],
    });
    const { c } = await client(p.fetchImpl);
    const prompt = await c.identity.beginSignIn();
    const result = await settle(c.identity.waitForSignIn(prompt));
    expect(result).toEqual({ status: "expired" });
    // One 60 s sleep, then expiry: no poll, and not a 1 ms timer overflow.
    expect(polls(p.calls)).toHaveLength(0);
    expect(Date.now() / 1000 - T0).toBeGreaterThanOrEqual(60);
  });

  it("retries a failed poll at the same interval, never faster", async () => {
    const { p, c, prompt } = await begin({
      [POLL]: [
        new TypeError("connection reset"),
        json({ error: "boom" }, 503),
        ready(),
      ],
    });
    const result = await settle(c.identity.waitForSignIn(prompt));
    expect(result).toEqual({ status: "ready" });
    expect(
      gaps(
        polls(p.calls).map((x) => x.at),
        T0,
      ),
    ).toEqual([2, 2, 2]);
  });

  it("stops at the prompt's expiry without asking the server again", async () => {
    const p = plane({
      [START]: [started({ expiresIn: 5 })],
      [POLL]: [pending()],
    });
    const { c } = await client(p.fetchImpl);
    const prompt = await c.identity.beginSignIn();
    const result = await settle(c.identity.waitForSignIn(prompt));
    expect(result).toEqual({ status: "expired" });
    // Polls at +2 and +4; at +6 the prompt has expired, so there is no third.
    expect(polls(p.calls).map((x) => x.at - T0)).toEqual([2, 4]);
  });

  it("reports the server's timeout as expired", async () => {
    const { c, prompt } = await begin({
      [POLL]: [pending(), json({ status: "timeout" })],
    });
    expect(await settle(c.identity.waitForSignIn(prompt))).toEqual({
      status: "expired",
    });
  });

  it("stops polling when the signal aborts, rejecting with its reason", async () => {
    const { p, c, prompt } = await begin({ [POLL]: [pending()] });
    const abort = new AbortController();
    const waiting = c.identity.waitForSignIn(prompt, { signal: abort.signal });
    waiting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2500);
    expect(polls(p.calls)).toHaveLength(1);
    abort.abort(new Error("player backed out"));
    await expect(waiting).rejects.toThrow("player backed out");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls(p.calls)).toHaveLength(1);
  });

  it("ends on a refusal (a device mismatch is a 401)", async () => {
    const { c, store, prompt } = await begin({
      [POLL]: [json({ error: "unauthorized" }, 401)],
    });
    const result = await settle(c.identity.waitForSignIn(prompt));
    expect(result.status).toBe("error");
    expect(await store.getToken()).toBeNull();
  });
});

describe("printing a prompt", () => {
  it("redacts the device code from console.log and JSON.stringify", async () => {
    const p = plane({ [START]: [started()] });
    const { c } = await client(p.fetchImpl);
    const prompt = await c.identity.beginSignIn();
    expect(prompt.deviceCode).toBe("device-code-1");
    expect(Object.keys(prompt)).toContain("deviceCode");
    for (const printed of [inspect(prompt), JSON.stringify(prompt)]) {
      expect(printed).not.toContain("device-code-1");
      expect(printed).toContain("WDJB-MJHT");
      expect(printed).toContain("[redacted]");
    }
  });
});

describe("pollSignIn", () => {
  it("polls exactly once and reports slow-down with the server's interval", async () => {
    const p = plane({
      [POLL]: [json({ status: "slow_down", interval: 2 }, 429)],
    });
    const { c } = await client(p.fetchImpl);
    const prompt: SignInPrompt = {
      deviceCode: "device-code-1",
      userCode: "WDJB-MJHT",
      verificationUri: "u",
      verificationUriComplete: "u?user_code=WDJB-MJHT",
      expiresIn: 600,
      interval: 2,
      expiresAt: T0 + 600,
    };
    expect(await c.identity.pollSignIn(prompt)).toEqual({
      status: "slow-down",
      interval: 2,
    });
    expect(polls(p.calls)).toHaveLength(1);
    expect(polls(p.calls)[0]!.body).toEqual({
      deviceCode: "device-code-1",
      deviceId: c.core.deviceId,
    });
  });

  it("throws network-error rather than inventing a status", async () => {
    const p = plane({ [POLL]: [new TypeError("offline")] });
    const { c } = await client(p.fetchImpl);
    await expect(
      c.identity.pollSignIn({ deviceCode: "d" } as SignInPrompt),
    ).rejects.toBeInstanceOf(PolarisError);
  });
});

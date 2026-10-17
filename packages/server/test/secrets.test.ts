// No secret reaches a log line, an error message or a toJSON: the header, the JWS, and the
// holder's name and email (plan §5.5).
import { inspect } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createPolarisKey, PolarisKeyError } from "../src/index.js";
import { createTestKit, type TestKit } from "../src/testing.js";

let kit: TestKit;
beforeAll(async () => {
  kit = await createTestKit({ product: "acme" });
});

const SECRETS = ["Grace Hopper", "grace@example.com"];

describe("secrets stay out of every serialised form", () => {
  it("the licence's toJSON, inspect and spread carry no holder, no document, no JWS", async () => {
    const jws = await kit.sign({
      holder: { name: "Grace Hopper", email: "grace@example.com" },
      entitlements: { "export.pdf": true },
    });
    const auth = await kit.polarisKey().authenticate(kit.headers(jws));
    expect(auth.license?.holder).toEqual({
      name: "Grace Hopper",
      email: "grace@example.com",
    });
    for (const text of [
      JSON.stringify(auth),
      JSON.stringify(auth.license),
      inspect(auth, { depth: 6 }),
      inspect(auth.license),
      JSON.stringify({ ...auth.license }),
      String(Object.keys(auth.license!)),
    ]) {
      for (const secret of [...SECRETS, jws, jws.split(".")[1]!])
        expect(text).not.toContain(secret);
    }
  });

  it("a refusal's problem, error message and debug lines carry none either", async () => {
    const lines: string[] = [];
    const verdicts: unknown[][] = [];
    const core = kit.polarisKey({
      debug: (l) => lines.push(l),
      onVerdict: (...a) => verdicts.push(a),
    });
    const jws = await kit.sign({
      holder: { name: "Grace Hopper", email: "grace@example.com" },
    });
    const stale = await core.authenticate(kit.headers(jws));
    expect(stale.problem).toBeNull();
    const refused = core.require(stale, [
      { kind: "entitlement", name: "nope" },
    ]);
    const error = new PolarisKeyError(refused.problem!);
    const all = [
      ...lines,
      JSON.stringify(verdicts),
      JSON.stringify(refused.problem),
      error.message,
      JSON.stringify(error),
      String(error.stack),
    ].join("\n");
    for (const secret of [
      ...SECRETS,
      jws,
      jws.split(".")[1]!,
      jws.split(".")[2]!,
    ])
      expect(all).not.toContain(secret);
    expect(lines.join("\n")).toMatch(
      /kid=pkey-test-2026 aud=acme device=[0-9a-f]{8}/,
    );
    expect(lines.join("\n")).not.toContain(kit.deviceId);
  });

  it("onVerdict receives a code and a step, nothing else", async () => {
    const seen: unknown[][] = [];
    const core = kit.polarisKey({ onVerdict: (...a) => seen.push(a) });
    await core.authenticate([]);
    await core.authenticate(kit.headers(await kit.sign({})));
    expect(seen).toEqual([
      ["license_required", "credential"],
      [null, "pass"],
    ]);
  });
});

describe("configuration errors fail at start", () => {
  const pins = { trust: { pinnedKeys: {} } };
  it("a product without the license service", () => {
    expect(() =>
      createPolarisKey({
        config: { productSlug: "acme", expectedServices: ["config"], ...pins },
      }),
    ).toThrow(/license/);
  });
  it("no product, a duplicate product, a bad maxAgeSeconds", () => {
    expect(() => createPolarisKey({ config: [] })).toThrow(TypeError);
    expect(() =>
      createPolarisKey({
        config: [
          { productSlug: "a", ...pins },
          { productSlug: "a", ...pins },
        ],
      }),
    ).toThrow(/twice/);
    expect(() =>
      createPolarisKey({
        config: { productSlug: "a", ...pins },
        maxAgeSeconds: -1,
      }),
    ).toThrow(/maxAgeSeconds/);
  });
});

describe("maxAgeSeconds and the cache", () => {
  it("a tighter window refuses sooner, and a cached document still ages out", async () => {
    const core = kit.polarisKey({ maxAgeSeconds: 600 });
    const headers = kit.headers(await kit.sign({}));
    expect((await core.authenticate(headers)).problem).toBeNull();
    kit.clock.advance(600 + 300);
    expect((await core.authenticate(headers)).problem).toBeNull();
    kit.clock.advance(1);
    expect((await core.authenticate(headers)).problem?.code).toBe(
      "license_stale",
    );
    kit.clock.advance(-901);
  });

  it("a cached document reports the age now, not the age it was cached at", async () => {
    const core = kit.polarisKey();
    const headers = kit.headers(await kit.sign({}));
    const first = await core.authenticate(headers);
    kit.clock.advance(120);
    const second = await core.authenticate(headers);
    expect(second.license!.ageSeconds - first.license!.ageSeconds).toBe(120);
    kit.clock.advance(-120);
  });
});

describe("the entry points take the shapes a framework has", () => {
  it("accepts a Request, Headers, pairs and a Node header object", async () => {
    const core = kit.polarisKey();
    const jws = await kit.sign({});
    const h = kit.headers(jws);
    for (const input of [
      new Request("http://x/", { headers: h }),
      new Headers(h),
      Object.entries(h),
      { "x-pkey-license": jws, "x-pkey-device": ["dev_test"] },
    ])
      expect((await core.authenticate(input)).problem).toBeNull();
  });
});

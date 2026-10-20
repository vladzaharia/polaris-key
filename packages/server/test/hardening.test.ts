// Concurrency and resource bounds: the unknown-kid refetch is claimed before it is awaited, a
// verification that started under an older trust set never fills the cache, and nothing reads an
// unbounded header or manifest body.
import { signJws } from "@polaris-key/jws";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPolarisKey } from "../src/index.js";
import { MAX_MANIFEST_BYTES } from "../src/trust.js";
import { licenseDoc, makeKey, manifest, type TestKey } from "./helpers.js";

const PRODUCT = "acme";
const T0 = 1_700_000_000;
let pin: TestKey;
let rotated: TestKey;

beforeAll(async () => {
  pin = await makeKey("pin-2026");
  rotated = await makeKey("rotated-2027");
});
afterEach(() => vi.restoreAllMocks());

const sign = (key: TestKey, at = T0) =>
  signJws(licenseDoc(PRODUCT, at), key.pem, key.kid, "pkey-license+jws");
const cfg = () => ({
  productSlug: PRODUCT,
  baseUrl: "https://key.example",
  trust: { pinnedKeys: { [pin.kid]: pin.pub } },
});
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("the unknown-kid refetch is claimed before it is awaited", () => {
  it("25 concurrent random-kid requests cause one fetch", async () => {
    let now = T0;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      await tick(30); // in flight while the other requests arrive
      return new Response(await manifest(PRODUCT, pin, [pin], now), {
        status: 200,
      });
    };
    const core = createPolarisKey({
      config: cfg(),
      fetch: fetcher,
      now: () => now,
    });
    await tick(60); // the start fetch settles
    expect(calls).toBe(1);
    now += 61; // the unknown-kid gate is open
    const junk = await Promise.all(
      Array.from({ length: 25 }, async () => sign(await makeKey("k"))),
    );
    const results = await Promise.all(
      junk.map((jws) => core.authenticate([["X-PKey-License", jws]])),
    );
    expect(results.every((r) => r.problem?.code === "license_invalid")).toBe(
      true,
    );
    expect(calls).toBe(2); // one fetch, not 25
    // And the minute still holds afterwards.
    await core.authenticate([["X-PKey-License", junk[0]!]]);
    expect(calls).toBe(2);
  });
});

describe("trust refreshes are serialised and never roll back", () => {
  it("an older manifest served after a newer one changes nothing", async () => {
    let now = T0;
    const serve: { current: Promise<string> } = {
      current: manifest(PRODUCT, pin, [pin, rotated], T0 + 100, 100_000),
    };
    const core = createPolarisKey({
      config: cfg(),
      fetch: async () => new Response(await serve.current, { status: 200 }),
      now: () => now,
    });
    await tick();
    const jws = await sign(rotated, now);
    expect(
      (await core.authenticate([["X-PKey-License", jws]])).problem,
    ).toBeNull();
    now += 900;
    serve.current = manifest(PRODUCT, pin, [pin], T0 + 50, 100_000); // an older manifest, without the key
    await core.authenticate([["X-PKey-License", jws]]);
    await tick();
    expect(
      (await core.authenticate([["X-PKey-License", jws]])).problem,
    ).toBeNull();
    // Equal issuedAt is no newer either.
    now += 900;
    serve.current = manifest(PRODUCT, pin, [pin], T0 + 100, 100_000);
    await core.authenticate([["X-PKey-License", jws]]);
    await tick();
    expect(
      (await core.authenticate([["X-PKey-License", jws]])).problem,
    ).toBeNull();
    // A newer one that drops the key does take effect. The refresh runs in the background (real
    // WebCrypto signing and verifying), so wait for it to land rather than a fixed 10 ms, which a
    // loaded runner overshoots.
    now += 900;
    serve.current = manifest(PRODUCT, pin, [pin], T0 + 200, 100_000);
    await core.authenticate([["X-PKey-License", jws]]);
    await vi.waitFor(
      async () => {
        expect(
          (await core.authenticate([["X-PKey-License", jws]])).problem?.code,
        ).toBe("license_invalid");
      },
      { timeout: 2000, interval: 20 },
    );
  });

  it("a periodic refresh and an unknown-kid refresh overlap as one flight", async () => {
    let now = T0;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      await tick(30);
      return new Response(await manifest(PRODUCT, pin, [pin, rotated], now), {
        status: 200,
      });
    };
    const core = createPolarisKey({
      config: cfg(),
      fetch: fetcher,
      now: () => now,
    });
    await tick(60);
    expect(calls).toBe(1);
    now += 901; // the periodic refresh is due and the unknown-kid gate is open
    const learned = await sign(rotated, now);
    const [a, b] = await Promise.all([
      core.authenticate([["X-PKey-License", learned]]),
      core.authenticate([["X-PKey-License", learned]]),
    ]);
    expect(a.problem).toBeNull();
    expect(b.problem).toBeNull();
    expect(calls).toBe(2); // not three: the two refreshes were one
  });
});

describe("a stale verification never fills the cache", () => {
  it("a document verified under a trust set that changed meanwhile is not cached", async () => {
    let now = T0;
    let keys: TestKey[] = [pin, rotated];
    const fetcher: typeof fetch = async () =>
      new Response(await manifest(PRODUCT, pin, keys, now), { status: 200 });
    const refreshes: Promise<unknown>[] = [];
    const core = createPolarisKey({
      config: cfg(),
      fetch: fetcher,
      now: () => now,
      waitUntil: (p) => void refreshes.push(p),
    });
    await Promise.all(refreshes); // the start fetch has settled
    const jws = await sign(rotated);
    const headers = [["X-PKey-License", jws]] as [string, string][];

    // Hold the licence document's signature check; let the trust refresh land meanwhile.
    const realVerify = crypto.subtle.verify.bind(crypto.subtle);
    let held!: () => void;
    const gate = new Promise<void>((r) => (held = r));
    let pausedOnce = false;
    vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const data = new TextDecoder().decode(args[3] as ArrayBuffer);
      if (!pausedOnce && jws.startsWith(data)) {
        pausedOnce = true;
        await gate;
      }
      return realVerify(...(args as Parameters<typeof realVerify>));
    });

    now += 900;
    keys = [pin]; // the next manifest no longer lists the rotated key
    const before = refreshes.length;
    const inFlight = core.authenticate(headers); // verifying, held at the signature
    // The refresh (started by that request) installs the new set: await it, not a sleep.
    while (refreshes.length === before) await tick(1);
    await Promise.all(refreshes);
    held();
    expect((await inFlight).problem).toBeNull(); // it began under the old set
    vi.restoreAllMocks();
    // Had the stale insert happened, this would be a cache hit that passes.
    expect((await core.authenticate(headers)).problem?.code).toBe(
      "license_invalid",
    );
  });
});

describe("resource bounds", () => {
  it("an enormous credential header is refused without being split", async () => {
    const core = createPolarisKey({
      config: cfg(),
      trustRefresh: false,
      now: () => T0,
    });
    const huge = ",".repeat(5_000_000);
    const split = vi.spyOn(String.prototype, "split");
    const a = await core.authenticate([["X-PKey-License", huge]]);
    expect(a.problem?.code).toBe("license_invalid");
    expect(
      split.mock.calls.every(
        (_c, i) => (split.mock.contexts[i] as string).length < 100_000,
      ),
    ).toBe(true);
    const b = await core.authenticate([
      ["X-PKey-License", await sign(pin)],
      ["X-PKey-Device", huge],
    ]);
    expect(b.problem?.code).toBe("license_invalid");
  });

  it("an enormous Accept-Language is ignored, not parsed", async () => {
    const core = createPolarisKey({
      config: cfg(),
      trustRefresh: false,
      now: () => T0,
    });
    const res = core.refuse("license_required", [
      ["Accept-Language", "de, ".repeat(1_000_000)],
    ]);
    expect(res.status).toBe(401);
  });

  it("a manifest body over the cap is dropped unread, and the pins keep verifying", async () => {
    let read = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        read += 65536;
        controller.enqueue(new Uint8Array(65536).fill(97));
      },
    });
    const core = createPolarisKey({
      config: cfg(),
      fetch: async () => new Response(big, { status: 200 }),
      now: () => T0,
    });
    await tick(50);
    expect(read).toBeLessThanOrEqual(MAX_MANIFEST_BYTES + 3 * 65536);
    const ok = await core.authenticate([["X-PKey-License", await sign(pin)]]);
    expect(ok.problem).toBeNull();
    // A declared length over the cap: the body is cancelled without being read.
    let cancelled = false;
    createPolarisKey({
      config: cfg(),
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": String(MAX_MANIFEST_BYTES + 1) } },
        ),
      now: () => T0,
    });
    await tick(50);
    expect(cancelled).toBe(true);
  });
});

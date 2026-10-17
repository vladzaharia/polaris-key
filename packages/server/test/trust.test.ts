// The trust manifest's schedule (WIRE-CONTRACT-V4 §14.4, plan §5.1): fetched at start, every
// 900 s, and on an unknown kid at most once a minute; a Polaris Key outage never refuses a document
// a pinned key signed.
import { signJws } from "@polaris-key/jws";
import { beforeAll, describe, expect, it } from "vitest";
import { createPolarisKey } from "../src/index.js";
import { licenseDoc, makeKey, manifest, type TestKey } from "./helpers.js";

const PRODUCT = "acme";
const T0 = 1_700_000_000;
let pin: TestKey;
let rotated: TestKey;

beforeAll(async () => {
  pin = await makeKey("pin-2026");
  rotated = await makeKey("rotated-2027");
});

interface Call {
  url: string;
  sdk: string | null;
}

function harness(opts: { outage?: () => boolean } = {}) {
  let now = T0;
  const calls: Call[] = [];
  let published: Promise<string> | null = null;
  const publish = (keys: TestKey[]) => {
    published = manifest(PRODUCT, pin, keys, now);
  };
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), sdk: headers.get("x-pkey-sdk") });
    if (opts.outage?.() || published === null)
      return new Response("down", { status: 503 });
    return new Response(await published, { status: 200 });
  };
  const core = () =>
    createPolarisKey({
      config: {
        productSlug: PRODUCT,
        baseUrl: "https://key.example",
        trust: { pinnedKeys: { [pin.kid]: pin.pub } },
      },
      fetch: fetcher,
      now: () => now,
    });
  return {
    calls,
    publish,
    core,
    advance: (s: number) => (now += s),
    now: () => now,
  };
}

const sign = (key: TestKey, at: number) =>
  signJws(licenseDoc(PRODUCT, at), key.pem, key.kid, "pkey-license+jws");
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("the trust manifest schedule", () => {
  it("fetches at start, sends X-PKey-SDK: node-server and asks for <baseUrl>/<p>/.well-known/polaris-trust.jws", async () => {
    const h = harness();
    h.publish([pin]);
    h.core();
    await tick();
    expect(h.calls).toEqual([
      {
        url: "https://key.example/acme/.well-known/polaris-trust.jws",
        sdk: "node-server",
      },
    ]);
  });

  it("refreshes every 900 s, on a request, never sooner", async () => {
    const h = harness();
    h.publish([pin]);
    const core = h.core();
    await tick();
    const jws = await sign(pin, h.now());
    const headers = [["X-PKey-License", jws]] as [string, string][];
    h.advance(899);
    await core.authenticate(headers);
    await tick();
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await core.authenticate(headers);
    await tick();
    expect(h.calls).toHaveLength(2);
    await core.authenticate(headers);
    await tick();
    expect(h.calls).toHaveLength(2);
  });

  it("learns a rotated key from the manifest, then verifies documents it signed", async () => {
    const h = harness();
    h.publish([pin, rotated]);
    const core = h.core();
    await tick();
    const jws = await sign(rotated, h.now());
    const auth = await core.authenticate([["X-PKey-License", jws]]);
    expect(auth.problem).toBeNull();
    expect(auth.license?.id).toBe("lic_1");
  });

  it("fetches for an unknown kid at most once every 60 s, however many junk headers arrive", async () => {
    const h = harness();
    h.publish([pin]);
    const core = h.core();
    await tick();
    const unknown = await makeKey("never-published");
    const junk = await sign(unknown, h.now());
    h.advance(61);
    for (let i = 0; i < 25; i++) {
      const a = await core.authenticate([["X-PKey-License", junk]]);
      expect(a.problem?.code).toBe("license_invalid");
    }
    // The start fetch plus one for the first junk header; the other 24 cost Polaris Key nothing.
    expect(h.calls).toHaveLength(2);
    h.advance(59);
    await core.authenticate([["X-PKey-License", junk]]);
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    await core.authenticate([["X-PKey-License", junk]]);
    expect(h.calls).toHaveLength(3);
  });

  it("a Polaris Key outage never refuses a pinned-key document, and keeps the last verified set", async () => {
    let down = false;
    const h = harness({ outage: () => down });
    h.publish([pin, rotated]);
    const core = h.core();
    await tick();
    const viaPin = await sign(pin, h.now());
    const viaRotated = await sign(rotated, h.now());
    down = true;
    h.advance(1000);
    for (let i = 0; i < 3; i++) {
      const a = await core.authenticate([["X-PKey-License", viaPin]]);
      expect(a.problem).toBeNull();
      h.advance(901);
    }
    // The learned key survives the failed refreshes (the document is within its 65 minutes only
    // because the clock moved less than that).
    const fresh = await sign(rotated, h.now());
    expect(
      (await core.authenticate([["X-PKey-License", fresh]])).problem,
    ).toBeNull();
    expect(viaRotated).toBeTruthy();
  });

  it("trustRefresh: false never calls Polaris Key", async () => {
    const h = harness();
    h.publish([pin]);
    const core = createPolarisKey({
      config: {
        productSlug: PRODUCT,
        trust: { pinnedKeys: { [pin.kid]: pin.pub } },
      },
      trustRefresh: false,
      fetch: async () => {
        throw new Error("no network");
      },
      now: h.now,
    });
    const unknown = await makeKey("x");
    const a = await core.authenticate([
      ["X-PKey-License", await sign(unknown, h.now())],
    ]);
    expect(a.problem?.code).toBe("license_invalid");
    expect(h.calls).toHaveLength(0);
  });

  it("drops a cached document when a refresh removes its key (absence is revocation)", async () => {
    const h = harness();
    h.publish([pin, rotated]);
    const core = h.core();
    await tick();
    const headers = [["X-PKey-License", await sign(rotated, h.now())]] as [
      string,
      string,
    ][];
    expect((await core.authenticate(headers)).problem).toBeNull();
    expect((await core.authenticate(headers)).problem).toBeNull(); // cached
    h.advance(900);
    h.publish([pin]); // the manifest no longer lists the rotated key
    await core.authenticate(headers); // starts the refresh in the background
    await tick();
    expect((await core.authenticate(headers)).problem?.code).toBe(
      "license_invalid",
    );
  });

  it("passes the start refresh to waitUntil", async () => {
    const h = harness();
    h.publish([pin]);
    const waited: Promise<unknown>[] = [];
    createPolarisKey({
      config: {
        productSlug: PRODUCT,
        baseUrl: "https://key.example",
        trust: { pinnedKeys: { [pin.kid]: pin.pub } },
      },
      fetch: async () =>
        new Response(await manifest(PRODUCT, pin, [pin], h.now())),
      now: h.now,
      waitUntil: (p) => void waited.push(p),
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });
});

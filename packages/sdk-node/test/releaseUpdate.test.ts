// Release and Update — the two thin, unauthenticated sub-clients (D-05, plan §R1).
//
// Release owns the software TRUTH (changelog, install script, artifacts); Update owns the FEED
// over it (version check, appcast). They are separate services because a product can want a
// changelog without wanting Sparkle, and this suite pins the two things that separation buys
// and the two ways it can be got wrong:
//
//   * the §R1 CANONICAL paths. Both services moved in v3 (`/changelog` → `/release/changelog`,
//     `/version` → `/update/version`, `/cli/:v/:bin-:arch` → `/release/dl/:v/:bin-:arch`) and
//     left permanent aliases on the server. A client that kept calling the alias would work —
//     and would silently be the reason the alias can never be retired.
//   * the D-21 capability gate, which fires BEFORE the dial. Neither service is on by default,
//     so a client that has not been told the product runs them must not probe for them.
//
// There is no signed document on either route and therefore no verification here: a release
// note is not a grant. The one authenticated case is Release's `entitled` access mode (P2.T3),
// where the server refuses a build that is not entitled to the feed — this client forwards the
// device token when it holds one and reports the refusal rather than inventing a retry.

import { describe, expect, it } from "vitest";
import { PolarisKeyClient } from "../src/client.js";
import { InMemoryStore } from "../src/core/store.js";

const PRODUCT = "djdl";
const BASE = "https://k.test";
const KID = "pkey-test-prod-2026";
const PUB = "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI";

interface Call {
  url: string;
  method: string;
  bearer: string | null;
  headers: Headers;
}

interface Mock {
  impl: typeof fetch;
  calls: Call[];
}

/** A suffix-routed fetch: anything unrouted 404s, which is what makes "never requested"
 *  assertable rather than merely unobserved. */
function mockFetch(routes: Record<string, () => Response>): Mock {
  const calls: Call[] = [];
  const impl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      bearer: headers.get("authorization"),
      headers,
    });
    const path = new URL(url).pathname;
    for (const [suffix, make] of Object.entries(routes)) {
      if (path.endsWith(suffix)) return make();
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function client(
  mock: Mock,
  opts: {
    services?: ("release" | "update" | "license" | "config")[];
    version?: string;
  } = {},
): Promise<PolarisKeyClient> {
  return PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: opts.version ?? "1.2.3",
    trust: { pinnedKeys: { [KID]: PUB } },
    trustRefresh: false,
    store: new InMemoryStore(PRODUCT),
    fetchImpl: mock.impl,
    expectedServices: opts.services ?? ["release", "update"],
    license: { fingerprint: false },
    devices: { fingerprint: false },
  });
}

const CHANGELOG = {
  entries: [
    {
      version: "1.3.0",
      tag: "v1.3.0",
      date: "2026-08-01T00:00:00Z",
      summary: "Stems.",
      url: "https://github.com/x/y/releases/tag/v1.3.0",
    },
    {
      version: "1.2.3",
      tag: "v1.2.3",
      date: "2026-07-01T00:00:00Z",
      summary: "Fixes.",
      url: "https://github.com/x/y/releases/tag/v1.2.3",
    },
  ],
};

describe("ReleaseClient — the truth store's public face (§R1)", () => {
  it("GETs the CANONICAL /release/changelog, not v2's /changelog alias", async () => {
    const mock = mockFetch({ "/release/changelog": () => json(CHANGELOG) });
    const c = await client(mock);
    await expect(c.release.changelog()).resolves.toEqual(CHANGELOG.entries);
    expect(mock.calls[0]!.url).toBe(`${BASE}/${PRODUCT}/release/changelog`);
    expect(mock.calls[0]!.method).toBe("GET");
    c.close();
  });

  it("carries the X-PKey-* metadata headers, so an entitled feed can gate on the build", async () => {
    const mock = mockFetch({ "/release/changelog": () => json(CHANGELOG) });
    const c = await client(mock);
    await c.release.changelog();
    const h = mock.calls[0]!.headers;
    expect(h.get("x-pkey-version")).toBe("1.2.3");
    expect(h.get("x-pkey-channel")).toBe("stable");
    expect(h.get("x-pkey-device")).toBe(c.core.deviceId);
    c.close();
  });

  it("tolerates a body with no entries array rather than throwing at the caller", async () => {
    const mock = mockFetch({ "/release/changelog": () => json({}) });
    const c = await client(mock);
    await expect(c.release.changelog()).resolves.toEqual([]);
    c.close();
  });

  it("sends NO Authorization header when the device holds no credential", async () => {
    const mock = mockFetch({ "/release/changelog": () => json(CHANGELOG) });
    const c = await client(mock);
    await c.release.changelog();
    expect(mock.calls[0]!.bearer).toBeNull();
    c.close();
  });

  it("forwards the device token when one IS held — the `entitled` access mode (P2.T3)", async () => {
    const mock = mockFetch({ "/release/changelog": () => json(CHANGELOG) });
    const c = await client(mock);
    await c.core.store.setToken("pkeyt_entitled");
    // Re-init so the token manager picks the credential up the way a restart would.
    await c.init();
    await c.release.changelog();
    expect(mock.calls.at(-1)!.bearer).toBe("Bearer pkeyt_entitled");
    c.close();
  });

  it("surfaces a 403 as the server's own code, not as a generic failure", async () => {
    // An entitled feed refusing a stable-only licence is a licensing answer the host should
    // render ("upgrade to reach the beta channel"), not a network error to retry.
    const mock = mockFetch({
      "/release/changelog": () =>
        json({ error: { code: "channel_not_allowed" } }, 403),
    });
    const c = await client(mock);
    await expect(c.release.changelog()).rejects.toMatchObject({
      code: "channel_not_allowed",
    });
    c.close();
  });

  it("maps any other non-OK status to a PolarisError rather than a raw Response", async () => {
    const mock = mockFetch({ "/release/changelog": () => json({}, 500) });
    const c = await client(mock);
    await expect(c.release.changelog()).rejects.toMatchObject({
      code: "not_found",
    });
    c.close();
  });

  it("builds the §R1 install and artifact URLs, including the ?checksum flag", async () => {
    const mock = mockFetch({});
    const c = await client(mock);
    expect(c.release.installUrl()).toBe(
      `${BASE}/${PRODUCT}/release/install.sh`,
    );
    // `/release/dl/:version/:binary-:arch`, replacing v2's `/cli/…` and `/dmg/…`.
    expect(c.release.downloadUrl("1.3.0", "djdl", "arm64")).toBe(
      `${BASE}/${PRODUCT}/release/dl/1.3.0/djdl-arm64`,
    );
    expect(c.release.downloadUrl("1.3.0", "djdl", "arm64", { dmg: true })).toBe(
      `${BASE}/${PRODUCT}/release/dl/1.3.0/djdl-arm64.dmg`,
    );
    expect(
      c.release.downloadUrl("1.3.0", "djdl", "x86_64", { checksum: true }),
    ).toBe(`${BASE}/${PRODUCT}/release/dl/1.3.0/djdl-x86_64?checksum=sha256`);
    // No request was made — these are builders, and a host that wants the bytes streams them.
    expect(mock.calls).toHaveLength(0);
    c.close();
  });

  it("percent-encodes the version segment so a crafted selector cannot add a path", async () => {
    const mock = mockFetch({});
    const c = await client(mock);
    expect(c.release.downloadUrl("../../admin", "djdl", "arm64")).toContain(
      "release/dl/..%2F..%2Fadmin/",
    );
    c.close();
  });
});

describe("UpdateClient — the feed over Release's store (§R1)", () => {
  const VERSION = {
    version: "1.3.0",
    tag: "v1.3.0",
    url: "https://github.com/x/y/releases/tag/v1.3.0",
  };

  it("GETs the CANONICAL /update/version and reports whether the HOST app is behind", async () => {
    const mock = mockFetch({ "/update/version": () => json(VERSION) });
    const c = await client(mock, { version: "1.2.3" });
    await expect(c.update.check()).resolves.toEqual({
      ...VERSION,
      updateAvailable: true,
    });
    expect(mock.calls[0]!.url).toBe(`${BASE}/${PRODUCT}/update/version`);
    c.close();
  });

  it("compares with client-core's semver, so the answer agrees with the build gate", async () => {
    // A version check that disagreed with the gate would tell a user to update to a build the
    // gate then blocks — or leave them on a build the gate has already refused.
    const mock = mockFetch({ "/update/version": () => json(VERSION) });
    const uptodate = await client(mock, { version: "1.3.0" });
    expect((await uptodate.update.check()).updateAvailable).toBe(false);
    uptodate.close();

    const ahead = await client(mock, { version: "1.4.0" });
    expect((await ahead.update.check()).updateAvailable).toBe(false);
    ahead.close();

    // A prerelease sorts BELOW its release (SemVer rule 11), so 1.3.0-beta.1 IS behind 1.3.0.
    const pre = await client(mock, { version: "1.3.0-beta.1" });
    expect((await pre.update.check()).updateAvailable).toBe(true);
    pre.close();
  });

  it("passes the requested channel as a query parameter", async () => {
    const mock = mockFetch({ "/update/version": () => json(VERSION) });
    const c = await client(mock);
    await c.update.check({ channel: "beta" });
    expect(mock.calls[0]!.url).toBe(
      `${BASE}/${PRODUCT}/update/version?channel=beta`,
    );
    c.close();
  });

  it("surfaces a 403 from an entitled channel as the server's code", async () => {
    const mock = mockFetch({
      "/update/version": () =>
        json({ error: { code: "channel_not_allowed" } }, 403),
    });
    const c = await client(mock);
    await expect(c.update.check({ channel: "beta" })).rejects.toMatchObject({
      code: "channel_not_allowed",
    });
    c.close();
  });

  it("appcastUrl() is null until discovery has run — the feed URL is the PRODUCT's to state", async () => {
    // §R1 moved the appcast path and left a permanent alias. A host that string-built the URL
    // would be a host that breaks the next time it moves; the discovery document is the
    // product's own statement of where its feed lives, so there is nothing to answer before it
    // has been read. Null, not a throw: that is a sequencing question, not an error.
    const mock = mockFetch({});
    const c = await client(mock);
    expect(c.update.appcastUrl()).toBeNull();
    c.close();
  });

  it("appcastUrl() reads the endpoint out of the loaded discovery document", async () => {
    const mock = mockFetch({
      "/.well-known/polaris.json": () =>
        json({
          product: PRODUCT,
          services: {
            license: { enabled: false },
            config: { enabled: false },
            release: { enabled: true },
            update: {
              enabled: true,
              endpoints: {
                version: `${BASE}/${PRODUCT}/update/version`,
                appcast: `${BASE}/${PRODUCT}/update/appcast.xml`,
              },
            },
            identity: { enabled: false },
          },
        }),
    });
    const c = await client(mock);
    expect((await c.discover()).kind).toBe("ok");
    expect(c.update.appcastUrl()).toBe(`${BASE}/${PRODUCT}/update/appcast.xml`);
    // `?arch=` is a QUERY parameter; the channel is a PATH segment (§R1).
    expect(c.update.appcastUrl({ arch: "x86_64" })).toBe(
      `${BASE}/${PRODUCT}/update/appcast.xml?arch=x86_64`,
    );
    expect(c.update.appcastUrl({ channel: "beta" })).toBe(
      `${BASE}/${PRODUCT}/update/beta/appcast.xml`,
    );
    expect(c.update.appcastUrl({ channel: "stable" })).toBe(
      `${BASE}/${PRODUCT}/update/appcast.xml`,
    );
    c.close();
  });
});

describe("Release/Update — the D-21 gate fires before the dial", () => {
  it("both refuse when the product has not enabled them, without touching the network", async () => {
    const mock = mockFetch({
      "/release/changelog": () => json(CHANGELOG),
      "/update/version": () => json({ version: "9.9.9", tag: "v9", url: "u" }),
    });
    // The suite default: license + config on, release/update/identity OFF.
    const c = await client(mock, { services: ["license", "config"] });
    await expect(c.release.changelog()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    await expect(c.update.check()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    expect(() => c.release.installUrl()).toThrow();
    expect(() => c.release.downloadUrl("1.0.0", "djdl", "arm64")).toThrow();
    // Not one request left this client: a build that was not told the service exists must not
    // be the thing that discovers it.
    expect(mock.calls).toHaveLength(0);
    c.close();
  });

  it("a discovery document that turns Release ON makes it reachable", async () => {
    const mock = mockFetch({
      "/.well-known/polaris.json": () =>
        json({
          product: PRODUCT,
          services: {
            license: { enabled: false },
            config: { enabled: false },
            release: { enabled: true },
            update: { enabled: false },
            identity: { enabled: false },
          },
        }),
      "/release/changelog": () => json(CHANGELOG),
    });
    const c = await client(mock, { services: [] });
    await expect(c.release.changelog()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    await c.discover();
    await expect(c.release.changelog()).resolves.toHaveLength(2);
    // …and Update, which the document says is off, is still refused.
    await expect(c.update.check()).rejects.toMatchObject({
      code: "service-unavailable",
    });
    c.close();
  });
});

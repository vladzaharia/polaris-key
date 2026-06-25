import { describe, expect, it } from "vitest";
import { discoverProduct } from "../src/discovery.js";

function fakeFetch(
  status: number,
  body?: unknown,
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("discoverProduct", () => {
  it("GETs the product well-known document and returns typed stable fields", async () => {
    const { impl, calls } = fakeFetch(200, {
      schemaVersion: 1,
      slug: "djdl",
      name: "DJDL",
      baseUrl: "https://key.plrs.im",
      endpoints: {
        config: "https://key.plrs.im/djdl/config",
        jwks: "https://key.plrs.im/djdl/.well-known/jwks.json",
      },
      trust: {
        jwksUrl: "https://key.plrs.im/djdl/.well-known/jwks.json",
        pinnedKeys: { "pkey-djdl-prod-2026-06": "pub" },
      },
      sdk: { node: { package: "@polaris-key/node" } },
    });

    const res = await discoverProduct({
      baseUrl: "https://key.plrs.im/",
      product: "djdl",
      fetchImpl: impl,
    });

    expect(calls[0]?.url).toBe(
      "https://key.plrs.im/djdl/.well-known/polaris.json",
    );
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.manifest.product).toBe("djdl");
    expect(res.manifest.endpoints?.config).toBe(
      "https://key.plrs.im/djdl/config",
    );
    expect(res.manifest.trust?.pinnedKeys?.["pkey-djdl-prod-2026-06"]).toBe(
      "pub",
    );
  });

  it("maps a missing well-known document distinctly", async () => {
    const { impl } = fakeFetch(404);
    expect(
      await discoverProduct({
        baseUrl: "https://key.plrs.im",
        product: "djdl",
        fetchImpl: impl,
      }),
    ).toEqual({
      kind: "not-found",
    });
  });

  it("rejects a product mismatch", async () => {
    const { impl } = fakeFetch(200, { product: "other" });
    const res = await discoverProduct({
      baseUrl: "https://key.plrs.im",
      product: "djdl",
      fetchImpl: impl,
    });
    expect(res.kind).toBe("invalid");
    expect(res.kind === "invalid" ? res.message : "").toContain(
      "does not match",
    );
  });

  it("accepts richer worker-shaped product metadata", async () => {
    const { impl } = fakeFetch(200, {
      product: { slug: "djdl", name: "DJDL" },
      endpoints: { config: "https://key.plrs.im/djdl/config" },
      trust: { signingKid: "kid", signingPub: "pub" },
    });
    const res = await discoverProduct({
      baseUrl: "https://key.plrs.im",
      product: "djdl",
      fetchImpl: impl,
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.manifest.product).toBe("djdl");
    expect(res.manifest.trust?.signingKid).toBe("kid");
  });
});

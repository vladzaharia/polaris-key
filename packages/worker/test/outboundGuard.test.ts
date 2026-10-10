/** The shared outbound guard and the safeFetch guard gaps. */
import { describe, expect, it } from "vitest";
import {
  outboundFetch,
  OutboundRefusedError,
} from "../src/core/outboundGuard.js";
import { guardUrl, safeFetch, type FetchImpl } from "../src/core/safeFetch.js";

describe("guardUrl trailing dots and deny list", () => {
  it("strips every trailing dot", () => {
    expect(guardUrl("https://key.plrs.im../x")).not.toBeNull();
    expect(guardUrl("https://printer.local../x")).not.toBeNull();
    expect(guardUrl("https://intranet../x")).not.toBeNull();
  });
  it("refuses empty labels and workers.dev", () => {
    expect(guardUrl("https://a..example.com/x")).toBe("unparseable");
    expect(guardUrl("https://evil.workers.dev/x")).toBe("denied-host");
    expect(guardUrl("https://workers.dev/x")).toBe("denied-host");
    expect(guardUrl("https://cdn.example.com./x")).toBeNull();
  });
});

describe("safeFetch redirect headers", () => {
  it("drops cookie and key headers on a hop", async () => {
    const seen: Headers[] = [];
    const impl: FetchImpl = async (input, init) => {
      seen.push(new Headers(init?.headers));
      const url = String(input);
      return url.includes("a.example.com")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://b.example.com/y" },
          })
        : new Response("ok", { status: 200 });
    };
    await safeFetch("https://a.example.com/x", {
      maxBytes: 100,
      fetchImpl: impl,
      headers: { cookie: "s=1", "x-api-key": "k", authorization: "Bearer t" },
    });
    expect(seen[0]!.get("cookie")).toBe("s=1");
    for (const h of ["cookie", "x-api-key", "authorization"])
      expect(seen[1]!.get(h)).toBeNull();
  });
});

describe("outboundFetch", () => {
  const post = {
    method: "POST",
    body: new URLSearchParams({ client_secret: "S" }),
  };
  it("refuses a redirect to a private host without dialling it", async () => {
    const urls: string[] = [];
    const f = async (u: string) => {
      urls.push(u);
      return new Response(null, {
        status: 307,
        headers: { location: "https://169.254.169.254/x" },
      });
    };
    await expect(
      outboundFetch("https://id.example.com/t", { init: post, fetchImpl: f }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(urls).toEqual(["https://id.example.com/t"]);
  });
  it("never re-sends the posted secret to another origin", async () => {
    const bodies: unknown[] = [];
    const f = async (u: string, init?: RequestInit) => {
      bodies.push(init?.body ?? null);
      return u.includes("id.example.com")
        ? new Response(null, {
            status: 307,
            headers: { location: "https://other.example.org/t" },
          })
        : new Response("{}", { status: 200 });
    };
    await outboundFetch("https://id.example.com/t", {
      init: post,
      fetchImpl: f,
    });
    expect(bodies[1]).toBeNull();
  });
  it("caps the body and refuses userinfo / http", async () => {
    const big = async () => new Response("x".repeat(500));
    await expect(
      outboundFetch("https://id.example.com/t", {
        maxBytes: 100,
        fetchImpl: big,
      }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    await expect(
      outboundFetch("https://u:p@id.example.com/t", { fetchImpl: big }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    await expect(
      outboundFetch("http://id.example.com/t", { fetchImpl: big }),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
  });
});

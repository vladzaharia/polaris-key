// @pkey-feature ui.cli.portal
// `portalLink` (the kit's product page link) over the cases of portal-matrix.json: the response's
// own link, discovery's `core.portal`, then the legacy guess (WIRE-CONTRACT-V4 §5.7).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PolarisKeyClient } from "../../src/client.js";
import { ensurePortal, portalLink } from "../../src/cli/flows.js";

const MATRIX = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "portal-matrix.json",
    ),
    "utf8",
  ),
) as {
  linkCases: {
    name: string;
    served: string | null;
    portal: unknown;
    baseUrl: string;
    product: string;
    expect: string | null;
  }[];
};

const client = (baseUrl: string, product: string, portal: unknown) =>
  ({
    core: { baseUrl },
    product,
    portal: () => portal,
  }) as unknown as PolarisKeyClient;

describe("portalLink (the product page link)", () => {
  it.each(MATRIX.linkCases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(portalLink(client(c.baseUrl, c.product, c.portal), c.served)).toBe(
      c.expect,
    );
  });

  it("a client without portal() is the legacy guess", () => {
    const bare = {
      core: { baseUrl: "https://key.plrs.im/" },
      product: "djdl",
    } as unknown as PolarisKeyClient;
    expect(portalLink(bare)).toBe(
      "https://polaris.locker/activate?product=djdl",
    );
  });
});

describe("ensurePortal", () => {
  const spy = (portal: unknown, discovery: unknown) => {
    let discovered = 0;
    const c = {
      portal: () => portal,
      discovery: () => discovery,
      discover: async () => {
        discovered++;
        throw new Error("offline");
      },
    } as unknown as PolarisKeyClient;
    return { c, count: () => discovered };
  };

  it("discovers once when the session has neither a member nor a discovery", async () => {
    const s = spy(null, null);
    await ensurePortal(s.c);
    expect(s.count()).toBe(1);
  });

  it("does not dial when a member or a discovery is held", async () => {
    const a = spy({ enabled: false }, null);
    await ensurePortal(a.c);
    const b = spy(null, {});
    await ensurePortal(b.c);
    expect(a.count() + b.count()).toBe(0);
  });
});

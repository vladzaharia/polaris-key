// client-core's proof for `core.portal` (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md): every row of
// `conformance/corpus/v2/portal-matrix.json`, which the corpus generator recomputed with its own
// reference. Then the edges the corpus cannot carry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePortal, portalLink, type ParsedPortal } from "../src/portal.js";

const MATRIX = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
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
  portalMatrixVersion: number;
  parseCases: { name: string; core: unknown; expect: ParsedPortal | null }[];
  linkCases: {
    name: string;
    served: string | null;
    portal: ParsedPortal | null;
    baseUrl: string;
    product: string;
    expect: string | null;
  }[];
};

// @pkey-feature ui.cli.portal
describe("portal-matrix.json", () => {
  it("is version 1", () => {
    expect(MATRIX.portalMatrixVersion).toBe(1);
  });

  it.each(MATRIX.parseCases.map((c) => [c.name, c] as const))(
    "parse: %s",
    (_n, c) => {
      expect(parsePortal(c.core)).toEqual(c.expect);
    },
  );

  it.each(MATRIX.linkCases.map((c) => [c.name, c] as const))(
    "link: %s",
    (_n, c) => {
      expect(
        portalLink({
          served: c.served,
          portal: c.portal,
          baseUrl: c.baseUrl,
          product: c.product,
        }),
      ).toBe(c.expect);
    },
  );
});

describe("portalLink edges", () => {
  it("never adds a key or a return to the link", () => {
    const link = portalLink({
      portal: parsePortal({
        portal: {
          enabled: true,
          activate: "https://polaris.locker/activate?product=djdl",
        },
      }),
      baseUrl: "https://key.plrs.im",
      product: "djdl",
    });
    expect(link).toBe("https://polaris.locker/activate?product=djdl");
    expect(link).not.toContain("#");
  });

  it("treats an absent served link like no served link", () => {
    expect(
      portalLink({
        portal: null,
        baseUrl: "https://key.plrs.im",
        product: "djdl",
      }),
    ).toBe("https://polaris.locker/activate?product=djdl");
  });
});

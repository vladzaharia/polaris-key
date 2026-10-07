// client-core's proof for `core.presentation` (WIRE-CONTRACT-V4 §5.5, plans/HA-12.md Q2): every
// row of `conformance/corpus/v2/presentation-matrix.json`, which the corpus generator recomputed
// with its own reference. Then the edges the corpus cannot carry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  iconMatches,
  parsePresentation,
  pickIconSize,
  usableUrlOrigin,
  type PresentationIcon,
  type PresentationSource,
  type ProductPresentation,
} from "../src/presentation.js";

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
      "presentation-matrix.json",
    ),
    "utf8",
  ),
) as {
  presentationMatrixVersion: number;
  parseCases: {
    name: string;
    core: unknown;
    doc: { name?: unknown; product: string };
    expect: ProductPresentation | null;
  }[];
  pickCases: {
    name: string;
    icon: PresentationIcon;
    px: number;
    scale: number;
    decodable: string[];
    expect: unknown;
  }[];
  verifyCases: {
    name: string;
    bytes: string;
    sha256: string;
    expect: boolean;
  }[];
};

const fromBase64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe("presentation-matrix.json", () => {
  it("is version 1 and non-trivial", () => {
    expect(MATRIX.presentationMatrixVersion).toBe(1);
    expect(MATRIX.parseCases.length).toBeGreaterThan(50);
    expect(MATRIX.pickCases.length).toBeGreaterThan(15);
    expect(MATRIX.verifyCases.length).toBeGreaterThanOrEqual(4);
  });

  for (const c of MATRIX.parseCases)
    it(`parse: ${c.name}`, () => {
      const got = parsePresentation(c.core, c.doc);
      expect(got).toEqual(c.expect);
      // The fixed point: what the Worker emits, every SDK re-parses to itself.
      if (got !== null)
        expect(parsePresentation({ presentation: got }, c.doc)).toEqual(got);
    });

  for (const c of MATRIX.pickCases)
    it(`pick: ${c.name}`, () => {
      expect(pickIconSize(c.icon, c.px, c.scale, c.decodable)).toEqual(
        c.expect,
      );
    });

  for (const c of MATRIX.verifyCases)
    it(`verify: ${c.name}`, async () => {
      expect(await iconMatches(fromBase64(c.bytes), c.sha256)).toBe(c.expect);
    });
});

describe("the edges the corpus does not carry", () => {
  it("a lone surrogate is not text", () => {
    expect(
      parsePresentation(
        { presentation: { name: "a\udc00" } },
        { product: "p" },
      ),
    ).toEqual({ name: "p" });
  });

  it("never returns the input object, and never carries an unknown member", () => {
    const raw = {
      name: "P",
      extra: 1,
      icon: {
        sha256: "a".repeat(64),
        contentType: "image/png",
        original: "https://img.plrs.im/p/a/x",
        extra: 2,
      },
    };
    const got = parsePresentation({ presentation: raw }, { product: "p" })!;
    expect(got).not.toBe(raw);
    expect(Object.keys(got).sort()).toEqual(["icon", "name"]);
    expect(Object.keys(got.icon!).sort()).toEqual([
      "contentType",
      "original",
      "sha256",
      "sizes",
    ]);
  });

  it("a usable URL's origin is its scheme and authority, lower-cased", () => {
    expect(usableUrlOrigin("HTTPS://Img.Plrs.Im:443/x?y")).toBe(
      "https://img.plrs.im:443",
    );
    expect(usableUrlOrigin("http://[::1]/x")).toBe("http://[::1]");
    expect(usableUrlOrigin("http://[::2]/x")).toBeNull();
    expect(usableUrlOrigin(42)).toBeNull();
  });

  it("a nonsensical hero size still picks something", () => {
    const icon: PresentationIcon = {
      sha256: "a".repeat(64),
      contentType: "image/png",
      original: "https://img.plrs.im/p/a/x",
      url: "https://img.plrs.im/p/a/x/{w}.webp",
      sizes: [{ w: 64, sha256: "b".repeat(64) }],
    };
    expect(pickIconSize(icon, Number.NaN, 2, ["image/webp"])).toMatchObject({
      source: "size",
      w: 64,
    });
    expect(pickIconSize(icon, -5, 1, new Set(["image/webp"]))).toMatchObject({
      source: "size",
      w: 64,
    });
  });

  it("verifies a view into a larger buffer by its own bytes only", async () => {
    const backing = new TextEncoder().encode("xxpolarisxx");
    const view = backing.subarray(2, 9);
    expect(
      await iconMatches(
        view,
        "c4a2a2f6a1ce8f5a8b4b1e62bd3e23b3a1cbde1fde4d4e9ffd8d7d8b5d24b0f0",
      ),
    ).toBe(false);
    const hex = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("polaris"),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    expect(await iconMatches(view, hex)).toBe(true);
  });

  it("PresentationSource is a seam a kit can implement in a few lines", async () => {
    let listener: ((p: ProductPresentation | null) => void) | null = null;
    const source: PresentationSource = {
      current: () => ({ name: "P" }),
      icon: async () => null,
      subscribe: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    };
    const off = source.subscribe(() => undefined);
    expect(listener).not.toBeNull();
    off();
    expect(listener).toBeNull();
    expect(source.current()).toEqual({ name: "P" });
    expect(await source.icon(48, 2)).toBeNull();
  });
});

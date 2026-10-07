// The presentation matrix's generator-local reference (plans/HA-12.md Q2) restates the limits
// rather than importing them, so it shares no code with what it checks. This pins the restated
// values to `@polaris-key/protocol/core`'s, and gives the self-check teeth.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "@polaris-key/protocol/core";
import {
  buildPresentationMatrix,
  PRESENTATION_MATRIX_VERSION,
  REF_LIMITS,
  refOrigin,
  refParse,
  refPick,
} from "./presentation-matrix.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("presentation-matrix.json's reference", () => {
  it("restates exactly the protocol's limits", () => {
    for (const [name, value] of Object.entries(REF_LIMITS))
      expect(value, name).toEqual(
        (core as Record<string, unknown>)[name] as unknown,
      );
  });

  it("is the committed file's version", () => {
    const file = JSON.parse(
      readFileSync(
        join(ROOT, "conformance", "corpus", "v2", "presentation-matrix.json"),
        "utf8",
      ),
    ) as { presentationMatrixVersion: number };
    expect(file.presentationMatrixVersion).toBe(PRESENTATION_MATRIX_VERSION);
    expect(buildPresentationMatrix().presentationMatrixVersion).toBe(1);
  });

  it("has teeth: the rules it recomputes", () => {
    // A usable URL, and what is not one.
    expect(refOrigin("https://IMG.plrs.im/x")).toBe("https://img.plrs.im");
    expect(refOrigin("http://localhost:8787/x")).toBe("http://localhost:8787");
    expect(refOrigin("http://example.com/x")).toBeUndefined();
    expect(refOrigin("https://u@img.plrs.im/x")).toBeUndefined();
    expect(refOrigin("https://img.plrs.im/x#")).toBeUndefined();
    // Text is counted in UTF-8 bytes, never UTF-16 units or code points.
    const doc = { product: "p" };
    expect(refParse({ presentation: { name: "é".repeat(513) } }, doc)).toEqual({
      name: "p",
    });
    expect(refParse({ presentation: { name: "\ud800" } }, doc)).toEqual({
      name: "p",
    });
    // The original wins above the ladder only when it is wider and decodable.
    const icon = {
      sha256: "a".repeat(64),
      contentType: "image/png",
      width: 1024,
      original: "https://img.plrs.im/p/a/x",
      url: "https://img.plrs.im/p/a/x/{w}.webp",
      sizes: [{ w: 64, sha256: "b".repeat(64) }],
    };
    expect(refPick(icon, 100, 1, ["image/png", "image/webp"]).source).toBe(
      "original",
    );
    expect(refPick(icon, 100, 1, ["image/webp"]).source).toBe("size");
  });
});

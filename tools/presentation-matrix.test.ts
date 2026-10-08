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

  it("is the committed file's version, and the file holds no U+0000", () => {
    const text = readFileSync(
      join(ROOT, "conformance", "corpus", "v2", "presentation-matrix.json"),
      "utf8",
    );
    const file = JSON.parse(text) as { presentationMatrixVersion: number };
    expect(file.presentationMatrixVersion).toBe(PRESENTATION_MATRIX_VERSION);
    // A Godot String cannot hold U+0000 (WIRE-CONTRACT-V4 §10); the generator refuses one.
    expect(text.toLowerCase()).not.toContain("\\u0000");
    expect(buildPresentationMatrix().presentationMatrixVersion).toBe(1);
  });

  it("has teeth: the rules it recomputes", () => {
    // A usable URL, and what is not one.
    expect(refOrigin("https://IMG.plrs.im/x")).toBe("https://img.plrs.im");
    expect(refOrigin("http://localhost:8787/x")).toBe("http://localhost:8787");
    expect(refOrigin("http://example.com/x")).toBeUndefined();
    expect(refOrigin("https://u@img.plrs.im/x")).toBeUndefined();
    expect(refOrigin("https://img.plrs.im/x#")).toBeUndefined();
    // The authority: a bounded numeric port, `[::1]` as the only bracketed host, DNS labels.
    expect(refOrigin("https://img.plrs.im:65535/x")).toBe(
      "https://img.plrs.im:65535",
    );
    for (const bad of [
      "https://img.plrs.im:65536/x",
      "https://img.plrs.im:abc/x",
      "https://[evil]/x",
      "http://[::1]evil.com/x",
      "https://img%40plrs.im/x",
      "https://999.1.1.1/x",
    ])
      expect(refOrigin(bad), bad).toBeUndefined();
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

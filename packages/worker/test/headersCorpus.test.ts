// @pkey-feature core.headers
// The Worker's side of `conformance/corpus/v2/headers.json` (WIRE-CONTRACT-V3 §5.2 rule 3): every
// row through the normaliser `deviceMetadata` applies. A listed spelling is stored as its
// canonical value; a spelling with no value is stored as sent (`expect ?? raw`), and an empty
// value is absent. The SDK runners (Node, Python, Swift, Godot) run the same rows.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LEGACY_SDK_NAMES,
  normalizeArchHeader,
  normalizePlatformHeader,
  normalizeSdkHeader,
} from "../src/core/clientMetadata.js";
import { deviceMetadata } from "../src/core/devices.js";

interface HeaderCase {
  id: string;
  raw: string;
  expect: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "..", "conformance", "corpus", "v2", "headers.json"),
    "utf8",
  ),
) as {
  headersVersion: number;
  platformCases: HeaderCase[];
  archCases: HeaderCase[];
};

/** What the Worker stores for a row: the canonical value, else the raw value, else nothing. */
const stored = (row: HeaderCase): string | null =>
  row.expect ?? (row.raw === "" ? null : row.raw);

describe("headers.json through the Worker's normaliser", () => {
  it("is headersVersion 1, with both sections at their floors", () => {
    expect(corpus.headersVersion).toBe(1);
    expect(corpus.platformCases.length).toBeGreaterThanOrEqual(31);
    expect(corpus.archCases.length).toBeGreaterThanOrEqual(31);
  });

  it.each(corpus.platformCases.map((r) => [r.id, r] as const))(
    "platform %s",
    (_id, row) => {
      expect(normalizePlatformHeader(row.raw)).toBe(stored(row));
    },
  );

  it.each(corpus.archCases.map((r) => [r.id, r] as const))(
    "arch %s",
    (_id, row) => {
      expect(normalizeArchHeader(row.raw)).toBe(stored(row));
    },
  );

  it("a doctored row fails the same comparison", () => {
    const row = corpus.platformCases.find((r) => r.expect === "macos")!;
    expect(normalizePlatformHeader(row.raw) === stored(row)).toBe(true);
    expect(
      normalizePlatformHeader(row.raw) === stored({ ...row, expect: "linux" }),
    ).toBe(false);
  });

  it("maps each pre-§5.2 SDK name to its id, exactly, and keeps anything else", () => {
    expect(normalizeSdkHeader("@polaris-key/node")).toBe("node");
    expect(normalizeSdkHeader("@polaris-key/react")).toBe("react");
    expect(normalizeSdkHeader("polaris-key-python")).toBe("python");
    expect(normalizeSdkHeader("PolarisKeySwift")).toBe("swift");
    expect(normalizeSdkHeader("polaris-key-godot")).toBe("godot");
    expect(Object.keys(LEGACY_SDK_NAMES)).toHaveLength(5);
    for (const id of ["node", "react", "python", "swift", "godot"])
      expect(normalizeSdkHeader(id)).toBe(id);
    expect(normalizeSdkHeader("polariskeyswift")).toBe("polariskeyswift");
    expect(normalizeSdkHeader("kotlin")).toBe("kotlin");
    expect(normalizeSdkHeader("constructor")).toBe("constructor");
    expect(normalizeSdkHeader("")).toBeNull();
    expect(normalizeSdkHeader(null)).toBeNull();
  });

  it("deviceMetadata applies the normaliser to the request's headers", () => {
    const meta = deviceMetadata(
      new Request("https://key.plrs.im/djdl/license/document", {
        headers: {
          "x-pkey-platform": "Darwin",
          "x-pkey-arch": "AMD64",
          "x-pkey-sdk": "polaris-key-python",
        },
      }),
    );
    expect(meta).toMatchObject({
      platform: "macos",
      arch: "x86_64",
      sdkName: "python",
    });
    const empty = deviceMetadata(
      new Request("https://key.plrs.im/djdl/license/document", {
        headers: { "x-pkey-platform": "", "x-pkey-arch": "", "x-pkey-sdk": "" },
      }),
    );
    expect(empty).toMatchObject({ platform: null, arch: null, sdkName: null });
  });
});

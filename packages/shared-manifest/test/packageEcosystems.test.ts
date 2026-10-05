/**
 * The per-ecosystem ingest rules (`src/ecosystems/*.ts`): the ONE entry point each package feed
 * declares its rules through, and the older tables derived from it.
 */

import { describe, expect, it } from "vitest";
import {
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  PACKAGE_FILE_TYPES,
  PACKAGE_METADATA_KEYS,
  PACKAGE_NAME_MAX_LENGTH,
  PACKAGE_NAME_PATTERNS,
  isPackageName,
  maxPackageFiles,
  packageNameNorm,
  packageNamespaceEmpty,
  packageNamespaceProblem,
} from "../src/index.js";

describe("PACKAGE_ECOSYSTEM_RULES", () => {
  it("declares every ecosystem once, under its own name", () => {
    expect(Object.keys(PACKAGE_ECOSYSTEM_RULES).sort()).toEqual(
      [...PACKAGE_ECOSYSTEMS].sort(),
    );
    for (const e of PACKAGE_ECOSYSTEMS)
      expect(PACKAGE_ECOSYSTEM_RULES[e].ecosystem).toBe(e);
  });

  it("is what every older table reads", () => {
    for (const e of PACKAGE_ECOSYSTEMS) {
      const r = PACKAGE_ECOSYSTEM_RULES[e];
      expect(PACKAGE_NAME_PATTERNS[e]).toBe(r.name.pattern);
      expect(PACKAGE_NAME_MAX_LENGTH[e]).toBe(r.name.maxLength);
      expect(PACKAGE_FILE_TYPES[e]).toBe(r.fileTypes);
      expect(PACKAGE_METADATA_KEYS[e]).toBe(r.metadataKeys);
      expect(maxPackageFiles(e)).toBe(r.maxFiles);
    }
  });

  it("keeps each ecosystem's grammar, normalisation and file ceiling", () => {
    expect(isPackageName("npm", "@acme/sdk")).toBe(true);
    expect(isPackageName("npm", "sdk")).toBe(false);
    expect(packageNameNorm("pypi", "Acme.SDK_x")).toBe("acme-sdk-x");
    expect(packageNameNorm("maven", "Com.Acme:SDK")).toBe("com.acme:sdk");
    expect(packageNameNorm("oci", "app/web")).toBe("app/web");
    expect(maxPackageFiles("oci")).toBe(4096);
    expect(maxPackageFiles("npm")).toBe(64);
    // Cargo: crates.io's key, case-insensitive with `-` and `_` equal; one crate per version.
    expect(packageNameNorm("cargo", "Acme_SDK-x")).toBe("acme-sdk-x");
    expect(isPackageName("cargo", "acme_sdk")).toBe(true);
    expect(isPackageName("cargo", "1acme")).toBe(false);
    expect(isPackageName("cargo", `a${"x".repeat(64)}`)).toBe(false);
    expect(maxPackageFiles("cargo")).toBe(1);
  });

  it("checks names against each feed's namespace, refusing an empty one", () => {
    const cases: Array<[string, string, unknown, boolean]> = [
      ["npm", "@acme/sdk", { scope: "@acme" }, true],
      ["npm", "@other/sdk", { scope: "@acme" }, false],
      ["swift", "acme.Sdk", { scope: "Acme" }, true],
      ["maven", "com.acme.x:sdk", { groupPrefixes: ["com.acme"] }, true],
      ["maven", "com.acmex:sdk", { groupPrefixes: ["com.acme"] }, false],
      ["pypi", "acme_sdk", { prefixes: ["acme"] }, true],
      ["pypi", "Other", { names: ["acme-sdk"] }, false],
      ["oci", "anything", {}, true],
      ["godot", "acme_tool", { publisher: "acme" }, true],
      ["cargo", "anything", {}, true],
    ];
    for (const [e, name, ns, inside] of cases)
      expect(
        packageNamespaceProblem(e as never, name, ns) === null,
        `${e} ${name}`,
      ).toBe(inside);
    for (const e of PACKAGE_ECOSYSTEMS) {
      const fields = Object.keys(PACKAGE_ECOSYSTEM_RULES[e].namespace.fields);
      expect(packageNamespaceEmpty(e, {}), e).toBe(fields.length > 0);
      expect(packageNamespaceProblem(e, "x", null) !== null, e).toBe(
        fields.length > 0,
      );
    }
  });
});

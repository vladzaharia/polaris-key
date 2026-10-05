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
  goMajorProblem,
  goPathMajor,
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
    expect(maxPackageFiles("go")).toBe(2);
  });

  it("takes Go module paths, and checks the major-version suffix against a version", () => {
    for (const ok of [
      "go.acme.dev/sdk",
      "example.com/Acme/SDK_x~1",
      "go.acme.dev/sdk/v2",
      "a.b",
    ])
      expect(isPackageName("go", ok), ok).toBe(true);
    for (const bad of [
      "acme/sdk", // the first element is a host name with a dot
      "Go.acme.dev/sdk", // ... in lower case
      "go.acme.dev/.sdk",
      "go.acme.dev/sdk.",
      "go.acme.dev//sdk",
      "go.acme.dev/sdk/",
      "go.acme.dev/s dk",
      "go_acme.dev/sdk",
    ])
      expect(isPackageName("go", bad), bad).toBe(false);
    expect(packageNameNorm("go", "example.com/Acme/SDK")).toBe(
      "example.com/acme/sdk",
    );
    expect(goPathMajor("go.acme.dev/sdk/v3")).toBe(3);
    expect(goPathMajor("go.acme.dev/sdk")).toBeNull();
    expect(goMajorProblem("go.acme.dev/sdk", "1.2.3")).toBeNull();
    expect(goMajorProblem("go.acme.dev/sdk", "0.1.0")).toBeNull();
    expect(goMajorProblem("go.acme.dev/sdk/v2", "2.0.0-rc.1")).toBeNull();
    expect(goMajorProblem("go.acme.dev/sdk", "2.0.0")).toMatch(/ends in \/v2/);
    expect(goMajorProblem("go.acme.dev/sdk/v3", "2.0.0")).toMatch(
      /ends in \/v2/,
    );
    expect(goMajorProblem("go.acme.dev/sdk/v2", "1.0.0")).toMatch(
      /no major suffix/,
    );
    expect(goMajorProblem("go.acme.dev/sdk/v1", "1.0.0")).toMatch(
      /not a Go major-version suffix/,
    );
    expect(goMajorProblem("go.acme.dev/sdk/v02", "2.0.0")).toMatch(
      /not a Go major-version suffix/,
    );
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
      ["go", "go.acme.dev/sdk/v2", { modulePrefixes: ["go.acme.dev"] }, true],
      ["go", "go.acme.dev", { modulePrefixes: ["go.acme.dev"] }, true],
      ["go", "go.acme.devx/sdk", { modulePrefixes: ["go.acme.dev"] }, false],
      // Go module paths are case-sensitive: the namespace compares them exactly.
      [
        "go",
        "example.com/Acme/sdk",
        { modulePrefixes: ["example.com/acme"] },
        false,
      ],
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

import { describe, expect, it } from "vitest";
import {
  PACKAGE_ECOSYSTEMS,
  PACKAGE_ECOSYSTEM_RULES,
  deriveFeedNamespace,
  isPackageName,
  namespaceIsEmpty,
  packageNamespaceProblem,
  type PackageEcosystem,
} from "../packages.js";

const OWNER = "acme-app";

/** Declared names per ecosystem; every one is valid for its grammar. */
const FIXTURES: Record<PackageEcosystem, string[]> = {
  npm: ["@acme/sdk", "@acme/cli", "@acme/sdk"],
  pypi: ["Acme_SDK", "acme.tools", "acme-sdk"],
  swift: ["acme.Sdk", "Acme.Tools"],
  maven: ["com.acme:sdk", "com.acme.tools:cli", "org.other:lib"],
  oci: ["acme/sdk", "acme/tools"],
  godot: ["acme_addon", "acme_other"],
  cargo: ["acme-sdk", "acme_tools"],
  go: ["example.com/acme/sdk", "example.com/acme/tools/v2"],
};

describe("deriveFeedNamespace", () => {
  it("has a fixture for every ecosystem", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      [...PACKAGE_ECOSYSTEMS].sort(),
    );
  });

  for (const eco of PACKAGE_ECOSYSTEMS) {
    describe(eco, () => {
      const rules = PACKAGE_ECOSYSTEM_RULES[eco];
      const names = FIXTURES[eco];

      it("fixtures follow the name grammar", () => {
        for (const n of names) expect(isPackageName(eco, n)).toBe(true);
      });

      it("covers every declared name and is not empty", () => {
        const { namespace, ambiguous } = deriveFeedNamespace(eco, names, OWNER);
        expect(ambiguous).toBeNull();
        expect(namespaceIsEmpty(rules, namespace)).toBe(false);
        for (const n of names)
          expect(packageNamespaceProblem(eco, n, namespace)).toBeNull();
      });

      it("is deterministic and independent of input order", () => {
        const a = deriveFeedNamespace(eco, names, OWNER);
        const b = deriveFeedNamespace(eco, [...names].reverse(), OWNER);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(JSON.stringify(deriveFeedNamespace(eco, names, OWNER))).toBe(
          JSON.stringify(a),
        );
      });

      it("answers {} with no names", () => {
        expect(deriveFeedNamespace(eco, [], OWNER)).toEqual({
          namespace: {},
          ambiguous: null,
        });
      });

      it("only uses keys the ecosystem declares", () => {
        const { namespace } = deriveFeedNamespace(eco, names, OWNER);
        for (const k of Object.keys(namespace))
          expect(Object.keys(rules.namespace.fields)).toContain(k);
      });
    });
  }

  it("sorts and de-duplicates lists", () => {
    expect(
      deriveFeedNamespace("pypi", ["b-pkg", "A_pkg", "a.pkg"], OWNER).namespace,
    ).toEqual({ names: ["a-pkg", "b-pkg"] });
    expect(
      deriveFeedNamespace("maven", ["org.z:a", "com.a:b", "com.a:c"], OWNER)
        .namespace,
    ).toEqual({ groupPrefixes: ["com.a", "org.z"] });
    expect(
      deriveFeedNamespace("go", ["example.com/z", "example.com/a"], OWNER)
        .namespace,
    ).toEqual({ modulePrefixes: ["example.com/a", "example.com/z"] });
  });

  it("refuses a sibling where the fields can express it", () => {
    const pypi = deriveFeedNamespace("pypi", ["acme-sdk"], OWNER).namespace;
    expect(
      packageNamespaceProblem("pypi", "acme-sdk-evil", pypi),
    ).not.toBeNull();
    expect(packageNamespaceProblem("pypi", "Acme_SDK", pypi)).toBeNull();

    const maven = deriveFeedNamespace(
      "maven",
      ["com.acme:sdk"],
      OWNER,
    ).namespace;
    expect(
      packageNamespaceProblem("maven", "com.other:sdk", maven),
    ).not.toBeNull();
    expect(
      packageNamespaceProblem("maven", "com.acmeevil:sdk", maven),
    ).not.toBeNull();

    const go = deriveFeedNamespace(
      "go",
      ["example.com/acme/sdk"],
      OWNER,
    ).namespace;
    expect(
      packageNamespaceProblem("go", "example.com/acme/other", go),
    ).not.toBeNull();
    expect(
      packageNamespaceProblem("go", "example.com/acme/sdkevil", go),
    ).not.toBeNull();

    const npm = deriveFeedNamespace("npm", ["@acme/sdk"], OWNER).namespace;
    expect(packageNamespaceProblem("npm", "@other/sdk", npm)).not.toBeNull();

    const swift = deriveFeedNamespace("swift", ["acme.Sdk"], OWNER).namespace;
    expect(packageNamespaceProblem("swift", "other.Sdk", swift)).not.toBeNull();
  });

  it("known property: a Maven groupId and a Go module admit their subpaths (prefix semantics)", () => {
    const maven = deriveFeedNamespace(
      "maven",
      ["com.acme:sdk"],
      OWNER,
    ).namespace;
    expect(
      packageNamespaceProblem("maven", "com.acme.sub:x", maven),
    ).toBeNull();
    const go = deriveFeedNamespace("go", ["example.com/m"], OWNER).namespace;
    expect(packageNamespaceProblem("go", "example.com/m/sub", go)).toBeNull();
  });

  it("several npm or Swift scopes are ambiguous with {}", () => {
    const npm = deriveFeedNamespace("npm", ["@a/x", "@b/y"], OWNER);
    expect(npm.namespace).toEqual({});
    expect(npm.ambiguous).toMatch(/@a, @b/);
    const swift = deriveFeedNamespace("swift", ["a.X", "b.Y"], OWNER);
    expect(swift.namespace).toEqual({});
    expect(swift.ambiguous).toMatch(/a, b/);
  });

  it("npm and Swift scopes are lower-cased", () => {
    expect(deriveFeedNamespace("swift", ["Acme.X", "acme.Y"], OWNER)).toEqual({
      namespace: { scope: "acme" },
      ambiguous: null,
    });
  });

  it("Godot's publisher is the owner slug; an invalid one is ambiguous", () => {
    expect(deriveFeedNamespace("godot", ["addon"], "my-app")).toEqual({
      namespace: { publisher: "my-app" },
      ambiguous: null,
    });
    const bad = deriveFeedNamespace("godot", ["addon"], "Not Valid");
    expect(bad.namespace).toEqual({});
    expect(bad.ambiguous).not.toBeNull();
  });

  it("Cargo and OCI derive no namespace", () => {
    for (const eco of ["cargo", "oci"] as const)
      expect(deriveFeedNamespace(eco, FIXTURES[eco], OWNER)).toEqual({
        namespace: {},
        ambiguous: null,
      });
  });
});

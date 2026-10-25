/**
 * A-20.5: `outlet_without_build`, the warning for a declared outlet whose channel serves none of
 * the platforms the release declares builds for. It is a warning only: nothing is refused, a
 * bare `direct` never warns, and it is silent while no artifact map is declared.
 */
import { describe, expect, it } from "vitest";
import { validateManifestDocuments } from "../src/index.js";

const build = (id: string, platform: string, format: string, arch = "any") => ({
  id,
  platform,
  arch,
  format,
  match: `Acme-*-${id}.${format}`,
});

function check(outlets: Record<string, unknown>, artifacts?: unknown[]) {
  return validateManifestDocuments({
    product: {
      slug: "acme",
      name: "Acme",
      modules: { release: { enabled: true }, distribution: { enabled: true } },
    },
    release: {
      release: {
        provider: { type: "github", owner: "acme", repo: "desktop" },
        binaryName: "acme",
        ...(artifacts === undefined
          ? {}
          : { deliverables: { app: { kind: "app", artifacts } } }),
      },
    },
    distribution: { apiVersion: "pkey.dev/v1", outlets },
  });
}

const warned = (res: ReturnType<typeof check>) =>
  res.warnings.filter((w) => w.code === "outlet_without_build");

describe("outlet_without_build (A-20.5)", () => {
  it("warns for an App Store outlet with only Windows builds, naming the platforms", () => {
    const res = check({ "app-store": { appleId: "1234567890" } }, [
      build("win", "windows", "msi", "x86_64"),
    ]);
    const hits = warned(res);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      file: "distribution",
      path: "/outlets/app-store",
    });
    expect(hits[0]!.message).toContain("ios or macos build");
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("is silent when the release declares no artifact map", () => {
    expect(warned(check({ "app-store": { appleId: "1234567890" } }))).toEqual(
      [],
    );
    expect(
      warned(check({ "app-store": { appleId: "1234567890" } }, [])),
    ).toEqual([]);
  });

  it("is silent for a bare direct outlet, whatever the builds", () => {
    expect(
      warned(check({ direct: {} }, [build("apk", "android", "apk")])),
    ).toEqual([]);
    expect(
      warned(
        check({ direct: { platforms: ["macos"] } }, [
          build("apk", "android", "apk"),
        ]),
      ),
    ).toEqual([]);
  });

  it("is silent when the platforms intersect", () => {
    expect(
      warned(
        check({ "app-store": { appleId: "1234567890" } }, [
          build("mac", "macos", "dmg", "universal"),
        ]),
      ),
    ).toEqual([]);
  });

  it("judges a direct outlet's package-manager subkind: homebrew needs macos or linux", () => {
    const res = check({ direct: { homebrewCask: "acme" } }, [
      build("win", "windows", "msi", "x86_64"),
    ]);
    const hits = warned(res);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain("macos or linux build");
    expect(
      warned(
        check({ direct: { homebrewCask: "acme" } }, [
          build("mac", "macos", "dmg", "universal"),
        ]),
      ),
    ).toEqual([]);
  });

  it("warns once per outlet, so two stores with no build give two warnings", () => {
    const res = check(
      { flathub: { appId: "com.acme.Desktop" }, snap: { name: "acme" } },
      [build("win", "windows", "msi", "x86_64")],
    );
    expect(warned(res).map((w) => w.path)).toEqual([
      "/outlets/flathub",
      "/outlets/snap",
    ]);
  });
});

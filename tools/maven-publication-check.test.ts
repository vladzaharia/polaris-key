/**
 * The pre-upload Maven publication check (tools/maven-publication-check.mjs): a release version
 * whose POM matches no `maven.*` artifacts glob fails in the Kotlin build job, not in the publish
 * job (the v0.9.3 maven.packs failure surfaced only at publish time).
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkPublication,
  globMatches,
  mavenDeliverables,
} from "./maven-publication-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = readFileSync(join(ROOT, ".pkey", "release.yaml"), "utf8");

const pom = (artifactId: string, version: string) =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>im.plrs.key</groupId><artifactId>${artifactId}</artifactId><version>${version}</version><dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>1</version></dependency></dependencies></project>`;

/** A Gradle repo holding every declared maven.* artifact at `version`. */
function repo(version: string, skip: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "pkey-mvn-"));
  for (const d of mavenDeliverables(RELEASE)) {
    const a = d.name!.split(":")[1]!;
    if (skip.includes(a)) continue;
    const v = join(dir, "im", "plrs", "key", a, version);
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, `${a}-${version}.pom`), pom(a, version));
    writeFileSync(join(v, `${a}-${version}.pom.sha1`), "x");
    writeFileSync(join(v, `${a}-${version}.jar`), "x");
  }
  return dir;
}

describe("maven publication check", () => {
  it("reads every maven.* deliverable from the real .pkey/release.yaml", () => {
    const ds = mavenDeliverables(RELEASE);
    expect(ds.length).toBeGreaterThanOrEqual(18);
    for (const d of ds) {
      expect(d.name).toMatch(/^im\.plrs\.key:polaris-key-/);
      // `ui` and `server` are the narrowed globs: `polaris-key-ui-*` would also take ui-core's
      // files, and `polaris-key-server-*` server-ktor's.
      const narrowed = [
        "im.plrs.key:polaris-key-ui",
        "im.plrs.key:polaris-key-server",
      ];
      expect(d.match).toBe(
        narrowed.includes(d.name!)
          ? `${d.name!.split(":")[1]}-?.*`
          : `${d.name!.split(":")[1]}-*`,
      );
    }
  });

  it("the ui glob does not take polaris-key-ui-core's files", () => {
    const ui = mavenDeliverables(RELEASE).find((d) => d.id === "maven.ui")!;
    expect(globMatches(ui.match!, "polaris-key-ui-0.9.4.pom")).toBe(true);
    expect(
      globMatches(ui.match!, "polaris-key-ui-0.9.4-main.7-sources.jar"),
    ).toBe(true);
    expect(globMatches(ui.match!, "polaris-key-ui-core-0.9.4.pom")).toBe(false);
    expect(globMatches(ui.match!, "polaris-key-ui-core-0.9.4.module")).toBe(
      false,
    );
  });

  it("the server glob does not take polaris-key-server-ktor's files", () => {
    const server = mavenDeliverables(RELEASE).find(
      (d) => d.id === "maven.server",
    )!;
    expect(globMatches(server.match!, "polaris-key-server-0.9.6.pom")).toBe(
      true,
    );
    expect(
      globMatches(server.match!, "polaris-key-server-0.9.6-main.7-sources.jar"),
    ).toBe(true);
    expect(
      globMatches(server.match!, "polaris-key-server-ktor-0.9.6.pom"),
    ).toBe(false);
  });

  it("globMatches is the release glob dialect", () => {
    expect(
      globMatches("polaris-key-packs-*", "polaris-key-packs-0.9.3.pom"),
    ).toBe(true);
    expect(
      globMatches("polaris-key-packs-*", "polaris-key-update-0.9.3.pom"),
    ).toBe(false);
  });

  for (const version of ["0.9.3", "0.9.4-main.11"]) {
    it(`passes a complete publication at ${version}`, () => {
      expect(checkPublication(repo(version), version, RELEASE)).toEqual([]);
    });
  }

  it("fails early when a deliverable's POM is missing, naming it", () => {
    const problems = checkPublication(
      repo("0.9.3", ["polaris-key-packs"]),
      "0.9.3",
      RELEASE,
    );
    expect(problems).toEqual([expect.stringContaining("maven.packs: 0 POMs")]);
  });

  it("fails when the POM is at another version than the release", () => {
    const problems = checkPublication(repo("0.9.2"), "0.9.3", RELEASE);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/expected polaris-key-.*-0\.9\.3\.pom/);
  });

  it("fails when a release.yaml glob matches no POM", () => {
    const broken = RELEASE.replace(
      "polaris-key-packs-*",
      "polaris-key-packz-*",
    );
    const problems = checkPublication(repo("0.9.3"), "0.9.3", broken);
    expect(problems.some((p) => p.startsWith("maven.packs: 0 POMs"))).toBe(
      true,
    );
  });

  it("the Kotlin build script publishes packs as polaris-key-packs (the glob's artifact)", () => {
    expect(
      readFileSync(
        join(ROOT, "sdks", "kotlin", "packs", "build.gradle.kts"),
        "utf8",
      ),
    ).toContain('artifactId = "polaris-key-packs"');
  });
});

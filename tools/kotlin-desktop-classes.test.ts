/**
 * The kotlin-desktop job runs named test classes, not whole modules (QA Q4). A rename or a delete
 * would make Gradle's `--tests` filter match nothing and fail the leg for a reason nobody owns, so
 * every class named in the job must exist, and the legs must agree.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ci = parseYaml(
  readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};

const steps = ci.jobs["kotlin-desktop"]!.steps;
const stepRun = (os: string) =>
  steps.find((s) => s.name?.startsWith(`JVM desktop suites (${os}`))?.run ?? "";

/** `module:FQCN` for every `:module:test` task and the `--tests` filters that follow it. */
const classesOf = (run: string): string[] => {
  const out: string[] = [];
  let mod = "";
  for (const m of run.matchAll(/:(\w+):test\b|--tests\s+["']([\w.]+)["']/g)) {
    if (m[1]) mod = m[1];
    else out.push(`${mod}:${m[2]}`);
  }
  return out;
};

const sourceOf = (entry: string) => {
  const [mod, fqcn] = entry.split(":") as [string, string];
  return join(
    ROOT,
    "sdks/kotlin",
    mod,
    "src/test/kotlin",
    `${fqcn.replaceAll(".", "/")}.kt`,
  );
};

describe("kotlin-desktop class lists", () => {
  const linux = classesOf(stepRun("Linux"));
  const mac = classesOf(stepRun("macOS"));
  const windows = classesOf(stepRun("Windows"));

  it("name the classes the leg is for", () => {
    for (const c of [
      "core:im.plrs.key.core.KeyringStoreTest",
      "core:im.plrs.key.core.CacheTest",
      "core:im.plrs.key.core.DeviceKeysTest",
      "core:im.plrs.key.core.DegradedStoreWarningTest",
    ])
      expect(linux, c).toContain(c);
  });

  it("each exist as a test source", () => {
    for (const c of new Set([...linux, ...mac, ...windows]))
      expect(existsSync(sourceOf(c)), c).toBe(true);
  });

  it("are the same on Linux and macOS, and cover the Windows leg", () => {
    expect([...mac].sort()).toEqual([...linux].sort());
    for (const c of windows) expect(linux, c).toContain(c);
  });

  it("keep the build cache off only for the keyring class", () => {
    const run = stepRun("Linux");
    expect(run.match(/--no-build-cache/g)?.length).toBe(1);
    expect(run).toMatch(
      /--no-build-cache[^"]*:core:test --tests "im\.plrs\.key\.core\.KeyringStoreTest"/,
    );
  });
});

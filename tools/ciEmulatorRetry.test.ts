/**
 * The kotlin-emulator job retries only a known emulator or adb failure; a test failure gets no second
 * attempt (tools/ci-emulator-retry.mjs, tools/ci-emulator-run.sh, .github/workflows/ci.yml).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { shouldRetry } from "./ci-emulator-retry.mjs";

describe("emulator retry decision", () => {
  it("retries when the run script never started (the emulator did not boot)", () => {
    expect(shouldRetry(null)).toBe(true);
  });

  it.each([
    "adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]",
    "Error: install-write failed for the test APK",
    "adb: could not connect to TCP port 5554",
    "error: device offline",
    "emulator: ERROR: the AVD is already running",
  ])("retries on the infrastructure signature %s", (line) => {
    expect(
      shouldRetry(`> Task :app:connectedLeanDebugAndroidTest\n${line}\n`),
    ).toBe(true);
  });

  it("does not retry a test failure", () => {
    const log = [
      "> Task :app:connectedLeanDebugAndroidTest FAILED",
      "im.plrs.key.LicenseGateTest > verifiesSignedDocument[Pixel_API_34] FAILED",
      "    java.lang.AssertionError: expected:<valid> but was:<expired>",
      "1 test failed",
    ].join("\n");
    expect(shouldRetry(log)).toBe(false);
  });

  it("does not retry an empty log from a script that started and failed quietly", () => {
    expect(shouldRetry("")).toBe(false);
  });
});

describe("kotlin-emulator job", () => {
  type Step = { id?: string; if?: string; run?: string; uses?: string };
  const ci = parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  ) as { jobs: Record<string, { steps: Step[] }> };
  const steps = ci.jobs["kotlin-emulator"]!.steps;
  const byId = (id: string) => steps.find((s) => s.id === id)!;

  it("runs the second attempt only when the classifier says so, never on any failure", () => {
    expect(byId("emulator2").if).toBe("steps.classify.outputs.retry == 'true'");
    expect(byId("classify").if).toBe("steps.emulator.outcome == 'failure'");
    expect(byId("classify").run).toContain("ci-emulator-retry.mjs");
  });

  it("keeps each attempt's output through the run script", () => {
    for (const id of ["emulator", "emulator2"])
      expect(JSON.stringify(byId(id))).toContain("ci-emulator-run.sh");
  });

  it("fails the job when the attempt failed and no second attempt passed", () => {
    const fail = steps.find((s) =>
      (s.if ?? "").includes("steps.emulator2.outcome != 'success'"),
    )!;
    expect(fail.if).toContain("steps.emulator.outcome == 'failure'");
    expect(fail.run).toContain("exit 1");
  });

  it("caches the AVD, saving it only from next", () => {
    const restore = steps.find((s) =>
      s.uses?.includes("actions/cache/restore"),
    );
    const save = steps.find((s) => s.uses?.includes("actions/cache/save"));
    expect(restore?.id).toBe("avd-cache");
    expect(save).toBeDefined();
    expect(byId("avd").if).toContain("refs/heads/next");
    expect(save!.if).toContain("steps.avd.outcome == 'success'");
  });
});

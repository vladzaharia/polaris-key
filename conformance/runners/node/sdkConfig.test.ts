// `pkey sdk --lang node --write` (SDK parity pass §3.19, SP-02): the committed sample
// (sdkConfigSample.ts, pinned to the renderer by packages/cli/test/sdkConfig.test.ts) type-checks
// against `PolarisKeyClientOptions` (`pnpm typecheck` here) and builds a client with no edits
// beyond the app's version.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolarisKeyClient } from "@polaris-key/node";
import polarisConfig from "./sdkConfigSample.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("pkey sdk --lang node sample", () => {
  it("builds a client from the generated module and the app's version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pkey-sdkconfig-"));
    dirs.push(root);
    const client = await PolarisKeyClient.create({
      ...polarisConfig,
      version: "1.2.3",
      configDir: path.join(root, "config"),
      dataDir: path.join(root, "data"),
      cacheDir: path.join(root, "cache"),
      stateDir: path.join(root, "state"),
      fetchImpl: () => Promise.reject(new Error("no network in this test")),
    });
    try {
      expect(polarisConfig.expectedServices).toContain("update");
      expect(client.isLicensed()).toBe(false);
    } finally {
      client.close();
    }
  });
});

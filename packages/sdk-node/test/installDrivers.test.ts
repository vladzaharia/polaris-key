// @pkey-feature update.driver update.bootguard
// SDK parity pass §3.16 (SP-N09): update.install(decision) hands a signed decision to an install
// driver and answers a typed InstallOutcome; every driver keeps the verified decision as the
// authority and records the update-health events.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordHash } from "@polaris-key/client-core";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import { PolarisKeyClient } from "../src/client.js";
import {
  electronUpdaterDriver,
  seaSelfReplaceDriver,
  storeLinkDriver,
  velopackDriver,
  type VelopackUpdateInfo,
} from "../src/update/drivers/index.js";
import { tempDir } from "./parityFixtures.js";
import {
  BASE,
  discoveryDoc,
  MemStore,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  recordPayload,
  signRecord,
  V4_SERVICES,
} from "./updateFixtures.js";

const BYTES = Buffer.from(
  "#!/bin/sh\necho polaris-key next build\n".repeat(16),
);
const SHA = createHash("sha256").update(BYTES).digest("hex");

async function setup(o: { artifactName?: string; velopack?: boolean } = {}) {
  const payload = recordPayload();
  (
    payload as unknown as { builds: { artifacts: unknown[] }[] }
  ).builds[0]!.artifacts = [
    {
      name: o.artifactName ?? "app",
      role: "payload",
      sha256: SHA,
      size: BYTES.length,
    },
  ];
  const recordJws = await signRecord(payload);
  const hash = await recordHash(recordJws);
  const doc = discoveryDoc() as {
    services: { update: { endpoints: Record<string, string> } };
  };
  if (o.velopack)
    doc.services.update.endpoints.velopack = `${BASE}/${PRODUCT}/update/{channel}/velopack/releases.{velopackChannel}.json`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === `/${PRODUCT}/.well-known/polaris.json`)
      return new Response(JSON.stringify(doc), { status: 200 });
    if (url.pathname === `/${PRODUCT}/release/records/${hash}`)
      return new Response(recordJws, { status: 200 });
    if (url.pathname === `/${PRODUCT}/distribution/builds/1.5.0/macos-zip`)
      return new Response(BYTES, { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const store = new MemStore("dev_install");
  store.token = "pkeyt_install";
  const dir = tempDir();
  const opened: string[] = [];
  const client = await PolarisKeyClient.create({
    productSlug: PRODUCT,
    baseUrl: BASE,
    version: "1.4.0",
    trust: { pinnedKeys: PINS },
    store,
    fetchImpl,
    requestTimeoutMs: 0,
    stateDir: dir,
    expectedServices: [...V4_SERVICES] as never,
    update: {
      pinnedReleaseKeys: RELEASE_KEYS,
      outlet: "direct",
      platform: "macos",
      arch: "arm64",
      openUrl: (u) => {
        opened.push(u);
        return true;
      },
    },
  });
  const decision: Extract<UpdateDecision, { action: "binary" }> = {
    action: "binary",
    method: "download",
    release: { version: "1.5.0", seq: 15, sha256: hash },
    build: "macos-zip",
    mandatory: false,
    critical: false,
    prestage: [],
    discardStaged: false,
  };
  return { client, decision, dir, opened };
}

const events = async (client: PolarisKeyClient) =>
  (await client.update.journal.all()).map((e) => e.event);

describe("update.install without a driver", () => {
  it("answers typed outcomes, never a silent no-op", async () => {
    const { client, decision, opened } = await setup();
    expect(await client.update.install(decision)).toMatchObject({
      kind: "unsupported",
      reason: "dependency",
    });
    expect(
      await client.update.install({
        action: "packs",
        install: [],
        revoke: [],
        set: [],
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "product" });
    expect(
      await client.update.install({
        action: "platform",
        release: decision.release,
        mandatory: false,
        critical: false,
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "outlet" });
    const store: UpdateDecision = {
      action: "store",
      release: decision.release,
      listingUrl: "https://store.test/app",
      mandatory: false,
      critical: false,
      discardStaged: false,
    };
    expect(await client.update.install(store)).toEqual({
      kind: "storeOpened",
      url: "https://store.test/app",
    });
    expect(opened).toEqual(["https://store.test/app"]);
  });
});

describe("electronUpdaterDriver", () => {
  function fakeUpdater(dir: string, o: { version?: string; bytes?: Buffer }) {
    const listeners = new Set<
      (p: { transferred: number; total: number }) => void
    >();
    const file = join(dir, "eu-download.bin");
    return {
      autoDownload: true,
      quitAndInstall: vi.fn(),
      async checkForUpdates() {
        return { updateInfo: { version: o.version ?? "1.5.0" } };
      },
      async downloadUpdate() {
        const b = o.bytes ?? BYTES;
        for (const l of listeners)
          l({ transferred: b.length, total: b.length });
        writeFileSync(file, b);
        return [file];
      },
      on(_e: "download-progress", l: never) {
        listeners.add(l);
      },
      removeListener(_e: "download-progress", l: never) {
        listeners.delete(l);
      },
    };
  }

  it("downloads, verifies against the record, and restarts into the build", async () => {
    const { client, decision, dir } = await setup();
    const up = fakeUpdater(dir, {});
    client.update.useDriver(electronUpdaterDriver({ autoUpdater: up }));
    const progress: number[] = [];
    const out = await client.update.install(decision, {
      onProgress: (d) => progress.push(d),
    });
    expect(out).toMatchObject({ kind: "restartRequired", version: "1.5.0" });
    expect(up.autoDownload).toBe(false);
    expect(progress).toEqual([BYTES.length]);
    expect(await events(client)).toEqual(["update_downloaded"]);
    if (out.kind !== "restartRequired") throw new Error("unreachable");
    await out.restart();
    expect(up.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(await events(client)).toEqual([
      "update_downloaded",
      "update_applied",
    ]);
  });

  it("refuses a feed that offers another version", async () => {
    const { client, decision, dir } = await setup();
    client.update.useDriver(
      electronUpdaterDriver({
        autoUpdater: fakeUpdater(dir, { version: "1.6.0" }),
      }),
    );
    expect(await client.update.install(decision)).toMatchObject({
      kind: "unsupported",
      reason: "version",
    });
  });

  it("refuses a download that is not an artifact of the signed record", async () => {
    const { client, decision, dir } = await setup();
    client.update.useDriver(
      electronUpdaterDriver({
        autoUpdater: fakeUpdater(dir, { bytes: Buffer.from("tampered") }),
      }),
    );
    await expect(client.update.install(decision)).rejects.toMatchObject({
      code: "payload-mismatch",
    });
    expect(await events(client)).toEqual([]);
  });
});

describe("velopackDriver", () => {
  it("points UpdateManager at the discovery feed's directory and applies on restart", async () => {
    const { client, decision } = await setup({ velopack: true });
    const seen: string[] = [];
    const apply = vi.fn();
    const exit = vi.fn();
    const info: VelopackUpdateInfo = {
      TargetFullRelease: { Version: "1.5.0" },
    };
    client.update.useDriver(
      velopackDriver({
        velopackChannel: "osx-arm64",
        exit,
        createManager: (url, channel) => {
          seen.push(url, channel);
          return {
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: async (_u, p) => p?.(100),
            waitExitThenApplyUpdate: apply,
          };
        },
      }),
    );
    const progress: [number, number][] = [];
    const out = await client.update.install(decision, {
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(seen).toEqual([
      `${BASE}/${PRODUCT}/update/stable/velopack`,
      "osx-arm64",
    ]);
    expect(progress).toEqual([[100, 100]]);
    expect(out).toMatchObject({ kind: "restartRequired", version: "1.5.0" });
    if (out.kind !== "restartRequired") throw new Error("unreachable");
    await out.restart();
    expect(apply).toHaveBeenCalledWith(info, false, true, []);
    expect(exit).toHaveBeenCalledOnce();
    expect(await events(client)).toEqual([
      "update_downloaded",
      "update_applied",
    ]);
  });

  it("is unsupported (product) when the product publishes no Velopack feed", async () => {
    const { client, decision } = await setup();
    client.update.useDriver(
      velopackDriver({
        velopackChannel: "win",
        createManager: () => {
          throw new Error("must not be built");
        },
      }),
    );
    expect(await client.update.install(decision)).toMatchObject({
      kind: "unsupported",
      reason: "product",
    });
  });
});

describe("seaSelfReplaceDriver", () => {
  it("replaces the executable with the verified build and rolls back through the guard", async () => {
    const { client, decision, dir } = await setup();
    const exe = join(dir, "bin", "djdl");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(exe, "old build");
    const relaunch = vi.fn();
    client.update.useDriver(
      seaSelfReplaceDriver({
        executablePath: exe,
        isSea: () => true,
        platform: "linux",
        relaunch,
      }),
    );
    const out = await client.update.install(decision);
    expect(out).toMatchObject({ kind: "restartRequired", version: "1.5.0" });
    expect(readFileSync(exe).equals(BYTES)).toBe(true);
    expect(readFileSync(`${exe}.previous`, "utf8")).toBe("old build");
    expect(existsSync(`${exe}.new`)).toBe(false);
    expect(await events(client)).toEqual([
      "update_downloaded",
      "update_applied",
    ]);
    if (out.kind !== "restartRequired") throw new Error("unreachable");
    await out.restart();
    expect(relaunch).toHaveBeenCalledWith(exe);

    // The driver's rollback is the boot guard's; the wrong previous version is refused.
    const rollback = client.update.guard.opts.rollback!;
    expect(await rollback("1.3.0")).toBe(false);
    expect(await rollback("1.4.0")).toBe(true);
    expect(readFileSync(exe, "utf8")).toBe("old build");
  });

  it("refuses outside a single-executable build, and refuses an archive payload", async () => {
    const a = await setup();
    a.client.update.useDriver(seaSelfReplaceDriver({ isSea: () => false }));
    expect(await a.client.update.install(a.decision)).toMatchObject({
      kind: "unsupported",
      reason: "runtime",
    });
    const b = await setup({ artifactName: "app.zip" });
    b.client.update.useDriver(
      seaSelfReplaceDriver({
        executablePath: join(b.dir, "never"),
        isSea: () => true,
      }),
    );
    expect(await b.client.update.install(b.decision)).toMatchObject({
      kind: "unsupported",
      reason: "product",
    });
  });
});

describe("storeLinkDriver", () => {
  it("opens the download page for a binary decision", async () => {
    const { client, decision, opened } = await setup();
    client.update.useDriver(
      storeLinkDriver({ downloadPage: (v) => `https://get.test/${v}` }),
    );
    expect(await client.update.install(decision)).toEqual({
      kind: "storeOpened",
      url: "https://get.test/1.5.0",
    });
    expect(opened).toEqual(["https://get.test/1.5.0"]);
  });

  it("is unsupported (product) without a page", async () => {
    const { client, decision } = await setup();
    client.update.useDriver(storeLinkDriver());
    expect(await client.update.install(decision)).toMatchObject({
      kind: "unsupported",
      reason: "product",
    });
  });
});

// @pkey-feature outlet.detect
//
// Outlet detection in the Node SDK (plans/P3-01.md §2.9). The mapping is client-core's
// `detectOutlet`, run row for row over `outlet-matrix.json` by `conformance/runners/node`; this
// file proves the READERS (`readOutletSignals`, over a faked install for every outlet a Node
// process can see) and the WIRING: with no host outlet the update client detects in-process and
// `decide()` uses the result; a host value always wins.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordHash } from "@polaris-key/client-core";
import { detectOutlet, detectionStamp } from "../src/index.js";
import { PolarisKeyClient } from "../src/client.js";
import { FileStore } from "../src/core/store.js";
import type { UpdateClientOptions } from "../src/update/client.js";
import {
  readOutletSignals,
  type OutletFs,
  type OutletReaderEnvironment,
} from "../src/update/outlet.js";
import {
  BASE,
  PINS,
  PRODUCT,
  RELEASE_KEYS,
  V4_SERVICES,
  fakeWorker,
  feedPayload,
  recordPayload,
  signFeed,
  signRecord,
} from "./updateFixtures.js";

const IDS = {
  steamAppId: "3166810",
  itchGameId: "1001",
  flatpakId: "gg.vlad.Diceroll",
  snapName: "diceroll",
  caskToken: "diceroll",
  homebrewFormula: "diceroll",
  msixFamilyName: "Diceroll_abc123",
  bundleId: "gg.vlad.diceroll",
};
const STAMP = { outlet: "direct", outletKind: "direct", outletIds: IDS };

/** A fake file system: files (path → bytes), symlinks (path → target) and directories derived
 *  from both. */
function fakeFs(
  files: Record<string, string | Uint8Array> = {},
  links: Record<string, string> = {},
  real: Record<string, string> = {},
): OutletFs {
  const all = [...Object.keys(files), ...Object.keys(links)];
  const dirs = new Set<string>();
  for (const p of all)
    for (
      let d = p.slice(0, p.lastIndexOf("/"));
      d;
      d = d.slice(0, d.lastIndexOf("/"))
    )
      dirs.add(d);
  return {
    existsSync: (p) => p in files || p in links || dirs.has(p),
    readFileSync: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return typeof f === "string" ? Buffer.from(f, "utf8") : f;
    },
    realpathSync: (p) => real[p] ?? links[p] ?? p,
    readdirSync: (p) => {
      if (!dirs.has(p)) throw new Error(`ENOTDIR ${p}`);
      const names = new Set<string>();
      for (const q of [...all, ...dirs])
        if (q.startsWith(`${p}/`))
          names.add(q.slice(p.length + 1).split("/")[0]!);
      return [...names];
    },
    lstatSync: (p) => ({ isSymbolicLink: () => p in links }),
    readlinkSync: (p) => {
      const t = links[p];
      if (t === undefined) throw new Error(`EINVAL ${p}`);
      return t;
    },
  };
}

const read = (o: OutletReaderEnvironment) =>
  readOutletSignals({
    env: {},
    isSea: false,
    electron: null,
    scriptPath: null,
    fs: fakeFs(),
    outletIds: IDS,
    ...o,
  });

const detect = (o: OutletReaderEnvironment, stamp: unknown = STAMP) =>
  detectOutlet({ stamp: detectionStamp(stamp), signals: read(o) });

const MAC_APP = "/Applications/Diceroll.app/Contents/MacOS/Diceroll";

describe("readOutletSignals — macOS", () => {
  it("an App Store receipt in the bundle names app-store; ProductionSandbox names testflight", () => {
    const receipt = "/Applications/Diceroll.app/Contents/_MASReceipt/receipt";
    const mas = {
      platform: "darwin",
      execPath: MAC_APP,
      electron: { mas: true },
    };
    expect(
      read({ ...mas, fs: fakeFs({ [receipt]: "receipt-bytes" }) }),
    ).toEqual({
      "macos.masReceipt": true,
      "macos.receiptSandbox": false,
    });
    expect(
      detect({ ...mas, fs: fakeFs({ [receipt]: "receipt-bytes" }) }),
    ).toEqual({
      kind: "app-store",
      confidence: "attested",
      source: "macos.masReceipt",
      subkind: null,
    });
    expect(
      detect(
        { ...mas, fs: fakeFs({ [receipt]: "..ProductionSandbox.." }) },
        null,
      ).kind,
    ).toBe("testflight");
    expect(read({ ...mas, fs: fakeFs() })).toEqual({
      "macos.masReceipt": false,
    });
  });

  it("a Caskroom link to this bundle, named by the cask token, restricts to direct + homebrew", () => {
    const fs = fakeFs(
      {},
      {
        "/opt/homebrew/Caskroom/diceroll/1.4.0/Diceroll.app":
          "/Applications/Diceroll.app",
      },
    );
    const o = { platform: "darwin", execPath: MAC_APP, electron: {}, fs };
    expect(read(o)["macos.homebrewCask"]).toBe("diceroll");
    expect(detect(o)).toEqual({
      kind: "direct",
      confidence: "heuristic",
      source: "macos.homebrewCask",
      subkind: "homebrew",
    });
    // Another token's Caskroom is never read: only the product's own token is looked up.
    expect(
      read({ ...o, outletIds: { caskToken: "other" } })["macos.homebrewCask"],
    ).toBe(undefined);
  });

  it("a script whose realpath is in the Cellar names the formula", () => {
    const fs = fakeFs(
      {},
      {},
      {
        "/opt/homebrew/bin/diceroll":
          "/opt/homebrew/Cellar/diceroll/1.4.0/libexec/cli.js",
      },
    );
    const o = {
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      scriptPath: "/opt/homebrew/bin/diceroll",
      fs,
    };
    expect(read(o)["macos.homebrewFormula"]).toBe("diceroll");
    expect(detect(o).subkind).toBe("homebrew");
  });
});

describe("readOutletSignals — Windows", () => {
  const store =
    "C:\\Program Files\\WindowsApps\\Diceroll_1.4.0.0_x64__abc123\\Diceroll.exe";
  it("Electron's windowsStore reads the package family name from the WindowsApps path", () => {
    const o = {
      platform: "win32",
      execPath: store,
      electron: { windowsStore: true },
    };
    expect(read(o)).toEqual({ "windows.packageIdentity": "Diceroll_abc123" });
    // Package identity alone selects nothing: the stamp stands (SignatureKind needs WinRT).
    expect(detect(o)).toEqual({
      kind: "direct",
      confidence: "stamp",
      source: "stamp",
      subkind: null,
    });
    expect(read({ ...o, electron: { windowsStore: false } })).toEqual({});
  });
  it.each([
    [
      "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Diceroll\\diceroll.exe",
      "winget",
      { kind: "winget", subkind: null },
    ],
    [
      "C:\\Users\\a\\scoop\\apps\\diceroll\\current\\diceroll.exe",
      "scoop",
      { kind: "direct", subkind: "scoop" },
    ],
    [
      "C:\\ProgramData\\chocolatey\\lib\\diceroll\\tools\\diceroll.exe",
      "chocolatey",
      { kind: "direct", subkind: "chocolatey" },
    ],
  ])("%s is the %s path convention", (path, value, out) => {
    const o = { platform: "win32", execPath: path, isSea: true };
    expect(read(o)).toEqual({ "windows.pathConvention": value });
    expect(detect(o)).toMatchObject({
      ...out,
      confidence: "heuristic",
      source: "windows.pathConvention",
    });
  });
});

describe("readOutletSignals — Linux", () => {
  it("/.flatpak-info's application name with this id names flathub", () => {
    const fs = fakeFs({
      "/.flatpak-info":
        "[Application]\nname=gg.vlad.Diceroll\nruntime=runtime/x\n[Instance]\nbranch=master\n",
    });
    const o = {
      platform: "linux",
      execPath: "/app/bin/diceroll",
      isSea: true,
      fs,
    };
    expect(read(o)).toEqual({ "linux.flatpakInfo": "gg.vlad.Diceroll" });
    expect(detect(o)).toMatchObject({
      kind: "flathub",
      confidence: "attested",
    });
  });
  it("SNAP_NAME and SNAP_REVISION restrict to snap; a local revision vetoes a snap stamp", () => {
    const o = {
      platform: "linux",
      env: { SNAP_NAME: "diceroll", SNAP_REVISION: "42" },
    };
    expect(read(o)).toEqual({
      "linux.snapEnv": { name: "diceroll", revision: "42" },
    });
    expect(detect(o)).toMatchObject({ kind: "snap", confidence: "declared" });
    expect(
      detect(
        {
          platform: "linux",
          env: { SNAP_NAME: "diceroll", SNAP_REVISION: "x1" },
        },
        { outlet: "snap", outletIds: IDS },
      ).kind,
    ).toBe("unknown");
  });
  it("APPIMAGE and APPDIR around the executable restrict to direct + appimage", () => {
    const o = {
      platform: "linux",
      execPath: "/tmp/.mount_DicerX1/usr/bin/diceroll",
      isSea: true,
      env: {
        APPIMAGE: "/home/a/Diceroll.AppImage",
        APPDIR: "/tmp/.mount_DicerX1",
      },
    };
    expect(read(o)["linux.appImageEnv"]).toEqual({
      appImage: "/home/a/Diceroll.AppImage",
      appDir: "/tmp/.mount_DicerX1",
      exePath: "/tmp/.mount_DicerX1/usr/bin/diceroll",
    });
    expect(detect(o)).toMatchObject({ kind: "direct", subkind: "appimage" });
  });
});

describe("readOutletSignals — Steam and itch", () => {
  const lib = "/home/a/.steam/steam";
  const exe = `${lib}/steamapps/common/Diceroll/diceroll`;
  const acf = `"AppState"\n{\n\t"appid"\t\t"3166810"\n\t"installdir"\t\t"Diceroll"\n\t"buildid"\t\t"22883144"\n}\n`;

  it("the product's own appmanifest naming this install dir moves direct to steam (declared)", () => {
    const o = {
      platform: "linux",
      execPath: exe,
      isSea: true,
      fs: fakeFs({ [`${lib}/steamapps/appmanifest_3166810.acf`]: acf }),
    };
    expect(read(o)).toEqual({ "steam.libraryManifest": "3166810" });
    expect(detect(o)).toMatchObject({ kind: "steam", confidence: "declared" });
    // A manifest for another install dir does not count, and no other manifest is read.
    const other = acf.replace('"Diceroll"', '"Other"');
    expect(
      read({
        ...o,
        fs: fakeFs({ [`${lib}/steamapps/appmanifest_3166810.acf`]: other }),
      }),
    ).toEqual({});
  });
  it("SteamAppId names steam (heuristic) only with this app id", () => {
    const o = { env: { SteamAppId: "3166810", SteamClientLaunch: "1" } };
    expect(read(o)).toEqual({
      "steam.appIdEnv": { appId: "3166810", clientLaunch: true },
    });
    expect(detect(o)).toMatchObject({ kind: "steam", confidence: "heuristic" });
    expect(detect({ env: { SteamAppId: "480" } }).kind).toBe("direct");
  });
  it("the nearest .itch/receipt.json.gz names itch by game.id; ITCHIO_APP is diagnostic", () => {
    const receipt = gzipSync(
      Buffer.from(JSON.stringify({ game: { id: 1001 }, upload: { id: 2002 } })),
    );
    const o = {
      execPath: "/home/a/itch/apps/diceroll/bin/diceroll",
      isSea: true,
      env: { ITCHIO_APP: "1" },
      fs: fakeFs({
        "/home/a/itch/apps/diceroll/.itch/receipt.json.gz": receipt,
      }),
    };
    expect(read(o)).toEqual({ "itch.receipt": "1001", "itch.appEnv": true });
    expect(detect(o)).toMatchObject({
      kind: "itch",
      confidence: "declared",
      source: "itch.receipt",
    });
    expect(detect({ env: { ITCHIO_APP: "1" } }).kind).toBe("direct");
  });
});

describe("readOutletSignals — Node package managers", () => {
  it("npx, pnpm and npm, matched against the product's package name", () => {
    const npx = "/home/a/.npm/_npx/9f/node_modules/@acme/diceroll/bin/cli.js";
    expect(
      read({
        scriptPath: npx,
        packageName: "@acme/diceroll",
        env: { npm_config_user_agent: "npm/10.9.2 node/v22.13.1" },
      }),
    ).toEqual({
      "node.packageManager": { manager: "npx", packageMatch: true },
    });
    expect(
      detect({
        scriptPath: npx,
        packageName: "@acme/diceroll",
        env: { npm_config_user_agent: "npm/10.9.2" },
      }),
    ).toEqual({
      kind: "direct",
      confidence: "heuristic",
      source: "node.packageManager",
      subkind: "npx",
    });
    const local = "/w/node_modules/@acme/diceroll/bin/cli.js";
    expect(
      read({
        scriptPath: local,
        packageName: "@acme/diceroll",
        env: { npm_config_user_agent: "pnpm/11.22.0 npm/? node/v26.0.0" },
      })["node.packageManager"],
    ).toEqual({ manager: "pnpm", packageMatch: true });
    expect(
      read({
        scriptPath: local,
        packageName: "other",
        env: { npm_config_user_agent: "npm/10.9.2" },
      })["node.packageManager"],
    ).toEqual({ manager: "npm", packageMatch: false });
    // No package manager, a SEA, or an Electron app: nothing.
    expect(read({ scriptPath: local, packageName: "@acme/diceroll" })).toEqual(
      {},
    );
    expect(
      read({
        scriptPath: npx,
        isSea: true,
        env: { npm_config_user_agent: "npm/1" },
      }),
    ).toEqual({});
  });
  it("no stamp: heuristic and declared evidence never selects", () => {
    expect(detect({ env: { SteamAppId: "3166810" } }, null).kind).toBe(
      "unknown",
    );
  });
});

// ── The update client: the detected outlet is the default ────────────────────────────────

describe("UpdateClient — outlet detection is the default outlet", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pkey-outlet-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_100 * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const client = async (
    update: UpdateClientOptions,
    fetchImpl?: typeof fetch,
  ) =>
    PolarisKeyClient.create({
      productSlug: PRODUCT,
      baseUrl: BASE,
      version: "1.4.0",
      trust: { pinnedKeys: PINS },
      store: new FileStore(PRODUCT, dir),
      fetchImpl: fetchImpl ?? fakeWorker({}).fetch,
      requestTimeoutMs: 0,
      expectedServices: [...V4_SERVICES] as never,
      update,
    });
  const base = {
    pinnedReleaseKeys: RELEASE_KEYS,
    platform: "macos",
    arch: "arm64",
  } as const;
  const steamEnv: OutletReaderEnvironment = {
    env: { SteamAppId: "3166810" },
    isSea: true,
    electron: null,
    fs: fakeFs(),
  };

  it("detects when the host names no outlet, and decide() uses the result", async () => {
    const recordJws = await signRecord(recordPayload());
    const hash = await recordHash(recordJws);
    const feedJws = await signFeed(
      feedPayload({
        channel: "stable",
        seq: 7,
        issuedAt: 1_700_000_000,
        sha256: hash,
      }),
    );
    const worker = () =>
      fakeWorker({ feeds: () => feedJws, records: { [hash]: recordJws } })
        .fetch;

    // The stamp alone (an empty install): direct, so the direct build is offered.
    const plain = await client(
      {
        ...base,
        stamp: STAMP,
        outletEnvironment: {
          env: {},
          isSea: true,
          electron: null,
          fs: fakeFs(),
        },
      },
      worker(),
    );
    expect(plain.update.detected).toEqual({
      kind: "direct",
      confidence: "stamp",
      source: "stamp",
      subkind: null,
    });
    expect(plain.update.outlet).toEqual({
      id: "direct",
      kind: "direct",
      subkind: null,
    });
    expect((await plain.update.decide()).decision.action).toBe("binary");
    plain.close();

    // Steam's environment names this app: steam, which the feed has no entry for.
    const steam = await client(
      { ...base, stamp: STAMP, outletEnvironment: steamEnv },
      worker(),
    );
    expect(steam.update.detected).toMatchObject({
      kind: "steam",
      source: "steam.appIdEnv",
    });
    expect(steam.update.outlet).toEqual({
      id: null,
      kind: "steam",
      subkind: null,
    });
    expect((await steam.update.decide()).decision).toMatchObject({
      action: "none",
      reason: "not-available",
    });
    steam.close();
  });

  it("the host's outlet always wins, and nothing is detected", async () => {
    const c = await client({
      ...base,
      outlet: "direct",
      stamp: STAMP,
      outletEnvironment: steamEnv,
    });
    expect(c.update.detected).toBeNull();
    expect(c.update.outlet).toEqual({
      id: "direct",
      kind: "direct",
      subkind: null,
    });
    c.close();
  });

  it("a host detection result is used as given; detect: false leaves the stamp", async () => {
    const given = await client({
      ...base,
      stamp: STAMP,
      detected: {
        kind: "itch",
        confidence: "declared",
        source: "itch.receipt",
        subkind: null,
      },
      outletEnvironment: steamEnv,
    });
    expect(given.update.outlet).toEqual({
      id: null,
      kind: "itch",
      subkind: null,
    });
    given.close();
    const off = await client({
      ...base,
      stamp: STAMP,
      detect: false,
      outletEnvironment: steamEnv,
    });
    expect(off.update.detected).toBeNull();
    expect(off.update.outlet).toEqual({
      id: "direct",
      kind: "direct",
      subkind: null,
    });
    off.close();
  });

  it("no stamp and no attested evidence is unknown", async () => {
    const c = await client({ ...base, outletEnvironment: steamEnv });
    expect(c.update.outlet).toEqual({
      id: null,
      kind: "unknown",
      subkind: null,
    });
    c.close();
  });

  it("refuses a non-boolean detect or a non-string packageName (invalid-options)", async () => {
    await expect(
      client({ ...base, detect: "yes" as never }),
    ).rejects.toMatchObject({ code: "invalid-options" });
    await expect(
      client({ ...base, packageName: 5 as never }),
    ).rejects.toMatchObject({ code: "invalid-options" });
  });
});

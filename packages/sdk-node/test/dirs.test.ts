// @pkey-feature core.store
// Platform directories (P1b-09 plan §5.4): each OS's table, the XDG edge cases, the legacy
// config base equal to today's, and the never-throwing backup-exclusion helper.

import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CACHEDIR_TAG_SIGNATURE,
  defaultDirBases,
  excludeFromBackup,
  resolveDirs,
} from "../src/core/dirs.js";
import { CoreContext } from "../src/core/context.js";
import { InMemoryStore } from "../src/core/store.js";

describe("resolveDirs — the per-OS table", () => {
  it("Linux: XDG data/cache/state under a polaris-key segment; config unchanged", () => {
    expect(
      resolveDirs(
        "djdl",
        {},
        { platform: "linux", env: {}, home: "/home/ada" },
      ),
    ).toEqual({
      config: "/home/ada/.config/djdl",
      data: "/home/ada/.local/share/polaris-key/djdl",
      cache: "/home/ada/.cache/polaris-key/djdl",
      state: "/home/ada/.local/state/polaris-key/djdl",
    });
  });

  it("Linux: absolute XDG variables are honoured", () => {
    expect(
      resolveDirs(
        "djdl",
        {},
        {
          platform: "linux",
          home: "/home/ada",
          env: {
            XDG_CONFIG_HOME: "/x/config",
            XDG_DATA_HOME: "/x/data",
            XDG_CACHE_HOME: "/x/cache",
            XDG_STATE_HOME: "/x/state",
          },
        },
      ),
    ).toEqual({
      config: "/x/config/djdl",
      data: "/x/data/polaris-key/djdl",
      cache: "/x/cache/polaris-key/djdl",
      state: "/x/state/polaris-key/djdl",
    });
  });

  it("Linux: empty or relative XDG variables are ignored (the XDG spec)", () => {
    const dirs = resolveDirs(
      "djdl",
      {},
      {
        platform: "linux",
        home: "/home/ada",
        env: {
          XDG_CONFIG_HOME: "",
          XDG_DATA_HOME: "relative/data",
          XDG_CACHE_HOME: "",
          XDG_STATE_HOME: "./state",
        },
      },
    );
    // The one config change: an EMPTY XDG_CONFIG_HOME is ~/.config, not ./<product>.
    expect(dirs.config).toBe("/home/ada/.config/djdl");
    expect(dirs.data).toBe("/home/ada/.local/share/polaris-key/djdl");
    expect(dirs.cache).toBe("/home/ada/.cache/polaris-key/djdl");
    expect(dirs.state).toBe("/home/ada/.local/state/polaris-key/djdl");
  });

  it("macOS: Application Support and Caches; config stays ~/.config; XDG ignored except config", () => {
    expect(
      resolveDirs(
        "djdl",
        {},
        {
          platform: "darwin",
          home: "/Users/ada",
          env: { XDG_DATA_HOME: "/x/data", XDG_CACHE_HOME: "/x/cache" },
        },
      ),
    ).toEqual({
      config: "/Users/ada/.config/djdl",
      data: "/Users/ada/Library/Application Support/polaris-key/data/djdl",
      cache: "/Users/ada/Library/Caches/polaris-key/djdl",
      state: "/Users/ada/Library/Application Support/polaris-key/state/djdl",
    });
  });

  it("Windows: %LOCALAPPDATA%\\polaris-key\\<type>; config stays ~\\.config", () => {
    expect(
      resolveDirs(
        "djdl",
        {},
        {
          platform: "win32",
          home: "C:\\Users\\ada",
          env: {
            LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
            XDG_DATA_HOME: "/x/data",
          },
        },
      ),
    ).toEqual({
      config: "C:\\Users\\ada\\.config\\djdl",
      data: "C:\\Users\\ada\\AppData\\Local\\polaris-key\\data\\djdl",
      cache: "C:\\Users\\ada\\AppData\\Local\\polaris-key\\cache\\djdl",
      state: "C:\\Users\\ada\\AppData\\Local\\polaris-key\\state\\djdl",
    });
  });

  it("Windows: a missing %LOCALAPPDATA% falls back to ~\\AppData\\Local", () => {
    expect(
      defaultDirBases({ platform: "win32", home: "C:\\Users\\ada", env: {} })
        .data,
    ).toBe("C:\\Users\\ada\\AppData\\Local\\polaris-key\\data");
  });

  it("overrides are BASES: the product slug is appended, like configDir", () => {
    expect(
      resolveDirs(
        "djdl",
        {
          configDir: "/o/config",
          dataDir: "/o/data",
          cacheDir: "/o/cache",
          stateDir: "/o/state",
        },
        { platform: "linux", env: {}, home: "/home/ada" },
      ),
    ).toEqual({
      config: "/o/config/djdl",
      data: "/o/data/djdl",
      cache: "/o/cache/djdl",
      state: "/o/state/djdl",
    });
  });

  it("the legacy config base equals today's on every OS", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const home = platform === "win32" ? "C:\\Users\\ada" : "/home/ada";
      const sep = platform === "win32" ? "\\" : "/";
      expect(defaultDirBases({ platform, env: {}, home }).config).toBe(
        `${home}${sep}.config`,
      );
      expect(
        defaultDirBases({ platform, env: { XDG_CONFIG_HOME: "/xdg" }, home })
          .config,
      ).toBe("/xdg");
    }
  });

  it("CoreContext exposes dirs and creates nothing", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pkey-dirs-")));
    const core = new CoreContext({
      productSlug: "djdl",
      version: "1.0.0",
      trust: { pinnedKeys: {} },
      store: new InMemoryStore("djdl"),
      configDir: join(base, "config"),
      dataDir: join(base, "data"),
      cacheDir: join(base, "cache"),
      stateDir: join(base, "state"),
    });
    expect(core.dirs).toEqual({
      config: join(base, "config", "djdl"),
      data: join(base, "data", "djdl"),
      cache: join(base, "cache", "djdl"),
      state: join(base, "state", "djdl"),
    });
    for (const dir of Object.values(core.dirs))
      expect(existsSync(dir)).toBe(false);
  });
});

describe("excludeFromBackup — never throws", () => {
  it("POSIX: writes a CACHEDIR.TAG; an existing tag is fine", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pkey-tag-")));
    const ran: string[][] = [];
    const host = {
      platform: "linux" as const,
      run: (cmd: string, args: string[]) => void ran.push([cmd, ...args]),
    };
    expect(excludeFromBackup(dir, host)).toBe("excluded");
    expect(
      readFileSync(join(dir, "CACHEDIR.TAG"), "utf8").startsWith(
        CACHEDIR_TAG_SIGNATURE,
      ),
    ).toBe(true);
    expect(excludeFromBackup(dir, host)).toBe("excluded");
    expect(ran).toEqual([]); // no tmutil off Apple
  });

  it("macOS: also runs tmutil addexclusion", () => {
    const ran: string[][] = [];
    const written: string[] = [];
    expect(
      excludeFromBackup(
        "/Users/ada/Library/Application Support/polaris-key/data/djdl",
        {
          platform: "darwin",
          run: (cmd, args) => void ran.push([cmd, ...args]),
          writeFile: (path) => void written.push(path),
        },
      ),
    ).toBe("excluded");
    expect(ran).toEqual([
      [
        "/usr/bin/tmutil",
        "addexclusion",
        "/Users/ada/Library/Application Support/polaris-key/data/djdl",
      ],
    ]);
    expect(written[0]).toMatch(/CACHEDIR\.TAG$/);
  });

  it("Windows is not-applicable", () => {
    expect(excludeFromBackup("C:\\x", { platform: "win32" })).toBe(
      "not-applicable",
    );
  });

  it("a failing step is `failed`, not a throw", () => {
    expect(
      excludeFromBackup("/nope", {
        platform: "darwin",
        writeFile: () => undefined,
        run: () => {
          throw new Error("tmutil: permission denied");
        },
      }),
    ).toBe("failed");
    expect(
      excludeFromBackup("/does/not/exist/anywhere", { platform: "linux" }),
    ).toBe("failed");
  });
});

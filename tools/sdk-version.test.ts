/**
 * F-10 automation — the lockstep SDK version (tools/sdk-version.mjs): derived from the ref and git,
 * stamped into every SDK, never chosen by hand.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveVersion,
  gitDescribe,
  nextVersion,
  publicPackageJsons,
  STAMP_TARGETS,
  stampText,
  stampVersions,
  toPep440,
} from "./sdk-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "sdk-version-"));
  temps.push(d);
  return d;
}

describe("deriveVersion: a release tag", () => {
  it("publishes every SDK at exactly the tag's version, stable", () => {
    expect(
      deriveVersion({ ref: "refs/tags/v0.9.0", latestTag: null, distance: 0 }),
    ).toEqual({
      kind: "release",
      version: "0.9.0",
      pep440: "0.9.0",
      channel: "stable",
      npmTag: "latest",
    });
  });

  it.each([
    ["v1.0.0-rc.1", "1.0.0-rc.1", "1.0.0rc1"],
    ["v1.0.0-beta.2", "1.0.0-beta.2", "1.0.0b2"],
    ["v1.0.0-alpha.0", "1.0.0-alpha.0", "1.0.0a0"],
    ["v2.3.4-b.7", "2.3.4-b.7", "2.3.4b7"],
  ])(
    "a prerelease tag %s is %s (PyPI %s) on the beta channel",
    (tag, v, py) => {
      expect(
        deriveVersion({
          ref: `refs/tags/${tag}`,
          latestTag: null,
          distance: 3,
        }),
      ).toEqual({
        kind: "release",
        version: v,
        pep440: py,
        channel: "beta",
        npmTag: "beta",
      });
    },
  );

  it.each([
    "refs/tags/1.0.0",
    "refs/tags/v1.0",
    "refs/tags/v01.0.0",
    "refs/tags/godot-v1.0.0",
    "refs/tags/@polaris-key/node@1.0.0",
    "refs/tags/v1.0.0-preview.1",
    "refs/tags/v1.0.0-rc1",
    "refs/tags/v1.0.0+build.5",
  ])("refuses %s", (ref) => {
    expect(() =>
      deriveVersion({ ref, latestTag: null, distance: 0 }),
    ).toThrow();
  });
});

describe("deriveVersion: a push to main", () => {
  it("is a prerelease of the patch after a stable tag, numbered by commits since it", () => {
    expect(
      deriveVersion({
        ref: "refs/heads/main",
        latestTag: "v0.8.12",
        distance: 7,
      }),
    ).toEqual({
      kind: "main",
      version: "0.8.13-main.7",
      pep440: "0.8.13.dev7",
      channel: "main",
      npmTag: "main",
    });
  });

  it("is a prerelease of the version a prerelease tag heads for", () => {
    expect(
      deriveVersion({
        ref: "refs/heads/main",
        latestTag: "v1.5.0-rc.1",
        distance: 2,
      }).version,
    ).toBe("1.5.0-main.2");
  });

  it("starts from 0.0.1 with no tag at all", () => {
    expect(
      deriveVersion({ ref: "refs/heads/main", latestTag: null, distance: 40 }),
    ).toMatchObject({ version: "0.0.1-main.40", pep440: "0.0.1.dev40" });
  });

  it("the tagged commit itself is main.0", () => {
    expect(
      deriveVersion({
        ref: "refs/heads/main",
        latestTag: "v0.9.0",
        distance: 0,
      }).version,
    ).toBe("0.9.1-main.0");
  });

  it("orders after the tag it follows and before the release it heads for (semver and PEP 440)", () => {
    // semver: 0.8.12 < 0.8.13-main.7 < 0.8.13 (a prerelease sorts below its release).
    // PEP 440: 0.8.12 < 0.8.13.dev7 < 0.8.13 (a dev release sorts below its release).
    const v = deriveVersion({
      ref: "refs/heads/main",
      latestTag: "v0.8.12",
      distance: 7,
    });
    expect(v.version.startsWith("0.8.13-")).toBe(true);
    expect(v.pep440).toMatch(/^0\.8\.13\.dev\d+$/);
  });

  it.each(["refs/heads/feature", "refs/pull/1/merge", "refs/heads/main2"])(
    "refuses any other ref (%s)",
    (ref) => {
      expect(() =>
        deriveVersion({ ref, latestTag: "v1.0.0", distance: 1 }),
      ).toThrow(/main and from v\* release tags only/);
    },
  );

  it("refuses a negative distance", () => {
    expect(() =>
      deriveVersion({ ref: "refs/heads/main", latestTag: null, distance: -1 }),
    ).toThrow();
  });
});

describe("nextVersion and toPep440", () => {
  it("bumps the patch after a stable tag", () => {
    expect(nextVersion("v0.8.12")).toBe("0.8.13");
    expect(nextVersion("v1.9.9")).toBe("1.9.10");
  });
  it("maps the main prerelease to a dev release", () => {
    expect(toPep440("1.2.3-main.4")).toBe("1.2.3.dev4");
  });
  it("refuses a suffix PyPI cannot carry", () => {
    expect(() => toPep440("1.2.3-preview.1")).toThrow(
      /alpha.N, -beta.N or -rc.N/,
    );
  });
});

describe("gitDescribe", () => {
  function repo(): string {
    const d = temp();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: d, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "t");
    const commit = (n: number) => {
      writeFileSync(join(d, "f"), String(n));
      git("add", "f");
      git("commit", "-q", "-m", `c${n}`);
    };
    commit(1);
    commit(2);
    git("tag", "v0.8.12");
    git("tag", "godot-v9.9.9"); // a legacy tag is never a release tag
    commit(3);
    commit(4);
    commit(5);
    return d;
  }

  it("finds the newest release tag and counts the commits since it", () => {
    const d = repo();
    expect(gitDescribe(d)).toEqual({ latestTag: "v0.8.12", distance: 3 });
  });

  it("ignores a malformed nearer tag and takes the highest strict reachable tag", () => {
    const d = repo();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: d, stdio: "ignore" });
    git("tag", "v0.8.13-rc.1");
    writeFileSync(join(d, "f"), "6");
    git("commit", "-q", "-am", "c6");
    git("tag", "v0.8.13-weird"); // nearest by describe, not a deployable tag
    git("tag", "v0.8.99x");
    expect(gitDescribe(d)).toEqual({ latestTag: "v0.8.13-rc.1", distance: 1 });
  });

  it("counts every commit when there is no release tag", () => {
    const d = temp();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@e",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "a",
      ],
      { cwd: d },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@e",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "b",
      ],
      { cwd: d },
    );
    expect(gitDescribe(d)).toEqual({ latestTag: null, distance: 2 });
  });
});

describe("stamping", () => {
  it("every stamp target holds exactly one version line in the committed tree", () => {
    for (const t of STAMP_TARGETS) {
      const text = readFileSync(join(ROOT, t.file), "utf8");
      expect(
        () => stampText(text, t.pattern, "9.9.9", t.file),
        t.file,
      ).not.toThrow();
    }
  });

  it("the npm packages are every public @polaris-key package", () => {
    const files = publicPackageJsons(ROOT);
    expect(files).toContain("packages/sdk-node/package.json");
    expect(files).toContain("packages/cli/package.json");
    expect(files).not.toContain("packages/worker/package.json");
    expect(files).not.toContain("packages/admin/package.json");
    expect(files).toContain("packages/ui-core/package.json");
    expect(files).toHaveLength(11);
  });

  it("writes one version into every SDK, PEP 440 for Python, and leaves everything else", () => {
    const root = temp();
    for (const t of STAMP_TARGETS) {
      mkdirSync(dirname(join(root, t.file)), { recursive: true });
      cpSync(join(ROOT, t.file), join(root, t.file));
    }
    for (const f of [
      ...publicPackageJsons(ROOT),
      "packages/worker/package.json",
    ]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      cpSync(join(ROOT, f), join(root, f));
    }
    const written = stampVersions(root, {
      version: "0.8.13-main.7",
      pep440: "0.8.13.dev7",
    });
    expect(written).toHaveLength(STAMP_TARGETS.length + 11);
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    expect(read("sdks/python/pyproject.toml")).toMatch(
      /^version = "0\.8\.13\.dev7"$/m,
    );
    expect(read("sdks/swift/Sources/PolarisKeyCore/Models.swift")).toContain(
      'public let POLARIS_SDK_VERSION = "0.8.13-main.7"',
    );
    expect(read("sdks/kotlin/build.gradle.kts")).toMatch(
      /version = "0\.8\.13-main\.7"/,
    );
    expect(read("sdks/godot/addons/polaris_key/plugin.cfg")).toContain(
      'version="0.8.13-main.7"',
    );
    expect(read("sdks/godot/addons/polaris_key/polaris_key.gd")).toContain(
      'const SDK_VERSION := "0.8.13-main.7"',
    );
    expect(read("packages/sdk-react/src/version.ts")).toContain(
      'export const SDK_VERSION = "0.8.13-main.7";',
    );
    const node = JSON.parse(read("packages/sdk-node/package.json")) as {
      version: string;
      dependencies?: Record<string, string>;
    };
    expect(node.version).toBe("0.8.13-main.7");
    // `workspace:*` stays: pnpm pack rewrites it to the stamped version.
    expect(Object.values(node.dependencies ?? {})).toContain("workspace:*");
    expect(
      (JSON.parse(read("packages/worker/package.json")) as { version: string })
        .version,
    ).toBe("0.0.0");
  });

  it("refuses a PEP 440 version that is not the semver one's", () => {
    expect(() =>
      stampVersions(temp(), { version: "1.0.0", pep440: "1.0.1" }),
    ).toThrow(/PEP 440/);
  });

  it("refuses a file whose version line moved (none, or two)", () => {
    expect(() =>
      stampText(
        'a\nversion="1"\nversion="2"\n',
        /^(version=")[^"]*(")$/m,
        "3",
        "x",
      ),
    ).toThrow(/found 2/);
    expect(() =>
      stampText("nothing here\n", /^(version=")[^"]*(")$/m, "3", "x"),
    ).toThrow(/found 0/);
  });

  it("the CLI derives for a tag without touching git", () => {
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, "tools", "sdk-version.mjs"),
        "derive",
        "--ref",
        "refs/tags/v1.2.3",
      ],
      { encoding: "utf8" },
    );
    expect(out).toBe(
      "kind=release\nversion=1.2.3\npep440=1.2.3\nchannel=stable\nnpm_tag=latest\n",
    );
  });
});

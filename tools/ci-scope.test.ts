/**
 * P0-43: the one CI scope (tools/ci-scope.mjs over tools/ci-scope.json). The `changes` job of
 * ci.yml and `pnpm gate` read it, so these tests pin what a change runs (a rename at both of its paths,
 * a sample or a fixture at the lane that reads it, everything when the changed files cannot be
 * read), that every lane and matrix the workflow names exists here, that the workflow wires each
 * one, that the Swift SDK keeps a build on its oldest toolchain, and that a workflow's path filter
 * covers the local actions its jobs use.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  changedFiles,
  ciOutputs,
  loadScope,
  matrixFor,
  selectLanes,
} from "./ci-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "tools", "ci-scope.mjs");
const scope = loadScope();

interface Step {
  uses?: string;
  run?: string;
  if?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "continue-on-error"?: boolean;
  "runs-on"?: string;
  outputs?: Record<string, string>;
  strategy?: { matrix?: unknown };
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { paths?: string[] } | null | undefined>;
  jobs: Record<string, Job>;
}
const WORKFLOWS = join(ROOT, ".github", "workflows");
const workflow = (file: string) =>
  parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
const ci = workflow("ci.yml");

const on = (files: string[] | null) =>
  Object.entries(selectLanes(scope, files))
    .filter(([, v]) => v)
    .map(([k]) => k);

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

/**
 * A scratch repository whose `main` holds `files`. Its git reads no user or system configuration
 * (a global hooks path or commit signing would otherwise run in it).
 */
function repo(files: Record<string, string>) {
  const dir = temp("ci-scope-");
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  /** `git mv`, which needs the destination's directory to exist. */
  const move = (from: string, to: string) => {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    git("mv", from, to);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git, write, move };
}

/** `node tools/ci-scope.mjs <args>` run inside `cwd`, the way ci.yml and `pnpm gate` run it. */
const cli = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

/** The `key=value` lines `ci` prints after its summary line. */
const outputsOf = (stdout: string) =>
  Object.fromEntries(
    stdout
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  ) as Record<string, string>;

describe("lane selection", () => {
  it("runs the Swift lanes, and nothing else, for a Swift source change", () => {
    expect(on(["sdks/swift/Sources/PolarisKeyCore/Client.swift"])).toEqual([
      "swift",
      "swift-floor",
    ]);
  });

  it("keeps the Swift floor to the package: the Godot addon, the CLI and the kit lint need only the Apple job", () => {
    for (const file of [
      "sdks/godot/native/ios/build.sh",
      "packages/cli/src/index.ts",
      "packages/ui-qa/rules/kit-rules.json",
    ]) {
      expect(on([file]), file).toContain("swift");
      expect(on([file]), file).not.toContain("swift-floor");
    }
  });

  it("runs the kit lint lane for a kit's UI sources", () => {
    expect(on(["sdks/kotlin/ui/src/androidMain/kotlin/A.kt"])).toEqual([
      "ui-kits",
      "compose-desktop",
      "kotlin",
      "android",
    ]);
  });

  it("runs the android lane for the Compose Android sample", () => {
    expect(
      on(["examples/ui/compose-android/src/main/AndroidManifest.xml"]),
    ).toContain("android");
  });

  it("runs the recipes lane for a recipe, the elements, the view models and the lint, and no kit lane for a recipe", () => {
    expect(on(["examples/ui/recipes/vue/src/App.vue"])).toEqual(["ui-recipes"]);
    for (const file of [
      "packages/elements/src/index.ts",
      "packages/ui-core/src/index.ts",
      "packages/ui-qa/src/lint.ts",
    ]) {
      expect(on([file]), file).toContain("ui-recipes");
    }
  });

  it("runs nothing for a change no lane reads", () => {
    expect(on(["README.md", "docs/RUNBOOK.md"])).toEqual(["docs"]);
    expect(on(["examples/node-cli/README.md"])).toEqual([]);
  });

  // What a lane's tests open outside its own tree triggers that lane: the Python suite runs the
  // three Python samples, compares its QR encoder with the Godot suite's reference fixtures and
  // its terminal kit with the text the Node kit recorded.
  it.each([
    "examples/python-cli/mytool.py",
    "examples/python-renpy/polaris_key.rpy",
    "examples/ui/terminal-python/tidewater.py",
    "examples/ui/terminal-python/tidewater_fixtures.py",
    "sdks/godot/tests/qr/fixtures.json",
    "docs/design/ui-kits/terminal-parity.json",
  ])("runs the python lane for %s, which its tests read", (file) => {
    expect(existsSync(join(ROOT, file)), `${file} exists`).toBe(true);
    expect(on([file])).toContain("python");
  });

  it("keeps the Python lane off the other samples", () => {
    expect(on(["examples/ui/terminal-node/README.md"])).not.toContain("python");
    expect(on(["examples/node-cli/README.md"])).not.toContain("python");
  });

  it("still runs the Godot lanes for the QR fixtures, and the kit lint for the terminal text", () => {
    expect(on(["sdks/godot/tests/qr/fixtures.json"])).toContain("godot");
    expect(on(["docs/design/ui-kits/terminal-parity.json"])).toEqual(
      expect.arrayContaining(["ui-kits", "docs"]),
    );
  });

  it.each([
    "conformance/corpus/v2/cases.json",
    "packages/shared-protocol/src/index.ts",
    "packages/client-core/src/index.ts",
    "packages/brand/tokens.json",
    "tools/gen.ts",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
  ])("runs every lane for the shared input %s", (file) => {
    expect(on([file])).toEqual(Object.keys(scope.lanes));
  });

  it("runs every lane when the changed files are unknown", () => {
    expect(on(null)).toEqual(Object.keys(scope.lanes));
  });

  it("names every path it lists as a repository directory or file prefix", () => {
    const all = [
      ...scope.shared,
      ...Object.values(scope.lanes).flatMap((l) => l.paths),
    ];
    for (const p of all) expect(p).not.toMatch(/^\/|\*/);
  });
});

describe("the changes job outputs", () => {
  it("narrows a pull request to its lanes and the PR matrices", () => {
    const out = ciOutputs(scope, {
      event: "pull_request",
      files: ["sdks/python/src/polaris_key/a.py"],
    });
    expect(out.python).toBe("true");
    expect(out.swift).toBe("false");
    expect(out.full).toBe("false");
    expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(2);
    expect(JSON.parse(out["kotlin-desktop-matrix"]!).os).toEqual([
      "ubuntu-latest",
    ]);
  });

  it.each(["push", "workflow_dispatch", "schedule"])(
    "runs every lane and the full matrices on %s",
    (event) => {
      const out = ciOutputs(scope, { event, files: ["README.md"] });
      for (const lane of Object.keys(scope.lanes))
        expect(out[lane], lane).toBe("true");
      expect(out.full).toBe("true");
      expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(3);
      expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(6);
    },
  );

  it("runs everything on the full matrices for a pull request whose changed files cannot be read", () => {
    const out = ciOutputs(scope, { event: "pull_request", files: null });
    // Exactly what a push to main gets: every lane, every matrix in its full shape.
    expect(out).toEqual(ciOutputs(scope, { event: "push", files: null }));
    expect(out.full).toBe("true");
    for (const lane of Object.keys(scope.lanes))
      expect(out[lane], lane).toBe("true");
    expect(JSON.parse(out["python-matrix"]!).include).toContainEqual({
      os: "macos-14",
      python: "3.12",
    });
    expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(6);
    expect(JSON.parse(out["kotlin-desktop-matrix"]!).os).toHaveLength(3);
    expect(JSON.parse(out["kotlin-emulator-matrix"]!)["api-level"]).toEqual([
      24, 34, 36,
    ]);
  });

  it("keeps the floor and the latest of each pull-request matrix inside the full one", () => {
    for (const name of Object.keys(scope.matrices)) {
      const pr = JSON.stringify(matrixFor(scope, name, true));
      const main = JSON.stringify(matrixFor(scope, name, false));
      expect(pr, name).not.toBe(main);
      const asSet = (v: string) =>
        JSON.stringify(
          Object.entries(JSON.parse(v)).map(([k, a]) => [
            k,
            (a as unknown[]).map((x) => JSON.stringify(x)),
          ]),
        );
      const prM = JSON.parse(asSet(pr)) as [string, string[]][];
      const mainM = Object.fromEntries(
        JSON.parse(asSet(main)) as [string, string[]][],
      );
      for (const [k, vals] of prM)
        for (const v of vals) expect(mainM[k], `${name}.${k}`).toContain(v);
    }
  });
});

describe("the changed files", () => {
  const swift = "sdks/swift/Sources/PolarisKeyCore/CoreContext.swift";
  const moved = "examples/swift/CoreContext.swift";
  const body = "struct CoreContext {}\n";

  it("names both paths of a file moved out of a lane's tree", () => {
    const r = repo({ [swift]: body, "README.md": "# r\n" });
    r.git("checkout", "-q", "-b", "feature");
    r.move(swift, moved);
    r.git("commit", "-q", "-m", "move");
    // The premise: git's own listing keeps only a rename's destination.
    expect(r.git("diff", "--name-only", "main...feature").trim()).toBe(moved);
    const files = changedFiles({ base: "main", head: "feature", cwd: r.dir });
    expect(files?.sort()).toEqual([moved, swift]);
    expect(selectLanes(scope, files).swift).toBe(true);
    expect(selectLanes(scope, files)["swift-floor"]).toBe(true);
  });

  it("names both paths of a rename that is not committed yet", () => {
    const r = repo({ [swift]: body });
    r.move(swift, moved);
    expect(changedFiles({ base: "main", cwd: r.dir })).toEqual([]);
    const files = changedFiles({ base: "main", worktree: true, cwd: r.dir });
    expect(files?.sort()).toEqual([moved, swift]);
    expect(selectLanes(scope, files).swift).toBe(true);
  });

  it("reports a path with non-ASCII characters as written, not C-quoted", () => {
    const named = "sdks/swift/Sources/PolarisKeyCore/Ünï.swift";
    const r = repo({ "README.md": "# r\n" });
    r.git("checkout", "-q", "-b", "feature");
    r.write(named, "struct Ünï {}\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "add");
    // Without -z git prints "sdks/swift/Sources/PolarisKeyCore/\303\234n\303\257.swift", quotes
    // included, which no lane prefix matches.
    const files = changedFiles({ base: "main", head: "feature", cwd: r.dir });
    expect(files).toEqual([named]);
    expect(selectLanes(scope, files).swift).toBe(true);
  });

  it("answers null when git cannot say", () => {
    const r = repo({ "README.md": "# r\n" });
    expect(changedFiles({ base: "origin/missing", cwd: r.dir })).toBeNull();
  });
});

describe("the ci-scope command", () => {
  const swift = "sdks/swift/Sources/PolarisKeyCore/CoreContext.swift";
  const moved = "examples/swift/CoreContext.swift";

  it("scopes a rename-only pull request to the lane that lost the file", () => {
    const r = repo({ [swift]: "struct CoreContext {}\n" });
    r.git("checkout", "-q", "-b", "feature");
    r.move(swift, moved);
    r.git("commit", "-q", "-m", "move");
    const run = cli(
      r.dir,
      "ci",
      "--event",
      "pull_request",
      "--base",
      "main",
      "--head",
      "feature",
    );
    expect(run.status, run.stderr).toBe(0);
    const out = outputsOf(run.stdout);
    expect(out.swift).toBe("true");
    expect(out["swift-floor"]).toBe("true");
    expect(out.python).toBe("false");
    expect(out.full).toBe("false");
    expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(2);
  });

  it.each([
    ["a base git cannot find", ["--base", "origin/missing"]],
    ["no base at all", []],
  ])(
    "runs every lane on the full matrices for a pull request with %s",
    (_name, base) => {
      const r = repo({ "README.md": "# r\n" });
      const run = cli(r.dir, "ci", "--event", "pull_request", ...base);
      expect(run.status, run.stderr).toBe(0);
      const out = outputsOf(run.stdout);
      expect(out.full).toBe("true");
      for (const lane of Object.keys(scope.lanes))
        expect(out[lane], lane).toBe("true");
      expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(3);
      expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(6);
      expect(JSON.parse(out["kotlin-desktop-matrix"]!).os).toHaveLength(3);
      expect(JSON.parse(out["kotlin-emulator-matrix"]!)["api-level"]).toEqual([
        24, 34, 36,
      ]);
    },
  );

  it("touches: exits 0 for a lane the change needs, 1 for one it can skip, 0 when git cannot say", () => {
    const r = repo({ [swift]: "struct CoreContext {}\n" });
    r.move(swift, moved);
    const touches = (lane: string, base: string) =>
      cli(r.dir, "touches", lane, "--base", base, "--worktree").status;
    expect(touches("swift", "main")).toBe(0);
    expect(touches("python", "main")).toBe(1);
    expect(touches("python", "origin/missing")).toBe(0);
  });
});

describe("ci.yml reads the scope", () => {
  const jobs = ci.jobs;
  const needsOf = (j: Job) => [j.needs ?? []].flat();

  it("has a changes job that every scoped job needs", () => {
    expect(jobs.changes).toBeDefined();
    for (const lane of Object.keys(scope.lanes)) {
      // A lane gates a whole job (`if:`) or a step of one (the docs link check in `js`).
      const owner = Object.entries(jobs).filter(([, j]) =>
        JSON.stringify(j).includes(`needs.changes.outputs.${lane} ==`),
      );
      expect(Object.keys(jobs.changes!.outputs ?? {}), lane).toContain(lane);
      expect(owner.length, `a job gated on lane ${lane}`).toBeGreaterThan(0);
      for (const [id, j] of owner) expect(needsOf(j), id).toContain("changes");
    }
  });

  it("feeds each matrix from the changes job", () => {
    for (const name of Object.keys(scope.matrices)) {
      const text = JSON.stringify(
        Object.values(jobs).map((j) => j.strategy?.matrix ?? null),
      );
      expect(text, name).toContain(`needs.changes.outputs.${name}-matrix`);
    }
  });

  it("aggregates every other job in ci-ok, which runs always", () => {
    const ok = jobs["ci-ok"]!;
    expect(ok.if).toBe("${{ always() }}");
    const others = Object.keys(jobs).filter(
      (id) =>
        id !== "ci-ok" && id !== "swiftui-mac" && id !== "compose-desktop",
    ); // swiftui-mac and compose-desktop are non-blocking until their baselines are committed (UK-08.8, UK-10.12);
    expect(needsOf(ok).sort()).toEqual(others.sort());
  });
});

// The old `swift` job built the package with the macos-15 runner's Xcode 16.4 (Swift 6.1); `apple`
// pins Xcode 26.6 and so compiles only the `#if compiler(>=6.3)` branch of PolarisKeyPlatform. The
// floor job keeps the pre-6.3 branch compiling, which no other job does.
describe("ci.yml keeps the Swift SDK building on its oldest toolchain", () => {
  const GUARD = "sdks/swift/tools/select-xcode-16.sh";
  const floor = ci.jobs["swift-floor"]!;
  const apple = ci.jobs.apple!;
  const runs = (floor.steps ?? []).map((s) => s.run ?? "");

  it("is a macos-15 job on its own lane, and CI OK waits for it", () => {
    expect(floor).toBeDefined();
    expect(floor["runs-on"]).toBe("macos-15");
    expect(floor.if).toBe("needs.changes.outputs.swift-floor == 'true'");
    expect([floor.needs ?? []].flat()).toContain("changes");
    expect([ci.jobs["ci-ok"]!.needs ?? []].flat()).toContain("swift-floor");
  });

  it("selects Xcode 16.4 before it builds, and leaves Xcode 26.6 to the Apple job", () => {
    const select = runs.indexOf(GUARD);
    const build = runs.findIndex((r) => /swift build|xcodebuild/.test(r));
    expect(select, "the Xcode 16.4 guard step").toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(build);
    expect(runs.join("\n")).not.toContain("select-xcode-26");
    expect(
      (apple.steps ?? []).some(
        (s) => s.run === "sdks/swift/tools/select-xcode-26.sh",
      ),
    ).toBe(true);
    expect(apple["runs-on"]).toBe("macos-26");
  });

  it("builds the package for macOS and, for iOS, packs, update, the platform and its C surface", () => {
    expect(runs).toContain("swift build --package-path sdks/swift");
    expect(runs.join("\n")).not.toMatch(/swift test/);
    const ios = runs
      .find((r) => r.includes("generic/platform=iOS"))!
      .replace(/\\\n\s*/g, " ");
    // Which schemes each `for` loop builds, with and without warnings as errors.
    const plain: string[] = [];
    const strict: string[] = [];
    for (const [, schemes, body] of ios.matchAll(
      /for scheme in ([^;]+); do([\s\S]*?)done/g,
    ))
      (body!.includes("SWIFT_TREAT_WARNINGS_AS_ERRORS=YES")
        ? strict
        : plain
      ).push(...schemes!.trim().split(/\s+/));
    expect(plain.sort()).toEqual(["PolarisKeyPacks", "PolarisKeyUpdate"]);
    expect(strict.sort()).toEqual([
      "PolarisKeyPlatform",
      "PolarisKeyPlatformC",
    ]);
  });

  // The guard script runs here against stand-ins for sudo, xcode-select, xcodebuild and swift.
  const guard = (swiftVersion: string) => {
    const bin = temp("xcode16-");
    const calls = join(bin, "calls");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stub("sudo", 'exec "$@"');
    stub("xcode-select", 'echo "xcode-select $*" >> "$STUB_CALLS"');
    stub("xcodebuild", "exit 0");
    stub("swift", 'echo "$STUB_SWIFT"');
    const run = spawnSync("bash", [join(ROOT, GUARD)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        STUB_CALLS: calls,
        STUB_SWIFT: swiftVersion,
      },
    });
    return {
      status: run.status,
      stderr: run.stderr,
      calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    };
  };

  it.each([
    ["Apple Swift version 6.0 (swiftlang-6.0.0.1 clang-1600.0.26.3)", 0],
    ["Apple Swift version 6.1.2 (swiftlang-6.1.2.1.2 clang-1700.0.13.5)", 0],
    ["Apple Swift version 6.2 (swiftlang-6.2.0.19.9 clang-1700.4.4.1)", 0],
    ["Apple Swift version 6.3 (swiftlang-6.3.0.1 clang-1800.0.1)", 1],
    ["Apple Swift version 6.10 (swiftlang-6.10.0.1)", 1],
    ["Apple Swift version 7.0 (swiftlang-7.0.0.1)", 1],
    ["Apple Swift version 5.10 (swiftlang-5.10.0.13 clang-1500.3.9.4)", 1],
    ["Apple Swift version 5.2 (swiftlang-5.2.0.1)", 1],
    ["swift-driver version: 1.120", 1],
  ])("the Xcode 16.4 guard on `%s` exits %i", (version, status) => {
    const run = guard(version);
    expect(run.calls).toContain("xcode-select -s /Applications/Xcode_16.4.app");
    expect(run.status, run.stderr).toBe(status);
    if (status !== 0) expect(run.stderr).toContain("is not 6.0 to 6.2");
  });
});

// A workflow that runs only for some paths has to list the local actions its jobs use: a change to
// one is a change to every job that uses it, and the filter would otherwise skip the workflow.
describe("a workflow's path filter covers the local actions its jobs use", () => {
  const all = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => [f, workflow(f)] as const);
  const filtered = all.filter(([, wf]) =>
    Object.values(wf.on).some((trigger) => trigger?.paths),
  );
  const localActions = (wf: Workflow) => [
    ...new Set(
      Object.values(wf.jobs)
        .flatMap((j) => j.steps ?? [])
        .map(
          (s) => /^\.\/\.github\/actions\/([^/@\s]+)/.exec(s.uses ?? "")?.[1],
        )
        .filter((name): name is string => name !== undefined),
    ),
  ];

  it("finds the native desktop workflow and the composite action it uses", () => {
    const native = filtered.find(([f]) => f === "native-desktop.yml");
    expect(native, "native-desktop.yml has a path filter").toBeDefined();
    expect(localActions(native![1])).toContain("setup-js");
  });

  it.each(filtered.map(([f]) => f))(
    "%s lists each local action under every trigger that filters paths",
    (file) => {
      const wf = workflow(file);
      for (const [event, trigger] of Object.entries(wf.on)) {
        if (!trigger?.paths) continue;
        for (const action of localActions(wf))
          expect(trigger.paths, `${file} on ${event}`).toContain(
            `.github/actions/${action}/**`,
          );
      }
    },
  );
});

// UK-08.8: the SwiftUI kit's macOS renders (macos-26 and macos-15) run only for the kit's own tree,
// the sample and the copy it renders, and CI OK does not wait for them until the baselines are committed.
describe("ci.yml renders the SwiftUI kit on the Mac", () => {
  const job = ci.jobs["swiftui-mac"]!;
  const steps = JSON.stringify(job.steps ?? []);

  it("is its own lane, non-blocking for CI OK", () => {
    expect(job.if).toBe("needs.changes.outputs.swiftui-mac == 'true'");
    expect(job["continue-on-error"]).toBe(true);
    // Non-blocking until the first baselines are committed (UK-08.8).
    expect([ci.jobs["ci-ok"]!.needs ?? []].flat()).not.toContain("swiftui-mac");
    expect(on(["examples/ui/swiftui/run.sh"])).toContain("swiftui-mac");
    expect(
      on(["sdks/swift/Sources/PolarisKeyUpdateUI/Driver.swift"]),
    ).toContain("swiftui-mac");
    expect(
      on(["sdks/swift/Sources/PolarisKeyCore/Client.swift"]),
    ).not.toContain("swiftui-mac");
  });

  it("runs both legs, pins XcodeGen by checksum, and always uploads", () => {
    expect(JSON.stringify(job.strategy)).toContain("macos-26");
    expect(JSON.stringify(job.strategy)).toContain("macos-15");
    expect(JSON.stringify(job.strategy)).toContain("select-xcode-26.sh");
    expect(JSON.stringify(job.strategy)).toContain("select-xcode-16.sh");
    expect(steps).toContain(
      "090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef",
    );
    expect(
      (job.steps ?? []).some(
        (s) => s.if === "always()" && /upload-artifact/.test(s.uses ?? ""),
      ),
    ).toBe(true);
  });
});

// UK-10.12: the Compose desktop kit's lane runs on the three desktop OSes for the kit's own tree and the
// sample, and CI OK does not wait for it until the baselines are committed.
describe("ci.yml runs the Compose desktop kit lane", () => {
  const job = ci.jobs["compose-desktop"]!;
  const steps = JSON.stringify(job.steps ?? []);

  it("is its own lane, non-blocking for CI OK", () => {
    expect(job.if).toBe("needs.changes.outputs.compose-desktop == 'true'");
    expect(job["continue-on-error"]).toBe(true);
    expect([ci.jobs["ci-ok"]!.needs ?? []].flat()).not.toContain(
      "compose-desktop",
    );
    expect(on(["examples/ui/compose-desktop/build.gradle.kts"])).toContain(
      "compose-desktop",
    );
    expect(on(["sdks/kotlin/ui/src/desktopMain/X.kt"])).toContain(
      "compose-desktop",
    );
    expect(on(["sdks/kotlin/core/src/X.kt"])).not.toContain("compose-desktop");
  });

  it("covers three OSes, the Android SDK, xvfb on Linux, and always uploads", () => {
    const m = JSON.stringify(job.strategy);
    for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"])
      expect(m).toContain(os);
    expect(steps).toContain("platforms;android-36");
    expect(steps).toContain("verifyRoborazziDesktop");
    expect(steps).toContain("xvfb-run");
    expect(steps).toContain(":sample-compose-desktop:smoke");
    expect(steps).toContain(":sample-compose-desktop:shots");
    expect(steps).toContain(":ui:desktopTest");
    expect(steps).not.toContain("--daemon ");
    const upload = (job.steps ?? []).find((x) =>
      String(x.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload?.if).toBe("always()");
  });
});

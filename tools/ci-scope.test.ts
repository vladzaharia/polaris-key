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
import { affected, EXTRA_INPUTS, packagesOf } from "./ci-js-affected.mjs";
import {
  changedFiles,
  ciOutputs,
  globMatch,
  greenBasesOf,
  groupOfJob,
  laneBases,
  loadScope,
  matrixFor,
  selectLanes,
  trackedGroups,
  type CiJob,
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
  container?: { image?: string };
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
const nightly = workflow("nightly-advisory.yml");
/** The advisory jobs that run nightly, off the push path (ci.yml has none of them). */
const NIGHTLY_JOBS = [
  "swift-linux",
  "swiftui-mac",
  "compose-desktop",
  "apple-footprint",
];
/** Lanes whose only job lives in nightly-advisory.yml: no `changes` job there, so no ci.yml owner. */
const NIGHTLY_LANES = ["swift-linux", "swiftui-mac", "compose-desktop"];

const on = (files: string[] | null) =>
  Object.entries(selectLanes(scope, files))
    .filter(([, v]) => v)
    .map(([k]) => k);

/** A nightly advisory job never fails the run and CI OK does not wait for it. */
const expectAdvisory = (name: string) => {
  expect(nightly.jobs[name]!["continue-on-error"]).toBe(true);
  expect([ci.jobs["ci-ok"]!.needs ?? []].flat()).not.toContain(name);
};

/** Every lane on, and every matrix in its full shape. */
const expectFullMatrices = (
  out: Record<string, string>,
  lanes: string[] = Object.keys(scope.lanes),
) => {
  for (const lane of lanes) expect(out[lane], lane).toBe("true");
  expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(19);
  expect(JSON.parse(out["kotlin-desktop-matrix"]!).os).toHaveLength(3);
  expect(JSON.parse(out["kotlin-emulator-matrix"]!)["api-level"]).toEqual([
    24, 34, 36,
  ]);
};

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
      "docs-snippets",
      "swift",
      "swift-floor",
      "swift-linux",
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
      "docs-snippets",
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
      expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(19);
    },
  );

  it("runs everything on the full matrices for a pull request whose changed files cannot be read", () => {
    const out = ciOutputs(scope, { event: "pull_request", files: null });
    // Exactly what a push to main gets: every lane, every matrix in its full shape.
    expect(out).toEqual(ciOutputs(scope, { event: "push", files: null }));
    expect(out.full).toBe("true");
    expect(JSON.parse(out["python-matrix"]!).include).toContainEqual({
      os: "macos-15",
      python: "3.12",
    });
    expectFullMatrices(out);
  });

  it("emits the Godot legs a runner can tell apart: unique names, and the UI matrix legs with their path and shard range", () => {
    type Leg = {
      name: string;
      os: string;
      godot: string;
      part?: string;
      ui_paths?: string;
      ui_shards?: string;
      ui_range?: string;
    };
    for (const event of ["push", "pull_request"]) {
      const out = ciOutputs(scope, {
        event,
        files: event === "push" ? null : ["sdks/godot/tests/runner.gd"],
      });
      const legs = JSON.parse(out["godot-matrix"]!).include as Leg[];
      expect(new Set(legs.map((l) => l.name)).size).toBe(legs.length);
      for (const l of legs.filter((x) => x.part === "matrix"))
        expect(
          [l.ui_paths, l.ui_shards, l.ui_range].every(Boolean),
          l.name,
        ).toBe(true);
      for (const l of legs.filter((x) => x.part !== "matrix"))
        expect(l.ui_paths ?? "", l.name).toBe("");
      // The newest engine is on the matrix in both pull-request and main shapes, on both paths.
      const newest = legs.filter(
        (l) => l.godot === "4.7.2" && l.part === "matrix",
      );
      expect(new Set(newest.map((l) => l.ui_paths))).toEqual(
        new Set(["0", "1"]),
      );
    }
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
    expect(selectLanes(scope, files)["swift-linux"]).toBe(true);
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
    expect(out["swift-linux"]).toBe("true");
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
      expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(3);
      expectFullMatrices(out);
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
      // The nightly lanes run unfiltered from nightly-advisory.yml, off the push path.
      if (NIGHTLY_LANES.includes(lane)) continue;
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
    // The advisory jobs left ci.yml for nightly-advisory.yml, so CI OK cannot need them.
    const others = Object.keys(jobs).filter((id) => id !== "ci-ok");
    expect(needsOf(ok).sort()).toEqual(others.sort());
    for (const id of NIGHTLY_JOBS) expect(jobs[id], id).toBeUndefined();
  });

  it("runs the full CI on pushes to main and next, superseding a run in flight", () => {
    const push = ci.on.push as { branches?: string[] };
    expect(push.branches).toEqual(["main", "next"]);
    const concurrency = (
      ci as unknown as {
        concurrency: { group: string; "cancel-in-progress": boolean };
      }
    ).concurrency;
    // One group per pull request, else per ref; always superseded (PRs, next and main).
    expect(concurrency.group).toBe(
      "ci-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(concurrency["cancel-in-progress"]).toBe(true);
  });

  it("runs the full CI on a push to next that has no green base, like main", () => {
    // ci.yml hands the scope the event name and the ref; no base means no per-lane diff.
    const lanes = ciOutputs(scope, {
      event: "push",
      ref: "refs/heads/next",
      push: null,
    });
    for (const lane of Object.keys(scope.lanes))
      expect(lanes[lane], lane).toBe("true");
    expect(lanes.full).toBe("true");
    for (const name of Object.keys(scope.matrices))
      expect(JSON.parse(String(lanes[`${name}-matrix`]))).toEqual(
        matrixFor(scope, name, false),
      );
  });

  it("scopes ci-ok's skipped lanes to a narrowed run", () => {
    const ok = jobs["ci-ok"]!;
    const run = ok.steps!.map((st) => st.run ?? "").join("\n");
    expect(jobs.changes!.outputs).toHaveProperty("full");
    expect(JSON.stringify(ok.steps)).toContain("needs.changes.outputs.full");
    // A skipped job passes only when FULL is "false"; success always passes.
    expect(run).toContain('.result == "skipped" and $full == "false"');
  });

  it("lets the changes job read this workflow's runs, and nothing more", () => {
    const perms = (
      jobs.changes as unknown as { permissions: Record<string, string> }
    ).permissions;
    expect(perms).toEqual({ contents: "read", actions: "read" });
    const step = jobs.changes!.steps!.find((st) =>
      st.run?.includes("ci-scope"),
    )!;
    expect(step.run).toContain('--ref "$GITHUB_REF"');
    expect(JSON.stringify(step)).toContain("github.token");
  });
});

/** The job display names a ci.yml job can take (a matrix name is rendered from its matrix). */
function renderedNames(id: string, job: Job & { name?: string }): string[] {
  const name = job.name ?? id;
  if (name !== "${{ matrix.name }}")
    return [name.replace(/\$\{\{[^}]*\}\}/g, "x")];
  if (id === "godot") {
    const m = scope.matrices.godot!.main as { include: { name: string }[] };
    return m.include.map((i) => i.name);
  }
  const m = job.strategy?.matrix as { include: { name: string }[] };
  return m.include.map((i) => i.name);
}

describe("the lane to jobs map", () => {
  it("maps every ci.yml job to exactly one lane, `js` or `always`", () => {
    for (const [id, job] of Object.entries(ci.jobs))
      for (const name of renderedNames(id, job)) {
        const hits = Object.entries(scope.jobs)
          .filter(([, globs]) => globs.some((g) => globMatch(g, name)))
          .map(([g]) => g);
        expect(hits, `${id}: ${name}`).toHaveLength(1);
      }
  });

  it("matches a glob against the whole name, `*` being any run of characters", () => {
    expect(globMatch("Python SDK (*", "Python SDK (3.9, ubuntu-24.04)")).toBe(
      true,
    );
    expect(globMatch("CI OK", "CI OK (old)")).toBe(false);
    expect(globMatch("Godot SDK (*", "my Godot SDK (4.7.2)")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
  });

  it("names a group for every lane and no group that is not a lane, `js` or `always`", () => {
    expect(Object.keys(scope.jobs).sort()).toEqual(
      [...Object.keys(scope.lanes), "js", "always"].sort(),
    );
  });

  it("gives a lane jobs exactly when ci.yml gates a job on it", () => {
    for (const lane of Object.keys(scope.lanes)) {
      const gated = Object.values(ci.jobs).some((j) =>
        JSON.stringify(j).includes(`needs.changes.outputs.${lane} ==`),
      );
      const owned = scope.jobs[lane]!.length > 0;
      // The docs lane also gates a step of `js`; its own job is help-search.
      expect(owned, lane).toBe(gated && !NIGHTLY_LANES.includes(lane));
    }
  });

  it("tracks the lanes that have jobs, and `js`", () => {
    expect(trackedGroups(scope)).toContain("js");
    expect(trackedGroups(scope)).not.toContain("always");
    for (const l of NIGHTLY_LANES)
      expect(trackedGroups(scope)).not.toContain(l);
  });
});

/** One concrete job per group, with a conclusion; `changes` succeeds unless said otherwise. */
const jobsFor = (
  conclusions: Record<string, string>,
  fallback = "success",
  changes = "success",
): CiJob[] => [
  { name: "Changes (which lanes run)", conclusion: changes },
  { name: "CI OK", conclusion: "failure" },
  ...trackedGroups(scope).flatMap((g) =>
    scope.jobs[g]!.map((glob) => ({
      name: glob.replace("*", "x"),
      conclusion: conclusions[g] ?? fallback,
    })),
  ),
];

const history = (runs: Record<string, CiJob[]>) => (sha: string) =>
  runs[sha] ?? null;

describe("a lane's green base", () => {
  it("is the newest ancestor on which every job of the lane succeeded, per lane", () => {
    // A is green; B failed in python only; the fix C is the commit being built.
    const runs = {
      A: jobsFor({}),
      B: jobsFor({ python: "failure" }),
    };
    const bases = laneBases(scope, ["B", "A"], history(runs));
    expect(bases.python).toBe("A");
    expect(bases.kotlin).toBe("B");
    expect(bases.js).toBe("B");
    expect(bases.godot).toBe("B");
  });

  it("counts a lane that passed in a cancelled run", () => {
    const runs = {
      A: jobsFor({}),
      D: jobsFor({ godot: "cancelled", android: "cancelled" }),
    };
    const bases = laneBases(scope, ["D", "A"], history(runs));
    expect(bases.kotlin).toBe("D");
    expect(bases.godot).toBe("A");
    expect(bases.android).toBe("A");
  });

  it("needs every job of the lane: one red or unfinished job in a lane makes it not green", () => {
    const [first, second] = scope.jobs.kotlin!;
    const run = jobsFor({}).map((j) =>
      globMatch(second!, j.name) ? { ...j, conclusion: "failure" } : j,
    );
    expect(first).toBeDefined();
    expect(laneBases(scope, ["B"], history({ B: run })).kotlin).toBeNull();
    const pending = run.map((j) =>
      j.conclusion === "failure" ? { ...j, conclusion: "" } : j,
    );
    expect(laneBases(scope, ["B"], history({ B: pending })).kotlin).toBeNull();
  });

  it("counts a lane the run skipped, when changes succeeded: it was green at its own base", () => {
    const narrowed = jobsFor({ python: "skipped", swift: "skipped" });
    const bases = laneBases(scope, ["B"], history({ B: narrowed }));
    expect(bases.python).toBe("B");
    expect(bases.swift).toBe("B");
    // A skip with a failed changes job (an outage) is not green, nor is a skipped js.
    const outage = jobsFor({}, "skipped", "failure");
    expect(
      Object.values(laneBases(scope, ["B"], history({ B: outage }))),
    ).toEqual(trackedGroups(scope).map(() => null));
    expect(
      laneBases(scope, ["B"], history({ B: jobsFor({ js: "skipped" }) })).js,
    ).toBeNull();
  });

  it("finds none when no ancestor has a run, or the runs hold no job of the lane", () => {
    const none = laneBases(scope, ["B", "A"], () => null);
    expect(Object.values(none).every((b) => b === null)).toBe(true);
    const empty = laneBases(scope, ["B"], history({ B: [] }));
    expect(Object.values(empty).every((b) => b === null)).toBe(true);
  });

  it("walks the ancestry, not a window: a base 500 commits back is found", () => {
    const commits = Array.from({ length: 600 }, (_, i) => `c${i}`);
    const seen: string[] = [];
    const bases = laneBases(scope, commits, (sha) => {
      seen.push(sha);
      return sha === "c500" ? jobsFor({}) : null;
    });
    expect(bases.python).toBe("c500");
    // Once every lane has a base the walk stops.
    expect(seen.at(-1)).toBe("c500");
  });

  it("reads each run's jobs lazily: stops at the commit that settles every lane", () => {
    const calls: string[] = [];
    laneBases(scope, ["a", "b", "c"], (sha) => {
      calls.push(sha);
      return jobsFor({});
    });
    expect(calls).toEqual(["a"]);
  });
});

describe("a push to next narrows each lane to the files since its own base", () => {
  const next = "refs/heads/next";
  const pyFile = "sdks/python/src/polaris_key/a.py";
  const swiftFile = "sdks/swift/Sources/PolarisKeyCore/Client.swift";
  const allBases = (sha: string | null) =>
    Object.fromEntries(trackedGroups(scope).map((g) => [g, sha]));
  const allFiles = (files: string[] | null) =>
    Object.fromEntries(trackedGroups(scope).map((g) => [g, files]));

  it("runs only the lanes the files since each base touch, on the FULL matrices", () => {
    // The python fix after a python-only red: python's base is old and sees the Python change
    // alongside the fix; every other lane's base is the previous commit.
    const out = ciOutputs(scope, {
      event: "push",
      ref: next,
      push: {
        bases: { ...allBases("B"), python: "A" },
        files: {
          ...allFiles([pyFile]),
          python: [pyFile, "sdks/python/pyproject.toml"],
        },
      },
    });
    expect(out.python).toBe("true");
    expect(out["e2e-backend"]).toBe("true");
    expect(out.swift).toBe("false");
    expect(out.kotlin).toBe("false");
    expect(out.godot).toBe("false");
    expect(out.full).toBe("false");
    for (const name of Object.keys(scope.matrices))
      expect(JSON.parse(String(out[`${name}-matrix`]))).toEqual(
        matrixFor(scope, name, false),
      );
  });

  it("runs a lane that has no base (mixed), and skips one that is green and untouched", () => {
    const out = ciOutputs(scope, {
      event: "push",
      ref: next,
      push: {
        bases: { ...allBases("B"), godot: null },
        files: { ...allFiles([pyFile]), godot: null },
      },
    });
    expect(out.godot).toBe("true");
    expect(out.python).toBe("true");
    expect(out.swift).toBe("false");
    expect(out.full).toBe("false");
  });

  it("runs every lane on the full matrices when no lane has a base", () => {
    const out = ciOutputs(scope, {
      event: "push",
      ref: next,
      push: { bases: allBases(null), files: allFiles(null) },
    });
    for (const lane of Object.keys(scope.lanes))
      expect(out[lane], lane).toBe("true");
    expect(out.full).toBe("true");
    expect(out["js-base"]).toBe("");
    expectFullMatrices(out);
  });

  it("runs every lane when a shared path changed since its base", () => {
    const out = ciOutputs(scope, {
      event: "push",
      ref: next,
      push: {
        bases: allBases("B"),
        files: allFiles([swiftFile, "conformance/corpus/v2/cases.json"]),
      },
    });
    for (const lane of Object.keys(scope.lanes))
      expect(out[lane], lane).toBe("true");
    expect(out.full).toBe("false");
    expectFullMatrices(out);
  });

  it("runs every lane when the diff cannot be read", () => {
    const out = ciOutputs(scope, {
      event: "push",
      ref: next,
      push: { bases: allBases("B"), files: allFiles(null) },
    });
    for (const lane of Object.keys(scope.lanes))
      expect(out[lane], lane).toBe("true");
  });

  it.each(["refs/heads/main", "refs/tags/v1.2.3", ""])(
    "runs the full CI on a push to %s, whatever the bases",
    (ref) => {
      const out = ciOutputs(scope, {
        event: "push",
        ref,
        push: { bases: allBases("B"), files: allFiles(["README.md"]) },
      });
      for (const lane of Object.keys(scope.lanes))
        expect(out[lane], lane).toBe("true");
      expect(out.full).toBe("true");
      expectFullMatrices(out);
    },
  );

  it("hands turbo the js base only when every file since it is under packages/", () => {
    const js = (files: string[]) =>
      ciOutputs(scope, {
        event: "push",
        ref: next,
        push: { bases: allBases("B"), files: allFiles(files) },
      })["js-base"];
    expect(js(["packages/worker/src/a.ts", "packages/docs/x.md"])).toBe("B");
    expect(js(["packages/worker/src/a.ts", "sdks/python/a.py"])).toBe("");
    expect(js(["packages/worker/src/a.ts", "pnpm-lock.yaml"])).toBe("");
    expect(js(["conformance/node/a.ts"])).toBe("");
    // A pull request never narrows the JS tests.
    expect(
      ciOutputs(scope, { event: "pull_request", files: ["packages/a/b.ts"] })[
        "js-base"
      ],
    ).toBe("");
  });

  it("reads the bases through git and the API, HEAD excluded, newest runs only", () => {
    const calls: string[][] = [];
    const bases = greenBasesOf({
      scope,
      repo: "o/r",
      run: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (cmd === "git") return "head\nc1\nc2\n";
        if (args.some((a) => a.includes("/jobs?")))
          return jobsFor({})
            .map((j) => `${j.name}\t${j.conclusion}`)
            .join("\n");
        return "c1\t77\nc2\t76\nc1\t5\n";
      },
    });
    expect(bases!.python).toBe("c1");
    expect(calls[0]).toEqual(["git", "rev-list", "-n", "1001", "HEAD"]);
    expect(calls[1]![2]).toContain(
      "repos/o/r/actions/workflows/ci.yml/runs?branch=next&event=push&per_page=100",
    );
    // The newest run of a SHA wins; its jobs are the latest attempt.
    expect(calls[2]![3]).toContain("repos/o/r/actions/runs/77/jobs?");
    expect(calls[2]![3]).toContain("filter=latest");
    expect(calls).toHaveLength(3);
  });

  it("answers null when the API or git fails, so the caller runs everything", () => {
    const boom = (cmd: string) => {
      if (cmd === "gh") throw new Error("403");
      return "head\nc1\n";
    };
    expect(greenBasesOf({ scope, repo: "o/r", run: boom })).toBeNull();
    const jobsBoom = (cmd: string, args: string[]) => {
      if (cmd === "git") return "head\nc1\n";
      if (args.some((a) => a.includes("/jobs?"))) throw new Error("502");
      return "c1\t9\n";
    };
    expect(greenBasesOf({ scope, repo: "o/r", run: jobsBoom })).toBeNull();
    const noGit = () => {
      throw new Error("not a repo");
    };
    expect(greenBasesOf({ scope, repo: "o/r", run: noGit })).toBeNull();
    expect(
      greenBasesOf({
        scope,
        repo: "o/r",
        run: (c: string) => (c === "git" ? "head\n" : ""),
      }),
    ).toBeNull();
  });

  it("finds all-null bases when the ancestry has no run, which the outputs treat as a full run", () => {
    const run = (cmd: string) => (cmd === "git" ? "head\nc1\n" : "");
    const bases = greenBasesOf({ scope, repo: "o/r", run });
    expect(Object.values(bases!).every((b) => b === null)).toBe(true);
  });

  it("the command runs everything on a push to next when no repository is named", () => {
    const r = repo({ "README.md": "# r\n" });
    const run = spawnSync(
      process.execPath,
      [CLI, "ci", "--event", "push", "--ref", next],
      {
        cwd: r.dir,
        encoding: "utf8",
        env: { ...process.env, GITHUB_REPOSITORY: "" },
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const out = outputsOf(run.stdout);
    expect(out.full).toBe("true");
    expect(out["js-base"]).toBe("");
    expectFullMatrices(out);
  });
});

describe("shared is narrowed to what every lane verifies", () => {
  it("selects only the always-on js jobs for a lint-ledger-only commit", () => {
    for (const f of [
      "tools/lint/debt/jscpd.json",
      "tools/lint/debt/knip.json",
      "tools/lint/debt/size.json",
    ])
      expect(on([f]), f).toEqual([]);
  });

  it("keeps a generator or a tool script from turning every lane on", () => {
    expect(on(["tools/sign-corpus.ts"])).toEqual([]);
    expect(on(["tools/gate.mjs"])).toEqual([]);
    expect(on(["tools/lint-staged.mjs"])).toEqual([]);
  });

  it("still turns every lane on for the scope, the registry, the workflow and its actions", () => {
    for (const f of [
      "tools/ci-scope.json",
      "tools/ci-scope.mjs",
      "tools/generators.ts",
      "tools/gen.ts",
      ".github/workflows/ci.yml",
      ".github/actions/setup-js/action.yml",
      "conformance/corpus/v2/cases.json",
      "packages/shared-protocol/src/core.ts",
      "pnpm-lock.yaml",
    ])
      expect(on([f]), f).toHaveLength(Object.keys(scope.lanes).length);
  });

  it("leaves another workflow, which ci.yml does not run, out", () => {
    expect(on([".github/workflows/publish-sdks.yml"])).toEqual([]);
    expect(on([".github/dependabot.yml"])).toEqual([]);
  });

  it("still runs the lanes that read the lint tree, but not for its debt ledgers", () => {
    expect(on(["tools/lint/lint-debt.mjs"])).toEqual(
      expect.arrayContaining(["python", "e2e-backend"]),
    );
    expect(on(["tools/lint/adapters/python.mjs"])).toContain("python");
    expect(on(["tools/lint/debt/knip.json"])).not.toContain("python");
  });

  it("replays history: the command reports each commit's lanes and how many are full", () => {
    const r = repo({ "README.md": "# r\n" });
    r.write("tools/lint/debt/jscpd.json", "{}\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "ledger");
    r.write("sdks/python/src/a.py", "x = 1\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "py");
    r.write("tools/ci-scope.json", "{}\n");
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "scope");
    const out = cli(r.dir, "replay", "--count", "3");
    expect(out.status, out.stderr).toBe(0);
    const lines = out.stdout.trim().split("\n");
    expect(lines[0]).toContain("every lane");
    expect(lines[1]).toMatch(/python/);
    expect(lines[1]).not.toContain("every lane");
    expect(lines[2]).toContain("js only");
    expect(lines[3]).toBe("1 of 3 commit(s) turn every lane on");
  });
});

describe("the JS test jobs narrow with the js base", () => {
  const text = (id: string) => JSON.stringify(ci.jobs[id]);

  it("hands the js base from the changes job to the three test jobs", () => {
    expect(ci.jobs.changes!.outputs).toHaveProperty("js-base");
    for (const id of ["js-worker", "js-admin", "js-rest"])
      expect(text(id), id).toContain("needs.changes.outputs.js-base");
  });

  it("builds and tests the Worker and the admin only when turbo says they are affected", () => {
    for (const [id, pkg] of [
      ["js-worker", "@polaris-key/worker"],
      ["js-admin", "@polaris-key/admin"],
    ] as const) {
      const steps = ci.jobs[id]!.steps!;
      const check = steps.find((st) => st.run?.includes("ci-js-affected"))!;
      expect(check.run, id).toContain(pkg);
      const after = steps.slice(steps.indexOf(check) + 1);
      for (const st of after.filter((x) => x.run?.startsWith("pnpm")))
        expect(st.if, `${id}: ${st.run}`).toBe(
          "steps.affected.outputs.affected == 'true'",
        );
    }
  });

  it("filters js-rest to the changed packages, keeping its three exclusions", () => {
    const step = ci.jobs["js-rest"]!.steps!.find((st) =>
      st.run?.includes("turbo run test"),
    )!;
    expect(step.run).toContain('${JS_BASE:+"--filter=...[$JS_BASE]"}');
    for (const p of ["worker", "admin", "conformance-browser"])
      expect(step.run).toContain(`--filter=!@polaris-key/${p}`);
  });

  it("runs a package when there is no base, or turbo cannot say", () => {
    const boom = () => {
      throw new Error("turbo failed");
    };
    expect(affected("@polaris-key/worker", "")).toBe(true);
    expect(affected("@polaris-key/worker", undefined)).toBe(true);
    expect(affected("@polaris-key/worker", "abc", boom)).toBe(true);
    expect(affected("@polaris-key/worker", "abc", () => "not json")).toBe(true);
  });

  it("selects the Worker when docs, admin or elements changed: its tests read their files", () => {
    const only = (pkg: string) => () => `{"tasks":[{"package":"${pkg}"}]}`;
    for (const pkg of ["docs", "admin", "elements"])
      expect(
        affected("@polaris-key/worker", "abc", only(`@polaris-key/${pkg}`)),
        pkg,
      ).toBe(true);
    expect(
      affected("@polaris-key/worker", "abc", only("@polaris-key/node")),
    ).toBe(false);
    // Only the Worker has undeclared inputs; the admin SPA's own tests do not read the docs build.
    expect(
      affected("@polaris-key/admin", "abc", only("@polaris-key/docs")),
    ).toBe(false);
    expect(Object.keys(EXTRA_INPUTS)).toEqual(["@polaris-key/worker"]);
  });

  it("lists every sibling package the Worker's tests open by relative path", () => {
    const tests = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? tests(join(dir, e.name)) : [join(dir, e.name)],
      );
    const sibling =
      /["']\.\.["'], ["']\.\.["'], ["'](docs|admin|elements|cli|ui-core|sdk-[a-z]+|server|ui-qa)["']/;
    const found = new Set<string>();
    for (const f of tests(join(ROOT, "packages", "worker", "test")))
      if (/\.(ts|tsx)$/.test(f))
        for (const m of readFileSync(f, "utf8").matchAll(
          new RegExp(sibling, "g"),
        ))
          found.add(`@polaris-key/${m[1]}`);
    for (const pkg of found)
      expect(EXTRA_INPUTS["@polaris-key/worker"], pkg).toContain(pkg);
  });

  it("selects by turbo's `...[base]` task list", () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return 'warn\n{"tasks":[{"package":"@polaris-key/react"},{"package":"@polaris-key/node"}]}';
    };
    expect(affected("@polaris-key/react", "abc", run)).toBe(true);
    expect(affected("@polaris-key/worker", "abc", run)).toBe(false);
    expect(calls[0]).toContain("--filter=...[abc]");
    expect(packagesOf('{"tasks":[]}').size).toBe(0);
  });
});

describe("nightly-advisory.yml holds the advisory lanes", () => {
  it("runs on a schedule and on demand only, read-only", () => {
    expect(Object.keys(nightly.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    expect(Object.keys(nightly.jobs).sort()).toEqual([...NIGHTLY_JOBS].sort());
  });

  it("keeps each job advisory and independent of the scope map", () => {
    for (const id of NIGHTLY_JOBS) {
      const job = nightly.jobs[id]!;
      expect(job["continue-on-error"], id).toBe(true);
      expect(job.needs, id).toBeUndefined();
      expect(job.if, id).toBeUndefined();
    }
    expect(JSON.stringify(nightly)).not.toContain("needs.changes");
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
    // The Swift docs snippets ride this job (macOS slot diet), on their own lane.
    expect(floor.if).toBe(
      "needs.changes.outputs.swift-floor == 'true' || needs.changes.outputs.docs-snippets == 'true'",
    );
    expect(ci.jobs["docs-snippets-swift"]).toBeUndefined();
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

  it("builds the package for macOS and, for iOS, every library, then the platform and its C surface strictly", () => {
    expect(runs).toContain("swift build --package-path sdks/swift");
    expect(runs.join("\n")).not.toMatch(/swift test/);
    const ios = runs
      .find((r) => r.includes("generic/platform=iOS"))!
      .replace(/\\\n\s*/g, " ");
    // One plain invocation of the package scheme, then the strict loop.
    expect(ios).toMatch(/xcodebuild -scheme PolarisKey-Package /);
    const loop = /for scheme in ([^;]+); do([\s\S]*?)done/.exec(ios)!;
    expect(loop[2]).toContain("SWIFT_TREAT_WARNINGS_AS_ERRORS=YES");
    expect(loop[1]!.trim().split(/\s+/).sort()).toEqual([
      "PolarisKeyPlatform",
      "PolarisKeyPlatformC",
    ]);
  });

  it("runs the Swift docs snippets here, gated on the docs-snippets lane", () => {
    const lane = (floor.steps ?? []).find((s) =>
      (s.run ?? "").includes('-t "swift lane"'),
    )!;
    expect(lane.if).toBe("needs.changes.outputs.docs-snippets == 'true'");
    expect(ci.jobs["docs-snippets"]!.if).toBe(
      "needs.changes.outputs.docs-snippets == 'true'",
    );
  });

  it("keeps a full run to five macOS jobs", () => {
    const mac = Object.entries(ci.jobs).filter(([, j]) =>
      String(j["runs-on"] ?? "").startsWith("macos-"),
    );
    // The three matrix legs (Python 3.12, Kotlin desktop, Godot smoke) are not counted here: their
    // fate is the macOS-leg decision, not this fold.
    expect(
      mac.map(([id]) => id),
      "the single-leg macOS jobs",
    ).toEqual([
      "browser-webkit",
      "swift-floor",
      "apple",
      "apple-hosted",
      "apple-plugin",
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

// The Swift SDK on Linux: advisory, pinned by digest, runs for the package's tree.
describe("nightly-advisory.yml builds the Swift SDK on Linux", () => {
  const job = nightly.jobs["swift-linux"]!;

  it("is advisory, nightly, and not a CI OK dependency; the lane stays in the scope map", () => {
    expectAdvisory("swift-linux");
    expect(on(["sdks/swift/Sources/PolarisKeyCore/Transport.swift"])).toContain(
      "swift-linux",
    );
    expect(on(["packages/cli/src/index.ts"])).not.toContain("swift-linux");
  });

  it("pins the Swift image by digest and runs the redirect tests", () => {
    expect(JSON.stringify(job.container)).toMatch(/@sha256:[0-9a-f]{64}/);
    const steps = JSON.stringify(job.steps ?? []);
    expect(steps).toContain("swift build");
    expect(steps).toContain("DelegatedExchange|RedirectPolicy");
  });
});

// UK-08.8: the SwiftUI kit's macOS renders (macos-26 and macos-15) run only for the kit's own tree,
// the sample and the copy it renders, and CI OK does not wait for them until the baselines are committed.
describe("nightly-advisory.yml renders the SwiftUI kit on the Mac", () => {
  const job = nightly.jobs["swiftui-mac"]!;
  const steps = JSON.stringify(job.steps ?? []);

  it("is advisory, nightly, and not a CI OK dependency; the lane stays in the scope map", () => {
    // Non-blocking until the first baselines are committed (UK-08.8).
    expectAdvisory("swiftui-mac");
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
describe("nightly-advisory.yml runs the Compose desktop kit lane", () => {
  const job = nightly.jobs["compose-desktop"]!;
  const steps = JSON.stringify(job.steps ?? []);

  it("is advisory, nightly, and not a CI OK dependency; the lane stays in the scope map", () => {
    expectAdvisory("compose-desktop");
    expect(ci.jobs["compose-desktop"]).toBeUndefined();
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

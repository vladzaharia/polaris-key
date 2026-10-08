/**
 * F-10 — our SDKs onto our own feeds (plans/F-01.md §5), automated (owner decision 2026-10-04). A
 * static check of the properties the publish pipeline promises, so a later edit cannot quietly
 * undo one:
 *
 *   - the root `.pkey/` (the system product `polaris-key`) is valid and declares one package
 *     deliverable per SDK artifact this repository ships, every one of which publish-sdks.yml
 *     publishes;
 *   - publishing is automatic and in lockstep: every push to main and every v* tag (deploy.yml
 *     calls publish-sdks.yml after the deploy and the registration), with the version derived by
 *     tools/sdk-version.mjs and stamped after each SDK's tests; nothing else publishes, and the
 *     legacy release workflows and Changesets are gone;
 *   - every publish goes through `publish-package.yml`, the one trusted publisher, in the
 *     `package-registry` environment, with the committed `./actions/publish` Action, from main or
 *     a v* tag only, on the channel the version belongs to;
 *   - deploy.yml registers the platform packages (the deploy hook) on every deploy, and a drift job
 *     reads every feed back after a publish;
 *   - no workflow publishes anywhere else (npmjs, GitHub Packages, PyPI, Maven Central, Docker
 *     Hub, GHCR);
 *   - the Swift job is signed or nothing: it fails with plans/F-01.md §5.3's message when a secret
 *     is missing, and deletes the key files in an always() step;
 *   - P0-52, feed coherence: the npm packages publish in dependency tiers, so a stuck or failed
 *     leg leaves no dependent published at that version; the trusted publisher waits until the
 *     feed lists every @polaris-key version a tarball pins; the drift job and a daily workflow
 *     check that every pin resolves; npm-repair.yml is the one manual backfill, of a release
 *     tag's version, from main.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadManifest, validateLoadedManifest } from "../src/manifest.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const run = promisify(execFile);

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  name?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  uses?: string;
  if?: string;
  name?: string;
  needs?: string | string[];
  "runs-on"?: string;
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  with?: Record<string, unknown>;
  steps?: Step[];
  "continue-on-error"?: boolean;
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const raw = (file: string) => readFileSync(path.join(WORKFLOWS, file), "utf8");
const workflow = (file: string) => parseYaml(raw(file)) as Workflow;
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

const PUBLISHER = "./.github/workflows/publish-package.yml";
const PUBLISH_SDKS = "publish-sdks.yml";
const NPM_REPAIR = "npm-repair.yml";
/** publish-sdks.yml's npm publish jobs, one per dependency tier (P0-52). */
const NPM_TIERS = [
  "npm-tier-0",
  "npm-tier-1",
  "npm-tier-2",
  "npm-tier-3",
  "npm-tier-4",
];
const LEGACY = [
  "release.yml",
  "release-python.yml",
  "release-swift.yml",
  "release-kotlin.yml",
  "release-godot.yml",
  "release-image.yml",
];
const SWIFT_ERROR =
  "::error::Swift registry releases are signed (owner decision 2026-10-04). Set SWIFT_REGISTRY_SIGNING_KEY, SWIFT_REGISTRY_SIGNING_CERT and SWIFT_REGISTRY_CERT_CHAIN.";

/** Every job that calls the trusted publisher, with the workflow it sits in. */
function publishCalls(): { file: string; id: string; job: Job }[] {
  const out: { file: string; id: string; job: Job }[] = [];
  for (const file of workflowFiles)
    for (const [id, job] of Object.entries(workflow(file).jobs ?? {}))
      if (job.uses === PUBLISHER) out.push({ file, id, job });
  return out;
}

/** The deliverable ids a publish call can name (expanding its matrix). */
function calledDeliverables(job: Job): string[] {
  const d = String(job.with?.deliverable ?? "");
  const m = /^([a-z]+)\.\$\{\{ matrix\.([a-z]+) \}\}$/.exec(d);
  if (m) {
    const values = job.strategy?.matrix?.[m[2]!];
    return (Array.isArray(values) ? values : []).map((a) => `${m[1]}.${a}`);
  }
  return [d];
}

/** The public npm packages of this workspace, by their short name. */
function publicNpmPackages(): string[] {
  const out: string[] = [];
  for (const d of readdirSync(path.join(ROOT, "packages"))) {
    let pkg: { name?: string; private?: boolean };
    try {
      pkg = JSON.parse(
        readFileSync(path.join(ROOT, "packages", d, "package.json"), "utf8"),
      ) as { name?: string; private?: boolean };
    } catch {
      continue;
    }
    if (!pkg.private && pkg.name?.startsWith("@polaris-key/"))
      out.push(pkg.name.slice("@polaris-key/".length));
  }
  return out.sort();
}

describe("the root .pkey/ (the system product)", () => {
  it("is valid and owned by polaris-key, with the one trusted publisher", async () => {
    const loaded = await loadManifest(ROOT);
    const v = validateLoadedManifest(loaded);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect((loaded.product as { product: { slug: string } }).product.slug).toBe(
      "polaris-key",
    );
    const release = (
      loaded.release as {
        release: {
          publishing: {
            trustedPublisher: { workflow: string; environment: string };
          };
        };
      }
    ).release;
    expect(release.publishing.trustedPublisher).toEqual({
      workflow: ".github/workflows/publish-package.yml",
      environment: "package-registry",
    });
  });

  it("declares a package for every SDK artifact, and publish-sdks.yml publishes each one", async () => {
    const loaded = await loadManifest(ROOT);
    const deliverables = (
      loaded.release as {
        release: {
          deliverables: Record<
            string,
            { kind: string; ecosystem: string; name: string }
          >;
        };
      }
    ).release.deliverables;
    const ids = Object.keys(deliverables).sort();
    for (const d of Object.values(deliverables)) expect(d.kind).toBe("package");

    // npm: every public workspace package, and only those.
    const npm = ids
      .filter((id) => id.startsWith("npm."))
      .map((id) => id.slice(4));
    expect(npm).toEqual(publicNpmPackages());
    for (const n of npm)
      expect(deliverables[`npm.${n}`]!.name).toBe(`@polaris-key/${n}`);

    // Everything publish-sdks.yml names is declared, and everything declared is named.
    const named = new Set<string>();
    for (const call of publishCalls().filter((c) => c.file === PUBLISH_SDKS))
      for (const d of calledDeliverables(call.job)) named.add(d);
    expect([...named].sort()).toEqual(ids);
  });

  it("names the Maven coordinates per flavour, and the Kotlin build checks build/repo against them", async () => {
    const loaded = await loadManifest(ROOT);
    const deliverables = (
      loaded.release as {
        release: { deliverables: Record<string, { name: string }> };
      }
    ).release.deliverables;
    const maven = Object.entries(deliverables)
      .filter(([id]) => id.startsWith("maven."))
      .map(([id, d]) => [id.slice(6), d.name] as const);
    for (const [artifact, name] of maven)
      expect(name).toBe(`im.plrs.key:polaris-key-${artifact}`);
    const artifacts = maven.map(([a]) => a).sort();
    expect(artifacts).toEqual(
      expect.arrayContaining([
        "platform-play",
        "platform-direct",
        "godot-play",
        "godot-direct",
        // P6-11 and P6-12: the Compose UI module and the Kotlin SDK's Android glue, per flavour.
        "ui",
        "android-play",
        "android-direct",
      ]),
    );
    const expected = /expected="([^"]+)"/.exec(raw(PUBLISH_SDKS))?.[1];
    expect(expected?.split(" ")).toEqual(artifacts);
  });
});

describe("publishing is automatic and in lockstep (owner decision 2026-10-04)", () => {
  const wf = workflow(PUBLISH_SDKS);

  it("runs on every push to main, and on every v* tag through deploy.yml, and nothing else", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["push", "workflow_call"]);
    const push = wf.on.push as { branches?: string[]; tags?: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(push.tags).toBeUndefined();
    // The tag path: deploy.yml calls it after the Worker is live and the packages registered.
    const deploy = workflow("deploy.yml");
    expect((deploy.on.push as { tags: string[] }).tags).toEqual(["v*"]);
    expect(deploy.jobs["publish-sdks"]).toMatchObject({
      needs: "deploy-worker",
      uses: "./.github/workflows/publish-sdks.yml",
      permissions: { contents: "read", "id-token": "write" },
      // Without it the called workflow's swift-sign job reads every package-registry secret as
      // empty (the v0.8.15 tag run), although it declares the environment itself.
      secrets: "inherit",
    });
    // Only publish-sdks.yml and deploy.yml start a publish.
    for (const file of workflowFiles)
      for (const job of Object.values(workflow(file).jobs ?? {}))
        if (job.uses === "./.github/workflows/publish-sdks.yml")
          expect(file).toBe("deploy.yml");
  });

  it("derives the version from git, never from a hand-edited file or Changesets", () => {
    const version = wf.jobs.version!;
    const derive = (version.steps ?? []).find((s) =>
      s.run?.includes("tools/sdk-version.mjs derive"),
    );
    expect(derive?.run).toContain("--github-output");
    const checkout = (version.steps ?? []).find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    // The whole history: the version counts commits since the newest v* tag.
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    for (const file of workflowFiles)
      expect(raw(file), file).not.toMatch(/changeset/i);
  });

  it("stamps every SDK after its tests, with the derived version", () => {
    const stamped: string[] = [];
    for (const [id, job] of Object.entries(wf.jobs)) {
      const steps = job.steps ?? [];
      const stamp = steps.findIndex((s) =>
        s.run?.includes("tools/sdk-version.mjs stamp"),
      );
      if (stamp === -1) continue;
      stamped.push(id);
      expect(steps[stamp]!.env).toEqual({
        VERSION: "${{ needs.version.outputs.version }}",
        PEP440: "${{ needs.version.outputs.pep440 }}",
      });
      const tests = steps.findIndex((s) =>
        /pytest|turbo run test|gradlew[^\n]*:core:test/.test(s.run ?? ""),
      );
      if (tests !== -1) expect(tests, id).toBeLessThan(stamp);
    }
    expect(stamped.sort()).toEqual([
      "godot-package",
      "kotlin-build",
      "npm-pack",
      "python-build",
      "swift-sign",
    ]);
  });

  it("publishes each package at the lockstep version, on its channel", () => {
    for (const c of publishCalls().filter((c) => c.file === PUBLISH_SDKS)) {
      expect(c.job.with?.channel, c.id).toBe(
        "${{ needs.version.outputs.channel }}",
      );
      expect(c.job.with?.version, c.id).toBe(
        c.id === "python"
          ? "${{ needs.version.outputs.pep440 }}"
          : "${{ needs.version.outputs.version }}",
      );
    }
  });

  it("reads every feed back after publishing (the drift check)", () => {
    const drift = wf.jobs.drift!;
    expect([...(drift.needs as string[])].sort()).toEqual(
      [
        "godot",
        "image",
        "maven",
        ...NPM_TIERS,
        "python",
        "swift",
        "version",
      ].sort(),
    );
    const check = (drift.steps ?? []).find((s) =>
      s.run?.includes("tools/feed-drift.mjs"),
    );
    expect(check?.run).toContain("--origin https://pkg.plrs.im");
    expect(check?.env).toMatchObject({
      VERSION: "${{ needs.version.outputs.version }}",
      PEP440: "${{ needs.version.outputs.pep440 }}",
      CHANNEL: "${{ needs.version.outputs.channel }}",
    });
  });

  it("the legacy release workflows and Changesets are gone", () => {
    for (const f of LEGACY) expect(workflowFiles).not.toContain(f);
    expect(existsSync(path.join(ROOT, ".changeset"))).toBe(false);
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts.changeset).toBeUndefined();
    expect(pkg.scripts["version-packages"]).toBeUndefined();
    expect(
      Object.keys(pkg.devDependencies).filter((d) =>
        d.startsWith("@changesets/"),
      ),
    ).toEqual([]);
  });
});

describe("deploy.yml registers the platform packages on every deploy", () => {
  const deploy = workflow("deploy.yml");
  const job = deploy.jobs["deploy-worker"]!;
  const steps = (job.steps ?? []) as (Step & { name?: string })[];
  const index = (name: string) => steps.findIndex((s) => s.name === name);

  it("calls the deploy hook after the smoke check, before the deploy is recorded", () => {
    const register = index("Register the platform packages");
    expect(register).toBeGreaterThan(index("Smoke check"));
    expect(register).toBeLessThan(index("Record deploy"));
    expect(steps[register]!.run).toContain(
      "node scripts/register-platform.mjs",
    );
    expect(steps[register]!.env).toEqual({ ORIGIN: "https://key.plrs.im" });
    // The OIDC token is the credential: no secret reaches the step.
    expect(JSON.stringify(steps[register])).not.toContain("secrets.");
  });

  it("the deploy job may mint its OIDC token", () => {
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  });
});

describe("publish-package.yml (the trusted publisher)", () => {
  const wf = workflow("publish-package.yml");
  const job = wf.jobs.publish!;

  it("is reusable only, runs in package-registry from main or a v* tag, and uses the committed Action", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_call"]);
    expect(job.environment).toMatchObject({ name: "package-registry" });
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const steps = job.steps ?? [];
    const guard = steps[0]!;
    expect(guard.run).toContain("refs/heads/main) want=main");
    expect(guard.run).toContain("refs/tags/v*)");
    expect(guard.run).toContain("exit 1");
    const publish = steps.find((s) => s.uses === "./actions/publish");
    expect(publish?.with).toMatchObject({
      product: "polaris-key",
      dir: "dist-feed/${{ inputs.dir }}",
      channel: "${{ inputs.channel }}",
    });
    expect(raw("publish-package.yml")).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
  });

  it("is called by publish-sdks.yml and npm-repair.yml only, with id-token: write", () => {
    const calls = publishCalls();
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual(
      [NPM_REPAIR, PUBLISH_SDKS].sort(),
    );
    for (const c of calls)
      expect(c.job.permissions, `${c.file} ${c.id}`).toEqual({
        contents: "read",
        "id-token": "write",
      });
  });

  it("is the only place pkey release publish runs", () => {
    for (const file of workflowFiles) {
      if (file === "publish-package.yml") continue;
      for (const job of Object.values(workflow(file).jobs ?? {}))
        for (const s of job.steps ?? [])
          expect(s.uses ?? "", `${file}`).not.toMatch(/actions\/publish/);
    }
  });
});

describe("the backstop prune after a stable tag (P0-48, feed retention)", () => {
  const wf = workflow(PUBLISH_SDKS);
  const job = wf.jobs.prune!;
  const steps = job.steps ?? [];
  const at = (name: string) => steps.findIndex((s) => s.name === name);

  it("runs only on a stable tag, after every publish and the drift check passed", () => {
    expect([...(job.needs as string[])].sort()).toEqual(
      [
        "drift",
        "godot",
        "image",
        "maven",
        ...NPM_TIERS,
        "python",
        "swift",
        "version",
      ].sort(),
    );
    // No status function: GitHub ANDs success(), so a failed publish or drift skips it.
    expect(job.if).toBe(
      "needs.version.outputs.channel == 'stable' && startsWith(github.ref, 'refs/tags/v')",
    );
    const guard = steps[at("A stable vX.Y.Z tag")]!;
    expect(guard.run).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(guard.run).toContain('"refs/tags/v$VERSION"');
    expect(guard.run).toContain("exit 1");
    // The publish is done: a prune problem must not turn the release red.
    expect(job["continue-on-error"]).toBe(true);
    expect(job.environment).toBe("package-registry");
    expect(job.permissions).toEqual({ contents: "read" });
  });

  it("dry-runs and checks the plan before it applies, with the existing rule only", () => {
    const dry = at("Dry run (deletes nothing)");
    const check = at("The plan holds builds of main only");
    const apply = at("Apply the prune");
    expect(at("A stable vX.Y.Z tag")).toBeLessThan(dry);
    expect(dry).toBeLessThan(check);
    expect(check).toBeLessThan(apply);
    expect(steps[dry]!.run).not.toContain("--apply");
    expect(steps[dry]!.run).toContain(
      "node actions/publish/dist/index.js feeds prune --product polaris-key",
    );
    expect(steps[check]!.run).toContain("-main");
    expect(steps[check]!.run).toContain(".dev");
    for (const i of [check, apply])
      expect(steps[i]!.if).toBe("steps.plan.outputs.skip != 'true'");
    expect(steps[dry]!.id).toBe("plan");
    // Only the apply step deletes, and it names no deliverable or version of its own: the
    // Worker's rule decides what goes (builds of main below each package's newest stable).
    const applies = steps.filter((s) => s.run?.includes("--apply"));
    expect(applies).toEqual([steps[apply]]);
    expect(steps[apply]!.run).toContain(
      "feeds prune --product polaris-key --apply",
    );
    expect(steps[apply]!.run).not.toMatch(/--deliverable|--base-url/);
    // A token never reaches the job summary: the mask line is filtered out of it.
    for (const i of [dry, apply])
      expect(steps[i]!.run).toContain("grep -v '^::'");
    for (const i of [dry, apply])
      expect(steps[i]!.env).toEqual({
        PKEY_CI_TOKEN: "${{ secrets.PKEY_FEED_PRUNE_TOKEN }}",
      });
    // The plan and the reports are written under $RUNNER_TEMP, never into the checkout.
    for (const i of [dry, check, apply]) {
      expect(steps[i]!.run).toContain('"$RUNNER_TEMP/prune-');
      expect(steps[i]!.run).not.toMatch(/[> ]prune-[a-z-]+\.(txt|json)/);
    }
  });

  it("warns and stops, green, when the token is not set", () => {
    const dry = steps[at("Dry run (deletes nothing)")]!.run!;
    const guard = dry.indexOf('if [ -z "$PKEY_CI_TOKEN" ]; then');
    expect(guard).toBeGreaterThanOrEqual(0);
    // The guard comes before the first pkey call, and its branch ends the step without one.
    expect(guard).toBeLessThan(dry.indexOf("node actions/publish"));
    const branch = dry.slice(guard, dry.indexOf("\nfi\n", guard));
    expect(branch).toContain("::warning::PKEY_FEED_PRUNE_TOKEN is not set");
    expect(branch).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(branch).toContain("exit 0");
    expect(branch).not.toContain("node ");
  });

  it("is the only workflow that applies a prune", () => {
    for (const file of workflowFiles)
      for (const [id, j] of Object.entries(workflow(file).jobs ?? {}))
        for (const s of j.steps ?? [])
          if (/feeds prune[^\n]*--apply/.test(s.run ?? ""))
            expect(`${file} ${id}`).toBe(`${PUBLISH_SDKS} prune`);
  });
});

/** A job's `needs`, as a list. */
function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/** Every job `id` waits for, directly or through another job. */
function ancestors(jobs: Record<string, Job>, id: string): Set<string> {
  const out = new Set<string>();
  const queue = [...needsOf(jobs[id]!)];
  while (queue.length) {
    const n = queue.shift()!;
    if (out.has(n)) continue;
    out.add(n);
    queue.push(...needsOf(jobs[n]!));
  }
  return out;
}

/** Each public npm package's @polaris-key dependencies (short names), from its package.json. */
function npmDependencyGraph(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of readdirSync(path.join(ROOT, "packages"))) {
    let pkg: {
      name?: string;
      private?: boolean;
      [field: string]: unknown;
    };
    try {
      pkg = JSON.parse(
        readFileSync(path.join(ROOT, "packages", d, "package.json"), "utf8"),
      ) as typeof pkg;
    } catch {
      continue;
    }
    if (pkg.private || !pkg.name?.startsWith("@polaris-key/")) continue;
    const deps = new Set<string>();
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      for (const n of Object.keys((pkg[field] as object | undefined) ?? {}))
        if (n.startsWith("@polaris-key/"))
          deps.add(n.slice("@polaris-key/".length));
    out.set(pkg.name.slice("@polaris-key/".length), [...deps].sort());
  }
  return out;
}

/** Everything a package depends on, directly or through another package. */
function transitiveDeps(
  graph: Map<string, string[]>,
  name: string,
): Set<string> {
  const out = new Set<string>();
  const queue = [...(graph.get(name) ?? [])];
  while (queue.length) {
    const n = queue.shift()!;
    if (out.has(n)) continue;
    out.add(n);
    queue.push(...(graph.get(n) ?? []));
  }
  return out;
}

describe("the npm packages publish in dependency order (P0-52, feed coherence)", () => {
  const wf = workflow(PUBLISH_SDKS);
  const graph = npmDependencyGraph();
  const npmCalls = publishCalls().filter(
    (c) =>
      c.file === PUBLISH_SDKS &&
      String(c.job.with?.deliverable ?? "").startsWith("npm."),
  );
  /** Package short name → the publish job that publishes it. */
  const jobOf = new Map<string, string>();
  for (const c of npmCalls)
    for (const d of calledDeliverables(c.job)) {
      expect(jobOf.has(d.slice(4)), `${d} is published twice`).toBe(false);
      jobOf.set(d.slice(4), c.id);
    }

  it("one job per tier, each publishing every package once", () => {
    expect(npmCalls.map((c) => c.id).sort()).toEqual(NPM_TIERS);
    expect([...jobOf.keys()].sort()).toEqual(publicNpmPackages());
    for (const c of npmCalls) {
      // GitHub ANDs success() into a job with no status function: a failed, cancelled or stuck
      // tier below skips this one. An `if:` (always(), !cancelled()) would undo that.
      expect(c.job.if, c.id).toBeUndefined();
      expect(needsOf(c.job), c.id).toEqual(
        expect.arrayContaining(["version", "npm-pack"]),
      );
    }
  });

  it("every package's job waits for the job of every package it depends on", () => {
    for (const [pkg, deps] of graph) {
      const job = jobOf.get(pkg)!;
      const before = ancestors(wf.jobs, job);
      for (const dep of deps)
        expect(
          before.has(jobOf.get(dep)!),
          `${pkg} (${job}) publishes without waiting for ${dep} (${jobOf.get(dep)})`,
        ).toBe(true);
    }
  });

  it("a simulated stuck leg leaves no dependent published at that version", () => {
    for (const stuck of graph.keys()) {
      const stuckJob = jobOf.get(stuck)!;
      // The stuck leg's job never completes, so no job that waits for it ever starts; its
      // siblings in the same matrix do run.
      const published = new Set<string>();
      for (const [pkg, job] of jobOf) {
        if (pkg === stuck) continue;
        if (job === stuckJob || !ancestors(wf.jobs, job).has(stuckJob))
          published.add(pkg);
      }
      for (const pkg of published)
        expect(
          transitiveDeps(graph, pkg).has(stuck),
          `with ${stuck} stuck, ${pkg} still publishes, and it depends on ${stuck}`,
        ).toBe(false);
    }
  });

  it("the trusted publisher waits until the feed lists every version an npm tarball pins", () => {
    const steps = workflow("publish-package.yml").jobs.publish!.steps ?? [];
    const gate = steps.findIndex((s) =>
      s.run?.includes("tools/feed-closure.mjs requires"),
    );
    const publish = steps.findIndex((s) => s.uses === "./actions/publish");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(publish);
    expect(steps[gate]!.if).toBe("startsWith(inputs.deliverable, 'npm.')");
    expect(steps[gate]!.run).toContain('requires "$DIR" --version "$VERSION"');
    expect(steps[gate]!.run).toContain("--origin https://pkg.plrs.im");
    expect(steps[gate]!.run).toContain("--timeout 600");
    expect(steps[gate]!.env).toEqual({
      DIR: "dist-feed/${{ inputs.dir }}",
      VERSION: "${{ inputs.version }}",
    });
    // Node 22 for it, set up for npm only, before it.
    const node = steps.findIndex((s) =>
      s.uses?.startsWith("actions/setup-node@"),
    );
    expect(node).toBeGreaterThan(-1);
    expect(node).toBeLessThan(gate);
    expect(steps[node]!.if).toBe("startsWith(inputs.deliverable, 'npm.')");
  });

  it("the drift job fails on a broken pin of this version, after a red drift check too", () => {
    const steps = wf.jobs.drift!.steps ?? [];
    const drift = steps.findIndex((s) =>
      s.run?.includes("tools/feed-drift.mjs"),
    );
    const closure = steps.findIndex((s) =>
      s.run?.includes("tools/feed-closure.mjs"),
    );
    expect(closure).toBeGreaterThan(drift);
    expect(steps[closure]!.if).toBe("${{ !cancelled() }}");
    expect(steps[closure]!.run).toContain(
      '--ecosystem npm --version "$VERSION"',
    );
    expect(steps[closure]!.env).toEqual({
      VERSION: "${{ needs.version.outputs.version }}",
    });
  });

  it("installs from the feed as an adopter would, once the whole set is there", () => {
    const job = wf.jobs["npm-install"]!;
    expect(needsOf(job)).toEqual(["version", "npm-tier-4"]);
    const runs = (job.steps ?? []).map((s) => s.run ?? "");
    const wait = runs.findIndex((r) => r.includes("tools/feed-closure.mjs"));
    expect(runs[wait]).toContain('--version "$VERSION" --complete');
    const pnpm = runs.findIndex((r) =>
      r.includes("npx --yes pnpm@11 add @polaris-key/node"),
    );
    const react = runs.findIndex((r) =>
      r.includes(
        "npm install --no-audit --no-fund @polaris-key/react react react-dom",
      ),
    );
    const set = runs.findIndex((r) =>
      r.includes('"@polaris-key/node@$VERSION"'),
    );
    for (const i of [pnpm, react, set]) {
      expect(i).toBeGreaterThan(wait);
      // An empty directory, with only the scope line the install page gives.
      expect(runs[i]).toContain(
        "printf '@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/\\n' > .npmrc",
      );
      expect(runs[i]).toContain('mkdir -p "$dir" && cd "$dir"');
    }
    // pnpm with its defaults: no minimumReleaseAge override anywhere.
    expect(runs.join("\n")).not.toMatch(
      /minimumReleaseAge|minimum-release-age/,
    );
  });
});

describe("the publisher's guard (P0-52: main, a v* tag, or npm-repair.yml's backfill)", () => {
  const script = workflow("publish-package.yml").jobs.publish!.steps![0]!.run!;
  async function guard(env: Record<string, string>): Promise<string | null> {
    try {
      await run("bash", ["-e", "-c", script], {
        env: { PATH: process.env.PATH ?? "", RELEASE_TAG: "", ...env },
      });
      return null;
    } catch (e) {
      return (e as { stderr: string }).stderr;
    }
  }
  const push = { GITHUB_EVENT_NAME: "push", DELIVERABLE: "npm.jws" };
  const repair = {
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    DELIVERABLE: "npm.jws",
    RELEASE_TAG: "v0.8.28",
    VERSION: "0.8.28",
    CHANNEL: "stable",
  };

  it("publishes main builds on main and releases on their tag, as before", async () => {
    const main = { ...push, GITHUB_REF: "refs/heads/main" };
    expect(
      await guard({ ...main, VERSION: "0.9.1-main.4", CHANNEL: "main" }),
    ).toBeNull();
    expect(
      await guard({ ...main, VERSION: "0.9.1", CHANNEL: "stable" }),
    ).toMatch(/belongs on the main channel/);
    const tag = { ...push, GITHUB_REF: "refs/tags/v0.9.1" };
    expect(
      await guard({ ...tag, VERSION: "0.9.1", CHANNEL: "stable" }),
    ).toBeNull();
    expect(
      await guard({
        ...push,
        GITHUB_REF: "refs/heads/feature",
        VERSION: "0.9.1",
        CHANNEL: "main",
      }),
    ).toMatch(/from main and from v\* release tags only/);
  });

  it("backfills a release tag's version on its channel, from a manual dispatch on main, npm only", async () => {
    expect(await guard(repair)).toBeNull();
    expect(
      await guard({
        ...repair,
        RELEASE_TAG: "v1.0.0-rc.1",
        VERSION: "1.0.0-rc.1",
        CHANNEL: "beta",
      }),
    ).toBeNull();
    expect(await guard({ ...repair, CHANNEL: "main" })).toMatch(
      /belongs on the stable channel/,
    );
    expect(await guard({ ...repair, GITHUB_EVENT_NAME: "push" })).toMatch(
      /manual dispatch on main/,
    );
    expect(await guard({ ...repair, GITHUB_REF: "refs/tags/v0.8.28" })).toMatch(
      /manual dispatch on main/,
    );
    expect(await guard({ ...repair, DELIVERABLE: "pypi.polaris-key" })).toMatch(
      /npm packages only/,
    );
    expect(await guard({ ...repair, VERSION: "0.8.29" })).toMatch(
      /not a release tag of version/,
    );
    expect(
      await guard({
        ...repair,
        RELEASE_TAG: "v0.8.34-main.4",
        VERSION: "0.8.34-main.4",
        CHANNEL: "beta",
      }),
    ).toMatch(/not a release tag of version/);
  });

  it("checks the tag is on main before anything is downloaded", () => {
    const steps = workflow("publish-package.yml").jobs.publish!.steps ?? [];
    const onMain = steps.findIndex(
      (s) => s.name === "The release tag is on main",
    );
    expect(steps[onMain]!.if).toBe("inputs.release-tag != ''");
    expect(steps[onMain]!.run).toContain(
      'git merge-base --is-ancestor "$commit" origin/main',
    );
    expect(onMain).toBeLessThan(
      steps.findIndex((s) => s.uses?.startsWith("actions/download-artifact@")),
    );
  });
});

describe("npm-repair.yml, the manual backfill (P0-52, owner decision 2026-10-08)", () => {
  const wf = workflow(NPM_REPAIR);

  it("runs only when dispatched, from main, with a tag, packages and a dry-run switch", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    const inputs = (
      wf.on.workflow_dispatch as { inputs: Record<string, unknown> }
    ).inputs;
    expect(Object.keys(inputs).sort()).toEqual(["dry-run", "packages", "tag"]);
    const plan = wf.jobs.plan!;
    expect(plan.steps![0]!.run).toContain(
      'if [ "$GITHUB_REF" != refs/heads/main ]',
    );
    expect(raw(NPM_REPAIR)).toContain("tools/feed-closure.mjs absent");
  });

  it("builds at the validated tag, stamping after the tests", () => {
    const pack = wf.jobs.pack!;
    expect(needsOf(pack)).toEqual(["plan"]);
    const steps = pack.steps ?? [];
    expect(steps[0]!.with?.ref).toBe("refs/tags/${{ needs.plan.outputs.tag }}");
    const tests = steps.findIndex((s) => s.run?.includes("turbo run test"));
    const stamp = steps.findIndex((s) =>
      s.run?.includes("tools/sdk-version.mjs stamp"),
    );
    expect(tests).toBeGreaterThan(-1);
    expect(tests).toBeLessThan(stamp);
  });

  it("publishes through the trusted publisher with release-tag, after the pins check, unless a dry run", () => {
    const publish = wf.jobs.publish!;
    expect(publish.uses).toBe(PUBLISHER);
    expect(needsOf(publish).sort()).toEqual(["pack", "plan", "verify"]);
    expect(publish.if).toBe("${{ !inputs.dry-run }}");
    expect(publish.with).toEqual({
      deliverable: "npm.${{ matrix.package }}",
      artifact: "npm-repair",
      dir: "${{ matrix.package }}",
      version: "${{ needs.plan.outputs.version }}",
      channel: "${{ needs.plan.outputs.channel }}",
      "release-tag": "${{ needs.plan.outputs.tag }}",
    });
    expect(wf.jobs.verify!.steps!.at(-1)!.run).toContain(
      'tools/feed-closure.mjs requires "dist-pkg/$n" --version "$VERSION"',
    );
    expect(wf.jobs.closure!.steps!.at(-1)!.run).toContain(
      '--version "$VERSION"',
    );
    expect(needsOf(wf.jobs.closure!)).toEqual(["plan", "publish"]);
  });

  it("no dispatch input reaches a shell except through the environment", () => {
    for (const job of Object.values(wf.jobs))
      for (const s of job.steps ?? []) expect(s.run ?? "").not.toContain("${{");
  });
});

describe("feed-closure.yml, the daily full-feed check (P0-52)", () => {
  const wf = workflow("feed-closure.yml");

  it("runs on a schedule and on demand, read-only, over every version of both feeds", () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    const job = wf.jobs.closure!;
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(wf)).not.toContain("secrets.");
    const check = job.steps!.at(-1)!.run!;
    expect(check).toContain(
      "node tools/feed-closure.mjs --origin https://pkg.plrs.im",
    );
    expect(check).toContain("--ecosystem npm,pypi");
    expect(check).not.toContain("--version");
  });
});

describe("no publishing anywhere else (owner decision 2026-10-04, feeds only)", () => {
  const FORBIDDEN: [RegExp, string][] = [
    [/npm\.pkg\.github\.com/, "GitHub Packages"],
    [/registry\.npmjs\.org/, "npmjs"],
    [/changeset publish/, "changeset publish"],
    [/\b(npm|pnpm|yarn) publish\b/, "an npm publish"],
    [/gh-action-pypi-publish|twine upload|upload\.pypi\.org/, "PyPI"],
    [
      /sonatype|central\.sonatype|publishToMavenCentral|oss\.sonatype/i,
      "Maven Central",
    ],
    [
      /docker push|ghcr\.io|docker\.io\/|docker\/login-action/,
      "a container registry",
    ],
    [/gh release (create|upload)/, "a GitHub Release"],
    [/packages: write/, "the packages permission"],
  ];

  it("no workflow names a public registry or a publish to one", () => {
    for (const file of workflowFiles) {
      // Comments may say where we do NOT publish; the steps may not.
      const text = raw(file)
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      for (const [re, what] of FORBIDDEN)
        expect(re.test(text), `${file} publishes to ${what}`).toBe(false);
    }
  });

  it("the root .npmrc routes no scope to a public registry", () => {
    // A `@polaris-key:registry` line would send a manual `pnpm publish` (and the resolution of
    // any non-workspace @polaris-key package) to that registry instead of the feed.
    const npmrc = readFileSync(path.join(ROOT, ".npmrc"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*[#;]/.test(line))
      .join("\n");
    expect(npmrc).not.toMatch(/registry\s*=/);
    for (const [re, what] of FORBIDDEN)
      expect(re.test(npmrc), `.npmrc names ${what}`).toBe(false);
  });
});

describe("Swift releases are signed or not published (plans/F-01.md §5.3)", () => {
  const wf = workflow(PUBLISH_SDKS);
  const sign = wf.jobs["swift-sign"]!;
  const script = path.join(
    ROOT,
    "sdks",
    "swift",
    "tools",
    "sign-registry-release.sh",
  );

  it("signs in package-registry with the three secrets, and deletes the key files always()", () => {
    expect(sign.environment).toBe("package-registry");
    const steps = sign.steps ?? [];
    const signStep = steps.find((s) =>
      s.run?.includes("sign-registry-release.sh"),
    );
    for (const name of [
      "SWIFT_REGISTRY_SIGNING_KEY",
      "SWIFT_REGISTRY_SIGNING_CERT",
      "SWIFT_REGISTRY_CERT_CHAIN",
    ]) {
      expect(signStep?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
      // Passed through the environment only, never interpolated into a script.
      for (const s of steps)
        expect(s.run ?? "").not.toContain(`secrets.${name}`);
    }
    const cleanup = steps.find((s) => s.if === "always()");
    expect(cleanup?.run).toContain('rm -rf "$RUNNER_TEMP/swift-registry-keys"');
    expect(wf.jobs.swift!.needs).toEqual(["version", "swift-sign"]);
  });

  it("tests and signs on ci.yml's toolchain: macos-26, Xcode 26.6, Swift 6.3 or later", () => {
    const guard = "sdks/swift/tools/select-xcode-26.sh";
    const text = readFileSync(path.join(ROOT, guard), "utf8");
    expect(text).toContain("xcode-select -s /Applications/Xcode_26.6.app");
    expect(text).toContain("is below 6.3");
    for (const id of ["swift-test", "swift-sign"]) {
      const job = wf.jobs[id]!;
      expect(job["runs-on"], id).toBe("macos-26");
      const steps = job.steps ?? [];
      const at = steps.findIndex((s) => s.run === guard);
      const swift = steps.findIndex((s) =>
        /swift test|sign-registry-release/.test(s.run ?? ""),
      );
      expect(at, `${id} selects Xcode 26.6`).toBeGreaterThanOrEqual(0);
      expect(at, `${id} selects Xcode before running Swift`).toBeLessThan(
        swift,
      );
    }
    // CI's apple job runs the same guard.
    const apple = workflow("ci.yml").jobs.apple!;
    expect(apple["runs-on"]).toBe("macos-26");
    expect((apple.steps ?? []).some((s) => s.run === guard)).toBe(true);
  });

  it("runs SwiftPM's signer in dry-run mode only, never unsigned", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain(SWIFT_ERROR);
    expect(text).toMatch(
      /swift package-registry publish [^\n]*\\\n(?:[^\n]*\\\n)*\s*--dry-run/,
    );
    expect(text).toContain("--private-key-path");
    expect(text).toContain("--cert-chain-paths");
    expect(text).not.toMatch(/allow-unsigned|onUnsigned/);
  });

  it.each([
    ["all three missing", {}],
    [
      "the key missing",
      { SWIFT_REGISTRY_SIGNING_CERT: "x", SWIFT_REGISTRY_CERT_CHAIN: "y" },
    ],
    [
      "the cert missing",
      { SWIFT_REGISTRY_SIGNING_KEY: "x", SWIFT_REGISTRY_CERT_CHAIN: "y" },
    ],
    [
      "the chain missing",
      { SWIFT_REGISTRY_SIGNING_KEY: "x", SWIFT_REGISTRY_SIGNING_CERT: "y" },
    ],
  ])("stops with the documented message when %s", async (_what, secrets) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...secrets };
    const failure = await run(
      "bash",
      [script, "1.0.0", "/nonexistent/scratch", "/nonexistent/keys"],
      {
        env,
      },
    ).then(
      () => null,
      (e: { code?: number; stdout?: string }) => e,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stdout?.trim()).toBe(SWIFT_ERROR);
  });
});

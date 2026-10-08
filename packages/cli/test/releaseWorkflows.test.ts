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
 *     is missing, and deletes the key files in an always() step.
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
    for (const call of publishCalls())
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
    for (const c of publishCalls()) {
      expect(c.file).toBe(PUBLISH_SDKS);
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
      ["godot", "image", "maven", "npm", "python", "swift", "version"].sort(),
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

  it("is called by publish-sdks.yml only, with id-token: write", () => {
    const calls = publishCalls();
    expect([...new Set(calls.map((c) => c.file))]).toEqual([PUBLISH_SDKS]);
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
        "npm",
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

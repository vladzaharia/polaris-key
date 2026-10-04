/**
 * F-10 — our SDKs onto our own feeds (plans/F-01.md §5). A static check of the properties the
 * release pipeline promises, so a later edit cannot quietly undo one:
 *
 *   - the root `.pkey/` (the system product `polaris-key`) is valid and declares one package
 *     deliverable per SDK artifact this repository ships, every one of which a release workflow
 *     publishes;
 *   - every publish goes through `publish-package.yml`, the one trusted publisher, in the
 *     `package-registry` environment, with the committed `./actions/publish` Action;
 *   - no workflow publishes anywhere else (npmjs, GitHub Packages, PyPI, Maven Central, Docker
 *     Hub, GHCR), and merging never publishes (the Changesets action has no publish step);
 *   - the Swift job is signed or nothing: it fails with plans/F-01.md §5.3's message when a secret
 *     is missing, and deletes the key files in an always() step.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  uses?: string;
  if?: string;
  needs?: string | string[];
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  with?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const raw = (file: string) => readFileSync(path.join(WORKFLOWS, file), "utf8");
const workflow = (file: string) => parseYaml(raw(file)) as Workflow;
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

const PUBLISHER = "./.github/workflows/publish-package.yml";
const RELEASE_WORKFLOWS = [
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

/** The deliverable ids a publish call can name (expanding `maven.${{ matrix.artifact }}`). */
function calledDeliverables(job: Job): string[] {
  const d = String(job.with?.deliverable ?? "");
  const m = /^maven\.\$\{\{ matrix\.artifact \}\}$/.exec(d);
  if (m) {
    const artifacts = job.strategy?.matrix?.artifact;
    return (Array.isArray(artifacts) ? artifacts : []).map((a) => `maven.${a}`);
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

  it("declares a package for every SDK artifact, and a workflow publishes each one", async () => {
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

    // Everything a release workflow names is declared, and everything declared is named. npm is
    // published per tag (release.yml derives `npm.<name>` from `@polaris-key/<name>@<version>`).
    const named = new Set<string>();
    for (const call of publishCalls())
      for (const d of calledDeliverables(call.job)) named.add(d);
    expect(named.has("${{ needs.pack.outputs.deliverable }}")).toBe(true);
    expect(raw("release.yml")).toContain(
      'echo "deliverable=npm.${name#@polaris-key/}"',
    );
    named.delete("${{ needs.pack.outputs.deliverable }}");
    for (const n of npm) named.add(`npm.${n}`);
    expect([...named].sort()).toEqual(ids);
  });

  it("names the Maven coordinates per flavour, and release-kotlin.yml checks build/repo against them", async () => {
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
      ]),
    );
    const expected = /expected="([^"]+)"/.exec(raw("release-kotlin.yml"))?.[1];
    expect(expected?.split(" ")).toEqual(artifacts);
  });
});

describe("publish-package.yml (the trusted publisher)", () => {
  const wf = workflow("publish-package.yml");
  const job = wf.jobs.publish!;

  it("is reusable only, runs in package-registry on tags, and uses the committed Action", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_call"]);
    expect(job.environment).toMatchObject({ name: "package-registry" });
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    const steps = job.steps ?? [];
    const guard = steps.find((s) => s.if === "github.ref_type != 'tag'");
    expect(guard?.run).toContain("exit 1");
    const publish = steps.find((s) => s.uses === "./actions/publish");
    expect(publish?.with).toMatchObject({
      product: "polaris-key",
      dir: "dist-feed",
    });
    expect(raw("publish-package.yml")).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
  });

  it("is called by every release workflow, with id-token: write", () => {
    const calls = publishCalls();
    expect([...new Set(calls.map((c) => c.file))].sort()).toEqual(
      [...RELEASE_WORKFLOWS].sort(),
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

  it("merging the Version Packages PR publishes nothing", () => {
    const wf = workflow("release.yml");
    const versionPr = wf.jobs["version-pr"]!;
    expect(versionPr.if).toContain("github.ref == 'refs/heads/main'");
    const changesets = (versionPr.steps ?? []).find((s) =>
      s.uses?.startsWith("changesets/action@"),
    );
    expect(changesets).toBeDefined();
    expect(changesets?.with?.publish).toBeUndefined();
    // Publishing jobs run on release tags only.
    expect(wf.jobs.pack!.if).toContain(
      "startsWith(github.ref, 'refs/tags/@polaris-key/')",
    );
    expect((wf.on.push as { tags: string[] }).tags).toEqual([
      "@polaris-key/*@*",
    ]);
  });

  it("every other release workflow publishes from tags only (or a dispatch that publishes nothing)", () => {
    for (const file of RELEASE_WORKFLOWS.filter((f) => f !== "release.yml")) {
      const wf = workflow(file);
      const push = wf.on.push as { tags?: string[]; branches?: string[] };
      expect(push.branches, file).toBeUndefined();
      expect(push.tags?.length, file).toBeGreaterThan(0);
      if ("workflow_dispatch" in wf.on)
        for (const c of publishCalls().filter((x) => x.file === file))
          expect(c.job.if, `${file} ${c.id}`).toBe(
            "github.event_name == 'push'",
          );
    }
  });
});

describe("Swift releases are signed or not published (plans/F-01.md §5.3)", () => {
  const wf = workflow("release-swift.yml");
  const sign = wf.jobs.sign!;
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
    expect(wf.jobs.publish!.needs).toEqual(["validate", "sign"]);
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

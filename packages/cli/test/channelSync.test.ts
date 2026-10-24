/**
 * A-25.3 — `pkey channel sync`: the plan over `.pkey/distribution`, the PR steps through the
 * `storefront <store> pr` runner (fake Worker and fake GitHub, one fetch), the D-A3 skips, one
 * failure failing the run after the rest, `--dry-run` and `--json`.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import { cmdChannel } from "../src/channel.js";
import type { SpawnTool } from "../src/storefronts/run.js";
import { planSync } from "../src/channelSync.js";
import type { PrInputs } from "../src/storefronts/prInputs.js";
import { BASE, FLATHUB_INPUTS, WINGET_INPUTS } from "./prFixtures.js";

const ENV = {
  PKEY_CI_TOKEN: `pkeyci_${"A".repeat(43)}`,
  PKEY_PR_TOKEN: "github_pat_fake",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "vlad/diceroll",
};

const MSI = {
  platform: "windows",
  arch: "x86_64",
  name: "Diceroll-1.2.0-x64.msi",
  url: `${BASE}/diceroll/distribution/blobs/sha256/${"c".repeat(64)}`,
  sha256: "c".repeat(64),
  size: 1,
};
const WINGET: PrInputs = {
  ...WINGET_INPUTS,
  release: { ...WINGET_INPUTS.release!, builds: [MSI] },
};

const DISTRIBUTION = `outlets:
  flathub:
    appId: gg.vlad.Diceroll
  winget:
    packageIdentifier: Vlad.Diceroll
  itch:
    target: vlad/diceroll
  snap:
    name: diceroll
  steam:
    appId: 480
`;

const ARTIFACTS = [
  {
    id: "win",
    platform: "windows",
    arch: "x86_64",
    format: "zip",
    match: "Diceroll-*-win.zip",
  },
  {
    id: "lin",
    platform: "linux",
    arch: "x86_64",
    format: "zip",
    match: "Diceroll-*-linux.zip",
  },
  {
    id: "snap",
    platform: "linux",
    arch: "x86_64",
    format: "snap",
    match: "diceroll_*.snap",
  },
  {
    id: "apk",
    platform: "android",
    arch: "arm64",
    format: "apk",
    match: "Diceroll-*.apk",
  },
];

async function repo(
  distribution = DISTRIBUTION,
  artifacts: object[] = [
    {
      id: "win",
      platform: "windows",
      arch: "x86_64",
      format: "msi",
      match: "Diceroll-*.msi",
    },
  ],
): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pkey-channel-sync-"));
  await mkdir(path.join(cwd, ".pkey"));
  const w = (f: string, v: unknown) =>
    writeFile(path.join(cwd, ".pkey", f), JSON.stringify(v));
  await w("product.json", {
    slug: "diceroll",
    name: "Diceroll",
    modules: { release: { enabled: true }, distribution: { enabled: true } },
  });
  await w("release.json", {
    release: {
      provider: { type: "github", owner: "vlad", repo: "diceroll" },
      deliverables: {
        app: {
          kind: "app",
          artifacts,
        },
      },
    },
  });
  await w("schema.json", { schemaVersion: 1, entries: [] });
  await writeFile(path.join(cwd, ".pkey/distribution.yaml"), distribution);
  return cwd;
}

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** A fake Worker (inputs, report-back) and a fake GitHub. `broken` stores answer 500. */
function world(broken: string[] = []) {
  const seen: Seen[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    seen.push(s);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const pr = /\/distribution\/pr\/([a-z]+)/.exec(s.url);
    if (pr) {
      if (broken.includes(pr[1]!))
        return reply(500, { error: "internal", message: "boom" });
      return reply(200, {
        ok: true,
        inputs: pr[1] === "winget" ? WINGET : FLATHUB_INPUTS,
      });
    }
    if (s.url.endsWith("/distribution/report"))
      return reply(200, {
        ok: true,
        type: "store-step",
        step: {
          opId: "op",
          state: s.body.state,
          replayed: false,
          verdict: "in-review",
        },
      });
    const p = s.url.replace("https://api.github.com", "");
    if (p === "/user") return reply(200, { login: "vlad" });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p) && s.method === "GET")
      return reply(200, { default_branch: "master" });
    if (p.endsWith("/forks"))
      return reply(202, { full_name: "vlad/winget-pkgs" });
    if (p.endsWith("/merge-upstream")) return reply(200, {});
    if (p.includes("/git/ref/heads/master"))
      return reply(200, { object: { sha: "b0" } });
    if (p.includes("/git/ref/heads/"))
      return reply(404, { message: "Not Found" });
    if (p.includes("/git/commits/")) return reply(200, { tree: { sha: "t0" } });
    if (p.endsWith("/git/trees")) return reply(201, { sha: "t1" });
    if (p.endsWith("/git/commits")) return reply(201, { sha: "c1" });
    if (p.endsWith("/git/refs")) return reply(201, {});
    if (p.includes("/pulls?")) return reply(200, []);
    if (p.startsWith("/search/issues")) return reply(200, { items: [] });
    if (p.includes("/contents/")) return reply(404, { message: "Not Found" });
    if (p.endsWith("/pulls") && s.method === "POST")
      return reply(201, {
        number: 9001,
        html_url: "https://github.com/microsoft/winget-pkgs/pull/9001",
        state: "open",
        merged_at: null,
        labels: [],
        title: s.body.title,
      });
    throw new Error(`unexpected ${s.method} ${s.url}`);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function sync(
  cwd: string,
  args: string[],
  opts: {
    env?: Record<string, string | undefined>;
    w?: ReturnType<typeof world>;
  } = {},
) {
  const w = opts.w ?? world();
  let out = "";
  let err = "";
  const code = await runPkey(["channel", "sync", "--base-url", BASE, ...args], {
    cwd,
    stdout: { write: (s: string) => ((out += s), true) } as never,
    stderr: { write: (s: string) => ((err += s), true) } as never,
    env: opts.env ?? ENV,
    fetchImpl: w.fetchImpl,
    sleep: async () => {},
  });
  return { code, out, err, w };
}

describe("pkey channel sync (A-25.3)", () => {
  it("plans a mixed .pkey/distribution: pr and ci channels only, with the skip reasons", () => {
    const rows = planSync(
      [
        { id: "flathub", kind: "flathub", identity: {} },
        { id: "winget", kind: "winget", identity: {} },
        { id: "itch", kind: "itch", identity: {} },
        { id: "snap", kind: "snap", identity: {} },
        { id: "steam", kind: "steam", identity: {} },
        {
          id: "direct",
          kind: "direct",
          identity: { homebrewCask: "d", scoop: "d" },
        },
        { id: "fdroid", kind: "fdroid-repo", identity: {} },
      ],
      { env: { PKEY_PR_TOKEN: "x", BUTLER_API_KEY: "y" } },
    );
    expect(
      rows.map((r) => [r.outlet, r.channel, r.step, r.state, r.reason ?? null]),
    ).toEqual([
      ["flathub", "flathub", "pr", "planned", null],
      ["winget", "winget", "pr", "planned", null],
      ["itch", "itch", "local-files", "skipped", "needs-dir"],
      ["snap", "snap", "local-files", "skipped", "missing-secret"],
      ["direct", "homebrew", "pr", "planned", null],
      ["direct", "scoop", "pr", "planned", null],
      ["fdroid", "fdroid", "local-files", "skipped", "missing-secret"],
    ]);
    expect(rows[3]!.secret).toBe("SNAPCRAFT_STORE_CREDENTIALS");
  });

  it("a PR channel runs through the PR runner and reports into the ledger", async () => {
    const cwd = await repo(
      "outlets:\n  winget:\n    packageIdentifier: Vlad.Diceroll\n",
    );
    const r = await sync(cwd, []);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain(
      "opened https://github.com/microsoft/winget-pkgs/pull/9001",
    );
    expect(r.out).toContain("diceroll · track stable: 1 done");
    const states = r.w.seen
      .filter((s) => s.url.endsWith("/distribution/report"))
      .map((s) => s.body.state);
    expect(states).toEqual(["pending", "done"]);
    expect(
      r.out +
        r.err +
        JSON.stringify(r.w.seen.filter((s) => s.url.endsWith("/report"))),
    ).not.toContain("github_pat_fake");
  });

  it("a missing PKEY_PR_TOKEN skips with the name; no secret value is printed", async () => {
    const cwd = await repo();
    const { PKEY_PR_TOKEN: _t, ...env } = ENV;
    const r = await sync(cwd, [], {
      env: { ...env, BUTLER_API_KEY: "butler-secret-value" },
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("winget: skipped: PKEY_PR_TOKEN is not set");
    expect(r.out).toContain("flathub: skipped: PKEY_PR_TOKEN is not set");
    expect(r.out).toContain("itch: skipped: needs --dir");
    expect(r.out).toContain(
      "snap: skipped: SNAPCRAFT_STORE_CREDENTIALS is not set",
    );
    expect(r.out).not.toContain("steam");
    expect(r.out).not.toContain("butler-secret-value");
    expect(r.w.seen).toHaveLength(0);
  });

  it("one failure fails the run after the others ran", async () => {
    const cwd = await repo();
    const r = await sync(cwd, [], { w: world(["flathub"]) });
    expect(r.code).toBe(1);
    // flathub is first and fails; winget still opened its PR.
    expect(r.out).toMatch(/flathub: failed: /);
    expect(r.out).toContain(
      "winget: opened https://github.com/microsoft/winget-pkgs/pull/9001",
    );
    // the verdict comes first, failures before the rest, and no closing count
    expect(r.out.split("\n")[0]).toBe(
      "✗  diceroll · track stable: 1 failed, 1 done, 2 skipped",
    );
    expect(r.out).not.toMatch(/^1 done/m);
  });

  it("--dry-run runs nothing", async () => {
    const cwd = await repo();
    const r = await sync(cwd, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.w.seen).toHaveLength(0);
    expect(r.out).toContain("flathub: would open a pull request");
    expect(r.out.split("\n")[0]).toBe(
      "◆  diceroll · track stable · dry run: 2 planned, 2 skipped",
    );
  });

  it("--json: one object, the rows with their state and reason", async () => {
    const cwd = await repo();
    const { PKEY_PR_TOKEN: _t, ...env } = ENV;
    const r = await sync(cwd, ["--json", "--dry-run"], { env });
    const j = JSON.parse(r.out);
    expect(r.out.trimEnd().split("\n")).toHaveLength(1);
    expect(j).toMatchObject({
      v: 1,
      command: "channel sync",
      event: "result",
      ok: true,
      exit: 0,
      dryRun: true,
      product: "diceroll",
      track: "stable",
    });
    expect(j.channel).toBeUndefined();
    const by = (id: string) =>
      j.steps.find((x: { outlet: string }) => x.outlet === id);
    expect(j.steps.map((x: { outlet: string }) => x.outlet)).toEqual([
      "flathub",
      "itch",
      "snap",
      "winget",
    ]);
    expect(by("winget")).toEqual({
      outlet: "winget",
      channel: "winget",
      step: "pr",
      state: "skipped",
      reason: "missing-secret",
      secret: "PKEY_PR_TOKEN",
    });
    expect(by("snap")).toMatchObject({
      step: "local-files",
      reason: "missing-secret",
      secret: "SNAPCRAFT_STORE_CREDENTIALS",
    });
  });

  it("no pr or ci outlet is a clear exit 0", async () => {
    const cwd = await repo("outlets:\n  steam:\n    appId: 480\n");
    const r = await sync(cwd, []);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "Nothing to sync. Sync covers winget, Homebrew, Scoop, Flathub, itch.io, Snap and F-Droid; add one with pkey channel add <id>.\n",
    );
  });

  it("an option it does not know exits 2 before anything runs", async () => {
    const cwd = await repo();
    const r = await sync(cwd, ["--dryrun"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("✗  Unknown option --dryrun. Did you mean --dry-run?\n");
    expect(r.out).toBe("");
    expect(r.w.seen).toHaveLength(0);
    const extra = await sync(cwd, ["extra"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("pkey channel sync");
    expect(extra.err).not.toContain("channel add");
  });

  it("PKEY_BASE_URL and --product come from the context, like the other commands", async () => {
    const cwd = await repo(
      "outlets:\n  winget:\n    packageIdentifier: Vlad.Diceroll\n",
    );
    const w = world();
    let out = "";
    const code = await runPkey(["channel", "sync"], {
      cwd,
      stdout: { write: (s: string) => ((out += s), true) } as never,
      stderr: { write: () => true } as never,
      env: { ...ENV, PKEY_BASE_URL: BASE },
      fetchImpl: w.fetchImpl,
      sleep: async () => {},
    });
    expect(code, out).toBe(0);
    expect(w.seen[0]!.url.startsWith(BASE)).toBe(true);
    const other = await sync(cwd, ["--product", "elsewhere"]);
    expect(other.code).toBe(2);
    expect(other.err).toContain("--product elsewhere does not match");
  });

  it("--channel is the release track: a distribution channel id is refused", async () => {
    const cwd = await repo();
    const r = await sync(cwd, ["--channel", "itch", "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      "--channel is the release track (stable, beta, dev, …); itch is a distribution channel.\n",
    );
    const beta = await sync(cwd, ["--channel", "beta", "--dry-run"]);
    expect(beta.code).toBe(0);
    expect(beta.out).toContain("diceroll · track beta · dry run");
  });

  it("a missing CI credential fails once, before any step, --dry-run too", async () => {
    const cwd = await repo();
    const { PKEY_CI_TOKEN: _t, ...env } = ENV;
    for (const args of [[], ["--dry-run"]]) {
      const r = await sync(cwd, args, { env });
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        "✗  No CI credential: in GitHub Actions add permissions: id-token: write; elsewhere set PKEY_CI_TOKEN.\n",
      );
      expect(r.out).toBe("");
      expect(r.w.seen).toHaveLength(0);
    }
    const j = await sync(cwd, ["--json"], { env });
    expect(JSON.parse(j.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "no-ci-credential",
    });
    // the job's OIDC grant counts
    const oidc = await sync(cwd, ["--dry-run"], {
      env: {
        ...env,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://x.invalid/t",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      },
    });
    expect(oidc.code).toBe(0);
  });

  it("with no manifest, --json prints validate's no-manifest shape", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pkey-channel-sync-"));
    const r = await sync(cwd, ["--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({
      ok: false,
      exit: 1,
      error: "no-manifest",
    });
  });

  it("Flathub before its first submission is a skip with its fix, not a failure", async () => {
    const cwd = await repo(
      "outlets:\n  flathub:\n    appId: gg.vlad.Diceroll\n  winget:\n    packageIdentifier: Vlad.Diceroll\n",
    );
    const r = await sync(cwd, []);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain(
      "▲  flathub: skipped: the first submission is by hand (pkey storefront flathub init)",
    );
    expect(r.out.split("\n")[0]).toBe(
      "✓  diceroll · track stable: 1 done, 1 skipped",
    );
  });

  it("rows are named by channel, with the outlet id when it differs", async () => {
    const cwd = await repo(
      "outlets:\n  homebrew:\n    kind: direct\n    scoopBucket: vlad/bucket\n",
    );
    const r = await sync(cwd, ["--dry-run"]);
    expect(r.out).toContain("scoop (homebrew): would open a pull request");
  });
});

describe("pkey channel sync --dir (A-25.4)", () => {
  const LOCAL =
    "outlets:\n  itch:\n    target: vlad/diceroll\n  snap:\n    name: diceroll\n";
  const ENV2 = {
    ...ENV,
    BUTLER_API_KEY: "butler-secret-value",
    SNAPCRAFT_STORE_CREDENTIALS: "snap-secret-value",
  };
  async function build(files: string[], distribution = LOCAL) {
    const cwd = await repo(distribution, ARTIFACTS);
    await mkdir(path.join(cwd, "dist"));
    for (const f of files) await writeFile(path.join(cwd, "dist", f), "x");
    return cwd;
  }
  /** `channel sync` through the dispatcher, with a fake vendor tool and a fake ledger. */
  async function run(
    cwd: string,
    args: string[],
    env: Record<string, string> = ENV2,
  ) {
    const runs: string[][] = [];
    const spawnTool: SpawnTool = async (tool, argv) => (
      runs.push([tool, ...argv]),
      0
    );
    const w = world();
    let out = "";
    const flags: Record<string, string | boolean> = { "base-url": BASE };
    for (let i = 0; i < args.length; i++) {
      const k = args[i]!.replace(/^--/, "");
      flags[k] =
        args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : true;
    }
    const code = await cmdChannel(
      { positional: ["sync"], flags, multi: {} },
      {
        cwd,
        env,
        stdout: { write: (s: string) => ((out += s), true) } as never,
        stderr: { write: () => true } as never,
        fetchImpl: w.fetchImpl,
        sleep: async () => {},
        spawnTool,
      },
    );
    return { code, out, runs, w };
  }

  it("a windows and a linux zip push twice, one channel word each", async () => {
    const cwd = await build([
      "Diceroll-1.2.0-win.zip",
      "Diceroll-1.2.0-linux.zip",
    ]);
    const r = await run(cwd, ["--dir", "dist", "--version", "1.2.0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.runs).toEqual([
      [
        "butler",
        "push",
        "dist/Diceroll-1.2.0-win.zip",
        "vlad/diceroll:windows",
        "--userversion",
        "1.2.0",
      ],
      [
        "butler",
        "push",
        "dist/Diceroll-1.2.0-linux.zip",
        "vlad/diceroll:linux",
        "--userversion",
        "1.2.0",
      ],
    ]);
    expect(r.out).toContain("itch: pushed windows");
    expect(r.out).toContain("itch: pushed linux");
    expect(r.out).toContain("snap: skipped: no fitting file under --dir");
    expect(r.out).not.toContain("butler-secret-value");
    // each step is reported into the ledger around the run
    expect(r.w.seen.filter((s) => s.url.endsWith("/report"))).toHaveLength(4);
  });

  it("a release channel suffixes the butler channel; a tag supplies the version", async () => {
    const cwd = await build(["Diceroll-1.2.0-win.zip"]);
    const r = await run(cwd, ["--dir", "dist", "--channel", "beta"], {
      ...ENV2,
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.2.0",
    });
    expect(r.runs[0]).toContain("vlad/diceroll:windows-beta");
    expect(r.runs[0]!.at(-1)).toBe("1.2.0");
  });

  it("a .snap uploads to the lanes the outlet maps the channel onto", async () => {
    const cwd = await build(["diceroll_1.2.0_amd64.snap"]);
    const r = await run(cwd, ["--dir", "dist"]);
    expect(r.code, r.out).toBe(0);
    expect(r.runs).toEqual([
      [
        "snapcraft",
        "upload",
        "dist/diceroll_1.2.0_amd64.snap",
        "--release=stable",
      ],
    ]);
    expect(r.out).toContain("snap: uploaded");
    expect(r.out).toContain("itch: skipped: no fitting file under --dir");
  });

  it("no fitting file is a skip line, exit 0", async () => {
    const cwd = await build(["README.txt"]);
    const r = await run(cwd, ["--dir", "dist"]);
    expect(r.code, r.out).toBe(0);
    expect(r.runs).toHaveLength(0);
    expect(r.out).toContain("itch: skipped: no fitting file under --dir");
    expect(r.out).toContain("snap: skipped: no fitting file under --dir");
  });

  it("a missing secret skips by name; itch without a version fails after the rest ran", async () => {
    const cwd = await build([
      "Diceroll-1.2.0-win.zip",
      "diceroll_1.2.0_amd64.snap",
    ]);
    const { SNAPCRAFT_STORE_CREDENTIALS: _s, ...noSnap } = ENV2;
    const r = await run(cwd, ["--dir", "dist"], noSnap);
    expect(r.code).toBe(1);
    expect(r.out).toContain("itch: failed: --version is required");
    expect(r.out).toContain(
      "snap: skipped: SNAPCRAFT_STORE_CREDENTIALS is not set",
    );
    expect(r.out).not.toContain("snap-secret-value");
  });

  it("--dry-run prints the checked argv and runs nothing", async () => {
    const cwd = await build([
      "Diceroll-1.2.0-linux.zip",
      "diceroll_1.2.0_amd64.snap",
    ]);
    const r = await run(cwd, [
      "--dir",
      "dist",
      "--version",
      "1.2.0",
      "--dry-run",
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.runs).toHaveLength(0);
    expect(r.w.seen).toHaveLength(0);
    expect(r.out).toContain(
      "itch: would run butler push dist/Diceroll-1.2.0-linux.zip vlad/diceroll:linux --userversion 1.2.0",
    );
    expect(r.out).toContain(
      "snap: would run snapcraft upload dist/diceroll_1.2.0_amd64.snap --release=stable",
    );
  });

  it("the allow-list is the control: a file name it refuses fails the row, nothing runs", async () => {
    const cwd = await build(["Diceroll-1.2.0$(x)-win.zip"]);
    const r = await run(cwd, ["--dir", "dist", "--version", "1.2.0"]);
    expect(r.code).toBe(1);
    expect(r.runs).toHaveLength(0);
    expect(r.out).toMatch(/itch: failed: /);
  });

  it("the F-Droid row plans from an .apk and names the keystore env it waits on", async () => {
    const dist = "outlets:\n  fdroid:\n    kind: fdroid-repo\n";
    const cwd = await build(["Diceroll-1.2.0.apk"], dist);
    const env = { ...ENV, PKEY_FDROID_KS_PASS: "ks-secret-value" };
    const a = await run(cwd, ["--dir", "dist", "--dry-run"], env);
    expect(a.out).toContain("fdroid: skipped: PKEY_FDROID_KEYSTORE is not set");
    const b = await run(cwd, ["--dir", "dist", "--dry-run"], {
      ...env,
      PKEY_FDROID_KEYSTORE: "ci.jks",
      PKEY_FDROID_ALIAS: "repo",
    });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain(
      "fdroid: would run pkey storefront fdroid --product diceroll --channel stable --out fdroid-repo --keystore ci.jks --alias repo",
    );
    expect(a.out + b.out).not.toContain("ks-secret-value");
  });
});

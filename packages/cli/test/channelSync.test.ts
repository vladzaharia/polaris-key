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

async function repo(distribution = DISTRIBUTION): Promise<string> {
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
          artifacts: [
            {
              id: "win",
              platform: "windows",
              arch: "x86_64",
              format: "msi",
              match: "Diceroll-*.msi",
            },
          ],
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
    expect(r.out).toContain("1 done");
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
    expect(r.out).toContain("1 done, 2 skipped, 1 failed");
  });

  it("--dry-run runs nothing", async () => {
    const cwd = await repo();
    const r = await sync(cwd, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.w.seen).toHaveLength(0);
    expect(r.out).toContain("flathub: would open a pull request");
    expect(r.out).toContain("2 planned, 2 skipped");
  });

  it("--json: one object, the rows with their state and reason", async () => {
    const cwd = await repo();
    const { PKEY_PR_TOKEN: _t, ...env } = ENV;
    const r = await sync(cwd, ["--json", "--dry-run"], { env });
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({
      ok: true,
      dryRun: true,
      product: "diceroll",
      channel: "stable",
    });
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
      store: "winget",
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
    expect(r.out).toContain("Nothing to sync");
  });
});

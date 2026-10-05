/**
 * A-18h — the CI-plane storefront steps: the command allow-list the CLI enforces (over the
 * generated copy of the Worker's declaration), the itch.io and Snap command plans, the step
 * runner's report-back (`POST /<p>/distribution/report`, `type: "store-step"`) against a fake
 * Worker and a fake vendor tool, snapcraft.yaml metadata, and the Action's storefront input. The
 * Worker side (re-check, ledger row with `plane = 'ci'`) is
 * `packages/worker/test/storefront/storeSteps.test.ts`.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import { runAction } from "../src/action.js";
import { CI_PLANE } from "../src/storefronts/ciPlane.generated.js";
import {
  checkCiCommand,
  ciLiterals,
  ciStore,
  matchCiCommand,
} from "../src/storefronts/allowList.js";
import { itchChannel, itchPushStep } from "../src/storefronts/itch.js";
import {
  checkStep,
  checkToolPath,
  commandLine,
  runStoreSteps,
  stepRunId,
  toolEnv,
  vdfSetliveProblem,
  type SpawnTool,
  type StoreStep,
} from "../src/storefronts/run.js";
import {
  applySnapMetadata,
  snapMetadataFields,
  snapUploadMetadataStep,
  snapUploadStep,
} from "../src/storefronts/snap.js";

const BASE = "https://key.example.test";
const CI_TOKEN = `pkeyci_${"A".repeat(43)}`;
const ENV = {
  PKEY_CI_TOKEN: CI_TOKEN,
  GITHUB_RUN_ID: "424242",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "acme/dice",
};

const ITCH = {
  id: "itch",
  kind: "itch",
  identity: { target: "acme/dice", gameId: "1001" },
};
const SNAP = {
  id: "snap",
  kind: "snap",
  identity: { name: "dice", channels: { stable: "stable", beta: "beta" } },
};

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    stderr: { write: (c: string) => ((err += c), true) },
    out: () => out,
    err: () => err,
  };
}

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function fakeWorker(
  answer: (s: Seen) => [number, unknown] = (s) => [
    200,
    {
      ok: true,
      type: "store-step",
      step: { opId: "op1", state: s.body.state, replayed: false },
    },
  ],
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {},
    };
    seen.push(s);
    const [status, body] = answer(s);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function fakeTool(exit = 0) {
  const runs: { tool: string; argv: string[] }[] = [];
  const spawnTool: SpawnTool = async (tool, argv) => {
    runs.push({ tool, argv: [...argv] });
    return exit;
  };
  return { runs, spawnTool };
}

async function repo(distribution: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pkey-storefront-"));
  await mkdir(path.join(cwd, ".pkey"));
  await writeFile(
    path.join(cwd, ".pkey/product.json"),
    JSON.stringify({
      slug: "dice",
      name: "Dice",
      modules: {
        release: { enabled: true },
        distribution: { enabled: true },
      },
    }),
  );
  await writeFile(
    path.join(cwd, ".pkey/release.json"),
    JSON.stringify({
      release: {
        provider: { type: "github", owner: "acme", repo: "dice" },
        deliverables: {
          app: {
            kind: "app",
            artifacts: [
              {
                id: "win",
                platform: "windows",
                arch: "x86_64",
                format: "zip",
                match: "Dice-*.zip",
              },
            ],
          },
        },
      },
    }),
  );
  await writeFile(
    path.join(cwd, ".pkey/schema.json"),
    JSON.stringify({ schemaVersion: 1, entries: [] }),
  );
  await writeFile(path.join(cwd, ".pkey/distribution.yaml"), distribution);
  return cwd;
}

const DISTRIBUTION = `outlets:
  itch:
    target: acme/dice
    gameId: 1001
  snap:
    name: dice
    channels:
      stable: stable
      beta: beta
  ms-store:
    productId: 9NBLGGH4R315
`;

// ── The allow-list over the generated copy ───────────────────────────────────────────────────

describe("the CI allow-list in the CLI (A-18h)", () => {
  for (const s of CI_PLANE.stores)
    it(`${s.store}: refuses every never-list command and spells no never-token`, () => {
      for (const argv of s.never)
        expect(matchCiCommand(s.list, argv), argv.join(" ")).toBeNull();
      const literals = ciLiterals(s.list).map((l) => l.toLowerCase());
      for (const t of s.neverTokens)
        expect(
          literals.filter((l) => l.includes(t)),
          t,
        ).toEqual([]);
    });

  it("checks values, the never-list and the outlet identity like the Worker", () => {
    const butler = ciStore("itch")!.list;
    const argv = [
      "push",
      "build",
      "acme/dice:windows",
      "--userversion",
      "1.0.0",
    ];
    expect(checkCiCommand(butler, "push", argv, ITCH.identity)).toBeNull();
    expect(checkCiCommand(butler, "push", argv)).toBe("identity_required");
    expect(checkCiCommand(butler, "push", argv, { target: "evil/game" })).toBe(
      "identity_mismatch",
    );
    expect(
      checkCiCommand(
        butler,
        "push",
        [...argv.slice(0, 4), "--x"],
        ITCH.identity,
      ),
    ).toBe("value_not_allowed");
    expect(checkCiCommand(butler, "wipe", [])).toBe("not_allowed");
  });
});

// ── The command plans ───────────────────────────────────────────────────────────────────────

describe("the itch.io and Snap command plans", () => {
  it("itch push targets the identity's game on a platform channel, suffixed for non-stable channels", () => {
    const step = itchPushStep({
      outlet: ITCH,
      dir: "build/windows",
      platform: "windows",
      channel: "beta",
      version: "1.2.0",
    });
    expect(step).toMatchObject({
      store: "itch",
      op: "uploadBuild",
      command: "push",
      tool: "butler",
      argv: [
        "push",
        "build/windows",
        "acme/dice:windows-beta",
        "--userversion",
        "1.2.0",
      ],
    });
    expect(() => checkStep(step)).not.toThrow();
    expect(itchChannel("linux")).toBe("linux");
    expect(itchChannel("mac", "stable")).toBe("mac");
    expect(() => itchChannel("switch")).toThrow(/--platform must be one of/);
    expect(() => itchChannel("windows", "Beta Two")).toThrow(/cannot suffix/);
  });

  it("snap upload releases only to the snap channels the identity maps", () => {
    const step = snapUploadStep({
      outlet: SNAP,
      snap: "dist/dice_1.2.0_amd64.snap",
      channels: ["beta", "stable", "beta"],
    });
    expect(step.argv).toEqual([
      "upload",
      "dist/dice_1.2.0_amd64.snap",
      "--release=beta,stable",
    ]);
    expect(() => checkStep(step)).not.toThrow();
    expect(() =>
      snapUploadStep({ outlet: SNAP, snap: "d.snap", channels: ["nightly"] }),
    ).toThrow(/maps no snap channel for nightly/);
    expect(() =>
      snapUploadStep({
        outlet: { ...SNAP, identity: { name: "dice" } },
        snap: "d.snap",
        channels: ["stable"],
      }),
    ).toThrow(/declares no channels/);
    // A hand-built step to an unmapped channel is refused by the allow-list itself.
    expect(() =>
      checkStep({ ...step, argv: ["upload", "d.snap", "--release=edge"] }),
    ).toThrow(/does not declare/);
    expect(() => checkStep(snapUploadMetadataStep("d.snap"))).not.toThrow();
  });

  it("refuses a Steam build script that sets the default or public branch live", () => {
    expect(vdfSetliveProblem('"AppBuild" { "setlive" "beta" }')).toBeNull();
    expect(vdfSetliveProblem('"AppBuild" { "SetLive" "" }')).toBeNull();
    expect(vdfSetliveProblem('"AppBuild" { "setlive" "public" }')).toMatch(
      /public/,
    );
    expect(vdfSetliveProblem('"appbuild" { "setlive" "Default" }')).toMatch(
      /default/,
    );
    // KeyValues accepts unquoted keys and values, in any mix.
    expect(vdfSetliveProblem('"appbuild"{ setlive public }')).toMatch(/public/);
    expect(vdfSetliveProblem('"appbuild"{ "setlive" public }')).toMatch(
      /public/,
    );
    expect(vdfSetliveProblem('"appbuild"{ setlive "default" }')).toMatch(
      /default/,
    );
    expect(vdfSetliveProblem("appbuild{setlive\tdefault}")).toMatch(/default/);
    expect(vdfSetliveProblem('"appbuild"{ setlive beta }')).toBeNull();
    // A comment between key and value does not hide the value.
    expect(
      vdfSetliveProblem('"appbuild"{ "setlive" // go live\n "public" }'),
    ).toMatch(/public/);
    // Backslashes are read both ways a parser may treat them.
    expect(
      vdfSetliveProblem('"appbuild"{ "desc" "a\\" "setlive" "public" }'),
    ).toMatch(/public/);
    // A comment inside an unquoted token is caught by the raw fallback.
    expect(
      vdfSetliveProblem('"appbuild"{ "desc" b//"\n"setlive" "public" }'),
    ).toMatch(/public/);
    // A key with no value, and a file pulled in from elsewhere, are refused.
    expect(vdfSetliveProblem('"appbuild"{ "setlive" }')).toMatch(
      /without a branch/,
    );
    expect(vdfSetliveProblem('#include "live.vdf"\n"appbuild"{ }')).toMatch(
      /#include/,
    );
    expect(vdfSetliveProblem('#base live.vdf\n"appbuild"{ }')).toMatch(/#base/);
  });

  it("lets --tool-path name only the declared tool", () => {
    expect(() =>
      checkToolPath("/opt/steam/steamcmd.sh", "steamcmd"),
    ).not.toThrow();
    expect(() =>
      checkToolPath("C:\\Tools\\BuildPatchTool.exe", "BuildPatchTool"),
    ).not.toThrow();
    expect(() => checkToolPath("/bin/sh", "butler")).toThrow(/butler itself/);
    expect(() => checkToolPath("/tmp/butler-evil", "butler")).toThrow(
      /butler itself/,
    );
  });

  it("keeps the CI token and OIDC request variables from the vendor tool", () => {
    expect(
      toolEnv({
        PATH: "/usr/bin",
        BUTLER_API_KEY: "k",
        PKEY_TOKEN: "t",
        ACTIONS_ID_TOKEN_REQUEST_URL: "u",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r",
      }),
    ).toEqual({ PATH: "/usr/bin", BUTLER_API_KEY: "k" });
  });

  it("prints copyable command lines and a run id per job attempt", () => {
    expect(commandLine("butler", ["push", "my build", "a/b:windows"])).toBe(
      "butler push 'my build' a/b:windows",
    );
    expect(stepRunId(ENV)).toBe("gh-424242-2");
    expect(stepRunId({ PKEY_RUN_ID: "deploy-0001" })).toBe("deploy-0001");
    expect(stepRunId({})).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ── The runner ──────────────────────────────────────────────────────────────────────────────

describe("runStoreSteps: allow-list, report-back, tool", () => {
  const push: StoreStep = itchPushStep({
    outlet: ITCH,
    dir: "build/windows",
    platform: "windows",
    version: "1.2.0",
  });
  const opts = (
    w: ReturnType<typeof fakeWorker>,
    t: ReturnType<typeof fakeTool>,
  ) => ({
    cwd: process.cwd(),
    product: "dice",
    baseUrl: BASE,
    env: ENV,
    ...capture(),
    fetchImpl: w.fetchImpl,
    sleep: async () => {},
    spawnTool: t.spawnTool,
  });

  it("reports pending, runs the tool without a shell, then reports done", async () => {
    const w = fakeWorker();
    const t = fakeTool(0);
    const outcomes = await runStoreSteps([push], opts(w, t));
    expect(outcomes.map((o) => o.outcome)).toEqual(["ran"]);
    expect(t.runs).toEqual([{ tool: "butler", argv: push.argv }]);
    expect(w.seen.map((s) => [s.url, s.body.state])).toEqual([
      [`${BASE}/dice/distribution/report`, "pending"],
      [`${BASE}/dice/distribution/report`, "done"],
    ]);
    expect(w.seen[1]!.body).toEqual({
      type: "store-step",
      store: "itch",
      op: "uploadBuild",
      command: "push",
      argv: push.argv,
      outlet: "itch",
      runId: "gh-424242-2",
      state: "done",
      exitCode: 0,
      runUrl: "https://github.com/acme/dice/actions/runs/424242",
    });
  });

  it("reports a failure with the exit code and stops", async () => {
    const w = fakeWorker();
    const t = fakeTool(3);
    await expect(
      runStoreSteps([push, snapUploadMetadataStep("d.snap")], opts(w, t)),
    ).rejects.toThrow(/butler exited 3/);
    expect(t.runs).toHaveLength(1);
    expect(w.seen.map((s) => [s.body.state, s.body.exitCode])).toEqual([
      ["pending", undefined],
      ["failed", 3],
    ]);
  });

  it("skips a step the Worker says is already done in this run", async () => {
    const w = fakeWorker(() => [
      200,
      {
        ok: true,
        type: "store-step",
        step: { opId: "op1", state: "done", replayed: true },
      },
    ]);
    const t = fakeTool(0);
    const outcomes = await runStoreSteps([push], opts(w, t));
    expect(outcomes[0]!.outcome).toBe("skipped");
    expect(t.runs).toEqual([]);
    expect(w.seen).toHaveLength(1);
  });

  it("runs nothing when the Worker refuses the step (a Worker-staged msstore draft)", async () => {
    const w = fakeWorker(() => [
      409,
      {
        error: "bad_request",
        reason: "worker_draft_staged",
        message: "Microsoft Store has a draft the console staged",
      },
    ]);
    const t = fakeTool(0);
    const publish: StoreStep = {
      store: "msstore",
      op: "uploadBuild",
      command: "publish",
      tool: "msstore",
      argv: ["publish", "build/Dice.msixupload", "--appId", "9NBLGGH4R315"],
      outlet: {
        id: "ms-store",
        kind: "ms-store",
        identity: { productId: "9NBLGGH4R315" },
      },
    };
    await expect(runStoreSteps([publish], opts(w, t))).rejects.toThrow(
      /Nothing ran: msstore publish/,
    );
    expect(t.runs).toEqual([]);
    await expect(
      runStoreSteps([publish], { ...opts(w, t), report: false }),
    ).rejects.toThrow(/needs report-back/);
  });

  it("refuses before reporting or running anything when a step is outside the allow-list", async () => {
    const w = fakeWorker();
    const t = fakeTool(0);
    await expect(
      runStoreSteps([push, { ...push, argv: ["login"] }], opts(w, t)),
    ).rejects.toThrow(/Refused by the CI allow-list/);
    expect(w.seen).toEqual([]);
    expect(t.runs).toEqual([]);
  });

  it("a dry run checks and prints, and neither reports nor runs", async () => {
    const w = fakeWorker();
    const t = fakeTool(0);
    const o = opts(w, t);
    await runStoreSteps([push], { ...o, dryRun: true });
    expect(o.out()).toContain(
      "Would run: butler push build/windows acme/dice:windows --userversion 1.2.0",
    );
    expect(w.seen).toEqual([]);
    expect(t.runs).toEqual([]);
  });
});

// ── snapcraft.yaml ──────────────────────────────────────────────────────────────────────────

describe("the Snap listing in snapcraft.yaml", () => {
  const projection = {
    store: "snap",
    exists: true,
    defaultLocale: "en-US",
    status: "green" as const,
    payload: {
      app: {},
      locales: {
        "en-US": {
          title: "Dice",
          summary: "Roll dice",
          description: "Line one.\nLine two.",
        },
      },
    },
    issues: [],
  };

  it("replaces summary and description and keeps the rest, comments included", () => {
    const before = `# the snap\nname: dice # keep\nsummary: old\ndescription: old\ngrade: stable\n`;
    const after = applySnapMetadata(before, snapMetadataFields(projection));
    expect(after).toContain("# the snap");
    expect(after).toContain("name: dice # keep");
    expect(after).toContain("summary: Roll dice");
    expect(after).toContain("description: |-\n  Line one.\n  Line two.");
    expect(after).toContain("grade: stable");
  });

  it("refuses a blocked projection and a file that is not a snapcraft.yaml", () => {
    expect(() =>
      snapMetadataFields({
        ...projection,
        exists: false,
        payload: null,
        issues: [{ field: "summary", locale: "en-US", issue: "missing" }],
      }),
    ).toThrow(
      /blocked \(the product has no listing yet\): summary \(en-US\): missing/,
    );
    expect(() =>
      applySnapMetadata("foo: 1\n", { summary: "a", description: "b" }),
    ).toThrow(/no top-level name/);
  });
});

// ── The commands and the Action ─────────────────────────────────────────────────────────────

describe("pkey storefront and the Action's storefront input", () => {
  it("pkey storefront itch push --dry-run reads the outlet from .pkey/distribution", async () => {
    const cwd = await repo(DISTRIBUTION);
    const io = capture();
    const code = await runPkey(
      [
        "storefront",
        "itch",
        "push",
        "--platform",
        "linux",
        "--dir",
        "build/linux",
        "--version",
        "1.2.0",
        "--channel",
        "beta",
        "--dry-run",
      ],
      { cwd, ...io, env: ENV },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(io.out()).toContain(
      "Would run: butler push build/linux acme/dice:linux-beta --userversion 1.2.0",
    );
  });

  it("pkey storefront exec runs any allow-listed command and refuses the rest", async () => {
    const cwd = await repo(DISTRIBUTION);
    const ok = capture();
    expect(
      await runPkey(
        [
          "storefront",
          "exec",
          "msstore",
          "publish",
          "--op",
          "uploadBuild",
          "--dry-run",
          "--",
          "publish",
          "build/Dice.msixupload",
          "--appId",
          "9NBLGGH4R315",
        ],
        { cwd, ...ok, env: ENV },
      ),
    ).toBe(0);
    expect(ok.out()).toContain(
      "Would run: msstore publish build/Dice.msixupload --appId 9NBLGGH4R315",
    );
    const bad = capture();
    expect(
      await runPkey(
        [
          "storefront",
          "exec",
          "msstore",
          "publish",
          "--op",
          "uploadBuild",
          "--dry-run",
          "--",
          "submission",
          "delete",
          "9NBLGGH4R315",
        ],
        { cwd, ...bad, env: ENV },
      ),
    ).toBe(1);
    expect(bad.err()).toMatch(/Refused by the CI allow-list/);
    const wrongOp = capture();
    expect(
      await runPkey(
        [
          "storefront",
          "exec",
          "snap",
          "upload-metadata",
          "--op",
          "submit",
          "--",
          "upload-metadata",
          "d.snap",
        ],
        { cwd, ...wrongOp, env: ENV },
      ),
    ).toBe(1);
    expect(wrongOp.err()).toMatch(
      /runs upload-metadata for writeListingText, not submit/,
    );
  });

  it("pkey storefront snap metadata writes the projection into snapcraft.yaml", async () => {
    const cwd = await repo(DISTRIBUTION);
    await mkdir(path.join(cwd, "snap"));
    await writeFile(
      path.join(cwd, "snap/snapcraft.yaml"),
      "name: dice\nsummary: old\ndescription: old\n",
    );
    const w = fakeWorker((s) =>
      s.method === "GET"
        ? [
            200,
            {
              ok: true,
              listing: {
                store: "snap",
                exists: true,
                defaultLocale: "en-US",
                status: "green",
                payload: {
                  app: {},
                  locales: {
                    "en-US": {
                      summary: "Roll dice",
                      description: "All of it.",
                    },
                  },
                },
                issues: [],
              },
            },
          ]
        : [500, {}],
    );
    const io = capture();
    const code = await runPkey(
      ["storefront", "snap", "metadata", "--yaml", ".", "--base-url", BASE],
      { cwd, ...io, env: ENV, fetchImpl: w.fetchImpl, sleep: async () => {} },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(w.seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", `${BASE}/dice/distribution/listing/snap`],
    ]);
    const yaml = await readFile(path.join(cwd, "snap/snapcraft.yaml"), "utf8");
    expect(yaml).toContain("summary: Roll dice");
    expect(yaml).toContain("All of it.");
  });

  it("the Action's itch-push step dry-runs through the allow-list", async () => {
    const cwd = await repo(DISTRIBUTION);
    const io = capture();
    const code = await runAction({
      cwd,
      ...io,
      env: {
        ...ENV,
        GITHUB_ACTIONS: "true",
        INPUT_PRODUCT: "dice",
        INPUT_DIR: "build/windows",
        INPUT_VERSION: "1.2.0",
        INPUT_STOREFRONT: "itch-push",
        "INPUT_ITCH-PLATFORM": "windows",
        "INPUT_DRY-RUN": "true",
        INPUT_DELIVERABLE: "app",
        "INPUT_TRANSPORT-REPORT": "true",
        "INPUT_BASE-URL": BASE,
      },
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(io.out()).toContain(
      "Would run: butler push build/windows acme/dice:windows --userversion 1.2.0",
    );
  });

  it("the Action refuses publish inputs on a storefront step and an unknown step", async () => {
    const cwd = await repo(DISTRIBUTION);
    for (const [extra, message] of [
      [
        { INPUT_STOREFRONT: "itch-push", INPUT_PINS: "a@1" },
        /pins does not apply to a storefront step/,
      ],
      [{ INPUT_STOREFRONT: "steam-push" }, /storefront must be one of/],
      [
        { "INPUT_ITCH-PLATFORM": "linux" },
        /itch-platform applies only with the storefront input/,
      ],
    ] as const) {
      const io = capture();
      const code = await runAction({
        cwd,
        ...io,
        env: {
          ...ENV,
          GITHUB_ACTIONS: "true",
          INPUT_PRODUCT: "dice",
          INPUT_DIR: "build",
          ...extra,
        },
      });
      expect(code).toBe(1);
      expect(io.err()).toMatch(message);
    }
  });
});

/**
 * P2-06, A-25.5 — the `polaris-key/publish` Action entry (eight inputs, the removed-input refusals,
 * `channels: auto`), the standalone bundle and its freshness gate, `pkey manifest schemas`, and the
 * SigV4 signer against AWS's published examples.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ACTION_INPUTS,
  actionInput,
  isActionInvocation,
  runAction,
  splitArgs,
} from "../src/action.js";
import { runPkey, signV4 } from "../src/index.js";
import {
  actionsEnv,
  BASE,
  capture,
  cleanup,
  fakeServer,
  instant,
  json,
  RELEASE_PEM,
  RELEASE_PEM_BODY,
  RELEASE_YAML_KEYED,
  repo,
  SLUG,
  tempDir,
} from "./publishFixture.js";

const run = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgDir, "..", "..");

afterEach(cleanup);

/** The step's environment: `with:` keys as GitHub passes them, plus action.yml's defaults. */
async function stepEnv(withInputs: Record<string, string>) {
  const yml = parseYaml(
    await readFile(path.join(repoRoot, "actions/publish/action.yml"), "utf8"),
  ) as { inputs: Record<string, { default?: string }> };
  const env: Record<string, string> = {};
  for (const [name, decl] of Object.entries(yml.inputs)) {
    const value = withInputs[name] ?? decl.default;
    if (value !== undefined) env[`INPUT_${name.toUpperCase()}`] = String(value);
  }
  for (const [name, value] of Object.entries(withInputs))
    if (!(name in yml.inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  return env;
}

const PUBLISH_ARGS = `--tag v0.3.0 --dir dist --base-url ${BASE}`;

async function act(
  cwd: string,
  withInputs: Record<string, string>,
  over: { GITHUB_OUTPUT?: string; fetchImpl?: typeof fetch } = {},
) {
  const io = capture();
  const server = fakeServer();
  const code = await runAction({
    env: {
      ...actionsEnv(
        over.GITHUB_OUTPUT ? { GITHUB_OUTPUT: over.GITHUB_OUTPUT } : {},
      ),
      ...(await stepEnv(withInputs)),
    },
    cwd,
    stdout: io.stdout,
    stderr: io.stderr,
    fetchImpl: over.fetchImpl ?? server.fetchImpl,
    sleep: instant,
  });
  return { code, io, server };
}

describe("the Action entry", () => {
  it("is chosen only with no argv, inside Actions, with the command input (D-A6)", () => {
    const env = { GITHUB_ACTIONS: "true", INPUT_COMMAND: "release publish" };
    expect(isActionInvocation([], env)).toBe(true);
    expect(isActionInvocation(["validate"], env)).toBe(false);
    expect(isActionInvocation([], { GITHUB_ACTIONS: "true" })).toBe(false);
    expect(isActionInvocation([], { INPUT_COMMAND: "x" })).toBe(false);
    // The old detector no longer selects the Action.
    expect(
      isActionInvocation([], { GITHUB_ACTIONS: "true", INPUT_PRODUCT: SLUG }),
    ).toBe(false);
    // GitHub upper-cases names and keeps hyphens; an unset input arrives as "".
    expect(actionInput({ "INPUT_BASE-URL": " https://x " }, "base-url")).toBe(
      "https://x",
    );
    expect(actionInput({ INPUT_CHANNEL: "" }, "channel")).toBeUndefined();
  });

  it("splits args on whitespace and newlines, quotes group, nothing expands", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("--a 1\n--b  2\n")).toEqual(["--a", "1", "--b", "2"]);
    expect(splitArgs('--notes \'two words\' --x="a b" ""')).toEqual([
      "--notes",
      "two words",
      "--x=a b",
      "",
    ]);
    expect(splitArgs("$HOME *.zip `id` $(id) ; rm -rf \\n")).toEqual([
      "$HOME",
      "*.zip",
      "`id`",
      "$(id)",
      ";",
      "rm",
      "-rf",
      "\\n",
    ]);
    expect(() => splitArgs("--a 'b")).toThrow(/unterminated/);
  });

  it("declares exactly the eight inputs, in order, with the documented defaults", async () => {
    const yml = parseYaml(
      await readFile(path.join(repoRoot, "actions/publish/action.yml"), "utf8"),
    ) as { inputs: Record<string, { default?: string }> };
    expect(Object.keys(yml.inputs)).toEqual([...ACTION_INPUTS]);
    expect(ACTION_INPUTS).toHaveLength(8);
    expect(yml.inputs.command!.default).toBe("release publish");
    expect(yml.inputs.channels!.default).toBe("auto");
    expect(yml.inputs["dry-run"]!.default).toBe("false");
    expect(yml.inputs["base-url"]!.default).toBeUndefined();
  });

  it("publishes from args and writes release-id and outcome to $GITHUB_OUTPUT", async () => {
    const cwd = await repo();
    const output = path.join(cwd, "gh_output");
    await writeFile(output, "");
    const { code, io, server } = await act(
      cwd,
      { args: PUBLISH_ARGS },
      { GITHUB_OUTPUT: output },
    );
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe(
      "release-id=v0.3.0\noutcome=created\n",
    );
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(8);
  });

  it("base-url reaches the CLI as PKEY_BASE_URL, with no flag", async () => {
    const cwd = await repo();
    const { code, io, server } = await act(cwd, {
      args: "--tag v0.3.0 --dir dist",
      "base-url": BASE,
      channels: "none",
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(server.calls.length).toBeGreaterThan(0);
  });

  it("dry-run: true uploads nothing", async () => {
    const cwd = await repo();
    const { code, server } = await act(cwd, {
      args: PUBLISH_ARGS,
      "dry-run": "true",
    });
    expect(code).toBe(0);
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
    expect(
      (server.to("/publish/submit")[0]!.body as { dryRun: boolean }).dryRun,
    ).toBe(true);
  });

  it("refuses a dry-run or channels value outside its set", async () => {
    const cwd = await repo();
    for (const [name, value, message] of [
      ["dry-run", "yes", "dry-run must be true or false"],
      ["channels", "all", "channels must be auto or none"],
    ] as const) {
      const { code, io, server } = await act(cwd, {
        args: PUBLISH_ARGS,
        [name]: value,
      });
      expect(code).toBe(1);
      expect(io.err()).toContain(message);
      expect(server.calls).toEqual([]);
    }
  });

  it("a failed command is an ::error:: annotation and exit 1, so the job fails", async () => {
    const cwd = await repo();
    const server = fakeServer();
    server.script("/token", () =>
      json(
        {
          error: "forbidden",
          reason: "policy_mismatch",
          claim: "environment",
          message: "no",
        },
        403,
      ),
    );
    const { code, io } = await act(
      cwd,
      { args: PUBLISH_ARGS },
      {
        fetchImpl: server.fetchImpl,
      },
    );
    expect(code).toBe(1);
    expect(io.out()).toMatch(
      /^::error title=pkey release publish::Exchanging the GitHub OIDC token failed \(403 policy_mismatch\).*%0A {2}failing claim: environment/m,
    );
    expect(io.err()).toContain("policy_mismatch");
  });

  it("runs another command in working-directory", async () => {
    const cwd = await tempDir();
    const sub = path.join(cwd, "app");
    await mkdir(sub);
    await writeFile(path.join(sub, "marker.txt"), "x");
    const io = capture();
    // `manifest schemas --out` is resolved against the working directory.
    const code = await runAction({
      env: {
        ...actionsEnv(),
        ...(await stepEnv({
          command: "manifest schemas",
          args: "--out vendor",
          "working-directory": "app",
        })),
      },
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect((await readdir(path.join(sub, "vendor"))).length).toBeGreaterThan(0);
    await expect(readdir(path.join(cwd, "vendor"))).rejects.toThrow();
    const missing = capture();
    const bad = await runAction({
      env: {
        ...actionsEnv(),
        ...(await stepEnv({ args: "--dir x", "working-directory": "nope" })),
      },
      cwd,
      stdout: missing.stdout,
      stderr: missing.stderr,
    });
    expect(bad).toBe(1);
    expect(missing.err()).toContain("working-directory is not a directory");
  });

  it("an unterminated quote in args fails before any network call", async () => {
    const cwd = await repo();
    const { code, io, server } = await act(cwd, { args: "--tag 'v1" });
    expect(code).toBe(1);
    expect(io.err()).toContain("unterminated");
    expect(server.calls).toEqual([]);
  });
});

describe("the Action's secrets", () => {
  it("release-key reaches the signer as PKEY_RELEASE_KEY; the key is never printed or sent", async () => {
    const cwd = await repo(undefined, RELEASE_YAML_KEYED);
    const { code, io, server } = await act(cwd, {
      args: PUBLISH_ARGS,
      "release-key": RELEASE_PEM,
      channels: "none",
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    const submit = server.to("/publish/submit")[0]!.body as { record?: string };
    expect(typeof submit.record).toBe("string");
    const seen = JSON.stringify(server.calls) + io.out() + io.err();
    expect(seen).not.toContain(RELEASE_PEM_BODY);
  });

  it("without release-key a keyed product is refused naming PKEY_RELEASE_KEY", async () => {
    const cwd = await repo(undefined, RELEASE_YAML_KEYED);
    const { code, io } = await act(cwd, { args: PUBLISH_ARGS });
    expect(code).toBe(1);
    expect(io.err()).toContain("PKEY_RELEASE_KEY");
  });

  it("keys are not on argv: a bogus command that echoes its argv never shows them", async () => {
    const cwd = await repo();
    const { code, io } = await act(cwd, {
      command: "bogus",
      "release-key": "SECRET-RELEASE-KEY-SENTINEL",
      "content-key": "SECRET-CONTENT-KEY-SENTINEL",
    });
    expect(code).toBe(1);
    const seen = io.out() + io.err();
    expect(seen).toContain("bogus");
    expect(seen).not.toContain("SENTINEL");
  });
});

describe("the Action's removed inputs (D-A2)", () => {
  const SENTINEL = "never-echo-this-value";
  const cases: [string, string][] = [
    [
      "product",
      "Input product was removed in 0.9. Put --product <value> in args.",
    ],
    [
      "deliverable",
      "Input deliverable was removed in 0.9. Put --deliverable <value> in args.",
    ],
    ["version", "Put --version <value> in args."],
    ["tag", "Put --tag <value> in args."],
    ["channel", "Put --channel <value> in args."],
    ["dir", "Input dir was removed in 0.9. Put --dir <value> in args."],
    ["source", "Put --source <value> in args."],
    ["pins", "Put --pin <value> in args."],
    ["delegation", "Put --delegation <value> in args."],
    ["itch-platform", "Put --platform <value> in args."],
    ["storefront-outlet", "Put --outlet <value> in args."],
    ["transport-report", "Put --no-report in args."],
    ["storefront", "Use channels: auto, or command: storefront"],
    ["transport", "Use command: transport <step>"],
    ["assets", "Use command: assets push"],
  ];

  it.each(cases)(
    "%s is refused before any network call, naming its replacement, without its value",
    async (name, replacement) => {
      const cwd = await repo();
      const { code, io, server } = await act(cwd, {
        args: PUBLISH_ARGS,
        [name]: SENTINEL,
      });
      expect(code).toBe(1);
      expect(server.calls).toEqual([]);
      expect(io.err()).toContain(`Input ${name} was removed in 0.9.`);
      expect(io.err()).toContain(replacement);
      expect(io.err() + io.out()).not.toContain(SENTINEL);
      expect(io.out()).toMatch(/^::error title=pkey::Input /);
    },
  );

  it("an input that was never one is refused too, and every removed input is listed at once", async () => {
    const cwd = await repo();
    const { code, io } = await act(cwd, {
      args: PUBLISH_ARGS,
      tag: "v1",
      colour: "red",
    });
    expect(code).toBe(1);
    expect(io.err()).toContain("Input tag was removed in 0.9.");
    expect(io.err()).toContain("Input colour is not an input of this Action.");
  });
});

describe("the Action's channels input (D-A3)", () => {
  const DISTRIBUTION = "outlets:\n  itch:\n    target: vlad/diceroll\n";

  async function withChannels() {
    const cwd = await repo();
    await writeFile(path.join(cwd, ".pkey/distribution.yaml"), DISTRIBUTION);
    return cwd;
  }
  const syncs = (out: string) =>
    out.match(/^Channels for diceroll/gm)?.length ?? 0;

  it("auto runs channel sync once after an app publish, with the publish's flags", async () => {
    const cwd = await withChannels();
    const { code, io } = await act(cwd, {
      args: `${PUBLISH_ARGS} --channel beta`,
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(io.out()).toContain("Channels for diceroll · beta");
    expect(syncs(io.out())).toBe(1);
  });

  it("none, a pack and a non-publish command never sync", async () => {
    const cwd = await withChannels();
    const none = await act(cwd, { args: PUBLISH_ARGS, channels: "none" });
    expect(none.code).toBe(0);
    expect(syncs(none.io.out())).toBe(0);
    const other = await act(cwd, { command: "validate" });
    expect(syncs(other.io.out())).toBe(0);
  });

  it("a pack publish never syncs", async () => {
    const cwd = await withChannels();
    const { io } = await act(cwd, {
      args: `--deliverable some.pack --version 1.0.0 --dir dist`,
    });
    expect(syncs(io.out())).toBe(0);
  });

  it("a failed publish does not sync", async () => {
    const cwd = await withChannels();
    const { code, io } = await act(cwd, { args: "--tag v0.3.0 --dir missing" });
    expect(code).toBe(1);
    expect(syncs(io.out())).toBe(0);
  });

  it("dry-run prints the plan and runs no step", async () => {
    const cwd = await withChannels();
    const { code, io, server } = await act(cwd, {
      args: PUBLISH_ARGS,
      "dry-run": "true",
    });
    expect(io.err()).toBe("");
    expect(code).toBe(0);
    expect(syncs(io.out())).toBe(1);
    expect(server.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });
});

describe("pkey manifest schemas", () => {
  it("vendors every published .pkey/ schema into --out", async () => {
    const cwd = await tempDir();
    const io = capture();
    const code = await runPkey(["manifest", "schemas", "--out", "vendor"], {
      cwd,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const source = path.join(repoRoot, "packages/shared-manifest/schemas/v1");
    const expected = (await readdir(source)).sort();
    expect((await readdir(path.join(cwd, "vendor"))).sort()).toEqual(expected);
    for (const name of expected)
      expect(await readFile(path.join(cwd, "vendor", name), "utf8")).toBe(
        await readFile(path.join(source, name), "utf8"),
      );
  });
});

describe("the standalone bundle", () => {
  it("bundle:action --check passes on a fresh bundle and fails on a stale one", async () => {
    const dir = await tempDir();
    const out = path.join(dir, "index.js");
    const script = path.join(pkgDir, "scripts/bundle-action.mjs");
    await run(process.execPath, [script, "--out", out]);
    await run(process.execPath, [script, "--check", "--out", out]);
    await writeFile(out, `${await readFile(out, "utf8")}\n// edited by hand\n`);
    await expect(
      run(process.execPath, [script, "--check", "--out", out]),
    ).rejects.toMatchObject({ code: 1 });
    // The bundle runs as a standalone pkey, schemas inlined.
    const vendored = path.join(dir, "vendor");
    const { stdout } = await run(
      process.execPath,
      [out, "manifest", "schemas", "--out", vendored],
      { cwd: dir },
    );
    expect(stdout).toContain("Wrote 5 schemas");
    const help = await run(process.execPath, [out, "help"]);
    expect(help.stdout).toContain("release publish");
    const publishHelp = await run(process.execPath, [
      out,
      "release",
      "publish",
      "--help",
    ]);
    expect(publishHelp.stdout).toContain("pkey release publish");
  }, 60_000);

  // The Action runs its COMMITTED dist/index.js. A bare `dist/` in the root .gitignore once
  // swallowed it: the bundle existed only in the author's checkout, `--check` passed there and
  // failed on every clean clone, and `uses: …/actions/publish@<sha>` had no entry point. Pin that
  // git does not ignore the bundle's path, and that action.yml points at that path.
  it("the bundle path is not git-ignored and is the Action's entry point", async () => {
    const bundle = "actions/publish/dist/index.js";
    const ignored = await run("git", ["check-ignore", "-q", bundle], {
      cwd: repoRoot,
    }).then(
      () => true,
      (err: { code?: number }) => {
        // 1 = not ignored. Anything else (128: no git checkout) is surfaced, not passed.
        if (err.code === 1) return false;
        throw err;
      },
    );
    expect(
      ignored,
      `${bundle} is git-ignored, so the Action would ship without it`,
    ).toBe(false);
    const actionYml = await readFile(
      path.join(repoRoot, "actions/publish/action.yml"),
      "utf8",
    );
    expect(actionYml).toMatch(/^\s+main:\s*dist\/index\.js\s*$/m);
  });
});

describe("SigV4", () => {
  // AWS's published examples ("Authenticating Requests: Using the Authorization Header",
  // Amazon S3 API reference), credentials AKIAIOSFODNN7EXAMPLE / wJalrXUtnFEMI/K7MDENG/....
  const creds = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  };

  it("matches AWS's GET Object example", () => {
    expect(
      signV4({
        ...creds,
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: {
          range: "bytes=0-9",
          "x-amz-content-sha256":
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "x-amz-date": "20130524T000000Z",
        },
        payloadHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches AWS's PUT Object example (a path segment that needs encoding)", () => {
    expect(
      signV4({
        ...creds,
        method: "PUT",
        url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
        headers: {
          date: "Fri, 24 May 2013 00:00:00 GMT",
          "x-amz-date": "20130524T000000Z",
          "x-amz-storage-class": "REDUCED_REDUNDANCY",
          "x-amz-content-sha256":
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
        },
        payloadHash:
          "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
});

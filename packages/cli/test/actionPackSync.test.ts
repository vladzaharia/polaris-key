/**
 * P4-33.5: `channels: auto` after a pack publish. `runPkey` is replaced by a recorder so the
 * argv the Action builds is what is asserted; the manifest is real.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, tempDir } from "./publishFixture.js";

const calls: string[][] = [];
let exitFor: (argv: string[]) => number = () => 0;
vi.mock("../src/index.js", () => ({
  runPkey: async (argv: string[]) => {
    calls.push(argv);
    return exitFor(argv);
  },
}));

const { runAction } = await import("../src/action.js");

const RELEASE = `apiVersion: pkey.dev/v1
release:
  provider:
    type: github
    owner: acme
    repo: game
  binaryName: game
  deliverables:
    app:
      kind: app
      content:
        contentApi: 4
      artifacts:
        - { id: linux, platform: linux, arch: x86_64, format: tar.gz, match: "game-*.tar.gz" }
    game.pack:
      kind: pack
      type: files.tree
    npm.sdk:
      kind: package
      ecosystem: npm
      name: "@acme/sdk"
      artifacts:
        tarball: { match: "acme-sdk-*.tgz" }
`;

const PRODUCT = `apiVersion: pkey.dev/v1
product:
  slug: game
  name: Game
modules:
  release:
    enabled: true
  distribution:
    enabled: true
`;

async function project(): Promise<string> {
  const cwd = await tempDir();
  await mkdir(path.join(cwd, ".pkey"), { recursive: true });
  await writeFile(path.join(cwd, ".pkey/product.yaml"), PRODUCT);
  await writeFile(
    path.join(cwd, ".pkey/schema.yaml"),
    "apiVersion: pkey.dev/v1\nschemaVersion: 1\nentries: []\n",
  );
  await writeFile(path.join(cwd, ".pkey/release.yaml"), RELEASE);
  return cwd;
}

async function act(
  cwd: string,
  args: string,
  extra: Record<string, string> = {},
) {
  const lines: string[] = [];
  const sink = { write: (c: string) => (lines.push(String(c)), true) };
  const code = await runAction({
    env: {
      GITHUB_ACTIONS: "true",
      INPUT_COMMAND: "release publish",
      INPUT_ARGS: args,
      INPUT_CHANNELS: "auto",
      RUNNER_TEMP: "/runner/tmp",
      ...extra,
    },
    cwd,
    stdout: sink as never,
    stderr: sink as never,
  });
  return { code, lines };
}

beforeEach(() => {
  calls.length = 0;
  exitFor = () => 0;
});
afterEach(cleanup);

describe("the Action after a pack publish", () => {
  it("adds --out and runs one sync with --deliverable and --from", async () => {
    const cwd = await project();
    const { code } = await act(
      cwd,
      "--deliverable game.pack --version 1.0.0 --dir dist",
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    const out = path.join("/runner/tmp", "pkey-packs");
    expect(calls[0]).toEqual([
      "release",
      "publish",
      "--deliverable",
      "game.pack",
      "--version",
      "1.0.0",
      "--dir",
      "dist",
      "--out",
      out,
    ]);
    expect(calls[1]).toEqual([
      "channel",
      "sync",
      "--deliverable",
      "game.pack",
      "--from",
      out,
      "--version",
      "1.0.0",
    ]);
  });

  it("keeps an --out the args carry", async () => {
    const cwd = await project();
    await act(
      cwd,
      "--deliverable game.pack --version 1.0.0 --dir dist --out=build/packs",
    );
    expect(calls[0]!.filter((w) => w.startsWith("--out"))).toEqual([
      "--out=build/packs",
    ]);
    expect(calls[1]).toEqual([
      "channel",
      "sync",
      "--deliverable",
      "game.pack",
      "--from",
      "build/packs",
      "--version",
      "1.0.0",
    ]);
  });

  it("forwards --channel and a --tag's version", async () => {
    const cwd = await project();
    await act(
      cwd,
      "--deliverable game.pack --tag v2.0.0 --channel beta --dir dist",
    );
    expect(calls[1]!.slice(-4)).toEqual([
      "--channel",
      "beta",
      "--version",
      "2.0.0",
    ]);
  });

  it("without RUNNER_TEMP the cache is a fresh private directory", async () => {
    const cwd = await project();
    const args = "--deliverable game.pack --version 1.0.0 --dir dist";
    await act(cwd, args, { RUNNER_TEMP: "" });
    const first = calls[0]![calls[0]!.indexOf("--out") + 1]!;
    calls.length = 0;
    await act(cwd, args, { RUNNER_TEMP: "" });
    const second = calls[0]![calls[0]!.indexOf("--out") + 1]!;
    expect(first).toMatch(/pkey-packs-[A-Za-z0-9]{6}$/);
    expect(second).not.toBe(first);
  });

  it("channels none runs no sync and adds no --out", async () => {
    const cwd = await project();
    await act(cwd, "--deliverable game.pack --version 1.0.0 --dir dist", {
      INPUT_CHANNELS: "none",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--out");
  });

  it("a package publish runs nothing", async () => {
    const cwd = await project();
    await act(cwd, "--deliverable npm.sdk --version 1.0.0 --dir dist");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--out");
  });

  it("a failed pack publish does not sync", async () => {
    const cwd = await project();
    exitFor = () => 1;
    const { code } = await act(
      cwd,
      "--deliverable game.pack --version 1.0.0 --dir dist",
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("the app path is unchanged: one channel sync, no --from", async () => {
    const cwd = await project();
    await act(cwd, "--tag v1.0.0 --dir dist");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.slice(0, 2)).toEqual(["channel", "sync"]);
    expect(calls[1]).not.toContain("--from");
    expect(calls[0]).not.toContain("--out");
  });
});

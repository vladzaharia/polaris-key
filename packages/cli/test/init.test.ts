import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-init-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

interface Key {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
}
const key = (name: string, ctrl = false): Key => ({
  name,
  sequence: name === "space" ? " " : name,
  ctrl,
  meta: false,
});
const ENTER = key("return");
const SPACE = key("space");
const DOWN = key("down");

function run(
  argv: string[],
  cwd: string,
  o: {
    keys?: Key[];
    tty?: boolean;
    stdinTty?: boolean;
    env?: Record<string, string>;
    columns?: number;
  } = {},
) {
  let out = "";
  let err = "";
  const queue = [...(o.keys ?? [])];
  const reads: number[] = [];
  const keys = {
    next: async () => (reads.push(1), queue.shift() ?? null),
    close: () => undefined,
  };
  const stdout = {
    isTTY: o.tty ?? true,
    columns: o.columns ?? 80,
    rows: 24,
    write: (c: string) => ((out += c), true),
    on: () => undefined,
    off: () => undefined,
  };
  const stderr = { write: (c: string) => ((err += c), true) };
  const stdin = { isTTY: o.stdinTty ?? true, on: () => undefined };
  const done = runPkey(argv, {
    cwd,
    stdout: stdout as never,
    stderr,
    env: { TERM: "xterm-256color", NO_COLOR: "1", ...o.env },
    prompt: { stdin, keys: keys as never },
  });
  return {
    done,
    out: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
    err: () => err,
    reads: () => reads.length,
  };
}

const files = async (cwd: string) =>
  (await readdir(path.join(cwd, ".pkey")).catch(() => [])).sort();

describe("pkey init on a terminal (ST-46.3)", () => {
  it("opens with Licensing and Ship builds ticked, and Enter writes them with a Free tier", async () => {
    const cwd = await tempDir();
    const r = run(["init", "--product", "acme"], cwd, { keys: [ENTER, ENTER] });
    expect(await r.done).toBe(0);
    expect(r.out()).toMatch(/◼ Licensing/);
    expect(r.out()).toMatch(/◼ Ship builds/);
    expect(r.out()).toMatch(/◻ Managed config/);
    expect(r.out()).toContain("Start with a Free tier?");
    expect(r.out()).toContain("Next: pkey validate");
    expect(await files(cwd)).toEqual([
      "product.yaml",
      "release.yaml",
      "schema.yaml",
    ]);
    const product = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    expect(product).toMatch(/license:\n\s+enabled: true/);
    expect(product).toMatch(/release:\n\s+enabled: true/);
    expect(product).toMatch(/distribution:\n\s+enabled: true/);
    expect(product).toMatch(/config:\n\s+enabled: false/);
  });

  it("locks Commerce until Licensing is ticked, and clearing Licensing says so", async () => {
    const cwd = await tempDir();
    // Licensing off: Commerce (last) shows "Needs Licensing" and Space on it does nothing.
    const r = run(
      ["init", "--product", "acme", "--starter-tier", "none"],
      cwd,
      {
        keys: [
          key("up"), // wraps to Commerce
          SPACE, // locked
          key("down"), // Licensing
          SPACE, // untick Licensing
          ENTER,
        ],
      },
    );
    expect(await r.done).toBe(0);
    expect(r.out()).toContain("Needs Licensing");
    const product = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    expect(product).toMatch(/commerce:\n\s+enabled: false/);
    expect(product).toMatch(/license:\n\s+enabled: false/);
  });

  it("clearing Licensing clears Commerce with a note", async () => {
    const cwd = await tempDir();
    // Tick Managed config? Not needed: tick Commerce needs Licensing (on), then untick Licensing.
    const r = run(
      ["init", "--product", "acme", "--starter-tier", "none"],
      cwd,
      {
        keys: [
          key("up"),
          SPACE, // tick Commerce
          key("down"),
          SPACE, // untick Licensing -> clears Commerce
          ENTER,
        ],
      },
    );
    expect(await r.done).toBe(0);
    expect(r.out()).toContain("Clearing Licensing also clears Commerce.");
  });

  it("does not ask for a tier without Licensing", async () => {
    const cwd = await tempDir();
    const r = run(["init", "--product", "acme"], cwd, {
      keys: [SPACE, ENTER], // untick Licensing
    });
    expect(await r.done).toBe(0);
    expect(r.out()).not.toContain("Free tier");
    expect(r.reads()).toBe(2);
  });

  it("asks only what the flags did not give", async () => {
    const cwd = await tempDir();
    const r = run(["init", "--product", "acme", "--modules", "license"], cwd, {
      keys: [key("n")],
    });
    expect(await r.done).toBe(0);
    expect(r.out()).not.toContain("What is it for?");
    expect(r.out()).toContain("Start with a Free tier?");
    const none = await tempDir();
    const q = run(
      [
        "init",
        "--product",
        "a",
        "--modules",
        "license",
        "--starter-tier",
        "free",
      ],
      none,
    );
    expect(await q.done).toBe(0);
    expect(q.reads()).toBe(0);
  });

  it("cancel writes nothing: Esc exits 1, Ctrl-C exits 130", async () => {
    const a = await tempDir();
    const esc = run(["init", "--product", "acme"], a, {
      keys: [key("escape")],
    });
    expect(await esc.done).toBe(1);
    expect(esc.out()).toContain("Cancelled. Nothing written.");
    expect(esc.out()).not.toContain("Next:");
    expect(await files(a)).toEqual([]);
    const b = await tempDir();
    const second = run(["init", "--product", "acme"], b, {
      keys: [ENTER, key("c", true)],
    });
    expect(await second.done).toBe(130);
    expect(await files(b)).toEqual([]);
    // DOWN is unused here; keep the import honest.
    expect(DOWN.name).toBe("down");
  });
});

describe("pkey init without a terminal is unchanged (D-S3, D-S5)", () => {
  const GOLDEN =
    "Created 2 manifest files:\n- .pkey/product.yaml\n- .pkey/schema.yaml\n\nNext: pkey validate\n";

  async function plain(o: Parameters<typeof run>[2]) {
    const cwd = await tempDir();
    const r = run(["init", "--product", "acme", "--name", "Acme"], cwd, {
      keys: [ENTER, ENTER],
      ...o,
    });
    expect(await r.done).toBe(0);
    expect(r.reads()).toBe(0);
    return { out: r.out(), cwd };
  }

  it("a pipe prints exactly today's output and scaffold", async () => {
    const { out, cwd } = await plain({ tty: false });
    expect(out).toBe(GOLDEN);
    expect(await files(cwd)).toEqual(["product.yaml", "schema.yaml"]);
    const product = await readFile(
      path.join(cwd, ".pkey/product.yaml"),
      "utf8",
    );
    expect(product).toMatch(/license:\n\s+enabled: true/);
    expect(product).toMatch(/config:\n\s+enabled: true/);
  });

  it("stdin that is not a terminal never prompts", async () => {
    expect((await plain({ stdinTty: false })).out).toBe(GOLDEN);
  });

  it("CI never prompts", async () => {
    expect((await plain({ env: { CI: "true" } })).out).toBe(GOLDEN);
  });

  it("TERM=dumb never prompts", async () => {
    expect((await plain({ env: { TERM: "dumb" } })).out).toBe(GOLDEN);
  });
});

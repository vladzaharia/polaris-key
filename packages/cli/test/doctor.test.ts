/**
 * P0-45 fix round: `pkey doctor` renders the facts it gathered once. Each test below pins one
 * finding of the built UX review (B1-B4 and the major ones) with the real discovery body shape.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripAnsi } from "@polaris-key/node/terminal";
import { afterEach, describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import { nearest } from "../src/suggest.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pkey-doc-"));
  dirs.push(dir);
  return dir;
}

function stream(tty: boolean, columns: number) {
  let text = "";
  return {
    isTTY: tty,
    columns,
    rows: 24,
    write: (c: string) => ((text += c), true),
    text: () => text,
  };
}

async function run(
  argv: string[],
  opts: {
    cwd: string;
    fetchImpl?: typeof fetch;
    tty?: boolean;
    columns?: number;
    doctorTimeoutMs?: number;
  },
) {
  const stdout = stream(opts.tty ?? false, opts.columns ?? 80);
  const stderr = stream(opts.tty ?? false, opts.columns ?? 80);
  const code = await runPkey(argv, {
    cwd: opts.cwd,
    stdout,
    stderr,
    env: { NO_COLOR: "1", TERM: "xterm" },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.doctorTimeoutMs ? { doctorTimeoutMs: opts.doctorTimeoutMs } : {}),
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

/** A manifest enabling license and config, at `dir`/.pkey. */
async function manifest(dir: string, files: Record<string, string> = {}) {
  await mkdir(path.join(dir, ".pkey"), { recursive: true });
  const all = {
    "product.yaml":
      "apiVersion: pkey.dev/v1\nproduct:\n  slug: demo\n  name: Demo\nmodules:\n  license:\n    enabled: true\n  config:\n    enabled: true\n",
    "schema.yaml": "schemaVersion: 1\nentries: []\n",
    ...files,
  };
  for (const [name, text] of Object.entries(all))
    await writeFile(path.join(dir, ".pkey", name), text);
  return dir;
}

/** The body `packages/worker/src/core/discovery.ts` serves: a `trust` block, no `signing` member. */
function discoveryBody(opts: { keys?: boolean; on?: string[] } = {}) {
  const keys =
    opts.keys === false
      ? []
      : [
          { kid: "demo-2026-10", status: "active", active: true },
          { kid: "demo-2026-04", status: "retired", active: false },
        ];
  const on = opts.on ?? ["license", "config"];
  return {
    version: 1,
    product: "demo",
    trust: {
      jwksUrl: "https://x/demo/.well-known/jwks.json",
      pinnedKeys: { "demo-2026-10": "MCowBQ" },
      signingKid: keys[0]?.kid ?? "demo",
      signingPub: keys.length ? "MCowBQ" : null,
      keys,
    },
    services: Object.fromEntries(
      ["license", "config", "release"].map((s) => [
        s,
        { enabled: on.includes(s) },
      ]),
    ),
  };
}

const answer = (body: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;

describe("B1: the signing keys come from trust.keys", () => {
  it("prints one row per key and never the trust object", async () => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓  Signing key  demo-2026-10, active");
    expect(r.out).toContain("   demo-2026-04, retired");
    expect(r.out).not.toContain("jwksUrl");
    expect(r.out).not.toContain("pinnedKeys");
  });

  it("--json lists the keys as kid and status, and counts two", async () => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor", "--json"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    const line = JSON.parse(r.out);
    expect(line.signing).toEqual([
      { kid: "demo-2026-10", status: "active" },
      { kid: "demo-2026-04", status: "retired" },
    ]);
    expect(
      line.facts.find((f: { id: string }) => f.id === "signing-keys"),
    ).toMatchObject({ state: "ok", detail: "2 keys" });
  });

  it("negative control: no keys is a to do, with a fix row", async () => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: answer(discoveryBody({ keys: false })),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗  error Signing key: none");
    expect(r.out).toMatch(/→ Create a signing key/);
  });
});

describe("B2 and B4: a syntax error", () => {
  const bad = { "schema.yaml": "a: 1\nbogus: [\n" };

  it("names .pkey/<file> and a line, never a path, and does not stop the remote checks", async () => {
    const cwd = await manifest(await tempDir(), bad);
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "✗  error .pkey/schema.yaml line 3: not valid YAML (an unclosed [).",
    );
    expect(r.out).not.toContain(cwd);
    expect(r.out).not.toContain("validate again");
    expect(r.out).toContain("✓  Live product  answers");
    expect(r.out).toContain("1 to do · 0 warnings");
  });

  it("validate prints the same line with a ✗", async () => {
    const cwd = await manifest(await tempDir(), bad);
    const r = await run(["validate"], { cwd });
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      "✗  .pkey/schema.yaml line 3: not valid YAML (an unclosed [).\n",
    );
  });

  it("wraps at 40 columns on a terminal", async () => {
    const cwd = await manifest(await tempDir(), bad);
    const r = await run(["doctor"], {
      cwd,
      tty: true,
      columns: 40,
      fetchImpl: answer(discoveryBody()),
    });
    for (const l of stripAnsi(r.out).split("\n"))
      expect([...l].length).toBeLessThanOrEqual(40);
  });
});

describe("B3: doctor validates the .pkey/ help found", () => {
  it("works from a subfolder, and --json does not contradict itself", async () => {
    const root = await manifest(await tempDir());
    const cwd = path.join(root, "src", "game");
    await mkdir(cwd, { recursive: true });
    const text = await run(["doctor"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    expect(text.code).toBe(0);
    expect(text.out).not.toContain("pkey init");
    expect(text.out).toContain("Manifest: valid");
    const json = JSON.parse(
      (
        await run(["doctor", "--json"], {
          cwd,
          fetchImpl: answer(discoveryBody()),
        })
      ).out,
    );
    expect(json.product).toBe("demo");
    expect(json.facts[0]).toMatchObject({ id: "manifest", state: "ok" });
  });
});

describe("B4: every state is a row", () => {
  const cases: Array<[string, typeof fetch, RegExp, RegExp]> = [
    [
      "an HTML page",
      answer("<html><body>portal</body></html>"),
      /✗ {2}error Live product: .* did not answer with discovery JSON\./,
      /→ Check --base-url/,
    ],
    [
      "a 500",
      answer({}, 500),
      /✗ {2}error Live product: server error \(500\)/,
      /→ The server failed; try again\./,
    ],
    [
      "an unreachable server",
      (async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
        });
      }) as typeof fetch,
      /✗ {2}error Live product: Could not reach/,
      /→ Check the network/,
    ],
  ];
  it.each(cases)("%s", async (_n, fetchImpl, row, fix) => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor"], { cwd, fetchImpl });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(row);
    expect(r.out).toMatch(fix);
    expect(r.out).not.toContain("Unexpected token");
    expect(r.out).not.toContain("Is the product registered");
    expect(r.err).toBe("");
    expect(r.out).toMatch(/1 to do · 0 warnings · \d\.\d s\n$/);
  });

  it("a ▲ row for no product, with the fix row, and the summary counts it", async () => {
    const r = await run(["doctor"], { cwd: await tempDir() });
    expect(r.out).toContain("▲  warning Live product: skipped: no product");
    expect(r.out).toContain("→ Pass --product");
  });

  it("opens with the product and origin", async () => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor", "--base-url", "http://h.test:9"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    expect(r.out.split("\n")[0]).toBe("Demo (demo) · h.test:9");
  });
});

describe("major findings", () => {
  it("an unknown flag is an error with a did-you-mean (exit 2)", async () => {
    const r = await run(["doctor", "--prodcut", "x"], { cwd: await tempDir() });
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "Unknown option --prodcut. Did you mean --product?",
    );
    expect(r.out).toBe("");
  });

  it("a flag with no value is an error", async () => {
    const r = await run(["doctor", "--json", "--base-url"], {
      cwd: await tempDir(),
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Option --base-url needs a value.");
  });

  it("a hung server times out into a row", async () => {
    const cwd = await manifest(await tempDir());
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new Error("abort"))),
      )) as unknown as typeof fetch;
    const r = await run(["doctor", "--base-url", "http://h.test"], {
      cwd,
      fetchImpl: hang,
      doctorTimeoutMs: 30,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "✗  error Live product: h.test did not answer in 0 s.",
    );
  });

  it("flags features that differ from the live product", async () => {
    const cwd = await manifest(await tempDir());
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: answer(
        discoveryBody({ on: ["license", "config", "release"] }),
      ),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("▲  warning Features differ: only live: release.");
    expect(r.out).toContain("1 warning");
  });

  it("offers validate --fix for a deprecated spelling", async () => {
    const cwd = await manifest(await tempDir(), {
      "product.yaml":
        "apiVersion: pkey.dev/v1\nproduct:\n  slug: demo\n  name: Demo\nadminGroup: ops\nmodules:\n  license:\n    enabled: true\n  config:\n    enabled: true\n",
    });
    const r = await run(["doctor"], {
      cwd,
      fetchImpl: answer(discoveryBody()),
    });
    expect(r.out).toContain("→ pkey validate --fix");
  });

  it("a mistyped command gets a suggestion", async () => {
    const r = await run(["doctr"], { cwd: await tempDir() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Did you mean doctor?");
    expect(nearest("x", ["doctor"])).toBeUndefined();
  });

  it("per-verb help fits 40 columns and promises nothing it does not do", async () => {
    for (const verb of ["doctor", "validate", "init"]) {
      const r = await run(["help", verb], {
        cwd: await tempDir(),
        tty: true,
        columns: 40,
      });
      for (const l of stripAnsi(r.out).split("\n"))
        expect([...l].length, l).toBeLessThanOrEqual(40);
    }
  });

  it("the Here line keeps its separator at 40 columns", async () => {
    const r = await run(["help"], {
      cwd: await tempDir(),
      tty: true,
      columns: 40,
    });
    expect(stripAnsi(r.out)).toMatch(/\n {7}· key\.plrs\.im\n/);
  });
});

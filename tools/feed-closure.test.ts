/**
 * P0-52 — the feed closure check and the pre-publish gate (tools/feed-closure.mjs): every
 * published `@polaris-key/*` version pins only sibling versions the feed lists, and no package is
 * published before every version it pins is on the feed.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Packument,
  listedVersions,
  missingFromSet,
  npmClosure,
  pinProblem,
  pypiClosure,
  pypiFileVersion,
  readPackuments,
  readTarEntry,
  siblingPins,
  tarballManifest,
  tarballsAt,
  waitForPins,
} from "./feed-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "tools", "feed-closure.mjs");
const run = promisify(execFile);

// ── The feed as it was on 2026-10-08 ────────────────────────────────────────────────────────

interface Recorded {
  packages: Record<
    string,
    {
      "dist-tags": Record<string, string>;
      versions: Record<
        string,
        { pins: Record<string, string>; deprecated?: string }
      >;
    }
  >;
}

/** The recorded feed (every @polaris-key packument, read-only, pins only) as packuments. */
function recordedFeed(): Map<string, Packument> {
  const rec = JSON.parse(
    readFileSync(
      join(ROOT, "tools", "fixtures", "npm-feed-2026-10-08.json"),
      "utf8",
    ),
  ) as Recorded;
  return new Map(
    Object.entries(rec.packages).map(([name, p]) => [
      name,
      {
        "dist-tags": p["dist-tags"],
        versions: Object.fromEntries(
          Object.entries(p.versions).map(([v, m]) => [
            v,
            m.deprecated
              ? { dependencies: m.pins, deprecated: m.deprecated }
              : { dependencies: m.pins },
          ]),
        ),
      },
    ]),
  );
}

/** The nine versions that pin a sibling no publish ever delivered (research §5 item 2). */
const BROKEN_2026_10_08 = [
  "@polaris-key/catalog@0.8.29 -> @polaris-key/protocol@0.8.29",
  "@polaris-key/cli@0.8.28 -> @polaris-key/jws@0.8.28",
  "@polaris-key/cli@0.8.29 -> @polaris-key/protocol@0.8.29",
  "@polaris-key/client-core@0.8.28 -> @polaris-key/jws@0.8.28",
  "@polaris-key/client-core@0.8.29 -> @polaris-key/protocol@0.8.29",
  "@polaris-key/jws@0.8.29 -> @polaris-key/protocol@0.8.29",
  "@polaris-key/manifest@0.8.29 -> @polaris-key/protocol@0.8.29",
  "@polaris-key/node@0.8.28 -> @polaris-key/jws@0.8.28",
  "@polaris-key/react@0.8.29 -> @polaris-key/protocol@0.8.29",
];

/**
 * The two versions the owner's repair publishes from their tags (npm-repair.yml), with the pins
 * `pnpm pack` gives them there: at v0.8.28 `packages/shared-jws` depends on protocol
 * (`workspace:*`, so `0.8.28`), and at v0.8.29 `packages/shared-protocol` depends on nothing.
 */
const REPAIR: [string, string, Record<string, string>][] = [
  ["@polaris-key/jws", "0.8.28", { "@polaris-key/protocol": "0.8.28" }],
  ["@polaris-key/protocol", "0.8.29", {}],
];

function withVersions(
  feed: Map<string, Packument>,
  add: [string, string, Record<string, string>][],
): Map<string, Packument> {
  const out = new Map(
    [...feed].map(([n, p]) => [n, { ...p, versions: { ...p.versions } }]),
  );
  for (const [name, version, pins] of add)
    out.get(name)!.versions![version] = { dependencies: pins };
  return out;
}

const lines = (r: ReturnType<typeof npmClosure>) =>
  r.broken.map((b) => `${b.name}@${b.version} -> ${b.dep}@${b.spec}`);

describe("the npm closure", () => {
  it("finds exactly the nine broken versions on the 2026-10-08 feed", () => {
    const r = npmClosure(recordedFeed());
    expect(lines(r)).toEqual(BROKEN_2026_10_08);
    expect(r.packages).toBe(10);
    expect(r.broken.every((b) => b.deprecated === null)).toBe(true);
  });

  it("finds none once the repair publishes jws@0.8.28 and protocol@0.8.29", () => {
    const repaired = withVersions(recordedFeed(), REPAIR);
    expect(npmClosure(repaired).broken).toEqual([]);
    // Each repair alone fixes its own tag's dependents and nothing else.
    expect(
      lines(npmClosure(withVersions(recordedFeed(), [REPAIR[0]!]))),
    ).toEqual(BROKEN_2026_10_08.filter((l) => l.endsWith("protocol@0.8.29")));
    expect(
      lines(npmClosure(withVersions(recordedFeed(), [REPAIR[1]!]))),
    ).toEqual(BROKEN_2026_10_08.filter((l) => l.endsWith("jws@0.8.28")));
  });

  it("--assume answers the same what-if from the live listing", () => {
    const r = npmClosure(recordedFeed(), {
      assume: REPAIR.map(([n, v]) => `${n}@${v}`),
    });
    expect(r.broken).toEqual([]);
  });

  it("marks a broken pin on a deprecated version (the other repair) as deprecated", () => {
    const feed = recordedFeed();
    feed.get("@polaris-key/node")!.versions!["0.8.28"]!.deprecated =
      "pins jws@0.8.28, which was never published";
    const node = npmClosure(feed).broken.find(
      (b) => b.name === "@polaris-key/node",
    );
    expect(node?.deprecated).toMatch(/never published/);
  });

  it("refuses a range, an unknown package and a missing version; a peer may be a range", () => {
    const listed = listedVersions(
      new Map<string, Packument | null>([
        ["@polaris-key/protocol", { versions: { "1.0.0": {} } }],
        ["@polaris-key/gone", null],
      ]),
    );
    const pin = (spec: string, name = "@polaris-key/protocol") => ({
      name,
      spec,
      field: "dependencies" as const,
    });
    expect(pinProblem(pin("1.0.0"), listed)).toBeNull();
    expect(pinProblem(pin("1.0.1"), listed)).toBe(
      "@polaris-key/protocol@1.0.1 is not on the feed",
    );
    expect(pinProblem(pin("^1.0.0"), listed)).toMatch(/range \^1\.0\.0/);
    expect(pinProblem(pin("workspace:*"), listed)).toMatch(/range/);
    expect(pinProblem(pin("1.0.0", "@polaris-key/gone"), listed)).toBe(
      "the feed has no @polaris-key/gone",
    );
    expect(
      pinProblem({ ...pin(">=1"), field: "peerDependencies" }, listed),
    ).toBeNull();
    expect(
      pinProblem({ ...pin("2.0.0"), field: "peerDependencies" }, listed),
    ).toMatch(/not on the feed/);
  });

  it("reads only @polaris-key pins, from dependencies, optional and peer dependencies", () => {
    expect(
      siblingPins({
        dependencies: { "@polaris-key/jws": "1.0.0", yaml: "^2" },
        optionalDependencies: { "@polaris-key/zstd-wasm": "1.0.0" },
        peerDependencies: { react: ">=18", "@polaris-key/node": "1.0.0" },
      }),
    ).toEqual([
      { name: "@polaris-key/jws", spec: "1.0.0", field: "dependencies" },
      {
        name: "@polaris-key/zstd-wasm",
        spec: "1.0.0",
        field: "optionalDependencies",
      },
      { name: "@polaris-key/node", spec: "1.0.0", field: "peerDependencies" },
    ]);
  });

  it("names the packages of a set that do not list a version", () => {
    const feed = recordedFeed();
    expect(missingFromSet(feed, [...feed.keys()], "0.8.29").sort()).toEqual([
      "@polaris-key/node",
      "@polaris-key/protocol",
    ]);
    expect(missingFromSet(feed, [...feed.keys()], "0.8.33")).toEqual([]);
  });

  it("follows pins to siblings outside the list, and a 404 is a package the feed lacks", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("%2fnode"))
        return Response.json({
          versions: {
            "1.0.0": {
              dependencies: {
                "@polaris-key/jws": "1.0.0",
                "@polaris-key/gone": "1.0.0",
              },
            },
          },
        });
      if (url.endsWith("%2fjws"))
        return Response.json({ versions: { "1.0.0": {} } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const docs = await readPackuments(
      "https://pkg.example.test/",
      "polaris-key",
      ["@polaris-key/node"],
      fake,
    );
    expect([...docs.keys()]).toEqual([
      "@polaris-key/gone",
      "@polaris-key/jws",
      "@polaris-key/node",
    ]);
    expect(docs.get("@polaris-key/gone")).toBeNull();
    expect(seen[0]).toBe(
      "https://pkg.example.test/npm/polaris-key/@polaris-key%2fnode",
    );
    expect(lines(npmClosure(docs))).toEqual([
      "@polaris-key/node@1.0.0 -> @polaris-key/gone@1.0.0",
    ]);
  });
});

describe("the PyPI equivalent", () => {
  it("reads the version from a wheel's and an sdist's name", () => {
    expect(pypiFileVersion("polaris_key-0.8.34.dev116-py3-none-any.whl")).toBe(
      "0.8.34.dev116",
    );
    expect(pypiFileVersion("polaris_key-0.8.33.tar.gz")).toBe("0.8.33");
    expect(pypiFileVersion("README")).toBeNull();
  });

  it("passes every listed version with a file, and names a version without one and a stray file", () => {
    const ok = {
      name: "polaris-key",
      versions: ["0.8.33", "0.8.34.dev1"],
      files: [
        { filename: "polaris_key-0.8.33-py3-none-any.whl" },
        { filename: "polaris_key-0.8.33.tar.gz" },
        { filename: "polaris_key-0.8.34.dev1.tar.gz", yanked: true },
      ],
    };
    expect(pypiClosure(ok)).toEqual({ versions: 2, broken: [] });
    const bad = {
      ...ok,
      versions: [...ok.versions, "0.8.35"],
      files: [...ok.files, { filename: "polaris_key-0.8.36.tar.gz" }],
    };
    expect(pypiClosure(bad).broken).toEqual([
      {
        name: "polaris-key",
        version: "0.8.36",
        problem: "polaris_key-0.8.36.tar.gz belongs to no listed version",
      },
      {
        name: "polaris-key",
        version: "0.8.35",
        problem: "is listed with no file to install",
      },
    ]);
  });
});

// ── The pre-publish gate ────────────────────────────────────────────────────────────────────

/** A packed npm package, as `pnpm pack` writes one: package/package.json in a .tgz. */
function pack(dir: string, manifest: Record<string, unknown>): Promise<void> {
  const src = mkdtempSync(join(tmpdir(), "pkey-pack-"));
  mkdirSync(join(src, "package"));
  writeFileSync(join(src, "package", "package.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "package", "index.js"), "export {};\n");
  mkdirSync(dir, { recursive: true });
  const short = String(manifest.name).replace("@polaris-key/", "");
  return run("tar", [
    "-czf",
    join(dir, `polaris-key-${short}-${String(manifest.version)}.tgz`),
    "-C",
    src,
    "package",
  ]).then(() => undefined);
}

describe("packed tarballs", () => {
  it("reads package/package.json out of a .tgz, and every .tgz of a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-tgz-"));
    await pack(dir, {
      name: "@polaris-key/jws",
      version: "0.9.1-main.4",
      dependencies: { "@polaris-key/protocol": "0.9.1-main.4" },
    });
    const [file] = tarballsAt(dir);
    expect(file).toMatch(/polaris-key-jws-0\.9\.1-main\.4\.tgz$/);
    const tgz = readFileSync(file!);
    expect(tarballManifest(tgz)).toMatchObject({
      name: "@polaris-key/jws",
      dependencies: { "@polaris-key/protocol": "0.9.1-main.4" },
    });
    expect(readTarEntry(tgz, "package/index.js")?.toString()).toBe(
      "export {};\n",
    );
    expect(readTarEntry(tgz, "package/missing.js")).toBeNull();
    expect(() => tarballsAt(mkdtempSync(join(tmpdir(), "empty-")))).toThrow(
      /no \.tgz/,
    );
  });
});

describe("waitForPins", () => {
  const pin = {
    name: "@polaris-key/protocol",
    spec: "0.9.1-main.4",
    field: "dependencies" as const,
  };

  it("waits while the feed renders, then answers nothing missing", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return Response.json({
        versions: calls < 3 ? {} : { "0.9.1-main.4": {} },
      });
    }) as unknown as typeof fetch;
    const missing = await waitForPins({
      origin: "https://pkg.example.test",
      owner: "polaris-key",
      pins: [pin],
      timeoutSec: 60,
      fetchImpl: fake,
      sleep: async () => undefined,
    });
    expect(missing).toEqual([]);
    expect(calls).toBe(3);
  });

  it("answers the pins a stuck leg never delivered once the timeout passes", async () => {
    let t = 0;
    const fake = (async () =>
      Response.json({ versions: {} })) as unknown as typeof fetch;
    const missing = await waitForPins({
      origin: "https://pkg.example.test",
      owner: "polaris-key",
      pins: [pin],
      timeoutSec: 30,
      fetchImpl: fake,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(missing).toEqual([pin]);
  });
});

// ── The command line, against a feed served locally ─────────────────────────────────────────

describe("the command line", () => {
  let server: Server;
  let origin = "";
  /** The packuments the local feed serves, by package name. */
  let feed = new Map<string, Packument>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      const npm = /^\/npm\/polaris-key\/(@polaris-key\/[a-z-]+)$/.exec(url);
      if (npm && feed.has(npm[1]!)) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(feed.get(npm[1]!)));
        return;
      }
      if (url === "/pypi/polaris-key/simple/polaris-key/") {
        res.setHeader("content-type", "application/vnd.pypi.simple.v1+json");
        res.end(
          JSON.stringify({
            name: "polaris-key",
            versions: ["0.8.33"],
            files: [{ filename: "polaris_key-0.8.33.tar.gz" }],
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function cli(args: string[]): Promise<{ code: number; out: string }> {
    try {
      const { stdout } = await run(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
      });
      return { code: 0, out: stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string };
      return { code: err.code, out: err.stdout + err.stderr };
    }
  }

  it("a simulated stuck leg: the gate refuses a dependent whose pin the feed never got", async () => {
    // protocol's leg is stuck in `waiting`: the feed lists only the release before it.
    feed = new Map([["@polaris-key/protocol", { versions: { "0.9.0": {} } }]]);
    const dir = mkdtempSync(join(tmpdir(), "pkey-gate-"));
    await pack(join(dir, "jws"), {
      name: "@polaris-key/jws",
      version: "0.9.1-main.4",
      dependencies: { "@polaris-key/protocol": "0.9.1-main.4" },
    });
    const refused = await cli([
      "requires",
      join(dir, "jws"),
      "--version",
      "0.9.1-main.4",
      "--origin",
      origin,
      "--timeout",
      "0",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "::error::@polaris-key/jws@0.9.1-main.4 pins @polaris-key/protocol@0.9.1-main.4",
    );
    expect(refused.out).toContain("Nothing was published");

    // Once protocol's leg lands, the same tarball passes.
    feed.set("@polaris-key/protocol", {
      versions: { "0.9.0": {}, "0.9.1-main.4": {} },
    });
    const passed = await cli([
      "requires",
      join(dir, "jws"),
      "--version",
      "0.9.1-main.4",
      "--origin",
      origin,
      "--timeout",
      "0",
    ]);
    expect(passed.code).toBe(0);
    expect(passed.out).toContain(
      "ok   @polaris-key/jws@0.9.1-main.4 -> @polaris-key/protocol@0.9.1-main.4 is on the feed",
    );
  });

  it("the gate refuses a range pin and a tarball at another version, without reading the feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pkey-gate-"));
    await pack(join(dir, "jws"), {
      name: "@polaris-key/jws",
      version: "0.9.1-main.4",
      dependencies: { "@polaris-key/protocol": "^0.9.0" },
    });
    const r = await cli([
      "requires",
      join(dir, "jws"),
      "--version",
      "0.9.1-main.5",
      "--origin",
      "http://127.0.0.1:9",
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not at 0.9.1-main.5");
    expect(r.out).toContain("a range");
  });

  it("absent: passes a version the feed never got, refuses one it lists", async () => {
    feed = new Map([["@polaris-key/jws", { versions: { "0.8.33": {} } }]]);
    const ok = await cli([
      "absent",
      "@polaris-key/jws@0.8.28",
      "--origin",
      origin,
    ]);
    expect(ok.code).toBe(0);
    const taken = await cli([
      "absent",
      "@polaris-key/jws@0.8.33",
      "--origin",
      origin,
    ]);
    expect(taken.code).toBe(1);
    expect(taken.out).toContain("is already on the feed");
  });

  it("the full check lists the nine, passes once they resolve, and scopes errors to --version", async () => {
    feed = recordedFeed();
    const broken = await cli(["--origin", origin]);
    expect(broken.code).toBe(1);
    for (const l of BROKEN_2026_10_08) expect(broken.out).toContain(`  ${l}`);
    expect(broken.out).toContain(
      "npm: 9 of 177 versions of 10 packages pin a sibling the feed does not have:",
    );
    expect(broken.out).toContain(
      "pypi: all 1 versions of polaris-key have a file to install.",
    );

    // Today's release is whole and closed: the nine are warnings, not errors.
    const scoped = await cli([
      "--origin",
      origin,
      "--ecosystem",
      "npm",
      "--version",
      "0.8.33",
      "--complete",
    ]);
    expect(scoped.code).toBe(0);
    expect(scoped.out).toContain(
      "::warning::@polaris-key/node@0.8.28: @polaris-key/jws@0.8.28 is not on the feed",
    );
    expect(scoped.out).not.toContain("::error::");

    // 0.8.29 is neither whole (node and protocol never landed) nor closed.
    const v29 = await cli([
      "--origin",
      origin,
      "--ecosystem",
      "npm",
      "--version",
      "0.8.29",
      "--complete",
    ]);
    expect(v29.code).toBe(1);
    expect(v29.out).toContain(
      "::error::@polaris-key/node does not list 0.8.29",
    );

    const whatIf = await cli([
      "--origin",
      origin,
      "--ecosystem",
      "npm",
      "--assume",
      "@polaris-key/jws@0.8.28,@polaris-key/protocol@0.8.29",
    ]);
    expect(whatIf.code).toBe(0);

    feed = withVersions(recordedFeed(), REPAIR);
    const repaired = await cli(["--origin", origin, "--ecosystem", "npm"]);
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain(
      "npm: every pin of all 179 versions of 10 packages resolves.",
    );
  });
});

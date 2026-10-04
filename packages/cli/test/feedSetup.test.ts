/**
 * `pkey feeds setup` (F-12). The CLI half of the shared test: every case in
 * `packages/shared-manifest/test/fixtures/feed-setup/cases.json` the CLI can express (no
 * shown-once token, which only the console's token dialog holds) is run through `runPkey` and
 * must print its golden byte for byte. The console's Setup tab test compares against the same
 * goldens, so the two are byte-identical for the same input.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared-manifest/test/fixtures/feed-setup",
);

interface Case {
  id: string;
  ecosystem: string;
  owner: string;
  namespace?: Record<string, string | string[]>;
  package?: { name: string; version?: string };
  credential?: { kind: string; name?: string };
}

const { origin, cases } = JSON.parse(
  readFileSync(join(FIXTURES, "cases.json"), "utf8"),
) as { origin: string; cases: Case[] };

function argsOf(c: Case): string[] {
  const args = [
    "feeds",
    "setup",
    "--ecosystem",
    c.ecosystem,
    "--owner",
    c.owner,
    "--origin",
    origin,
  ];
  for (const [key, value] of Object.entries(c.namespace ?? {}))
    args.push(
      "--namespace",
      `${key}=${Array.isArray(value) ? value.join(",") : value}`,
    );
  if (c.package) {
    args.push("--package", c.package.name);
    if (c.package.version) args.push("--version", c.package.version);
  }
  if (c.credential?.kind === "env")
    args.push("--token-env", c.credential.name!);
  return args;
}

async function run(args: string[]) {
  let out = "";
  let err = "";
  const code = await runPkey(args, {
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: { write: (s: string) => ((err += s), true) },
  });
  return { code, out, err };
}

describe("pkey feeds setup", () => {
  const cliCases = cases.filter(
    (c) => !c.credential || c.credential.kind === "env",
  );

  it("covers most shared cases", () => {
    expect(cliCases.length).toBeGreaterThanOrEqual(cases.length - 3);
  });

  for (const c of cliCases)
    it(`prints the shared golden: ${c.id}`, async () => {
      const { code, out, err } = await run(argsOf(c));
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toBe(readFileSync(join(FIXTURES, `${c.id}.txt`), "utf8"));
    });

  it("defaults the origin to pkg.plrs.im", async () => {
    const { out } = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "npm",
      "--owner",
      "polaris-key",
      "--namespace",
      "scope=@polaris-key",
    ]);
    expect(out).toBe(readFileSync(join(FIXTURES, "npm-feed.txt"), "utf8"));
  });

  it("prints JSON with --json", async () => {
    const { out } = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "oci",
      "--owner",
      "acme",
      "--package",
      "server",
      "--json",
    ]);
    const parsed = JSON.parse(out) as {
      ecosystem: string;
      snippets: { id: string; code: string }[];
    };
    expect(parsed.ecosystem).toBe("oci");
    expect(parsed.snippets[0]!.code).toBe(
      "docker pull pkg.plrs.im/acme/server:latest",
    );
  });

  it("refuses bad input with the reason", async () => {
    const usage = await run(["feeds", "setup", "--ecosystem", "npm"]);
    expect(usage.code).toBe(1);
    expect(usage.err).toContain("pkey feeds setup --ecosystem");
    const eco = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "cargo",
      "--owner",
      "acme",
    ]);
    expect(eco.err).toContain("--ecosystem must be one of");
    const ns = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "npm",
      "--owner",
      "acme",
      "--namespace",
      "publisher=acme",
    ]);
    expect(ns.err).toContain("--namespace takes scope=");
    const oci = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "oci",
      "--owner",
      "acme",
      "--namespace",
      "x=y",
    ]);
    expect(oci.err).toContain("no namespace to set");
    const token = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "npm",
      "--owner",
      "acme",
      "--token-env",
      "pkeyr_secret-value",
    ]);
    expect(token.err).toContain("never the token itself");
    const name = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "npm",
      "--owner",
      "acme",
      "--package",
      "left-pad",
    ]);
    expect(name.err).toContain("is not a npm package name");
    const version = await run([
      "feeds",
      "setup",
      "--ecosystem",
      "npm",
      "--owner",
      "acme",
      "--version",
      "1.0.0",
    ]);
    expect(version.err).toContain("--version goes with --package");
  });
});

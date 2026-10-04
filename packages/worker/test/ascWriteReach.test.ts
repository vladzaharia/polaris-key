/**
 * A-17a — nothing reaches App Store Connect around the write gate.
 *
 * The deny-by-default gate (`core/asc/writeGate.ts`) runs inside `AscClient.send`, before a token
 * is minted. It is the ONLY barrier between the Worker's Admin ASC key and Apple, so this suite
 * makes "every request goes through `AscClient`" a CI fact rather than a convention, in three
 * directions:
 *
 *   1. **The token minters.** `ascToken` and `platformAscToken` (`core/outletTokens.ts`) are named
 *      only by their owner and the two files that build an `AscClient` around them
 *      (`connectors/asc/run.ts`, `connectors/asc/platform.ts`). A bearer token anywhere else could
 *      be sent with a raw `fetch`.
 *   2. **The client.** `new AscClient(` appears only in those same two files, so no other code
 *      builds a client with a token source of its own.
 *   3. **The host.** No source file but `core/asc/client.ts` spells `api.appstoreconnect.apple.com`,
 *      so no raw `fetch` to Apple's API exists outside the gated client.
 *
 * Adding a file to an allowlist is a custody decision: it needs a review that says why, and the
 * threat model's write-gate review trigger applies. Like `outletCredentialReach.test.ts`, this is
 * a regex over source that errs toward false positives; only block comments and whole-line `//`
 * comments are ignored for (1) and (2), and nothing is ignored for (3).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, "..");
const SRC = join(WORKER_ROOT, "src");

const CLIENT_BUILDERS = [
  "src/services/distribution/connectors/asc/run.ts",
  "src/services/distribution/connectors/asc/platform.ts",
];
const MINTER_ALLOW_FILES = ["src/core/outletTokens.ts", ...CLIENT_BUILDERS];
const CLIENT_ALLOW_FILES = CLIENT_BUILDERS;
const HOST_ALLOW_FILES = ["src/core/asc/client.ts"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(WORKER_ROOT, p).split(sep).join("/");

/** The source with block comments and whole-line `//` comments removed. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const FILES = sourceFiles(SRC).map((p) => ({
  file: rel(p),
  src: readFileSync(p, "utf8"),
}));

/** The files outside `allow` whose text matches `re`. */
function offenders(
  re: RegExp,
  allow: readonly string[],
  strip: boolean,
): string[] {
  return FILES.filter(
    ({ file, src }) =>
      !allow.includes(file) && re.test(strip ? code(src) : src),
  ).map((f) => f.file);
}

describe("A-17a: the write gate cannot be bypassed", () => {
  it("scans the Worker's source", () => {
    expect(FILES.length).toBeGreaterThan(50);
    for (const f of [...MINTER_ALLOW_FILES, ...HOST_ALLOW_FILES])
      expect(
        FILES.some((s) => s.file === f),
        f,
      ).toBe(true);
  });

  it("only the client builders name the ASC token minters", () => {
    expect(
      offenders(/\b(ascToken|platformAscToken)\b/, MINTER_ALLOW_FILES, true),
    ).toEqual([]);
  });

  it("only the client builders construct an AscClient", () => {
    expect(
      offenders(/\bnew\s+AscClient\s*\(/, CLIENT_ALLOW_FILES, true),
    ).toEqual([]);
  });

  it("only the gated client spells App Store Connect's API host", () => {
    expect(
      offenders(/api\.appstoreconnect\.apple\.com/i, HOST_ALLOW_FILES, false),
    ).toEqual([]);
  });

  it("the gated client checks every request before it mints a token", () => {
    const client = FILES.find((f) => f.file === "src/core/asc/client.ts")!.src;
    const send = client.slice(client.indexOf("private async send("));
    const gate = send.indexOf("checkAscRequest(");
    const token = send.indexOf("this.bearer(");
    const fetchAt = send.indexOf("this.fetchImpl(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(token);
    expect(token).toBeLessThan(fetchAt);
  });
});

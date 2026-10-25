// The retired console-cookie variable (ST-34.9, D-5): setting it refuses every admin command,
// with the one fix, before the store is opened and before anything is sent.

import { describe, expect, it } from "vitest";
import { runPkey } from "../src/index.js";
import { RETIRED_COOKIE_REFUSAL, retiredCookieSet } from "../src/retired.js";

const COOKIE_ENV = "PKEY_ADMIN_COOKIE";
const TOKEN = `pkeyp_${"P".repeat(43)}`;
const GODOT = `${import.meta.dirname}/fixtures/godot-listing`;

async function run(argv: string[], env: Record<string, string>, columns = 0) {
  let out = "";
  let err = "";
  let network = 0;
  let storeOpened = 0;
  const code = await runPkey(argv, {
    cwd: import.meta.dirname,
    env: { CI: "true", NO_COLOR: "1", TERM: "xterm-256color", ...env },
    stdout: { write: (s: string) => ((out += s), true) },
    stderr: {
      write: (s: string) => ((err += s), true),
      ...(columns ? { isTTY: true, columns } : {}),
    },
    credentialStore: async () => {
      storeOpened++;
      throw new Error("the store must not be opened");
    },
    fetchImpl: (async () => {
      network++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  return { code, out, err, network, storeOpened };
}

const COMMANDS: [string, string[]][] = [
  [
    "bundle",
    [
      "bundle",
      "--product",
      "djdl",
      "--device",
      "AbCdEfGh0123456789_-ijKLmnOPqrst",
      "--grace-days",
      "30",
    ],
  ],
  ["migrate", ["migrate", "list"]],
  ["listing import", ["listing", "import", "--godot", GODOT, "--product", "d"]],
  ["whoami", ["whoami"]],
];

describe("PKEY_ADMIN_COOKIE is refused, not read", () => {
  it("is one constant: a sentence and one fix", () => {
    expect(RETIRED_COOKIE_REFUSAL.message).toBe(
      "PKEY_ADMIN_COOKIE isn't used any more.",
    );
    expect(RETIRED_COOKIE_REFUSAL.fix).toBe("Run pkey login once.");
    expect(retiredCookieSet({ [COOKIE_ENV]: "x" })).toBe(true);
    expect(retiredCookieSet({ [COOKIE_ENV]: "" })).toBe(false);
    expect(retiredCookieSet({})).toBe(false);
  });

  describe.each(COMMANDS)("pkey %s", (_name, argv) => {
    it.each([
      ["alone", {}],
      ["with a token too", { PKEY_ADMIN_TOKEN: TOKEN }],
    ])(
      "refuses %s: exit 4, before the store and the network",
      async (_l, extra) => {
        const r = await run(argv, {
          [COOKIE_ENV]: "__Host-pkey_admin=session-value",
          ...extra,
        });
        expect(r.code).toBe(4);
        expect(r.err).toBe(
          "▲  PKEY_ADMIN_COOKIE isn't used any more.\n   Run pkey login once.\n",
        );
        expect(r.err).not.toContain("session-value");
        expect(r.out).toBe("");
        expect(r.network).toBe(0);
        expect(r.storeOpened).toBe(0);
      },
    );
  });

  it("listing import --dry-run reads no credential, so it is not refused", async () => {
    const r = await run(["listing", "import", "--godot", GODOT, "--dry-run"], {
      [COOKIE_ENV]: "x",
    });
    expect(r.code).toBe(0);
  });

  it.each([80, 40])("the old-cookie frame at %i columns", async (columns) => {
    const r = await run(["migrate", "list"], { [COOKIE_ENV]: "x" }, columns);
    for (const line of r.err.split("\n"))
      expect([...line].length).toBeLessThanOrEqual(columns);
    // Wrapped to the width, nothing lost: the sentence, then the fix on its own line.
    expect(r.err.startsWith("▲  PKEY_ADMIN_COOKIE isn't used")).toBe(true);
    expect(r.err.replace(/\n\s*/g, " ")).toBe(
      "▲  PKEY_ADMIN_COOKIE isn't used any more. Run pkey login once. ",
    );
    expect(r.err.endsWith("\n   Run pkey login once.\n")).toBe(true);
  });
});

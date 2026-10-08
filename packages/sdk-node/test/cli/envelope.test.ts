// @pkey-feature ui.cli
// The `--json` envelope both terminal kits print (docs/design/UI-KITS.md §1.4 "Terminal"; the
// Python kit, UK-13, is the reference): NDJSON, "v": 1 and "command" on every line, the verb's
// fields flattened onto a last "event": "result" line with "ok" and "exit"; "error" only on a
// failure with a code ("usage", "internal", "interrupted" or a registry code); "message" only for
// a usage error and an import-bundle failure; exit codes 0, 1, 2 and 130.

import { describe, expect, it } from "vitest";
import { runKitVerb } from "../../src/cli/adapter.js";
import { CLI_VERBS } from "../../src/cli/kit.js";
import { envelope, EXIT } from "../../src/cli/json.js";
import {
  FakeStdin,
  frozenTicker,
  KEY,
  NOW,
  settle,
  stubClient,
} from "./harness.js";
import { Screen } from "./screen.js";

const verb = (path: string) =>
  CLI_VERBS.find((v) => v.path.join(" ") === path)!;

async function json(path: string, client = stubClient(), args: unknown[] = []) {
  const screen = new Screen();
  const code = await runKitVerb(
    verb(path),
    args,
    { json: true },
    async () => client,
    {
      slug: "tidewater",
      io: {
        stdout: screen,
        stderr: new Screen(),
        env: {},
        ticker: frozenTicker,
        now: () => NOW,
      },
    },
  );
  const lines = screen.raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { code, lines, last: lines.at(-1)! };
}

describe("the --json envelope (UI-KITS §1.4)", () => {
  it("flattens the verb's fields onto the result line (status, the Python kit's fields)", async () => {
    const { code, last } = await json("status");
    expect(code).toBe(0);
    expect(Object.keys(last)).toEqual([
      "v",
      "command",
      "event",
      "ok",
      "exit",
      "status",
      "usable",
      "component",
      "state",
      "graceUntil",
      "allowedRange",
      "profile",
      "version",
      "channel",
      "tier",
      "tokenStore",
    ]);
    expect(last).toMatchObject({
      v: 1,
      command: "status",
      event: "result",
      ok: true,
      exit: 0,
      status: "ok",
      usable: true,
    });
    expect(last).not.toHaveProperty("result");
    expect(last).not.toHaveProperty("error");
    expect(last).not.toHaveProperty("message");
  });

  it("an unusable license is exit 1 with no error field", async () => {
    const { code, last } = await json(
      "status",
      stubClient({ status: () => ({ status: "revoked" }) }),
    );
    expect(code).toBe(1);
    expect(last).toMatchObject({
      ok: false,
      exit: 1,
      status: "revoked",
      usable: false,
    });
    expect(last).not.toHaveProperty("error");
  });

  it("an activation refusal carries kind and code, exit 1 (device limit included)", async () => {
    const { code, last } = await json(
      "activate",
      stubClient({
        license: {
          activateWithKey: async () => ({
            kind: "device-limit",
            code: "device_limit",
            limit: 3,
            deviceCount: 3,
            manageUrl: "https://key.plrs.im/p",
          }),
        },
      }),
      [KEY],
    );
    expect(code).toBe(1);
    expect(last).toMatchObject({
      ok: false,
      exit: 1,
      kind: "device-limit",
      code: "device_limit",
      deviceCount: 3,
      limit: 3,
      manageUrl: "https://key.plrs.im/p",
    });
    expect(last).not.toHaveProperty("message");
  });

  it("a network failure is exit 1 with its code, never 4", async () => {
    const { code, last } = await json(
      "changelog",
      stubClient({
        release: {
          changelog: async () =>
            Promise.reject(Object.assign(new Error("x"), { code: "network" })),
        },
      }),
    );
    expect(code).toBe(1);
    expect(last).toMatchObject({ ok: false, exit: 1, error: "network" });
  });

  it("an untyped exception is error internal, exit 1", async () => {
    const { code, last } = await json(
      "status",
      stubClient({
        status: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(code).toBe(1);
    expect(last).toEqual({
      v: 1,
      command: "status",
      event: "result",
      ok: false,
      exit: 1,
      error: "internal",
    });
  });

  it("a usage error is exit 2 with error usage and a message", async () => {
    const screen = new Screen();
    const code = await runKitVerb(
      verb("config get"),
      [],
      { json: true },
      async () => stubClient(),
      {
        slug: "tidewater",
        usage: true,
        io: {
          stdout: screen,
          stderr: new Screen(),
          env: {},
          ticker: frozenTicker,
          now: () => NOW,
        },
      },
    );
    expect(code).toBe(EXIT.usage);
    expect(JSON.parse(screen.raw)).toEqual({
      v: 1,
      command: "config get",
      event: "result",
      ok: false,
      exit: 2,
      usage: "tidewater config get <key>",
      error: "usage",
      message: "tidewater config get <key>",
    });
  });

  it("an import-bundle failure carries its message, as the Python kit's does", async () => {
    const { last } = await json(
      "import-bundle",
      stubClient({
        extra: {
          importBundle: async () =>
            Promise.reject(
              Object.assign(new Error("bad signature"), {
                code: "bundle-jws-rejected",
              }),
            ),
        },
      }),
      ["/nonexistent"],
    );
    expect(last).toMatchObject({
      ok: false,
      exit: 1,
      error: "bundle-jws-rejected",
      message: "bad signature",
    });
  });

  it("never lets a verb field replace v, command, event, ok or exit", () => {
    expect(
      envelope("x", {
        exitCode: 0,
        result: { v: 9, ok: false, exit: 5, event: "y", command: "z", a: 1 },
      }),
    ).toEqual({
      v: 1,
      command: "x",
      event: "result",
      ok: true,
      exit: 0,
      a: 1,
    });
  });
});

describe("exit codes 0, 1, 2 and 130", () => {
  async function prompt(press: (s: FakeStdin) => void) {
    const stdin = new FakeStdin(true);
    const p = runKitVerb(verb("activate"), [], {}, async () => stubClient(), {
      slug: "tidewater",
      io: {
        stdout: new Screen(),
        stderr: new Screen(),
        stdin,
        env: {},
        ticker: frozenTicker,
        now: () => NOW,
      },
    });
    await settle();
    press(stdin);
    return p;
  }
  it("Ctrl-C at a prompt is 130 (interrupted); Esc is 1 (cancelled)", async () => {
    expect(
      await prompt((s) => s.press("c", { ctrl: true, sequence: "\x03" })),
    ).toBe(130);
    expect(await prompt((s) => s.press("escape", { sequence: "\x1b" }))).toBe(
      1,
    );
  });
});

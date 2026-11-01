// @pkey-feature identity.nearby
// Nearby sign-in in the Node terminal kit (I-47.12; plans/I-47-slices.md D-5, D-6, D-10): `login`
// looks for the person's other devices first (a lone approver after 3 s, several by number, `c`
// for a code, nothing in 2 s hands over to the regular sign-in), the account is confirmed after
// the poll signed in (`n` = Not you? signs out), and `devices approve` shows the three codes as
// choices 1-3 with `d` = Deny. Never under `--json`, in CI or on a pipe. Everything from the
// other device is display data from an unverified peer: it is cleaned before it is drawn (SR-47).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import {
  devicesApproveFlow,
  LISTEN_MS,
  LONE_MS,
} from "../../src/cli/nearby.js";
import { loginFlow } from "../../src/cli/flows.js";
import { stripAnsi } from "../../src/cli/term/width.js";
import { EXIT, type FlowResult } from "../../src/cli/json.js";
import {
  FakeNearbySession,
  render,
  settle,
  stubClient,
  VARIANTS,
  type Harness,
  type RunOptions,
} from "./harness.js";

const V = VARIANTS.find((v) => v.id === "no-color-80")!;
const ANA = { id: "a1", label: "Ana's laptop", platform: "macos" };
const BEN = { id: "a2", label: "Ben's phone", platform: "ios" };

const plain = (t: string): string => stripAnsi(t);

/** Let the flow run until `cond` holds (keys reach it through readline, a few turns later). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 5)
    await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

/** Run `body` on a terminal; the flow's result and the screen it left come back. */
async function run(
  o: Omit<RunOptions, "variant">,
  body: (h: Harness) => Promise<FlowResult>,
): Promise<{ result: FlowResult; text: string; raw: string }> {
  let result!: FlowResult;
  const r = await render({ ...o, variant: V }, async (h) => {
    result = await body(h);
  });
  return { result, text: plain(r.text), raw: r.raw };
}

const nearby = (
  session: FakeNearbySession,
  over: { available?: () => Promise<boolean>; calls?: string[] } = {},
) =>
  stubClient({
    identity: {
      nearby: {
        available: async (o: unknown) => {
          over.calls?.push(`available:${JSON.stringify(o)}`);
          return (over.available ?? (async () => true))();
        },
      },
      nearbyStart: async () => {
        over.calls?.push("start");
        return session;
      },
    },
  });

describe("login: nearby first", () => {
  it("a lone approver is chosen only once the 3 s window has passed (D-5)", async () => {
    // The windows never elapse here: the approver is listed, not chosen.
    const waiting = new FakeNearbySession([ANA], {
      signedInAfterChoose: false,
    });
    const calls: string[] = [];
    await run({ interactive: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(waiting, { calls }));
      await until(() => calls.includes("start"));
      await settle();
      expect(waiting.chosen).toEqual([]);
      h.stdin.press("escape");
      return done;
    });
    expect(calls).toEqual(['available:{"role":"requester"}', "start"]);
    // The window passed: it is chosen without a key.
    const passed = new FakeNearbySession([ANA], { signedInAfterChoose: false });
    await run({ interactive: true, fastDelay: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(passed));
      await until(() => passed.chosen.length === 1);
      expect(passed.chosen).toEqual(["a1"]);
      h.stdin.press("escape");
      return done;
    });
    expect([LISTEN_MS, LONE_MS]).toEqual([2000, 3000]);
  });

  it("shows the code as 482 913, then the account, and Enter confirms it", async () => {
    const s = new FakeNearbySession([ANA]);
    let wait = "";
    const { result, text } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await until(() => plain(h.screen.text()).includes("Enter continue"));
        wait = plain(h.screen.text());
        h.stdin.press("return");
        return done;
      },
    );
    // The poll answered at once in this fake, so the screen at rest is the done step.
    expect(wait).toContain("Signed in as mara@fennick.studio");
    expect(wait).toContain("Enter continue");
    expect(wait).toContain("n or Esc not you, sign out");
    // Still held: the active mark, not the check (UXR-47 B2). The check is the committed frame.
    expect(wait).toContain("◆  Signed in as");
    expect(wait).not.toContain("✓");
    expect(text).toContain("✓  Signed in as mara@fennick.studio");
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.state).toBe("signedIn");
    expect(s.chosen).toEqual(["a1"]);
    expect(s.confirmed).toBe(1);
    expect(s.declined).toBe(0);
    expect(text).toContain("Signed in as mara@fennick.studio");
  });

  it("the code view: the chosen device, the code once, a short wait line, c use a code instead", async () => {
    const s = new FakeNearbySession([ANA], { signedInAfterChoose: false });
    let shown = "";
    await run({ interactive: true, fastDelay: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(s));
      await until(() => plain(h.screen.text()).includes("Tap this code there"));
      shown = plain(h.screen.text());
      h.stdin.press("escape");
      return done;
    });
    expect(shown).toContain("Approve on your other device");
    expect(shown).toContain("482 913");
    // The code once: its screen reader line is its a11y name, never a second visible row (UXR-47 B3).
    expect(shown).not.toContain("Code to tap");
    expect(shown.split("482 913")).toHaveLength(2);
    expect(shown).toContain("Open Tidewater Studio on Ana's laptop.");
    expect(shown).toContain("Waiting…");
    expect(shown).not.toContain("approve it on the other device");
    expect(shown).toContain("c use a code instead");
    expect(shown).not.toContain("browser");
  });

  it("n is Not you?: the held records are dropped, the device signs out, and the exit is 1", async () => {
    const s = new FakeNearbySession([ANA]);
    const { result, text } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await until(() => plain(h.screen.text()).includes("not you, sign out"));
        h.stdin.press("n");
        return done;
      },
    );
    expect(s.declined).toBe(1);
    expect(s.confirmed).toBe(0);
    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.state).toBe("declined");
    expect(text).toContain("Signed out");
    expect(text).toContain("tidewater login");
  });

  it("Esc at the confirmation is not a confirmation: it signs out too", async () => {
    const s = new FakeNearbySession([ANA]);
    await run({ interactive: true, fastDelay: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(s));
      await until(() => plain(h.screen.text()).includes("not you, sign out"));
      h.stdin.press("escape");
      return done;
    });
    expect(s.declined).toBe(1);
    expect(s.confirmed).toBe(0);
  });

  it("nearby sign-in CLI: the confirm screen ends when the session times out", async () => {
    const s = new FakeNearbySession([ANA]);
    const { result, text } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await until(() => plain(h.screen.text()).includes("not you, sign out"));
        s.end();
        return done;
      },
    );
    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.state).toBe("expired");
    expect(s.confirmed).toBe(0);
    expect(text).not.toContain("✓  Signed in as");
  });

  it("nearby sign-in CLI: confirm after the deadline reports expired", async () => {
    const s = new FakeNearbySession([ANA]);
    const { result, text } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await until(() => plain(h.screen.text()).includes("not you, sign out"));
        // The deadline passes in the same turn as Enter: the session refuses to confirm.
        s.ended = true;
        h.stdin.press("return");
        return done;
      },
    );
    expect(result.state).toBe("expired");
    expect(s.confirmed).toBe(0);
    expect(text).not.toContain("✓  Signed in as");
  });

  it("several approvers are listed and picked by number", async () => {
    const s = new FakeNearbySession([ANA, BEN], { signedInAfterChoose: false });
    let list = "";
    let code = "";
    await run({ interactive: true, fastDelay: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(s));
      await until(() => plain(h.screen.text()).includes("2  Ben's phone"));
      list = plain(h.screen.text());
      // No automatic choice with two devices to pick from.
      expect(s.chosen).toEqual([]);
      h.stdin.press("2");
      await until(() => plain(h.screen.text()).includes("Tap this code there"));
      code = plain(h.screen.text());
      h.stdin.press("escape");
      return done;
    });
    expect(list).toContain("1  Ana's laptop");
    expect(list).toContain("2  Ben's phone");
    // The hint shows the real range (UXR-47 B5).
    expect(list).toContain("1-2 choose a device");
    expect(list).not.toContain("1-9");
    expect(s.chosen).toEqual(["a2"]);
    expect(code).toContain("482 913");
  });

  it("a lone approver shows its row during the 3 s wait, and 1 skips the wait", async () => {
    const s = new FakeNearbySession([ANA], { signedInAfterChoose: false });
    let row = "";
    await run({ interactive: true }, async (h) => {
      const done = loginFlow(h.ctx, nearby(s));
      await until(() => plain(h.screen.text()).includes("1  Ana's laptop"));
      row = plain(h.screen.text());
      expect(s.chosen).toEqual([]);
      h.stdin.press("1");
      await until(() => plain(h.screen.text()).includes("Tap this code there"));
      h.stdin.press("escape");
      return done;
    });
    expect(row).toContain("1 choose this device");
    expect(s.chosen).toEqual(["a1"]);
  });

  it("c uses a code instead: nearby is cancelled and the device-code sign-in runs", async () => {
    const s = new FakeNearbySession([ANA], { signedInAfterChoose: false });
    let waited = 0;
    const client = stubClient({
      identity: {
        nearby: { available: async () => true },
        nearbyStart: async () => s,
        waitForSignIn: async () => {
          waited += 1;
          return {
            status: "ready",
            identity: { email: "mara@fennick.studio" },
          };
        },
      },
    });
    const { result } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, client);
        await settle();
        h.stdin.press("c");
        return done;
      },
    );
    expect(s.cancelled).toBe(true);
    expect(waited).toBe(1);
    expect(result.state).toBe("signedIn");
  });

  it("Esc cancels without an error, and Ctrl-C is an interrupt", async () => {
    for (const [name, opts, exit] of [
      ["escape", {}, EXIT.failed],
      ["c", { ctrl: true, sequence: "\x03" }, EXIT.interrupted],
    ] as const) {
      const s = new FakeNearbySession([ANA], { signedInAfterChoose: false });
      const { result, text } = await run(
        { interactive: true, fastDelay: true },
        async (h) => {
          const done = loginFlow(h.ctx, nearby(s));
          await settle();
          h.stdin.press(name, opts);
          return done;
        },
      );
      expect(s.cancelled).toBe(true);
      expect(result.exitCode).toBe(exit);
      expect(text).not.toContain("✗");
    }
  });

  it("nobody answering in 2 s cancels nearby and the regular sign-in runs", async () => {
    const s = new FakeNearbySession([]);
    let waited = 0;
    const client = stubClient({
      identity: {
        nearby: { available: async () => true },
        nearbyStart: async () => s,
        waitForSignIn: async () => {
          waited += 1;
          return {
            status: "ready",
            identity: { email: "mara@fennick.studio" },
          };
        },
      },
    });
    const { result } = await run(
      { interactive: true, fastDelay: true },
      async (h) => loginFlow(h.ctx, client),
    );
    expect(s.cancelled).toBe(true);
    expect(s.chosen).toEqual([]);
    expect(waited).toBe(1);
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("a refused poll after the tap is the sign-in's own refusal", async () => {
    const s = new FakeNearbySession([ANA], { outcome: "denied" });
    const { result, text } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await settle();
        return done;
      },
    );
    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.state).toBe("denied");
    expect(result.error?.code).toBe("sign-in-denied");
    expect(text).toContain("tidewater login");
  });

  it("does not start under --json, with --device-code, without a terminal, or on a headless computer", async () => {
    const cases: Omit<RunOptions, "variant">[] = [
      { interactive: true, json: true },
      { interactive: false },
      { interactive: true, headless: true },
    ];
    for (const o of cases) {
      const calls: string[] = [];
      await run(o, (h) =>
        loginFlow(h.ctx, nearby(new FakeNearbySession([ANA]), { calls })),
      );
      expect(calls, JSON.stringify(o)).toEqual([]);
    }
    const calls: string[] = [];
    await run({ interactive: true }, (h) =>
      loginFlow(h.ctx, nearby(new FakeNearbySession([ANA]), { calls }), {
        deviceCode: true,
      }),
    );
    expect(calls).toEqual([]);
  });

  it("is off where nearby is not on offer: the regular sign-in, silently", async () => {
    const calls: string[] = [];
    const { result } = await run({ interactive: true }, (h) =>
      loginFlow(
        h.ctx,
        nearby(new FakeNearbySession([ANA]), {
          calls,
          available: async () => false,
        }),
      ),
    );
    expect(calls).toEqual(['available:{"role":"requester"}']);
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("an unsupported runtime or a product with no nearby falls through to the regular sign-in", async () => {
    for (const code of ["nearby-unsupported", "service-unavailable"]) {
      const client = stubClient({
        identity: {
          nearby: { available: async () => true },
          nearbyStart: async () => {
            throw new PolarisError(code, "nope");
          },
        },
      });
      const { result } = await run({ interactive: true }, (h) =>
        loginFlow(h.ctx, client),
      );
      expect(result.exitCode, code).toBe(EXIT.ok);
    }
  });

  describe("macOS asks for the Local Network on the first browse", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0))
        rmSync(d, { recursive: true, force: true });
    });
    const withState = (s: FakeNearbySession, state: string) =>
      stubClient({
        identity: {
          nearby: { available: async () => true },
          nearbyStart: async () => s,
        },
        extra: {
          core: {
            version: "2.4.1",
            channel: "stable",
            deviceId: "dev_9fK2Lw7QmZ",
            baseUrl: "https://key.plrs.im",
            dirs: { state },
          },
        },
      });

    it("explains first, and remembers that a browse worked", async () => {
      const state = mkdtempSync(join(tmpdir(), "pkey-nearby-"));
      dirs.push(state);
      const s = new FakeNearbySession([ANA], { signedInAfterChoose: false });
      let prompt = "";
      await run(
        { interactive: true, fastDelay: true, platform: "darwin" },
        async (h) => {
          const done = loginFlow(h.ctx, withState(s, state));
          await until(() => plain(h.screen.text()).includes("Enter continue"));
          prompt = plain(h.screen.text());
          expect(s.chosen).toEqual([]);
          h.stdin.press("return");
          await until(() => s.chosen.length === 1);
          h.stdin.press("escape");
          return done;
        },
      );
      expect(prompt).toContain("Sign in with your phone");
      expect(prompt).toContain(
        "allow Tidewater Studio to find devices on your network",
      );
      expect(prompt).toContain("Enter continue");
      expect(s.chosen).toEqual(["a1"]);
      expect(readFileSync(join(state, "nearby-browsed"), "utf8")).toBe("1\n");

      // The next run starts at once: no explanation.
      const again = new FakeNearbySession([ANA], {
        signedInAfterChoose: false,
      });
      let second = "";
      await run(
        { interactive: true, fastDelay: true, platform: "darwin" },
        async (h) => {
          const done = loginFlow(h.ctx, withState(again, state));
          await until(() => plain(h.screen.text()).includes("482 913"));
          second = plain(h.screen.text());
          h.stdin.press("escape");
          return done;
        },
      );
      expect(second).not.toContain("Sign in with your phone");
      expect(second).toContain("482 913");
    });

    it("Not now goes to the regular sign-in and starts nothing", async () => {
      const state = mkdtempSync(join(tmpdir(), "pkey-nearby-"));
      dirs.push(state);
      const calls: string[] = [];
      const s = new FakeNearbySession([ANA]);
      const client = nearby(s, { calls });
      (client.core as unknown as { dirs: { state: string } }).dirs = { state };
      const { result } = await run(
        { interactive: true, fastDelay: true, platform: "darwin" },
        async (h) => {
          const done = loginFlow(h.ctx, client);
          await settle();
          h.stdin.press("escape");
          return done;
        },
      );
      expect(calls).toEqual(['available:{"role":"requester"}']);
      expect(result.exitCode).toBe(EXIT.ok);
    });
  });

  it("a label from the other device is text, never an escape (SR-47)", async () => {
    const evil = {
      id: "a1",
      label: "Ana\u001b]52;c;ZXZpbA==\u0007's ‮laptop\u001b[2J\u009b",
      platform: "macos",
    };
    const s = new FakeNearbySession([evil, BEN], {
      signedInAfterChoose: false,
    });
    let list = "";
    const { raw } = await run(
      { interactive: true, fastDelay: true },
      async (h) => {
        const done = loginFlow(h.ctx, nearby(s));
        await settle();
        list = plain(h.screen.text());
        h.stdin.press("escape");
        return done;
      },
    );
    expect(list).toContain("Ana");
    for (const bad of ["\u001b]52", "\u001b[2J", "‮", "\u009b", "\u0007"])
      expect(raw, JSON.stringify(bad)).not.toContain(bad);
  });
});

describe("devices approve", () => {
  const CODES = ["111 111", "482 913", "777 777"];
  type Step = Record<string, unknown>;

  /** A client whose `onRequest` hands the handler an ask, and records what the person did. */
  function asking(
    step: Step | ((code: string) => Step),
    o: {
      device?: string | null;
      stops?: string[];
      picks?: string[];
      denies?: string[];
    } = {},
  ) {
    return stubClient({
      identity: {
        nearby: {
          available: async () => true,
          onRequest: async (handler: (a: unknown) => void, opts: unknown) => {
            o.stops?.push(`opts:${JSON.stringify(opts)}`);
            handler({
              device: o.device === undefined ? "New phone" : o.device,
              platform: "linux",
              codes: CODES,
              pick: async (code: string) => {
                o.picks?.push(code);
                return typeof step === "function" ? step(code) : step;
              },
              deny: async () => {
                o.denies?.push("deny");
              },
            });
            return { stop: async () => void o.stops?.push("stop") };
          },
        },
      },
    });
  }

  it("shows the three codes as 1-3 and d = Deny, and picks exactly the code pressed", async () => {
    const picks: string[] = [];
    const stops: string[] = [];
    let ask = "";
    const { result, text } = await run({ interactive: true }, async (h) => {
      const done = devicesApproveFlow(
        h.ctx,
        asking({ kind: "approved" }, { picks, stops }),
      );
      await until(() => plain(h.screen.text()).includes("choose a code"));
      ask = plain(h.screen.text());
      h.stdin.press("4"); // not a code
      h.stdin.press("x");
      await until(() => plain(h.screen.text()).includes("choose a code"));
      expect(picks).toEqual([]);
      h.stdin.press("3");
      return done;
    });
    expect(ask).toContain("Let New phone sign in?");
    expect(ask).toContain("1  111 111");
    expect(ask).toContain("2  482 913");
    expect(ask).toContain("3  777 777");
    expect(ask).toContain("1-3 choose a code · d or Esc deny");
    expect(picks).toEqual(["777 777"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.state).toBe("approved");
    expect(text).toContain("New phone is signed in");
    // The advert stands only while the command runs (D-6): prompt open, stopped on the way out.
    expect(stops).toEqual(['opts:{"prompt":true}', "stop"]);
  });

  it("d denies without picking, Esc denies quietly, and both stop the advert", async () => {
    for (const key of ["d", "escape"]) {
      const picks: string[] = [];
      const denies: string[] = [];
      const stops: string[] = [];
      const { result } = await run({ interactive: true }, async (h) => {
        const done = devicesApproveFlow(
          h.ctx,
          asking({ kind: "approved" }, { picks, denies, stops }),
        );
        await until(() => plain(h.screen.text()).includes("choose a code"));
        h.stdin.press(key);
        return done;
      });
      expect(picks, key).toEqual([]);
      expect(denies, key).toEqual(["deny"]);
      expect(stops, key).toContain("stop");
      expect(result.exitCode, key).toBe(EXIT.failed);
      expect(result.state, key).toBe("denied");
    }
  });

  it("the licence choice: a number gives that license, the last row creates one, Esc denies", async () => {
    const chosen: unknown[] = [];
    const view = {
      state: "choose",
      choices: [
        { id: "lic_1", tierName: "Pro", name: null, state: "free" },
        {
          id: "lic_2",
          tierName: "Team",
          name: "Harbor Audio team",
          state: "free",
        },
        { id: "lic_3", tierName: "Full", name: "Full one", state: "full" },
      ],
      keep: false,
      preselected: null,
      create: { tierName: "Pro", access: "account" },
      getLicense: null,
    };
    const choose = (cancel: () => Promise<Step>): Step => ({
      kind: "choose",
      choices: view,
      choose: async (c: unknown) => {
        chosen.push(c);
        return { kind: "approved" };
      },
      cancel,
    });
    const play = async (key: string) => {
      chosen.length = 0;
      let screen = "";
      const res = await run({ interactive: true }, async (h) => {
        const done = devicesApproveFlow(
          h.ctx,
          asking(choose(async () => ({ kind: "denied" }))),
        );
        await until(() => plain(h.screen.text()).includes("choose a code"));
        h.stdin.press("2");
        await until(() =>
          plain(h.screen.text()).includes("Choose a license for"),
        );
        screen = plain(h.screen.text());
        h.stdin.press(key);
        return done;
      });
      return { ...res, screen };
    };
    const a = await play("2");
    expect(a.screen).toContain("Choose a license for New phone");
    expect(a.screen).toContain("1  Pro");
    expect(a.screen).toContain("2  Harbor Audio team");
    expect(a.screen).toContain("3  Create a new free license");
    expect(a.screen).not.toContain("Full one"); // a full license cannot be given
    expect(chosen).toEqual([{ kind: "license", licenseId: "lic_2" }]);
    expect(a.result.state).toBe("approved");
    await play("3");
    expect(chosen).toEqual([{ kind: "create" }]);
    const c = await play("escape");
    expect(chosen).toEqual([]);
    expect(c.result.state).toBe("denied");
  });

  it("each outcome of the pick has its own screen and exit", async () => {
    const outcomes: [Step, string, number, string][] = [
      [{ kind: "mismatch" }, "mismatch", EXIT.failed, "That code didn't match"],
      [
        { kind: "not-nearby" },
        "not-nearby",
        EXIT.failed,
        "isn't on this network",
      ],
      [
        { kind: "expired" },
        "expired",
        EXIT.failed,
        "Start again on New phone.",
      ],
      [
        { kind: "device-limit" },
        "device-limit",
        EXIT.failed,
        "This license is on all its devices",
      ],
      [{ kind: "rate-limited" }, "rate-limited", EXIT.failed, "Wait a moment"],
      [
        { kind: "account-required" },
        "account-required",
        EXIT.failed,
        "tidewater login",
      ],
    ];
    for (const [step, state, exit, words] of outcomes) {
      const { result, text } = await run({ interactive: true }, async (h) => {
        const done = devicesApproveFlow(h.ctx, asking(step));
        await until(() => plain(h.screen.text()).includes("choose a code"));
        h.stdin.press("1");
        return done;
      });
      expect(result.state).toBe(state);
      expect(result.exitCode).toBe(exit);
      expect(text, state).toContain(words);
    }
  });

  it("an unnamed device is 'the new device', and a hostile name is only text (SR-47)", async () => {
    const unnamed = await run({ interactive: true }, async (h) => {
      const done = devicesApproveFlow(
        h.ctx,
        asking({ kind: "approved" }, { device: null }),
      );
      await until(() => plain(h.screen.text()).includes("choose a code"));
      h.stdin.press("2");
      return done;
    });
    expect(unnamed.text).toContain("The new device is signed in");
    const evil = "Evil\u001b]52;c;ZXZpbA==\u0007 ‮phone\u001b[2J";
    let ask = "";
    const { raw } = await run({ interactive: true }, async (h) => {
      const done = devicesApproveFlow(
        h.ctx,
        asking({ kind: "approved" }, { device: evil }),
      );
      await until(() => plain(h.screen.text()).includes("choose a code"));
      ask = plain(h.screen.text());
      h.stdin.press("d");
      return done;
    });
    expect(ask).toContain("Evil");
    for (const bad of ["\u001b]52", "\u001b[2J", "‮", "\u0007"])
      expect(raw, JSON.stringify(bad)).not.toContain(bad);
  });

  it("waits 300 s for a device to ask, then stops with nothing changed; Esc stops sooner", async () => {
    const stops: string[] = [];
    const quietClient = () =>
      stubClient({
        identity: {
          nearby: {
            available: async () => true,
            onRequest: async () => ({
              stop: async () => void stops.push("stop"),
            }),
          },
        },
      });
    const waiting = await run({ interactive: true }, async (h) => {
      const done = devicesApproveFlow(h.ctx, quietClient());
      await settle();
      expect(plain(h.screen.text())).toContain("Waiting for a device to ask");
      expect(plain(h.screen.text())).toContain("Esc stop");
      h.stdin.press("escape");
      return done;
    });
    expect(waiting.result.state).toBe("cancelled");
    expect(waiting.text).toContain("Nothing changed.");
    expect(stops).toEqual(["stop"]);
    // The 300 s wait elapses: nothing asked, nothing changed, the advert stopped.
    stops.length = 0;
    const timeout = await run({ interactive: true, fastDelay: "all" }, (h) =>
      devicesApproveFlow(h.ctx, quietClient()),
    );
    expect(timeout.result.state).toBe("timeout");
    expect(timeout.result.exitCode).toBe(EXIT.failed);
    expect(stops).toEqual(["stop"]);
  });

  it("is refused before anything starts under --json and without a terminal", async () => {
    for (const o of [
      { interactive: true, json: true },
      { interactive: false },
    ]) {
      const calls: string[] = [];
      const client = stubClient({
        identity: {
          nearby: {
            available: async () => true,
            onRequest: async () => {
              calls.push("onRequest");
              return { stop: async () => undefined };
            },
          },
        },
      });
      const { result } = await run(o, (h) => devicesApproveFlow(h.ctx, client));
      expect(calls, JSON.stringify(o)).toEqual([]);
      expect(result.exitCode).toBe(EXIT.usage);
      expect(result.error?.code).toBe("usage");
    }
  });

  it("an unsupported runtime and a signed-out device are typed results, not crashes", async () => {
    for (const [code, state] of [
      ["nearby-unsupported", "unsupported"],
      ["account_required", "account-required"],
    ] as const) {
      const client = stubClient({
        identity: {
          nearby: {
            available: async () => true,
            onRequest: async () => {
              throw new PolarisError(code, "x");
            },
          },
        },
      });
      const { result, text } = await run({ interactive: true }, (h) =>
        devicesApproveFlow(h.ctx, client),
      );
      expect(result.state).toBe(state);
      expect(result.error).toBeUndefined();
      expect(text).toContain(
        state === "unsupported"
          ? "Can't approve from this computer"
          : "tidewater login",
      );
    }
  });
});

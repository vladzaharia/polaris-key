// @pkey-feature ui.cli
// The Node terminal kit on a real pseudo-terminal: the key reader, the OSC 11 and cursor-position
// questions, SIGWINCH and a person's terminal (@xterm/headless) answering, all real. The program
// is `pty-flow.ts`, run through `pty-relay.py` (python3's pty module; Node has none).

import { afterEach, describe, expect, it } from "vitest";
import { Pty, ptyAvailable, type PtyOptions } from "./pty.js";

const live: Pty[] = [];
const start = (o: PtyOptions) => {
  const p = new Pty(o);
  live.push(p);
  return p;
};
afterEach(async () => {
  for (const p of live.splice(0)) await p.close();
});

const tidy = (p: Pty) =>
  p.screen
    .viewport()
    .map((r) =>
      r.text.replace(/\d+:\d\d/, "m:ss").replace(/[\u2800-\u28ff]/, "*"),
    )
    .join("\n")
    .trimEnd();

describe.skipIf(!ptyAvailable)("on a real pty", () => {
  for (const answerOsc11 of [true, false])
    it(`an Esc typed 0.05 s after launch is honoured (the terminal ${answerOsc11 ? "answers" : "never answers"} the OSC 11 question)`, async () => {
      const p = start({
        columns: 80,
        rows: 24,
        args: ["login"],
        answerOsc11,
      });
      await new Promise((r) => setTimeout(r, 50));
      p.type("\x1b");
      const t0 = Date.now();
      const code = await Promise.race([
        p.exited,
        new Promise<number>((r) => setTimeout(() => r(-1), 3000)),
      ]);
      await p.settle(100);
      const text = p.screen
        .all()
        .map((r) => r.text)
        .join("\n");
      expect(text, text).toContain("Sign-in cancelled");
      expect(text).not.toContain("Code expired");
      expect(code).toBe(1);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(p.osc11Seen).toBe(true);
    }, 20_000);

  const drags: Array<[string, Array<[number, number]>]> = [
    [
      "80x24 → 60x10 → 80x24",
      [
        [60, 10],
        [80, 24],
      ],
    ],
    [
      "80x24 → 32x10 → 110x30",
      [
        [32, 10],
        [110, 30],
      ],
    ],
  ];
  for (const [name, steps] of drags)
    for (const mode of ["login", "device-limit"])
      it(`${mode} ${name}: the screen a window dragged back to size shows is a fresh launch's`, async () => {
        const args = [mode, "long"];
        const env = { PKEY_THEME: "dark", PTY_EXPIRE_MS: "60000" };
        const ready = mode === "login" ? "Esc cancel" : "Enter";
        const p = start({ columns: 80, rows: 24, args, env });
        expect(await p.waitFor(ready)).toBe(true);
        for (const [c, r] of steps) {
          await p.resize(c, r);
          await p.settle(350);
        }
        const [lc, lr] = steps.at(-1)!;
        const fresh = start({ columns: lc, rows: lr, args, env });
        expect(await fresh.waitFor(ready)).toBe(true);
        await fresh.settle(200);
        expect(tidy(p)).toBe(tidy(fresh));
        expect(p.screen.raw).toContain("\x1b[6n");
        p.type("\x1b");
        fresh.type("\x1b");
        await Promise.all([p.exited, fresh.exited]);
        await p.settle(150);
        await fresh.settle(150);
        expect(tidy(p)).toBe(tidy(fresh));
      }, 40_000);
});

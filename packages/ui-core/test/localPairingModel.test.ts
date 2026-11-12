// @pkey-feature connect.local
//
// LocalPairingModel and PairedDevicesModel (CC-29K): Pair with a Code over a fake driver with an
// injected clock and timer, so no test waits. The rows of ui-matrix.json `local` pin every view.

import { describe, expect, it } from "vitest";

import {
  COOLDOWN_SECONDS,
  LocalPairingModel,
  PairedDevicesModel,
  connectEscape,
  localPairingLayout,
  showSwitchColumn,
  type LocalCodeLike,
  type LocalLinkLike,
  type LocalLinksLike,
  type LocalOfferLike,
  type LocalPairedLike,
} from "../src/index.js";

const BASE = {
  platform: { os: "windows", formFactor: "computer" },
  integrator: { name: "DJDL" },
} as const;

type PairArgs = Parameters<LocalLinksLike["pair"]>[0];
type JoinArgs = Parameters<LocalLinksLike["join"]>[0];

/** A clock the test moves and a timer it fires: nothing here waits for time. */
function clock() {
  let t = 1_000;
  const timers: { fn: () => void; at: number }[] = [];
  return {
    now: () => t,
    timer: (fn: () => void, ms: number) => {
      const entry = { fn, at: t + ms / 1000 };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    advance(s: number) {
      t += s;
      for (const e of [...timers].filter((x) => x.at <= t)) {
        timers.splice(timers.indexOf(e), 1);
        e.fn();
      }
    },
    pending: () => timers.length,
  };
}

const code = (
  c: string,
  reason = "opened",
  expiresAt = 1_300,
): LocalCodeLike => ({
  code: c,
  qr: `PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:${c.replace(" ", "")}`,
  reason,
  expiresAt,
  failures: 0,
});

const err = (code: string, extra: Record<string, string> = {}) =>
  Object.assign(new Error(code), { code, ...extra });

function fake(
  opts: {
    rows?: LocalLinkLike[];
    on?: boolean;
    dials?: (text: string) => number | null;
  } = {},
) {
  const log: string[] = [];
  const seen: { pair: PairArgs | null; join: JoinArgs | null } = {
    pair: null,
    join: null,
  };
  const rows = opts.rows ?? [];
  const next: { join: () => Promise<LocalPairedLike>; pair: () => void } = {
    join: () => new Promise(() => undefined),
    pair: () => undefined,
  };
  const windowHandle = {
    open: true,
    stop: async () => void log.push("stop"),
    renew: async () => {
      log.push("renew");
      return code("4873 0691");
    },
    code: () => null,
  };
  const driver: LocalLinksLike = {
    localPairing: () => opts.on ?? true,
    list: async () => rows,
    rename: async (id, label) => {
      log.push(`rename ${id} ${label}`);
      return true;
    },
    remove: async (id) => {
      log.push(`remove ${id}`);
      return true;
    },
    setReachable: async () => true,
    onChange: () => () => undefined,
    dialsLeft: (t) => (opts.dials ? opts.dials(t) : null),
    pair: async (o) => {
      next.pair();
      seen.pair = o;
      log.push("pair");
      return windowHandle;
    },
    join: (o) => {
      seen.join = o;
      log.push(`join ${o.code}`);
      return next.join();
    },
  };
  return { driver, log, seen, next, windowHandle };
}

const offer = (
  log: string[],
  label: string | null = "Maya's PC",
): LocalOfferLike => ({
  label,
  categories: ["crates"],
  confirm: async () => void log.push("confirm"),
  decline: async () => void log.push("decline"),
});

const make = (f: ReturnType<typeof fake>, c = clock()) => ({
  c,
  m: new LocalPairingModel({
    driver: f.driver,
    categories: ["crates"],
    label: "My PC",
    now: c.now,
    timer: c.timer,
    base: BASE,
  }),
});

/** The joiner with a code typed. */
const joined = async (f: ReturnType<typeof fake>, text: string) => {
  const { m, c } = make(f);
  await m.enter();
  m.setEntry(text);
  return { m, c };
};

/** The shower with its window open and its first code on screen. */
async function opened(f: ReturnType<typeof fake>) {
  const { m } = make(f);
  await m.show();
  f.seen.pair!.onCode(code("4812 3456"));
  return m;
}

describe("LocalPairingModel: show", () => {
  it("opens a window, counts down from expiresAt and ticks each second", async () => {
    const f = fake();
    const { m, c } = make(f);
    await m.start();
    expect(m.snapshot.step).toBe("choose");
    await m.show();
    f.seen.pair!.onCode(code("4812 3456"));
    expect(m.snapshot).toMatchObject({
      step: "show",
      code: "4812 3456",
      secondsLeft: 300,
    });
    c.advance(10);
    expect(m.snapshot.secondsLeft).toBe(290);
    expect(m.view().state).toBe("show");
  });

  it("lights the changed digits and announces the new code after a wrong one", async () => {
    const f = fake();
    const m = await opened(f);
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    expect(m.snapshot.notice).toBe("rotated");
    expect(m.snapshot.changed).toEqual([2, 3, 5, 6, 7, 8]);
    const v = m.view();
    expect(v.copy).toContain("a11y.newCode");
    expect(v.copy).toContain("localPairing.showNew");
  });

  it("says a declined prompt on the changed code, naming the device", async () => {
    const f = fake();
    const m = await opened(f);
    f.seen.pair!.onConfirm(offer(f.log, "LAPTOP-7QH3RX"));
    expect(m.snapshot.step).toBe("confirm");
    await m.notNow();
    expect(f.log).toContain("decline");
    f.seen.pair!.onCode(code("4812 9999", "declined"));
    expect(m.snapshot).toMatchObject({
      step: "show",
      notice: "declined",
      device: "LAPTOP-7QH3RX",
    });
  });

  it("shows the blocked notice at 3 interruptions and the next code clears it", async () => {
    const f = fake();
    const m = await opened(f);
    f.seen.pair!.onInterrupted(2);
    expect(m.snapshot.notice).toBeUndefined();
    f.seen.pair!.onInterrupted(3);
    expect(m.snapshot.notice).toBe("blocked");
    f.seen.pair!.onCode(code("5512 0000"));
    expect(m.snapshot.notice).toBeUndefined();
  });

  it("closes on Too many tries for 30 s, then offers a new code; Time ran out has no wait", async () => {
    const f = fake();
    const { m, c } = make(f);
    await m.show();
    f.seen.pair!.onCode(code("4812 3456"));
    f.seen.pair!.onEnd({ reason: "too-many-tries" });
    expect(m.snapshot).toMatchObject({
      step: "closed",
      closedBy: "too-many-tries",
      cooldownLeft: COOLDOWN_SECONDS,
    });
    expect(m.view().disabled).toEqual(["localPairing.showNewIn"]);
    await m.showNew();
    expect(f.log).not.toContain("renew");
    c.advance(24);
    expect(m.snapshot.cooldownLeft).toBe(6);
    c.advance(6);
    expect(m.snapshot.cooldownLeft).toBe(0);
    expect(m.view().disabled).toBeUndefined();
    expect(m.view().decisions.primary).toBe("localPairing.showNew");
    await m.showNew();
    expect(f.log.filter((l) => l === "pair").length).toBe(2);
  });

  it("a window that ran out waits for nothing", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onEnd({ reason: "expired" });
    expect(m.snapshot).toMatchObject({ step: "closed", closedBy: "expired" });
    expect(m.snapshot.cooldownLeft).toBeUndefined();
    expect(m.view().disabled).toBeUndefined();
  });

  it("warns on the second Too many tries, and after five wrong codes across windows (D4)", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onEnd({ reason: "too-many-tries" });
    expect(m.snapshot.warn).toBeUndefined();
    const g = fake();
    const two = make(g, clock());
    await two.m.show();
    g.seen.pair!.onEnd({ reason: "too-many-tries" });
    two.c.advance(31);
    await two.m.showNew();
    g.seen.pair!.onEnd({ reason: "too-many-tries" });
    expect(two.m.snapshot.warn).toBe(true);
    expect(two.m.view().copy).toContain("localPairing.tooManyAgainTitle");

    const h = fake();
    const w = make(h);
    await w.m.show();
    h.seen.pair!.onCode(code("1100 0000"));
    for (let i = 0; i < 4; i++)
      h.seen.pair!.onCode(code(`11${i}0 0000`, "wrong-code"));
    expect(w.m.snapshot.notice).toBe("rotated");
    h.seen.pair!.onCode(code("1190 0000", "wrong-code"));
    expect(w.m.snapshot.notice).toBe("guessing");
    expect(w.m.snapshot.cooldownLeft).toBeUndefined();
    expect(w.m.view().copy).toContain("localPairing.showNew");
  });

  it("the SDK's cooldown rejection is waited out, not shown as a failure", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onEnd({ reason: "expired" });
    f.driver.pair = async () => {
      throw err("peer-closed", { reason: "cooldown" });
    };
    await m.showNew();
    expect(m.snapshot).toMatchObject({
      step: "closed",
      cooldownLeft: COOLDOWN_SECONDS,
    });
  });

  it("a stored link is the paired screen; Done renames only when the name changed", async () => {
    const rows: LocalLinkLike[] = [
      { id: "L1", label: "Maya's PC", lastSeen: null, reachable: false },
    ];
    const f = fake({ rows });
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onLinked({
      id: "L1",
      label: "Maya's PC",
      categories: ["crates"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(m.snapshot).toMatchObject({
      step: "paired",
      device: "Maya's PC",
      name: "Maya's PC",
    });
    expect(m.snapshot.cantConnect).toBe(true);
    m.setName("Booth");
    await m.done();
    expect(f.log).toContain("rename L1 Booth");
    expect(m.snapshot.left).toBe(true);
  });

  it("Enter a code instead withdraws the code; Cancel returns to the entry", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    await m.toEnter();
    expect(f.log).toContain("stop");
    expect(m.snapshot.step).toBe("enter");
    await m.toShow();
    f.seen.pair!.onCode(code("4812 3456"));
    await m.cancel();
    expect(m.snapshot.step).toBe("choose");
  });

  it("says the gate and the cap before either button", async () => {
    const off = make(fake({ on: false }));
    await off.m.start();
    expect(off.m.snapshot.step).toBe("off");
    const rows = Array.from({ length: 32 }, (_, i) => ({
      id: `L${i}`,
      label: `D${i}`,
      lastSeen: null,
      reachable: true,
    }));
    const full = make(fake({ rows }));
    await full.m.start();
    expect(full.m.snapshot.full).toBe(true);
    expect(full.m.view().disabled).toEqual([
      "localPairing.enter",
      "localPairing.show",
    ]);
    await full.m.show();
    expect(full.m.snapshot.step).toBe("choose");
  });

  it("a gate-clearing end shows Pairing unavailable", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onEnd({ reason: "off" });
    expect(m.snapshot.step).toBe("off");
  });

  it("network blocked offers Open Settings only where the platform can", async () => {
    const f = fake();
    f.driver.pair = async () => {
      throw err("nearby-permission-denied");
    };
    const c = clock();
    const m = new LocalPairingModel({
      driver: f.driver,
      categories: [],
      canOpenSettings: true,
      now: c.now,
      timer: c.timer,
    });
    await m.show();
    expect(m.view().copy).toContain("localPairing.openSettings");
  });
});

describe("LocalPairingModel: the prompt", () => {
  const prompt = async (f: ReturnType<typeof fake>) => {
    const m = await opened(f);
    f.seen.pair!.onConfirm(offer(f.log, "LAPTOP-7QH3RX"));
    expect(m.snapshot.step).toBe("confirm");
    return m;
  };

  it("a changed code ends the prompt: the next device reaches confirm, never 'one at a time'", async () => {
    for (const reason of ["timeout", "declined", "closed"]) {
      const f = fake();
      const m = await prompt(f);
      f.seen.pair!.onCode(code("4812 7777", reason));
      expect(m.snapshot.step, reason).toBe("show");
      const second = offer(f.log, "Studio PC");
      f.seen.pair!.onConfirm(second);
      expect(m.snapshot, reason).toMatchObject({
        step: "confirm",
        device: "Studio PC",
      });
      expect(f.log, reason).not.toContain("decline");
      await m.confirm();
      expect(f.log, reason).toContain("confirm");
    }
  });

  it("a wrong code while the prompt is up also frees it", async () => {
    const f = fake();
    const m = await prompt(f);
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    f.seen.pair!.onConfirm(offer(f.log, "Studio PC"));
    expect(m.snapshot.step).toBe("confirm");
  });

  it("a second device at the prompt is declined while the first is up", async () => {
    const f = fake();
    await prompt(f);
    f.seen.pair!.onConfirm(offer(f.log, "Other"));
    expect(f.log).toContain("decline");
  });

  it("Pair answers at once: busy until the window answers, and a repeat press confirms once", async () => {
    const f = fake();
    const m = await opened(f);
    let calls = 0;
    let release!: () => void;
    const slow = offer(f.log, "LAPTOP-7QH3RX");
    slow.confirm = () => {
      calls++;
      return new Promise<void>((r) => (release = r));
    };
    f.seen.pair!.onConfirm(slow);
    const one = m.confirm();
    expect(m.snapshot.busy).toBe("pair");
    const v = m.view();
    expect(v.disabled).toEqual(["common.notNow", "localPairing.pair"]);
    expect(v.copy).toContain("a11y.busy");
    await m.confirm();
    await m.notNow();
    expect(calls).toBe(1);
    expect(f.log).not.toContain("decline");
    release();
    await one;
    f.seen.pair!.onLinked({ id: "L1", label: "LAPTOP-7QH3RX", categories: [] });
    expect(m.snapshot.step).toBe("paired");
    expect(m.snapshot.busy).toBeUndefined();
  });

  it("a confirm that fails clears the busy state so Pair can be pressed again", async () => {
    const f = fake();
    const m = await opened(f);
    const o = offer(f.log, "LAPTOP-7QH3RX");
    o.confirm = async () => {
      throw err("peer-closed");
    };
    f.seen.pair!.onConfirm(o);
    await m.confirm();
    expect(m.snapshot).toMatchObject({ step: "confirm" });
    expect(m.snapshot.busy).toBeUndefined();
  });

  it("Not now is busy the same way, until the changed code arrives", async () => {
    const f = fake();
    const m = await prompt(f);
    const pending = m.notNow();
    expect(m.snapshot.busy).toBe("not-now");
    await pending;
    expect(m.view().disabled).toEqual(["common.notNow", "localPairing.pair"]);
    f.seen.pair!.onCode(code("4812 9999", "declined"));
    expect(m.snapshot).toMatchObject({ step: "show", notice: "declined" });
    expect(m.snapshot.busy).toBeUndefined();
  });

  it("the waiting screen names what each shares", async () => {
    const f = fake();
    const { m } = await joined(f, "48123456");
    void m.pair();
    f.seen.join!.onConfirm(offer(f.log, "Studio PC"));
    expect(m.snapshot).toMatchObject({ step: "waiting" });
    const v = m.view();
    expect(v.copy).toContain("linkPairing.shares");
    expect(v.copy).not.toContain("localPairing.waitingDevice");
  });
});

describe("LocalPairingModel: the code and the QR are two views of one window", () => {
  it("switches to the QR view and back without renewing or rotating", async () => {
    const f = fake();
    const m = await opened(f);
    const before = m.snapshot;
    const open = f.log.filter((l) => l === "pair").length;
    m.showQr();
    expect(m.view().state).toBe("show-qr");
    expect(m.view().copy).not.toContain("a11y.linkCode");
    expect(m.snapshot).toMatchObject({
      code: before.code,
      qr: before.qr,
      rotation: before.rotation,
      secondsLeft: before.secondsLeft,
      switches: 1,
    });
    m.showCode();
    expect(m.view().state).toBe("show");
    expect(m.view().copy).toContain("a11y.linkCode");
    expect(m.view().copy).not.toContain("a11y.qrPairing");
    expect(m.snapshot.switches).toBe(2);
    expect(f.log).not.toContain("renew");
    expect(f.log.filter((l) => l === "pair")).toHaveLength(open);
  });

  it("a switch outside the show step does nothing", async () => {
    const f = fake();
    const { m } = make(f);
    await m.start();
    m.showQr();
    expect(m.snapshot).toMatchObject({ step: "choose", switches: 0 });
  });

  it("keeps the view the person is on through a new code, and starts a new window on the code", async () => {
    const f = fake();
    const m = await opened(f);
    m.showQr();
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    expect(m.snapshot).toMatchObject({ view: "qr", code: "4873 0691" });
    expect(m.view().state).toBe("show-qr");
    expect(m.snapshot.rotation).toBe(2);
    f.seen.pair!.onEnd({ reason: "expired" });
    await m.showNew();
    f.seen.pair!.onCode(code("1111 2222"));
    expect(m.snapshot.view).toBeUndefined();
    expect(m.view().state).toBe("show");
  });
});

describe("LocalPairingModel: slow starts", () => {
  it("Show a code goes to the opening tile at once, and a late window is withdrawn by Cancel", async () => {
    const f = fake();
    let open!: () => void;
    f.driver.pair = (o) => {
      f.seen.pair = o;
      return new Promise((r) => {
        open = () => r(f.windowHandle);
      });
    };
    const { m } = make(f);
    const pending = m.show();
    expect(m.snapshot.step).toBe("opening");
    expect(m.view().state).toBe("opening");
    expect(m.view().copy).toContain("a11y.busy");
    expect(m.view().copy).not.toContain("a11y.linkCode");
    await new Promise((r) => setTimeout(r, 0)); // the driver is now asked
    await m.cancel();
    expect(m.snapshot.step).toBe("choose");
    open();
    await pending;
    expect(f.log).toContain("stop");
    expect(m.snapshot.step).toBe("choose");
  });

  it("Cancel before the driver is asked opens nothing", async () => {
    const f = fake();
    const { m } = make(f);
    const pending = m.show();
    await m.cancel();
    await pending;
    expect(f.log).not.toContain("pair");
    expect(m.snapshot.step).toBe("choose");
  });

  it("Show a new code is busy while the renewal is answered, and a second press does nothing", async () => {
    const f = fake();
    const m = await opened(f);
    f.seen.pair!.onCode(code("4873 0691", "wrong-code"));
    let renewals = 0;
    let release!: () => void;
    f.windowHandle.renew = () => {
      renewals++;
      return new Promise((r) => (release = () => r(code("4900 1122"))));
    };
    const first = m.showNew();
    expect(m.snapshot.busy).toBe("new-code");
    expect(m.view().disabled).toEqual(["localPairing.showNew"]);
    await m.showNew();
    expect(renewals).toBe(1);
    release();
    await first;
    expect(m.snapshot).toMatchObject({ step: "show", code: "4900 1122" });
    expect(m.snapshot.busy).toBeUndefined();
  });
});

describe("LocalPairingModel: the network answer", () => {
  it("Try again from the shower reopens the window; from the field it returns to the code typed", async () => {
    const f = fake();
    let blocked = true;
    const open = f.driver.pair;
    f.driver.pair = async (o) => {
      if (blocked) throw err("nearby-permission-denied");
      return open(o);
    };
    const { m } = make(f);
    await m.show();
    expect(m.view().state).toBe("network-blocked");
    expect(m.view().copy).toContain("common.tryAgain");
    expect(m.view().decisions.primary).toBe("common.tryAgain");
    blocked = false;
    await m.retry();
    expect(m.snapshot.step).toBe("opening");

    const g = fake();
    const { m: j } = await joined(g, "48123456");
    g.next.join = async () => {
      throw err("nearby-permission-denied");
    };
    await j.pair();
    expect(j.snapshot.step).toBe("network-blocked");
    await j.retry();
    expect(j.snapshot).toMatchObject({ step: "enter", entry: "4812 3456" });
  });
});

describe("LocalPairingModel: the paired screen", () => {
  it("a name the store refuses keeps the screen and says so; editing clears it", async () => {
    const f = fake();
    const { m } = make(f);
    await m.show();
    f.seen.pair!.onLinked({ id: "L1", label: "Maya's PC", categories: [] });
    f.driver.rename = async () => {
      throw err("store");
    };
    m.setName("Booth");
    await m.done();
    expect(m.snapshot).toMatchObject({ step: "paired", nameError: "failed" });
    expect(m.snapshot.left).toBe(false);
    expect(m.view().copy).toContain("devices.renameFailed");
    m.setName("Booth 2");
    expect(m.snapshot.nameError).toBeUndefined();
  });
});

describe("LocalPairingModel: enter", () => {
  it("groups what is typed and drops spaces, hyphens and the 9th digit", async () => {
    const { m } = await joined(fake(), "4812-3456 9");
    expect(m.snapshot.entry).toBe("4812 3456");
    expect(m.snapshot.pairDisabled).toBe(false);
  });

  it("Pair is unavailable under 8 digits and a press answers 'A code is 8 digits' without sending", async () => {
    const f = fake();
    const { m } = await joined(f, "4812");
    expect(m.snapshot.pairDisabled).toBe(true);
    await m.pair();
    expect(m.snapshot.error).toBe("not-a-code");
    expect(f.seen.join).toBeNull();
    m.setEntry("48123");
    expect(m.snapshot.error).toBeUndefined();
  });

  it("after a wrong code keeps 48, clears the rest and holds Pair until the code differs", async () => {
    const f = fake({ dials: () => 1 });
    const { m } = await joined(f, "48123456");
    f.next.join = async () => {
      throw err("pairing-code-failed", { reason: "wrong" });
    };
    await m.pair();
    expect(m.snapshot).toMatchObject({
      step: "enter",
      entry: "48",
      error: "wrong",
      triesLeft: 1,
    });
    expect(m.view().copy).toContain("localPairing.triesLeft");
    m.setEntry("48123456");
    expect(m.snapshot.pairDisabled).toBe(true);
    await m.pair();
    expect(m.snapshot.error).toBe("wrong");
    expect(f.log.filter((l) => l.startsWith("join")).length).toBe(1);
    m.setEntry("48123457");
    expect(m.snapshot.pairDisabled).toBe(false);
    expect(m.snapshot.error).toBeUndefined();
  });

  it("another app's QR reads as a wrong code", async () => {
    const f = fake();
    const { m } = await joined(f, "48123456");
    f.next.join = async () => {
      throw err("pairing-code-failed", { reason: "other-app" });
    };
    await m.pair();
    expect(m.snapshot.error).toBe("wrong");
  });

  it("after a spent prefix the field is empty and editable; a spent prefix answers under the field", async () => {
    let spent = false;
    const f = fake({
      dials: (t) =>
        t.length >= 2 ? (spent && t.startsWith("48") ? 0 : 2) : null,
    });
    const { m } = await joined(f, "48123456");
    f.next.join = async () => {
      spent = true;
      throw err("pairing-code-failed", { reason: "spent" });
    };
    await m.pair();
    expect(m.snapshot).toMatchObject({
      step: "enter",
      entry: "",
      error: "too-many",
    });
    expect(m.view().copy).toContain("localPairing.cooldownTitle");
    m.setEntry("4873");
    expect(m.snapshot.error).toBeUndefined();
    expect(m.snapshot.triesLeft).toBe(0);
    expect(m.view().copy).toContain("localPairing.spentCode");
    expect(m.snapshot.pairDisabled).toBe(true);
    m.setEntry("5512");
    expect(m.snapshot.triesLeft).toBe(2);
  });

  it("nothing found says so and keeps the code; Pair tries again", async () => {
    const f = fake();
    const { m } = await joined(f, "48123456");
    f.next.join = async () => {
      throw err("pairing-not-found");
    };
    await m.pair();
    expect(m.snapshot).toMatchObject({
      error: "not-found",
      entry: "4812 3456",
      pairDisabled: false,
    });
  });

  it("Pair is the yes: the prompt is confirmed at once, then waits; the link is paired", async () => {
    const f = fake({
      rows: [{ id: "L1", label: "Studio PC", lastSeen: null, reachable: true }],
    });
    const { m } = await joined(f, "48123456");
    let done!: (l: LocalPairedLike) => void;
    f.next.join = () => new Promise((r) => (done = r));
    const pending = m.pair();
    expect(m.snapshot.step).toBe("joining");
    expect(m.view().disabled).toEqual(["localPairing.pair"]);
    f.seen.join!.onConfirm(offer(f.log, "Studio PC"));
    expect(m.snapshot).toMatchObject({ step: "waiting", device: "Studio PC" });
    expect(f.log).toContain("confirm");
    done({ id: "L1", label: "Studio PC", categories: [] });
    await pending;
    expect(m.snapshot).toMatchObject({ step: "paired", id: "L1" });
  });

  it("Cancel while pairing aborts the join and returns to the field with the code kept", async () => {
    const f = fake();
    const { m } = await joined(f, "48123456");
    void m.pair();
    f.seen.join!.onConfirm(offer(f.log));
    await m.cancel();
    expect(f.seen.join!.signal.aborted).toBe(true);
    expect(f.log).toContain("decline");
    expect(m.snapshot).toMatchObject({ step: "enter", entry: "4812 3456" });
  });

  it("maps the ends: declined, timeout, closed, full, cancelled, off", async () => {
    for (const [e, want] of [
      [
        err("peer-closed", { reason: "declined" }),
        { step: "failed", reason: "declined" },
      ],
      [
        err("peer-closed", { reason: "timeout" }),
        { step: "failed", reason: "timeout" },
      ],
      [
        err("peer-closed", { reason: "closed" }),
        { step: "failed", reason: "closed" },
      ],
      [
        err("local-links-full", { cap: "stored" }),
        { step: "failed", reason: "full" },
      ],
      [err("peer-closed", { reason: "cancelled" }), { step: "enter" }],
      [err("local-pairing-off"), { step: "off" }],
    ] as const) {
      const f = fake();
      const { m } = await joined(f, "48123456");
      f.next.join = async () => {
        throw e;
      };
      await m.pair();
      expect(m.snapshot, String(e)).toMatchObject(want);
    }
  });

  it("Escape answers Not now, Cancel, Back, Close or Done by state", async () => {
    const f = fake();
    const { m } = await joined(f, "");
    expect(connectEscape(m.view())).toBe("common.back");
  });
});

describe("PairedDevicesModel", () => {
  const row = (
    id: string,
    over: Partial<LocalLinkLike> = {},
  ): LocalLinkLike => ({
    id,
    label: `Device ${id}`,
    lastSeen: 100,
    reachable: true,
    ...over,
  });
  /** A list model over `rows`, read once. */
  const listed = async (...rows: LocalLinkLike[]) => {
    const f = fake({ rows });
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    return { f, m };
  };

  it("re-reads on change and shows the switch column only for more than 8 or one off", async () => {
    let rows = [row("a"), row("b")];
    let fire: () => void = () => undefined;
    const f = fake();
    f.driver.list = async () => rows;
    f.driver.onChange = (fn) => {
      fire = fn;
      return () => undefined;
    };
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    expect(showSwitchColumn(m.snapshot.devices!)).toBe(false);
    expect(m.view().copy).not.toContain("pairedDevices.canConnect");
    rows = [row("a"), row("b", { reachable: false })];
    fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.view().copy).toContain("pairedDevices.canConnect");
    expect(
      showSwitchColumn(Array.from({ length: 9 }, () => ({ reachable: true }))),
    ).toBe(true);
  });

  it("renames in the row, refusing a long or an empty name and keeping the text", async () => {
    const { f, m } = await listed(row("a"), row("b"));
    m.startRename("a");
    expect(m.snapshot.draft).toBe("Device a");
    m.setDraft("x".repeat(65));
    await m.saveRename();
    expect(m.snapshot).toMatchObject({ step: "renaming", renameError: "long" });
    expect(m.view().copy).toContain("pairedDevices.renameLong");
    m.setDraft("   ");
    await m.saveRename();
    expect(m.snapshot.renameError).toBe("empty");
    m.setDraft("Riverside");
    await m.saveRename();
    expect(f.log).toContain("rename a Riverside");
    expect(m.snapshot.step).toBe("list");
  });

  it("forgets in the row and moves focus to the next row, or the title when none is left", async () => {
    let rows = [row("a"), row("b")];
    const f = fake();
    f.driver.list = async () => rows;
    f.driver.remove = async (id) => {
      rows = rows.filter((r) => r.id !== id);
      return true;
    };
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    m.askForget("a");
    expect(m.view().state).toBe("forgetting");
    await m.confirmForget();
    expect(m.snapshot.focus).toEqual({ kind: "row", id: "b" });
    m.askForget("b");
    await m.confirmForget();
    expect(m.snapshot.focus).toEqual({ kind: "title" });
    expect(m.view().state).toBe("empty");
  });

  it("says nothing about what is paired until the first read answers", async () => {
    const f = fake({ rows: [row("a")] });
    let answer!: (r: LocalLinkLike[]) => void;
    f.driver.list = () => new Promise((r) => (answer = r));
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    const started = m.start();
    expect(m.snapshot.loaded).toBe(false);
    expect(m.view().state).toBe("loading");
    expect(m.view().copy).not.toContain("pairedDevices.empty");
    answer([row("a")]);
    await started;
    expect(m.view().state).toBe("list");
    // The same for an empty answer: only now is "none yet" true.
    const e = new PairedDevicesModel({ driver: fake().driver, base: BASE });
    expect(e.view().state).toBe("loading");
    await e.start();
    expect(e.view().state).toBe("empty");
  });

  it("Try again from a failed read shows the loading state, then the list", async () => {
    const f = fake();
    let fail = true;
    let answer!: (r: LocalLinkLike[]) => void;
    f.driver.list = () =>
      fail
        ? Promise.reject(new Error("strict"))
        : new Promise((r) => (answer = r));
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    expect(m.view().state).toBe("load-failed");
    fail = false;
    const again = m.refresh();
    expect(m.view().state).toBe("loading");
    answer([row("a")]);
    await again;
    expect(m.view().state).toBe("list");
  });

  it("a rename the store refuses keeps the text and says it failed, not 'Enter a name'", async () => {
    const f = fake({ rows: [row("a")] });
    f.driver.rename = async () => {
      throw err("store");
    };
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    m.startRename("a");
    m.setDraft("Riverside");
    await m.saveRename();
    expect(m.snapshot).toMatchObject({
      step: "renaming",
      renameError: "failed",
      draft: "Riverside",
    });
    expect(m.view().copy).toContain("devices.renameFailed");
    expect(m.view().copy).not.toContain("pairedDevices.renameEmpty");
    f.driver.rename = async () => {
      throw Object.assign(new Error("bad"), { reason: "bad_input" });
    };
    await m.saveRename();
    expect(m.snapshot.renameError).toBe("empty");
  });

  it("a forget the store refuses keeps the question open and says so", async () => {
    const f = fake({ rows: [row("a"), row("b")] });
    f.driver.remove = async () => {
      throw err("store");
    };
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    m.askForget("a");
    await m.confirmForget();
    expect(m.snapshot).toMatchObject({
      step: "forgetting",
      target: "a",
      forgetError: true,
    });
    expect(m.view().copy).toContain("pairedDevices.forgetFailed");
    m.cancelEdit();
    expect(m.snapshot.forgetError).toBeUndefined();
  });

  it("Cancel and a saved rename return focus to the row's menu button; Forget moves on", async () => {
    const { f, m } = await listed(row("a"), row("b"));
    m.startRename("a");
    m.cancelEdit();
    expect(m.snapshot.focus).toEqual({ kind: "row", id: "a" });
    m.startRename("a");
    expect(m.snapshot.focus).toBeNull();
    m.setDraft("Booth");
    await m.saveRename();
    expect(m.snapshot.focus).toEqual({ kind: "row", id: "a" });
    m.askForget("b");
    m.cancelEdit();
    expect(m.snapshot.focus).toEqual({ kind: "row", id: "b" });
  });

  it("an answer the host gave about a device shows with the list, and Try again names the device", async () => {
    const { f, m } = await listed(row("a"));
    m.hostNotice = { device: "Device a", kind: "busy", id: "a" };
    expect(m.input().pairedDevices?.notice).toEqual({
      device: "Device a",
      kind: "busy",
      id: "a",
    });
    expect(m.view().copy).toContain("pairedDevices.busyTitle");
    m.hostNotice = undefined;
    m.base = {
      ...BASE,
      pairedDevices: {
        step: "list",
        notice: { device: "Device a", kind: "not-found" },
      },
    };
    expect(m.view().copy).toContain("pairedDevices.notFoundTitle");
    m.report("a", "busy");
    expect(m.snapshot.notice).toMatchObject({ kind: "busy", id: "a" });
  });

  it("an unreadable record is load-failed with Try again; the gate off keeps only Rename and Forget", async () => {
    const f = fake({ rows: [row("a")] });
    f.driver.list = async () => {
      throw new Error("strict");
    };
    const m = new PairedDevicesModel({ driver: f.driver, base: BASE });
    await m.start();
    expect(m.view().state).toBe("load-failed");
    const off = fake({ rows: [row("a")], on: false });
    const o = new PairedDevicesModel({ driver: off.driver, base: BASE });
    await o.start();
    expect(o.view().state).toBe("off");
    expect(o.snapshot.entryVisible).toBe(true);
    expect(o.view().copy).not.toContain("pairedDevices.canConnect");
  });
});

describe("localPairingLayout", () => {
  it("is one centred column at every size, the QR never beside the code", () => {
    for (const w of [
      { width: 1280, height: 800 },
      { width: 600, height: 700 },
      { width: 1100, height: 800, textScale: 2 },
      { width: 900, height: 300, tv: true },
    ])
      expect(localPairingLayout(w).panes).toBe(1);
  });

  it("a window under 480 tall drops the logo and scrolls, the notice before the QR", () => {
    for (const width of [390, 720])
      expect(localPairingLayout({ width, height: 420 })).toEqual({
        panes: 1,
        logo: false,
        scrolls: true,
        noticeBeforeQr: true,
      });
    expect(localPairingLayout({ width: 390, height: 844 })).toEqual({
      panes: 1,
      logo: true,
      scrolls: false,
      noticeBeforeQr: false,
    });
  });
});

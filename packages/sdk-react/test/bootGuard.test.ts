// @pkey-feature update.bootguard
// The app boot guard (SDK parity pass §3.15, SP-15): slots in browser storage, the count, the
// rollback and the confirmation, over client-core's `bootGuardAction`. The proof is
// conformance/corpus/v2/stage-matrix.json's `guardCases` and `confirmCases`, replayed here
// against PERSISTED slots (a fresh `BootGuard` per launch over the same storage, as a reload is),
// and the same guard driven through `boot()` and through the desktop bridge.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_OK_SECONDS,
  MAX_FAILED_BOOTS,
  bootConfirmation,
  type BootOutcome,
} from "@polaris-key/client-core";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import {
  BootGuard,
  bootGuardStorageKey,
  browserBootSlotStore,
  type BootSlots,
} from "../src/core/bootGuard.js";
import { runBoot, type BootDriver } from "../src/core/boot.js";
import { UpdateEvent } from "../src/constants.generated.js";
import type { UpdateEventInput } from "../src/core/updateEvents.js";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { localAdapter } from "../src/local/localAdapter.js";
import type { SwContainer } from "../src/browser/serviceWorkerUpdate.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  services,
} from "./fixtures.js";

interface GuardCase {
  name: string;
  input: { staged: boolean; failedBoots: number };
  expect: { action: "none" | "apply-staged" | "roll-back" };
}
interface ConfirmCase {
  outcome: BootOutcome;
  expect: "now" | "after-ok-seconds" | "never";
}

const here = dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "stage-matrix.json",
    ),
    "utf8",
  ),
) as {
  maxFailedBoots: number;
  bootOkSeconds: number;
  guardCases: GuardCase[];
  confirmCases: ConfirmCase[];
};

/** Browser storage the tests can inspect and reload from. */
function storage() {
  const mem = new Map<string, string>();
  return {
    mem,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
}
const KEY = bootGuardStorageKey("acme");
const slotsIn = (s: ReturnType<typeof storage>): BootSlots =>
  JSON.parse(s.mem.get(KEY) ?? "null") as BootSlots;

interface Recorded {
  event: UpdateEvent;
  input: UpdateEventInput;
}

/** One launch of `version`: a fresh guard over the same storage. */
function launch(
  s: ReturnType<typeof storage>,
  version: string,
  o: {
    staged?: boolean;
    rollback?: (previous: string) => Promise<boolean>;
    flush?: () => Promise<unknown>;
  } = {},
) {
  const events: Recorded[] = [];
  const guard = new BootGuard({
    version,
    store: browserBootSlotStore("acme", s),
    record: async (event, input) => void events.push({ event, input }),
    staged: () => o.staged === true,
    ...(o.rollback ? { rollback: o.rollback } : {}),
    ...(o.flush ? { flush: o.flush } : {}),
  });
  return { guard, events };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stage-matrix.json: the corpus constants", () => {
  it("the guard's constants are the corpus's", () => {
    expect(MAX_FAILED_BOOTS).toBe(MATRIX.maxFailedBoots);
    expect(BOOT_OK_SECONDS).toBe(MATRIX.bootOkSeconds);
    expect(MATRIX.guardCases.length).toBeGreaterThanOrEqual(7);
  });
});

describe("stage-matrix.json guardCases, replayed against persisted slots", () => {
  for (const c of MATRIX.guardCases) {
    it(c.name, async () => {
      const s = storage();
      // The slots a previous run left: 1.1.0 was installed over 1.0.0 and has failed
      // `failedBoots` unconfirmed launches. `markBootAttempt` for the same version must read
      // them back, decide, and count this launch.
      s.mem.set(
        KEY,
        JSON.stringify({
          current: "1.1.0",
          previous: "1.0.0",
          failedBoots: c.input.failedBoots,
          confirmed: false,
          skipVersion: null,
        } satisfies BootSlots),
      );
      const rollback = vi.fn(async () => true);
      const { guard, events } = launch(s, "1.1.0", {
        staged: c.input.staged,
        rollback,
      });
      const a = await guard.markBootAttempt();
      expect(a.action).toBe(c.expect.action);
      if (c.expect.action === "roll-back") {
        // The previous build is re-installed once, the failure is journaled, the failed
        // version is never re-offered and the count starts over.
        expect(rollback).toHaveBeenCalledExactlyOnceWith("1.0.0");
        expect(a.result).toBe("rolled-back");
        expect(a.failedBoots).toBe(c.input.failedBoots);
        expect(events.map((e) => e.event)).toEqual([
          UpdateEvent.updateReverted,
          UpdateEvent.bootRolledBack,
        ]);
        expect(slotsIn(s)).toMatchObject({
          current: "1.1.0",
          previous: "1.0.0",
          failedBoots: 1,
          skipVersion: "1.1.0",
        });
      } else {
        expect(rollback).not.toHaveBeenCalled();
        expect(a.result).toBe("ok");
        expect(a.failedBoots).toBe(c.input.failedBoots + 1);
        expect(events).toEqual([]);
        expect(slotsIn(s)).toMatchObject({
          failedBoots: c.input.failedBoots + 1,
          skipVersion: null,
        });
      }
    });
  }
});

describe("the guard across launches (persisted slots, rollback, confirmation)", () => {
  it("an update that never confirms rolls back on the launch after MAX_FAILED_BOOTS", async () => {
    const s = storage();
    // 1.0.0 is the first launch ever, and confirms.
    expect((await launch(s, "1.0.0").guard.markBootAttempt()).result).toBe(
      "ok",
    );
    await launch(s, "1.0.0").guard.confirmBoot();
    // 1.1.0 lands: the slots move, and each unconfirmed launch is counted.
    const rollback = vi.fn(async () => true);
    const first = launch(s, "1.1.0", { rollback });
    expect(await first.guard.markBootAttempt()).toMatchObject({
      result: "applied",
      action: "none",
      failedBoots: 1,
      previous: "1.0.0",
    });
    expect(
      (await launch(s, "1.1.0", { rollback }).guard.markBootAttempt())
        .failedBoots,
    ).toBe(2);
    expect(rollback).not.toHaveBeenCalled();
    const third = launch(s, "1.1.0", { rollback });
    expect(await third.guard.markBootAttempt()).toMatchObject({
      result: "rolled-back",
      action: "roll-back",
      failedBoots: MAX_FAILED_BOOTS,
      previous: "1.0.0",
    });
    expect(rollback).toHaveBeenCalledExactlyOnceWith("1.0.0");
    expect(third.guard.skipVersion()).toBe("1.1.0");
    expect(third.events.map((e) => e.event)).toEqual([
      UpdateEvent.updateReverted,
      UpdateEvent.bootRolledBack,
    ]);
    expect(third.events[0]!.input).toMatchObject({
      release: "1.1.0",
      fromRelease: "1.0.0",
    });
  });

  it("a confirmed launch resets the count and reports update_confirmed once", async () => {
    const s = storage();
    await launch(s, "1.0.0").guard.markBootAttempt();
    await launch(s, "1.0.0").guard.confirmBoot();
    const { guard, events } = launch(s, "1.1.0");
    await guard.markBootAttempt();
    await guard.confirmBoot();
    await guard.confirmBoot();
    expect(events).toEqual([
      {
        event: UpdateEvent.updateConfirmed,
        input: { release: "1.1.0", fromRelease: "1.0.0" },
      },
    ]);
    expect(slotsIn(s)).toMatchObject({ failedBoots: 0, confirmed: true });
  });

  it("sends the journal once the confirmation is saved, and only for a confirmation that recorded an event", async () => {
    const s = storage();
    const log: string[] = [];
    const flush = async (): Promise<void> => {
      // What the guard has saved by the time the page could be lost.
      const slots = slotsIn(s);
      log.push(`failedBoots=${slots.failedBoots} confirmed=${slots.confirmed}`);
    };
    // The first launch ever has no previous version: nothing is recorded, so nothing is sent.
    const first = launch(s, "1.0.0", { flush });
    await first.guard.markBootAttempt();
    await first.guard.confirmBoot();
    expect(log).toEqual([]);
    // An update's first confirmation records update_confirmed: saved first, then sent.
    const update = launch(s, "1.1.0", { flush });
    await update.guard.markBootAttempt();
    expect(log).toEqual([]);
    await update.guard.confirmBoot();
    expect(log).toEqual(["failedBoots=0 confirmed=true"]);
    // Idempotent: nothing recorded, nothing sent.
    await update.guard.confirmBoot();
    expect(log).toHaveLength(1);
  });

  it("sends the journal once a rollback is saved, with its events already recorded, even when nothing could be rolled back", async () => {
    for (const rollback of [async () => true, undefined]) {
      const s = storage();
      s.mem.set(
        KEY,
        JSON.stringify({
          current: "1.1.0",
          previous: "1.0.0",
          failedBoots: MAX_FAILED_BOOTS,
          confirmed: false,
          skipVersion: null,
        } satisfies BootSlots),
      );
      const log: string[] = [];
      let recorded: Recorded[] = [];
      const l = launch(s, "1.1.0", {
        ...(rollback ? { rollback } : {}),
        flush: async () =>
          void log.push(
            `${recorded.length} events, skip=${slotsIn(s).skipVersion}`,
          ),
      });
      recorded = l.events;
      await l.guard.markBootAttempt();
      expect(log).toEqual([`${rollback ? 2 : 1} events, skip=1.1.0`]);
    }
  });

  it("a journal that cannot be sent never fails a launch or a confirmation", async () => {
    const s = storage();
    await launch(s, "1.0.0").guard.markBootAttempt();
    await launch(s, "1.0.0").guard.confirmBoot();
    const flush = vi.fn(async () => {
      throw new Error("offline");
    });
    const l = launch(s, "1.1.0", { flush });
    expect((await l.guard.markBootAttempt()).result).toBe("applied");
    await expect(l.guard.confirmBoot()).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(slotsIn(s)).toMatchObject({ confirmed: true });
  });

  it("a version that was confirmed once is never rolled back for later crashes", async () => {
    const s = storage();
    await launch(s, "1.0.0").guard.markBootAttempt();
    await launch(s, "1.0.0").guard.confirmBoot();
    const rollback = vi.fn(async () => true);
    for (let i = 0; i < MAX_FAILED_BOOTS + 3; i++) {
      const a = await launch(s, "1.0.0", { rollback }).guard.markBootAttempt();
      expect(a.result).toBe("ok");
      expect(a.action).toBe("none");
    }
    expect(rollback).not.toHaveBeenCalled();
  });

  it("without a rollback, or with one that fails, the rollback is reported, not faked", async () => {
    const none = storage();
    await launch(none, "1.0.0").guard.markBootAttempt();
    await launch(none, "1.0.0").guard.confirmBoot();
    await launch(none, "1.1.0").guard.markBootAttempt();
    await launch(none, "1.1.0").guard.markBootAttempt();
    const a = launch(none, "1.1.0");
    expect(await a.guard.markBootAttempt()).toMatchObject({
      result: "rolled-back",
      reason: "no-previous",
    });
    expect(a.events).toEqual([
      {
        event: UpdateEvent.bootRolledBack,
        input: { release: "1.1.0", fromRelease: "1.0.0", code: "no-previous" },
      },
    ]);
    expect(a.guard.skipVersion()).toBe("1.1.0");

    const bad = storage();
    await launch(bad, "1.0.0").guard.markBootAttempt();
    await launch(bad, "1.0.0").guard.confirmBoot();
    await launch(bad, "1.1.0").guard.markBootAttempt();
    await launch(bad, "1.1.0").guard.markBootAttempt();
    const failing = async (): Promise<boolean> => {
      throw new Error("offline");
    };
    const b = launch(bad, "1.1.0", { rollback: failing });
    expect(await b.guard.markBootAttempt()).toMatchObject({
      result: "rolled-back",
      reason: "rollback-failed",
    });
    expect(b.events[0]!.input.code).toBe("rollback-failed");
  });

  it("a first launch ever has no previous version; the skipped version clears when it is installed again", async () => {
    const s = storage();
    expect(await launch(s, "1.0.0").guard.markBootAttempt()).toMatchObject({
      result: "ok",
      previous: null,
    });
    s.mem.set(
      KEY,
      JSON.stringify({
        current: "1.0.0",
        previous: null,
        failedBoots: 0,
        confirmed: true,
        skipVersion: "1.2.0",
      } satisfies BootSlots),
    );
    await launch(s, "1.2.0").guard.markBootAttempt();
    expect(slotsIn(s).skipVersion).toBeNull();
  });

  it("a staged update (a waiting service worker) is reported as apply-staged and counts the launch", async () => {
    const s = storage();
    const { guard } = launch(s, "1.0.0", { staged: true });
    expect(await guard.markBootAttempt()).toMatchObject({
      action: "apply-staged",
      result: "ok",
      failedBoots: 1,
    });
  });

  it("corrupt or foreign storage reads as no slots, and an unusable store falls back to memory", async () => {
    const s = storage();
    s.mem.set(KEY, "{not json");
    expect((await launch(s, "1.0.0").guard.markBootAttempt()).failedBoots).toBe(
      1,
    );
    s.mem.set(
      KEY,
      JSON.stringify({ current: 7, failedBoots: -2, previous: [] }),
    );
    expect(
      new BootGuard({
        version: "1.0.0",
        store: browserBootSlotStore("acme", s),
      }).slots(),
    ).toEqual({
      current: null,
      previous: null,
      failedBoots: 0,
      confirmed: false,
      skipVersion: null,
    });
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    const store = browserBootSlotStore("acme", throwing);
    const g = new BootGuard({ version: "1.0.0", store });
    expect((await g.markBootAttempt()).failedBoots).toBe(1);
    expect((await g.markBootAttempt()).failedBoots).toBe(2);
    expect(store.persistent()).toBe(false);
    expect(browserBootSlotStore("acme", null).persistent()).toBe(false);
  });

  it("a journal that throws never fails a launch", async () => {
    const s = storage();
    const g = new BootGuard({
      version: "1.0.0",
      store: browserBootSlotStore("acme", s),
      record: async () => {
        throw new Error("cookie page");
      },
    });
    expect((await g.markBootAttempt()).result).toBe("ok");
    await expect(g.confirmBoot()).resolves.toBeUndefined();
  });
});

describe("stage-matrix.json confirmCases through runBoot", () => {
  /** A driver that ends the boot in `outcome`, with a spy for `confirm`. */
  function driverFor(outcome: BootOutcome): {
    driver: BootDriver;
    confirm: ReturnType<typeof vi.fn>;
    opts: { allowOffline?: boolean };
  } | null {
    const confirm = vi.fn(async () => undefined);
    const base = {
      discover: async () => undefined,
      hasToken: () => true,
      registrationPolicy: () => null,
      licenseEnabled: () => true,
      confirm,
    };
    let status: LicenseStatus = "ok";
    let sync: "ok" | "offline" | "error" = "ok";
    let allowOffline = true;
    switch (outcome) {
      case "ready":
        break;
      case "waiting":
        status = "needs-activation";
        break;
      case "blocked":
        status = "version-too-old";
        break;
      case "offline":
        sync = "offline";
        allowOffline = false;
        break;
      case "error":
        sync = "error";
        allowOffline = false;
        break;
      default:
        return null;
    }
    return {
      driver: { ...base, sync: async () => sync, status: () => status },
      confirm,
      opts: { allowOffline },
    };
  }

  for (const c of MATRIX.confirmCases) {
    it(`${c.outcome}: ${c.expect}`, async () => {
      // The client-core function the corpus pins.
      expect(bootConfirmation(c.outcome)).toBe(c.expect);
      const d = driverFor(c.outcome);
      // `running` is a stage, not a stop: runBoot never ends there.
      if (!d) return;
      vi.useFakeTimers();
      const r = await runBoot(d.driver, d.opts);
      expect(r.outcome).toBe(c.outcome);
      if (c.expect === "now") {
        expect(d.confirm).toHaveBeenCalledTimes(1);
      } else if (c.expect === "never") {
        await vi.advanceTimersByTimeAsync(BOOT_OK_SECONDS * 1000 * 10);
        expect(d.confirm).not.toHaveBeenCalled();
      } else {
        expect(d.confirm).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(BOOT_OK_SECONDS * 1000 - 1);
        expect(d.confirm).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(d.confirm).toHaveBeenCalledTimes(1);
      }
    });
  }

  it("autoConfirm: false leaves a ready launch for the host's confirmBoot()", async () => {
    const d = driverFor("ready")!;
    vi.useFakeTimers();
    await runBoot(d.driver, { autoConfirm: false });
    await vi.advanceTimersByTimeAsync(BOOT_OK_SECONDS * 1000 * 2);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("a driver with no guard boots as before: guard ok, nothing confirmed", async () => {
    const r = await runBoot({
      discover: async () => undefined,
      hasToken: () => true,
      registrationPolicy: () => null,
      licenseEnabled: () => false,
      sync: async () => "ok",
      status: () => "not-applicable",
    });
    expect(r.outcome).toBe("ready");
    expect(r.guard).toBeNull();
  });
});

describe("the browser adapter's boot() runs the guard", () => {
  const waitingContainer: SwContainer = {
    getRegistration: async () => ({
      waiting: {
        state: "installed",
        postMessage: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      installing: null,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  function page(s: ReturnType<typeof storage>, version: string) {
    return new BrowserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config"),
      }),
      now: () => NOW_SEC,
      version,
      bootGuard: { storage: s },
      serviceWorker: { container: waitingContainer },
    });
  }

  it("counts each boot in the persisted slots and confirms once the boot is ready", async () => {
    const s = storage();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const a = page(s, "1.0.0");
    const r = await a.boot();
    expect(r.outcome).toBe("ready");
    expect(r.guard).toMatchObject({
      result: "ok",
      // The waiting worker is the staged update.
      action: "apply-staged",
      failedBoots: 1,
    });
    expect(slotsIn(s)).toMatchObject({ failedBoots: 1, confirmed: false });
    await vi.advanceTimersByTimeAsync(BOOT_OK_SECONDS * 1000);
    await vi.waitFor(() =>
      expect(slotsIn(s)).toMatchObject({ failedBoots: 0, confirmed: true }),
    );
    a.dispose();
  });

  it("reads the page service worker as staged without activating it", async () => {
    const posted: unknown[] = [];
    const container: SwContainer = {
      getRegistration: async () => ({
        waiting: {
          state: "installed",
          postMessage: (message: unknown): void => void posted.push(message),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
        installing: null,
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    vi.stubGlobal("navigator", { serviceWorker: container });
    const a = new BrowserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config"),
      }),
      now: () => NOW_SEC,
      version: "1.0.0",
      bootGuard: { storage: storage() },
      autoStart: false,
    });
    try {
      expect(await a.markBootAttempt()).toMatchObject({
        action: "apply-staged",
        failedBoots: 1,
      });
      expect(posted).toEqual([]);
    } finally {
      a.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("a page with no version has no build to count: markBootAttempt says so, boot() skips the stage", async () => {
    const a = new BrowserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config"),
      }),
      now: () => NOW_SEC,
      bootGuard: { storage: storage() },
    });
    expect(await a.markBootAttempt().catch((e: unknown) => e)).toMatchObject({
      code: "not-configured",
    });
    expect(await a.confirmBoot().catch((e: unknown) => e)).toMatchObject({
      code: "not-configured",
    });
    expect((await a.boot()).guard).toBeNull();
    a.dispose();
  });

  it("the adapter's markBootAttempt/confirmBoot share the boot's slots", async () => {
    const s = storage();
    const a = page(s, "2.0.0");
    expect((await a.markBootAttempt()).failedBoots).toBe(1);
    await a.confirmBoot();
    expect(slotsIn(s)).toMatchObject({ failedBoots: 0, confirmed: true });
    expect(await a.bootGuardSkipVersion()).toBeNull();
    a.dispose();
  });
});

describe("the local adapter's guard", () => {
  it("persists its slots in the storage the host gave", async () => {
    const s = storage();
    const a = localAdapter({
      productSlug: "acme",
      version: "1.0.0",
      expectServices: services("config"),
      storage: s,
    });
    await a.markBootAttempt();
    expect(slotsIn(s)).toMatchObject({ current: "1.0.0", failedBoots: 1 });
    expect(a.bootGuardPersistent()).toBe(true);
    await a.confirmBoot();
    expect(slotsIn(s).confirmed).toBe(true);
    a.dispose();
  });
});

describe("update.bootguard on desktop-bridge: the host's guard over bridge v4", () => {
  function host() {
    const calls: Array<{ service: string; method: string; args: unknown }> = [];
    const attempt = {
      result: "applied",
      action: "none",
      failedBoots: 1,
      version: "1.1.0",
      previous: "1.0.0",
    };
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        if (method === "markBootAttempt") return attempt;
        if (method === "boot")
          return {
            outcome: "ready",
            state: { stage: "ready", outcome: "ready" },
            license: { status: "ok" },
            decision: null,
            guard: attempt,
            emits: [],
          };
        return undefined;
      },
    };
    return { bridge, calls, attempt };
  }

  it("markBootAttempt and confirmBoot are the host's update verbs", async () => {
    const { bridge, calls, attempt } = host();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    expect(await a.markBootAttempt()).toEqual(attempt);
    await a.confirmBoot();
    expect(calls).toEqual([
      { service: "update", method: "markBootAttempt", args: undefined },
      { service: "update", method: "confirmBoot", args: undefined },
    ]);
    a.dispose();
  });

  it("boot() carries the host's guard outcome", async () => {
    const { bridge, attempt } = host();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    expect((await a.boot()).guard).toEqual(attempt);
    a.dispose();
  });

  it("boot() sends the host the options bridge.ts lists (autoConfirm among them) and keeps its callbacks and pack facet", async () => {
    const { bridge, calls } = host();
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const onStage = vi.fn();
    await a.boot({
      onStage,
      answer: async () => true,
      packs: {
        bootOptions: () => ({ requiredPacks: [], essentialPacks: [] }),
        bootFetch: async () => undefined,
      },
      consent: "never",
      metered: true,
      requiredPacks: ["acme.l10n"],
      allowOffline: false,
      allowGrace: false,
      registration: false,
      autoConfirm: false,
    });
    expect(calls.find((c) => c.method === "boot")).toEqual({
      service: "core",
      method: "boot",
      args: {
        consent: "never",
        metered: true,
        requiredPacks: ["acme.l10n"],
        allowOffline: false,
        allowGrace: false,
        registration: false,
        autoConfirm: false,
      },
    });
    // The boot ran in the host, so the renderer's stage callback is called once, at the end.
    expect(onStage).toHaveBeenCalledTimes(1);
    a.dispose();
  });

  it("an older host gets the typed version N/A with nothing sent", async () => {
    const calls: unknown[] = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 3,
      invoke: async (...a: unknown[]) => {
        calls.push(a);
        return null;
      },
    };
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    for (const call of [() => a.markBootAttempt(), () => a.confirmBoot()]) {
      expect(await call().catch((e: unknown) => e)).toMatchObject({
        feature: "update.bootguard",
        reason: "version",
      });
    }
    expect(calls).toEqual([]);
    expect(a.supports("update.bootguard")).toMatchObject({
      supported: false,
      reason: "version",
    });
    a.dispose();
  });
});

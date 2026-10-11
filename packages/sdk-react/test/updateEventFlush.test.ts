// @vitest-environment node
//
// @pkey-feature telemetry.updates update.driver update.bootguard
//
// A bearer page's update-health journal lives in memory and is drained by the report that ends a
// sync pass (telemetry.updates). Two lifecycle steps record events and then leave no pass to
// drain them: an install reloads the page right after `update_applied`, and a launch's first
// confirmation comes after the boot's last sync and is never recorded again (nor is a rollback).
// So both send the journal themselves (`BearerSession.flushUpdateEvents`), and this file drives
// them through the browser ADAPTER in bearer mode against a reporter that remembers what it was
// sent and when it answered: the events must have reached it before the reload, and before
// `confirmBoot()` / `markBootAttempt()` return.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FAILED_BOOTS } from "@polaris-key/client-core";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { FLUSH_WAIT_SECONDS } from "../src/browser/bearer/session.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import type { SwContainer } from "../src/browser/serviceWorkerUpdate.js";
import { bootGuardStorageKey, type BootSlots } from "../src/core/bootGuard.js";
import type { InstallOutcome } from "../src/core/install.js";
import { newTestKey, type TestKey } from "./fixtures.js";
// Loaded before any fake clock starts: the adapter imports it on first use.
import "../src/browser/serviceWorkerInstall.js";

const NOW = 1_700_000_000;

const platform: UpdateDecision = {
  action: "platform",
  release: { version: "1.1.0", seq: 7 },
  mandatory: false,
  critical: false,
  discardStaged: false,
};

afterEach(() => {
  vi.useRealTimers();
});

interface Report {
  updates?: Array<{ event: string }>;
}

/**
 * The Worker's `devices/report`: what it received, what it answered, and when. `hold` keeps the
 * answer back until `release()`; `up: false` is an unreachable network.
 */
function reporter() {
  const state = { up: true, hold: false };
  const received: Report[] = [];
  const answered: Report[] = [];
  const held: Array<() => void> = [];
  let arrive = (): void => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    if (new URL(String(input)).pathname !== "/acme/devices/report")
      return new Response("not found", { status: 404 });
    if (!state.up) throw new TypeError("Failed to fetch");
    const body = JSON.parse(String(init.body)) as Report;
    received.push(body);
    arrive();
    if (state.hold) await new Promise<void>((resolve) => held.push(resolve));
    answered.push(body);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return {
    state,
    received,
    fetchImpl,
    firstRequest,
    release: (): void => {
      for (const resolve of held.splice(0)) resolve();
    },
    /** The events of every report the Worker answered, in order. */
    delivered: (): string[] =>
      answered.flatMap((r) => (r.updates ?? []).map((u) => u.event)),
  };
}

/** A registration whose waiting worker takes control as soon as it is told to skip waiting. */
function activatingContainer(): SwContainer {
  const listeners = new Set<() => void>();
  const waiting = {
    state: "installed",
    postMessage: (): void => {
      queueMicrotask(() => {
        waiting.state = "activated";
        for (const l of [...listeners]) l();
      });
    },
    addEventListener: (_type: string, l: () => void): void => {
      listeners.add(l);
    },
    removeEventListener: (_type: string, l: () => void): void => {
      listeners.delete(l);
    },
  };
  return {
    getRegistration: async () => ({ waiting, installing: null }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

/** Browser storage the tests can inspect, shared by the launches of one page. */
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

let key: TestKey | undefined;

/** A bearer-mode page holding a device token, reporting to `fetchImpl`. */
async function bearerPage(o: {
  fetchImpl: typeof fetch;
  version?: string;
  container?: SwContainer;
  reload?: () => void;
  storage?: ReturnType<typeof storage>;
  rollback?: (previous: string) => Promise<boolean>;
}): Promise<BrowserAdapter> {
  key ??= await newTestKey("pkey-test-flush");
  const store = memoryStore("acme");
  await store.setToken("pkeyt_flush");
  return new BrowserAdapter({
    auth: "bearer",
    productSlug: "acme",
    offlineStore: null,
    autoStart: false,
    version: o.version ?? "1.0.0",
    now: () => NOW,
    trust: { pinnedKeys: { [key.kid]: key.raw } },
    store,
    fetchImpl: o.fetchImpl,
    serviceWorker: {
      container: o.container ?? null,
      reload: o.reload ?? (() => undefined),
    },
    bootGuard: {
      storage: o.storage ?? null,
      ...(o.rollback ? { rollback: o.rollback } : {}),
    },
  });
}

describe("a bearer page's install sends its journal before it reloads", () => {
  it("has update_downloaded and update_applied answered by the reporter when the reload runs", async () => {
    const rep = reporter();
    const atReload: string[][] = [];
    const reload = vi.fn(() => void atReload.push(rep.delivered()));
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      container: activatingContainer(),
      reload,
    });
    try {
      expect(await page.installUpdate(platform)).toMatchObject({
        kind: "handedOff",
        version: "1.1.0",
      });
      expect(atReload).toEqual([["update_downloaded", "update_applied"]]);
      // Answered, so they left the journal: the next report carries none.
      expect(await page.report()).toBe(true);
      expect(rep.received.at(-1)).not.toHaveProperty("updates");
    } finally {
      page.dispose();
    }
  });

  it("reload: false: restart() sends them before it reloads, too", async () => {
    const rep = reporter();
    const atReload: string[][] = [];
    const reload = vi.fn(() => void atReload.push(rep.delivered()));
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      container: activatingContainer(),
      reload,
    });
    try {
      const out = await page.installUpdate(platform, { reload: false });
      if (out.kind !== "restartRequired") throw new Error("unreachable");
      expect(reload).not.toHaveBeenCalled();
      await out.restart();
      expect(atReload).toEqual([["update_downloaded", "update_applied"]]);
    } finally {
      page.dispose();
    }
  });

  it("waits for the reporter's answer, not just for the request to leave", async () => {
    const rep = reporter();
    rep.state.hold = true;
    const reload = vi.fn();
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      container: activatingContainer(),
      reload,
    });
    try {
      const install = page.installUpdate(platform);
      // Fails here, not by timing out, when the install finishes without ever reporting.
      await Promise.race([rep.firstRequest, install]);
      expect(rep.received).toHaveLength(1);
      expect(reload).not.toHaveBeenCalled();
      rep.release();
      expect(await install).toMatchObject({ kind: "handedOff" });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(rep.delivered()).toEqual(["update_downloaded", "update_applied"]);
    } finally {
      page.dispose();
    }
  });

  it("does not hold the reload behind a reporter that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rep = reporter();
    rep.state.hold = true; // never released
    const reload = vi.fn();
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      container: activatingContainer(),
      reload,
    });
    try {
      let outcome: InstallOutcome | undefined;
      const install = page.installUpdate(platform).then((o) => (outcome = o));
      await Promise.race([rep.firstRequest, install]);
      expect(rep.received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(FLUSH_WAIT_SECONDS * 1000 - 1);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(reload).toHaveBeenCalledTimes(1);
      await install;
      expect(outcome).toMatchObject({ kind: "handedOff", version: "1.1.0" });
    } finally {
      page.dispose();
    }
  });

  it("an unreachable reporter never fails the install: the events wait for the next report", async () => {
    const rep = reporter();
    rep.state.up = false;
    const reload = vi.fn();
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      container: activatingContainer(),
      reload,
    });
    try {
      expect(await page.installUpdate(platform)).toMatchObject({
        kind: "handedOff",
      });
      expect(reload).toHaveBeenCalledTimes(1);
      rep.state.up = true;
      expect(await page.report()).toBe(true);
      expect(rep.delivered()).toEqual(["update_downloaded", "update_applied"]);
    } finally {
      page.dispose();
    }
  });
});

describe("a bearer page's boot guard sends its journal once it has saved", () => {
  /** 1.0.0 launched and confirmed, so that 1.1.0 is an update with a previous version. */
  async function installed100(
    s: ReturnType<typeof storage>,
    rep: ReturnType<typeof reporter>,
  ): Promise<void> {
    const old = await bearerPage({
      fetchImpl: rep.fetchImpl,
      version: "1.0.0",
      storage: s,
    });
    await old.markBootAttempt();
    await old.confirmBoot();
    old.dispose();
  }

  it("has update_confirmed answered by the reporter when confirmBoot() returns, and sends it once", async () => {
    const s = storage();
    const rep = reporter();
    await installed100(s, rep);
    // The first launch ever has no previous version: nothing to confirm, nothing sent.
    expect(rep.received).toEqual([]);
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      version: "1.1.0",
      storage: s,
    });
    try {
      await page.markBootAttempt();
      expect(rep.received).toEqual([]);
      await page.confirmBoot();
      expect(rep.delivered()).toEqual(["update_confirmed"]);
      expect(slotsIn(s)).toMatchObject({ failedBoots: 0, confirmed: true });
      // Idempotent: no second event, no second report.
      await page.confirmBoot();
      expect(rep.received).toHaveLength(1);
    } finally {
      page.dispose();
    }
  });

  it("has update_reverted and boot_rolled_back answered when a rollback's markBootAttempt() returns", async () => {
    const s = storage();
    const rep = reporter();
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
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      version: "1.1.0",
      storage: s,
      rollback: async () => true,
    });
    try {
      expect(await page.markBootAttempt()).toMatchObject({
        result: "rolled-back",
      });
      expect(rep.delivered()).toEqual(["update_reverted", "boot_rolled_back"]);
      expect(slotsIn(s)).toMatchObject({ skipVersion: "1.1.0" });
    } finally {
      page.dispose();
    }
  });

  it("an unreachable reporter never fails the confirmation: the event waits for the next report", async () => {
    const s = storage();
    const rep = reporter();
    await installed100(s, rep);
    rep.state.up = false;
    const page = await bearerPage({
      fetchImpl: rep.fetchImpl,
      version: "1.1.0",
      storage: s,
    });
    try {
      await page.markBootAttempt();
      await expect(page.confirmBoot()).resolves.toBeUndefined();
      expect(slotsIn(s)).toMatchObject({ confirmed: true });
      rep.state.up = true;
      expect(await page.report()).toBe(true);
      expect(rep.delivered()).toEqual(["update_confirmed"]);
    } finally {
      page.dispose();
    }
  });
});

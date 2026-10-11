// @pkey-feature update.driver
// The update hand-off (SDK parity pass §3.16, SP-15). Two transports:
//
//   web             a `platform` decision hands off to the registration's WAITING service worker:
//                   post `SKIP_WAITING`, wait for it to take control, reload. Proven with a fake
//                   registration (a worker that moves through states and a container that fires
//                   `controllerchange`), not a real browser; the device proof is a recorded run
//                   in a browser and in the Electron sample, noted in the PR.
//   desktop-bridge  forwarded to the host's `client.update.install()` over bridge v4
//                   (`invoke("update", "install", {decision})`); an older host answers the typed
//                   `version` N/A as a result, with nothing sent.

import { describe, expect, it, vi } from "vitest";
import type { UpdateDecision } from "@polaris-key/protocol/update";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import {
  HAND_OFF_TIMEOUT_MS,
  installViaServiceWorker,
} from "../src/browser/serviceWorkerInstall.js";
import {
  SKIP_WAITING_MESSAGE,
  hasWaitingWorker,
  type SwContainer,
  type SwRegistration,
  type SwWorker,
} from "../src/browser/serviceWorkerUpdate.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { PolarisError } from "../src/core/types.js";
import type { InstallOutcome } from "../src/core/install.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeFakeBridge,
  makeFakeFetch,
  makeDoc,
  services,
} from "./fixtures.js";

class FakeWorker implements SwWorker {
  state: string;
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<() => void>();
  /** What the worker does when it is told to skip waiting. */
  onSkip: () => void = () => this.become("activated");
  constructor(state: string) {
    this.state = state;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
    queueMicrotask(() => this.onSkip());
  }
  addEventListener(_type: string, l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: string, l: () => void): void {
    this.listeners.delete(l);
  }
  become(state: string): void {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }
  get listening(): number {
    return this.listeners.size;
  }
}

class FakeContainer implements SwContainer {
  reg: SwRegistration | undefined;
  readonly listeners = new Set<() => void>();
  constructor(reg: SwRegistration | undefined) {
    this.reg = reg;
  }
  async getRegistration(): Promise<SwRegistration | undefined> {
    return this.reg;
  }
  addEventListener(_type: string, l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: string, l: () => void): void {
    this.listeners.delete(l);
  }
  controllerChange(): void {
    for (const l of [...this.listeners]) l();
  }
}

const platform: UpdateDecision = {
  action: "platform",
  release: { version: "1.1.0", seq: 7 },
  mandatory: false,
  critical: false,
  discardStaged: false,
};
const binary: UpdateDecision = {
  action: "binary",
  method: "native",
  release: { version: "1.1.0", seq: 7, sha256: "a".repeat(64) },
  build: "win-x64",
  mandatory: false,
  critical: false,
  prestage: [],
  discardStaged: false,
};

describe("update.driver on web: the service-worker hand-off", () => {
  it("posts SKIP_WAITING to the waiting worker, waits for control, reloads, answers handedOff", async () => {
    const waiting = new FakeWorker("installed");
    const container = new FakeContainer({ waiting, installing: null });
    const reload = vi.fn();
    const events: string[] = [];
    const out = await installViaServiceWorker(
      {
        container,
        reload,
        currentVersion: "1.0.0",
        record: async (event, input) => {
          events.push(`${event}:${input.release}<${input.fromRelease}`);
          // The reload must come after the hand-off is journaled.
          expect(reload).not.toHaveBeenCalled();
        },
      },
      platform,
    );
    expect(waiting.posted).toEqual([SKIP_WAITING_MESSAGE]);
    expect(out).toMatchObject({ kind: "handedOff", version: "1.1.0" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "update_downloaded:1.1.0<1.0.0",
      "update_applied:1.1.0<1.0.0",
    ]);
    // No listener is left behind.
    expect(waiting.listening).toBe(0);
    expect(container.listeners.size).toBe(0);
  });

  it("takes control on the container's controllerchange too", async () => {
    const waiting = new FakeWorker("installed");
    waiting.onSkip = () => undefined;
    const container = new FakeContainer({ waiting, installing: null });
    const reload = vi.fn();
    const p = installViaServiceWorker({ container, reload }, platform);
    await vi.waitFor(() =>
      expect(waiting.posted).toEqual([SKIP_WAITING_MESSAGE]),
    );
    expect(reload).not.toHaveBeenCalled();
    container.controllerChange();
    expect(await p).toMatchObject({ kind: "handedOff" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("waits for an installing worker to finish installing", async () => {
    const installing = new FakeWorker("installing");
    const reg: SwRegistration & { waiting: SwWorker | null } = {
      waiting: null,
      installing,
    };
    const reload = vi.fn();
    const p = installViaServiceWorker(
      { container: new FakeContainer(reg), reload },
      platform,
    );
    await vi.waitFor(() => expect(installing.listening).toBe(1));
    expect(installing.posted).toEqual([]);
    reg.waiting = installing;
    installing.become("installed");
    expect(await p).toMatchObject({ kind: "handedOff" });
    expect(installing.posted).toEqual([SKIP_WAITING_MESSAGE]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reload: false answers restartRequired and restart() does the hand-off", async () => {
    const waiting = new FakeWorker("installed");
    const reload = vi.fn();
    const out = await installViaServiceWorker(
      { container: new FakeContainer({ waiting, installing: null }), reload },
      platform,
      { reload: false },
    );
    expect(out.kind).toBe("restartRequired");
    expect(waiting.posted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    if (out.kind !== "restartRequired") throw new Error("unreachable");
    await out.restart();
    expect(waiting.posted).toEqual([SKIP_WAITING_MESSAGE]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a worker that goes redundant is a typed N/A, never a reload", async () => {
    const waiting = new FakeWorker("installed");
    waiting.onSkip = () => waiting.become("redundant");
    const reload = vi.fn();
    const out = await installViaServiceWorker(
      { container: new FakeContainer({ waiting, installing: null }), reload },
      platform,
    );
    expect(out).toMatchObject({ kind: "unsupported", reason: "dependency" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("sends the journal after update_applied and before the reload, and waits for it", async () => {
    const waiting = new FakeWorker("installed");
    const order: string[] = [];
    const reload = vi.fn(() => void order.push("reload"));
    // A reporter that answers when the test says so.
    let answer = (): void => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const install = installViaServiceWorker(
      {
        container: new FakeContainer({ waiting, installing: null }),
        reload,
        record: async (event) => void order.push(event),
        flush: async () => {
          order.push("flush sent");
          await answered;
          order.push("flush answered");
        },
      },
      platform,
    );
    await vi.waitFor(() => expect(order).toContain("flush sent"));
    expect(reload).not.toHaveBeenCalled();
    answer();
    expect((await install).kind).toBe("handedOff");
    expect(order).toEqual([
      "update_downloaded",
      "update_applied",
      "flush sent",
      "flush answered",
      "reload",
    ]);
  });

  it("reload: false sends the journal in restart(), before it reloads", async () => {
    const waiting = new FakeWorker("installed");
    const order: string[] = [];
    const out = await installViaServiceWorker(
      {
        container: new FakeContainer({ waiting, installing: null }),
        reload: () => void order.push("reload"),
        record: async (event) => void order.push(event),
        flush: async () => void order.push("flush"),
      },
      platform,
      { reload: false },
    );
    if (out.kind !== "restartRequired") throw new Error("unreachable");
    await out.restart();
    expect(order).toEqual([
      "update_downloaded",
      "update_applied",
      "flush",
      "reload",
    ]);
  });

  it("a journal that cannot be sent never fails the install; a hand-off that did not happen sends nothing", async () => {
    const reload = vi.fn();
    const out = await installViaServiceWorker(
      {
        container: new FakeContainer({
          waiting: new FakeWorker("installed"),
          installing: null,
        }),
        reload,
        flush: async () => {
          throw new Error("offline");
        },
      },
      platform,
    );
    expect(out.kind).toBe("handedOff");
    expect(reload).toHaveBeenCalledTimes(1);

    const redundant = new FakeWorker("installed");
    redundant.onSkip = () => redundant.become("redundant");
    const flush = vi.fn(async () => undefined);
    expect(
      await installViaServiceWorker(
        {
          container: new FakeContainer({
            waiting: redundant,
            installing: null,
          }),
          reload: vi.fn(),
          flush,
        },
        platform,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "dependency" });
    expect(flush).not.toHaveBeenCalled();
  });

  it("a worker that never takes control is unsupported{dependency} after HAND_OFF_TIMEOUT_MS, never a reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const waiting = new FakeWorker("installed");
      waiting.onSkip = () => undefined; // never answers SKIP_WAITING
      const container = new FakeContainer({ waiting, installing: null });
      const reload = vi.fn();
      const flush = vi.fn(async () => undefined);
      const events: string[] = [];
      let outcome: InstallOutcome | undefined;
      const p = installViaServiceWorker(
        {
          container,
          reload,
          flush,
          record: async (event) => void events.push(event),
        },
        platform,
      ).then((o) => (outcome = o));
      await vi.advanceTimersByTimeAsync(HAND_OFF_TIMEOUT_MS - 1);
      expect(waiting.posted).toEqual([SKIP_WAITING_MESSAGE]);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({
        kind: "unsupported",
        reason: "dependency",
        detail: expect.stringContaining("15 seconds"),
      });
      await p;
      expect(reload).not.toHaveBeenCalled();
      expect(flush).not.toHaveBeenCalled();
      // Downloaded, never applied.
      expect(events).toEqual(["update_downloaded"]);
      // Nothing is left listening, and no deadline is left running.
      expect(waiting.listening).toBe(0);
      expect(container.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reload: false: restart() rejects when the worker never takes control", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const waiting = new FakeWorker("installed");
      waiting.onSkip = () => undefined;
      const reload = vi.fn();
      const out = await installViaServiceWorker(
        { container: new FakeContainer({ waiting, installing: null }), reload },
        platform,
        { reload: false },
      );
      if (out.kind !== "restartRequired") throw new Error("unreachable");
      let result: unknown;
      const settled = out.restart().then(
        () => (result = "restarted"),
        (e: unknown) => (result = e),
      );
      await vi.advanceTimersByTimeAsync(HAND_OFF_TIMEOUT_MS);
      expect(result).toMatchObject({
        code: "unknown",
        message: expect.stringContaining("15 seconds"),
      });
      await settled;
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a worker that takes control just before the deadline still hands off, and an abort leaves no deadline behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const waiting = new FakeWorker("installed");
      waiting.onSkip = () => undefined;
      const reload = vi.fn();
      const p = installViaServiceWorker(
        { container: new FakeContainer({ waiting, installing: null }), reload },
        platform,
      );
      await vi.advanceTimersByTimeAsync(HAND_OFF_TIMEOUT_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      waiting.become("activated");
      expect(await p).toMatchObject({ kind: "handedOff" });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);

      const stuck = new FakeWorker("installed");
      stuck.onSkip = () => undefined;
      const abort = new AbortController();
      const q = installViaServiceWorker(
        { container: new FakeContainer({ waiting: stuck, installing: null }) },
        platform,
        { signal: abort.signal },
      ).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      expect(stuck.posted).toEqual([SKIP_WAITING_MESSAGE]);
      abort.abort(new Error("later"));
      expect(await q).toMatchObject({ message: "later" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers unsupported{reason} when there is nothing to hand off to", async () => {
    const reload = vi.fn();
    expect(
      await installViaServiceWorker({ container: null, reload }, platform),
    ).toMatchObject({ kind: "unsupported", reason: "runtime" });
    expect(
      await installViaServiceWorker(
        { container: new FakeContainer(undefined), reload },
        platform,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "dependency" });
    expect(
      await installViaServiceWorker(
        {
          container: new FakeContainer({ waiting: null, installing: null }),
          reload,
        },
        platform,
      ),
    ).toMatchObject({ kind: "unsupported", reason: "dependency" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("binary and store decisions are not a page's to install; the rest offer nothing", async () => {
    const waiting = new FakeWorker("installed");
    const container = new FakeContainer({ waiting, installing: null });
    const deps = { container, reload: vi.fn() };
    expect(await installViaServiceWorker(deps, binary)).toMatchObject({
      kind: "unsupported",
      reason: "runtime",
    });
    expect(
      await installViaServiceWorker(deps, {
        action: "none",
        reason: "up-to-date",
        behind: false,
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "product" });
    expect(
      await installViaServiceWorker(deps, {
        action: "packs",
        install: [],
        revoke: [],
        set: [],
        discardStaged: false,
      }),
    ).toMatchObject({ kind: "unsupported", reason: "product" });
    expect(waiting.posted).toEqual([]);
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("an aborted signal rejects with its reason before anything starts, and while waiting", async () => {
    const waiting = new FakeWorker("installed");
    waiting.onSkip = () => undefined;
    const container = new FakeContainer({ waiting, installing: null });
    const early = new AbortController();
    early.abort(new Error("stop"));
    await expect(
      installViaServiceWorker({ container, reload: vi.fn() }, platform, {
        signal: early.signal,
      }),
    ).rejects.toThrow("stop");
    expect(waiting.posted).toEqual([]);
    const late = new AbortController();
    const p = installViaServiceWorker(
      { container, reload: vi.fn() },
      platform,
      { signal: late.signal },
    );
    await vi.waitFor(() => expect(waiting.posted).toHaveLength(1));
    late.abort(new Error("later"));
    await expect(p).rejects.toThrow("later");
    expect(waiting.listening).toBe(0);
  });

  it("a journal that fails never fails the install", async () => {
    const waiting = new FakeWorker("installed");
    const reload = vi.fn();
    const out = await installViaServiceWorker(
      {
        container: new FakeContainer({ waiting, installing: null }),
        reload,
        record: async () => {
          throw new PolarisError("unsupported", "cookie page");
        },
      },
      platform,
    );
    expect(out.kind).toBe("handedOff");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("hasWaitingWorker reads the registration and never throws", async () => {
    expect(await hasWaitingWorker(null)).toBe(false);
    expect(
      await hasWaitingWorker(
        new FakeContainer({
          waiting: new FakeWorker("installed"),
          installing: null,
        }),
      ),
    ).toBe(true);
    expect(
      await hasWaitingWorker({
        ...new FakeContainer(undefined),
        getRegistration: async () => {
          throw new Error("blocked");
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    ).toBe(false);
  });

  it("the browser adapter's installUpdate runs it, journaling in bearer mode", async () => {
    const waiting = new FakeWorker("installed");
    const reload = vi.fn();
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config", "update"),
      }),
      now: () => NOW_SEC,
      version: "1.0.0",
      serviceWorker: {
        container: new FakeContainer({ waiting, installing: null }),
        reload,
      },
    });
    expect(await a.installUpdate(platform)).toMatchObject({
      kind: "handedOff",
      version: "1.1.0",
    });
    expect(reload).toHaveBeenCalledTimes(1);
    a.dispose();
  });

  it("the browser adapter discovers the page service worker when no container is configured", async () => {
    const waiting = new FakeWorker("installed");
    const container = new FakeContainer({ waiting, installing: null });
    const reload = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: container });
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {
        capabilities: services("license", "config", "update"),
      }),
      now: () => NOW_SEC,
      version: "1.0.0",
      serviceWorker: { reload },
      autoStart: false,
    });
    try {
      expect(await a.installUpdate(platform)).toMatchObject({
        kind: "handedOff",
        version: "1.1.0",
      });
      expect(waiting.posted).toEqual([SKIP_WAITING_MESSAGE]);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      a.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("the browser adapter with no service worker answers unsupported", async () => {
    const a = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(makeDoc(), {}),
      now: () => NOW_SEC,
      serviceWorker: { container: null },
    });
    expect(await a.installUpdate(platform)).toMatchObject({
      kind: "unsupported",
      reason: "runtime",
    });
    a.dispose();
  });
});

describe("update.driver on desktop-bridge: forwarded to the host", () => {
  function host(answer: unknown) {
    const calls: Array<{ service: string; method: string; args: unknown }> = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        return method === "install" ? answer : undefined;
      },
    };
    return { bridge, calls };
  }

  it("sends a binary decision to update.install and returns the host's outcome", async () => {
    const { bridge, calls } = host({
      kind: "handedOff",
      version: "1.1.0",
      detail: "installer started",
    });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    expect(await a.installUpdate(binary)).toEqual({
      kind: "handedOff",
      version: "1.1.0",
      detail: "installer started",
    });
    expect(calls).toEqual([
      { service: "update", method: "install", args: { decision: binary } },
    ]);
    a.dispose();
  });

  it("a restartRequired outcome's restart() is invoke(update, restart)", async () => {
    const { bridge, calls } = host({
      kind: "restartRequired",
      version: "1.1.0",
    });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const out = await a.installUpdate(binary);
    if (out.kind !== "restartRequired") throw new Error("not restartRequired");
    expect(out.version).toBe("1.1.0");
    await out.restart();
    expect(calls.map((c) => `${c.service}.${c.method}`)).toEqual([
      "update.install",
      "update.restart",
    ]);
    a.dispose();
  });

  it("a store outcome and the host's own N/A pass through", async () => {
    const store = host({ kind: "storeOpened", url: "https://store.test/a" });
    const a = desktopAdapter({ bridge: store.bridge, now: () => NOW_SEC });
    expect(
      await a.installUpdate({
        action: "store",
        release: { version: "1.1.0", seq: 7 },
        listingUrl: "https://store.test/a",
        mandatory: false,
        critical: false,
        discardStaged: false,
      }),
    ).toEqual({ kind: "storeOpened", url: "https://store.test/a" });
    a.dispose();
    const na = host({
      kind: "unsupported",
      reason: "dependency",
      detail: "no driver",
    });
    const b = desktopAdapter({ bridge: na.bridge, now: () => NOW_SEC });
    expect(await b.installUpdate(binary)).toEqual({
      kind: "unsupported",
      reason: "dependency",
      detail: "no driver",
    });
    b.dispose();
  });

  it("answers decisions no driver installs without crossing the bridge", async () => {
    const { bridge, calls } = host(null);
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    expect(await a.installUpdate(platform)).toMatchObject({
      kind: "unsupported",
      reason: "outlet",
    });
    expect(calls).toEqual([]);
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
    expect(await a.installUpdate(binary)).toMatchObject({
      kind: "unsupported",
      reason: "version",
    });
    expect(calls).toEqual([]);
    expect(a.supports("update.driver")).toMatchObject({
      supported: false,
      reason: "version",
    });
    a.dispose();
  });

  it("a host answer that is not an outcome is refused, not trusted", async () => {
    const { bridge } = host({ kind: "wat" });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    await expect(a.installUpdate(binary)).rejects.toMatchObject({
      code: "unknown",
    });
    a.dispose();
  });

  it("an aborted signal stops the install before it crosses the bridge", async () => {
    const { bridge, calls } = host({ kind: "handedOff", version: "1.1.0" });
    const a = desktopAdapter({ bridge, now: () => NOW_SEC });
    const c = new AbortController();
    c.abort(new Error("no"));
    await expect(a.installUpdate(binary, { signal: c.signal })).rejects.toThrow(
      "no",
    );
    expect(calls).toEqual([]);
    a.dispose();
  });
});

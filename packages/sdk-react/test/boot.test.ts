// @vitest-environment node
//
// @pkey-feature ui.boot ui.stages
// The one-call boot (SDK-PARITY-PASS §3.4, SP-12). Three proofs:
//
//   1. every conformance/corpus/v2/stage-matrix.json row a single boot pass can produce runs
//      through `runBoot` (core/boot.ts) over a scripted driver that answers each stage as the row
//      does; the events `runBoot` sends, the emits and the outcome must be the row's;
//   2. boot-cold-register.json replays through the browser ADAPTER's `boot()` in bearer mode
//      (the transcript replayer drives the same driver over a bare session; this drives the
//      adapter wiring);
//   3. the desktop adapter forwards to the host's `client.boot()` over bridge v4, and an older
//      host gets the typed `version` N/A without the call crossing the bridge.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  BootEmit,
  BootEvent,
  BootOptions,
  BootState,
} from "@polaris-key/client-core";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import { runBoot, type BootDriver, type BootPacks } from "../src/core/boot.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { memoryStore } from "../src/browser/bearer/store.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import { UnsupportedError } from "../src/core/caps.js";
import { servicesFromList } from "../src/core/services.js";
import type { OfflineRecord } from "../src/browser/offline.js";
import {
  NOW_SEC,
  emptyBridgeState,
  makeFakeBridge,
  okBridgeState,
} from "./fixtures.js";
import {
  loadTranscripts,
  ReplayServer,
} from "../../../conformance/runners/node/transcriptReplay.js";

interface Row {
  name: string;
  init: BootOptions;
  steps: Array<{ event: BootEvent; emits: BootEmit[] }>;
  expect: { stages: string[]; outcome: string };
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
) as { rows: Row[] };

/** The linear order one boot pass sends its events in. */
const PASS = [
  "start",
  "shell.done",
  "guard.done",
  "sync.done",
  "gate.status",
  "decide.done",
];
const FETCH = new Set(["fetch.consent", "fetch.progress", "fetch.done"]);

/** Whether one boot pass can produce the row: the pass's events in order, one gate status (a
 *  reacquire happens inside the gate step), the fetch's own events, then at most `mount.done`.
 *  Retries, timeouts, `play-offline`, host failures and background work are a host's later
 *  events, not one pass's. */
function onePass(row: Row): boolean {
  const types = row.steps.map((s) => s.event.type);
  let i = 0;
  for (const want of PASS) {
    if (i === types.length) return true;
    if (types[i] !== want) return false;
    i += 1;
  }
  while (i < types.length && FETCH.has(types[i]!)) i += 1;
  if (i < types.length && types[i] === "mount.done") i += 1;
  return i === types.length;
}

function eventOf<T extends BootEvent["type"]>(
  row: Row,
  type: T,
): Extract<BootEvent, { type: T }> | undefined {
  return row.steps.find((s) => s.event.type === type)?.event as
    | Extract<BootEvent, { type: T }>
    | undefined;
}

/** A driver answering each stage as the row does. */
function scripted(row: Row): { driver: BootDriver; packs: BootPacks } {
  const guard = eventOf(row, "guard.done");
  const sync = eventOf(row, "sync.done");
  const gate = eventOf(row, "gate.status");
  const decide = eventOf(row, "decide.done");
  const fetchEvents = row.steps
    .map((s) => s.event)
    .filter((e) => FETCH.has(e.type));
  const status: LicenseStatus = gate?.status ?? "needs-activation";
  return {
    driver: {
      discover: async () => undefined,
      hasToken: () => true,
      registrationPolicy: () => null,
      licenseEnabled: () => false,
      guard: async () => guard?.result ?? "ok",
      sync: async () => sync?.result ?? "ok",
      status: () => status,
      ...(decide && decide.decision !== "none"
        ? {
            decide: async () => ({ decision: decide.decision, check: null }),
          }
        : {}),
    },
    packs: {
      bootOptions: () => ({
        requiredPacks: row.init.requiredPacks ?? [],
        essentialPacks: row.init.essentialPacks ?? [],
      }),
      bootFetch: async ({ send }) => {
        for (const e of fetchEvents) send(e);
      },
    },
  };
}

describe("stage-matrix.json rows through runBoot", () => {
  const rows = MATRIX.rows.filter(onePass);

  it("covers every single-pass row, ending in every outcome but running", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
    expect(new Set(rows.map((r) => r.expect.outcome))).toEqual(
      new Set(["ready", "waiting", "blocked", "offline", "error"]),
    );
  });

  for (const row of rows) {
    it(row.name, async () => {
      const { driver, packs } = scripted(row);
      const sent: BootEvent[] = [];
      const stages: string[] = [];
      const r = await runBoot(driver, {
        ...(row.init.allowOffline !== undefined
          ? { allowOffline: row.init.allowOffline }
          : {}),
        ...(row.init.allowGrace !== undefined
          ? { allowGrace: row.init.allowGrace }
          : {}),
        packs,
        onStage: (step) => {
          if (step.event) sent.push(step.event);
          for (const e of step.emits)
            if (e.type === "stage_changed") stages.push(e.stage);
        },
      });
      expect(sent).toEqual(row.steps.map((s) => s.event));
      expect(r.emits).toEqual(row.steps.flatMap((s) => s.emits));
      expect(stages).toEqual(row.expect.stages);
      expect(r.outcome).toBe(row.expect.outcome);
    });
  }
});

describe("runBoot's reacquire (core.registration)", () => {
  function driver(over: Partial<BootDriver>, log: string[]): BootDriver {
    let status: LicenseStatus = "needs-activation";
    return {
      discover: async () => undefined,
      hasToken: () => true,
      registrationPolicy: () => "open",
      licenseEnabled: () => true,
      register: async () => {
        log.push("register");
        status = "ok";
        return true;
      },
      enroll: async () => {
        log.push("enroll");
        return false;
      },
      sync: async (force) => {
        log.push(force ? "sync!" : "sync");
        return "ok";
      },
      status: () => status,
      ...over,
    };
  }

  it("registers on an open product, syncs, and passes the gate", async () => {
    const log: string[] = [];
    const r = await runBoot(driver({}, log));
    expect(log).toEqual(["sync", "register", "sync!"]);
    expect(r.outcome).toBe("ready");
  });

  it("never prompts: a product that requires an identity ends waiting", async () => {
    const log: string[] = [];
    const r = await runBoot(
      driver({ registrationPolicy: () => "requires-identity" }, log),
    );
    expect(log).toEqual(["sync"]);
    expect(r.outcome).toBe("waiting");
    expect(r.emits).toContainEqual({
      type: "waiting",
      status: "needs-activation",
    });
  });

  it("registration: false skips the reacquire", async () => {
    const log: string[] = [];
    const r = await runBoot(driver({}, log), { registration: false });
    expect(log).toEqual(["sync"]);
    expect(r.outcome).toBe("waiting");
  });
});

describe("boot-cold-register.json through the browser adapter's boot()", () => {
  const t = loadTranscripts().find((x) => x.id === "boot-cold-register")!;

  it("discovery, the keyless registration, trust, the config document and the report, then ready", async () => {
    const server = new ReplayServer(t);
    let record: OfflineRecord | null = { deviceId: t.initial.deviceId };
    const store = memoryStore(t.product, {
      read: async () => record,
      write: async (_p, r) => {
        record = r;
      },
    });
    const adapter = browserAdapter({
      productSlug: t.product,
      baseUrl: t.baseUrl,
      version: t.initial.version,
      auth: "bearer",
      trust: { pinnedKeys: t.trust },
      expectServices: servicesFromList(t.initial.services as never),
      store,
      offlineStore: null,
      fetchImpl: server.fetch as typeof fetch,
      fingerprint: () => ({
        components: { machineUuid: "REPLAYmachineUuid00000" },
        hwid: "REPLAYhwid0000000000000000000000",
      }),
      now: () => t.now,
      autoStart: false,
    });
    server.beginStep(0);
    const seen: BootState["stage"][] = [];
    const r = await adapter.boot({
      onStage: (s) => {
        seen.push(s.state.stage);
      },
    });
    server.endStep();
    expect(r.outcome).toBe(t.steps[0]!.expect.bootOutcome);
    expect(r.status).toBe(t.steps[0]!.expect.licenseStatus);
    expect(adapter.snapshot().status).toBe("not-applicable");
    expect(await store.getToken()).not.toBeNull();
    expect(seen).toEqual([
      "shell",
      "guard",
      "sync",
      "gate",
      "decide",
      "fetch",
      "mount",
      "ready",
    ]);
    adapter.dispose();
  });
});

describe("the desktop adapter's boot()", () => {
  it("forwards to the host's client.boot() over bridge v4, then re-reads the host state", async () => {
    const calls: unknown[] = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 4,
      invoke: async (service: string, method: string, args?: unknown) => {
        calls.push({ service, method, args });
        bridge.push(okBridgeState());
        return {
          outcome: "ready",
          state: { stage: "ready", outcome: "ready" },
          license: { status: "ok" },
          decision: null,
          guard: null,
          emits: [{ type: "boot_ready" }],
        };
      },
    };
    const adapter = desktopAdapter({ bridge, now: () => NOW_SEC });
    const steps: unknown[] = [];
    const r = await adapter.boot({
      consent: "never",
      requiredPacks: ["core"],
      onStage: (s) => steps.push(s.emits),
      answer: async () => true,
    });
    // Callbacks stay in the renderer; the bag that crosses is serialisable.
    expect(calls).toEqual([
      {
        service: "core",
        method: "boot",
        args: { consent: "never", requiredPacks: ["core"] },
      },
    ]);
    expect(r.outcome).toBe("ready");
    expect(r.status).toBe("ok");
    expect(r.emits).toEqual([{ type: "boot_ready" }]);
    expect(steps).toEqual([[{ type: "boot_ready" }]]);
    expect(adapter.snapshot().status).toBe("ok");
    adapter.dispose();
  });

  it("a v3 host gets the typed version N/A, with nothing sent", async () => {
    const calls: unknown[] = [];
    const bridge = {
      ...makeFakeBridge(emptyBridgeState()),
      version: 3,
      invoke: async (...a: unknown[]) => {
        calls.push(a);
        return null;
      },
    };
    const adapter = desktopAdapter({ bridge });
    const err = await adapter.boot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({ feature: "ui.boot", reason: "version" });
    expect(calls).toEqual([]);
    expect(adapter.supports("ui.boot")).toMatchObject({
      supported: false,
      reason: "version",
    });
    adapter.dispose();
  });
});

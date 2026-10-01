// @pkey-feature ui.stages
// The unit properties of the boot stage machine that the corpus cannot express. The rows of
// `conformance/corpus/v2/stage-matrix.json` and the probes of its `accepts` table run in the
// Node runner (`conformance/runners/node/stageMatrix.test.ts`), as the bundle cases do; this
// suite pins purity, identity on an ignored event, malformed events, the defaults, and that
// the gate's pass set is `isUsable`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LicenseStatus } from "@polaris-key/protocol/license";
import { isUsable } from "../src/gate.js";
import {
  MAX_FAILED_BOOTS,
  bootGuardAction,
  bootTransition,
  initialBootState,
  type BootEvent,
  type BootOptions,
  type BootState,
} from "../src/stages.js";

const here = dirname(fileURLToPath(import.meta.url));

const STATUSES: readonly LicenseStatus[] = [
  "ok",
  "grace",
  "expired",
  "revoked",
  "needs-activation",
  "version-too-old",
  "version-too-new",
  "channel-not-entitled",
  "not-applicable",
];

function run(events: readonly BootEvent[], options?: BootOptions): BootState {
  let state = initialBootState(options);
  for (const event of events) state = bootTransition(state, event).state;
  return state;
}

const TO_GATE: readonly BootEvent[] = [
  { type: "start" },
  { type: "shell.done" },
  { type: "guard.done", result: "ok" },
  { type: "sync.done", result: "ok" },
];

const TO_FETCH: readonly BootEvent[] = [
  ...TO_GATE,
  { type: "gate.status", status: "ok" },
  { type: "decide.done", decision: "none" },
];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe("stages — purity", () => {
  it("never mutates its input and returns equal results for equal inputs", () => {
    const state = deepFreeze(run(TO_GATE, { requiredPacks: ["core"] }));
    const event = deepFreeze<BootEvent>({
      type: "gate.status",
      status: "needs-activation",
    });
    const snapshot = JSON.stringify(state);
    const first = bootTransition(state, event);
    const second = bootTransition(state, event);
    expect(second).toEqual(first);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(first.state).not.toBe(state);
  });

  it("returns equal guard decisions for equal inputs", () => {
    const input = deepFreeze({ staged: true, failedBoots: 1 });
    expect(bootGuardAction(input)).toBe(bootGuardAction(input));
  });

  it("copies requiredPacks, so the caller's array cannot change a running boot", () => {
    const packs = ["core"];
    const state = initialBootState({ requiredPacks: packs });
    packs.push("extra");
    expect(state.options.requiredPacks).toEqual(["core"]);
  });

  it("reads no clock, randomness, timer, network or crypto, and imports only types", () => {
    const source = readFileSync(join(here, "..", "src", "stages.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const banned of [
      /\bDate\b/,
      /\bMath\.random\b/,
      /\bperformance\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bsetImmediate\b/,
      /\bqueueMicrotask\b/,
      /\bfetch\s*\(/,
      /\bcrypto\b/,
      /\bprocess\b/,
    ])
      expect(code).not.toMatch(banned);
    const imports = code.match(/^\s*import\b.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });
});

describe("stages — an ignored event returns the input object itself", () => {
  it("a late sync.timeout in the gate", () => {
    const state = run(TO_GATE);
    const result = bootTransition(state, { type: "sync.timeout" });
    expect(result.state).toBe(state);
    expect(result.emits).toEqual([]);
  });

  it("play-offline in offline, retry while running, fail after ready", () => {
    const offline = run(
      TO_GATE.slice(0, 3).concat([{ type: "sync.timeout" }]),
      {
        allowOffline: false,
      },
    );
    expect(offline.stage).toBe("offline");
    expect(bootTransition(offline, { type: "play-offline" }).state).toBe(
      offline,
    );

    const gate = run(TO_GATE);
    expect(bootTransition(gate, { type: "retry" }).state).toBe(gate);

    const ready = run([
      ...TO_FETCH,
      { type: "fetch.done", result: "ok", installed: [] },
      { type: "mount.done" },
    ]);
    expect(ready.stage).toBe("ready");
    const late = bootTransition(ready, { type: "fail", code: "late" });
    expect(late.state).toBe(ready);
    expect(late.emits).toEqual([]);
  });
});

describe("stages — malformed events are ignored", () => {
  const cases: Array<[string, readonly BootEvent[], unknown]> = [
    ["an unknown type", [], { type: "launch" }],
    ["a missing type", [], {}],
    ["a non-object event", [], "start"],
    ["a null event", [], null],
    [
      "an unknown guard result",
      TO_GATE.slice(0, 2),
      { type: "guard.done", result: "maybe" },
    ],
    ["a missing guard result", TO_GATE.slice(0, 2), { type: "guard.done" }],
    [
      "an unknown sync result",
      TO_GATE.slice(0, 3),
      { type: "sync.done", result: "timeout" },
    ],
    ["a missing sync result", TO_GATE.slice(0, 3), { type: "sync.done" }],
    [
      "an unknown gate status",
      TO_GATE,
      { type: "gate.status", status: "valid" },
    ],
    [
      "a wrongly typed gate status",
      TO_GATE,
      { type: "gate.status", status: 1 },
    ],
    [
      "an unknown decision",
      TO_FETCH.slice(0, -1),
      { type: "decide.done", decision: "maybe" },
    ],
    ["a missing decision", TO_FETCH.slice(0, -1), { type: "decide.done" }],
    [
      "an unknown fetch result",
      TO_FETCH,
      { type: "fetch.done", result: "partial", installed: [] },
    ],
    [
      "a missing installed list",
      TO_FETCH,
      { type: "fetch.done", result: "ok" },
    ],
    [
      "installed not a list",
      TO_FETCH,
      { type: "fetch.done", result: "ok", installed: "core" },
    ],
    [
      "installed holding a non-string",
      TO_FETCH,
      { type: "fetch.done", result: "ok", installed: [1] },
    ],
    ["a missing fail code", TO_GATE, { type: "fail" }],
    ["a wrongly typed fail code", TO_GATE, { type: "fail", code: 500 }],
  ];

  for (const [name, prefix, event] of cases) {
    it(name, () => {
      const state = run(prefix);
      const result = bootTransition(state, event as BootEvent);
      expect(result.state).toBe(state);
      expect(result.emits).toEqual([]);
    });
  }

  it("an event with an extra key is accepted", () => {
    const state = run(TO_GATE.slice(0, 3));
    const result = bootTransition(state, {
      type: "sync.done",
      result: "ok",
      attempt: 2,
    } as BootEvent);
    expect(result.state.stage).toBe("gate");
    expect(result.emits).toEqual([
      { type: "stage_changed", stage: "gate", previous: "sync" },
    ]);
  });
});

describe("stages — defaults", () => {
  it("starts idle and running, with nothing synced and retry resuming at the shell", () => {
    expect(initialBootState()).toEqual({
      stage: "idle",
      outcome: "running",
      options: { allowOffline: true, allowGrace: true, requiredPacks: [] },
      sync: "pending",
      resume: "shell",
    });
    expect(initialBootState({})).toEqual(initialBootState());
  });

  it("keeps the options it is given", () => {
    expect(
      initialBootState({
        allowOffline: false,
        allowGrace: false,
        requiredPacks: ["core"],
      }).options,
    ).toEqual({
      allowOffline: false,
      allowGrace: false,
      requiredPacks: ["core"],
    });
  });

  it("moves resume to guard on shell.done and to sync on guard.done", () => {
    expect(run(TO_GATE.slice(0, 2)).resume).toBe("guard");
    expect(run(TO_GATE.slice(0, 3)).resume).toBe("sync");
  });

  it("resets sync to pending on retry", () => {
    const blocked = run([
      ...TO_GATE,
      { type: "gate.status", status: "version-too-old" },
    ]);
    expect(blocked.sync).toBe("ok");
    const retried = bootTransition(blocked, { type: "retry" }).state;
    expect(retried.stage).toBe("sync");
    expect(retried.sync).toBe("pending");
  });

  it("rolls back at MAX_FAILED_BOOTS", () => {
    expect(MAX_FAILED_BOOTS).toBe(2);
    expect(
      bootGuardAction({ staged: true, failedBoots: MAX_FAILED_BOOTS - 1 }),
    ).toBe("apply-staged");
    expect(
      bootGuardAction({ staged: true, failedBoots: MAX_FAILED_BOOTS }),
    ).toBe("roll-back");
  });
});

describe("stages — the gate's pass set is isUsable", () => {
  for (const sync of ["ok", "offline", "error"] as const) {
    it(`after sync ${sync}`, () => {
      const atGate = run(
        TO_GATE.slice(0, 3).concat([{ type: "sync.done", result: sync }]),
      );
      expect(atGate.stage).toBe("gate");
      for (const status of STATUSES) {
        const next = bootTransition(atGate, { type: "gate.status", status });
        expect(next.state.stage === "decide", status).toBe(isUsable(status));
      }
    });
  }
});

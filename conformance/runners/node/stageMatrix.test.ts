// @pkey-feature ui.stages packs.state update.bootguard
// The Node conformance runner for `conformance/corpus/v2/stage-matrix.json`: the boot stage
// machine of `@polaris-key/client-core/stages`. It covers React too, since both JS SDKs drive
// the same `client-core`. The Python (`sdks/python/tests/test_stage_matrix.py`) and Swift
// (`StageMatrixTests.swift`) runners mirror this file against the same rows.
//
// For every row it asserts each step's emits (as values), the stage sequence built from the
// actual `stage_changed` emits, the final stage and the outcome. At the row's initial state and
// after every step it also sends every probe and asserts that the state comes back unchanged
// with no emits exactly when the probe's type is not in `accepts` for that state. Probe results
// are discarded; the row continues from its own steps.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOOT_CONFIRMATIONS,
  BOOT_OK_SECONDS,
  bootConfirmation,
  BOOT_EMIT_TYPES,
  BOOT_EVENT_TYPES,
  BOOT_GUARD_ACTIONS,
  BOOT_OUTCOMES,
  BOOT_STAGES,
  MAX_FAILED_BOOTS,
  bootGuardAction,
  bootTransition,
  initialBootState,
  type BootEmit,
  type BootEvent,
  type BootOptions,
  type BootState,
} from "@polaris-key/client-core/stages";

interface StageMatrix {
  stageMatrixVersion: number;
  maxFailedBoots: number;
  bootOkSeconds: number;
  vocabulary: {
    stages: string[];
    outcomes: string[];
    events: string[];
    emits: string[];
    guardActions: string[];
    confirmations: string[];
  };
  accepts: Record<string, string[]>;
  probes: BootEvent[];
  rows: Array<{
    name: string;
    init: BootOptions;
    steps: Array<{ event: BootEvent; emits: BootEmit[] }>;
    expect: { stages: string[]; outcome: string };
  }>;
  guardCases: Array<{
    name: string;
    input: { staged: boolean; failedBoots: number };
    expect: { action: string };
  }>;
  confirmCases: Array<{ outcome: string; expect: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "stage-matrix.json"),
    "utf8",
  ),
) as StageMatrix;

/** The `accepts` key of a state: `gate:waiting` while the gate waits, `fetch:waiting` while
 *  the fetch waits for consent, `offline:playable` at a playable offline stop (v3), otherwise
 *  the stage. */
function acceptsKey(state: BootState): string {
  if (state.stage === "gate" && state.outcome === "waiting")
    return "gate:waiting";
  if (state.stage === "fetch" && state.outcome === "waiting")
    return "fetch:waiting";
  if (state.stage === "offline" && state.canPlayOffline)
    return "offline:playable";
  return state.stage;
}

/** Sends every probe from `state` and returns how many it sent. */
function probe(state: BootState, where: string): number {
  const accepted = matrix.accepts[acceptsKey(state)];
  expect(
    accepted,
    `${where}: accepts has no ${acceptsKey(state)}`,
  ).toBeDefined();
  for (const event of matrix.probes) {
    const result = bootTransition(state, event);
    const ignored =
      result.emits.length === 0 &&
      JSON.stringify(result.state) === JSON.stringify(state);
    expect(
      ignored,
      `${where}: probe ${event.type} in ${acceptsKey(state)}`,
    ).toBe(!accepted!.includes(event.type));
  }
  return matrix.probes.length;
}

describe(`stage-matrix v${matrix.stageMatrixVersion} (the boot stage machine)`, () => {
  it(`runs on Node ${process.version}`, () => {
    expect(matrix.stageMatrixVersion).toBe(3);
    expect(matrix.maxFailedBoots).toBe(MAX_FAILED_BOOTS);
    expect(matrix.bootOkSeconds).toBe(BOOT_OK_SECONDS);
  });

  it("has the vocabulary of @polaris-key/client-core/stages, in order", () => {
    expect(matrix.vocabulary).toEqual({
      stages: [...BOOT_STAGES],
      outcomes: [...BOOT_OUTCOMES],
      events: [...BOOT_EVENT_TYPES],
      emits: [...BOOT_EMIT_TYPES],
      guardActions: [...BOOT_GUARD_ACTIONS],
      confirmations: [...BOOT_CONFIRMATIONS],
    });
  });

  it("has one probe per event type, in vocabulary order", () => {
    expect(matrix.probes.map((p) => p.type)).toEqual(matrix.vocabulary.events);
  });

  let probes = 0;
  for (const row of matrix.rows) {
    it(row.name, () => {
      let state = initialBootState(row.init);
      const stages: string[] = [];
      probes += probe(state, `${row.name}, initial state`);
      for (const [i, step] of row.steps.entries()) {
        const where = `${row.name}, step ${i + 1} (${step.event.type})`;
        const result = bootTransition(state, step.event);
        expect(result.emits, where).toEqual(step.emits);
        for (const emit of result.emits)
          if (emit.type === "stage_changed") stages.push(emit.stage);
        state = result.state;
        // v3: canPlayOffline is true exactly at an offline stop whose emit said so.
        const off = result.emits.find((e) => e.type === "offline");
        if (off) expect(state.canPlayOffline, where).toBe(off.canPlayOffline);
        else if (result.emits.length > 0)
          expect(state.canPlayOffline, where).toBe(false);
        probes += probe(state, `${where}, after`);
      }
      expect(stages).toEqual(row.expect.stages);
      expect(state.stage).toBe(row.expect.stages.at(-1));
      expect(state.outcome).toBe(row.expect.outcome);
    });
  }

  it("sent every probe at every state the rows reach", () => {
    const states = matrix.rows.reduce((n, r) => n + r.steps.length + 1, 0);
    expect(probes).toBe(states * matrix.probes.length);
  });

  for (const c of matrix.guardCases) {
    it(`guard: ${c.name}`, () => {
      expect(bootGuardAction(c.input)).toBe(c.expect.action);
    });
  }

  // Version 2 (plans/P3-01.md §2.10): boot confirmation, one case per outcome.
  it("has one confirm case per outcome", () => {
    expect(matrix.confirmCases.map((c) => c.outcome).sort()).toEqual(
      [...BOOT_OUTCOMES].sort(),
    );
  });
  for (const c of matrix.confirmCases) {
    it(`confirm: ${c.outcome} → ${c.expect}`, () => {
      expect(
        bootConfirmation(c.outcome as (typeof BOOT_OUTCOMES)[number]),
      ).toBe(c.expect);
    });
  }
});

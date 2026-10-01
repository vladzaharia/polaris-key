// @pkey-feature ui.stages
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
  vocabulary: {
    stages: string[];
    outcomes: string[];
    events: string[];
    emits: string[];
    guardActions: string[];
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
}

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(here, "..", "..", "corpus", "v2", "stage-matrix.json"),
    "utf8",
  ),
) as StageMatrix;

/** The `accepts` key of a state: `gate:waiting` while the gate waits, otherwise the stage. */
function acceptsKey(state: BootState): string {
  return state.stage === "gate" && state.outcome === "waiting"
    ? "gate:waiting"
    : state.stage;
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
    expect(matrix.stageMatrixVersion).toBe(1);
    expect(matrix.maxFailedBoots).toBe(MAX_FAILED_BOOTS);
  });

  it("has the vocabulary of @polaris-key/client-core/stages, in order", () => {
    expect(matrix.vocabulary).toEqual({
      stages: [...BOOT_STAGES],
      outcomes: [...BOOT_OUTCOMES],
      events: [...BOOT_EVENT_TYPES],
      emits: [...BOOT_EMIT_TYPES],
      guardActions: [...BOOT_GUARD_ACTIONS],
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
});

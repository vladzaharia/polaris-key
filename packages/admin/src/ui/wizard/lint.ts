import { MAX_FLOW_STEPS, type FlowDef } from "./model.js";

/**
 * Flow lint (ST-39; SETUP.md §1.1 and §1.13). A flow is data, so its rules are checked on the data:
 *
 *   - at most `max` steps before Done (5 unless the flow is listed in `EXEMPT`);
 *   - ids are unique kebab-case words; labels are what the operator does, never "Step 3";
 *   - a Done step is last and there is at most one;
 *   - a `wait` step follows the step that produces its fact, never opens the flow.
 *
 * Returns readable problems; an empty list is a pass. `test/wizardKit.test.ts` runs it over every
 * flow in `console/wizard/flows.ts` and over fixtures that must each fail.
 */
export function lintFlow(
  flow: FlowDef,
  max: number = MAX_FLOW_STEPS,
): string[] {
  const out: string[] = [];
  const at = `flow ${flow.id}`;
  const humanSteps = flow.steps.filter((s) => s.kind !== "done");
  if (flow.steps.length === 0) out.push(`${at}: no steps`);
  if (humanSteps.length > max)
    out.push(
      `${at}: ${humanSteps.length} steps before Done (at most ${max}): split it into two wizards`,
    );
  const seen = new Set<string>();
  for (const s of flow.steps) {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(s.id))
      out.push(`${at}: step id "${s.id}" is not kebab-case`);
    if (seen.has(s.id)) out.push(`${at}: step id "${s.id}" is repeated`);
    seen.add(s.id);
    if (s.label.trim() === "" || /^step\s*\d+$/i.test(s.label.trim()))
      out.push(
        `${at}: step "${s.id}" is named "${s.label}": name what the operator does`,
      );
  }
  const dones = flow.steps
    .map((s, i) => (s.kind === "done" ? i : -1))
    .filter((i) => i >= 0);
  if (dones.length > 1) out.push(`${at}: more than one Done step`);
  if (dones.length === 1 && dones[0] !== flow.steps.length - 1)
    out.push(`${at}: the Done step is not last`);
  if (flow.steps[0]?.kind === "wait")
    out.push(
      `${at}: opens with a wait: put the step that produces the fact first`,
    );
  return out;
}

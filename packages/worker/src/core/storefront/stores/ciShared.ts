/**
 * Helpers the CI-plane adapters (`itch.ts`, `snap.ts`) share: how an op is declared, and the
 * ledger projection of a reported CI step (A-18h). Pure data.
 */

import type { Support } from "../../adapters/contract.js";
import type { CiPlaneStore } from "../ciPlane.js";

export const ciOp = (store: CiPlaneStore, ...commands: string[]): Support => ({
  mode: "ci",
  plane: "ci",
  tool: store.list.tool,
  commands,
});

export const unsupported = (reason: string): Support => ({
  mode: "unsupported",
  reason,
});

export const linkOp = (id: string): Support => ({
  mode: "deep-link",
  link: id,
  verify: "operator-assertion",
});

/**
 * A CI step's row keeps the tool, the command id, its argv (allow-listed values only: paths,
 * versions, identity values; credentials reach the tools through the environment, never argv) and
 * the exit code (`services/distribution/storeSteps.ts`).
 */
export const CI_STEP_PROJECTION: Readonly<Record<string, readonly string[]>> = {
  "ci-step": ["tool", "command", "argv", "exitCode", "runUrl"],
};

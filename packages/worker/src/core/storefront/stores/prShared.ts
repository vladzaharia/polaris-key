/**
 * Helpers the PR-plane adapters (`winget.ts`, `homebrew.ts`, `scoop.ts`, `flathub.ts`) share: how
 * an op is declared, and the ledger projection of a reported PR step (A-18i). Pure data.
 */

import type { Support } from "../../adapters/contract.js";
import type { PrPlaneStore } from "../prPlane.js";

/** An op the store's PR plane performs: a pull request (or its verifier) on the store's repo. */
export const prOp = (store: PrPlaneStore): Support => ({
  mode: "pr",
  plane: "pr",
  repo: store.repo,
});

/**
 * A PR step's row keeps the command and its argv (allow-listed values only: the repository, the
 * package and the version), the files the PR wrote (path and SHA-256 of the content, never the
 * content), the pull request (number, URL, state, labels) and the verifier's verdict
 * (`services/distribution/storeSteps.ts`). Credentials never leave CI.
 */
export const PR_STEP_PROJECTION: Readonly<Record<string, readonly string[]>> = {
  "pr-step": [
    "tool",
    "command",
    "argv",
    "repo",
    "files",
    "pr",
    "verdict",
    "existing",
    "exitCode",
    "runUrl",
  ],
};

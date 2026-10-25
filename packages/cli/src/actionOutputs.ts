/**
 * The Action's outputs (`release-id`, `outcome`) into `$GITHUB_OUTPUT`: written by
 * `pkey release publish` itself when the variable is set (A-25.5, D-A7), so the Action and a
 * `run:` step see the same outputs.
 */

import { appendFile } from "node:fs/promises";
import type { CiEnv } from "./oidc.js";

/** An outcome as the Worker answers one (`created`, `enriched`, `unchanged`, …). */
export const OUTCOME_RE = /^[a-z][a-z_-]{0,63}$/;

/**
 * A release id as it is minted (`descriptorReleaseId`: the tag, else `<deliverable>@<version>`):
 * the descriptor's tag shape, 1–255 characters with no whitespace and no control or format
 * character, so it can never end the `name=value` line or start another.
 */
export const RELEASE_ID_RE = /^[^\s\p{Cc}\p{Cf}]{1,255}$/u;

/**
 * `release-id` and `outcome` into `$GITHUB_OUTPUT`, each only when it has the shape the Worker
 * gives it, else empty: `outcome` is the server's word, and a value with a line break in it
 * would write an output (or an environment file line) of its own.
 */
export async function writeOutputs(
  io: { env: CiEnv },
  releaseId: string,
  server: Record<string, unknown> | undefined,
): Promise<void> {
  const outputFile = io.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const id = RELEASE_ID_RE.test(releaseId) ? releaseId : "";
  const outcome =
    typeof server?.outcome === "string" && OUTCOME_RE.test(server.outcome)
      ? server.outcome
      : "";
  await appendFile(
    outputFile,
    `release-id=${id}\noutcome=${outcome}\n`,
    "utf8",
  );
}

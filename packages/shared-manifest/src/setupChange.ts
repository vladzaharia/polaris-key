/**
 * A-32.4: the one file change `pkey/setup` carries (the setup pull request, A-32.5), composed
 * purely from the repository's current `.pkey/` text. Outlets go through `insertOutletBlock`
 * (the same insert `pkey channel add` uses) and the workflow through `renderCiWorkflow`; the
 * result is validated as a whole before it is returned, so an invalid change never leaves here.
 */

import YAML from "yaml";
import { renderCiWorkflow, type CiWorkflowPack } from "./ciWorkflow.js";
import {
  validateIngestDocuments,
  type IngestDocuments,
  type ValidationMessage,
} from "./index.js";
import {
  OutletInsertError,
  insertOutletBlock,
  outletBlockEntry,
} from "./outletBlock.js";

/** Where a new `.pkey/distribution` goes when the repository has none. */
export const DISTRIBUTION_PATH = ".pkey/distribution.yaml";
/** Where the release workflow goes. */
export const WORKFLOW_PATH = ".github/workflows/release.yml";

export interface SetupOutlet {
  /** The catalogue channel id (`itch`, `steam`, …). */
  channel: string;
  /** The channel's identity fields, by name. */
  identity?: Readonly<Record<string, unknown>>;
  /** The outlet id. Default: the channel id. */
  outletId?: string;
}

export interface SetupWorkflow {
  /** What follows `@` on the Action: a full commit SHA (the Worker passes `PKEY_GIT_SHA`). */
  actionRef: string;
  /** The release channel the tag publishes to. */
  channel: string;
  /** Where the build leaves the app's files. Default `dist`. */
  dir?: string;
  packs?: readonly CiWorkflowPack[];
}

export interface SetupChangeInput {
  /** The parsed `.pkey/` documents on the default branch. */
  documents: IngestDocuments;
  /** The repository's distribution file (repo path and text), or null when it has none. */
  distribution: { path: string; text: string } | null;
  outlets: readonly SetupOutlet[];
  workflow?: SetupWorkflow;
}

export interface SetupChange {
  /** Every file the change writes, whole, in write order. */
  files: { path: string; text: string }[];
  summary: { outlets: string[]; workflow: boolean };
}

export type SetupChangeErrorCode =
  | "nothing"
  | "invalid_file"
  | "duplicate_outlet"
  | "invalid";

/** The change cannot be composed; nothing is returned. `errors` holds the validator's findings. */
export class SetupChangeError extends Error {
  override name = "SetupChangeError";
  constructor(
    readonly code: SetupChangeErrorCode,
    message: string,
    readonly errors: readonly ValidationMessage[] = [],
  ) {
    super(message);
  }
}

export function composeSetupChange(input: SetupChangeInput): SetupChange {
  const { documents, outlets, workflow } = input;
  if (outlets.length === 0 && !workflow)
    throw new SetupChangeError("nothing", "There is nothing to change.");

  const files: { path: string; text: string }[] = [];
  const added: string[] = [];
  let nextDistribution: unknown = documents.distribution;

  if (outlets.length > 0) {
    const path = input.distribution?.path ?? DISTRIBUTION_PATH;
    const format = path.endsWith(".json") ? "json" : "yaml";
    let text = input.distribution?.text ?? "";
    try {
      for (const o of outlets) {
        const block = outletBlockEntry(o.channel, o.identity ?? {}, {
          outletId: o.outletId,
        });
        text = insertOutletBlock(text, format, block);
        added.push(block.id);
      }
    } catch (e) {
      if (e instanceof OutletInsertError)
        throw new SetupChangeError(
          /already declares/.test(e.message)
            ? "duplicate_outlet"
            : "invalid_file",
          e.message,
        );
      throw new SetupChangeError(
        "invalid",
        e instanceof Error ? e.message : String(e),
      );
    }
    files.push({ path, text });
    nextDistribution = format === "json" ? JSON.parse(text) : YAML.parse(text);
  }

  if (workflow) {
    const product = documents.product?.slug;
    if (typeof product !== "string")
      throw new SetupChangeError("invalid", ".pkey/product has no slug.");
    // `.pkey/release` is a document with one top-level `release:` mapping.
    const release = (
      documents.release as { release?: { releaseKeys?: unknown } } | undefined
    )?.release;
    try {
      files.push({
        path: WORKFLOW_PATH,
        text: renderCiWorkflow({
          product,
          channel: workflow.channel,
          actionRef: workflow.actionRef,
          dir: workflow.dir,
          packs: workflow.packs,
          releaseKeys:
            Array.isArray(release?.releaseKeys) &&
            release.releaseKeys.length > 0,
        }),
      });
    } catch (e) {
      throw new SetupChangeError(
        "invalid",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  const result = validateIngestDocuments({
    ...documents,
    distribution: nextDistribution,
  });
  if (!result.ok)
    throw new SetupChangeError(
      "invalid",
      `The change leaves .pkey/ invalid: ${result.errors[0]!.message}`,
      result.errors,
    );
  return {
    files,
    summary: { outlets: added, workflow: workflow !== undefined },
  };
}

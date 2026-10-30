/**
 * Create a product from documents, with no repository (plans/P0-26.md D8; ST-43). The console's
 * "From scratch" path builds the `.pkey/` documents a manual create implies (the name and slug,
 * the catalog if one was uploaded, the licence defaults if the caller set them) and hands them to
 * the one pipeline in `create` mode, so a manual product is written by the same code, checks and
 * batch as a linked one. The snapshot origin is `link` with `applied_sha` NULL; there is no
 * release coordinate, and a declared `trustedPublisher` is refused (nothing to pin it to).
 */

import { parseManifest } from "@polaris-key/manifest";
import { displayNameOptions } from "../accounts/reservedDisplayNames.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import type { CreateChoices } from "../products/createDefaults.js";
import type { Ingest, IngestFail, IngestOk } from "./types.js";

export interface DocumentsCreate {
  slug: string;
  name: string;
  /** A `.pkey/schema` document (or its parsed object); absent: the empty catalog. */
  schema?: unknown;
  /** The licence defaults the old manual create took; absent: 30 days and 5 devices. */
  defaultMaxOfflineDays?: number;
  defaultDeviceLimit?: number;
  /** The signing key's kid; absent: `<slug>-<year>`. */
  kid?: string;
  choices: CreateChoices;
  author: string;
  now: number;
}

/** A refusal before the pipeline ran: the documents did not parse. */
export interface DocumentsRefusal {
  ok: false;
  error: string;
  errors: string[];
  status: 422;
}

export async function createFromDocuments(
  env: Env,
  db: Db,
  ingest: Ingest,
  input: DocumentsCreate,
): Promise<IngestOk | IngestFail | DocumentsRefusal> {
  const files: Record<string, string> = {
    ".pkey/product.json": JSON.stringify({
      slug: input.slug,
      name: input.name,
      compatMin: "0.0.0",
      compatMax: "99.0.0",
      defaultMaxOfflineDays: input.defaultMaxOfflineDays ?? 30,
      defaultDeviceLimit: input.defaultDeviceLimit ?? 5,
    }),
    ".pkey/schema.json":
      typeof input.schema === "string"
        ? input.schema
        : JSON.stringify(input.schema ?? { schemaVersion: 1, entries: [] }),
  };
  // `parseManifest` keys the documents by name; the snapshot keeps them by path.
  // The platform's display-name policy; a product not yet created has no approval to read.
  const parsed = parseManifest(
    {
      product: files[".pkey/product.json"]!,
      schema: files[".pkey/schema.json"]!,
    },
    { ...(await displayNameOptions(env, db)) },
  );
  if (!parsed.ok)
    return {
      ok: false,
      error: "invalid manifest",
      errors: parsed.errors,
      status: 422,
    };
  return ingest.run(env, db, {
    mode: "create",
    product: input.slug,
    manifest: parsed.manifest,
    now: input.now,
    source: {
      origin: "link",
      sha: null,
      files,
      fetchImpl: async () => new Response("no repository", { status: 404 }),
    },
    create: {
      choices: input.choices,
      author: input.author,
      ...(input.kid ? { kid: input.kid } : {}),
    },
  });
}

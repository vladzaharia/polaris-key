/**
 * The Snap Store's CI-plane command plan (A-18h; notes/S-15 §4.4):
 *
 *   pkey storefront snap metadata     the listing model's Snap projection (A-18b) → `summary` and
 *                                     `description` in snapcraft.yaml, BEFORE the snap is built
 *                                     (upload-metadata reads them from the snap itself)
 *   snapcraft upload <snap> --release=<channels>
 *                                     only to snap channels the outlet identity maps the release
 *                                     channels onto (`.pkey/distribution` `snap.channels`)
 *   snapcraft upload-metadata <snap>  the summary, description and icon the snap carries
 *
 * snapcraft reads its credential from `SNAPCRAFT_STORE_CREDENTIALS`: a scoped, expiring
 * `snapcraft export-login --snaps <name> --channels <…> --acls package_push,package_release
 * --expires <date>`, held as a CI environment secret. Title, screenshots and banner stay in the
 * Snap Store dashboard.
 */

import { effectiveTrackMap } from "@polaris-key/manifest";
import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ciClient, type Out, type Sleep } from "../ci.js";
import { resolveCiToken, type CiEnv } from "../oidc.js";
import { untrusted } from "../untrusted.js";
import { ciStore } from "./allowList.js";
import type { StepOutlet } from "./outlets.js";
import type { StoreStep } from "./run.js";

export interface SnapUploadOptions {
  outlet: StepOutlet;
  /** The built `.snap`. */
  snap: string;
  /** Declared release channels (`stable`, `beta`); each must be mapped by the identity. */
  channels: readonly string[];
}

/** The snap channels the identity maps `channels` onto, in order, without repeats. */
export function snapReleaseChannels(
  outlet: StepOutlet,
  channels: readonly string[],
): string[] {
  const declared = outlet.identity.channels;
  const map = effectiveTrackMap(
    "snap",
    declared && typeof declared === "object" && !Array.isArray(declared)
      ? (declared as Record<string, string>)
      : undefined,
  );
  if (channels.length === 0)
    throw new Error(
      "--channel is required: the release channel(s) to release to.",
    );
  const out: string[] = [];
  for (const c of channels) {
    const snapChannel = (map as Record<string, unknown>)[c];
    if (typeof snapChannel !== "string")
      throw new Error(
        `outlet ${outlet.id} maps no snap channel for ${c} (channels: ${Object.keys(map).join(", ") || "none"}).`,
      );
    if (!out.includes(snapChannel)) out.push(snapChannel);
  }
  return out;
}

export function snapUploadStep(o: SnapUploadOptions): StoreStep {
  const store = ciStore("snap")!;
  return {
    store: "snap",
    op: "uploadBuild",
    command: "upload",
    tool: store.list.tool,
    argv: [
      "upload",
      o.snap,
      `--release=${snapReleaseChannels(o.outlet, o.channels).join(",")}`,
    ],
    outlet: o.outlet,
  };
}

export function snapUploadMetadataStep(snap: string): StoreStep {
  const store = ciStore("snap")!;
  return {
    store: "snap",
    op: "writeListingText",
    command: "upload-metadata",
    tool: store.list.tool,
    argv: ["upload-metadata", snap],
  };
}

/** What `GET /<p>/distribution/listing/snap` answers (`listing/ci.ts`). */
export interface SnapProjection {
  store: string;
  exists: boolean;
  defaultLocale: string;
  status: "green" | "amber" | "red";
  payload: {
    app: Record<string, unknown>;
    locales: Record<string, Record<string, unknown>>;
  } | null;
  issues: { field: string; locale: string | null; issue: string }[];
}

/** The summary and description the snap carries, from the projection's default locale. */
export function snapMetadataFields(p: SnapProjection): {
  summary: string;
  description: string;
} {
  if (!p.payload) {
    const blocking = p.issues
      .map((i) => `${i.field}${i.locale ? ` (${i.locale})` : ""}: ${i.issue}`)
      .join("; ");
    throw new Error(
      `The listing's Snap projection is blocked${p.exists ? "" : " (the product has no listing yet)"}: ${blocking || "fix it in the console's Listing editor"}.`,
    );
  }
  const locale = p.payload.locales[p.defaultLocale] ?? {};
  const summary = locale.summary;
  const description = locale.description;
  if (typeof summary !== "string" || typeof description !== "string")
    throw new Error(
      `The listing's Snap projection has no ${typeof summary !== "string" ? "summary" : "description"} in its default locale ${p.defaultLocale}.`,
    );
  return { summary, description };
}

/**
 * snapcraft.yaml with `summary` and `description` replaced, comments and the rest of the document
 * kept. The description is written as a literal block.
 */
export function applySnapMetadata(
  yamlText: string,
  fields: { summary: string; description: string },
): string {
  const doc = parseDocument(yamlText);
  if (doc.errors.length)
    throw new Error(`snapcraft.yaml does not parse: ${doc.errors[0]!.message}`);
  if (!doc.contents || typeof doc.get !== "function" || !doc.has("name"))
    throw new Error(
      "snapcraft.yaml has no top-level name: is this a snapcraft.yaml?",
    );
  doc.set("summary", fields.summary);
  const description = doc.createNode(fields.description.replace(/\r\n/g, "\n"));
  (description as { type?: string }).type = "BLOCK_LITERAL";
  doc.set("description", description);
  return doc.toString();
}

export interface SnapMetadataOptions {
  /** The snapcraft.yaml to update. */
  yamlPath: string;
  product: string;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  dryRun?: boolean;
}

/** `pkey storefront snap metadata`: fetch the Snap projection and write it into snapcraft.yaml. */
export async function writeSnapMetadata(o: SnapMetadataOptions): Promise<{
  summary: string;
  description: string;
}> {
  const token = await resolveCiToken({
    baseUrl: o.baseUrl,
    product: o.product,
    env: o.env,
    out: o.stdout,
    log: o.stderr,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
  });
  const client = ciClient({
    baseUrl: o.baseUrl,
    product: o.product,
    token,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    log: o.stderr,
    env: o.env,
  });
  const body = await client.getJson<{ listing: SnapProjection }>(
    "distribution/listing/snap",
    { what: "Reading the listing's Snap projection" },
  );
  const fields = snapMetadataFields(body.listing);
  const current = await readFile(o.yamlPath, "utf8");
  const next = applySnapMetadata(current, fields);
  // The listing is the server's: what is shown of it is cleaned (`untrusted.ts`).
  if (o.dryRun) {
    o.stdout.write(
      `Would write into ${o.yamlPath}:\n  summary: ${untrusted(fields.summary, o.env)}\n  description: ${fields.description.length} characters\n`,
    );
    return fields;
  }
  if (next !== current) await writeFile(o.yamlPath, next, "utf8");
  o.stdout.write(
    `${next === current ? "Unchanged" : "Wrote"} the Snap listing's summary and description in ${o.yamlPath} (${untrusted(body.listing.defaultLocale, o.env)}).\n`,
  );
  return fields;
}

/**
 * `pkey transport …` (P5-08; CONTENT §7, §11): package a published pack release for a store's
 * own transport. The platform moves the bytes; Polaris Key keeps the identity: every command
 * writes the pack's `pkey-marker/1` marker beside the payload it hands the platform, and ends by
 * reporting the transport's availability to Distribution (`pkey distribution report`).
 *
 *   apple-ba package     Manifest.json (asset-pack id `<pack>-c<contentApi>`, the download
 *                        policy from the pack's delivery, one file selector) and `xcrun
 *                        ba-package` (macOS) → `<assetPackId>.aar`        (transportAppleBa.ts)
 *   apple-ba upload      App Store Connect: the asset pack, a version, the manifest and archive
 *                        upload files, their parts and commits, with CI's own ASC key
 *   play-pad modules     `com.android.asset-pack` Gradle modules (fast-follow / on-demand, a
 *                        `#tcf_*` directory per texture variant) and the Godot Gradle build
 *                        patched to include them                          (transportPlayPad.ts)
 *   steam-depot vdf      a content-only SteamPipe build: the app and depot build VDFs and the
 *                        depot's content root, `setlive` on named branches only
 *                                                                         (transportSteam.ts)
 *
 * Input: the cache `pkey release publish --deliverable <packId> --out <dir>` keeps, at
 * `<from>/<packId>/<version>/` (`record.jws` and one directory per variant). Nothing is signed
 * here and nothing is re-published: the payload must be byte-for-byte the one the record pins
 * (each variant's `payload` is re-hashed), and P4-03's lint runs again first, so a pack with
 * scripts never reaches a store transport (CONTENT §12, data-only on store builds).
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTENT_API_RANGE_PATTERN,
  contentApiInRange,
  parseManifest,
  parseRange,
  type ManifestAppDeliverable,
  type ManifestDistribution,
  type ManifestPackDeliverable,
  type Transport,
} from "@polaris-key/manifest";
import { treeDigest, variantKey } from "@polaris-key/client-core/packs";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { MARKER_SUFFIX, TREE_MARKER_PATH } from "@polaris-key/protocol/packs";
import type { Out, Sleep } from "./ci.js";
import type { CiEnv } from "./oidc.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { declaredVariants, variantDirName } from "./packManifest.js";
import { loadVariant, markerJson } from "./packPublish.js";
import { reportDistribution } from "./distribution.js";

export const TRANSPORT_USAGE =
  "Usage: pkey transport apple-ba package --deliverable <packId> --release <v> --from <dir> [--content-api n]\n" +
  "              [--variant key] [--out dir] [--platforms iOS[,macOS]] [--no-archive] [--no-report]\n" +
  "       pkey transport apple-ba upload --deliverable <packId> --release <v> --dir <package out> [--content-api n]\n" +
  "              [--expect-resource id] [--lock file] [--wait minutes] [--no-report]\n" +
  "       pkey transport play-pad modules --deliverable <packId> --release <v> --from <dir> --project <gradle dir>\n" +
  "              [--delivery fast-follow|on-demand] [--default-texture fmt] [--variant key] [--no-report]\n" +
  "       pkey transport steam-depot vdf --deliverable <packId> --release <v> --from <dir> --depot <id>\n" +
  "              (--branch <name> | --channel <c>) [--setlive] [--app <id>] [--out dir] [--no-report]\n" +
  "  (each also takes --product slug, --base-url url; reports need distribution:report, the default CI grant)";

/** What every transport command takes. */
export interface TransportCommon {
  cwd: string;
  /** The pack id. */
  deliverable: string;
  /** The pack release version. */
  version: string;
  /** `--product`: must equal `.pkey/product`'s slug when given. */
  product?: string;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  /** False: write everything, report nothing (`--no-report`). */
  report?: boolean;
}

/** One published variant, re-read from the cache and proven against the record. */
export interface TransportVariant {
  variant: Record<string, string>;
  key: string;
  layout: "container" | "tree";
  /** The payload file (a container) or directory (a tree). */
  location: string;
  /** `.pck` or `.zip` for a container, `""` for a tree. */
  ext: string;
  payload: { sha256: string; size: number };
}

export interface LoadedTransportPack extends TransportProduct {
  /** `<from>/<packId>/<version>`. */
  root: string;
  recordJws: string;
  recordSha256: string;
  record: PackRecordDoc;
  variants: TransportVariant[];
  /** The marker every payload of this release carries (`pkey-marker/1`). */
  marker: string;
}

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

/** The decoded payload of a compact JWS (not verified: the cache is CI's own output). */
function jwsPayload(jws: string): unknown {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("record.jws is not a compact JWS.");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}

/** `.pkey/` as a transport command reads it: the product, the pack's declaration, the routes. */
export interface TransportProduct {
  slug: string;
  pack: ManifestPackDeliverable;
  app: ManifestAppDeliverable | null;
  distribution: ManifestDistribution | undefined;
}

/** Load and validate `.pkey/`, and find the pack's declaration. */
export async function loadTransportProduct(
  common: TransportCommon,
): Promise<TransportProduct> {
  const loaded = await loadManifest(common.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const files: Record<string, string> = {};
  for (const [name, doc] of Object.entries({
    product: loaded.product,
    schema: loaded.schema,
    release: loaded.release,
    distribution: loaded.distribution,
  }))
    if (doc !== undefined) files[name] = JSON.stringify(doc);
  const parsed = parseManifest(files);
  if (!parsed.ok)
    throw new Error(`.pkey/ does not parse:\n  ${parsed.errors.join("\n  ")}`);
  const m = parsed.manifest;
  if (common.product && common.product !== m.product.slug)
    throw new Error(
      `--product ${common.product} does not match .pkey/product's slug ${m.product.slug}.`,
    );
  const packs = m.release?.packDeliverables ?? [];
  const pack = packs.find((p) => p.id === common.deliverable);
  if (!pack)
    throw new Error(
      `--deliverable ${common.deliverable} is not a pack .pkey/release declares (declared: ${packs.map((p) => p.id).join(", ") || "none"}).`,
    );
  return {
    slug: m.product.slug,
    pack,
    app: m.release?.app ?? null,
    distribution: m.distribution,
  };
}

/**
 * Load `.pkey/`, the pack's declaration and its cached release, re-hash every published variant
 * against the record and run the publish lint again. Throws with the reason on any mismatch.
 */
export async function loadTransportPack(
  common: TransportCommon,
  from: string,
): Promise<LoadedTransportPack> {
  const { slug, pack, app, distribution } = await loadTransportProduct(common);
  const root = path.resolve(common.cwd, from, pack.id, common.version);
  let recordJws: string;
  try {
    recordJws = (await readFile(path.join(root, "record.jws"), "utf8")).trim();
  } catch {
    throw new Error(
      `No cached release at ${path.relative(common.cwd, root) || root}: run pkey release publish --deliverable ${pack.id} --version ${common.version} --out ${from} first (or restore that cache).`,
    );
  }
  const record = jwsPayload(recordJws) as PackRecordDoc;
  if (
    record?.kind !== "pack" ||
    record.deliverable !== pack.id ||
    record.version !== common.version
  )
    throw new Error(
      `${path.join(root, "record.jws")} is not ${pack.id}@${common.version}'s pack record.`,
    );

  const variants: TransportVariant[] = [];
  for (const v of declaredVariants(pack)) {
    const key = variantKey(v);
    const signed = record.variants.find((x) => variantKey(x.variant) === key);
    if (!signed) continue;
    const lv = await loadVariant(pack, v, root, {
      ...(app?.content?.attachable
        ? { attachable: app.content.attachable }
        : {}),
    });
    // The lint first: a pack with scripts is refused whatever its bytes are.
    if (lv.lintErrors.length)
      throw new Error(
        `${pack.id}@${common.version} fails the data-only lint, so it never reaches a store transport:\n  ${lv.lintErrors.join("\n  ")}`,
      );
    let payload: { sha256: string; size: number };
    if (lv.payload.layout === "container") {
      payload = {
        sha256: sha256Hex(lv.payload.bytes),
        size: lv.payload.bytes.byteLength,
      };
    } else {
      payload = {
        sha256: await treeDigest(lv.payload.files),
        size: lv.payload.files.reduce((n, f) => n + f.size, 0),
      };
    }
    if (
      payload.sha256 !== signed.payload.sha256 ||
      payload.size !== signed.payload.size
    )
      throw new Error(
        `${path.relative(common.cwd, lv.location) || lv.location} is not the payload ${pack.id}@${common.version}'s record pins for variant ${variantDirName(v)} (sha256 ${payload.sha256.slice(0, 12)}…, want ${signed.payload.sha256.slice(0, 12)}…).`,
      );
    variants.push({
      variant: v,
      key,
      layout: lv.payload.layout,
      location: lv.location,
      ext: lv.payload.layout === "container" ? path.extname(lv.location) : "",
      payload,
    });
  }
  if (variants.length === 0)
    throw new Error(
      `${pack.id}@${common.version}'s record names no variant .pkey/release declares.`,
    );
  return {
    slug,
    pack,
    app,
    distribution,
    root,
    recordJws,
    recordSha256: sha256Hex(recordJws),
    record,
    variants,
    marker: markerJson(pack.id, common.version, recordJws),
  };
}

/** The outlets `.pkey/distribution` routes this pack through `transport` on. */
export function outletsFor(
  loaded: TransportProduct,
  transport: Transport,
): string[] {
  return (loaded.distribution?.routes ?? [])
    .filter(
      (r) => r.deliverableId === loaded.pack.id && r.transport === transport,
    )
    .map((r) => r.outletId);
}

/** Every pack id `.pkey/distribution` routes through `transport` on any outlet. */
export function packsOn(
  loaded: Pick<LoadedTransportPack, "distribution">,
  transport: Transport,
): string[] {
  return [
    ...new Set(
      (loaded.distribution?.routes ?? [])
        .filter((r) => r.transport === transport && r.deliverableId !== "app")
        .map((r) => r.deliverableId),
    ),
  ];
}

/** Refuse a pack `.pkey/distribution` does not route through `transport` anywhere. */
export function requireRouted(
  loaded: TransportProduct,
  transport: Transport,
): string[] {
  const outlets = outletsFor(loaded, transport);
  if (!outlets.length)
    throw new Error(
      `${loaded.pack.id} is not bound to ${transport} on any outlet: add it under transports in .pkey/distribution (transports.packs.<outlet> or transports.deliverables.${loaded.pack.id}.<outlet>) and resync.`,
    );
  return outlets;
}

/**
 * The one variant a single-variant transport carries: `--variant <key>` when given, else the only
 * published variant. `fixed` lists the axes the transport itself targets (they may vary).
 */
export function pickVariants(
  loaded: LoadedTransportPack,
  wanted: string | undefined,
  fixed: readonly string[] = [],
): TransportVariant[] {
  if (wanted !== undefined) {
    const want = wanted === "default" ? "" : wanted;
    const hit = loaded.variants.filter((v) => {
      if (!fixed.length) return v.key === want;
      const rest = Object.fromEntries(
        Object.entries(v.variant).filter(([a]) => !fixed.includes(a)),
      );
      return variantKey(rest) === want;
    });
    if (!hit.length)
      throw new Error(
        `--variant ${wanted} is not a published variant of ${loaded.pack.id} (published: ${loaded.variants.map((v) => v.key || "default").join(", ")}).`,
      );
    return hit;
  }
  const otherAxes = new Set(
    loaded.variants.flatMap((v) =>
      Object.keys(v.variant).filter((a) => !fixed.includes(a)),
    ),
  );
  if (otherAxes.size)
    throw new Error(
      `${loaded.pack.id} varies by ${[...otherAxes].join(", ")}, which this transport cannot target: choose one with --variant (published: ${loaded.variants.map((v) => v.key || "default").join(", ")}).`,
    );
  return loaded.variants;
}

/**
 * Check the content level a store transport binds the pack to: inside the pack's declared
 * `requires.contentApi` range for the app, when it declares one. The level defaults to the app's
 * own `content.contentApi`.
 */
export function contentLevel(
  loaded: TransportProduct,
  given: string | undefined,
): number {
  const level =
    given !== undefined ? Number(given) : loaded.app?.content?.contentApi;
  if (level === undefined)
    throw new Error(
      "--content-api is required: .pkey/release declares no deliverables.app.content.contentApi.",
    );
  if (!Number.isSafeInteger(level) || level < 1)
    throw new Error(
      `--content-api must be a whole number of at least 1 (got ${String(given)}).`,
    );
  const range = loaded.pack.requires.contentApi?.app;
  if (range !== undefined) {
    const cmp = parseRange(range, CONTENT_API_RANGE_PATTERN);
    if (cmp && !contentApiInRange(cmp, level))
      throw new Error(
        `${loaded.pack.id} requires contentApi ${range}; it cannot be bound to content level ${level}.`,
      );
  }
  return level;
}

/**
 * Put one variant's payload and its marker into `dir` under `name`: a container as
 * `<name><ext>` with `<name><ext>.pkey.json` beside it, a tree as the directory itself with
 * `.pkey/pack.json` inside. Returns the files written (relative to `dir`).
 */
export async function placePayload(
  loaded: LoadedTransportPack,
  v: TransportVariant,
  dir: string,
  name: string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  if (v.layout === "container") {
    const file = `${name}${v.ext}`;
    await cp(v.location, path.join(dir, file));
    await writeFile(path.join(dir, `${file}${MARKER_SUFFIX}`), loaded.marker);
    return [file, `${file}${MARKER_SUFFIX}`];
  }
  await cp(v.location, dir, { recursive: true });
  const marker = path.join(dir, ...TREE_MARKER_PATH.split("/"));
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, loaded.marker);
  return [".", TREE_MARKER_PATH];
}

/** Report the transport's availability of this pack release on each outlet (or say why not). */
export async function reportTransport(
  common: TransportCommon,
  loaded: TransportProduct,
  outlets: readonly string[],
  state: string,
  platformRef: Record<string, unknown>,
): Promise<void> {
  if (common.report === false) {
    common.stdout.write(
      `Not reporting ${state} on ${outlets.join(", ")} (--no-report)\n`,
    );
    return;
  }
  for (const outlet of outlets)
    await reportDistribution({
      type: "availability",
      product: loaded.slug,
      baseUrl: common.baseUrl,
      env: common.env,
      stdout: common.stdout,
      stderr: common.stderr,
      fetchImpl: common.fetchImpl,
      sleep: common.sleep,
      outlet,
      version: common.version,
      deliverable: loaded.pack.id,
      state,
      platformRef: JSON.stringify(platformRef),
    });
}

/** Stable JSON for generated files: two-space indent, a final newline. */
export function prettyJson(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

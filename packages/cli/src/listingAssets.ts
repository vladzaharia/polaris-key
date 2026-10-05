/**
 * `pkey listing assets` (A-18d; notes/S-15 §5.4, §5.6, §7.4, decision 2): turn one icon master,
 * one logo-free key art (plus an optional portrait cut) and one wordmark into every store's
 * listing assets, deterministically, fit the screenshots per store, and optionally upload the
 * lot into the shared listing model.
 *
 *   1. Decode the masters (`listing/io.ts`, sharp) and the screenshots under `--screenshots`
 *      (one sub-directory per size class: `phone-portrait/`, `tablet/`, `desktop-16x9/`, ...).
 *   2. Derive every store icon, compose every store's art (`listing/derive.ts`, integer pixel
 *      operations, so the golden pixel hashes hold on every platform), and fit every screenshot
 *      against every store's rule. A screenshot that does not fit gets a crop (or pad) proposal,
 *      applied only for the images the operator names with `--accept <id>` (or `--pad <id>`):
 *      a crop can cut UI, so it is never silent.
 *   3. Write everything under `--out`: one directory per store, the fitted screenshots, the
 *      proposals' previews, one ZIP pack per store (Steam has no listing API: its pack is what
 *      the operator uploads by hand, A-18g), `report.json` (the fit report: every slot's status,
 *      size, alpha, format, SHA-256 and pixel hash) and `preview.html` to look at before anything
 *      is accepted or pushed.
 *   4. With `--upload --product <slug>`: upload the masters, outputs, fitted screenshots and packs
 *      through an upload ticket (P2-02's uploads route accepts `distribution:listing`) and register
 *      them (`POST /<p>/distribution/listing/assets`) into `dist_listing_assets`, with SHA-256,
 *      width, height, alpha and `derivedFrom`. Pending proposals and `red`, `human` and `missing`
 *      slots are never uploaded (the stored row carries no status, so a red output stays local).
 *      Nothing is pushed to any store here: the storefront adapters push from the blob store,
 *      after the operator has seen and accepted each output in the console (A-18j).
 *
 * Play's `aiGeneratedState` is `NotAiGenerated` for every template output: the report and the
 * Play pack say so, and the Worker derives the same from `derivedFrom` for the Play adapter (a
 * master or a fitted screenshot, which a person made, gets no declaration).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ciClient, type Out, type Sleep } from "./ci.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { putFile } from "./s3.js";
import { zipStore } from "./zip.js";
import { decodeImage, encodeImage, type Decoded } from "./listing/io.js";
import {
  defaultBackground,
  deriveAll,
  fitScreenshots,
  parseColor,
  parseFocal,
  type Acceptance,
  type Masters,
  type ScreenshotInput,
  type ScreenshotOutput,
  type SlotOutput,
  type SlotStatus,
} from "./listing/derive.js";
import { pixelSha256, channels, type Rgb } from "./listing/raster.js";
import {
  MASTER_RULES,
  PACK_STORES,
  SCREENSHOT_CLASSES,
  type MasterSlot,
  type PackStore,
  type ScreenshotClass,
  type TextAllowed,
} from "./listing/specs.js";

export const LISTING_ASSETS_USAGE =
  "Usage: pkey listing assets --out <dir> [--icon <png>] [--key-art <png>]\n" +
  "              [--key-art-portrait <png>] [--wordmark <png>] [--screenshots <dir>]\n" +
  "              [--focal x,y] [--focal-portrait x,y] [--background #rrggbb]\n" +
  "              [--accept <store/class/name> ...] [--pad <store/class/name> ...] [--locale <code>]\n" +
  "              [--upload --product <slug> [--base-url <url>] [--dry-run]]";

export const REPORT_FORMAT = "pkey-listing-assets/1";
const SCREENSHOT_EXT = /\.(png|jpe?g|webp)$/i;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface ListingAssetsOptions {
  cwd: string;
  out: string;
  icon?: string;
  keyArt?: string;
  keyArtPortrait?: string;
  wordmark?: string;
  screenshots?: string;
  focal?: string;
  focalPortrait?: string;
  background?: string;
  accept?: readonly string[];
  pad?: readonly string[];
  locale?: string;
  upload?: boolean;
  product?: string;
  baseUrl?: string;
  dryRun?: boolean;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

/** One file `pkey listing assets` wrote, as `report.json` lists it. */
export interface ReportFile {
  /** Under `--out`, `/`-separated. */
  file: string;
  format: "png" | "jpeg" | "zip";
  width: number | null;
  height: number | null;
  alpha: boolean;
  /** The encoded bytes' SHA-256 (what the blob store holds). */
  sha256: string;
  size: number;
  /** The golden hash: the pixels before encoding (`raster.ts` `pixelSha256`). */
  pixelSha256?: string;
}

export interface ReportSlot extends Partial<ReportFile> {
  slot: string;
  store: string;
  status: SlotStatus;
  textAllowed: TextAllowed;
  derivedFrom: string | null;
  aiGeneratedState?: "NotAiGenerated";
  notes: string[];
}

export interface ReportScreenshot extends Partial<ReportFile> {
  id: string;
  store: string;
  class: ScreenshotClass;
  slot: string;
  status: ScreenshotOutput["status"];
  method: ScreenshotOutput["method"];
  source: { file: string; width: number; height: number };
  proposal?: ScreenshotOutput["proposal"];
  problems: string[];
  notes: string[];
}

export interface ListingAssetsReport {
  format: typeof REPORT_FORMAT;
  locale: string | null;
  focal: { x: number; y: number };
  focalPortrait: { x: number; y: number };
  background: string;
  masters: Array<{
    slot: MasterSlot;
    file: string;
    width: number;
    height: number;
    alpha: boolean;
    sha256: string;
    size: number;
  }>;
  slots: ReportSlot[];
  screenshots: ReportScreenshot[];
  packs: Array<{ store: PackStore; slot: string } & ReportFile>;
  /** Every file written under `--out` (a later run removes exactly these). */
  files: string[];
}

export interface ListingAssetsResult {
  report: ListingAssetsReport;
  dir: string;
  uploaded: string[];
  registered: { stored: unknown[]; kept: unknown[] } | null;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (c: Rgb) =>
  `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

interface LoadedMaster {
  slot: MasterSlot;
  path: string;
  bytes: Buffer;
  decoded: Decoded;
}

async function loadMaster(
  cwd: string,
  slot: MasterSlot,
  file: string | undefined,
): Promise<LoadedMaster | null> {
  if (!file) return null;
  const p = path.resolve(cwd, file);
  const bytes = await readFile(p);
  const decoded = await decodeImage(
    bytes,
    `--${slot === "icon-master" ? "icon" : slot} ${file}`,
  );
  return { slot, path: p, bytes, decoded };
}

async function loadScreenshots(
  cwd: string,
  dir: string | undefined,
): Promise<Array<ScreenshotInput & { file: string; path: string }>> {
  if (!dir) return [];
  const root = path.resolve(cwd, dir);
  const out: Array<ScreenshotInput & { file: string; path: string }> = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (
      !e.isDirectory() ||
      !(SCREENSHOT_CLASSES as readonly string[]).includes(e.name)
    )
      throw new Error(
        `--screenshots ${dir}: ${e.name} is not a size-class directory (${SCREENSHOT_CLASSES.join(", ")}).`,
      );
    const cls = e.name as ScreenshotClass;
    const files = (await readdir(path.join(root, cls)))
      .filter((f) => !f.startsWith("."))
      .sort();
    for (const f of files) {
      if (!SCREENSHOT_EXT.test(f) || !/^[A-Za-z0-9_.-]+$/.test(f))
        throw new Error(
          `--screenshots ${dir}/${cls}/${f}: screenshots are .png, .jpg or .webp files with plain names.`,
        );
      const p = path.join(root, cls, f);
      const decoded = await decodeImage(
        await readFile(p),
        `${dir}/${cls}/${f}`,
      );
      out.push({
        cls,
        name: f.replace(SCREENSHOT_EXT, ""),
        raster: decoded.raster,
        file: `${cls}/${f}`,
        path: p,
      });
    }
  }
  const names = new Set<string>();
  for (const s of out) {
    const key = `${s.cls}/${s.name}`;
    if (names.has(key))
      throw new Error(
        `--screenshots: two ${s.cls} files are named ${s.name} (ids must be unique).`,
      );
    names.add(key);
  }
  return out;
}

/** Remove what a previous run wrote under `dir` (its report's `files`), never anything else. */
async function clearOut(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir);
  if (entries.length === 0) return;
  const reportPath = path.join(dir, "report.json");
  let previous: { format?: unknown; files?: unknown } | null;
  try {
    previous = JSON.parse(await readFile(reportPath, "utf8")) as {
      format?: unknown;
      files?: unknown;
    } | null;
  } catch {
    previous = null;
  }
  if (
    !previous ||
    previous.format !== REPORT_FORMAT ||
    !Array.isArray(previous.files)
  )
    throw new Error(
      `--out ${dir} is not empty and holds no ${REPORT_FORMAT} report.json: give an empty or new directory.`,
    );
  const dirs = new Set<string>();
  for (const rel of previous.files) {
    if (
      typeof rel !== "string" ||
      rel.startsWith("/") ||
      rel.split("/").includes("..")
    )
      continue;
    const p = path.join(dir, ...rel.split("/"));
    await rm(p, { force: true });
    for (
      let d = path.dirname(p);
      d.startsWith(dir) && d !== dir;
      d = path.dirname(d)
    )
      dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(d);
    } catch {
      // Not empty: something else lives there; leave it.
    }
  }
}

function acceptances(
  accept: readonly string[],
  pad: readonly string[],
): Map<string, Acceptance> {
  const out = new Map<string, Acceptance>();
  const split = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (const id of accept.flatMap(split)) out.set(id, "accept");
  for (const id of pad.flatMap(split)) {
    if (out.has(id))
      throw new Error(`${id} is named by both --accept and --pad.`);
    out.set(id, "pad");
  }
  return out;
}

function previewHtml(report: ListingAssetsReport): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const card = (
    title: string,
    status: string,
    file: string | undefined,
    meta: string,
    notes: string[],
  ) =>
    `<figure class="${esc(status)}"><figcaption><b>${esc(title)}</b> <i>${esc(status)}</i><br>${esc(meta)}${notes.map((n) => `<br><small>${esc(n)}</small>`).join("")}</figcaption>${file ? `<img src="${esc(file)}" alt="${esc(title)}" loading="lazy">` : ""}</figure>`;
  const slots = report.slots
    .map((s) =>
      card(
        s.slot,
        s.status,
        s.file,
        s.width
          ? `${s.width}x${s.height} ${s.format}${s.alpha ? " alpha" : ""}`
          : "",
        s.notes,
      ),
    )
    .join("\n");
  const shots = report.screenshots
    .map((s) =>
      card(
        s.id,
        s.status,
        s.file,
        `${s.source.width}x${s.source.height}${s.width ? ` -> ${s.width}x${s.height} (${s.method})` : ""}`,
        [...s.problems, ...s.notes],
      ),
    )
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>pkey listing assets</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;background:#f6f8ff;color:#060912}
section{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
figure{margin:0;padding:8px;background:#fff;border:2px solid #ccd;border-radius:8px}
figure.red,figure.missing{border-color:#c62828}figure.warn,figure.pending,figure.human{border-color:#d07a00}
figure.ok,figure.fits,figure.accepted{border-color:#2e7d32}
img{max-width:100%;height:auto;display:block;margin-top:8px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
</style>
<h1>Listing assets</h1>
<p>Generated by <code>pkey listing assets</code>. Nothing here has been pushed to a store.</p>
<h2>Store art and icons</h2>
<section>
${slots}
</section>
<h2>Screenshots</h2>
<section>
${shots}
</section>
`;
}

export async function listingAssets(
  opts: ListingAssetsOptions,
): Promise<ListingAssetsResult> {
  const out = opts.stdout;
  if (!opts.out?.trim()) throw new Error(LISTING_ASSETS_USAGE);
  if (
    !opts.icon &&
    !opts.keyArt &&
    !opts.keyArtPortrait &&
    !opts.wordmark &&
    !opts.screenshots
  )
    throw new Error(`Give at least one input.\n${LISTING_ASSETS_USAGE}`);
  if (opts.upload && !opts.product?.trim())
    throw new Error(`--upload needs --product.\n${LISTING_ASSETS_USAGE}`);
  if (!opts.upload && opts.dryRun)
    throw new Error(
      "--dry-run applies to --upload only (without --upload nothing is sent).",
    );
  const locale = opts.locale?.trim() || null;
  if (locale !== null && !LOCALE_RE.test(locale))
    throw new Error(`--locale ${locale} is not a locale code such as en-US.`);
  const focal = opts.focal ? parseFocal(opts.focal) : { x: 0.5, y: 0.5 };
  const focalPortrait = opts.focalPortrait
    ? parseFocal(opts.focalPortrait)
    : focal;
  const accepted = acceptances(opts.accept ?? [], opts.pad ?? []);
  const dir = path.resolve(opts.cwd, opts.out);
  // Refuse a foreign --out before any decoding.
  if (existsSync(dir) && !(await stat(dir)).isDirectory())
    throw new Error(`--out ${opts.out} is not a directory.`);

  // ── Inputs ──
  const masterList = (
    await Promise.all([
      loadMaster(opts.cwd, "icon-master", opts.icon),
      loadMaster(opts.cwd, "key-art", opts.keyArt),
      loadMaster(opts.cwd, "key-art-portrait", opts.keyArtPortrait),
      loadMaster(opts.cwd, "wordmark", opts.wordmark),
    ])
  ).filter((m): m is LoadedMaster => m !== null);
  const masters: Masters = {};
  for (const m of masterList) masters[m.slot] = m.decoded.raster;
  const icon = masters["icon-master"];
  if (icon && icon.width !== icon.height)
    throw new Error(
      `--icon must be square (got ${icon.width}x${icon.height}); a 1024x1024 master is best.`,
    );
  if (
    masters.wordmark &&
    !masterList.find((m) => m.slot === "wordmark")!.decoded.alpha
  )
    out.write(
      "warning: the wordmark has no alpha channel; it is placed as an opaque rectangle.\n",
    );
  const background = opts.background
    ? parseColor(opts.background)
    : defaultBackground(icon);
  const shots = await loadScreenshots(opts.cwd, opts.screenshots);

  // ── Derive, compose, fit ──
  const slots = deriveAll(masters, { focal, focalPortrait, background });
  const fitted = fitScreenshots(shots, accepted, background);
  if (fitted.unused.length)
    throw new Error(
      `${fitted.unused.join(", ")}: no screenshot proposal has ${fitted.unused.length === 1 ? "that id" : "those ids"}. ` +
        "Ids are <store>/<class>/<name>, as the report lists them; an image that already fits needs none.",
    );

  // ── Write ──
  await clearOut(dir);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const writeRel = async (rel: string, bytes: Uint8Array) => {
    const p = path.join(dir, ...rel.split("/"));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
    files.push(rel);
    return p;
  };
  const packEntries = new Map<
    PackStore,
    Array<{ name: string; data: Uint8Array; meta: Record<string, unknown> }>
  >();
  const addToPack = (
    store: string,
    name: string,
    data: Uint8Array,
    meta: Record<string, unknown>,
  ) => {
    if (!(PACK_STORES as readonly string[]).includes(store)) return;
    const list = packEntries.get(store as PackStore) ?? [];
    list.push({ name, data, meta });
    packEntries.set(store as PackStore, list);
  };

  const reportSlots: ReportSlot[] = [];
  for (const s of slots) {
    const entry: ReportSlot = {
      slot: s.spec.slot,
      store: s.spec.store,
      status: s.status,
      textAllowed: s.spec.textAllowed,
      derivedFrom: s.derivedFrom,
      notes: [...s.notes],
    };
    if (s.raster) {
      const n = s.spec.alpha ? 4 : 3;
      const bytes = await encodeImage(s.raster, s.spec.format, s.spec.alpha);
      const ext = s.spec.format === "jpeg" ? "jpg" : "png";
      const rel = `${s.spec.store}/${s.spec.name}.${ext}`;
      await writeRel(rel, bytes);
      Object.assign(entry, {
        file: rel,
        format: s.spec.format,
        width: s.raster.width,
        height: s.raster.height,
        alpha: s.spec.alpha,
        sha256: sha256(bytes),
        size: bytes.length,
        pixelSha256: pixelSha256(
          s.raster.width,
          s.raster.height,
          n,
          channels(s.raster, n),
        ),
      });
      if (s.derivedFrom !== null && s.spec.store === "play")
        entry.aiGeneratedState = "NotAiGenerated";
      if (s.spec.maxBytes !== undefined && bytes.length > s.spec.maxBytes) {
        entry.status = "red";
        entry.notes.push(
          `${bytes.length} bytes is over the store's ${s.spec.maxBytes}-byte limit`,
        );
      }
      addToPack(s.spec.store, `${s.spec.name}.${ext}`, bytes, {
        ...entry,
        file: `${s.spec.name}.${ext}`,
      });
    }
    reportSlots.push(entry);
  }

  const reportShots: ReportScreenshot[] = [];
  for (const s of fitted.outputs) {
    const src = shots.find((x) => x.cls === s.cls && x.name === s.name)!;
    const entry: ReportScreenshot = {
      id: s.id,
      store: s.store,
      class: s.cls,
      slot: s.slot,
      status: s.status,
      method: s.method,
      source: { file: src.file, ...s.source },
      ...(s.proposal ? { proposal: s.proposal } : {}),
      problems: s.problems,
      notes: s.notes,
    };
    if (s.raster) {
      const bytes = await encodeImage(s.raster, "png", false);
      const rel =
        s.status === "pending"
          ? `proposals/${s.store}/${s.cls}/${s.name}.png`
          : `screenshots/${s.store}/${s.cls}/${String(s.index).padStart(2, "0")}-${s.name}.png`;
      await writeRel(rel, bytes);
      Object.assign(entry, {
        file: rel,
        format: "png" as const,
        width: s.raster.width,
        height: s.raster.height,
        alpha: false,
        sha256: sha256(bytes),
        size: bytes.length,
        pixelSha256: pixelSha256(
          s.raster.width,
          s.raster.height,
          3,
          channels(s.raster, 3),
        ),
      });
      if (s.status !== "pending")
        addToPack(
          s.store,
          `screenshots/${s.cls}/${String(s.index).padStart(2, "0")}.png`,
          bytes,
          {
            slot: s.slot,
            file: `screenshots/${s.cls}/${String(s.index).padStart(2, "0")}.png`,
            width: s.raster.width,
            height: s.raster.height,
            method: s.method,
            sha256: sha256(bytes),
          },
        );
    }
    reportShots.push(entry);
  }

  const packs: ListingAssetsReport["packs"] = [];
  for (const store of PACK_STORES) {
    const entries = packEntries.get(store);
    if (!entries?.length) continue;
    const manifest = {
      format: "pkey-listing-pack/1",
      store,
      locale,
      generatedBy: "pkey listing assets",
      files: entries.map((e) => e.meta),
    };
    const zip = zipStore([
      ...entries.map((e) => ({ name: e.name, data: e.data })),
      {
        name: "assets.json",
        data: new TextEncoder().encode(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
      },
    ]);
    const rel = `packs/${store}.zip`;
    await writeRel(rel, zip);
    packs.push({
      store,
      slot: `pack:${store}`,
      file: rel,
      format: "zip",
      width: null,
      height: null,
      alpha: false,
      sha256: sha256(zip),
      size: zip.length,
    });
  }

  const report: ListingAssetsReport = {
    format: REPORT_FORMAT,
    locale,
    focal,
    focalPortrait,
    background: hex(background),
    masters: masterList.map((m) => ({
      slot: m.slot,
      file: path.relative(opts.cwd, m.path).split(path.sep).join("/"),
      width: m.decoded.raster.width,
      height: m.decoded.raster.height,
      alpha: m.decoded.alpha,
      sha256: sha256(m.bytes),
      size: m.bytes.length,
    })),
    slots: reportSlots,
    screenshots: reportShots,
    packs,
    files: [],
  };
  await writeRel("preview.html", new TextEncoder().encode(previewHtml(report)));
  report.files = [...files, "report.json"].sort();
  await writeFile(
    path.join(dir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  // ── Summary ──
  const relDir = path.relative(opts.cwd, dir);
  const rel = relDir === "" ? "." : relDir.startsWith("..") ? dir : relDir;
  const count = (st: string) =>
    reportSlots.filter((s) => s.status === st).length;
  out.write(
    `Wrote ${files.length + 1} files to ${rel}: ${count("ok")} ok, ${count("warn")} warn, ${count("red")} red, ` +
      `${count("human")} human, ${count("missing")} missing; ${packs.length} store pack${packs.length === 1 ? "" : "s"}.\n`,
  );
  for (const s of reportSlots)
    if (s.status !== "ok")
      out.write(
        `  ${s.status.padEnd(7)} ${s.slot}${s.notes.length ? `: ${s.notes.join("; ")}` : ""}\n`,
      );
  const pending = reportShots.filter((s) => s.status === "pending");
  const red = reportShots.filter((s) => s.status === "red");
  for (const s of red)
    out.write(`  red     screenshot ${s.id}: ${s.problems.join("; ")}\n`);
  if (pending.length) {
    out.write(
      `${pending.length} screenshot${pending.length === 1 ? " does" : "s do"} not fit as is; each proposal is previewed under ${rel}/proposals/ and is used only once accepted:\n`,
    );
    for (const s of pending) {
      const p = s.proposal!;
      const crop = p.crop
        ? `crop to ${p.crop.width}x${p.crop.height} (--accept ${s.id})`
        : null;
      const pad = p.pad
        ? `pad to ${p.pad.width}x${p.pad.height} (--pad ${s.id})`
        : null;
      out.write(
        `  ${s.id} ${s.source.width}x${s.source.height}: ${s.problems.join("; ")}; ${[crop, pad].filter(Boolean).join(" or ")}\n`,
      );
    }
  }
  out.write(`Look before accepting: ${path.join(rel, "preview.html")}\n`);

  const result: ListingAssetsResult = {
    report,
    dir,
    uploaded: [],
    registered: null,
  };
  if (!opts.upload) return result;

  // ── Upload and register ──
  interface UploadRow {
    slot: string;
    file: string;
    sha256: string;
    size: number;
    width: number | null;
    height: number | null;
    alpha: boolean;
    derivedFrom: string | null;
    textAllowed: TextAllowed;
  }
  const rows: UploadRow[] = [];
  for (const m of masterList)
    rows.push({
      slot: m.slot,
      file: m.path,
      sha256: sha256(m.bytes),
      size: m.bytes.length,
      width: m.decoded.raster.width,
      height: m.decoded.raster.height,
      alpha: m.decoded.alpha,
      derivedFrom: null,
      textAllowed: MASTER_RULES[m.slot],
    });
  // Only `ok` and `warn` outputs go up. A `red` output (an icon-only fallback with no key art, a
  // `title` slot composed with no wordmark, a file over the store's byte limit) stays local: the
  // stored row has no status, so registering it would make it look compliant.
  const notUploaded = reportSlots.filter((s) => s.file && s.status === "red");
  for (const s of reportSlots)
    if (s.file && (s.status === "ok" || s.status === "warn"))
      rows.push({
        slot: s.slot,
        file: path.join(dir, ...s.file.split("/")),
        sha256: s.sha256!,
        size: s.size!,
        width: s.width ?? null,
        height: s.height ?? null,
        alpha: s.alpha ?? false,
        derivedFrom: s.derivedFrom,
        textAllowed: s.textAllowed,
      });
  for (const s of reportShots)
    if (s.file && (s.status === "fits" || s.status === "accepted"))
      rows.push({
        slot: s.slot,
        file: path.join(dir, ...s.file.split("/")),
        sha256: s.sha256!,
        size: s.size!,
        width: s.width ?? null,
        height: s.height ?? null,
        alpha: false,
        derivedFrom: `screenshot:${s.class}`,
        textAllowed: "free",
      });
  for (const p of packs)
    rows.push({
      slot: p.slot,
      file: path.join(dir, ...p.file.split("/")),
      sha256: p.sha256,
      size: p.size,
      width: null,
      height: null,
      alpha: false,
      derivedFrom: null,
      textAllowed: "free",
    });
  const body = rows.map((r) => ({
    slot: r.slot,
    ...(locale ? { locale } : {}),
    sha256: r.sha256,
    size: r.size,
    width: r.width,
    height: r.height,
    alpha: r.alpha,
    derivedFrom: r.derivedFrom,
    textAllowed: r.textAllowed,
  }));
  const writeNotUploaded = () => {
    if (notUploaded.length)
      out.write(
        `${notUploaded.length} red output${notUploaded.length === 1 ? " was" : "s were"} not uploaded: ` +
          `${notUploaded.map((s) => s.slot).join(", ")}. Fix them (see the report) and run again.\n`,
      );
  };
  if (opts.dryRun) {
    out.write(
      `Dry run: would upload and register ${rows.length} listing assets; nothing sent.\n`,
    );
    writeNotUploaded();
    return result;
  }
  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product!,
    env: opts.env,
    out,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product!,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
  // Every object goes up under this ticket: the register earns only a listing row's own refs, so
  // `present` (a ref of any kind) is not a reason to skip.
  const unique = new Map(rows.map((r) => [r.sha256, r]));
  const ticket = (await client.postJson("release/publish/uploads", {
    what: "Requesting an upload ticket",
    body: {
      objects: [...unique.values()].map((r) => ({
        sha256: r.sha256,
        size: r.size,
      })),
    },
  })) as unknown as {
    ticket: string;
    credentials: {
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
    };
    objects: Array<{ sha256: string; size: number; key: string }>;
  };
  if (typeof ticket.ticket !== "string" || !Array.isArray(ticket.objects))
    throw new Error("The uploads route answered without a ticket.");
  mask(opts.env, out, ticket.ticket);
  mask(opts.env, out, ticket.credentials.secretAccessKey);
  mask(opts.env, out, ticket.credentials.sessionToken);
  for (const o of ticket.objects) {
    const r = unique.get(o.sha256);
    if (!r)
      throw new Error(
        `The ticket names ${o.sha256}, which pkey did not ask for.`,
      );
    await putFile({
      creds: ticket.credentials,
      key: o.key,
      file: r.file,
      size: r.size,
      sha256: r.sha256,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
    });
    result.uploaded.push(r.slot);
  }
  const answer = (await client.postJson("distribution/listing/assets", {
    what: "Registering the listing assets",
    body: { ticket: ticket.ticket, assets: body },
  })) as unknown as { stored?: unknown[]; kept?: Array<{ slot: string }> };
  result.registered = { stored: answer.stored ?? [], kept: answer.kept ?? [] };
  out.write(
    `Registered ${result.registered.stored.length} listing assets for ${opts.product}` +
      (answer.kept?.length
        ? `; kept ${answer.kept.length} the operator uploaded (${answer.kept.map((k) => k.slot).join(", ")})`
        : "") +
      ". Nothing was pushed to a store: accept each output in the console first.\n",
  );
  writeNotUploaded();
  if (pending.length)
    out.write(
      `${pending.length} pending screenshot proposal${pending.length === 1 ? " was" : "s were"} not uploaded.\n`,
    );
  return result;
}

/**
 * `pkey assets push` and the publish Action's `assets` input (HA-06; notes/S-20 §6.3 "Push from
 * CI"): files that are not on the web (an icon, a header, screenshots, a listing image slot) are
 * uploaded from CI and Polaris Key hosts a copy, served from its image host.
 *
 *   1. Every file is read, hashed and checked locally: a slot CI can push, a language tag, the
 *      slot's byte cap, no slot twice in one locale.
 *   2. One upload ticket (`POST /<p>/release/publish/uploads`, which accepts `assets:write`) and
 *      one S3 PUT per distinct file into the ticket's staging prefix. Every file is uploaded, even
 *      one the uploads route reports `present`: the push reads the bytes it hosts.
 *   3. `POST /<p>/assets` with the ticket and the entries. The Worker reads and sniffs every byte
 *      (PNG, JPEG, WebP, GIF or AVIF; never SVG) and answers each entry `stored`, `kept` (a slot an
 *      operator uploaded in the console, or one a manifest declares: console claim, then
 *      manifest, then CI) or `refused` with its reason.
 *
 * The token needs `assets:write`, an opt-in scope an operator grants (Keys & secrets → CI). The
 * upload ticket comes from Release's uploads route, so Release must be on for the product.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ciClient, type Out, type Sleep } from "./ci.js";
import { mask, resolveCiToken, type CiEnv } from "./oidc.js";
import { putFile } from "./s3.js";

export const ASSETS_PUSH_USAGE =
  "Usage: pkey assets push <file> --slot <slot> [--locale <code>] --product <slug>\n" +
  "              [--base-url <url>] [--dry-run]";

/** At most this many files per push (the Worker's `MAX_PUSH_ASSETS`). */
export const MAX_PUSH_ASSETS = 32;
/** The listing's screenshot slots: `listing.screenshot:1` to `listing.screenshot:16`. */
export const MAX_SCREENSHOTS = 16;
const MiB = 1024 * 1024;
/** The Worker's caps: icon slots 10 MiB, every other image slot 20 MiB (`SLOT_CLASSES`). */
export const ICON_MAX_BYTES = 10 * MiB;
export const ART_MAX_BYTES = 20 * MiB;

const SLOT_RE = /^[a-z0-9][a-z0-9.:-]{0,199}$/;
/** Slots that are not images CI pushes (store packs, the trailer, release files, notes images). */
const NOT_PUSHABLE =
  /^(pack:|youtube-url$|trailer-master$|notes-image:|release-file)/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The byte cap the Worker applies to `slot`. */
export function slotMaxBytes(slot: string): number {
  return slot === "presentation.icon" ||
    slot === "listing.icon" ||
    /icon/.test(slot)
    ? ICON_MAX_BYTES
    : ART_MAX_BYTES;
}

/** Why `slot` is not one CI can push, or `null` (the Worker has the full list and the last word). */
export function slotProblem(slot: string): string | null {
  if (!SLOT_RE.test(slot) || NOT_PUSHABLE.test(slot))
    return `${JSON.stringify(slot)} is not a slot CI can push: presentation.icon, listing.icon, listing.header, listing.screenshot:<1-16> or a listing image slot (icon-master, play:feature-graphic, …).`;
  const shot = /^listing\.screenshot:(\d+)$/.exec(slot);
  if (shot && (Number(shot[1]) < 1 || Number(shot[1]) > MAX_SCREENSHOTS))
    return `${slot}: the listing has screenshot slots 1 to ${MAX_SCREENSHOTS}.`;
  if (slot === "listing.screenshot")
    return "listing.screenshot needs its number (listing.screenshot:1 to listing.screenshot:16).";
  return null;
}

export interface AssetEntry {
  /** The file, relative to `cwd` or absolute. */
  file: string;
  slot: string;
  /** A language tag; omitted is every locale. */
  locale?: string;
}

export interface PushAssetsOptions {
  cwd: string;
  product: string;
  entries: readonly AssetEntry[];
  baseUrl?: string;
  dryRun?: boolean;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

export interface PushAnswer {
  ok: boolean;
  stored: Array<{ slot: string; locale: string; sha256: string; size: number }>;
  kept: Array<{ slot: string; locale: string; reason: string }>;
  refused: Array<{ slot: string; locale: string; reason: string }>;
}

interface Prepared extends AssetEntry {
  abs: string;
  sha256: string;
  size: number;
}

const where = (slot: string, locale?: string) =>
  locale ? `${slot} (${locale})` : slot;

async function prepare(
  cwd: string,
  entries: readonly AssetEntry[],
): Promise<Prepared[]> {
  if (entries.length === 0) throw new Error("Nothing to push.");
  if (entries.length > MAX_PUSH_ASSETS)
    throw new Error(
      `${entries.length} files in one push; at most ${MAX_PUSH_ASSETS}. Split them across steps.`,
    );
  const seen = new Set<string>();
  const out: Prepared[] = [];
  for (const e of entries) {
    const problem = slotProblem(e.slot);
    if (problem) throw new Error(problem);
    if (e.locale !== undefined && !LOCALE_RE.test(e.locale))
      throw new Error(
        `--locale must be a language tag such as de or pt-BR (got ${JSON.stringify(e.locale)}).`,
      );
    const id = `${e.slot}@${e.locale ?? ""}`;
    if (seen.has(id))
      throw new Error(
        `${where(e.slot, e.locale)} is named twice; one file per slot.`,
      );
    seen.add(id);
    const abs = path.resolve(cwd, e.file);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new Error(`${e.file}: no such file.`);
    }
    if (!info.isFile()) throw new Error(`${e.file} is not a file.`);
    if (info.size === 0) throw new Error(`${e.file} is empty.`);
    const cap = slotMaxBytes(e.slot);
    if (info.size > cap)
      throw new Error(
        `${e.file} is ${info.size} bytes; ${e.slot} takes files up to ${cap} bytes.`,
      );
    const bytes = await readFile(abs);
    out.push({
      ...e,
      abs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
  return out;
}

/**
 * Push `entries` (1 to 32 files) into their slots. Returns the Worker's answer; throws on a local
 * refusal or a refused request. The caller fails the job when `refused` is not empty.
 */
export async function pushAssets(
  opts: PushAssetsOptions,
): Promise<PushAnswer | null> {
  const out = opts.stdout;
  const files = await prepare(opts.cwd, opts.entries);
  if (opts.dryRun) {
    for (const f of files)
      out.write(
        `Would push ${path.relative(opts.cwd, f.abs) || f.file} → ${where(f.slot, f.locale)} (${f.size} bytes, sha256 ${f.sha256})\n`,
      );
    out.write(`Dry run: ${files.length} file(s); nothing sent.\n`);
    return null;
  }
  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
  const unique = new Map(files.map((f) => [f.sha256, f]));
  const ticket = (await client.postJson("release/publish/uploads", {
    what: "Requesting an upload ticket",
    body: {
      objects: [...unique.values()].map((f) => ({
        sha256: f.sha256,
        size: f.size,
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
  // Every object goes up, `present` or not: the push hosts the bytes it reads from the ticket.
  for (const o of ticket.objects) {
    const f = unique.get(o.sha256);
    if (!f)
      throw new Error(
        `The ticket names ${o.sha256}, which pkey did not ask for.`,
      );
    await putFile({
      creds: ticket.credentials,
      key: o.key,
      file: f.abs,
      size: f.size,
      sha256: f.sha256,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
    });
  }
  const answer = (await client.postJson("assets", {
    what: "Pushing the hosted assets",
    body: {
      ticket: ticket.ticket,
      assets: files.map((f) => ({
        slot: f.slot,
        ...(f.locale ? { locale: f.locale } : {}),
        sha256: f.sha256,
        size: f.size,
      })),
    },
  })) as unknown as Partial<PushAnswer>;
  const result: PushAnswer = {
    ok: answer.ok === true,
    stored: answer.stored ?? [],
    kept: answer.kept ?? [],
    refused: answer.refused ?? [],
  };
  for (const s of result.stored)
    out.write(
      `Hosted ${where(s.slot, s.locale)}: ${s.size} bytes, sha256 ${s.sha256}\n`,
    );
  for (const k of result.kept)
    out.write(
      `Kept ${where(k.slot, k.locale)}: ${
        k.reason === "console"
          ? "the console's upload wins"
          : "the manifest names this slot"
      }\n`,
    );
  for (const r of result.refused)
    opts.stderr.write(`Refused ${where(r.slot, r.locale)}: ${r.reason}\n`);
  out.write(
    `Pushed to ${opts.product}: ${result.stored.length} hosted, ${result.kept.length} kept, ${result.refused.length} refused.\n`,
  );
  return result;
}

// ── The Action's `assets` input ────────────────────────────────────────────────────────────

/** One line of the `assets` input: a glob and the slot (with an optional `@<locale>`). */
export interface AssetMapLine {
  glob: string;
  slot: string;
  locale?: string;
}

/**
 * Parse the `assets` input: one `<glob>: <slot>[@<locale>]` per line, split at the LAST `": "`
 * (a slot never holds a space); blank lines and `#` comments are skipped.
 */
export function parseAssetMap(input: string): AssetMapLine[] {
  const out: AssetMapLine[] = [];
  for (const [i, raw] of input.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.lastIndexOf(": ");
    if (at <= 0)
      throw new Error(
        `assets line ${i + 1} must be "<glob>: <slot>[@<locale>]" (got ${JSON.stringify(line)}).`,
      );
    const glob = line.slice(0, at).trim();
    const target = line.slice(at + 2).trim();
    const [slot, locale, extra] = target.split("@");
    if (!glob || !slot || extra !== undefined || locale === "")
      throw new Error(
        `assets line ${i + 1} must be "<glob>: <slot>[@<locale>]" (got ${JSON.stringify(line)}).`,
      );
    out.push({ glob, slot, ...(locale !== undefined ? { locale } : {}) });
  }
  if (out.length === 0) throw new Error("The assets input names no file.");
  return out;
}

/** A glob (`*` within a segment, `**` across segments, `?` one character) as a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches the rest.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Every file under `dir`, as POSIX paths relative to it (`.git` and `node_modules` skipped). */
async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, child)));
    else if (e.isFile()) out.push(child);
  }
  return out;
}

/**
 * Resolve the `assets` map against `base`: each glob must match exactly one file, except a line
 * whose slot is the unnumbered `listing.screenshot`, whose matches become `listing.screenshot:1`
 * to `:n` in sorted path order (n ≤ 16).
 */
export async function resolveAssetMap(
  base: string,
  lines: readonly AssetMapLine[],
): Promise<AssetEntry[]> {
  const files = (await walk(base)).sort();
  const out: AssetEntry[] = [];
  for (const l of lines) {
    const re = globToRegExp(l.glob);
    const hits = files.filter((f) => re.test(f));
    const loc = l.locale !== undefined ? { locale: l.locale } : {};
    if (l.slot === "listing.screenshot") {
      if (hits.length === 0)
        throw new Error(`assets: ${l.glob} matches no file.`);
      if (hits.length > MAX_SCREENSHOTS)
        throw new Error(
          `assets: ${l.glob} matches ${hits.length} screenshots; the listing holds ${MAX_SCREENSHOTS}.`,
        );
      hits.forEach((f, i) =>
        out.push({
          file: path.join(base, f),
          slot: `listing.screenshot:${i + 1}`,
          ...loc,
        }),
      );
      continue;
    }
    if (hits.length !== 1)
      throw new Error(
        hits.length === 0
          ? `assets: ${l.glob} matches no file.`
          : `assets: ${l.glob} matches ${hits.length} files (${hits.slice(0, 5).join(", ")}); ${l.slot} takes exactly one.`,
      );
    out.push({ file: path.join(base, hits[0]!), slot: l.slot, ...loc });
  }
  return out;
}

/**
 * The content stamp and an app release's `content` (P4-03; plans/P4-01.md §2.4, §2.8, decisions
 * 9, 25, 37).
 *
 * `pkey release content-stamp --embedded <dir> [--pin <packId>@<version> …] --out
 * pkey-content.json` writes the `pkey-content/1` stamp a build embeds BEFORE its export: the app
 * record's `content`, from
 *
 *   - the markers under `--embedded` (`X.pkey.json` beside a single-file payload,
 *     `D/.pkey/pack.json` inside a tree): each is verified as a device would (strict JSON, the
 *     format, the record's signature under `.pkey/release`'s `releaseKeys`, the record claims,
 *     the cross-check), and the payload beside it must be one of the record's variants, so a
 *     stale marker never becomes a pin;
 *   - `--pin <packId>@<version>`, resolved through the uploads preflight, whose
 *     `seqs[].recordSha256` names the stored record (a pack not embedded in this build);
 *   - `--hold <packId>@<version>[=<reason>]` (P4-13, plans/P4-13.md §2.4 and decision 17),
 *     resolved the same way: this app release keeps a `compatible` pack at that release. Holds
 *     go into the stamp's `holds` (never for a pinned pack) and reach devices in the stamp;
 *     `parseContentStamp` ignores them and `holdsOf` reads them;
 *   - `.pkey/release`: `contentApi` from `deliverables.app.content`, and each pin's `required`
 *     and `delivery` as its `expects` entry.
 *
 * Publish rules checked here as ingest checks them (§3): every pin is expected and every expect
 * pinned (v1); every `required` and every `baseline: embedded` pack is pinned; each build's
 * `embeds` ⊆ the pins; `contentApi` is the manifest's.
 *
 * `pkey release publish --deliverable app --content-stamp <file>` then puts the stamp (without
 * its `format`) into the release DESCRIPTOR's `content`, and each build's `embeds` from the
 * artifact map, never into the record directly: `descriptorToRecord` moves both, so the record the
 * CLI signs is the one ingest rebuilds (decision 37).
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanStrictJson, verifyJws } from "@polaris-key/jws";
import {
  CONTENT_STAMP_FORMAT,
  MARKER_FORMAT,
} from "@polaris-key/protocol/core";
import {
  MARKER_SUFFIX,
  type AppContent,
  type ContentHold,
  type ContentPin,
  type PackRecordDoc,
} from "@polaris-key/protocol/packs";
import {
  MAX_HOLD_REASON,
  type ManifestArtifactEntry,
  type ManifestPackDeliverable,
  type ManifestReleaseKey,
} from "@polaris-key/manifest";
import { releaseRecordClaims, isPackId } from "@polaris-key/client-core/record";
import { holdsOf, parseContentStamp } from "@polaris-key/client-core/packs";
import { ciClient, type CiClient, type Out, type Sleep } from "./ci.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";
import { packContext, requirePacksDiscovery } from "./packManifest.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";
import { payloadIdentity, readTree, sha256Hex } from "./packArtifacts.js";

export const CONTENT_STAMP_USAGE =
  "Usage: pkey release content-stamp --product <slug> --out <file> " +
  "[--embedded <dir>] [--pin <packId>@<version> ...] " +
  "[--hold <packId>@<version>[=<reason>] ...] [--base-url <url>]";

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** One pin and where it came from (a marker's path, or `--pin`). */
export interface SourcedPin extends ContentPin {
  source: string;
}

// ── Markers ──────────────────────────────────────────────────────────────────

/** Every marker under `dir`: `*.pkey.json` files and `.pkey/pack.json` files. */
async function findMarkers(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (
        e.isFile() &&
        (e.name.endsWith(MARKER_SUFFIX) ||
          (e.name === "pack.json" && path.basename(d) === ".pkey"))
      )
        out.push(full);
    }
  }
  try {
    await walk(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`--embedded ${dir} does not exist.`);
    throw e;
  }
  return out.sort();
}

/**
 * Verify one marker (WIRE-CONTRACT-V4 §3.7's order) and match the payload beside it against the
 * record's variants. Returns the pin, or throws with the marker's path and the failing step.
 */
export async function readMarker(
  file: string,
  ctx: { product: string; releaseKeys: readonly ManifestReleaseKey[] },
): Promise<SourcedPin & { record: PackRecordDoc }> {
  const fail = (step: string, why: string): never => {
    throw new Error(`${file}: marker rejected at ${step}: ${why}`);
  };
  const text = await readFile(file, "utf8");
  if (!scanStrictJson(text).ok) fail("format", "not strict JSON");
  const m = JSON.parse(text) as Record<string, unknown>;
  if (
    !m ||
    typeof m !== "object" ||
    m.format !== MARKER_FORMAT ||
    !isPackId(m.packId) ||
    typeof m.version !== "string" ||
    !VERSION_RE.test(m.version) ||
    typeof m.release !== "string"
  )
    fail("format", `not a ${MARKER_FORMAT} document`);
  const jws = m.release as string;
  const trust: Record<string, string> = {};
  for (const k of ctx.releaseKeys) trust[k.kid] = k.publicKey;
  const v = await verifyJws(jws, trust, { typ: "pkey-release+jws" });
  if (!v)
    fail("jws", "the record does not verify under .pkey/release's releaseKeys");
  if (
    !releaseRecordClaims(v!.payload, {
      expectedAud: ctx.product,
      nonWire: v!.nonWireIntegers,
    })
  )
    fail("claims", "the record fails the record claims");
  const record = v!.payload as unknown as PackRecordDoc;
  if (
    record.kind !== "pack" ||
    record.deliverable !== m.packId ||
    record.version !== m.version
  )
    fail("cross-check", "the record is not this marker's pack release");
  // The payload beside it must be one of the record's variants.
  let identity: { size: number; sha256: string };
  if (file.endsWith(MARKER_SUFFIX)) {
    const payloadFile = file.slice(0, -MARKER_SUFFIX.length);
    let bytes: Buffer;
    try {
      bytes = await readFile(payloadFile);
    } catch {
      return fail("payload", `${path.basename(payloadFile)} is not beside it`);
    }
    identity = { size: bytes.byteLength, sha256: sha256Hex(bytes) };
  } else {
    const root = path.dirname(path.dirname(file));
    const tree = await readTree(root);
    identity = await payloadIdentity({ layout: "tree", files: tree.files });
  }
  if (
    !record.variants.some(
      (x) =>
        x.payload.sha256 === identity.sha256 &&
        x.payload.size === identity.size,
    )
  )
    fail(
      "payload",
      `the payload (sha256 ${identity.sha256.slice(0, 12)}…) is none of ${record.deliverable} ${record.version}'s variants: a stale marker`,
    );
  return {
    pack: record.deliverable,
    release: {
      sha256: sha256Hex(jws),
      seq: record.seq,
      version: record.version,
    },
    source: file,
    record,
  };
}

// ── --pin ────────────────────────────────────────────────────────────────────

export function parsePinFlag(
  value: string,
  flag = "--pin",
): { pack: string; version: string } {
  const at = value.lastIndexOf("@");
  const pack = value.slice(0, at);
  const version = value.slice(at + 1);
  if (at < 1 || !isPackId(pack) || !VERSION_RE.test(version))
    throw new Error(`${flag} ${value} must be <packId>@<version>.`);
  return { pack, version };
}

/** `--hold <packId>@<version>[=<reason>]`: the reason follows the first `=` (pack ids and
 *  versions never contain one), 1–`MAX_HOLD_REASON` characters. */
export function parseHoldFlag(value: string): {
  pack: string;
  version: string;
  reason?: string;
} {
  const eq = value.indexOf("=");
  const spec = eq < 0 ? value : value.slice(0, eq);
  const { pack, version } = parsePinFlag(spec, "--hold");
  if (eq < 0) return { pack, version };
  const reason = value.slice(eq + 1);
  if (reason === "" || reason.length > MAX_HOLD_REASON)
    throw new Error(
      `--hold ${value}: the reason after "=" must be 1–${MAX_HOLD_REASON} characters.`,
    );
  return { pack, version, reason };
}

/** Resolve `--pin` flags through the uploads preflight's `seqs[].recordSha256`. */
export async function resolvePins(
  client: CiClient,
  flags: readonly string[],
  flag = "--pin",
): Promise<SourcedPin[]> {
  if (flags.length === 0) return [];
  const wanted = flags.map((f) => parsePinFlag(f, flag));
  const out: SourcedPin[] = [];
  for (let i = 0; i < wanted.length; i += 16) {
    const slice = wanted.slice(i, i + 16);
    const answer = await client.postJson<{
      seqs?: {
        deliverable: string;
        version: string;
        seq: number;
        recordSha256?: string;
      }[];
    }>("release/publish/uploads", {
      what: `Resolving ${flag} through Polaris Key`,
      body: {
        releases: slice.map((w) => ({
          deliverable: w.pack,
          version: w.version,
        })),
      },
    });
    for (const w of slice) {
      const s = answer.seqs?.find(
        (x) => x.deliverable === w.pack && x.version === w.version,
      );
      if (!s?.recordSha256)
        throw new Error(
          `${flag} ${w.pack}@${w.version}: Polaris Key stores no record for that pack release (publish it first).`,
        );
      out.push({
        pack: w.pack,
        release: { sha256: s.recordSha256, seq: s.seq, version: w.version },
        source: flag,
      });
    }
  }
  return out;
}

/**
 * Resolve `--hold` flags (P4-13) like `--pin`, and check them against the release: one hold per
 * pack, never a pinned pack, only a pack `.pkey/release` declares with binding `compatible`
 * (ingest refuses the rest as `hold-binding`). Sorted by pack id.
 */
export async function resolveHolds(
  client: CiClient,
  flags: readonly string[],
  packs: readonly ManifestPackDeliverable[],
  pins: readonly ContentPin[],
): Promise<ContentHold[]> {
  if (flags.length === 0) return [];
  const parsed = flags.map(parseHoldFlag);
  const seen = new Set<string>();
  const pinned = new Set(pins.map((p) => p.pack));
  const decl = new Map(packs.map((p) => [p.id, p]));
  for (const h of parsed) {
    if (seen.has(h.pack))
      throw new Error(`--hold ${h.pack} is given twice; hold a pack once.`);
    seen.add(h.pack);
    if (pinned.has(h.pack))
      throw new Error(
        `--hold ${h.pack}: this release pins ${h.pack}, and a pinned pack is never held.`,
      );
    const d = decl.get(h.pack);
    if (!d)
      throw new Error(`--hold ${h.pack} is not a pack .pkey/release declares.`);
    if (d.binding !== "compatible")
      throw new Error(
        `--hold ${h.pack}: its binding is ${d.binding}; a hold keeps a compatible pack at one release.`,
      );
  }
  const resolved = await resolvePins(
    client,
    parsed.map((h) => `${h.pack}@${h.version}`),
    "--hold",
  );
  return parsed
    .map((h) => {
      const r = resolved.find((x) => x.pack === h.pack)!;
      return {
        pack: h.pack,
        release: { ...r.release },
        ...(h.reason !== undefined ? { reason: h.reason } : {}),
      };
    })
    .sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0));
}

// ── The content and its publish rules ────────────────────────────────────────

/** Merge marker and `--pin` pins: one pin per pack, conflicting pins refused. */
export function mergePins(pins: readonly SourcedPin[]): SourcedPin[] {
  const by = new Map<string, SourcedPin>();
  for (const p of pins) {
    const prior = by.get(p.pack);
    if (prior && prior.release.sha256 !== p.release.sha256)
      throw new Error(
        `${p.pack} is pinned twice with different releases: ${prior.release.version} (${prior.source}) and ${p.release.version} (${p.source}).`,
      );
    if (!prior) by.set(p.pack, p);
  }
  return [...by.values()].sort((a, b) =>
    a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0,
  );
}

/** The `content` for `pins`: `expects` from each pinned pack's declaration (v1: pins = expects). */
export function contentFor(
  contentApi: number,
  packs: readonly ManifestPackDeliverable[],
  pins: readonly SourcedPin[],
): AppContent {
  const decl = new Map(packs.map((p) => [p.id, p]));
  for (const p of pins)
    if (!decl.has(p.pack))
      throw new Error(
        `${p.pack} (${p.source}) is not a pack .pkey/release declares.`,
      );
  return {
    contentApi,
    pins: pins.map((p) => ({ pack: p.pack, release: { ...p.release } })),
    expects: pins.map((p) => ({
      pack: p.pack,
      required: decl.get(p.pack)!.required,
      delivery: decl.get(p.pack)!.delivery,
    })),
  };
}

/** Each build's `embeds`: the artifact map's, or every `baseline: embedded` pack when omitted. */
export function embedsFor(
  entry: Pick<ManifestArtifactEntry, "embeds">,
  packs: readonly ManifestPackDeliverable[],
): string[] {
  return entry.embeds
    ? [...entry.embeds]
    : packs.filter((p) => p.baseline === "embedded").map((p) => p.id);
}

/**
 * The publish rules an app release's `content` must meet (plans/P4-01.md §3; ingest refuses the
 * same as `content-api`, `pin-missing` and `embeds`): one message per broken rule.
 */
export function contentRuleProblems(
  content: AppContent,
  contentApi: number | undefined,
  packs: readonly ManifestPackDeliverable[],
  embeds: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const problems: string[] = [];
  if (contentApi === undefined)
    problems.push(
      ".pkey/release declares packs but no deliverables.app.content.contentApi.",
    );
  else if (content.contentApi !== contentApi)
    problems.push(
      `the stamp's contentApi ${content.contentApi} is not .pkey/release's ${contentApi}.`,
    );
  const pinned = new Set(content.pins.map((p) => p.pack));
  const expected = new Set(content.expects.map((e) => e.pack));
  for (const p of pinned)
    if (!expected.has(p)) problems.push(`${p} is pinned but not expected.`);
  for (const e of expected)
    if (!pinned.has(e))
      problems.push(
        `${e} is expected but not pinned (v1 pins every expected pack).`,
      );
  const declared = new Set(packs.map((p) => p.id));
  for (const p of pinned)
    if (!declared.has(p))
      problems.push(`${p} is pinned but .pkey/release does not declare it.`);
  for (const p of packs) {
    if (p.required && !pinned.has(p.id))
      problems.push(`${p.id} is required, so every app release pins it.`);
    if (p.baseline === "embedded" && !pinned.has(p.id))
      problems.push(
        `${p.id} is baseline: embedded, so every app release pins it.`,
      );
  }
  for (const [build, list] of Object.entries(embeds))
    for (const p of list)
      if (!pinned.has(p))
        problems.push(
          `build ${build} embeds ${p}, which the release does not pin.`,
        );
  return problems;
}

/** The stamp file's text (`pkey-content/1`), checked by client-core's `parseContentStamp` and,
 *  when it carries holds, `holdsOf` (P4-13). */
export function stampText(content: AppContent): string {
  const holds = content.holds ?? [];
  const doc = {
    format: CONTENT_STAMP_FORMAT,
    contentApi: content.contentApi,
    pins: content.pins,
    expects: content.expects,
    ...(holds.length > 0 ? { holds } : {}),
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (!parseContentStamp(text).ok)
    throw new Error("Self-check: the content stamp fails parseContentStamp.");
  if (
    JSON.stringify(holdsOf(JSON.parse(text), undefined, "")) !==
    JSON.stringify(holds)
  )
    throw new Error("Self-check: the content stamp's holds fail holdsOf.");
  return text;
}

/** Read a `--content-stamp` file through client-core's `parseContentStamp`. */
export async function readContentStamp(file: string): Promise<AppContent> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error(`--content-stamp ${file} is not readable.`);
  }
  const parsed = parseContentStamp(new Uint8Array(bytes));
  if (!parsed.ok)
    throw new Error(
      `--content-stamp ${file} is not a valid ${CONTENT_STAMP_FORMAT} stamp (content-stamp-invalid).`,
    );
  // `parseContentStamp` ignores holds (plans/P4-13.md §2.4); read them beside it, with the
  // stamp's own token rule, so they reach the descriptor and the record.
  const scan = scanStrictJson(new TextDecoder().decode(bytes));
  const holds = holdsOf(
    JSON.parse(new TextDecoder().decode(bytes)),
    scan.ok ? scan.nonWireIntegers : undefined,
    "",
  );
  if (holds === null)
    throw new Error(
      `--content-stamp ${file}: its holds are malformed (each {pack, release {sha256, seq, version}, reason?}, never a pinned pack).`,
    );
  return holds.length > 0 ? { ...parsed.content, holds } : parsed.content;
}

/** The pins from `--embedded` markers. */
export async function markerPins(
  dir: string,
  ctx: { product: string; releaseKeys: readonly ManifestReleaseKey[] },
): Promise<SourcedPin[]> {
  const pins: SourcedPin[] = [];
  for (const file of await findMarkers(dir)) {
    const { record: _record, ...pin } = await readMarker(file, ctx);
    pins.push(pin);
  }
  return pins;
}

/**
 * The content a release carries. A pin's seq and record hash are Polaris Key's answer to
 * `resolvePins`, so they are cleaned (`untrusted.ts`) like any other server text.
 */
export function describeContent(
  out: Out,
  content: AppContent,
  pins: readonly SourcedPin[],
  env: UntrustedEnv = {},
): void {
  const u = (v: unknown) => untrusted(v, env);
  out.write(`Content: contentApi ${u(content.contentApi)}\n`);
  if (content.pins.length === 0) out.write("  pins: none\n");
  for (const p of content.pins) {
    const src = pins.find((x) => x.pack === p.pack)?.source;
    const e = content.expects.find((x) => x.pack === p.pack);
    out.write(
      `  pin ${u(p.pack)}@${u(p.release.version)} (seq ${u(p.release.seq)}, record ${u(String(p.release.sha256).slice(0, 12))}…)` +
        `${e ? ` ${e.required ? "required" : "optional"}, ${u(e.delivery)}` : ""}${src ? ` — from ${u(src)}` : ""}\n`,
    );
  }
  for (const h of content.holds ?? [])
    out.write(
      `  hold ${u(h.pack)}@${u(h.release.version)} (seq ${u(h.release.seq)}, record ${u(String(h.release.sha256).slice(0, 12))}…)` +
        `${h.reason !== undefined ? ` — ${u(h.reason)}` : ""}\n`,
    );
}

// ── `pkey release content-stamp` ─────────────────────────────────────────────

export interface ContentStampOptions {
  cwd: string;
  product: string;
  out: string;
  embedded?: string;
  pins?: string[];
  /** `--hold <packId>@<version>[=<reason>]` (P4-13). */
  holds?: string[];
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

export async function writeContentStampFile(
  opts: ContentStampOptions,
): Promise<{ content: AppContent; file: string }> {
  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const ctx = packContext(loaded);
  if (ctx.slug !== opts.product)
    throw new Error(
      `--product ${opts.product} does not match .pkey/product's slug ${ctx.slug}.`,
    );
  if (ctx.packs.length === 0)
    throw new Error(
      ".pkey/release declares no pack deliverables; there is nothing to stamp.",
    );
  const contentApi = ctx.app?.content?.contentApi;
  if (contentApi === undefined)
    throw new Error(
      ".pkey/release declares packs but no deliverables.app.content.contentApi.",
    );
  const pins: SourcedPin[] = [];
  if (opts.embedded)
    pins.push(
      ...(await markerPins(path.resolve(opts.cwd, opts.embedded), {
        product: opts.product,
        releaseKeys: ctx.releaseKeys,
      })),
    );
  let client: CiClient | null = null;
  if (opts.pins?.length || opts.holds?.length) {
    const token = await resolveCiToken({
      baseUrl: opts.baseUrl,
      product: opts.product,
      env: opts.env,
      out: opts.stdout,
      log: opts.stderr,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
    client = ciClient({
      baseUrl: opts.baseUrl,
      product: opts.product,
      token,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
      env: opts.env,
    });
    await requirePacksDiscovery(client, opts.fetchImpl);
    pins.push(...(await resolvePins(client, opts.pins ?? [])));
  }
  const merged = mergePins(pins);
  const content = contentFor(contentApi, ctx.packs, merged);
  if (client && opts.holds?.length) {
    const holds = await resolveHolds(client, opts.holds, ctx.packs, merged);
    if (holds.length > 0) content.holds = holds;
  }
  const problems = contentRuleProblems(content, contentApi, ctx.packs);
  if (problems.length)
    throw new Error(
      `The content stamp breaks the publish rules:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
  const file = path.resolve(opts.cwd, opts.out);
  await writeFile(file, stampText(content));
  describeContent(opts.stdout, content, merged, opts.env);
  opts.stdout.write(`Wrote ${path.relative(opts.cwd, file) || file}\n`);
  return { content, file };
}

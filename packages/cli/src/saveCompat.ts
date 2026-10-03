/**
 * Save compatibility in CI (P4-20, CONTENT §6.2, §6.7 item 8).
 *
 * PROVIDES AND REMOVES. `pkey release publish --deliverable <packId>` signs the content ids a pack
 * release provides into the record's record-level `provides` (a member WIRE-CONTRACT-V4 §2.5.1
 * reserves): from `--provides <file>`, else from the pack's declared `provides.from` (default
 * `.pkey/provides.json`). The file is a JSON array of content ids (printable ASCII without
 * spaces, 1–128 characters, at most 4,096, distinct); pkey signs it sorted. `provides.required`
 * fails a publish without the file. `--removes <id>` (repeatable, or comma-separated)
 * acknowledges ids this release stops providing; the Worker refuses an unacknowledged drop
 * (`provides-dropped`) at every live contentApi level both releases support.
 *
 * THE CONTENT-INTERFACE FINGERPRINT. `pkey release publish --content-interface <file>` (the app)
 * hashes an explicit registry of what the code references (for Diceroll, its content-id registry
 * and the path prefixes it loads, exported to JSON): the SHA-256 of the file's canonical JSON
 * (object keys sorted by UTF-16 code unit, no whitespace), so formatting and key order never
 * move it. It is sent beside the descriptor and stored as unsigned release metadata, never in the
 * record. The Worker answers the channel's current app release's fingerprint and contentApi, and
 * this module compares: a changed fingerprint with an unchanged contentApi is a warning, or a
 * failure with `--strict`, because the code may expect a content shape the packs on that
 * contentApi line do not have (bump contentApi). Deriving the registry from a Godot project is
 * CONTENT §17 question 10, still open.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  providesListProblem,
  type ManifestPackDeliverable,
} from "@polaris-key/manifest";

/** UTF-16 code-unit order, as `Array.prototype.sort` without a comparator. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** `value` as canonical JSON: object keys sorted by code unit, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort(byCodeUnit)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${what} ${file} does not exist.`);
    throw e;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`${what} ${file} is not JSON: ${(e as Error).message}`);
  }
}

/** `--removes` values: each may be a comma-separated list. */
export function parseRemoves(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * The record-level `provides` and `removes` a pack release signs, sorted. `providesFile` is
 * `--provides` (relative to `cwd`); without it the declared policy's `from` is read, and a missing
 * file is a failure only under `provides.required` (otherwise a warning when a policy is
 * declared).
 */
export async function collectProvides(o: {
  cwd: string;
  pack: Pick<ManifestPackDeliverable, "id" | "provides">;
  providesFile?: string;
  removes?: readonly string[];
  warn: (w: string) => void;
}): Promise<{ provides?: string[]; removes?: string[] }> {
  const out: { provides?: string[]; removes?: string[] } = {};
  const policy = o.pack.provides;
  let file: string | null = null;
  if (o.providesFile !== undefined) file = path.resolve(o.cwd, o.providesFile);
  else if (policy) {
    const declared = path.resolve(o.cwd, policy.from);
    try {
      await readFile(declared);
      file = declared;
    } catch {
      if (policy.required)
        throw new Error(
          `${o.pack.id} declares provides.required, and ${policy.from} does not exist: write the JSON array of content ids the release provides there (or pass --provides <file>).`,
        );
      o.warn(
        `${o.pack.id} declares provides, and ${policy.from} does not exist: the record carries no provides.`,
      );
    }
  }
  if (file !== null) {
    const list = await readJson(file, "The provides file");
    const problem = providesListProblem(list);
    if (problem)
      throw new Error(
        `The provides file ${path.relative(o.cwd, file) || file} ${problem}.`,
      );
    out.provides = [...(list as string[])].sort(byCodeUnit);
  }
  if (o.removes && o.removes.length > 0) {
    const problem = providesListProblem(o.removes);
    if (problem) throw new Error(`--removes ${problem}.`);
    out.removes = [...o.removes].sort(byCodeUnit);
  }
  return out;
}

/** The SHA-256 of a content-interface registry file's canonical JSON. */
export async function contentInterfaceFingerprint(
  cwd: string,
  file: string,
): Promise<string> {
  const value = await readJson(
    path.resolve(cwd, file),
    "The content-interface registry",
  );
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The Worker's `contentInterface` answer (`release/publish/submit`). */
interface InterfaceAnswer {
  sha256?: unknown;
  previous?: {
    releaseId?: unknown;
    version?: unknown;
    contentApi?: unknown;
    sha256?: unknown;
  } | null;
}

/**
 * Compare this release's fingerprint with the channel's current app release's. Returns the
 * warning (null when there is nothing to say); throws it with `strict`.
 */
export function judgeContentInterface(
  answer: unknown,
  fingerprint: string,
  contentApi: number | null,
  strict: boolean,
): { warning: string | null; note: string } {
  const a = (answer ?? {}) as InterfaceAnswer;
  if (a.sha256 === undefined)
    throw new Error(
      "The server answered no contentInterface (a Polaris Key without P4-20?); the fingerprint was not stored.",
    );
  const prev = a.previous ?? null;
  if (prev === null)
    return {
      warning: null,
      note: "the channel serves no app release yet: nothing to compare",
    };
  const name = `${String(prev.releaseId)}`;
  if (typeof prev.sha256 !== "string")
    return {
      warning: null,
      note: `${name} was published without a fingerprint: nothing to compare`,
    };
  if (prev.sha256 === fingerprint)
    return { warning: null, note: `unchanged since ${name}` };
  if (prev.contentApi !== contentApi)
    return {
      warning: null,
      note: `changed since ${name}, with contentApi ${String(prev.contentApi)} → ${String(contentApi)}`,
    };
  const warning = `the content interface changed since ${name} (${prev.sha256.slice(0, 12)}… → ${fingerprint.slice(0, 12)}…), but contentApi is still ${String(contentApi)}: packs on that contentApi line may not have the content shape this build expects. Bump deliverables.app.content.contentApi${strict ? "" : ", or pass --strict to fail on this"}.`;
  if (strict) throw new Error(`--strict: ${warning}`);
  return { warning, note: `changed since ${name}` };
}

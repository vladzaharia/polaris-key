/**
 * `pkey validate --fix` (P0-45): the repairs that cannot change what the platform reads. Today
 * that is one family: a field written in an old spelling moves to its canonical place when the
 * canonical place is empty (the validator's `deprecated_spelling` warnings, `DEPRECATED_SPELLINGS`
 * in `@polaris-key/manifest`, the one list). Nothing is guessed:
 *
 *   - a value is never overwritten (both spellings set is a conflict the author resolves);
 *   - a spelling the reader ignores, merges or refuses is left alone, since moving it would
 *     change what is read;
 *   - an array element, and a release body field (moving one would hide its siblings behind the
 *     `release:` wrapper), is left alone.
 *
 * YAML keeps its comments and layout (the `yaml` Document is edited in place); JSON is rewritten
 * with two-space indentation.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument, type Document } from "yaml";
import {
  DEPRECATED_SPELLINGS,
  type DeprecatedSpelling,
} from "@polaris-key/manifest";
import type { LoadedManifest } from "./manifest.js";

export interface FixMove {
  /** The `.pkey/` file, relative to the directory `pkey` ran in. */
  file: string;
  from: string;
  to: string;
}

type DocName = DeprecatedSpelling["doc"];

/** The spellings `--fix` may move, in the registry's order. */
export function fixableSpellings(): DeprecatedSpelling[] {
  return DEPRECATED_SPELLINGS.filter(
    (s) =>
      s.code === "deprecated_spelling" &&
      s.canonicalPointer !== null &&
      s.canonicalPointer.doc === s.doc &&
      !s.pointer.includes("*") &&
      !s.canonicalPointer.pointer.includes("*") &&
      (s.wins === "canonical" || s.wins === "deprecated") &&
      !s.unreadWhenWrapped &&
      !s.checkedElsewhere,
  );
}

const segments = (pointer: string): string[] =>
  pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

/** A document being edited, however it is stored. */
interface Editable {
  get(p: string[]): unknown;
  /** The value as `set` takes it back: a YAML node keeps its comments and style. */
  take(p: string[]): unknown;
  set(p: string[], v: unknown): void;
  remove(p: string[]): void;
  text(): string;
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null;

function jsonEditable(value: Record<string, unknown>): Editable {
  const walk = (p: string[]): unknown => {
    let cur: unknown = value;
    for (const k of p) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur))
        return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  };
  return {
    get: walk,
    take: walk,
    set(p, v) {
      let cur = value;
      for (const k of p.slice(0, -1)) {
        const next = cur[k];
        if (next === null || typeof next !== "object" || Array.isArray(next))
          cur[k] = {};
        cur = cur[k] as Record<string, unknown>;
      }
      cur[p.at(-1)!] = v;
    },
    remove(p) {
      const parent = walk(p.slice(0, -1));
      if (parent && typeof parent === "object")
        delete (parent as Record<string, unknown>)[p.at(-1)!];
    },
    text: () => `${JSON.stringify(value, null, 2)}\n`,
  };
}

function yamlEditable(doc: Document): Editable {
  return {
    get: (p) => doc.getIn(p),
    take: (p) => doc.getIn(p, true),
    set: (p, v) => doc.setIn(p, v),
    remove: (p) => {
      doc.deleteIn(p);
    },
    text: () => doc.toString(),
  };
}

/**
 * Apply every fix to the manifest's files, writing a file only when something moved in it.
 * `manifest` is what `loadManifest` read; reload it after.
 */
export async function fixManifest(
  manifest: LoadedManifest,
  cwd: string,
): Promise<FixMove[]> {
  const files: Partial<Record<DocName, string>> = {
    product: manifest.productPath,
    schema: manifest.schemaPath,
    release: manifest.releasePath,
    distribution: manifest.distributionPath,
  };
  const moves: FixMove[] = [];
  for (const [name, file] of Object.entries(files) as Array<
    [DocName, string | undefined]
  >) {
    if (!file) continue;
    const raw = await readFile(file, "utf8");
    const edit: Editable = file.endsWith(".json")
      ? jsonEditable(JSON.parse(raw) as Record<string, unknown>)
      : yamlEditable(parseDocument(raw));
    let changed = false;
    for (const s of fixableSpellings().filter((x) => x.doc === name)) {
      const from = segments(s.pointer);
      const to = segments(s.canonicalPointer!.pointer);
      if (!isSet(edit.get(from)) || isSet(edit.get(to))) continue;
      const value = edit.take(from);
      edit.set(to, value);
      edit.remove(from);
      changed = true;
      moves.push({
        file: path.relative(cwd, file),
        from: s.pointer,
        to: s.canonicalPointer!.pointer,
      });
    }
    if (changed) await writeFile(file, edit.text());
  }
  return moves;
}

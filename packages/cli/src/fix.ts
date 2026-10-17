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
      if (cur === null || typeof cur !== "object") return undefined;
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
        if (next === null || typeof next !== "object") cur[k] = {};
        cur = cur[k] as Record<string, unknown>;
      }
      cur[p.at(-1)!] = v;
    },
    remove(p) {
      const parent = walk(p.slice(0, -1));
      if (Array.isArray(parent)) parent.splice(Number(p.at(-1)), 1);
      else if (parent && typeof parent === "object")
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

/** A YAML node or a plain value, as plain data. */
const plain = (v: unknown): unknown =>
  v !== null && typeof v === "object" && "toJSON" in v
    ? (v as { toJSON(): unknown }).toJSON()
    : v;

/** The length of a plain array or a YAML sequence node. */
const lengthOf = (v: unknown): number =>
  Array.isArray(v)
    ? v.length
    : ((v as { items?: unknown[] } | undefined)?.items?.length ?? 0);

/** One `.pkey/` document being edited, with the path it was read from. */
interface OpenDoc {
  file: string;
  edit: Editable;
  changed: boolean;
}

/**
 * U-31: a legacy `edgeMint[]` recipe moves into the `mint` block of the catalog entry of the same
 * id, when that entry is a minted token with no block yet. The recipe's fields are unchanged
 * (the block is the recipe minus its `id`), so what the platform reads is the same. A recipe with
 * no such entry stays where it is: nothing to move it to without inventing an entry. The
 * recipes may sit in `.pkey/product` or in the release document's root (a deprecated place).
 */
function moveLegacyRecipes(
  docs: Partial<Record<DocName, OpenDoc>>,
  cwd: string,
  moves: FixMove[],
): void {
  const schema = docs.schema;
  if (!schema) return;
  for (const name of ["product", "release"] as const) {
    const doc = docs[name];
    if (!doc) continue;
    for (let i = lengthOf(doc.edit.get(["edgeMint"])) - 1; i >= 0; i--) {
      const recipe = plain(doc.edit.get(["edgeMint", String(i)])) as Record<
        string,
        unknown
      >;
      const id = recipe?.id;
      if (typeof id !== "string") continue;
      for (const list of ["entries", "catalog"]) {
        const n = lengthOf(schema.edit.get([list]));
        for (let j = 0; j < n; j++) {
          const at = [list, String(j)];
          if (
            schema.edit.get([...at, "key"]) !== id ||
            schema.edit.get([...at, "kind"]) !== "secret" ||
            schema.edit.get([...at, "delivery"]) !== "edgeMint" ||
            isSet(schema.edit.get([...at, "mint"]))
          )
            continue;
          const { id: _id, ...block } = recipe;
          schema.edit.set([...at, "mint"], block);
          doc.edit.remove(["edgeMint", String(i)]);
          if (lengthOf(doc.edit.get(["edgeMint"])) === 0)
            doc.edit.remove(["edgeMint"]);
          schema.changed = doc.changed = true;
          moves.push({
            file: path.relative(cwd, doc.file),
            from: `/edgeMint/${i}`,
            to: `${path.relative(cwd, schema.file)}#/${list}/${j}/mint`,
          });
        }
      }
    }
  }
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
  const open: Partial<Record<DocName, OpenDoc>> = {};
  for (const [name, file] of Object.entries(files) as Array<
    [DocName, string | undefined]
  >) {
    if (!file) continue;
    const raw = await readFile(file, "utf8");
    const edit: Editable = file.endsWith(".json")
      ? jsonEditable(JSON.parse(raw) as Record<string, unknown>)
      : yamlEditable(parseDocument(raw));
    const doc: OpenDoc = { file, edit, changed: false };
    open[name] = doc;
    for (const s of fixableSpellings().filter((x) => x.doc === name)) {
      const from = segments(s.pointer);
      const to = segments(s.canonicalPointer!.pointer);
      if (!isSet(edit.get(from)) || isSet(edit.get(to))) continue;
      const value = edit.take(from);
      edit.set(to, value);
      edit.remove(from);
      doc.changed = true;
      moves.push({
        file: path.relative(cwd, file),
        from: s.pointer,
        to: s.canonicalPointer!.pointer,
      });
    }
    // U-30: `secret: true` on a `kind: secret` entry says what the kind already says, and
    // ingest drops it. A `config` entry's `secret: true` is left alone: moving it to
    // `kind: secret` changes the SDK read (`getSecret`), which is the author's call.
    if (name === "schema") {
      for (const list of ["entries", "catalog"]) {
        const entries = edit.get([list]);
        // A plain array (JSON) or a YAML sequence node, whose `items` are its elements.
        const n = Array.isArray(entries)
          ? entries.length
          : ((entries as { items?: unknown[] } | undefined)?.items?.length ??
            0);
        for (let i = 0; i < n; i++) {
          if (
            edit.get([list, String(i), "kind"]) !== "secret" ||
            edit.get([list, String(i), "secret"]) !== true
          )
            continue;
          edit.remove([list, String(i), "secret"]);
          doc.changed = true;
          moves.push({
            file: path.relative(cwd, file),
            from: `/${list}/${i}/secret`,
            to: "(dropped)",
          });
        }
      }
    }
  }
  moveLegacyRecipes(open, cwd, moves);
  for (const doc of Object.values(open))
    if (doc.changed) await writeFile(doc.file, doc.edit.text());
  return moves;
}

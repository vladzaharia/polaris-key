/**
 * Duplicate manifest spellings (ST-19, plans/ST-19.md §3).
 *
 * The validator has always accepted more than one spelling for some `.pkey/` fields: a flat
 * product document beside the `product:` wrapper, `tiers` at the root beside `licensing.tiers`,
 * a release body with or without the `release:` wrapper, and so on. ST-19 keeps every one of
 * them valid and keeps today's precedence when two are present (owner decision Q3). It only
 * warns: `deprecated_spelling` when an old spelling is used, `conflicting_spelling` when the old
 * and the canonical spelling are both set (the message names the value that is used).
 *
 * `DEPRECATED_SPELLINGS` is the one list of those spellings. The validator's pass below, the
 * JSON schemas' `"deprecated": true` marks, the schema-parity test, the Worker's
 * registry ↔ manifest parity test and the settings-coverage row "Deprecated manifest spellings"
 * all read it, so a spelling cannot be deprecated in one place and silently accepted in another.
 *
 * Canonical means what `pkey init` writes and the docs show (owner decision Q2): `product:` for
 * identity and compatibility, `licensing:` for licence defaults, tiers and profiles, `release:`
 * in `.pkey/release`, tier `profileId` (Q2b).
 *
 * Refusing the old spellings is a later decision (plans/ST-19.md §7 step 3).
 */

import type { ValidationMessage } from "./index.js";

/** Which of two spellings a reader uses when both are present. */
export type SpellingWinner =
  /** The canonical spelling is read; the old one is ignored. */
  | "canonical"
  /** The old spelling is read (today's precedence, kept by Q3). */
  | "deprecated"
  /** Both are read and merged (legacy `modules:` names enable the same service). */
  | "merged"
  /** The old spelling is never read at all. */
  | "ignored"
  /** Both at once is an error with its own code (`conflictCode`). */
  | "refused";

export interface DeprecatedSpelling {
  /** The row of plans/ST-19.md §3.1 this spelling belongs to. */
  row: number;
  /** The document the old spelling lives in. */
  doc: "product" | "schema" | "release" | "distribution";
  /** The old spelling's JSON pointer. A `*` segment stands for an array index. */
  pointer: string;
  /**
   * The canonical spelling in registry form (`<doc>:<dotted path>`, `[]` for an array index):
   * what the warning tells the author to write instead.
   */
  canonical: string;
  /**
   * The canonical spelling's JSON pointer, used to detect "both are set". `*` segments bind to
   * the old pointer's indices in order. `null` when the two cannot both be set meaningfully.
   */
  canonicalPointer: { doc: DeprecatedSpelling["doc"]; pointer: string } | null;
  /** Which value a reader uses when both are present (`refused`: both is an error). */
  wins: SpellingWinner;
  /** How presence is judged, matching the reader: any non-null value, an array, an object. */
  present?: "value" | "array" | "record";
  /** The warning for the old spelling on its own; `null` when it has none (row 16). */
  code: "deprecated_spelling" | "listing_url_field_deprecated" | null;
  /** The code for both spellings at once, or `null` when the pass reports no conflict. */
  conflictCode:
    | "conflicting_spelling"
    | "conflicting_versioning"
    | "listing_field_conflict"
    | null;
  /**
   * Checked elsewhere: the pass skips the row because it keeps the checks it already had
   * (row 16, `conflicting_versioning`; row 18, the `.pkey/distribution` listing art codes).
   */
  checkedElsewhere?: true;
  /** A root release-body field: never read when the document also has the `release:` wrapper. */
  unreadWhenWrapped?: true;
  /** An older spelling that beats this one when both are set (row 3 and 4's root spelling). */
  shadowedBy?: string;
}

const P = "product" as const;
const S = "schema" as const;
const R = "release" as const;
const D = "distribution" as const;

function row(
  rowNo: number,
  doc: DeprecatedSpelling["doc"],
  pointer: string,
  canonical: string,
  canonicalPointer: DeprecatedSpelling["canonicalPointer"],
  wins: SpellingWinner,
  extra: Partial<DeprecatedSpelling> = {},
): DeprecatedSpelling {
  return {
    row: rowNo,
    doc,
    pointer,
    canonical,
    canonicalPointer,
    wins,
    code: "deprecated_spelling",
    conflictCode: canonicalPointer ? "conflicting_spelling" : null,
    ...extra,
  };
}

/** The release body fields that only moved under the `release:` wrapper (row 14). */
const RELEASE_BODY_FIELDS = [
  "provider",
  "binaryName",
  "channelWorkflow",
  "betaBranch",
  "summaryMarker",
  "sparkleEd25519Pub",
  "manualChannels",
  "artifactPolicy",
  "access",
  "deliverables",
  "publishing",
  "releaseKeys",
] as const;

/** Every duplicate spelling the validator accepts, by plans/ST-19.md §3.1 row. */
export const DEPRECATED_SPELLINGS: readonly DeprecatedSpelling[] = [
  // 1. A flat product document: identity outside the `product:` wrapper.
  row(
    1,
    P,
    "/slug",
    "product:product.slug",
    { doc: P, pointer: "/product/slug" },
    "canonical",
  ),
  row(
    1,
    P,
    "/name",
    "product:product.name",
    { doc: P, pointer: "/product/name" },
    "canonical",
  ),
  // 2. Administration and compatibility outside the wrapper.
  row(
    2,
    P,
    "/adminGroup",
    "product:product.adminGroup",
    { doc: P, pointer: "/product/adminGroup" },
    "canonical",
  ),
  row(
    2,
    P,
    "/compatMin",
    "product:product.compatMin",
    { doc: P, pointer: "/product/compatMin" },
    "canonical",
  ),
  row(
    2,
    P,
    "/compatMax",
    "product:product.compatMax",
    { doc: P, pointer: "/product/compatMax" },
    "canonical",
  ),
  // 3–4. Licence defaults outside `licensing:`; both old spellings beat the canonical one.
  row(
    3,
    P,
    "/product/defaultDeviceLimit",
    "product:licensing.defaultDeviceLimit",
    { doc: P, pointer: "/licensing/defaultDeviceLimit" },
    "deprecated",
  ),
  row(
    3,
    P,
    "/defaultDeviceLimit",
    "product:licensing.defaultDeviceLimit",
    { doc: P, pointer: "/licensing/defaultDeviceLimit" },
    "deprecated",
    { shadowedBy: "/product/defaultDeviceLimit" },
  ),
  row(
    4,
    P,
    "/product/defaultMaxOfflineDays",
    "product:licensing.defaultMaxOfflineDays",
    { doc: P, pointer: "/licensing/defaultMaxOfflineDays" },
    "deprecated",
  ),
  row(
    4,
    P,
    "/defaultMaxOfflineDays",
    "product:licensing.defaultMaxOfflineDays",
    { doc: P, pointer: "/licensing/defaultMaxOfflineDays" },
    "deprecated",
    { shadowedBy: "/product/defaultMaxOfflineDays" },
  ),
  // 5–6. Tiers and profiles at the root.
  row(
    5,
    P,
    "/tiers",
    "product:licensing.tiers",
    { doc: P, pointer: "/licensing/tiers" },
    "deprecated",
    { present: "array" },
  ),
  row(
    6,
    P,
    "/profiles",
    "product:licensing.profiles",
    { doc: P, pointer: "/licensing/profiles" },
    "deprecated",
    { present: "array" },
  ),
  // 7. Tier `profile` (Q2b: `profileId` is canonical), wherever the tiers are.
  row(
    7,
    P,
    "/licensing/tiers/*/profile",
    "product:licensing.tiers[].profileId",
    { doc: P, pointer: "/licensing/tiers/*/profileId" },
    "canonical",
  ),
  row(
    7,
    P,
    "/tiers/*/profile",
    "product:licensing.tiers[].profileId",
    { doc: P, pointer: "/tiers/*/profileId" },
    "canonical",
  ),
  // 8. Tier `expiryDays`.
  row(
    8,
    P,
    "/licensing/tiers/*/expiryDays",
    "product:licensing.tiers[].policyExpiryDays",
    { doc: P, pointer: "/licensing/tiers/*/policyExpiryDays" },
    "canonical",
  ),
  row(
    8,
    P,
    "/tiers/*/expiryDays",
    "product:licensing.tiers[].policyExpiryDays",
    { doc: P, pointer: "/tiers/*/policyExpiryDays" },
    "canonical",
  ),
  // 9. Profile `label`.
  row(
    9,
    P,
    "/licensing/profiles/*/label",
    "product:licensing.profiles[].name",
    { doc: P, pointer: "/licensing/profiles/*/name" },
    "canonical",
  ),
  row(
    9,
    P,
    "/profiles/*/label",
    "product:licensing.profiles[].name",
    { doc: P, pointer: "/profiles/*/name" },
    "canonical",
  ),
  // 10. The OIDC client secret's name.
  row(
    10,
    P,
    "/oidc/clientSecretRef",
    "product:oidc.clientSecretSecret",
    { doc: P, pointer: "/oidc/clientSecretSecret" },
    "canonical",
  ),
  // 11. The release document inlined in the product document.
  row(
    11,
    P,
    "/release",
    "release:release",
    { doc: R, pointer: "" },
    "canonical",
    { present: "record" },
  ),
  // 12. Legacy `modules:` names (Q4); both names enable the service, so nothing conflicts.
  row(12, P, "/modules/licensing", "product:modules.license", null, "merged"),
  row(12, P, "/modules/releases", "product:modules.release", null, "merged"),
  row(12, P, "/modules/oidc", "product:modules.identity", null, "merged"),
  row(12, P, "/modules/edgeMint", "product:modules.config", null, "merged"),
  // 13. The catalog's old key.
  row(
    13,
    S,
    "/catalog",
    "schema:entries",
    { doc: S, pointer: "/entries" },
    "canonical",
    { present: "array" },
  ),
  // 14. A release body at the document root, without the `release:` wrapper.
  ...RELEASE_BODY_FIELDS.map((field) =>
    row(
      14,
      R,
      `/${field}`,
      `release:release.${field}`,
      { doc: R, pointer: `/release/${field}` },
      "canonical",
      { unreadWhenWrapped: true },
    ),
  ),
  // 15. The GitHub coordinates as two flat fields; they beat `provider` when both are set.
  row(
    15,
    R,
    "/release/ghOwner",
    "release:release.provider.owner",
    { doc: R, pointer: "/release/provider/owner" },
    "deprecated",
  ),
  row(
    15,
    R,
    "/release/ghRepo",
    "release:release.provider.repo",
    { doc: R, pointer: "/release/provider/repo" },
    "deprecated",
  ),
  row(
    15,
    R,
    "/ghOwner",
    "release:release.provider.owner",
    { doc: R, pointer: "/provider/owner" },
    "deprecated",
    { unreadWhenWrapped: true },
  ),
  row(
    15,
    R,
    "/ghRepo",
    "release:release.provider.repo",
    { doc: R, pointer: "/provider/repo" },
    "deprecated",
    { unreadWhenWrapped: true },
  ),
  // 16. The tag filters in the release body. P2-04 kept the body spelling valid with no warning
  //     of its own, and both at once is already the error `conflicting_versioning`, so the pass
  //     skips the row (plans/ST-19.md §3.2).
  ...(["stableTagPattern", "ignoreTags"] as const).flatMap((field) => [
    row(
      16,
      R,
      `/release/${field}`,
      `release:release.deliverables.app.versioning.${field}`,
      { doc: R, pointer: `/release/deliverables/app/versioning/${field}` },
      "refused",
      {
        code: null,
        conflictCode: "conflicting_versioning",
        checkedElsewhere: true,
      },
    ),
    row(
      16,
      R,
      `/${field}`,
      `release:release.deliverables.app.versioning.${field}`,
      { doc: R, pointer: `/deliverables/app/versioning/${field}` },
      "refused",
      {
        code: null,
        conflictCode: "conflicting_versioning",
        checkedElsewhere: true,
      },
    ),
  ]),
  // 17. Edge-mint recipes in the release document. At the root they are read when the product
  //     declares none; under the wrapper they were never read.
  row(
    17,
    R,
    "/edgeMint",
    "product:edgeMint",
    { doc: P, pointer: "/edgeMint" },
    "canonical",
    { present: "array" },
  ),
  row(17, R, "/release/edgeMint", "product:edgeMint", null, "ignored"),
  // 18. Listing art URL aliases (`.pkey/distribution`), with their own codes since P2b-02.
  ...(["/listing", "/outlets/*/listing"] as const).flatMap((at) =>
    (
      [
        ["iconUrl", "icon"],
        ["headerUrl", "header"],
      ] as const
    ).map(([alias, field]) =>
      row(
        18,
        D,
        `${at}/${alias}`,
        `distribution:${dotted(at)}.${field}`,
        { doc: D, pointer: `${at}/${field}` },
        "refused",
        {
          code: "listing_url_field_deprecated",
          conflictCode: "listing_field_conflict",
          checkedElsewhere: true,
        },
      ),
    ),
  ),
];

/** A JSON pointer in registry form: `/licensing/tiers/*\/profile` → `licensing.tiers[].profile`. */
export function dotted(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => (seg === "*" ? "[]" : seg))
    .join(".")
    .replace(/\.\[\]/g, "[]");
}

/** A spelling's old path in registry form: `product:licensing.tiers[].profile`. */
export function spellingPath(s: DeprecatedSpelling): string {
  return `${s.doc}:${dotted(s.pointer)}`;
}

type Docs = Partial<Record<DeprecatedSpelling["doc"], unknown>>;

/** Every concrete match of a pointer: the path with indices filled in, the indices, the value. */
function resolve(
  root: unknown,
  pointer: string,
): { path: string; indices: number[]; value: unknown }[] {
  let frontier = [{ path: "", indices: [] as number[], value: root }];
  for (const seg of pointer.split("/").slice(1)) {
    const next: typeof frontier = [];
    for (const at of frontier) {
      if (seg === "*") {
        if (!Array.isArray(at.value)) continue;
        at.value.forEach((value, i) =>
          next.push({
            path: `${at.path}/${i}`,
            indices: [...at.indices, i],
            value,
          }),
        );
      } else if (isRecord(at.value) && seg in at.value) {
        next.push({
          path: `${at.path}/${seg}`,
          indices: at.indices,
          value: at.value[seg],
        });
      }
    }
    frontier = next;
  }
  return frontier;
}

/** The value at a pointer whose `*` segments are bound to `indices`, in order. */
function valueAt(root: unknown, pointer: string, indices: number[]): unknown {
  let node = root;
  let i = 0;
  for (const seg of pointer.split("/").slice(1)) {
    const key = seg === "*" ? indices[i++] : seg;
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else if (isRecord(node) && typeof key === "string") node = node[key];
    else return undefined;
  }
  return node;
}

function isPresent(
  value: unknown,
  how: DeprecatedSpelling["present"] = "value",
): boolean {
  if (how === "array") return Array.isArray(value);
  if (how === "record") return isRecord(value);
  return value !== undefined && value !== null;
}

/** A short, single-line rendering of a value for a message. */
function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** How the canonical spelling reads in a message, from the old spelling's document. */
function describeCanonical(s: DeprecatedSpelling): string {
  const [doc, path] = s.canonical.split(":") as [string, string];
  if (s.row === 11) return "the release block in .pkey/release";
  return doc === s.doc ? path : `${path} in .pkey/${doc}`;
}

/**
 * Warn on every deprecated spelling the documents use (plans/ST-19.md §3.2). Warnings only:
 * `ok`, the errors and every parsed value are exactly what they were before ST-19.
 */
export function checkSpellings(
  docs: Docs,
  warnings: ValidationMessage[],
): void {
  for (const s of DEPRECATED_SPELLINGS) {
    if (s.checkedElsewhere) continue;
    const root = docs[s.doc];
    if (root === undefined) continue;
    for (const hit of resolve(root, s.pointer)) {
      if (!isPresent(hit.value, s.present)) continue;
      const old = dotted(hit.path) || s.doc;
      const write = describeCanonical(s);
      const other = s.canonicalPointer
        ? valueAt(
            docs[s.canonicalPointer.doc],
            s.canonicalPointer.pointer,
            hit.indices,
          )
        : undefined;
      const both = s.canonicalPointer !== null && isPresent(other, s.present);
      if (both && s.conflictCode === "conflicting_spelling") {
        const shadow = s.shadowedBy
          ? valueAt(root, s.shadowedBy, [])
          : undefined;
        const used =
          s.wins !== "deprecated"
            ? `${write} (${show(other)})`
            : s.shadowedBy && isPresent(shadow)
              ? `${dotted(s.shadowedBy)} (${show(shadow)})`
              : `${old} (${show(hit.value)})`;
        emitConflict(warnings, s.doc, hit.path, old, write, used);
      } else if (!both) {
        // Row 17 under the wrapper, and a root release field next to the wrapper, are never
        // read: say so, so the author does not think the value takes effect.
        const ignored =
          s.wins === "ignored" ||
          (s.unreadWhenWrapped === true &&
            isRecord(valueAt(root, "/release", [])));
        emitDeprecated(
          warnings,
          s.doc,
          hit.path,
          old,
          write,
          ignored ? " and is ignored" : "",
        );
      }
      // `both` with another conflict code (row 16) is the existing error's to report.
    }
  }
}

// One literal emit site per document and code, so the generated validation-codes page
// (packages/docs/scripts/gen-reference.mjs) lists them.
function emitDeprecated(
  warnings: ValidationMessage[],
  doc: DeprecatedSpelling["doc"],
  path: string,
  old: string,
  write: string,
  ignored: string,
): void {
  if (doc === "product")
    add(
      warnings,
      "product",
      `${path}`,
      "deprecated_spelling",
      `${old} is a deprecated spelling${ignored}; write ${write}.`,
    );
  else if (doc === "schema")
    add(
      warnings,
      "schema",
      `${path}`,
      "deprecated_spelling",
      `${old} is a deprecated spelling${ignored}; write ${write}.`,
    );
  else
    add(
      warnings,
      "release",
      `${path}`,
      "deprecated_spelling",
      `${old} is a deprecated spelling${ignored}; write ${write}.`,
    );
}

function emitConflict(
  warnings: ValidationMessage[],
  doc: DeprecatedSpelling["doc"],
  path: string,
  old: string,
  write: string,
  used: string,
): void {
  if (doc === "product")
    add(
      warnings,
      "product",
      `${path}`,
      "conflicting_spelling",
      `${old} and ${write} are both set; ${used} is used. Keep only ${write}.`,
    );
  else if (doc === "schema")
    add(
      warnings,
      "schema",
      `${path}`,
      "conflicting_spelling",
      `${old} and ${write} are both set; ${used} is used. Keep only ${write}.`,
    );
  else
    add(
      warnings,
      "release",
      `${path}`,
      "conflicting_spelling",
      `${old} and ${write} are both set; ${used} is used. Keep only ${write}.`,
    );
}

function add(
  list: ValidationMessage[],
  file: ValidationMessage["file"],
  path: string,
  code: string,
  message: string,
): void {
  list.push({ file, path, code, message });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

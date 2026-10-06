/**
 * The PR plane as the CLI enforces it (A-18i; notes/S-15 §4.4, §6.3): the same checks as the
 * Worker's `core/storefront/prPlane.ts`, over the generated copy of the same declaration
 * (`ciPlane.generated.ts`, `prStores`). A pull-request step is the pseudo-tool `github`'s argv
 * (`pull-request --repo <repo> --package <id> --version <v>`), admitted by the store's allow-list
 * with the outlet identity, and every file it writes must match one of the store's path templates.
 * The CLI refuses before anything reaches GitHub; the Worker refuses the report again, so neither
 * side trusts the other's copy. `test/storefrontsPr.test.ts` runs the conformance cases over this
 * implementation.
 */

import { CI_PLANE } from "./ciPlane.generated.js";
import {
  checkCiCommand,
  matchCiCommand,
  type CiIdentity,
  type CiRefusal,
} from "./allowList.js";
import type { CiAllowList, CiParam, PrPlaneStore } from "./types.js";

/** The PR-plane stores (`winget`, `homebrew`, `scoop`, `flathub`). */
export function prStoreIds(): string[] {
  return CI_PLANE.prStores.map((s) => s.store);
}

/** A PR-plane store by id, or null. */
export function prStore(store: string): PrPlaneStore | null {
  return CI_PLANE.prStores.find((s) => s.store === store) ?? null;
}

/** The pattern `{locale}` stands for in a path template (the Worker's `PR_LOCALE_PATTERN`). */
export const PR_LOCALE_PATTERN = String.raw`[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The regular expression a path template becomes for the given parameter values, or null when
 * the template names a parameter that has no value. `{p|segments}` is the value's dot-separated
 * parts as directories; `{p|first}` its first character, lower-cased.
 */
export function prPathPattern(
  template: string,
  values: Readonly<Record<string, string>>,
): RegExp | null {
  let missing = false;
  const source = template
    .split(/(\{[A-Za-z]+(?:\|[a-z]+)?\})/)
    .map((part) => {
      const m = /^\{([A-Za-z]+)(?:\|([a-z]+))?\}$/.exec(part);
      if (!m) return escapeRe(part);
      const [, name, filter] = m;
      if (name === "locale") return PR_LOCALE_PATTERN;
      const v = values[name!];
      if (v === undefined || v === "") {
        missing = true;
        return "";
      }
      if (filter === "segments") return escapeRe(v.split(".").join("/"));
      if (filter === "first") return escapeRe(v.charAt(0).toLowerCase());
      return escapeRe(v);
    })
    .join("");
  return missing ? null : new RegExp(`^${source}$`);
}

/** The values of a command's named parameters in `argv` (after their prefixes). */
export function prParams(
  list: CiAllowList,
  command: string,
  argv: readonly string[],
): Record<string, string> {
  const rule = list.commands[command];
  const out: Record<string, string> = {};
  if (!rule) return out;
  rule.argv.forEach((a, i) => {
    if (typeof a === "string" || argv[i] === undefined) return;
    out[(a as CiParam).param] = argv[i]!.slice(
      ((a as CiParam).prefix ?? "").length,
    );
  });
  return out;
}

/** Whether `path` is one a `pull-request` with this (already allow-listed) argv may write. */
export function prPathAllowed(
  store: PrPlaneStore,
  argv: readonly string[],
  path: string,
): boolean {
  if (path.length > 512 || path.includes("..") || path.startsWith("/"))
    return false;
  const values = prParams(store.list, "pull-request", argv);
  return store.paths.some(
    (rule) => prPathPattern(rule.template, values)?.test(path) ?? false,
  );
}

/** The ledger natural key of a PR step: `pr:<package>:<version>`. */
export function prNaturalKey(
  store: PrPlaneStore,
  command: string,
  argv: readonly string[],
): string | null {
  const values = prParams(store.list, command, argv);
  const [pkg, version] = store.naturalKey.map((k) => values[k]);
  return pkg && version ? `pr:${pkg}:${version}` : null;
}

/** The repository (`owner/name`) a step's argv targets, or null. */
export function prRepo(
  store: PrPlaneStore,
  command: string,
  argv: readonly string[],
): string | null {
  const rule = store.list.commands[command];
  if (!rule) return null;
  const i = rule.argv.indexOf("--repo");
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
}

/** The verifier's reading of a pull request (the Worker derives the same from the report). */
export type PrVerdict =
  | "merged"
  | "closed"
  | "needs-author-feedback"
  | "validation-issue"
  | "in-review";

export function prVerdict(
  store: PrPlaneStore,
  pr: { state: "open" | "closed"; merged: boolean; labels: readonly string[] },
): PrVerdict {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.labels.some((l) => store.labels.needsAuthor.includes(l)))
    return "needs-author-feedback";
  const prefix = store.labels.validationPrefix;
  if (
    prefix !== null &&
    pr.labels.some(
      (l) => l.startsWith(prefix) && !store.labels.validationOk.includes(l),
    )
  )
    return "validation-issue";
  return "in-review";
}

/** Throws unless `argv` is `command` as the store's allow-list declares it, for this identity. */
export function checkPrCommand(
  store: PrPlaneStore,
  command: string,
  argv: readonly string[],
  identity: CiIdentity,
): void {
  const refusal = checkCiCommand(store.list, command, argv, identity);
  if (!refusal) return;
  const why: Record<CiRefusal, string> = {
    not_allowed: `is not ${command} as ${store.label}'s PR plane declares it`,
    value_not_allowed: `has a value ${store.label}'s PR plane refuses for ${command}`,
    identity_required:
      "is bound to the outlet's identity, and no outlet was given",
    identity_mismatch:
      "names a repository or package the outlet's identity does not declare",
  };
  throw new Error(
    `Refused by the PR plane's allow-list: ${store.list.tool} ${argv.join(" ")} ${why[refusal]}.`,
  );
}

/** Throws unless every path is one the (already admitted) pull request may write. */
export function checkPrPaths(
  store: PrPlaneStore,
  argv: readonly string[],
  paths: readonly string[],
): void {
  for (const p of paths)
    if (!prPathAllowed(store, argv, p))
      throw new Error(
        `Refused by the PR plane: ${p} is not a path ${store.label}'s pull request may write (${store.paths.map((r) => r.template).join(", ")}).`,
      );
  if (new Set(paths).size !== paths.length)
    throw new Error("Refused by the PR plane: a path is written twice.");
}

export { matchCiCommand };

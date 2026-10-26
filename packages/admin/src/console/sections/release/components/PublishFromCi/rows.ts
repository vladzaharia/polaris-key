/**
 * Publish from CI (A-32.11): the readiness checks as "Polaris Key does this" rows. Pure: the
 * drawer owns the fetch, the fix calls and what a refusal named.
 *
 *   ok       -> done (the tick says it)
 *   missing  -> "To do", neutral, with its one click when Polaris Key can do it
 *   unknown  -> Needs <permission>, with "Review permissions on GitHub"
 *   failed   -> only a fix that was tried and did not work
 */

import type { AutoState } from "../../../../../ui/wizard/index.js";
import type {
  CiFixCheck,
  CiReadiness,
  CiReadinessCheck,
} from "../../../../../api.js";

/** The permission both fixes need (the Worker's `ADMIN_PERMISSION`). */
export const ADMIN_PERMISSION = "administration: write";

/** GitHub's own page of the person's installed Apps: the fallback when no better link is known. */
export const REVIEW_PERMISSIONS_URL =
  "https://github.com/settings/installations";

export type CiRowId =
  | "app"
  | "workflow"
  | "environment"
  | "ruleset"
  | "publisher"
  | "distribution-pr";

export const LABELS: Record<CiRowId, string> = {
  app: "GitHub App installed",
  workflow: "Workflow",
  environment: "Release environment",
  ruleset: "Tag ruleset",
  publisher: "Trusted publisher",
  "distribution-pr": "Homebrew and Scoop pull requests",
};

/** The names a fix announces ("Release environment created"). */
export const LABELS_BY_FIX: Record<CiFixCheck, string> = {
  environment: "Release environment",
  ruleset: "Tag ruleset",
};

/** What each row does for the product, in the reader's terms; shown before and after. */
const OUTCOME: Partial<Record<CiRowId, string>> = {
  environment: "Only v* tags deploy",
  ruleset: "v* tags can't be moved or deleted",
  publisher: "Lets the workflow publish without a token",
  "distribution-pr": "Add distribution:pr to the publisher",
};

/** `administration: write` as GitHub words it: "Administration: Read and write". */
export function githubWords(permission: string): string {
  const [name = permission, level] = permission.split(/:\s*/);
  const words = name.replace(/_/g, " ");
  const cap = words.charAt(0).toUpperCase() + words.slice(1);
  if (!level) return cap;
  return `${cap}: ${level === "write" ? "Read and write" : "Read"}`;
}

export interface CiRow {
  id: CiRowId;
  label: string;
  state: AutoState;
  /** The word beside the row when the state's own does not fit. */
  status?: string;
  result?: string;
  /** What the row's button does. */
  fix?: "create" | "edit" | "keys" | "install" | "permissions" | "recheck";
  fixLabel?: string;
  /** The Create button while its request runs. */
  busy?: boolean;
  /** A refused fix: offer "Check again" next to the GitHub link. */
  recheck?: boolean;
}

export interface RowContext {
  /** Checks being fixed now. */
  pending: ReadonlySet<CiFixCheck>;
  /** Checks whose fix GitHub refused, with the permission it named. */
  refused: ReadonlyMap<CiFixCheck, string>;
  /** A fix failed for another reason. */
  failed: ReadonlySet<CiFixCheck>;
  /** The open setup pull request, which carries the workflow. */
  pullRequest?: number | null;
}

const isFixable = (id: string): id is CiFixCheck =>
  id === "environment" || id === "ruleset";

const todo = (
  id: CiRowId,
  result: string | undefined,
  more: Partial<CiRow> = {},
): CiRow => ({
  id,
  label: LABELS[id],
  state: "will",
  status: "To do",
  result,
  ...more,
});

function needs(id: CiRowId, permission: string, result?: string): CiRow {
  return {
    id,
    label: LABELS[id],
    state: "needs",
    status: "Needs permission",
    result: result
      ? `${githubWords(permission)} · ${result}`
      : githubWords(permission),
    fix: "permissions",
  };
}

export function ciRows(readiness: CiReadiness, ctx: RowContext): CiRow[] {
  const by = new Map(readiness.checks.map((c) => [c.id, c]));
  const done = (id: CiRowId, result?: string, more: Partial<CiRow> = {}) =>
    ({
      id,
      label: LABELS[id],
      state: "done",
      result,
      ...more,
    }) as CiRow;

  const app = by.get("app");
  if (app?.state === "missing")
    // Every other read hangs on the App: one row, one action.
    return [
      todo("app", undefined, {
        status: "Not installed",
        fix: "install",
        fixLabel: "Install the GitHub App",
      }),
    ];
  const rows: CiRow[] = [];
  if (app?.state === "unknown")
    rows.push(
      todo("app", "GitHub did not answer", {
        status: "Unknown",
        fix: "recheck",
        fixLabel: "Check again",
      }),
    );
  else rows.push(done("app"));

  // `.pkey/release` and the workflow are one change (step 1 below): one row.
  const parts = (["release-manifest", "workflow"] as const)
    .map((id) => by.get(id))
    .filter((c): c is CiReadinessCheck => c !== undefined);
  if (parts.length > 0) {
    const unknown = parts.find((c) => c.state === "unknown");
    if (unknown)
      rows.push(needs("workflow", unknown.permission ?? "contents: read"));
    else if (parts.every((c) => c.state === "ok"))
      rows.push(done("workflow", "On main"));
    else
      rows.push(
        todo(
          "workflow",
          ctx.pullRequest
            ? `In pull request #${ctx.pullRequest}`
            : parts.find((c) => c.detail)?.detail,
        ),
      );
  }

  for (const id of [
    "environment",
    "ruleset",
    "publisher",
    "distribution-pr",
  ] as const) {
    const c = by.get(id);
    if (!c) continue;
    if (c.state === "ok") {
      rows.push(
        done(id, id === "publisher" ? c.detail : OUTCOME[id], {
          ...(id === "publisher" ? { fix: "keys", fixLabel: "Change" } : null),
        }),
      );
    } else if (isFixable(id)) {
      if (ctx.pending.has(id))
        rows.push({
          id,
          label: LABELS[id],
          state: "doing",
          result: OUTCOME[id],
          fix: "create",
          fixLabel: "Create",
          busy: true,
        });
      else if (ctx.refused.has(id))
        rows.push({
          ...needs(
            id,
            ctx.refused.get(id)!,
            "Ask a repository admin to grant it.",
          ),
          recheck: true,
        });
      else if (c.state === "unknown")
        rows.push(needs(id, c.permission ?? ADMIN_PERMISSION));
      else if (!readiness.capabilities[id])
        rows.push(needs(id, ADMIN_PERMISSION, OUTCOME[id]));
      else if (ctx.failed.has(id))
        rows.push({
          id,
          label: LABELS[id],
          state: "failed",
          status: "Failed",
          result: "GitHub did not answer. Try again.",
          fix: "create",
          fixLabel: "Try again",
        });
      else
        rows.push(todo(id, OUTCOME[id], { fix: "create", fixLabel: "Create" }));
    } else if (c.state === "unknown") {
      rows.push(needs(id, c.permission ?? "contents: read"));
    } else {
      rows.push(
        todo(id, OUTCOME[id], {
          fix: "edit",
          fixLabel: id === "publisher" ? "Allow workflow" : "Add",
        }),
      );
    }
  }
  return rows;
}

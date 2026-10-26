/**
 * Publish from CI (A-32.11): the readiness checks as "Polaris Key does this" rows. Pure: the
 * drawer owns the fetch, the fix calls and what a refusal named.
 *
 *   ok       -> Done
 *   missing  -> Missing, with its fix (Create, for the two Polaris Key can write)
 *   unknown  -> Needs <permission>, with "Review permissions on GitHub"
 */

import type { AutoState } from "../../../../../ui/wizard/index.js";
import type {
  CiFixCheck,
  CiReadiness,
  CiReadinessCheck,
} from "../../../../../api.js";

/** The permission both fixes need (the Worker's `ADMIN_PERMISSION`). */
export const ADMIN_PERMISSION = "administration: write";

/** Where the owner reviews the App's permissions. */
export const REVIEW_PERMISSIONS_URL =
  "https://github.com/settings/installations";

export const LABELS: Record<CiReadinessCheck["id"], string> = {
  app: "GitHub App installed",
  "release-manifest": ".pkey/release",
  workflow: "Release workflow",
  environment: "Release environment",
  ruleset: "Tag ruleset for v*",
  publisher: "Trusted publisher",
  "distribution-pr": "Pull requests to homebrew and scoop",
};

/** What each row does when it is missing, in the reader's terms. */
const MISSING: Record<CiReadinessCheck["id"], string> = {
  app: "Install the app on the repository",
  "release-manifest": "Add it in the setup pull request",
  workflow: "Added by the setup pull request",
  environment: "Limited to v* tags",
  ruleset: "Only admins create, delete or move a release tag",
  publisher: "Lets the workflow publish without a token",
  "distribution-pr": "Add distribution:pr to the publisher",
};

export interface CiRow {
  id: CiReadinessCheck["id"];
  label: string;
  state: AutoState;
  /** The word beside the row when the state's own does not fit. */
  status?: string;
  result?: string;
  /** What the row's button does. */
  fix?: "create" | "edit" | "keys" | "install" | "permissions";
  fixLabel?: string;
  /** The permission to grant, on a `permissions` row. */
  permission?: string;
}

export interface RowContext {
  /** Checks being fixed now. */
  pending: ReadonlySet<CiFixCheck>;
  /** Checks whose fix GitHub refused, with the permission it named. */
  refused: ReadonlyMap<CiFixCheck, string>;
  /** A fix failed for another reason. */
  failed: ReadonlySet<CiFixCheck>;
}

const isFixable = (id: string): id is CiFixCheck =>
  id === "environment" || id === "ruleset";

export function ciRows(readiness: CiReadiness, ctx: RowContext): CiRow[] {
  return readiness.checks.map((c): CiRow => {
    const base = { id: c.id, label: LABELS[c.id] };
    if (c.state === "ok")
      return {
        ...base,
        state: "done",
        status: "Done",
        result: c.detail,
        ...(c.id === "publisher" ? { fix: "keys", fixLabel: "Change" } : null),
      } as CiRow;

    if (isFixable(c.id)) {
      if (ctx.pending.has(c.id))
        return { ...base, state: "doing", result: MISSING[c.id] };
      const refused = ctx.refused.get(c.id);
      if (refused)
        return needs(base, refused, "Ask a repository admin to give it");
      if (c.state === "unknown")
        return needs(base, c.permission ?? ADMIN_PERMISSION);
      if (!readiness.capabilities[c.id])
        return needs(base, ADMIN_PERMISSION, MISSING[c.id]);
      return {
        ...base,
        state: "failed",
        status: ctx.failed.has(c.id) ? "Failed" : "Missing",
        result: ctx.failed.has(c.id)
          ? "GitHub did not answer. Try again."
          : MISSING[c.id],
        fix: "create",
        fixLabel: ctx.failed.has(c.id) ? "Try again" : "Create",
      };
    }

    if (c.state === "unknown")
      return needs(base, c.permission ?? "its read permission", undefined);

    if (c.id === "app")
      return {
        ...base,
        state: "failed",
        status: "Missing",
        result: MISSING.app,
        fix: "install",
        fixLabel: "Install on GitHub",
      };
    if (c.id === "publisher")
      return {
        ...base,
        state: "failed",
        status: "Missing",
        result: MISSING.publisher,
        fix: "keys",
        fixLabel: "Allow workflow",
      };
    if (c.id === "distribution-pr")
      return {
        ...base,
        state: "failed",
        status: "Missing",
        result: MISSING["distribution-pr"],
        fix: "edit",
        fixLabel: "Add",
      };
    // .pkey/release and the workflow: the setup pull request writes them (A-32.12).
    return {
      ...base,
      state: "will",
      status: "Missing",
      result: c.detail ?? MISSING[c.id],
    };
  });
}

function needs(
  base: { id: CiReadinessCheck["id"]; label: string },
  permission: string,
  result?: string,
): CiRow {
  return {
    ...base,
    state: "needs",
    status: "Needs permission",
    result: result ? `${permission} · ${result}` : permission,
    fix: "permissions",
    permission,
  };
}

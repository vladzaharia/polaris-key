/**
 * `errorCopy(error, context)`: the console's one error mapper (docs/design/ADMIN.md §5.9,
 * components.md §5.5). It reads an `ApiError` (status, code, reason, errors, fields) and returns a
 * title, a description and the next step, so no view ever shows "api 422" again (P9). Toasts,
 * `ErrorState` and confirm dialogs all render through it.
 */

import { ApiError, SERVICE_ERROR_MESSAGES } from "../api.js";
import { RELEASE_POLICY_ERROR_MESSAGES } from "./releasePolicyMessages.js";

/** What the operator can do next. The renderer turns it into a button or a link. */
export type ErrorAction =
  | "retry"
  | "reload"
  | "sign-in"
  | "fields"
  | "copy-details"
  | "review"
  | "platform"
  | "none";

export interface ErrorContext {
  /** The thing the request was about, for "{Thing} not found": "License", "Profile". */
  thing?: string;
  /** Where that thing's collection lives, for the not-found link. */
  collectionHref?: string;
  /**
   * The area the request belongs to. It breaks ties between tables (`release_yanked` means a
   * different thing to a rollout than to a channel promote) and marks a 409 as the catalog's
   * concurrent-publish conflict (A-6).
   */
  area?: ErrorArea;
  /** The slug the operator typed, for "tonebox is taken: try tonebox-app" (`area: "slug"`). */
  slug?: string;
  /** The repository the operator named (`acme/tonebox`), for the GitHub App install fix. */
  repo?: string;
}

/**
 * The areas `errorCopy` routes by (EXPERIENCE.md §0.3, UX-01). The first three break ties between
 * reason tables. The rest name where a refusal came from, so it reads as that problem and not as a
 * generic status: a `.pkey/` manifest the server would not accept, a product slug, access to a
 * GitHub repository, or service settings that don't fit together. Each of the last four is also
 * recognised from the error itself, so a caller that passes no area still gets the right copy.
 */
export type ErrorArea =
  | "release"
  | "distribution"
  | "catalog"
  | "manifest"
  | "slug"
  | "github"
  | "services";

/** One `.pkey/` manifest problem, with the file and the JSON path it is about. */
export interface ManifestProblem {
  /** The repository path of the document: `.pkey/product`. */
  file: string;
  /** The JSON pointer inside it (`/licensing/tiers/0`), or "" for the whole document. */
  path: string;
  message: string;
}

/**
 * A fix the error offers beside its words (EXPERIENCE.md §0.3 "Inline fixes on errors"). The
 * caller renders it as a button: the GitHub App install link, or "Check again" once the operator
 * has pushed a fixed manifest.
 */
export type ErrorFix =
  | { kind: "install-github-app"; label: string; repo?: string }
  | { kind: "check-again"; label: string };

export interface ErrorCopy {
  title: string;
  description: string;
  action: ErrorAction;
  /** What still references the thing (409 in use), when the server listed them. */
  references?: string[];
  /** The fields the server refused (422): shown inline on those fields. */
  fieldErrors?: string[];
  /** One line per coherence code (422 `errors[]`, services). */
  lines?: string[];
  /** The `.pkey/` problems, each with its file and path (`area: "manifest"`). */
  problems?: ManifestProblem[];
  /**
   * The field a form should move focus to: the first refused field, or the one the area implies
   * (`slug`, `repoUrl`). It matches the field's `data-field-name`. Absent: nothing to focus.
   */
  focus?: string;
  /** A value the operator can take with one click: the free slug to try instead. */
  suggestion?: string;
  /** The fix to offer as a button, when there is one. */
  fix?: ErrorFix;
  /**
   * A JSON-able blob for "Copy details" (status, code, reason, path, time). The HTTP status lives
   * only here: a title or a description never shows it (EXPERIENCE.md §0.3).
   */
  details: Record<string, unknown>;
}

/**
 * The release policy reasons the console words (worker `services/release/policy.ts`: 18). The
 * first 12 live in `api.ts` beside the client; these are the rest, so every reason has copy.
 */
export const RELEASE_REASON_MESSAGES: Record<string, string> = {
  ...RELEASE_POLICY_ERROR_MESSAGES,
  bad_deliverable: "Choose a deliverable.",
  bad_pinned: "Pinned must be on or off.",
  bad_critical: "Critical must be on or off.",
  bad_content_api:
    "A floor per content API line applies to packs only, and the line must be 1 or higher.",
  content_api_floor_only:
    "With a content API line, only the minimum supported version can be set.",
  release_revoked:
    "This release was revoked by a CI-signed revocation, which is permanent. Publish a newer release instead.",
};

/**
 * Distribution refusals (worker `services/distribution/*`), as the console words them.
 * ADMIN.md §5.9 lists every code.
 */
export const DISTRIBUTION_ERROR_MESSAGES: Record<string, string> = {
  rollout_mirrored:
    "This rollout is mirrored from a store. Control it in the store's console.",
  invalid_transition:
    "The rollout can't move to that state from where it is now.",
  stale_release:
    "Someone changed this rollout. The matrix has been refreshed; try again.",
  release_yanked: "This release is yanked, so it can't be rolled out.",
  no_rollout: "There is no rollout here to change.",
  no_override: "There is no readiness override to clear.",
  candidate_closed: "This candidate has already been decided.",
  credential_pin_missing:
    "The App Store Connect credential has no pin. Set the pin in Outlet credentials.",
  credential_pin_mismatch:
    "The App Store Connect credential's pin doesn't match. Check it in Outlet credentials.",
  not_configured:
    "This store connector isn't configured. Set it up in Outlet credentials.",
  store_refused:
    "The store refused the request. Its message is in the details.",
  unknown_version: "The store doesn't know this version yet.",
  no_phased_release: "This version has no phased release in App Store Connect.",
  not_held: "This version isn't held for release.",
  unknown_beta_group:
    "That TestFlight group doesn't exist in App Store Connect.",
  no_webhook_secret: "No webhook secret is set for this connector.",
  unknown_track: "Google Play doesn't have that track.",
  // A-17a: typed confirmation on an App Store release (and Play's halt-with-rollback tick).
  confirmation_required:
    "This action needs its confirmation. Fill in what the dialog asks for and try again.",
  confirmation_mismatch:
    "The name you typed doesn't match the app's name in App Store Connect. Type it exactly as App Store Connect shows it.",
  // A-17g: the App Store Distribute flow and App Store products (A-17d, A-17e refusals).
  idempotency_key_required:
    "The console didn't send its retry key. Reload the page and try again.",
  idempotency_conflict:
    "This step was already sent with different values. Close the dialog and start the step again.",
  unknown_build:
    "App Store Connect has no such build for this app. The list has been refreshed.",
  build_expired:
    "This build has expired in App Store Connect. Choose a newer build.",
  build_not_ready:
    "App Store Connect hasn't finished processing this build. Wait until it is valid.",
  already_answered:
    "This build already has an export compliance answer, and it can't be changed.",
  version_not_editable:
    "This App Store version can't be changed in its current state.",
  no_build: "Attach a build to the App Store version before submitting it.",
  unknown_submission:
    "App Store Connect has no such review submission for this app.",
  not_cancelable:
    "This review submission can't be cancelled in its current state.",
  unmapped_product:
    "This product id isn't mapped to the App Store in Commerce.",
  iap_missing:
    "This In-App Purchase doesn't exist in App Store Connect yet. Create it first.",
  iap_type_mismatch:
    "App Store Connect has this product id as another type of In-App Purchase. Resolve it in App Store Connect.",
  unknown_price_point:
    "App Store Connect doesn't offer that price for this In-App Purchase. Choose a price from the list.",
  iap_not_ready:
    "This In-App Purchase isn't ready to submit. Finish its metadata in App Store Connect.",
  first_iap_portal:
    "An app's first In-App Purchase is submitted with an app version in App Store Connect.",
  unknown_iap_version:
    "App Store Connect has no such In-App Purchase version for this app.",
  unknown_background_asset_version:
    "App Store Connect has no such Background Asset version for this app.",
  background_asset_not_ready:
    "This Background Asset version isn't ready to submit.",
  write_denied:
    "Polaris Key doesn't send this kind of change to App Store Connect.",
  // A-9: the 404s keep their reason.
  unknown_outlet:
    "That outlet isn't declared any more. The page has been refreshed.",
  unknown_channel: "That channel doesn't exist for this product.",
  unknown_release:
    "That release doesn't exist any more. The page has been refreshed.",
  unknown_deliverable: "That deliverable isn't declared any more.",
  unknown_candidate: "That Sentry candidate doesn't exist any more.",
};

/** The `.pkey/` documents a manifest problem can name (shared-manifest `MANIFEST_DOCUMENTS`). */
const MANIFEST_FILES = ["product", "schema", "release", "distribution"];

/**
 * One manifest problem as the worker words it (shared-manifest `formatIngestError` and
 * `parseDocument`): `product/licensing/tiers/0: must be an object`, or `product: invalid YAML`.
 */
const MANIFEST_LINE = new RegExp(
  `^(?:\\.pkey/)?(${MANIFEST_FILES.join("|")})(/[^:\\s]*)?: (.+)$`,
  "s",
);

/** Parse every `errors[]` entry as a manifest problem, or null when any one is not. */
function manifestProblems(
  errors: string[] | undefined,
): ManifestProblem[] | null {
  if (!errors?.length) return null;
  const problems: ManifestProblem[] = [];
  for (const line of errors) {
    const m = MANIFEST_LINE.exec(line);
    if (!m) return null;
    problems.push({ file: `.pkey/${m[1]}`, path: m[2] ?? "", message: m[3]! });
  }
  return problems;
}

/**
 * Strip an HTTP status a server message carries ("github access failed: 404 Not Found",
 * "(422 bad_request)", "api 500"): a title or a description never shows one (EXPERIENCE.md §0.3).
 * What is left is the message's words; null when nothing is.
 */
function withoutStatus(message: string | null): string | null {
  if (!message) return null;
  const words = message
    .replace(/\s*\(\s*[1-5]\d\d(?:\s+[\w-]+)?\s*\)/g, "")
    .replace(/:\s*(?:HTTP\s+)?[1-5]\d\d(?:\s+[A-Za-z][A-Za-z -]*)?$/i, "")
    .replace(/^(?:api|HTTP)\s+[1-5]\d\d$/i, "")
    .trim();
  return words || null;
}

/** "taken" (exists), "reserved" or "invalid": why the slug was refused. */
type SlugProblem = "taken" | "reserved" | "invalid";

function slugProblem(
  error: ApiError,
  message: string,
  area: ErrorArea | undefined,
): SlugProblem | null {
  if (error.reason === "reserved_slug" || /^reserved slug\b/i.test(message))
    return "reserved";
  if (
    error.reason === "slug_taken" ||
    /\bproduct (?:already )?exists\b/i.test(message)
  )
    return "taken";
  if (/^invalid slug\b/i.test(message)) return "invalid";
  // Only a refusal of the slug alone: one that names other fields too is a form's to word.
  const slugField = error.fields?.length === 1 && error.fields[0] === "slug";
  if (slugField || area === "slug") {
    if (error.status === 409) return "taken";
    if (slugField) return "invalid";
  }
  return null;
}

/** "github app is not installed…", "installation token failed: 403", and the other access failures. */
type GitHubProblem =
  | "not-installed"
  | "not-configured"
  | "bad-repo"
  | "unreachable";

function githubProblem(
  status: number,
  hasFields: boolean,
  message: string,
  area: ErrorArea | undefined,
): GitHubProblem | null {
  if (/github app not configured/i.test(message)) return "not-configured";
  if (/could not parse a github/i.test(message)) return "bad-repo";
  if (
    /github app is not installed/i.test(message) ||
    /installation (?:discovery|token) failed:\s*(?:401|403|404)\b/i.test(
      message,
    ) ||
    /(?:repo file fetch|github access) failed:\s*(?:401|403|404)\b/i.test(
      message,
    )
  )
    return "not-installed";
  // The other access failures `linkRepo` and resync pass through; a message that merely says
  // "github" (a CI environment field, say) is not one of them. The area alone never claims an
  // ended session, a missing permission or a rate limit: the status table words those.
  if (
    /github access failed|github manifest fetch failed|installation (?:discovery|token)|repo file/i.test(
      message,
    ) ||
    (area === "github" && !hasFields && ![401, 403, 429].includes(status))
  )
    return "unreachable";
  return null;
}

/** The field a refused request should focus: the first one the server named. */
function firstField(error: ApiError): string | undefined {
  return error.fields?.[0];
}

/** Is this a network failure (fetch rejected before any response)? */
function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    /network|failed to fetch|load failed/i.test(error.message)
  );
}

/** The server's own message, when it sent one (ApiError's default message is "api {status}"). */
function serverMessage(error: ApiError): string | null {
  return error.message && error.message !== `api ${error.status}`
    ? error.message
    : null;
}

function detailsOf(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    time: new Date().toISOString(),
    path: typeof window !== "undefined" ? window.location.hash : undefined,
  };
  if (error instanceof ApiError) {
    return {
      ...base,
      status: error.status,
      code: error.code,
      reason: error.reason,
      fields: error.fields,
      errors: error.errors,
      message: serverMessage(error) ?? undefined,
    };
  }
  if (error instanceof Error) return { ...base, message: error.message };
  return { ...base, value: String(error) };
}

function referencesOf(error: ApiError): string[] | undefined {
  const refs = (error as ApiError & { references?: unknown }).references;
  return Array.isArray(refs) ? refs.map(String) : undefined;
}

/** Map any thrown value to the console's copy. Total: it never throws. */
export function errorCopy(
  error: unknown,
  context: ErrorContext = {},
): ErrorCopy {
  const details = detailsOf(error);
  const thing = context.thing ?? "This item";

  if (!(error instanceof ApiError)) {
    if (isNetworkError(error)) {
      return {
        title: "Can't reach Polaris Key",
        description:
          "Check your connection and try again. Nothing was changed.",
        action: "retry",
        details,
      };
    }
    return {
      title: "Something went wrong",
      description:
        (error instanceof Error && withoutStatus(error.message)) ||
        "The console hit an unexpected error.",
      action: "copy-details",
      details,
    };
  }

  const { status, code, reason } = error;
  const raw = serverMessage(error);
  // What a description may quote from the server: its words, never its status (§0.3).
  const message = withoutStatus(raw);

  // Reason tables first: they are the most specific. Distribution first in its own area.
  const distribution =
    (reason && DISTRIBUTION_ERROR_MESSAGES[reason]) || undefined;
  if (distribution && context.area === "distribution") {
    return {
      title: "Distribution refused this",
      description: distribution,
      action: reason === "stale_release" ? "retry" : "none",
      details,
    };
  }
  if (reason && RELEASE_REASON_MESSAGES[reason]) {
    return {
      title: "The release policy refused this",
      description: RELEASE_REASON_MESSAGES[reason]!,
      action: "none",
      fieldErrors: error.fields,
      focus: firstField(error),
      details,
    };
  }
  if (distribution) {
    return {
      title: "Distribution refused this",
      description: distribution,
      action: reason === "stale_release" ? "retry" : "none",
      details,
    };
  }

  // UX-01: the product-setup refusals, each worded as its own problem. Recognized from the error
  // itself, so a caller without an area gets the same copy; `context.area` only widens the match.
  const routed = setupCopy(error, raw ?? "", context, details);
  if (routed) return routed;

  if (status === 401) {
    return {
      title: "Your session ended",
      description:
        "Sign in again to continue; your unsaved changes stay in this tab.",
      action: "sign-in",
      details,
    };
  }
  if (status === 403) {
    if (/csrf/i.test(`${code ?? ""} ${reason ?? ""} ${raw ?? ""}`)) {
      return {
        title: "Your session token is out of date",
        description: "Reload the page to refresh it, then try again.",
        action: "reload",
        details,
      };
    }
    return {
      title: "You can't do that",
      description: message ?? "Your session isn't allowed to make this change.",
      action: "none",
      details,
    };
  }
  if (status === 404) {
    return {
      title: `${thing} not found`,
      description:
        message ?? "It may have been deleted, or the link may be out of date.",
      action: "none",
      details,
    };
  }
  if (status === 409) {
    const references = referencesOf(error);
    if (references || /in use|referenc/i.test(message ?? "")) {
      return {
        title: `${thing} is still in use`,
        description: references?.length
          ? `Used by ${references.length} ${references.length === 1 ? "item" : "items"}.`
          : (message ?? "Remove what uses it first."),
        action: "none",
        references,
        details,
      };
    }
    if (context.area === "catalog") {
      return {
        title: "The catalog changed since you started",
        description: "Review the newer version, or discard your draft.",
        action: "review",
        details,
      };
    }
    return {
      title: "This changed on the server",
      description:
        message ?? "Reload to see the latest version, then try again.",
      action: "reload",
      details,
    };
  }
  if ((status === 422 || status === 400) && error.fields?.length) {
    const n = error.fields.length;
    return {
      title: n === 1 ? "Fix 1 field" : `Fix ${n} fields`,
      description: message ?? "Some values weren't accepted.",
      action: "fields",
      fieldErrors: error.fields,
      focus: firstField(error),
      details,
    };
  }
  if (status === 429) {
    return {
      title: "Too many requests",
      description: "Wait a moment and try again.",
      action: "retry",
      details,
    };
  }
  if (status === 413) {
    return {
      title: "The request was too large",
      description: "This is a console problem. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (code === "invalid_json") {
    return {
      title: "The request was malformed",
      description: "This is a console problem. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (status === 503) {
    return {
      title: "The platform keyring is unavailable",
      description:
        "Polaris Key can't unseal product keys right now. Check the keyring on the Platform page.",
      action: "platform",
      details,
    };
  }
  if (code === "catalog_unavailable") {
    return {
      title: "The catalog couldn't be read",
      description:
        "The stored catalog is unavailable. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  if (code === "document_not_representable") {
    return {
      title: "This document can't be represented",
      description:
        "The server couldn't build a signed document from this data. Copy the details for a report.",
      action: "copy-details",
      details,
    };
  }
  return {
    // A 5xx is the server failing, not a refusal; "refused" is for 4xx. The status and code stay
    // in `details` for Copy details; the words never carry them (EXPERIENCE.md §0.3, UX-01).
    title:
      status >= 500
        ? "Something went wrong on the server"
        : "The server refused this",
    description: message ?? "Copy the details for a support report.",
    action: "copy-details",
    details,
  };
}

/** "1 problem", "3 problems". */
function problemCount(n: number): string {
  return n === 1 ? "1 problem" : `${n} problems`;
}

/**
 * The product-setup refusals (EXPERIENCE.md §0.4 S1, §11.3 "Errors"): a `.pkey/` manifest the
 * server would not accept, a slug that is taken or reserved, GitHub access, and service settings
 * that don't fit together. Null when the error is none of these, so the status table words it.
 */
function setupCopy(
  error: ApiError,
  message: string,
  context: ErrorContext,
  details: Record<string, unknown>,
): ErrorCopy | null {
  const { area } = context;

  // A manifest: every `errors[]` line names a `.pkey/` file. Service coherence codes never do.
  const problems = manifestProblems(error.errors);
  if (problems || (area === "manifest" && error.errors?.length)) {
    const list =
      problems ??
      error.errors!.map((line) => ({
        file: ".pkey/",
        path: "",
        message: line,
      }));
    const files = new Set(list.map((p) => p.file));
    const only = files.size === 1 && problems ? [...files][0] : undefined;
    return {
      title: only
        ? `${problemCount(list.length)} in ${only}`
        : `The manifest has ${problemCount(list.length)}`,
      description:
        list.length === 1
          ? "Fix it in a commit, then check again."
          : "Fix them in one commit, then check again.",
      action: "none",
      problems: list,
      lines: list.map((p) =>
        problems ? `${p.file}${p.path}: ${p.message}` : p.message,
      ),
      fix: { kind: "check-again", label: "Check again" },
      details,
    };
  }

  const slug = slugProblem(error, message, area);
  if (slug) {
    const named =
      context.slug ?? /exists:\s*([a-z0-9-]+)/i.exec(message)?.[1] ?? undefined;
    const suggestion = named ? `${named}-app` : undefined;
    if (slug === "taken") {
      return {
        title: named ? `${named} is taken` : "That slug is taken",
        description: suggestion ? `Try ${suggestion}.` : "Choose another slug.",
        action: "fields",
        fieldErrors: ["slug"],
        focus: "slug",
        suggestion,
        details,
      };
    }
    if (slug === "reserved") {
      return {
        title: named ? `${named} is reserved` : "That slug is reserved",
        description: suggestion
          ? `Polaris Key uses this address itself. Try ${suggestion}.`
          : "Polaris Key uses this address itself. Choose another slug.",
        action: "fields",
        fieldErrors: ["slug"],
        focus: "slug",
        suggestion,
        details,
      };
    }
    return {
      title: "That slug can't be used",
      description: "Use lowercase letters, digits and hyphens.",
      action: "fields",
      fieldErrors: ["slug"],
      focus: "slug",
      details,
    };
  }

  // A refused field (`repoUrl is required`) is the form's to word, even in the GitHub area.
  const github = githubProblem(
    error.status,
    Boolean(error.fields?.length),
    message,
    area,
  );
  if (github) {
    const repo = context.repo;
    const where = repo ?? "this repository";
    if (github === "not-installed") {
      return {
        title: `The GitHub App can't read ${where}`,
        description: `The Polaris Key GitHub App isn't installed on ${where}, or the repo is private.`,
        action: "none",
        focus: "repoUrl",
        fix: {
          kind: "install-github-app",
          label: "Install the GitHub App",
          repo,
        },
        details,
      };
    }
    if (github === "not-configured") {
      return {
        title: "The GitHub App isn't set up",
        description:
          "This platform has no GitHub App credentials yet. Add them on the Platform page.",
        action: "platform",
        details,
      };
    }
    if (github === "bad-repo") {
      return {
        title: "That isn't a GitHub repository",
        description:
          "Enter it as owner/repo, like acme/tonebox, or paste its URL.",
        action: "fields",
        fieldErrors: ["repoUrl"],
        focus: "repoUrl",
        details,
      };
    }
    return {
      title: "Couldn't reach GitHub",
      description: `GitHub didn't answer for ${where}. Try again in a moment.`,
      action: "retry",
      details,
    };
  }

  // Service coherence: codes that name a relationship, not a field (services, 422 `errors[]`).
  if (error.errors?.length && (area === "services" || error.status === 422)) {
    return {
      title: "These services depend on each other",
      description: "Change the settings below so they fit together.",
      action: "fields",
      lines: error.errors.map((c) => SERVICE_ERROR_MESSAGES[c] ?? c),
      details,
    };
  }
  return null;
}

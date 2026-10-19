/**
 * The New product wizard's model (ST-43): the draft, the slug and repository helpers, the plan a
 * set of answers implies, and the words of a refusal. Pure: the page owns the state and the calls.
 */

import { isReservedProductSlug } from "@polaris-key/manifest";
import type { CreateChoices } from "../../../../api.js";
import type { ErrorCopy } from "../../../../lib/errorCopy.js";
import { slugError } from "../../../../lib/products.js";
import {
  FEATURES,
  SERVICE_REQUIRES,
  SERVICE_TABLE,
  type FeatureId,
  type ServiceSlug,
} from "../../../../services.generated.js";

/**
 * Where the product's definition comes from. The URL keeps the old `?via=` names, so Home's and
 * Products' first-run links still preselect: `manual` is "From scratch", `github` is "A GitHub
 * repository".
 */
export type Via = "github" | "manual";

/** The draft. Nothing in it is secret, so it may live in `sessionStorage` (ADMIN.md §5.7). */
export interface ProductDraft {
  name: string;
  slug: string;
  /** The operator typed the slug: it no longer follows the name. */
  slugEdited: boolean;
  repo: string;
  /** "What it's for": the features to turn on. */
  features: FeatureId[];
  /** The planned platforms (Ship builds). */
  platforms: string[];
  /** Start with a Free tier (Licensing). */
  freeTier: boolean;
  /** "I'll choose later": create with no services. */
  later: boolean;
}

/** What most products start with (FLOWS.md §3.4): sell it, and ship it. */
export const RECOMMENDED: readonly FeatureId[] = ["licensing", "ship-builds"];

const EMPTY: ProductDraft = {
  name: "",
  slug: "",
  slugEdited: false,
  repo: "",
  features: [...RECOMMENDED],
  platforms: [],
  freeTier: true,
  later: false,
};

export const DRAFT_KEY = "pk-product-new";

const FEATURE_IDS = new Set<string>(FEATURES.map((f) => f.id));

export function readDraft(): ProductDraft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<ProductDraft>;
    const strings = (x: unknown): string[] =>
      Array.isArray(x)
        ? x.filter((i): i is string => typeof i === "string")
        : [];
    return {
      name: typeof v.name === "string" ? v.name : "",
      slug: typeof v.slug === "string" ? v.slug : "",
      slugEdited: v.slugEdited === true,
      repo: typeof v.repo === "string" ? v.repo : "",
      features: Array.isArray(v.features)
        ? (strings(v.features).filter((f) => FEATURE_IDS.has(f)) as FeatureId[])
        : EMPTY.features,
      platforms: strings(v.platforms),
      freeTier: v.freeTier !== false,
      later: v.later === true,
    };
  } catch {
    return EMPTY;
  }
}

export function writeDraft(draft: ProductDraft | null): void {
  try {
    if (draft === null) window.sessionStorage.removeItem(DRAFT_KEY);
    else window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // storage unavailable: the draft lasts as long as the page
  }
}

export const isDirty = (d: ProductDraft): boolean =>
  JSON.stringify(d) !== JSON.stringify(EMPTY);

/**
 * The slug a name derives (EXPERIENCE.md S1: "Name first; the slug follows"): lowercase ASCII
 * letters and digits, everything else a single hyphen, no hyphen at either end.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `owner/repo` from what the worker's `parseRepoUrl` accepts: an https or git@ GitHub URL, or a
 * bare `owner/repo`. Null when it is neither.
 */
export function repoOf(input: string): string | null {
  const t = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const m =
    t.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i) ??
    t.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  return m && m[1] && m[2] ? `${m[1]}/${m[2]}` : null;
}

/** What the registry says about a slug, before asking the server. */
export type SlugVerdict =
  | { kind: "empty" }
  | { kind: "invalid"; message: string }
  | { kind: "reserved" }
  | { kind: "taken"; suggestion: string }
  | { kind: "available" }
  /** The registry hasn't loaded: the server decides on Create. */
  | { kind: "unknown" };

/** The server's reservations (P0-14): router paths, admin actions, the system product. */
export const isReserved = (slug: string): boolean =>
  isReservedProductSlug(slug);

/** The first free variant of a taken slug: `-app`, then `-2`, `-3`… */
export function suggestSlug(slug: string, taken: ReadonlySet<string>): string {
  const free = (s: string) => !taken.has(s) && !isReserved(s);
  if (free(`${slug}-app`)) return `${slug}-app`;
  for (let i = 2; ; i++) if (free(`${slug}-${i}`)) return `${slug}-${i}`;
}

export function slugVerdict(
  slug: string,
  taken: ReadonlySet<string> | null,
): SlugVerdict {
  const t = slug.trim();
  if (t === "") return { kind: "empty" };
  const invalid = slugError(t);
  if (invalid) return { kind: "invalid", message: invalid };
  if (isReserved(t)) return { kind: "reserved" };
  if (!taken) return { kind: "unknown" };
  if (taken.has(t)) return { kind: "taken", suggestion: suggestSlug(t, taken) };
  return { kind: "available" };
}

/**
 * A slug refusal on the GitHub path, worded as the manifest change it needs: the slug lives in
 * `product.slug` in `.pkey/product`, so there is no free slug to take on this screen. The
 * reason `errorCopy` gives (reserved, malformed) is kept; its "Try …" is not.
 */
export function manifestSlugRefusal(copy: ErrorCopy): ErrorCopy {
  const reason = copy.description
    .replace(/\s*(?:Try \S+|Choose another slug)\.$/, "")
    .trim();
  // link-repo registers new products only: a repository already registered resyncs from its
  // product's page, so "taken" may mean this very product.
  const resync = /\btaken$/.test(copy.title)
    ? " If it is this repository's product, resync it from that product instead."
    : "";
  return {
    ...copy,
    description: `${reason ? `${reason} ` : ""}The slug comes from product.slug in .pkey/product: change it there, push, then check again.${resync}`,
    fieldErrors: undefined,
    suggestion: undefined,
    focus: undefined,
    fix: { kind: "check-again", label: "Check again" },
  };
}

/**
 * "tonebox is taken. Try tonebox-app." for a slug the server refused: `errorCopy`'s title and
 * description together. The free slug it offers is checked against the registry here, so a
 * suggestion that is itself taken is swapped for one that is not.
 */
export function slugRefusal(
  copy: ErrorCopy,
  slug: string,
  taken: ReadonlySet<string>,
): { message: string; suggestion?: string } {
  const suggestion = copy.suggestion
    ? suggestSlug(slug, new Set([...taken, slug]))
    : undefined;
  const description =
    copy.suggestion && suggestion
      ? copy.description.replace(copy.suggestion, suggestion)
      : copy.description;
  return {
    message: `${copy.title.replace(/[.!]$/, "")}. ${description}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

// ── What it's for ───────────────────────────────────────────────────────────────────────────

const labelOf = (slug: ServiceSlug): string =>
  FEATURES.find((f) => f.services.includes(slug))?.label ?? slug;

/** The services a set of features turns on: their own, and what those require. */
export function servicesFor(features: readonly FeatureId[]): {
  services: ServiceSlug[];
  /** Services that come with the choice rather than being chosen, with the feature each is. */
  alongside: { feature: string; because: string }[];
} {
  const own = new Set<ServiceSlug>();
  for (const f of FEATURES)
    if (features.includes(f.id)) for (const s of f.primary) own.add(s);
  const all = new Set<ServiceSlug>(own);
  const because = new Map<ServiceSlug, ServiceSlug>();
  const add = (slug: ServiceSlug, from: ServiceSlug) => {
    for (const req of SERVICE_REQUIRES[slug]) {
      if (!all.has(req)) {
        all.add(req);
        because.set(req, from);
      }
      add(req, from);
    }
  };
  for (const s of [...own]) add(s, s);
  const order = SERVICE_TABLE.map((r) => r.slug);
  const services = order.filter((s) => all.has(s));
  const alongside = services
    .filter((s) => !own.has(s))
    .map((s) => ({ feature: labelOf(s), because: labelOf(because.get(s)!) }));
  return { services, alongside };
}

/** The body of a manual create for these answers (no licence defaults: tiers own them). */
export function choicesFor(d: ProductDraft): CreateChoices {
  if (d.later) return { services: [], starterTier: "none" };
  const { services } = servicesFor(d.features);
  return {
    services,
    ...(d.platforms.length > 0 && services.includes("release")
      ? { intendedPlatforms: d.platforms }
      : {}),
    starterTier: d.freeTier && services.includes("license") ? "free" : "none",
  };
}

/** The plan in the future tense (FLOWS.md §3.4 "Polaris Key will set this up"). */
export function planFor(d: ProductDraft): string[] {
  const choices = choicesFor(d);
  const lines = [
    "Mint and activate the signing key",
    "Create the Default profile",
  ];
  const { services, alongside } = servicesFor(d.later ? [] : d.features);
  if (services.length === 0) lines.push("Turn on no services yet");
  else {
    const chosen = FEATURES.filter((f) => d.features.includes(f.id));
    lines.push(`Turn on ${chosen.map((f) => f.label).join(", ")}`);
    for (const a of alongside)
      lines.push(`${a.feature} comes with ${a.because}`);
  }
  if (choices.starterTier === "free") lines.push("Create the Free tier");
  if (choices.intendedPlatforms?.length)
    lines.push(`Plan ${choices.intendedPlatforms.join(", ")} builds`);
  return lines;
}

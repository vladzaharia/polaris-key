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
  return (
    name
      // Letters NFKD leaves whole: ø, æ, ß, đ, ł, þ and their capitals.
      .replace(/[øØ]/g, "o")
      .replace(/[æÆ]/g, "ae")
      .replace(/ß/g, "ss")
      .replace(/[đĐ]/g, "d")
      .replace(/[łŁ]/g, "l")
      .replace(/[þÞ]/g, "th")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
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

/** The label a feature or service is called by, never its slug. */
export const featureLabel = (id: FeatureId): string =>
  FEATURES.find((f) => f.id === id)?.label ?? id;

export { platformName as platformLabel } from "../../../../lib/vocab/platforms.js";

/** One line of what each feature is for, in the reader's terms (the mockup's copy). */
export function featureCopy(id: FeatureId, name: string): string {
  const who = name.trim() || "your product";
  return {
    licensing: `Gate ${who} on a license.`,
    "managed-config": "Change settings and secrets without shipping a build.",
    "ship-builds": "Publish releases from CI to every store.",
    "sign-in": "Let people sign in with a Polaris Locker account.",
    "cloud-sync": "Each person's saves and settings, the same on every device.",
    commerce:
      "Sell packs and tiers on App Store, Google Play, Steam and itch.io.",
  }[id];
}

/** The features a feature needs on first: the owners of the services its own services require. */
export function needsOf(id: FeatureId): FeatureId[] {
  const f = FEATURES.find((x) => x.id === id)!;
  const out = new Set<FeatureId>();
  for (const s of f.primary)
    for (const req of SERVICE_REQUIRES[s]) {
      const owner = FEATURES.find((x) => x.primary.includes(req));
      if (owner && owner.id !== id) out.add(owner.id);
    }
  return FEATURES.filter((x) => out.has(x.id)).map((x) => x.id);
}

/** A feature can be chosen once everything it needs is chosen. */
export const unlocked = (
  id: FeatureId,
  chosen: readonly FeatureId[],
): boolean => needsOf(id).every((n) => chosen.includes(n));

/**
 * Turn a feature on or off. Turning one off turns off whatever needs it, and says which (the
 * mockup: "clearing Licensing also clears Commerce").
 */
export function toggleFeature(
  chosen: readonly FeatureId[],
  id: FeatureId,
  on: boolean,
): { features: FeatureId[]; cleared: FeatureId[] } {
  if (on)
    return {
      features: unlocked(id, chosen)
        ? [...new Set([...chosen, id])]
        : [...chosen],
      cleared: [],
    };
  let next = chosen.filter((f) => f !== id);
  const cleared: FeatureId[] = [];
  for (;;) {
    const drop = next.filter((f) => !unlocked(f, next));
    if (drop.length === 0) break;
    cleared.push(...drop);
    next = next.filter((f) => !drop.includes(f));
  }
  return { features: next, cleared };
}

/** The services a set of features turns on (each feature's own; the cards keep it closed). */
export function servicesFor(features: readonly FeatureId[]): {
  services: ServiceSlug[];
} {
  const own = new Set<ServiceSlug>();
  for (const f of FEATURES)
    if (features.includes(f.id)) for (const s of f.primary) own.add(s);
  return {
    services: SERVICE_TABLE.map((r) => r.slug).filter((s) => own.has(s)),
  };
}

/** What Create writes for these answers: the same facts the body below sends. */
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

/** "Creates": the rail's list, and its one-line summary for the collapsed bar. */
export function createsFor(d: ProductDraft): {
  lines: string[];
  summary: string;
} {
  const choices = choicesFor(d);
  const n = d.later ? 0 : d.features.length;
  const platforms = choices.intendedPlatforms?.length ?? 0;
  const free = choices.starterTier === "free";
  const lines = [
    "A signing key",
    n === 0 ? "No features yet" : `${n} ${n === 1 ? "feature" : "features"}`,
    ...(platforms > 0
      ? [`${platforms} ${platforms === 1 ? "platform" : "platforms"}`]
      : []),
    "Default profile",
    "Catalog v1",
    ...(free ? ["The Free tier"] : []),
  ];
  const summary = [
    n === 0 ? "No features yet" : `${n} ${n === 1 ? "feature" : "features"}`,
    ...(platforms > 0
      ? [`${platforms} ${platforms === 1 ? "platform" : "platforms"}`]
      : []),
    ...(free ? ["Free tier"] : []),
  ].join(" · ");
  return { lines, summary };
}

/** "pushed last month", in words (the picker's meta line). */
export function pushedWords(
  seconds: number,
  nowMs: number = Date.now(),
): string {
  const days = Math.floor((nowMs / 1000 - seconds) / 86_400);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (days < 1) return "pushed today";
  if (days < 30) return `pushed ${rtf.format(-days, "day")}`;
  if (days < 365)
    return `pushed ${rtf.format(-Math.floor(days / 30), "month")}`;
  return `pushed ${rtf.format(-Math.floor(days / 365), "year")}`;
}

/**
 * The Feeds area's model (F-11, F-12, plans/F-01.md §6.9): scopes, links, labels, the setup
 * snippets and the ecosystem panels' extension fields, shared by both scopes' pages.
 *
 * One component set serves two places: Platform → Package feeds (the system product's feeds, our
 * SDKs, plus the platform policy) and a product's Distribution → Package feeds. `FeedScope` picks
 * the API base and the links, and hides what a product scope has no use for (the Owner column,
 * the platform policy).
 */

import {
  Bird,
  Braces,
  Coffee,
  Cog,
  Container,
  Gamepad2,
  Hexagon,
  Package,
  type LucideIcon,
} from "lucide-react";
import { formatShort } from "../../../../lib/format.js";
import { ACCESS_LABELS, label } from "../../../../lib/labels.js";
import {
  FEED_SETUP,
  feedSetupProblem,
  renderFeedSetup,
  type FeedSetupCredential,
  type FeedSnippet,
} from "@polaris-key/manifest";
import type {
  FeedEcosystem,
  FeedOffReason,
  FeedScope,
  FeedSettings,
} from "../../../../api.js";
import { r } from "../../../routes.js";

export type { FeedScope };

export {
  ECOSYSTEM_LABELS,
  SYSTEM_PRODUCT_SLUG,
  TOKEN_ENV,
} from "../../../../lib/vocab/ecosystems.js";

export const PLATFORM_SCOPE: FeedScope = { kind: "platform" };

/** The ecosystems, in the console's order (tier 1's, then tier 3's Cargo and Go). */
export const ECOSYSTEMS: readonly FeedEcosystem[] = [
  "npm",
  "pypi",
  "oci",
  "swift",
  "maven",
  "godot",
  "cargo",
  "go",
];

export function isEcosystem(v: string | undefined): v is FeedEcosystem {
  return v !== undefined && (ECOSYSTEMS as readonly string[]).includes(v);
}

/** The clients each feed answers: its setup declaration's (`@polaris-key/manifest` FEED_SETUP). */
export const ECOSYSTEM_CLIENTS: Record<FeedEcosystem, string> =
  Object.fromEntries(
    ECOSYSTEMS.map((e) => [e, FEED_SETUP[e].clients.join(", ")]),
  ) as Record<FeedEcosystem, string>;

export const ECOSYSTEM_ICONS: Record<FeedEcosystem, LucideIcon> = {
  npm: Hexagon,
  pypi: Braces,
  oci: Container,
  swift: Bird,
  maven: Coffee,
  godot: Gamepad2,
  cargo: Cog,
  go: Package,
};

/**
 * Two access options: Public and Licensed (F-34; the console words are `ACCESS_LABELS`). The stored
 * `authenticated` is the same strictness and an old `entitled` feed (packages gated one by one)
 * also reads as Licensed. The server writes only `public` and `licensed`.
 */
const CUSTOMER_MODES: readonly string[] = [
  "authenticated",
  "licensed",
  "entitled",
];

/** The choice a stored mode is shown as: `public`, else `customers`. */
export function feedAccessChoice(mode: string): string {
  return CUSTOMER_MODES.includes(mode) ? "customers" : mode;
}

/** The mode a save writes for a choice: `public` or `licensed`. */
export function feedAccessMode(choice: string): string {
  return choice === "customers" ? "licensed" : choice;
}

/** What a registry client needs, per choice; the names come from `ACCESS_LABELS`. */
export const FEED_ACCESS_DESCRIPTIONS: Record<string, string> = {
  public: "Any client can install, with no credentials.",
  customers:
    "Clients with a registry token: yours, your CI's, or a customer's while their license is active.",
};

/** A choice or stored mode as `ACCESS_LABELS` names it: `customers` is `licensed`. */
export function feedAccessLabel(modeOrChoice: string): string {
  const mode = feedAccessMode(feedAccessChoice(modeOrChoice));
  return label(ACCESS_LABELS, mode);
}

/** A feed's access as text: an old `entitled` feed also says its packages are gated one by one. */
export function feedAccessText(mode: string): string {
  return mode === "entitled"
    ? `${feedAccessLabel(mode)}, gated per package`
    : feedAccessLabel(mode);
}

/** Why a feed does not answer, in words. */
export const OFF_REASONS: Record<FeedOffReason, string> = {
  "platform-off": "The platform has this ecosystem switched off.",
  "no-owner": "The platform's feeds are not set up.",
  "distribution-off": "Distribution is off for this product.",
  "package-feeds-off": "Package feeds are off for this product.",
  "not-set-up": "This feed has no settings yet.",
  "feed-off": "This feed is switched off.",
};

/** What a yank does to clients, per protocol (notes/S-12 §8.2). */
export const YANK_EFFECTS: Record<FeedEcosystem, string> = {
  npm: "npm has no yank that keeps lockfiles working. Deprecate a version instead: it stays installable and npm prints the message.",
  pypi: "A yanked version stays installable when pinned exactly (PEP 592); resolvers skip it otherwise.",
  oci: "A yank removes the version tag. The image stays pullable by digest.",
  swift:
    "A yanked version leaves the release list and stays fetchable for existing Package.resolved pins.",
  maven:
    "Maven has no yank. The console marks the version yanked; Hide yanked versions is on by default: the version leaves maven-metadata.xml.",
  godot: "A yanked version leaves the asset listings.",
  cargo:
    "A yanked version stays in the index marked yanked: an existing Cargo.lock still builds, and new resolutions skip it.",
  go: "A yanked version leaves @v/list, @latest and every channel, so no version query resolves to it. A go.sum that pins it keeps building.",
};

/** The feed page in this scope (its default tab, or `tab`). */
export function feedHref(
  scope: FeedScope,
  eco: FeedEcosystem,
  tab?: string,
): string {
  return scope.kind === "platform"
    ? r.platformFeed(eco, tab)
    : r.packageFeed(scope.slug, eco, tab);
}

/** The scope's registry tokens page (F-21). */
export function tokensHref(scope: FeedScope): string {
  return scope.kind === "platform"
    ? r.platformFeed("tokens")
    : r.packageFeed(scope.slug, "tokens");
}

/** The Feeds overview in this scope. */
export function overviewHref(scope: FeedScope): string {
  return scope.kind === "platform"
    ? r.platformFeeds()
    : r.packageFeeds(scope.slug);
}

/** A package record in this scope (platform: under its owner). */
export function packageHref(
  scope: FeedScope,
  eco: FeedEcosystem,
  owner: string,
  name: string,
  tab?: string,
): string {
  return scope.kind === "platform"
    ? r.platformFeedPackage(eco, owner, name, tab)
    : r.packageFeedPackage(scope.slug, eco, name, tab);
}

export type { FeedSnippet };

/** What the snippets authenticate with (plans/F-20.md §3): nothing; an environment variable
 *  (docs, CI); the real token, only in the shown-once dialog; or a Godot URL token, which travels
 *  in the editor's URL. `@polaris-key/manifest`'s `FeedSetupCredential`, the shape
 *  `renderFeedSetup` and `pkey feeds setup --token-env` share. */
export type FeedCredential = FeedSetupCredential;

/**
 * The copy-paste setup for one feed, for its owner, optionally for one package, with or without a
 * registry credential (F-21, plans/F-20.md §6.3): `@polaris-key/manifest` `renderFeedSetup`, the
 * function `pkey feeds setup` prints, so the console and the CLI are byte-identical for the same
 * input. The inputs each ecosystem's snippets read are its declaration
 * (`FEED_SETUP[eco].inputs`), never a switch here. Answers `null` when the stored settings (or
 * the token) cannot be rendered (a namespace ingest would refuse).
 */
export function feedSetupSnippets(
  eco: FeedEcosystem,
  ctx: {
    /** The registry host's origin (`registryOrigin`, or a package's base URL's origin). */
    origin: string;
    owner: string;
    namespace: FeedSettings["namespace"];
    pkg?: { name: string; version?: string | null };
  },
  credential: FeedCredential = { kind: "none" },
): FeedSnippet[] | null {
  const context = {
    origin: new URL(ctx.origin).origin,
    owner: ctx.owner,
    namespace: ctx.namespace,
    ...(ctx.pkg
      ? {
          package: {
            name: ctx.pkg.name,
            ...(ctx.pkg.version ? { version: ctx.pkg.version } : {}),
          },
        }
      : {}),
    ...(credential.kind === "none" ? {} : { credential }),
  };
  if (feedSetupProblem(eco, context) !== null) return null;
  return renderFeedSetup(eco, context);
}

/** A byte count as an operator types it: whole MiB when it divides evenly. */
export function bytesToMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function mibToBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}

/**
 * How the ecosystem panel (F-12) edits one extension setting, keyed by the setting's name, never
 * by ecosystem: the panel renders the keys the feed's adapter declares (`FeedDetailDto.extensions`)
 * and saves them into `ext_json`. A key the adapter declares but this table lacks is not shown.
 */
export type FeedExtensionInput =
  | { kind: "switch"; default: boolean }
  | { kind: "number"; min: number; max: number; unit: string }
  | {
      kind: "select";
      options: readonly { value: string; label: string }[];
      default: string;
    }
  | { kind: "text"; placeholder: string; maxLength: number; pattern?: RegExp }
  | { kind: "repositoryMap"; placeholder: string };

export interface FeedExtensionField {
  label: string;
  help: string;
  input: FeedExtensionInput;
}

export const FEED_EXTENSION_FIELDS: Record<string, FeedExtensionField> = {
  htmlFallback: {
    label: "HTML pages",
    help: "Answer clients that cannot take PEP 691 JSON with the inert PEP 503 HTML page. Off, they get 406.",
    input: { kind: "switch", default: true },
  },
  requireSigned: {
    label: "Require signed releases",
    help: "Ingest refuses a release without a SwiftPM signature. Always on for the platform's own packages.",
    input: { kind: "switch", default: true },
  },
  repositoryUrls: {
    label: "Repository URLs",
    help: "Which source repositories are which package, for SwiftPM's identifier lookup. One per line: the identity, then the URL.",
    input: {
      kind: "repositoryMap",
      placeholder: "acme.Kit https://github.com/acme/kit",
    },
  },
};

/** The ecosystem panel's section title, per protocol. */
export const FEED_PANEL_TITLES: Record<FeedEcosystem, string> = {
  npm: "npm",
  pypi: "Simple API",
  swift: "Signing and identifiers",
  maven: "Maven",
  oci: "Retention",
  godot: "Asset listing",
  cargo: "Sparse index",
  go: "Module proxy",
};

/**
 * F-34.8: the switch as a `version_conflict` 409 from `PUT …/package-feeds` reports it, or `null`
 * for any other failure. The refusal carries the owner row (its `version`, not the generic
 * settings counter), so a retry sends a counter that matches.
 */
export function packageFeedsConflict(
  error: unknown,
): import("../../../../api.js").PackageFeedsSwitch | null {
  const e = error as { status?: unknown; body?: unknown } | null;
  if (e?.status !== 409) return null;
  const feeds = (e.body as { packageFeeds?: unknown } | null | undefined)
    ?.packageFeeds;
  return feeds && typeof feeds === "object"
    ? (feeds as import("../../../../api.js").PackageFeedsSwitch)
    : null;
}

/**
 * Where focus goes after a write moved the page to its other state (the old control unmounted):
 * the off card's title after Turn off, the page title after Turn on. Read once by the page that
 * mounts next.
 */
/** Focus the next page is owed: set by a write on the Packages page, consumed once for that slug. */
export const afterWrite: {
  focus: "off-card" | "page" | null;
  slug: string | null;
  at: number;
} = { focus: null, slug: null, at: 0 };

export function markAfterWrite(focus: "off-card" | "page", slug: string): void {
  afterWrite.focus = focus;
  afterWrite.slug = slug;
  afterWrite.at = Date.now();
}

/** The owed focus for this slug, once, and only within a few seconds of the write. */
export function takeAfterWrite(
  want: "off-card" | "page",
  slug: string,
): boolean {
  const ok =
    afterWrite.focus === want &&
    afterWrite.slug === slug &&
    Date.now() - afterWrite.at < 5000;
  if (afterWrite.focus === want) afterWrite.focus = null;
  return ok;
}

/** The house short absolute form: "Oct 7, 2:05 PM" (see `formatShort`). */
export const shortWhen = (ms: number): string =>
  formatShort(ms, { time: true });

/**
 * "Turned off by Ana Lima on Oct 7, 2:05 PM". A person is named; an unnamed actor, the manifest
 * or the system (which only ever provision a row) reads "Off since …".
 */
export function offWhen(
  by: string | null | undefined,
  at: number | null | undefined,
): string | null {
  if (!at) return null;
  const when = shortWhen(at * 1000);
  const person = by && by !== "manifest" && by !== "system" ? by : null;
  return person ? `Turned off by ${person} on ${when}` : `Off since ${when}`;
}

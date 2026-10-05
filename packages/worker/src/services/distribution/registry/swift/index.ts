/**
 * The Swift package registry feed (F-06, plans/F-01.md §5.3 and §6.8; SwiftPM `Registry.md`,
 * SE-0292) as a `FeedAdapter` (`../adapter.ts`): its documents (`render.ts`) and its read routes
 * (`routes.ts`). `registry/index.ts` lists it in `FEED_ADAPTERS`.
 */

import { FEED_SETUP, PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import {
  extBoolean,
  rendererOf,
  defineFeedAdapter,
  type FeedAdapter,
} from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { normaliseRepositoryUrl } from "./protocol.js";
import { renderSwift } from "./render.js";
import { SWIFT_LOGIN_ROUTE } from "./login.js";
import { SWIFT_ROUTES } from "./routes.js";

const MAX_REPOSITORY_IDS = 64;
const MAX_URLS_PER_ID = 8;

/**
 * `ext.repositoryUrls`: `{"<scope>.<Name>": [url, …]}`, each identity of the ingest name grammar,
 * each URL one `/identifiers` normalises (`protocol.ts` `normaliseRepositoryUrl`).
 */
function swiftRepositoryUrls(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_REPOSITORY_IDS) return false;
  return entries.every(
    ([id, urls]) =>
      PACKAGE_ECOSYSTEM_RULES.swift.name.pattern.test(id) &&
      Array.isArray(urls) &&
      urls.length > 0 &&
      urls.length <= MAX_URLS_PER_ID &&
      urls.every(
        (u) =>
          typeof u === "string" &&
          u.length <= 2048 &&
          normaliseRepositoryUrl(u) !== null,
      ),
  );
}

export const SWIFT_ADAPTER: FeedAdapter<"swift"> = defineFeedAdapter({
  ecosystem: "swift",
  label: "Swift",
  hostPrefix: "/swift/",
  feedPath: (owner) => `/swift/${owner}/`,
  routes: SWIFT_ROUTES,
  // F-21: `swift package-registry login` checks a registry token here.
  authRoutes: [SWIFT_LOGIN_ROUTE],
  renderer: { render: renderSwift, stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.swift,
  settings: {
    ext: {
      requireSigned: extBoolean,
      // §4.5 `GET /identifiers?url=`: which repository URLs map to which package identity.
      repositoryUrls: swiftRepositoryUrls,
    },
  },
  capabilities: {
    // A yanked version leaves the release list and stays fetchable for existing pins.
    yank: true,
    deprecate: { unsupported: "Swift has no deprecation state" },
    yankPolicy: false,
    channels: "latest",
    signing: true,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "basic",
  },
  setup: FEED_SETUP.swift,
  openapi: [
    ["/swift/{owner}/{scope}/{name}", ["get", "head"], "swift.releases"],
    [
      "/swift/{owner}/{scope}/{name}/{version}",
      ["get", "head"],
      "swift.release",
    ],
    [
      "/swift/{owner}/{scope}/{name}/{version}/Package.swift",
      ["get", "head"],
      "swift.manifest",
    ],
    [
      "/swift/{owner}/{scope}/{name}/{version}.zip",
      ["get", "head"],
      "swift.archive",
    ],
    ["/swift/{owner}/identifiers", ["get", "head"], "swift.identifiers"],
    // F-21: SwiftPM's login (Registry.md §4.1), a credential route.
    ["/swift/{owner}/login", ["post"], "swift.login"],
  ],
  harness: { clients: ["swift", "swift-compat", "swift-linux"] },
});

/** The materialiser's view of the adapter. */
export const SWIFT_RENDERER: RegistryRenderer = rendererOf(SWIFT_ADAPTER);

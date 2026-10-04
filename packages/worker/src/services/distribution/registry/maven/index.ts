/**
 * The Maven feed (F-07, plans/F-01.md §6.8) as a `FeedAdapter` (`../adapter.ts`):
 * `maven-metadata.xml` and its checksum sidecars, rendered on write (`render.ts`), and the
 * repository layout's two routes (`routes.ts`).
 */

import { PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import { extBoolean, rendererOf, type FeedAdapter } from "../adapter.js";
import type { RegistryRenderer } from "../materialise.js";
import { renderMaven } from "./render.js";
import { mavenRoutes } from "./routes.js";

export const MAVEN_ADAPTER: FeedAdapter<"maven"> = {
  ecosystem: "maven",
  label: "Maven",
  hostPrefix: "/maven/",
  feedPath: (owner) => `/maven/${owner}/`,
  routes: mavenRoutes(() => MAVEN_RENDERER),
  renderer: { render: (pkg) => renderMaven(pkg), stamp: "package" },
  ingest: PACKAGE_ECOSYSTEM_RULES.maven,
  settings: { ext: { yankHidesFromIndex: extBoolean } },
  capabilities: {
    // Maven has no yank in the protocol; the console's yank leaves maven-metadata.xml only with
    // `yankHidesFromIndex` on.
    yank: true,
    deprecate: false,
    yankPolicy: true,
    channels: "latest",
    signing: false,
    immutableVersions: true,
    delete: false,
    search: false,
    authChallenge: "basic",
  },
  setup: {
    clients: ["Gradle", "Maven"],
    inputs: [
      "baseUrl",
      "namespace.groupPrefixes",
      "package.name",
      "package.version",
    ],
  },
  openapi: [
    [
      "/maven/{owner}/{groupPath}/{artifactId}/maven-metadata.xml",
      ["get", "head"],
      "mavenMetadata",
    ],
    [
      "/maven/{owner}/{groupPath}/{artifactId}/maven-metadata.xml.{checksum}",
      ["get", "head"],
      "mavenMetadata",
    ],
    [
      "/maven/{owner}/{groupPath}/{artifactId}/{version}/{file}",
      ["get", "head"],
      "mavenFile",
    ],
  ],
  harness: { clients: ["gradle8", "gradle9", "maven"] },
};

/** The materialiser's view of the adapter. */
export const MAVEN_RENDERER: RegistryRenderer = rendererOf(MAVEN_ADAPTER);

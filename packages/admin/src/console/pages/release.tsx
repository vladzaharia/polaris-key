import * as React from "react";
import type { SectionPageProps } from "./types.js";
import { ChannelsPage } from "./release/ChannelsPage.js";
import { CompatibilityPage } from "./release/CompatibilityPage.js";
import { ContentKeysPage } from "./release/ContentKeysPage.js";
import { DeliverablesPage } from "./release/DeliverablesPage.js";
import { PackRecord } from "./release/PackRecord.js";
import { ReleaseRecord } from "./release/ReleaseRecord.js";
import { ReleasesPage } from "./release/ReleasesPage.js";
import { SimulatorPage } from "./release/SimulatorPage.js";

/** Release (ADMIN.md §6.3): releases, channels, deliverables, compatibility, content keys. */
export default function ReleasePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "releases":
      return route.id !== undefined ? (
        <ReleaseRecord slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <ReleasesPage slug={slug} />
      );
    case "channels":
      return <ChannelsPage slug={slug} />;
    case "deliverables":
      return route.id !== undefined ? (
        <PackRecord slug={slug} id={route.id} tab={route.tab} />
      ) : (
        <DeliverablesPage slug={slug} />
      );
    case "compatibility":
      return <CompatibilityPage slug={slug} />;
    case "simulator":
      return <SimulatorPage slug={slug} />;
    case "content-keys":
      return <ContentKeysPage slug={slug} />;
    default:
      return null;
  }
}

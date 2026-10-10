import * as React from "react";
import type { SectionPageProps } from "../../pages/types.js";
import { ChannelsPage } from "./pages/ChannelsPage.js";
import { CompatibilityPage } from "./pages/CompatibilityPage.js";
import { ContentKeysPage } from "./pages/ContentKeysPage.js";
import { DeliverablesPage } from "./pages/DeliverablesPage.js";
import { PackRecord } from "./pages/PackRecord.js";
import { ReleaseRecord } from "./pages/ReleaseRecord.js";
import { ReleasesPage } from "./pages/ReleasesPage.js";
import { SimulatorPage } from "./pages/SimulatorPage.js";

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

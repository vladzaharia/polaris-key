import * as React from "react";
import { ActivityPage } from "./pages/Activity.js";
import { DevicesPage } from "./pages/Devices.js";
import { KeysPage } from "./pages/Keys.js";
import { OverviewPage } from "./pages/Overview.js";
import { PresentationPage } from "./pages/Presentation.js";
import { ServicesPage } from "./pages/Services.js";
import { SettingsPage } from "./pages/Settings.js";
import { UsersPage } from "./pages/Users.js";
// U-03: fills the user record's account override slot (a side effect, before any record renders).
import "./pages/accountOverridesSlot.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Core: Overview, Services, Devices (with the routed device drawer), Users (I-12), Presentation (HA-06),
 *  Keys & secrets, Activity and Settings (ADMIN.md §2.3, §6.2, §6.7–§6.9). */
export default function CorePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  switch (route.page) {
    case "overview":
      return <OverviewPage slug={slug} />;
    case "services":
      return <ServicesPage slug={slug} />;
    case "devices":
      return <DevicesPage slug={slug} deviceId={route.id} />;
    case "users":
      return <UsersPage slug={slug} subject={route.id} tab={route.tab} />;
    case "presentation":
      return <PresentationPage slug={slug} />;
    case "keys":
      return <KeysPage slug={slug} />;
    case "activity":
      return <ActivityPage slug={slug} />;
    case "settings":
      return <SettingsPage slug={slug} />;
    default:
      return null;
  }
}

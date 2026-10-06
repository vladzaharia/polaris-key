import * as React from "react";
import { ActivityPage } from "./core/Activity.js";
import { DevicesPage } from "./core/Devices.js";
import { KeysPage } from "./core/Keys.js";
import { OverviewPage } from "./core/Overview.js";
import { PresentationPage } from "./core/Presentation.js";
import { ServicesPage } from "./core/Services.js";
import { SettingsPage } from "./core/Settings.js";
import { UsersPage } from "./core/Users.js";
// U-03: fills the user record's account override slot (a side effect, before any record renders).
import "./core/accountOverridesSlot.js";
import type { SectionPageProps } from "./types.js";

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

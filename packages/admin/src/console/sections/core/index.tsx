import * as React from "react";
import { ActivityPage } from "./pages/Activity.js";
import { DevicesPage } from "./pages/Devices.js";
import { IntegrationPage } from "./pages/Integration.js";
import { KeysPage } from "./pages/Keys.js";
import { OverviewPage } from "./pages/Overview.js";
import { PortalPage } from "./pages/Portal.js";
import { PresentationPage } from "./pages/Presentation.js";
import { PresentationListingPage } from "./pages/PresentationListing.js";
import { ServicesPage } from "./pages/Services.js";
import { SettingsAllPage } from "./pages/SettingsAll.js";
import { SettingsHub } from "./pages/SettingsHub.js";
import { SettingsMembersPage } from "./pages/SettingsMembers.js";
import { UsersPage } from "./pages/Users.js";
// U-03: fills the user record's account override slot (a side effect, before any record renders).
import "./pages/accountOverridesSlot.js";
// U-11a: fills the user record's Data tab slot.
import "./pages/dataTabSlot.js";
import type { SectionPageProps } from "../../pages/types.js";

/** Core: Overview, Services, Devices (with the routed device drawer), Users (I-12), Presentation (HA-06),
 *  Keys and secrets, Activity and Settings (ADMIN.md §2.3, §6.2, §6.7–§6.9). */
export default function CorePages({
  route,
}: SectionPageProps): React.ReactElement | null {
  const { slug } = route;
  const hub = (page: React.ReactNode): React.ReactElement => (
    <SettingsHub slug={slug} page={route.page}>
      {page}
    </SettingsHub>
  );
  switch (route.page) {
    case "overview":
      return <OverviewPage slug={slug} />;
    case "integration":
      return <IntegrationPage slug={slug} />;
    case "devices":
      return <DevicesPage slug={slug} deviceId={route.id} />;
    case "users":
      return <UsersPage slug={slug} subject={route.id} tab={route.tab} />;
    case "activity":
      return <ActivityPage slug={slug} />;
    // The settings hub (ST-08): one h1, one row of area tabs, one Core page per area.
    case "settings":
      return hub(<ServicesPage slug={slug} openDetails />);
    case "services":
      return hub(<ServicesPage slug={slug} />);
    case "presentation":
      return hub(<PresentationPage slug={slug} />);
    case "presentation-listing":
      return hub(<PresentationListingPage slug={slug} />);
    case "portal":
      return hub(<PortalPage slug={slug} />);
    case "keys":
      return hub(<KeysPage slug={slug} />);
    case "settings-members":
      return hub(<SettingsMembersPage slug={slug} />);
    case "settings-all":
      return hub(<SettingsAllPage slug={slug} />);
    default:
      return null;
  }
}

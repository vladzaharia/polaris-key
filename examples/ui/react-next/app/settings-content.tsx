"use client";

import { About, Devices, Settings, UpdatePrompt } from "@polaris-key/react/kit";

/** The App Router settings content: the React kit's parts, which read the SDK themselves inside the
 *  provider. Each pane's heading sits under the page's one h1. */
export function SettingsContent() {
  return (
    <div className="settings">
      <h1>Settings</h1>
      <UpdatePrompt />
      <Devices />
      <Settings />
      <About />
    </div>
  );
}

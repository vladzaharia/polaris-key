// The kit's parts placed by the app (UI-KITS.md §1.3, layer a): inside the provider each part reads
// the SDK itself, so this page holds no data code. The parts draw in the product's look with no
// theme code (Tidewater's accent and name reach them through the provider's presentation), and
// each pane's heading sits under the page's one h1.
import { About, Devices, Settings, UpdatePrompt } from "@polaris-key/react/kit";

export function SettingsPage() {
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

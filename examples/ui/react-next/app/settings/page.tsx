import type { Metadata } from "next";

import { SettingsContent } from "../settings-content";

export const metadata: Metadata = {
  title: "Settings · Tidewater Studio",
};

export default function SettingsPage() {
  return <SettingsContent />;
}

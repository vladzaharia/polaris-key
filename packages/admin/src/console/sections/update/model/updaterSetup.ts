/**
 * What each updater needs from the developer (P2-11), pure: the steps, the feed URLs it reads and
 * the snippet that points the app at them. The worker answers which updaters a platform can use
 * and whether it is Verified (`UpdatersView`); the words are the console's.
 */

import type { CodeLanguage } from "../../../../lib/highlight.js";
import type { UpdaterId } from "../../../../api.js";

export const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

export const UPDATER_LABEL: Record<UpdaterId, string> = {
  sparkle: "Sparkle",
  winsparkle: "WinSparkle",
  velopack: "Velopack",
  "app-installer": "App Installer",
  zsync: "zsync",
  "signed-feed": "Signed feed",
  godot: "Godot updater",
  play: "Play in-app updates",
  store: "App Store",
};

export interface UpdaterSetup {
  steps: string[];
  /** The feed URLs the updater reads; none for a store-driven one. */
  endpoints: { label: string; url: string }[];
  snippet: { language: CodeLanguage; filename?: string; code: string } | null;
}

export interface UpdaterSetupInput {
  updater: UpdaterId;
  platform: string;
  /** `publicUrl(slug, path)`: the product's origin and slug in front of a path. */
  url: (path: string) => string;
  channel: string;
}

/** Velopack's feed name per platform (`releases.<vch>.json`). */
const VELOPACK_CHANNEL: Record<string, string> = {
  windows: "win",
  macos: "osx",
  linux: "linux",
};

const KEY_STEPS = [
  "Make a signing key with Sparkle's generate_keys. Keep the private half in CI.",
  "Set the public half as sparkleEd25519Pub in .pkey/release.",
];

export function renderUpdaterSetup(i: UpdaterSetupInput): UpdaterSetup {
  const feed = (name: string) => i.url(`update/${i.channel}/${name}`);
  switch (i.updater) {
    case "sparkle": {
      const url = feed("appcast.xml");
      return {
        steps: [
          ...KEY_STEPS,
          "Put the feed and the public key in the app's Info.plist.",
          "Use PolarisKeyUpdate to send the device's license token and architecture with each check.",
        ],
        endpoints: [{ label: "Appcast", url }],
        snippet: {
          language: "text",
          filename: "Info.plist",
          code: `<key>SUFeedURL</key>\n<string>${url}</string>\n<key>SUPublicEDKey</key>\n<string>YOUR_PUBLIC_KEY</string>`,
        },
      };
    }
    case "winsparkle": {
      const url = feed("winsparkle.xml");
      return {
        steps: [
          ...KEY_STEPS,
          "Publish the installer as inno, nsis or msi so the appcast carries its silent arguments.",
          "Point WinSparkle at the feed and the public key before init.",
        ],
        endpoints: [{ label: "Appcast", url }],
        snippet: {
          language: "text",
          filename: "main.c",
          code: `win_sparkle_set_appcast_url("${url}");\nwin_sparkle_set_eddsa_public_key("YOUR_PUBLIC_KEY");\nwin_sparkle_init();`,
        },
      };
    }
    case "velopack": {
      const vch = VELOPACK_CHANNEL[i.platform] ?? "win";
      const base = feed("velopack/");
      return {
        steps: [
          "Pack each release with vpk and publish its files through Polaris Key.",
          "Point UpdateManager at the feed.",
        ],
        endpoints: [{ label: "Feed", url: `${base}releases.${vch}.json` }],
        snippet: {
          language: "text",
          filename: "Program.cs",
          code: `var mgr = new UpdateManager(new SimpleWebSource("${base}"));`,
        },
      };
    }
    case "app-installer": {
      const url = feed("app.appinstaller");
      return {
        steps: [
          "Publish the MSIX package.",
          "Link the App Installer file from your download page.",
        ],
        endpoints: [{ label: "App Installer file", url }],
        snippet: {
          language: "text",
          filename: "link",
          code: `ms-appinstaller:?source=${url}`,
        },
      };
    }
    case "zsync": {
      const url = feed("BUILD_ID.AppImage.zsync");
      return {
        steps: [
          "Publish the AppImage.",
          "Embed the update information in the AppImage, with the build's id for BUILD_ID.",
        ],
        endpoints: [{ label: "zsync file", url }],
        snippet: { language: "text", code: `zsync|${url}` },
      };
    }
    case "signed-feed": {
      const url = feed("feed.jws");
      return {
        steps: [
          "Pin your keys in the app.",
          "The SDK's update client fetches the feed and checks it against them.",
        ],
        endpoints: [{ label: "Signed feed", url }],
        snippet: null,
      };
    }
    case "godot":
      return {
        steps: [
          "Turn on the updater in the export preset.",
          "Set the public key in the project settings.",
          "The updater finds its feed through discovery.",
        ],
        endpoints: [
          { label: "Discovery", url: i.url(".well-known/polaris.json") },
        ],
        snippet: {
          language: "text",
          filename: "project settings",
          code: `polaris_key/sparkle/public_ed_key = "YOUR_PUBLIC_KEY"`,
        },
      };
    case "play":
      return {
        steps: [
          "Publish the app on Google Play.",
          "Play offers the update. Devices report the outcome.",
        ],
        endpoints: [],
        snippet: null,
      };
    case "store":
      return {
        steps: ["The App Store offers the update. Devices report the outcome."],
        endpoints: [],
        snippet: null,
      };
  }
}

/**
 * What each updater needs from the developer (P2-11), pure: the steps, the snippets that point the
 * app at the feed and, where the feed asks for it, the licence token. The worker answers which
 * updaters a platform can use and whether its group is Verified (`UpdatersView`); the words are
 * the console's. Identifiers sit in backticks; the page draws them as code.
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
  zsync: "AppImage",
  godot: "Godot updater",
  play: "Play in-app updates",
};

export interface Snippet {
  /** What the block is and where it goes: "Info.plist", "PKeyOptions". */
  label: string;
  language: CodeLanguage;
  code: string;
}

export interface UpdaterSetup {
  steps: string[];
  snippets: Snippet[];
}

export interface UpdaterSetupInput {
  updater: UpdaterId;
  platform: string;
  /** `publicUrl(slug, path)`: the product's origin and slug in front of a path. */
  url: (path: string) => string;
  /** The release track whose feed the snippets read. */
  channel: string;
  /** The app's delivery access mode; anything but `public` makes a check send the licence token. */
  access: string | null;
  /** The platform's signing key is made on another card: say so instead of repeating the steps. */
  keyShared: boolean;
  /** Whether the app is a Godot game: the Android card adds its GDScript call. */
  godot: boolean;
}

/** Velopack's feed name per platform (`releases.<vch>.json`). */
const VELOPACK_CHANNEL: Record<string, string> = {
  windows: "win",
  macos: "osx",
  linux: "linux",
};

export const KEY_STEPS = [
  "Make a signing key with `generate_keys` from Sparkle. Keep the private half in CI.",
  "Set the public half as `sparkleEd25519Pub` in `.pkey/release`.",
];
const KEY_SHARED = "Signing key: the same one as above.";

export function renderUpdaterSetup(i: UpdaterSetupInput): UpdaterSetup {
  const feed = (name: string) => i.url(`update/${i.channel}/${name}`);
  const token = i.access !== null && i.access !== "public";
  const keySteps = i.keyShared ? [KEY_SHARED] : KEY_STEPS;
  switch (i.updater) {
    case "sparkle":
      return {
        steps: [
          ...keySteps,
          "Put the public key in the app's `Info.plist`.",
          "Start `PolarisSparkle`: it reads the feed from discovery and sends the device's license token and architecture with each check.",
        ],
        snippets: [
          {
            label: "Swift, PolarisKeyUpdate",
            language: "text",
            code: `let sparkle = try await PolarisSparkle.start(client: client)`,
          },
          {
            label: "Info.plist, also required",
            language: "text",
            code: `<key>SUPublicEDKey</key>\n<string>YOUR_SPARKLE_PUBLIC_KEY</string>`,
          },
        ],
      };
    case "winsparkle":
      return {
        steps: [
          ...keySteps,
          "Publish the installer as `inno`, `nsis` or `msi` so the appcast carries its silent arguments.",
          token
            ? "Point WinSparkle at the feed and the public key, and send the device's license token with each check."
            : "Point WinSparkle at the feed and the public key before `win_sparkle_init`.",
        ],
        snippets: [
          {
            label: "C, WinSparkle",
            language: "text",
            code: [
              `win_sparkle_set_appcast_url("${feed("winsparkle.xml")}");`,
              `win_sparkle_set_eddsa_public_key("YOUR_SPARKLE_PUBLIC_KEY");`,
              ...(token
                ? [
                    `win_sparkle_set_http_header("Authorization", "Bearer " + license_token);`,
                  ]
                : []),
              `win_sparkle_init();`,
            ].join("\n"),
          },
        ],
      };
    case "velopack": {
      const vch = VELOPACK_CHANNEL[i.platform] ?? "win";
      const base = feed("velopack/");
      return {
        steps: [
          "Pack each release with `vpk` and publish its files through Polaris Key.",
          token
            ? `Point \`UpdateManager\` at the feed, \`releases.${vch}.json\`, with the device's license token as a bearer.`
            : `Point \`UpdateManager\` at the feed, \`releases.${vch}.json\`.`,
        ],
        snippets: [
          {
            label: "C#, UpdateManager",
            language: "text",
            code: token
              ? `var mgr = new UpdateManager(new SimpleWebSource("${base}", bearerToken: licenseToken));`
              : `var mgr = new UpdateManager(new SimpleWebSource("${base}"));`,
          },
        ],
      };
    }
    case "app-installer":
      return {
        steps: [
          "Publish the MSIX package.",
          "Link the `.appinstaller` file from your download page. Windows reads the update rules in it.",
        ],
        snippets: [
          {
            label: "Download page link",
            language: "text",
            code: feed("app.appinstaller"),
          },
        ],
      };
    case "zsync":
      return {
        steps: [
          "Publish the AppImage.",
          "Embed the update information in the AppImage. `BUILD_ID` is the build's id in your release's artifact map.",
        ],
        snippets: [
          {
            label: "AppImage update information",
            language: "text",
            code: `zsync|${feed("BUILD_ID.AppImage.zsync")}`,
          },
        ],
      };
    case "godot":
      return godotSetup(i, keySteps);
    case "play": {
      const snippets: Snippet[] = [
        {
          label: "Kotlin, play flavor",
          language: "text",
          code: `client.update.install(client.update.decide())`,
        },
      ];
      if (i.godot)
        snippets.push({
          label: "GDScript",
          language: "text",
          code: `await PolarisKey.update.install(check)`,
        });
      return {
        steps: [
          "Publish the app on Google Play.",
          "Install through the SDK's Play driver: Play offers the update and the SDK reports the outcome.",
        ],
        snippets,
      };
    }
  }
}

/** The Godot updater's key lives in a different place on each platform. */
function godotSetup(i: UpdaterSetupInput, keySteps: string[]): UpdaterSetup {
  if (i.platform === "macos")
    return {
      steps: [
        ...keySteps,
        "Turn on Sparkle in the macOS export preset and set its public key.",
      ],
      snippets: [
        {
          label: "macOS export preset",
          language: "text",
          code: `polaris_key/sparkle/enabled = true\npolaris_key/sparkle/public_ed_key = "YOUR_SPARKLE_PUBLIC_KEY"`,
        },
      ],
    };
  if (i.platform === "windows")
    return {
      steps: [
        ...keySteps,
        "Set the public key in `PKeyOptions`. WinSparkle refuses to start without it.",
      ],
      snippets: [
        {
          label: "GDScript, PKeyOptions",
          language: "text",
          code: `options.update_eddsa_public_key = "YOUR_SPARKLE_PUBLIC_KEY"`,
        },
      ],
    };
  return {
    steps: [
      "No key to set: the update check installs from the signed release record.",
    ],
    snippets: [],
  };
}

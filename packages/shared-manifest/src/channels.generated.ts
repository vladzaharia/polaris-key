// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm gen channels` (tools/gen-channels.ts) from tools/channels.json, the one
// catalogue of distribution channels. `pnpm gen channels --check` fails the green gate on any
// difference. To change a channel, edit the catalogue and regenerate.

/** Every distribution channel id, in catalogue order. */
export type ChannelId =
  | "polaris-key"
  | "app-store"
  | "testflight"
  | "altstore"
  | "altstore-pal"
  | "google-play"
  | "play-testing"
  | "obtainium"
  | "fdroid"
  | "microsoft-store"
  | "app-installer"
  | "winget"
  | "steam"
  | "itch"
  | "flathub"
  | "snap"
  | "homebrew"
  | "scoop"
  | "web";

export type ChannelFamily =
  | "first-party"
  | "apple"
  | "sideload"
  | "google"
  | "microsoft"
  | "package-manager"
  | "pc-store"
  | "linux"
  | "web";
export type ChannelPlane = "worker" | "feed" | "pr" | "ci";
export type ChannelCustomerAction =
  | "install"
  | "open-listing"
  | "add-source"
  | "download"
  | "run-command"
  | "open-in-browser";

export interface ChannelStorefrontFacet {
  /** The storefront adapter id the channel binds to. */
  adapter: string;
  /** The team credential slot that connects it; null when keyless. */
  credential: string | null;
  verification?: string;
  notification?: string;
  sku?: string;
}

export interface ChannelEntry {
  id: ChannelId;
  aliases: readonly string[];
  label: string;
  family: ChannelFamily;
  plane: ChannelPlane;
  /** The wire outlet kind (and, for a package manager, the `direct` subkind). Never a new kind. */
  outlet: { kind: string; subkind?: string };
  platforms: readonly string[];
  formats: readonly string[];
  deliverableKinds: readonly string[];
  customerAction: ChannelCustomerAction;
  verbs: readonly string[];
  auto: readonly string[];
  human: readonly string[];
  storefront: ChannelStorefrontFacet | null;
}

/** The catalogue, in canonical order. */
export const CHANNELS: readonly ChannelEntry[] = [
  {
    id: "polaris-key",
    aliases: ["direct"],
    label: "Polaris Key",
    family: "first-party",
    plane: "worker",
    outlet: { kind: "direct" },
    platforms: ["macos", "windows", "linux", "android", "ios"],
    formats: ["dmg", "zip", "msi", "exe", "appimage", "deb", "apk", "ipa"],
    deliverableKinds: ["app", "pack", "package"],
    customerAction: "install",
    verbs: ["connect", "readListing", "uploadBuild", "release", "status"],
    auto: ["upload-build", "release"],
    human: [],
    storefront: { adapter: "polaris-key", credential: null },
  },
  {
    id: "app-store",
    aliases: ["appstore"],
    label: "App Store",
    family: "apple",
    plane: "worker",
    outlet: { kind: "app-store" },
    platforms: ["ios", "macos"],
    formats: ["ipa", "pkg"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: [
      "connect",
      "listApps",
      "identifiers",
      "createApp",
      "readListing",
      "writeListingText",
      "writeListingAssets",
      "category",
      "contentRating",
      "privacyDeclarations",
      "pricing",
      "iap",
      "uploadBuild",
      "notificationsUrl",
      "submit",
      "release",
      "rollout",
      "status",
    ],
    auto: ["upload-build", "listing", "submit"],
    human: ["agreements", "app-privacy", "review"],
    storefront: {
      adapter: "app-store",
      credential: "app-store.api-key",
      verification: "app-store.in-app-purchase-key",
      notification: "app-store-server",
      sku: "app-store-product",
    },
  },
  {
    id: "testflight",
    aliases: [],
    label: "TestFlight",
    family: "apple",
    plane: "worker",
    outlet: { kind: "testflight" },
    platforms: ["ios", "macos"],
    formats: ["ipa", "pkg"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: ["connect", "uploadBuild", "testers", "status"],
    auto: ["upload-build", "testers"],
    human: ["beta-review"],
    storefront: { adapter: "app-store", credential: "app-store.api-key" },
  },
  {
    id: "altstore",
    aliases: [],
    label: "AltStore",
    family: "sideload",
    plane: "feed",
    outlet: { kind: "altstore" },
    platforms: ["ios"],
    formats: ["ipa"],
    deliverableKinds: ["app"],
    customerAction: "add-source",
    verbs: ["status"],
    auto: ["feed"],
    human: [],
    storefront: null,
  },
  {
    id: "altstore-pal",
    aliases: [],
    label: "AltStore PAL",
    family: "sideload",
    plane: "feed",
    outlet: { kind: "altstore-pal" },
    platforms: ["ios"],
    formats: ["ipa"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: ["status"],
    auto: ["feed"],
    human: ["marketplace-listing"],
    storefront: null,
  },
  {
    id: "google-play",
    aliases: ["play"],
    label: "Google Play",
    family: "google",
    plane: "worker",
    outlet: { kind: "play" },
    platforms: ["android"],
    formats: ["aab", "apk"],
    deliverableKinds: ["app", "pack"],
    customerAction: "open-listing",
    verbs: [
      "connect",
      "listApps",
      "readListing",
      "writeListingText",
      "writeListingAssets",
      "category",
      "contentRating",
      "privacyDeclarations",
      "pricing",
      "iap",
      "uploadBuild",
      "submit",
      "release",
      "rollout",
      "status",
    ],
    auto: ["upload-build", "listing", "release"],
    human: ["first-release", "data-safety", "review"],
    storefront: {
      adapter: "google-play",
      credential: "google-play.service-account",
      verification: "google-play.service-account",
      notification: "play-rtdn",
      sku: "play-product",
    },
  },
  {
    id: "play-testing",
    aliases: ["google-play-testing"],
    label: "Google Play testing",
    family: "google",
    plane: "worker",
    outlet: { kind: "play-testing" },
    platforms: ["android"],
    formats: ["aab", "apk"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: ["connect", "uploadBuild", "testers", "release", "status"],
    auto: ["upload-build", "release"],
    human: ["testers"],
    storefront: {
      adapter: "google-play",
      credential: "google-play.service-account",
    },
  },
  {
    id: "obtainium",
    aliases: [],
    label: "Obtainium",
    family: "sideload",
    plane: "feed",
    outlet: { kind: "obtainium" },
    platforms: ["android"],
    formats: ["apk"],
    deliverableKinds: ["app"],
    customerAction: "add-source",
    verbs: ["status"],
    auto: ["feed"],
    human: [],
    storefront: null,
  },
  {
    id: "fdroid",
    aliases: ["fdroid-repo"],
    label: "F-Droid repository",
    family: "sideload",
    plane: "feed",
    outlet: { kind: "fdroid-repo" },
    platforms: ["android"],
    formats: ["apk"],
    deliverableKinds: ["app"],
    customerAction: "add-source",
    verbs: ["status"],
    auto: ["feed"],
    human: [],
    storefront: null,
  },
  {
    id: "microsoft-store",
    aliases: ["ms-store"],
    label: "Microsoft Store",
    family: "microsoft",
    plane: "worker",
    outlet: { kind: "ms-store" },
    platforms: ["windows"],
    formats: ["msix", "msixbundle", "msi", "exe"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: [
      "connect",
      "listApps",
      "readListing",
      "writeListingText",
      "writeListingAssets",
      "uploadBuild",
      "submit",
      "release",
      "rollout",
      "status",
    ],
    auto: ["upload-build", "listing", "submit"],
    human: ["certification"],
    storefront: {
      adapter: "microsoft-store",
      credential: "microsoft-store.partner-center",
    },
  },
  {
    id: "app-installer",
    aliases: [],
    label: "App Installer",
    family: "microsoft",
    plane: "feed",
    outlet: { kind: "app-installer" },
    platforms: ["windows"],
    formats: ["msix", "msixbundle", "appinstaller"],
    deliverableKinds: ["app"],
    customerAction: "download",
    verbs: ["status"],
    auto: ["feed"],
    human: [],
    storefront: null,
  },
  {
    id: "winget",
    aliases: [],
    label: "winget",
    family: "package-manager",
    plane: "pr",
    outlet: { kind: "winget" },
    platforms: ["windows"],
    formats: ["msi", "exe", "msix"],
    deliverableKinds: ["app"],
    customerAction: "run-command",
    verbs: ["submit", "status"],
    auto: ["manifest-pr"],
    human: ["pr-review"],
    storefront: { adapter: "winget", credential: null },
  },
  {
    id: "steam",
    aliases: ["steamworks"],
    label: "Steam",
    family: "pc-store",
    plane: "worker",
    outlet: { kind: "steam" },
    platforms: ["windows", "macos", "linux"],
    formats: ["depot"],
    deliverableKinds: ["app", "pack"],
    customerAction: "open-listing",
    verbs: [
      "connect",
      "listApps",
      "readListing",
      "pricing",
      "iap",
      "uploadBuild",
      "submit",
      "release",
      "status",
    ],
    auto: ["upload-build", "branch"],
    human: ["store-page-review", "build-review"],
    storefront: {
      adapter: "steam",
      credential: "steam.publisher-key",
      verification: "steam.publisher-key",
      notification: "steam-microtxn",
      sku: "steam-package",
    },
  },
  {
    id: "itch",
    aliases: ["itch.io"],
    label: "itch.io",
    family: "pc-store",
    plane: "ci",
    outlet: { kind: "itch" },
    platforms: ["windows", "macos", "linux"],
    formats: ["zip", "tar.gz"],
    deliverableKinds: ["app"],
    customerAction: "open-listing",
    verbs: ["uploadBuild", "status"],
    auto: ["butler-push"],
    human: ["project-page"],
    storefront: { adapter: "itch", credential: null },
  },
  {
    id: "flathub",
    aliases: [],
    label: "Flathub",
    family: "linux",
    plane: "pr",
    outlet: { kind: "flathub" },
    platforms: ["linux"],
    formats: ["flatpak"],
    deliverableKinds: ["app"],
    customerAction: "run-command",
    verbs: ["submit", "status"],
    auto: ["manifest-pr"],
    human: ["pr-review"],
    storefront: { adapter: "flathub", credential: null },
  },
  {
    id: "snap",
    aliases: ["snap-store"],
    label: "Snap Store",
    family: "linux",
    plane: "ci",
    outlet: { kind: "snap" },
    platforms: ["linux"],
    formats: ["snap"],
    deliverableKinds: ["app"],
    customerAction: "run-command",
    verbs: ["uploadBuild", "release", "status"],
    auto: ["snapcraft-upload", "release"],
    human: ["name-registration"],
    storefront: { adapter: "snap", credential: null },
  },
  {
    id: "homebrew",
    aliases: [],
    label: "Homebrew",
    family: "package-manager",
    plane: "pr",
    outlet: { kind: "direct", subkind: "homebrew" },
    platforms: ["macos", "linux"],
    formats: ["tar.gz", "zip"],
    deliverableKinds: ["app", "package"],
    customerAction: "run-command",
    verbs: ["submit", "status"],
    auto: ["formula-pr"],
    human: ["pr-review"],
    storefront: { adapter: "homebrew", credential: null },
  },
  {
    id: "scoop",
    aliases: [],
    label: "Scoop",
    family: "package-manager",
    plane: "pr",
    outlet: { kind: "direct", subkind: "scoop" },
    platforms: ["windows"],
    formats: ["zip", "exe"],
    deliverableKinds: ["app", "package"],
    customerAction: "run-command",
    verbs: ["submit", "status"],
    auto: ["manifest-pr"],
    human: ["pr-review"],
    storefront: { adapter: "scoop", credential: null },
  },
  {
    id: "web",
    aliases: [],
    label: "Web",
    family: "web",
    plane: "feed",
    outlet: { kind: "web" },
    platforms: ["web"],
    formats: ["html"],
    deliverableKinds: ["app"],
    customerAction: "open-in-browser",
    verbs: ["status"],
    auto: ["feed"],
    human: [],
    storefront: null,
  },
];

/** Every channel id, in catalogue order. */
export const CHANNEL_IDS: readonly ChannelId[] = [
  "polaris-key",
  "app-store",
  "testflight",
  "altstore",
  "altstore-pal",
  "google-play",
  "play-testing",
  "obtainium",
  "fdroid",
  "microsoft-store",
  "app-installer",
  "winget",
  "steam",
  "itch",
  "flathub",
  "snap",
  "homebrew",
  "scoop",
  "web",
];

/** Alternate spellings and wire kinds that name a channel, mapped to its id. */
export const CHANNEL_ALIASES: Readonly<Record<string, ChannelId>> = {
  direct: "polaris-key",
  appstore: "app-store",
  play: "google-play",
  "google-play-testing": "play-testing",
  "fdroid-repo": "fdroid",
  "ms-store": "microsoft-store",
  steamworks: "steam",
  "itch.io": "itch",
  "snap-store": "snap",
};

/** A channel by id or alias, or null. */
export function findChannel(idOrAlias: string): ChannelEntry | null {
  const id = Object.hasOwn(CHANNEL_ALIASES, idOrAlias)
    ? CHANNEL_ALIASES[idOrAlias]
    : idOrAlias;
  return CHANNELS.find((c) => c.id === id) ?? null;
}

/** The label for a channel id or alias; an unknown value comes back unchanged. */
export function channelLabel(idOrAlias: string): string {
  return findChannel(idOrAlias)?.label ?? idOrAlias;
}

/** The channel serving an outlet kind (and subkind, for the `direct` package managers), or null. */
export function channelForOutlet(
  kind: string,
  subkind?: string | null,
): ChannelEntry | null {
  return (
    CHANNELS.find(
      (c) =>
        c.outlet.kind === kind &&
        (c.outlet.subkind ?? null) === (subkind ?? null),
    ) ?? null
  );
}

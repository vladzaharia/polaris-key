// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/kit-copy.ts) from
// packages/brand/kit-copy/ (en.json and the eight locale packs) and the core copy in
// conformance/parity/copy.<locale>.json. `pnpm gen brand --check` fails the green gate on any
// difference. To change a string, edit its source and regenerate.
/**
 * The web kits' copy entry (SP-47): the launch locales, the English variants, the per-locale
 * loaders and a lean English table (`en-lean.json`) without the wire codes' messages and the
 * terminal lines, which load on demand as `en-rest.json`. `./index.js` re-exports everything but
 * the tables and carries the full English table.
 */
import en from "./en-lean.json" with { type: "json" };
import type { KitCopyTable } from "./index.js";

/** The launch locales, English first. */
export const KIT_COPY_LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "ja",
  "ko",
  "zh-Hans",
] as const;
export type KitCopyLocale = (typeof KIT_COPY_LOCALES)[number];

/** English without `core.codes.*` and the terminal's `cli.*`: what a first paint needs. */
export const KIT_COPY_EN_LEAN: Readonly<Record<string, string>> = en;

/** The English keys `KIT_COPY_EN_LEAN` leaves out (load once; merge over the lean table). */
export async function loadKitCopyEnRest(): Promise<
  Readonly<Record<string, string>>
> {
  return (await import("./en-rest.json", { with: { type: "json" } })).default;
}

/** The key prefixes `en-rest.json` holds: a key under one is missing only until the rest loads. */
export const KIT_COPY_LAZY_PREFIXES: readonly string[] = [
  "core.codes.",
  "cli.",
  "common.update",
  "menu.signOut",
  "menu.account",
  "signin.signout.titleMac",
  "signin.signout.releasedMac",
  "signin.approve.",
  "signin.choice.",
  "signin.join.",
  "signin.replace.",
  "signin.linkOffer.",
  "signin.nearby.",
  "core.activation.",
  "signin.consent.",
  "signin.code.",
  "signin.device.",
  "signin.cli.",
  "signin.console.",
  "signin.confirmLink.",
  "signin.mail.",
  "signin.return.",
  "unlockSync.",
  "recoveryCode.",
  "ringChange.",
  "cloudSync.locked",
  "cloudSync.unlock",
  "cloudSync.ringChanged",
  "settings.",
  "devices.",
  "offlineActivation.",
  "updateProgress.",
  "releaseNotes.",
  "channel.",
  "about.",
  "account.",
];

/** English platform variants (D13 title case on macOS and documented verbs); other locales have none. */
export const KIT_COPY_VARIANTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "common.notNow": { macos: "Not Now" },
  "common.tryAgain": { macos: "Try Again" },
  "common.signOut": { macos: "Sign Out" },
  "part.qr.enlarge": { macos: "Show Larger" },
  "part.qr.scanInstead": { macos: "Scan with Your Phone Instead" },
  "boot.continueOffline": { godot: "Play offline", macos: "Continue Offline" },
  "welcome.signIn": { macos: "Sign In" },
  "welcome.useKey": { macos: "Use a License Key" },
  "welcome.trial": { macos: "Start a Free Trial" },
  "welcome.continueFree": { macos: "Continue Free" },
  "welcome.restore": { macos: "Restore Purchase" },
  "welcome.offline": { macos: "Activate Offline" },
  "signInHandoff.newCode": { macos: "Get a New Code" },
  "activate.submit": { macos: "Activate License" },
  "common.activateLicense": { macos: "Activate a License" },
  "offlineActivation.copyCode": { macos: "Copy Code" },
  "offlineActivation.loadFile": { macos: "Load File…" },
  "offlineActivation.submit": { macos: "Activate from File" },
  "deviceLimit.primary": { macos: "Replace and Continue" },
  "deviceLimit.openBrowser": { macos: "Open in Browser" },
  "devices.manage": { macos: "Manage Devices" },
  "update.allChanges": { macos: "All Changes in {version}" },
  "update.later": { macos: "Remind Me Later" },
  "update.restartWhenReady": { macos: "Install and Relaunch" },
  "update.restartNow": { macos: "Install and Relaunch" },
  "update.skipVersion": { macos: "Skip This Version" },
  "update.install": { macos: "Install and Relaunch" },
  "update.steam": { macos: "Get It on Steam" },
  "common.updateInstallUpdate": { macos: "Install Update" },
  "common.updateInstallOnQuit": { macos: "Install on Quit" },
  "common.updateDeclineChecks": { macos: "Don’t Check" },
  "common.updateQuitAndInstall": { macos: "Quit and Install" },
  "common.updatePermissionAllow": { macos: "Check Automatically" },
  "common.updateLearnMore": { macos: "Learn More" },
  "update.checkNow": { macos: "Check for Updates…" },
  "menu.manageLicense": { macos: "Manage License…" },
  "menu.signOut": { macos: "Sign Out…" },
  "signin.signout.confirm": { macos: "Sign Out" },
  "updateProgress.resume": { macos: "Download Now" },
  "status.useAnotherLicense": { macos: "Use Another License" },
  "status.switchChannel": { macos: "Switch Channel" },
  "settings.reset": { macos: "Reset to Default" },
  "settings.advanced": { macos: "Show Advanced Settings" },
  "paywall.redeem": { macos: "Redeem a Code" },
  "paywall.restore": { macos: "Restore Purchases" },
  "paywall.portal": { macos: "Buy in Your Browser" },
  "cloudSync.signIn": { macos: "Sign In to Sync" },
  "cloudSync.unlock": { macos: "Unlock Sync" },
  "unlockSync.startOver": { macos: "Start Over" },
  "unlockSync.startOverConfirm": { macos: "Start Over" },
  "recoveryCode.copy": { macos: "Copy Code" },
  "ringChange.accept": { macos: "That Was Me" },
  "ringChange.useCode": { macos: "Use Recovery Code" },
  "about.support": { macos: "Get Help" },
  "about.licenses": { macos: "Open-Source Licenses" },
  "about.copyDiagnostics": { macos: "Copy Diagnostics" },
  "signin.passkey": { macos: "Sign In with a Passkey" },
  "signin.email.continue": { macos: "Continue with Email" },
  "signin.link.key": { macos: "Have a License Key?" },
  "signin.link.anotherDevice": { macos: "Sign In with Another Device" },
  "signin.link.deviceCode": { macos: "Sign In on Your Phone or Computer" },
  "signin.retry": { macos: "Try Again" },
  "signin.code.resend": { macos: "Send a New Code" },
  "signin.code.resendIn": { macos: "Send a New Code in {time}" },
  "signin.code.differentEmail": { macos: "Use a Different Email" },
  "signin.hint.other": { macos: "Other Ways to Sign In" },
  "signin.register.submit": { macos: "Create Account and Continue" },
  "signin.gate.verify": { macos: "Verify and Continue" },
  "signin.gate.sendCode": { macos: "Send Code" },
  "signin.gate.cancel": { macos: "Cancel Sign-In" },
  "signin.gate.join": { macos: "Join into One Account" },
  "signin.profile.applePicture": {
    macos: "Apple Doesn't Share a Picture. Add One",
  },
  "signin.choice.keep": { macos: "Keep the License This Device Uses" },
  "signin.choice.create": { macos: "Create a New Free License" },
  "signin.choice.keyInstead": { macos: "Use a License Key Instead" },
  "signin.choice.freeDevice": { macos: "Free a Device" },
  "signin.choice.continue": { macos: "Use This License" },
  "signin.none.otherAccount": { macos: "Use Another Account" },
  "signin.deviceLimit.replace": { macos: "Replace a Device" },
  "signin.replace.open": { macos: "Replace a Device" },
  "signin.replace.confirm": { macos: "Replace and Continue" },
  "signin.notYou": { macos: "Not You?" },
  "signin.key.addAndUse": { macos: "Add and Use on This Device" },
  "signin.key.keep": { macos: "Keep {product} in an Account" },
  "signin.key.skip": { macos: "Skip for Now" },
  "signin.key.ownedSignIn": { macos: "Sign In to That Account" },
  "signin.key.signIn": { macos: "Sign In" },
  "signin.key.differentKey": { macos: "Use a Different Key" },
  "signin.auto.confirm.other": { macos: "Use Another Account" },
  "signin.linkOffer.decline": { macos: "No Thanks" },
  "signin.linkOffer.join": { macos: "Join Accounts" },
  "signin.nearby.code": { macos: "Use a Code Instead" },
  "signin.nearby.notYou": { macos: "Not You?" },
  "signin.nearby.menu": { macos: "Approve a Nearby Device" },
  "signin.key.addInLocker": { macos: "Add It in Polaris Locker" },
  "signin.return.stay": { macos: "Stay Here" },
  "signin.done.start": { macos: "Start Using {product}" },
  "signin.device.signOut": { macos: "Sign the TV Out" },
  "signin.handoff.again": { macos: "Open Browser Again" },
  "signin.desktop.continue": { macos: "Continue in Browser" },
  "signin.menu.signIn": { macos: "Sign In…" },
  "signin.handoff.useCode": { macos: "Use a Code Instead" },
  "signin.handoff.useBrowser": { macos: "Use Browser Sign-In" },
  "signin.handoff.copyLink": { macos: "Copy Link" },
  "signin.handoff.openBrowser": { macos: "Open Browser" },
  "signin.return.library": { macos: "Open Your Library" },
  "signin.approve.approve": { macos: "Approve and Sign It In" },
  "signin.again": { macos: "Sign In Again" },
  "signin.signout.waitSync": { macos: "Wait for Sync" },
  "signin.provider.manage": {
    macos: "Manage Sign-In Methods in Polaris Locker",
  },
  "signin.profile.changePicture": { macos: "Change Picture" },
  "signin.approve.other": { macos: "Use Another Way to Sign In" },
  "signin.approve.open": { macos: "Approve a New Device" },
  "signin.approve.look": { macos: "Find It" },
  "signin.gate.pictureInitials": { macos: "Use My Initials" },
  "signin.gate.pictureProvider": { macos: "Use My {provider} Picture" },
  "signin.hint.usePasskey": { macos: "Use a Passkey" },
  "signin.hint.emailCode": { macos: "Email Me a Code" },
  "signin.key.withoutKey": { macos: "Sign In Without the Key" },
  "signin.sso.codeIn": { macos: "Email Me a Code in {time}" },
  "signin.sso.code": { macos: "Email Me a Code Instead" },
  "signin.choice.replaceAndSignIn": { macos: "Replace and Sign In" },
  "signin.consent.deny": { macos: "Don't Allow" },
  "signin.key.createAccount": { macos: "Create Account" },
  "signin.key.signInInstead": { macos: "Sign In Instead" },
  "signin.gate.passkeyAdd": { macos: "Add a Passkey" },
  "signin.nudge.add": { macos: "Add a Way" },
  "signin.nudge.later": { macos: "Not Now" },
  "signin.join.start": { macos: "Sign In to the Other Account" },
  "signin.join.undo": { macos: "Undo Join" },
  "signin.join.again": { macos: "Sign In to {email} Again" },
  "signin.join.startAgain": { macos: "Start Again" },
  "signin.join.methodsLink": { macos: "Sign-In Methods" },
};

/** Locales whose core.* strings are English until their core pack lands. */
export const KIT_COPY_CORE_FALLBACK: readonly string[] = [];

/** Load one locale's table (code-split per locale). */
export async function loadKitCopy(
  locale: KitCopyLocale,
): Promise<KitCopyTable> {
  switch (locale) {
    case "en":
      return (await import("./en.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "de":
      return (await import("./de.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "fr":
      return (await import("./fr.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "es":
      return (await import("./es.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "pt-BR":
      return (await import("./pt-BR.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "it":
      return (await import("./it.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "ja":
      return (await import("./ja.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "ko":
      return (await import("./ko.json", { with: { type: "json" } }))
        .default as KitCopyTable;
    case "zh-Hans":
      return (await import("./zh-Hans.json", { with: { type: "json" } }))
        .default as KitCopyTable;
  }
}

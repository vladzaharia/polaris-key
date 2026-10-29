// Where each component's copy keys go (layer b's DOM contract, shared with React through
// `data-part`). A view names the keys its state shows (ui-core); this table says which of them are
// controls, which are tertiary links at the foot, and the form the component takes. Everything
// else in a view is text: titles by their key (`*.title`, `*.heading`, `*Title`), the rest body.
// test/matrix.test.ts holds the table to the catalog's roles (every `button` key a control, every
// `title` key a heading) for every row of ui-matrix.json.

import type {
  ComponentName,
  HolderScreenName,
  ScreenName,
  SyncScreenName,
} from "@polaris-key/ui-core";

import { SYNC_LAYOUTS } from "./syncLayouts.js";

export { SYNC_LAYOUTS };

export type Kind =
  /** A blocking step that owns its box: the card on the product ambient (DL2). */
  | "screen"
  /** An embedded pane: start edge, at most 40rem (DL2). */
  | "pane"
  /** A strip over the app (grace). */
  | "banner"
  | "toast"
  /** A small status inside the host's layout. */
  | "inline";

export interface Layout {
  kind: Kind;
  /** The product header's size on this component (DL5); `none` for panes that sit in settings. */
  header: "hero" | "compact" | "medium" | "none";
  /** Keys drawn as filled or tonal buttons, in this order (the view's `primary` is filled). */
  controls: readonly string[];
  /** Tertiary actions: text links at the foot (DL4). */
  links?: readonly string[];
  /** Keys that read as a title though their name does not say so. */
  titles?: readonly string[];
  /** Title keys drawn as the subhead under the h1 (an h2 at body size): a fact that heads the
   *  content, not a second title. */
  subtitles?: readonly string[];
  /** Links that stay quiet even as the view's primary (the filled control is drawn in the
   *  content instead: the Replace step's inline confirm). */
  quiet?: readonly string[];
  /** Short status lines in muted meta type. */
  meta?: readonly string[];
  /** The footnote at the foot of the card. */
  footnote?: readonly string[];
  /** Two panes in a landscape box (DL1). */
  split?: boolean;
  /** Text keys in reading order, ahead of the rest. */
  order?: readonly string[];
  /** Keys this layout draws inside its own content (rows, fields, codes): not repeated as text. */
  content?: readonly string[];
}

const ERRORS = ["common.tryAgain"];

/** Every component but the Cloud Sync screens. The React kit imports this table alone, so its
 *  gate's entry never carries the sync screens' layouts (they load with the screens). */
export const KIT_LAYOUTS: Readonly<
  Record<Exclude<ComponentName, SyncScreenName>, Layout>
> = {
  PolarisKeyGate: {
    kind: "screen",
    header: "hero",
    controls: ["common.tryAgain", "common.reconnect"],
    meta: ["gate.checking", "part.status.blocked"],
  },
  Boot: {
    kind: "screen",
    header: "hero",
    controls: [
      "boot.consent.download",
      "boot.continueOffline",
      "status.update",
      "common.tryAgain",
      "common.notNow",
    ],
    meta: [
      "boot.starting",
      "boot.syncing",
      "gate.checking",
      "boot.deciding",
      "common.loading",
      "boot.ready",
      "boot.fetching",
      "boot.fetchingProgress",
    ],
  },
  Welcome: {
    kind: "screen",
    header: "hero",
    split: true,
    controls: ["welcome.signIn", "welcome.useKey"],
    links: [
      "welcome.trial",
      "welcome.continueFree",
      "welcome.restore",
      "welcome.offline",
    ],
    meta: ["common.working"],
    order: ["welcome.lede", "welcome.ledeKeyOnly", "welcome.ledeSignInOnly"],
  },
  SignIn: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: [
      "signin.provider.continue",
      "signin.passkey",
      "signin.email.continue",
      "signin.desktop.continue",
      "signin.handoff.again",
      "signin.code.resend",
      "signin.replace.open",
      "signin.replace.openSystem",
      "signin.done.start",
      "signin.again",
      // Automatic sign-in's steps (I-46.1) and the key refusal's focused step.
      "signin.auto.confirm.primary",
      "signin.linkOffer.primary",
      "signin.key.ownedSignIn",
      "signin.key.signIn",
      "signin.key.addInLocker",
      "common.continue",
      // The key step's submit (the key field is the SignIn form's content).
      "activate.submit",
      "common.cancel",
    ],
    links: [
      "signin.link.deviceCode",
      "signin.handoff.useCode",
      "signin.choice.keyInstead",
      "signin.menu.signIn",
      "signin.auto.confirm.other",
      "signin.linkOffer.decline",
      "signin.nearby.code",
      "signin.nearby.notYou",
      "signin.linkOffer.join",
      "signin.key.differentKey",
      "common.notNow",
    ],
    titles: [
      "signin.return.signedInShort",
      "signin.return.signedInTier",
      "signin.linkOffer.done",
      "signin.nearby.done",
    ],
    meta: ["signin.provider.group", "signin.code.label"],
    // The confirm step reads as the model writes it: who, the license this device gets, then what
    // the app also receives (the keys sort by name otherwise, and "will also get" led).
    order: [
      "signin.auto.confirm.as",
      "signin.auto.confirm.asApple",
      "signin.consent.license",
      "signin.consent.newLicense",
      "signin.consent.licenseLine",
      "signin.consent.alsoGets",
      "signin.consent.profile",
      "signin.consent.pairwise",
    ],
    content: ["part.keyField.label", "signin.key.scan"],
    // The sign-in form's Replace step confirms inline (D-80): its Replace… opener is quiet.
    quiet: ["signin.replace.open", "signin.replace.openSystem"],
  },
  SignInHandoff: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: [
      "signin.handoff.openBrowser",
      "signin.handoff.again",
      "signInHandoff.newCode",
      "signin.handoff.copyLink",
      "common.cancel",
    ],
    links: ["signin.handoff.useCode", "part.qr.scanInstead", "part.qr.enlarge"],
    titles: ["signInHandoff.ok", "signin.handoff.noBrowser"],
    meta: [
      "signInHandoff.starting",
      "signInHandoff.linkCopied",
      "cli.signin.waitingCode",
      "signin.handoff.check",
      "signin.handoff.expires",
    ],
    content: ["part.code.label", "signin.handoff.url"],
  },
  NearbyApproval: {
    kind: "screen",
    header: "compact",
    controls: [
      "signin.approve.deny",
      "common.done",
      "devices.manage",
      "signin.choice.continue",
      "signin.key.signIn",
      "common.tryAgain",
    ],
    links: ["signin.nearby.menu"],
    // The ask: the instruction, then the warning (the codes sit between them).
    order: ["signin.nearby.askBody", "signin.approve.warning"],
    titles: [
      "signin.nearby.ask",
      "signin.nearby.approved",
      "signin.nearby.notNearby",
      "signin.nearby.mismatch",
      "signin.approve.deniedDone",
    ],
  },
  Activate: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: [
      "activate.submit",
      "common.back",
      "common.done",
      "signin.key.ownedSignIn",
      "signin.key.signIn",
      "signin.key.addInLocker",
    ],
    links: ["signin.key.differentKey"],
    meta: ["activate.busy"],
    content: [
      "signin.key.scan",
      "part.keyField.label",
      "part.keyField.placeholder",
      "part.keyField.forProduct",
      "part.keyField.verdict",
      "part.keyField.cutShort",
      "part.keyField.malformed",
      "part.keyField.empty",
      "common.paste",
      "part.seatMeter.caption",
    ],
  },
  OfflineActivation: {
    kind: "screen",
    header: "compact",
    controls: [
      "offlineActivation.submit",
      "offlineActivation.copyCode",
      "offlineActivation.loadFile",
    ],
    meta: ["offlineActivation.codeCopied"],
    content: ["offlineActivation.paste", "offlineActivation.dropHint"],
  },
  DeviceLimit: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: [
      "deviceLimit.primary",
      "deviceLimit.openBrowser",
      "common.tryAgain",
      "common.back",
    ],
    meta: ["common.working"],
    // The component is titled Replace a device in every kit (owner, 2026-10-05); the count
    // heads the content under it, then the lede (UI-KITS.md §4.3 DeviceLimit).
    order: ["deviceLimit.title", "deviceLimit.heading", "deviceLimit.lede"],
    subtitles: ["deviceLimit.heading"],
    content: [
      "part.seatMeter.caption",
      "signin.replace.meta",
      "signin.replace.leastRecent",
      "deviceLimit.confirmTitle",
      "deviceLimit.consequence",
    ],
  },
  LicenseChoice: {
    kind: "screen",
    header: "compact",
    controls: [
      "signin.choice.continue",
      "signin.replace.confirm",
      "signin.none.get",
      "signin.again",
      "signin.choice.keep",
      "signin.choice.create",
      "signin.replace.back",
      "signin.none.otherAccount",
      "common.cancel",
    ],
    // Replace a device names the step it opens; in the Replace step itself it is a quiet link.
    // The elements confirm inline everywhere (D-80: the web has no system confirm), so macOS's
    // Replace… is quiet too.
    links: [
      "signin.replace.open",
      "signin.replace.openSystem",
      "signin.choice.keyInstead",
      "signin.auto.confirm.other",
    ],
    quiet: ["signin.replace.open", "signin.replace.openSystem"],
    titles: ["deviceLimit.title"],
    meta: ["common.loading"],
    content: [
      "signin.choice.group",
      "signin.choice.meta",
      "signin.choice.devices",
      "signin.choice.origin.signIn",
      "signin.choice.origin.key",
      "signin.choice.origin.keyAdded",
      "signin.choice.origin.storeKey",
      "signin.choice.origin.storeKeyAdded",
      "signin.choice.origin.store",
      "signin.choice.origin.developer",
      "signin.choice.origin.free",
      "signin.choice.origin.gift",
      "signin.choice.origin.org",
      "signin.term.lifetime",
      "signin.term.until",
      "signin.term.yearlyUntil",
      "signin.choice.tag.current",
      "signin.choice.tag.new",
      "signin.choice.tag.full",
      "signin.choice.metaNew",
      "signin.choice.keepMeta",
      "signin.choice.createMeta",
      "signin.replace.title",
      "signin.replace.consequence",
    ],
  },
  Devices: {
    kind: "pane",
    header: "none",
    controls: ["devices.manage", "common.tryAgain"],
    meta: ["common.loading", "devices.count"],
    content: [
      "part.thisDeviceTitle",
      "devices.unnamed",
      "devices.meta",
      "devices.rename",
      "devices.remove",
      "devices.renameLabel",
      "devices.removeConfirm",
      "common.save",
      "common.cancel",
    ],
  },
  UpdatePrompt: {
    kind: "screen",
    header: "medium",
    controls: [
      "update.install",
      "update.restartWhenReady",
      "update.restartNow",
      "update.appStore",
      "update.googlePlay",
      "update.steam",
      "update.openStore",
      "update.testflight",
      "update.altstore",
      "update.reload",
      "update.later",
    ],
    links: ["update.allChanges", "update.skipVersion", "update.checkNow"],
    titles: ["update.whatsNew"],
    meta: ["update.downloading", "update.timeLeft", "update.current"],
  },
  UpdateProgress: {
    kind: "inline",
    header: "none",
    controls: ["updateProgress.resume", ...ERRORS],
    meta: [
      "updateProgress.queued",
      "updateProgress.downloading",
      "updateProgress.installing",
      "updateProgress.paused",
      "updateProgress.failed",
      "updateProgress.done",
      "update.verifying",
    ],
  },
  ReleaseNotes: {
    kind: "pane",
    header: "none",
    controls: ERRORS,
    meta: ["common.loading"],
    content: ["releaseNotes.version", "releaseNotes.released"],
  },
  StatusScreen: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: [
      "status.renew",
      "status.update",
      "status.switchChannel",
      "signin.key.differentKey",
      "status.useAnotherLicense",
      "common.signOut",
    ],
    links: ["status.contact"],
    meta: ["status.allowedRange", "status.allowedMin", "status.allowedMax"],
  },
  GraceBanner: {
    kind: "banner",
    header: "none",
    controls: ["common.reconnect", "common.dismiss"],
    meta: ["grace.deadline"],
  },
  AccountAndLicense: {
    kind: "pane",
    header: "medium",
    controls: ["common.manage", "common.signOut"],
    links: ["update.checkNow"],
    meta: ["common.loading", "part.poweredBy", "part.status.grace"],
    content: [
      "account.tier",
      // A floating license: the row and its Add action (UK-42).
      "account.notInAccount",
      "activate.recommend.action",
      "account.devices",
      "account.cloudSync",
      "account.updates",
      "account.autoUpdate",
      "account.channel",
      "account.version",
      "account.managedSettings",
    ],
  },
  Settings: {
    kind: "pane",
    header: "none",
    controls: ["common.save", "common.tryAgain"],
    links: ["settings.reset", "settings.advanced"],
    titles: ["settings.title"],
    meta: [
      "common.loading",
      "settings.unsaved",
      "settings.saving",
      "settings.saved",
    ],
    content: [
      "settings.fromDeveloper",
      "settings.source.local",
      "settings.source.env",
      "settings.source.default",
      "settings.on",
      "settings.off",
      "settings.setBy",
      "settings.setByGuardian",
      "settings.search",
      "settings.range",
    ],
  },
  Paywall: {
    kind: "screen",
    header: "compact",
    controls: ["paywall.upgrade", "paywall.portal", "common.done"],
    links: ["paywall.restore", "paywall.redeem"],
    titles: ["paywall.purchased"],
    meta: ["common.loading", "paywall.includes", "paywall.purchasing"],
  },
  EntitlementGate: {
    kind: "inline",
    header: "none",
    controls: ["entitlement.unlock"],
    meta: ["common.loading"],
  },
  CloudSyncStatus: {
    kind: "inline",
    header: "none",
    controls: ["cloudSync.signIn", "cloudSync.unlock", "common.review"],
    meta: ["cloudSync.synced", "cloudSync.syncing", "cloudSync.offline"],
  },
  About: {
    kind: "pane",
    header: "medium",
    controls: ["about.copyDiagnostics"],
    links: ["about.licenses"],
    titles: ["about.title"],
    meta: ["about.version", "about.diagnosticsCopied", "part.poweredBy"],
  },
  ChannelPicker: {
    kind: "pane",
    header: "none",
    controls: [],
  },
  Toast: {
    kind: "toast",
    header: "none",
    controls: ["toast.undo", "common.dismiss"],
    meta: ["common.copied"],
    order: ["updateProgress.downloading"],
  },
};

/**
 * The two screens activation without an account adds (UK-42.7). Each draws its own card and fields
 * in `content`; the one filled control is Start using, Continue or the step's own. The reasons
 * and the recommendation card are content: a quiet card, never a second primary (DL4).
 */
export const HOLDER_LAYOUTS: Readonly<Record<HolderScreenName, Layout>> = {
  ActivateDone: {
    kind: "screen",
    header: "compact",
    controls: ["signin.done.start", "activate.waitingSignIn"],
    titles: ["activate.done.title"],
    content: [
      "activate.recommend.title",
      "activate.recommend.badge",
      "activate.recommend.sync",
      "activate.recommend.recover",
      "activate.recommend.devices",
      "activate.recommend.portal",
      "activate.recommend.action",
      "activate.recommend.skip",
    ],
  },
  AddToAccount: {
    kind: "screen",
    header: "compact",
    controls: [
      "common.continue",
      "common.tryAgain",
      "signin.key.ownedSignIn",
      "activate.otherEmail.verify",
      "signin.done.start",
    ],
    links: ["common.cancel", "signin.auto.confirm.other"],
    // The form's heading is the action it came from ("Add your name and email").
    titles: ["activate.recommend.action", "activate.attach.done"],
    meta: ["common.working"],
    content: [
      "signin.gate.name",
      "signin.email.label",
      "signin.gate.nameRequired",
      "signin.email.invalid",
      "activate.attach.fine",
      "activate.attach.lede",
    ],
  },
};

/** Every component's layout. */
export const LAYOUTS: Readonly<Record<ScreenName, Layout>> =
  /* @__PURE__ */ Object.assign({}, KIT_LAYOUTS, SYNC_LAYOUTS, HOLDER_LAYOUTS);

/** A key that titles its screen or section. */
export function isTitleKey(key: string, layout: Layout): boolean {
  if (layout.titles?.includes(key)) return true;
  if (key.startsWith("core.") && key.endsWith(".title")) return true;
  return /(\.title|\.heading|Title)$/.test(key);
}

/** The custom element name of each component (UI-KITS.md §4.1: web components prefix `pk-`). */
export const TAGS: Readonly<Record<ScreenName, string>> = {
  PolarisKeyGate: "pk-gate",
  Boot: "pk-boot",
  Welcome: "pk-welcome",
  SignIn: "pk-sign-in",
  SignInHandoff: "pk-sign-in-handoff",
  NearbyApproval: "pk-nearby-approval",
  Activate: "pk-activate",
  OfflineActivation: "pk-offline-activation",
  DeviceLimit: "pk-device-limit",
  LicenseChoice: "pk-license-choice",
  Devices: "pk-devices",
  UpdatePrompt: "pk-update-prompt",
  UpdateProgress: "pk-update-progress",
  ReleaseNotes: "pk-release-notes",
  StatusScreen: "pk-status-screen",
  GraceBanner: "pk-grace-banner",
  AccountAndLicense: "pk-account-and-license",
  Settings: "pk-settings",
  Paywall: "pk-paywall",
  EntitlementGate: "pk-entitlement-gate",
  CloudSyncStatus: "pk-cloud-sync-status",
  About: "pk-about",
  ChannelPicker: "pk-channel-picker",
  Toast: "pk-toast",
  UnlockSync: "pk-unlock-sync",
  RecoveryCode: "pk-recovery-code",
  RingChange: "pk-ring-change",
  ActivateDone: "pk-activate-done",
  AddToAccount: "pk-add-to-account",
};

// ── Dialog controls (UK-06.6) ────────────────────────────────────────────────────────────────

/**
 * The controls of a view drawn in a modal dialog under the Windows chrome, split the way a
 * ContentDialog divides them: the footer holds the dialog's commands, and the choices the person
 * makes inside it stay in the body. The sign-in form's first step offers its methods as choices
 * with Cancel as the only command; every other view's controls are all commands.
 */
export function dialogControls(
  controls: readonly string[],
  view: { component: string; state: string },
): { choices: string[]; footer: string[] } {
  if (
    view.component === "SignIn" &&
    (view.state === "methods" || view.state === "error") &&
    controls.includes("common.cancel") &&
    controls.length > 1
  )
    return {
      choices: controls.filter((k) => k !== "common.cancel"),
      footer: ["common.cancel"],
    };
  return { choices: [], footer: [...controls] };
}

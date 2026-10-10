// Where each component's copy keys go (layer b's DOM contract, shared with React through
// `data-part`). A view names the keys its state shows (ui-core); this table says which of them are
// controls, which are tertiary links at the foot, and the form the component takes. Everything
// else in a view is text: titles by their key (`*.title`, `*.heading`, `*Title`), the rest body.
// test/matrix.test.ts holds the table to the catalog's roles (every `button` key a control, every
// `title` key a heading) for every row of ui-matrix.json.

import type { ComponentName } from "@polaris-key/ui-core";

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

export const LAYOUTS: Readonly<Record<ComponentName, Layout>> = {
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
      "common.cancel",
    ],
    links: [
      "signin.link.deviceCode",
      "signin.handoff.useCode",
      "signin.choice.keyInstead",
      "signin.menu.signIn",
    ],
    titles: ["signin.return.signedInShort"],
    meta: ["signin.provider.group", "signin.code.label"],
    content: ["part.keyField.label"],
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
    titles: ["signInHandoff.ok"],
    meta: [
      "signInHandoff.starting",
      "signInHandoff.linkCopied",
      "signin.handoff.check",
      "signin.handoff.expires",
    ],
    content: ["part.code.label", "signin.handoff.url"],
  },
  Activate: {
    kind: "screen",
    header: "compact",
    split: true,
    controls: ["activate.submit"],
    meta: ["activate.busy"],
    content: [
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
    meta: ["offlineActivation.product", "offlineActivation.codeCopied"],
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
    order: ["deviceLimit.heading", "deviceLimit.lede"],
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
      "signin.replace.open",
      "signin.replace.back",
      "signin.none.otherAccount",
    ],
    links: ["signin.choice.keyInstead"],
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
    controls: ["cloudSync.signIn"],
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

/** A key that titles its screen or section. */
export function isTitleKey(key: string, layout: Layout): boolean {
  if (layout.titles?.includes(key)) return true;
  if (key.startsWith("core.") && key.endsWith(".title")) return true;
  return /(\.title|\.heading|Title)$/.test(key);
}

/** The custom element name of each component (UI-KITS.md §4.1: web components prefix `pk-`). */
export const TAGS: Readonly<Record<ComponentName, string>> = {
  PolarisKeyGate: "pk-gate",
  Boot: "pk-boot",
  Welcome: "pk-welcome",
  SignIn: "pk-sign-in",
  SignInHandoff: "pk-sign-in-handoff",
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
};

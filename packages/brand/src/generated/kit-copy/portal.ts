// GENERATED FILE — do not edit by hand.
//
// Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/kit-copy.ts) from
// packages/brand/kit-copy/ (en.json and the eight locale packs) and the core copy in
// conformance/parity/copy.<locale>.json. `pnpm gen brand --check` fails the green gate on any
// difference. To change a string, edit its source and regenerate.
/**
 * The customer portal's copy (P0-36): the `PORTAL_NAMESPACES` of the kit copy catalog, one flat
 * table per launch locale. Only the portal reads it; the SDK kits import `./index.js` and never
 * carry these strings.
 */
import en from "./portal-en.json" with { type: "json" };
import type { KitCopyLocale } from "./index.js";

/** Every key the portal table holds. */
export type PortalCopyKey =
  | "profile.title"
  | "profile.subtitle"
  | "profile.edit"
  | "profile.editShort"
  | "profile.addPicture"
  | "profile.preview"
  | "profile.name.label"
  | "profile.name.yourChoice"
  | "profile.name.useFrom"
  | "profile.name.required"
  | "profile.picture.label"
  | "profile.picture.inUse"
  | "profile.picture.initials"
  | "profile.picture.initialsNote"
  | "profile.picture.upload"
  | "profile.picture.uploadNote"
  | "profile.picture.uploading"
  | "profile.picture.uploaded"
  | "profile.picture.yourUpload"
  | "profile.picture.yourUploadNote"
  | "profile.picture.current"
  | "profile.picture.currentNote"
  | "profile.birthdate.label"
  | "profile.birthdate.optional"
  | "profile.birthdate.hint"
  | "profile.birthdate.remove"
  | "profile.note"
  | "profile.save"
  | "profile.saved"
  | "profile.loadError"
  | "profile.removedMethod"
  | "profile.error.invalidName"
  | "profile.error.invalidBirthdate"
  | "profile.error.unknownSource"
  | "profile.error.noName"
  | "profile.error.noPicture"
  | "profile.error.unknownUpload"
  | "profile.error.tooLarge"
  | "profile.error.unsupportedType"
  | "profile.error.unreadableImage"
  | "profile.error.uploadLimit"
  | "profile.error.uploadUnavailable"
  | "profile.name.typedHint"
  | "profile.name.typedHintAny"
  | "profile.name.pickedHint"
  | "profile.name.followsHint"
  | "profile.source.nameTyped"
  | "profile.source.nameFrom"
  | "profile.source.pictureFrom"
  | "profile.source.pictureUploaded"
  | "profile.source.pictureInitials"
  | "profile.source.appleNoPicture"
  | "profile.source.noPicture"
  | "profile.picture.earlierNote"
  | "profile.name.chip"
  | "profile.birthdate.line"
  | "yourData.account.copy.title"
  | "yourData.account.copy.body"
  | "yourData.account.copy.button"
  | "yourData.copy.private"
  | "yourData.copy.started"
  | "yourData.product.copy.title"
  | "yourData.product.remove.title"
  | "yourData.product.remove.body"
  | "yourData.product.support.title"
  | "yourData.product.support.body"
  | "yourData.remove.keep"
  | "license.title"
  | "license.term.ended"
  | "license.timeline.alt"
  | "license.timeline.today"
  | "license.fact.versions"
  | "license.fact.source"
  | "license.fact.offline"
  | "license.fact.tracks"
  | "license.fact.included"
  | "license.offline"
  | "license.key.last4"
  | "license.key.fingerprint"
  | "license.expired"
  | "license.renew"
  | "license.suspended"
  | "license.switcher"
  | "getIt.alsoYoursOn"
  | "getIt.otherWays"
  | "getIt.newTab"
  | "getIt.sourceUrl"
  | "getIt.repositoryUrl"
  | "getIt.fingerprint"
  | "getIt.noFingerprint"
  | "getIt.obtainiumWeb"
  | "getIt.otherFiles"
  | "getIt.flow.sourcesBelow"
  | "getIt.flow.desktopBuilds"
  | "getIt.flow.emailMe"
  | "getIt.flow.otherBuilds"
  | "getIt.flow.channel"
  | "getIt.flow.sha256"
  | "getIt.flow.fullSha256"
  | "getIt.flow.copySha256"
  | "getIt.flow.hint.pkg"
  | "getIt.flow.hint.installer"
  | "getIt.flow.hint.appimage"
  | "getIt.flow.hint.package"
  | "getIt.flow.hint.apk"
  | "getIt.flow.hint.flatpak"
  | "getIt.flow.hint.dmg"
  | "getIt.flow.hint.zip"
  | "getIt.version"
  | "getIt.openOnComputer"
  | "getIt.installOn.ipad"
  | "getIt.installOn.iphone"
  | "getIt.installOn.android"
  | "getIt.installOn.device"
  | "getIt.copy.command"
  | "getIt.copy.source"
  | "getIt.copy.repository"
  | "getIt.copy.fingerprint"
  | "getIt.scan.apple"
  | "getIt.scan.android"
  | "getIt.scan.phone"
  | "getIt.qrAlt"
  | "getIt.otherWaysOn"
  | "getIt.downloadFor"
  | "getIt.downloadName"
  | "getIt.flow.emailName"
  | "getIt.flow.emailSent"
  | "getIt.lastCovered"
  | "getIt.heading"
  | "getIt.latest"
  | "getIt.table"
  | "getIt.col.platform"
  | "getIt.col.action"
  | "getIt.forYour"
  | "getIt.notCovered"
  | "getIt.fresh"
  | "getIt.downloading"
  | "getIt.downloadFailed"
  | "getIt.downloadAria"
  | "license.developerFallback"
  | "license.developerFallbackCap"
  | "getIt.device.macos"
  | "getIt.device.windows"
  | "getIt.device.linux"
  | "getIt.device.ios"
  | "getIt.device.android"
  | "getIt.device.web"
  | "locker.account.title"
  | "locker.account.sections"
  | "locker.account.onThisPage"
  | "locker.account.packages"
  | "locker.account.sessions"
  | "locker.appearance.title"
  | "locker.appearance.theme"
  | "locker.appearance.motion"
  | "locker.appearance.matchDevice"
  | "locker.appearance.dark"
  | "locker.appearance.light"
  | "locker.appearance.matchNote"
  | "locker.appearance.reduced"
  | "locker.appearance.reducedNote"
  | "locker.delete.canceled"
  | "locker.delete.scheduledTitle"
  | "locker.delete.banner"
  | "locker.delete.scheduledNote"
  | "locker.delete.cancel"
  | "locker.delete.verbCancel"
  | "locker.delete.askTitle"
  | "locker.delete.askErased"
  | "locker.delete.askLicenses"
  | "locker.delete.askEmail"
  | "locker.delete.type"
  | "locker.delete.verbSchedule"
  | "locker.delete.confirm"
  | "locker.delete.rowTitle"
  | "locker.delete.rowNote"
  | "locker.delete.open"
  | "locker.error.fileGone.title"
  | "locker.error.fileGone.body"
  | "locker.error.notHosted.title"
  | "locker.error.notHosted.body"
  | "locker.error.licenseInactive.title"
  | "locker.error.licenseInactive.body"
  | "locker.error.signInAgain"
  | "locker.library.title"
  | "locker.library.heading"
  | "locker.library.signedInAs"
  | "locker.library.everything"
  | "locker.library.more"
  | "locker.library.allProducts"
  | "locker.library.byName"
  | "locker.library.recentFirst"
  | "locker.library.showing"
  | "locker.library.showAll"
  | "locker.library.noMatchQuery"
  | "locker.library.noMatchFilter"
  | "locker.library.quickMac"
  | "locker.library.quickComputer"
  | "locker.library.quick"
  | "locker.library.all"
  | "locker.library.needsYou"
  | "locker.library.search"
  | "locker.library.filter"
  | "locker.library.sort"
  | "locker.library.sortRecent"
  | "locker.library.sortName"
  | "locker.library.view"
  | "locker.library.grid"
  | "locker.library.list"
  | "locker.library.empty.title"
  | "locker.library.empty.discover"
  | "locker.library.table.caption"
  | "locker.library.table.icon"
  | "locker.library.table.product"
  | "locker.library.table.status"
  | "locker.library.table.latest"
  | "locker.library.table.open"
  | "locker.discover.title"
  | "locker.discover.empty.title"
  | "locker.discover.empty.body"
  | "locker.discover.empty.back"
  | "locker.discover.offers"
  | "locker.discover.added"
  | "locker.discover.ended"
  | "locker.discover.addFailed"
  | "locker.account.yourData"
  | "locker.account.menuLabel";

/** One locale's table. */
export type PortalCopyTable = Readonly<Record<PortalCopyKey, string>>;

/** The English table, always bundled: every lookup falls back to it key by key. */
export const PORTAL_COPY_EN: PortalCopyTable = en as PortalCopyTable;

/** Load one locale's table (code-split per locale). */
export async function loadPortalCopy(
  locale: KitCopyLocale,
): Promise<PortalCopyTable> {
  switch (locale) {
    case "en":
      return (await import("./portal-en.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "de":
      return (await import("./portal-de.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "fr":
      return (await import("./portal-fr.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "es":
      return (await import("./portal-es.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "pt-BR":
      return (await import("./portal-pt-BR.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "it":
      return (await import("./portal-it.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "ja":
      return (await import("./portal-ja.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "ko":
      return (await import("./portal-ko.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
    case "zh-Hans":
      return (await import("./portal-zh-Hans.json", { with: { type: "json" } }))
        .default as PortalCopyTable;
  }
}

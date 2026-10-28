/**
 * Account → Profile's copy (PORTAL.md §4.26 Profile, §4.30, §6.2 "Profile"; PX-22).
 *
 * Every string is a `profile.*` key in the kit copy catalog (nine locales); this file reads them
 * through `t()`, and the sentences built from data are the functions below the table. US spelling, sentence case, no
 * jargon (§6.1): a sign-in method, never an "identity link".
 */

import { t } from "../../lib/copy.js";
export const PROFILE_COPY = {
  "profile.title": t("profile.title"),
  "profile.subtitle": t("profile.subtitle"),
  "profile.edit": t("profile.edit"),
  "profile.editShort": t("profile.editShort"),
  "profile.addPicture": t("profile.addPicture"),
  "profile.preview": t("profile.preview"),
  "profile.name.label": t("profile.name.label"),
  "profile.name.yourChoice": t("profile.name.yourChoice"),
  "profile.name.useFrom": t("profile.name.useFrom"),
  "profile.name.required": t("profile.name.required"),
  "profile.picture.label": t("profile.picture.label"),
  "profile.picture.inUse": t("profile.picture.inUse"),
  "profile.picture.initials": t("profile.picture.initials"),
  "profile.picture.initialsNote": t("profile.picture.initialsNote"),
  "profile.picture.upload": t("profile.picture.upload"),
  "profile.picture.uploadNote": t("profile.picture.uploadNote"),
  "profile.picture.uploading": t("profile.picture.uploading"),
  "profile.picture.uploaded": t("profile.picture.uploaded"),
  "profile.picture.yourUpload": t("profile.picture.yourUpload"),
  "profile.picture.yourUploadNote": t("profile.picture.yourUploadNote"),
  "profile.picture.current": t("profile.picture.current"),
  "profile.picture.currentNote": t("profile.picture.currentNote"),
  "profile.birthdate.label": t("profile.birthdate.label"),
  "profile.birthdate.optional": t("profile.birthdate.optional"),
  "profile.birthdate.hint": t("profile.birthdate.hint"),
  "profile.birthdate.remove": t("profile.birthdate.remove"),
  "profile.birthdate.removeShort": t("devices.remove"),
  "profile.note": t("profile.note"),
  "profile.save": t("profile.save"),
  "profile.cancel": t("signin.cancel"),
  "profile.saved": t("profile.saved"),
  "profile.loadError": t("profile.loadError"),
  "profile.retry": t("signin.retry"),
  "profile.removedMethod": t("profile.removedMethod"),
  "profile.error.invalidName": t("profile.error.invalidName"),
  "profile.error.invalidBirthdate": t("profile.error.invalidBirthdate"),
  "profile.error.incompleteBirthdate": t("profile.error.incompleteBirthdate"),
  "profile.error.unknownSource": t("profile.error.unknownSource"),
  "profile.error.noName": t("profile.error.noName"),
  "profile.error.noPicture": t("profile.error.noPicture"),
  "profile.error.unknownUpload": t("profile.error.unknownUpload"),
  "profile.error.tooLarge": t("profile.error.tooLarge"),
  "profile.error.unsupportedType": t("profile.error.unsupportedType"),
  "profile.error.unreadableImage": t("profile.error.unreadableImage"),
  "profile.error.uploadLimit": t("profile.error.uploadLimit"),
  "profile.error.uploadUnavailable": t("profile.error.uploadUnavailable"),
} as const;

/** "Steam", "Steam or Google", "Steam, Google or Game Center". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** `profile.name.typedHint`: "You typed this name, so signing in with Steam or Google won't change it." */
export function nameTypedHint(providers: readonly string[]): string {
  return providers.length
    ? t("profile.name.typedHint", { provider: orList(providers) })
    : t("profile.name.typedHintAny");
}

/** `profile.name.pickedHint`: a method's name, chosen. */
export function namePickedHint(provider: string): string {
  return t("profile.name.pickedHint", { provider });
}

/** `profile.name.followsHint`: an imported name nobody chose. */
export function nameFollowsHint(provider: string): string {
  return t("profile.name.followsHint", { provider });
}

/** `profile.source.*`: one part of the "where it came from" line. */
export const sourceParts = {
  nameTyped: t("profile.source.nameTyped"),
  nameFrom: (from: string) => t("profile.source.nameFrom", { provider: from }),
  pictureFrom: (from: string) =>
    t("profile.source.pictureFrom", { provider: from }),
  pictureUploaded: t("profile.source.pictureUploaded"),
  pictureInitials: t("profile.source.pictureInitials"),
  appleNoPicture: t("profile.source.appleNoPicture"),
  noPicture: t("profile.source.noPicture"),
} as const;

/** `profile.picture.earlierNote`: a picked picture its method has since replaced. */
export function earlierPictureNote(provider: string): string {
  return t("profile.picture.earlierNote", { provider });
}

/** `profile.name.chip`: a name chip's accessible name (its visible text is the name alone). */
export function chipLabel(provider: string, name: string): string {
  return t("profile.name.chip", { provider, name });
}

/** `profile.birthdate.line`: the Profile card's line, with the date as the locale writes it. */
export function bornLine(date: string): string {
  return t("profile.birthdate.line", { date });
}

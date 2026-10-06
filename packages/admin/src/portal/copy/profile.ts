/**
 * Account → Profile's copy (PORTAL.md §4.26 Profile, §4.30, §6.2 "Profile"; PX-22).
 *
 * Marked for the copy catalog (UK-02a): the catalog serves the SDK UI kits today and the portal
 * does not read it yet, so the strings live here under the `profile.*` keys they move to, and the
 * sentences built from data are the functions below the table. US spelling, sentence case, no
 * jargon (§6.1): a sign-in method, never an "identity link".
 */
export const PROFILE_COPY = {
  "profile.title": "Profile",
  "profile.subtitle":
    "How you appear in Polaris Key, and to an app once you agree to share it.",
  "profile.edit": "Edit profile",
  "profile.addPicture": "Add a picture",
  "profile.preview": "Preview",
  "profile.name.label": "Display name",
  "profile.name.yourChoice": "Your choice",
  "profile.name.useFrom": "Use a name from",
  "profile.name.required": "Enter a name.",
  "profile.picture.label": "Picture",
  "profile.picture.inUse": "In use",
  "profile.picture.initials": "Initials",
  "profile.picture.initialsNote": "No picture",
  "profile.picture.upload": "Upload",
  "profile.picture.uploadNote": "PNG or JPEG, up to 5 MB",
  "profile.picture.uploading": "Uploading…",
  "profile.picture.uploaded": "Picture uploaded. Save your profile to use it.",
  "profile.picture.yourUpload": "Your upload",
  "profile.picture.yourUploadNote": "Cropped to a square",
  "profile.picture.current": "Current picture",
  "profile.picture.currentNote": "From a sign-in method you removed",
  "profile.note":
    "Pictures are copied to Polaris Key, so neither this page nor any app loads them from the provider. An imported name or picture follows its provider until you pick one yourself; after that, your choice stays.",
  "profile.save": "Save profile",
  "profile.cancel": "Cancel",
  "profile.saved": "Profile saved",
  "profile.loadError": "Your profile didn't load",
  "profile.retry": "Try again",
  "profile.removedMethod": "a sign-in method you removed",
  "profile.error.invalidName": "Enter a name.",
  "profile.error.unknownSource":
    "That sign-in method isn't on this account anymore. Choose again.",
  "profile.error.noName":
    "That sign-in method didn't share a name. Choose another or type one.",
  "profile.error.noPicture":
    "That sign-in method didn't share a picture. Choose another picture.",
  "profile.error.unknownUpload":
    "That upload has expired. Upload the picture again.",
  "profile.error.tooLarge": "Use a picture of 5 MB or less.",
  "profile.error.unsupportedType": "Use a PNG or JPEG picture.",
  "profile.error.unreadableImage":
    "We couldn't read that picture. Try another PNG or JPEG.",
  "profile.error.uploadLimit":
    "You can upload 10 pictures an hour. Try again later.",
  "profile.error.uploadUnavailable":
    "Picture uploads aren't available right now. Try again later.",
} as const;

export type ProfileCopyKey = keyof typeof PROFILE_COPY;

/** "Steam", "Steam or Google", "Steam, Google or Game Center". */
export function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** `profile.name.typed`: "You typed this name, so signing in with Steam or Google won't change it." */
export function nameTypedHint(providers: readonly string[]): string {
  return providers.length
    ? `You typed this name, so signing in with ${orList(providers)} won't change it.`
    : "You typed this name, so signing in won't change it.";
}

/** `profile.name.picked`: a method's name, chosen. */
export function namePickedHint(provider: string): string {
  return `You picked the name from ${provider}, so signing in won't change it.`;
}

/** `profile.name.follows`: an imported name nobody chose. */
export function nameFollowsHint(provider: string): string {
  return `This name comes from ${provider} and follows it until you type or pick one yourself.`;
}

/** `profile.source.*`: one part of the "where it came from" line. */
export const sourceParts = {
  nameTyped: "Name typed by you",
  nameFrom: (from: string) => `Name from ${from}`,
  pictureFrom: (from: string) => `picture from ${from}`,
  pictureUploaded: "picture uploaded by you",
  pictureInitials: "initials instead of a picture",
  appleNoPicture: "Apple doesn't share a picture",
  noPicture: "no picture",
} as const;

/** `profile.picture.earlierNote`: a picked picture its method has since replaced. */
export function earlierPictureNote(provider: string): string {
  return `An earlier picture from ${provider}`;
}

/** `profile.name.chip`: a name chip's accessible name (its visible text is the name alone). */
export function chipLabel(provider: string, name: string): string {
  return `Use the name ${name} from ${provider}`;
}

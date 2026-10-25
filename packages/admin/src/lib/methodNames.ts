/**
 * How a sign-in method is named (shared by the Locker and the console's Sign-in methods page).
 * Pure; the words match the Worker's `methodLabel` (`services/identity/accounts/links.ts`).
 */

/** A method kind in words, as the Worker names it. Never print the raw kind. */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  email: "Email",
  passkey: "Passkey",
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  gamecenter: "Game Center",
  pgs: "Google Play Games",
  eos: "Epic Online Services",
  oidc: "Single sign-on",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? "Sign-in method";
}

/**
 * Passkey providers by AAGUID (the authenticator model the browser disclosed at enrolment): a
 * static table shipped with the site, never fetched. Sources: each vendor's published AAGUID, as
 * collected by the passkey-authenticator-aaguids list. An all-zero AAGUID (Safari, and any browser
 * asked for no attestation, may send one) names no provider.
 */
export const PASSKEY_PROVIDERS: Readonly<
  Record<string, { name: string; glyph?: "apple" | "google" | "windows" }>
> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": {
    name: "iCloud Keychain",
    glyph: "apple",
  },
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": {
    name: "iCloud Keychain",
    glyph: "apple",
  },
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": {
    name: "Google Password Manager",
    glyph: "google",
  },
  "adce0002-35bc-c60a-648b-0b25f1f05503": { name: "Chrome on Mac" },
  "b5397666-4885-aa6b-cebf-e52262a439a2": { name: "Chromium" },
  "08987058-cadc-4b81-b6e1-30de50dcbe96": {
    name: "Windows Hello",
    glyph: "windows",
  },
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": {
    name: "Windows Hello",
    glyph: "windows",
  },
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": {
    name: "Windows Hello",
    glyph: "windows",
  },
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": {
    name: "Microsoft Password Manager",
  },
  "bada5566-a7aa-401f-bd96-45619a55120d": { name: "1Password" },
  "d548826e-79b4-db40-a3d8-11116f7e8349": { name: "Bitwarden" },
  "531126d6-e717-415c-9320-3d9aa6981239": { name: "Dashlane" },
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": { name: "Keeper" },
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": { name: "NordPass" },
  "50726f74-6f6e-5061-7373-50726f746f6e": { name: "Proton Pass" },
  "f3809540-7f14-49c1-a8b3-8f813b225541": { name: "Enpass" },
  "fdb141b2-5d84-443e-8a35-4698c205a502": { name: "KeePassXC" },
  "53414d53-554e-4700-0000-000000000000": { name: "Samsung Pass" },
  "cb69481e-8ff7-4039-93ec-0a2729a154a8": { name: "YubiKey 5" },
  "ee882879-721c-4913-9775-3dfcce97072a": { name: "YubiKey 5 NFC" },
  "2fc0579f-8113-47ea-b116-bb5a8db9202a": { name: "YubiKey 5 NFC" },
  "d8522d9f-575b-4866-88a9-ba99fa02f35b": { name: "YubiKey Bio" },
  "f8a011f3-8c0a-4d15-8006-17111f9edc7d": { name: "Security Key by Yubico" },
};

/** The provider that holds this passkey, by its AAGUID; null when unknown. */
export function passkeyProvider(
  aaguid: string | null | undefined,
): { name: string; glyph?: "apple" | "google" | "windows" } | null {
  if (!aaguid) return null;
  return PASSKEY_PROVIDERS[aaguid.trim().toLowerCase()] ?? null;
}

/**
 * A passkey's name (PORTAL.md §4.26): the one its holder gave it, else its provider by AAGUID,
 * else the browser it was added from, else `fallback` ("Passkey").
 */
export function passkeyName(
  p: {
    aaguid?: string | null;
    addedFrom?: string | null;
    name?: string | null;
  },
  fallback = "Passkey",
): string {
  return (
    p.name?.trim() ||
    passkeyProvider(p.aaguid)?.name ||
    p.addedFrom?.trim() ||
    fallback
  );
}

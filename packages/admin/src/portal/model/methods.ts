/**
 * Account → Sign-in methods and Where you're signed in (PX-13; PORTAL.md §4.26): the words the
 * page builds from `GET /api/me/methods` and `GET /api/sessions`. Pure.
 */
import type {
  PortalMethod,
  PortalMethods,
  PortalPasskey,
  PortalProvider,
} from "../api.js";

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
 * A passkey's name (PORTAL.md §4.26 "provider name"): its provider by AAGUID, else the browser it
 * was added from, else "Passkey".
 */
export function passkeyName(
  p: Pick<PortalPasskey, "aaguid" | "addedFrom">,
): string {
  return passkeyProvider(p.aaguid)?.name ?? p.addedFrom?.trim() ?? "Passkey";
}

/** The account's providers by name, in the provider row's order. */
export const PROVIDER_NAME: Record<PortalProvider, string> = {
  apple: "Apple",
  google: "Google",
  steam: "Steam",
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What stays after removing `id` ("Google, 2 emails and 2 passkeys"), or null when nothing would
 * (the Worker refuses that removal anyway).
 */
export function remainingAfter(
  methods: readonly PortalMethod[],
  id: string,
): string | null {
  const left = methods.filter((m) => m.id !== id);
  if (left.length === 0) return null;
  const accounts = [
    ...new Set(left.filter((m) => m.group === "accounts").map((m) => m.label)),
  ];
  const emails = left.filter((m) => m.group === "email").length;
  const passkeys = left.filter((m) => m.group === "passkeys").length;
  return list([
    ...accounts,
    ...(emails ? [plural(emails, "email", "emails")] : []),
    ...(passkeys ? [plural(passkeys, "passkey", "passkeys")] : []),
  ]);
}

/** How a session signed in, in words (`GET /api/sessions` `methods`): unknown kinds are left out. */
const SESSION_METHOD: Record<string, string> = {
  passkey: "a passkey",
  email: "an email code",
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  device: "another device",
  oidc: "single sign-on",
};

export function sessionMethodText(methods: readonly string[]): string | null {
  const named = [
    ...new Set(
      methods
        .map((m) => SESSION_METHOD[m])
        .filter((m): m is string => Boolean(m)),
    ),
  ];
  return named.length ? `Signed in with ${list(named)}` : null;
}

/**
 * Whether a change can go ahead without confirming it's you first: the Worker says the session's
 * sign-in is fresh and it stays so for a little longer than a click takes. The Worker checks again
 * as the change lands; a `step_up_required` then asks after all.
 */
export function stepUpFresh(
  stepUp: PortalMethods["stepUp"] | undefined,
  nowSeconds: number,
): boolean {
  if (!stepUp) return false;
  return stepUp.fresh && stepUp.freshUntil - nowSeconds > 15;
}

/** The provider kinds the person can sign in again with to confirm it's them. */
export function stepUpProviders(view: PortalMethods): PortalProvider[] {
  return view.providers
    .filter((p) => p.connected && p.available)
    .map((p) => p.kind);
}

/** An account method's row label: the connected identity ("Sam's Apple Account · Hide My Email"). */
export function methodIdentity(m: PortalMethod): string | null {
  const shown = m.display?.trim() || null;
  if (m.relay) return shown ? `${shown} · Hide My Email` : "Hide My Email";
  return shown;
}

/**
 * The words of the licence-key email (LX-27), pure and import-free so the console's Delivery
 * preview (LX-29) and the Worker's template (`core/notify/templates.ts`) read the same strings.
 */

export type KeyEmailContext = "created" | "sent" | "assigned";

export const KEY_FOOTERS: Record<KeyEmailContext, string> = {
  created:
    "You are receiving this because a license was created for this address.",
  sent: "You are receiving this because a new key was sent for your license.",
  assigned:
    "You are receiving this because a license was assigned to this address.",
};

export const keyEmailSubject = (productName: string): string =>
  productName ? `Your ${productName} license` : "Your license";

/** The lines above the key. */
export const keyEmailIntro = (holderName: string): string[] => [
  ...(holderName ? [`Hi ${holderName},`] : []),
  "Here is your license key.",
];

/** The line under the key. */
export const KEY_EMAIL_AFTER =
  "Enter it in the app to activate. Keep it private: anyone with the key can use it.";

/** The primary button: the product's download when it has one, else the portal sign-in. */
export const keyEmailPrimaryLabel = (hasDownload: boolean): string =>
  hasDownload ? "Download" : "Open in Polaris Locker";

/**
 * The words of the licence-invitation email (LX-27c): a sign-in link and no key. The address is
 * named in the body, never put in a URL. Same strings for an address with and without an account.
 */
export type InviteEmailContext = "created" | "resent" | "assigned";

export const INVITE_FOOTERS: Record<InviteEmailContext, string> = {
  created:
    "You are receiving this because a license was created for this address.",
  resent: "You are receiving this because your invitation was sent again.",
  assigned:
    "You are receiving this because a license was assigned to this address.",
};

export const inviteEmailSubject = (productName: string): string =>
  productName
    ? `Your ${productName} license is ready`
    : "Your license is ready";

/** The lines in the body. */
export const inviteEmailIntro = (
  holderName: string,
  productName: string,
  address: string,
): string[] => [
  ...(holderName ? [`Hi ${holderName},`] : []),
  `Your ${productName ? `${productName} ` : ""}license is ready. Sign in with ${address} to use it.`,
];

/** The primary button: the product's download when it has one, else the portal sign-in. */
export const inviteEmailPrimaryLabel = keyEmailPrimaryLabel;

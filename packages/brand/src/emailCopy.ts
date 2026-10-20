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
  hasDownload ? "Download" : "Open in Polaris Key";

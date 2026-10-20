import { brandName } from "../brand.js";
import { t } from "../../lib/copy.js";

/**
 * Your data's copy (S-16 §5.5, §5.7; I-11): Account's **Download my data**, and each product page's
 * "Your data in <Product>" card with its **Remove my data from <Product>** confirmation.
 *
 * The catalog (`lib/copy.ts` `t()`) holds no `yourData.*` keys yet, so, like `profile.ts` and
 * `getIt.ts`, the strings live here under the keys they will take, and the sentences that change
 * with the data (a plural, a license kept or removed) are the functions below the table. US
 * spelling, sentence case, no jargon (§6.1): "your data in an app", never a subject or a
 * pairwise id.
 *
 * Scope is said wherever it could be mistaken. Account's file is the whole account; a product's
 * file and its removal are only what that product holds for the person, and neither touches the
 * account, another product or the account's deletion (the 14-day erasure stays on Account).
 */
export const YOUR_DATA_COPY = {
  "yourData.account.copy.title": "Download my data",
  "yourData.account.copy.body":
    "Account, sign-in methods, licenses, devices and each app's data. No keys or tokens.",
  "yourData.account.copy.button": "Download my data",
  "yourData.copy.private": "It holds personal details, so keep it private.",
  "yourData.copy.started": "Your download has started",
  "yourData.product.copy.title": "Download my data",
  "yourData.product.remove.title": "Remove my data",
  "yourData.product.remove.body": `${brandName()} deletes your settings and activity here. This can't be undone.`,
  "yourData.product.support.title": "Support code",
  "yourData.product.support.body": "Read it to the app's support team.",
  "yourData.remove.keep": "Keep my data",
} as const;

/** What a product's file holds: its licenses only when the person has one. */
export function productCopyBody(licenses: number): string {
  return licenses > 0
    ? `Your ${licenses === 1 ? "license" : "licenses"}, devices, settings and activity.`
    : "Your settings and activity.";
}

/**
 * The removal's consequences, one effect per line. While a license stays (the default, D25) the
 * developer can still connect the person to the old records through it, and the line says so; with
 * the choice to remove it too, that line gives way to the choice's own words. An open product has
 * no license: only that it stays in the library.
 */
export function removeConsequences(o: {
  name: string;
  developer: string | null;
  licenses: number;
  alsoRemoveLicense: boolean;
}): string[] {
  const list = [
    `${brandName()} deletes your settings and activity for ${o.name}. This can't be undone.`,
    `${o.developer ?? "The developer"} is told, so they can delete their own copy.`,
  ];
  if (o.licenses === 0) list.push(`${o.name} stays in your library.`);
  else if (!o.alsoRemoveLicense) {
    const who = o.developer ?? "the developer";
    list.push(
      o.licenses === 1
        ? `Your license stays in your library. While it does, ${who} can still connect you to your old records through it.`
        : `Your licenses stay in your library. While they do, ${who} can still connect you to your old records through them.`,
    );
  }
  return list;
}

/** The choice, offered only when every license can be added back with its key. */
export function alsoRemoveLabel(licenses: number): string {
  return licenses === 1
    ? "Also remove my license from my library"
    : `Also remove my ${licenses} licenses from my library`;
}

export function alsoRemoveNote(licenses: number): string {
  return licenses === 1
    ? "It won't come back to this account by itself. To add it again, use its key."
    : "They won't come back to this account by themselves. To add them again, use their keys.";
}

/** The confirm button names the choice made, so the bigger removal is never a surprise. */
export function removeConfirm(
  alsoRemoveLicense: boolean,
  licenses: number,
): string {
  if (!alsoRemoveLicense) return "Remove my data";
  return licenses === 1
    ? "Remove my data and license"
    : "Remove my data and licenses";
}

/** The toast's second line: what became of the license, or that an open product stays. */
export function removedNote(o: {
  name: string;
  licenses: number;
  alsoRemoveLicense: boolean;
}): string {
  if (o.licenses === 0) return `${o.name} stays in your library.`;
  if (o.alsoRemoveLicense)
    return o.licenses === 1
      ? "Your license also left your library. To add it again, use its key."
      : "Your licenses also left your library. To add them again, use their keys.";
  return o.licenses === 1
    ? "Your license stays in your library."
    : "Your licenses stay in your library.";
}

/**
 * `409 not_removable` on a removal that also asked for the license to go: nothing was written, so
 * the data is still there too, and the person can still remove it and keep the license. `reason` is
 * the Worker's (`no_active_key`, `key_claim_off`); any other reads as the catalog's refusal.
 */
export function notRemovableCopy(
  name: string,
  reason: string | undefined,
): { title: string; description: string } {
  const why =
    reason === "no_active_key"
      ? "A license has no active key, so it couldn't be added back later. It stays in your library."
      : reason === "key_claim_off"
        ? `${name} doesn't let you add a license with its key, so it couldn't be added back later. It stays in your library.`
        : t("core.codes.not_removable.message");
  return {
    title: "Nothing was removed",
    description: `${why} You can still remove your data and keep your license.`,
  };
}

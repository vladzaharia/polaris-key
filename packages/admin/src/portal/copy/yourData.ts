import { t } from "../../lib/copy.js";

/**
 * Your data's copy (S-16 §5.5, §5.7; I-11): Account's **Download my data**, and each product page's
 * "Your data in <Product>" card with its **Remove my data from <Product>** confirmation.
 *
 * The table reads the `yourData.*` keys of the kit copy catalog (nine locales); the sentences
 * that change with the data (a plural, a license kept or removed) are the functions below it. US
 * spelling, sentence case, no jargon (§6.1): "your data in an app", never a subject or a
 * pairwise id.
 *
 * Scope is said wherever it could be mistaken. Account's file is the whole account; a product's
 * file and its removal are only what that product holds for the person, and neither touches the
 * account, another product or the account's deletion (the 14-day erasure stays on Account).
 */
export const YOUR_DATA_COPY = {
  "yourData.account.copy.title": t("yourData.account.copy.title"),
  "yourData.account.copy.body": t("yourData.account.copy.body"),
  "yourData.account.copy.button": t("yourData.account.copy.button"),
  "yourData.copy.private": t("yourData.copy.private"),
  "yourData.copy.started": t("yourData.copy.started"),
  "yourData.product.copy.title": t("yourData.product.copy.title"),
  "yourData.product.remove.title": t("yourData.product.remove.title"),
  "yourData.product.support.title": t("yourData.product.support.title"),
  "yourData.product.support.body": t("yourData.product.support.body"),
  "yourData.remove.keep": t("yourData.remove.keep"),
} as const;

/** The support code's one-line hint (I-41): said to the app's support, so it names the app. */
export function supportCodeHint(name: string): string {
  return t("yourData.support.hint", { name });
}

/** A service map from the product's page (`services.config`, `services.sync`); `undefined` until read. */
export type DataServices = Readonly<Record<string, boolean>> | undefined;

/**
 * What a product holds for the person, named from the services it has on (never a fixed list):
 * settings only with Config, synced data only with Cloud Sync, activity always (settings and activity until the product's services are known). The license and its
 * devices count only when the person has one (`withLicense`). Joined as a list in the reader's
 * language ("settings, synced data and activity").
 */
function kinds(
  services: DataServices,
  licenses: number,
  withLicense: boolean,
): string {
  // Before the product's page answers: the long-standing "settings and activity".
  const on = services ?? { config: true };
  const out: string[] = [];
  if (withLicense && licenses > 0) {
    out.push(
      t(licenses === 1 ? "yourData.kind.license" : "yourData.kind.licenses"),
      t("yourData.kind.devices"),
    );
  }
  if (on.config) out.push(t("yourData.kind.settings"));
  if (on.sync) out.push(t("yourData.kind.synced"));
  out.push(t("yourData.kind.activity"));
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(out);
}

/** What a product's file holds. */
export function productCopyBody(
  licenses: number,
  services: DataServices,
): string {
  return t("yourData.product.copy.body", {
    detail: kinds(services, licenses, true),
  });
}

/** What the removal deletes (the data, never the license): the card row's sentence. */
export function removeBody(services: DataServices): string {
  return t("yourData.product.remove.body", {
    detail: kinds(services, 0, false),
  });
}

/**
 * The removal's consequences, one effect per line, each fact once. While a license stays (the
 * default, D25) the developer can still connect the person to the old records through it, and the
 * line says so; with the choice to remove it too, that line gives way to the choice's own words. An
 * open product has no license: only that it stays in the library.
 */
export function removeConsequences(o: {
  name: string;
  developer: string | null;
  licenses: number;
  alsoRemoveLicense: boolean;
  services: DataServices;
}): string[] {
  const list = [
    t("yourData.remove.goes", {
      detail: kinds(o.services, 0, false),
      product: o.name,
    }),
    t("yourData.remove.developerTold", {
      developer: o.developer ?? t("license.developerFallbackCap"),
    }),
  ];
  if (o.licenses === 0)
    list.push(t("yourData.remove.entryStays", { product: o.name }));
  else if (!o.alsoRemoveLicense) {
    list.push(
      t(
        o.licenses === 1
          ? "yourData.remove.licenseStaysOne"
          : "yourData.remove.licenseStaysMany",
        { developer: o.developer ?? t("license.developerFallback") },
      ),
    );
  }
  return list;
}

/** The choice, offered only when every license can be added back with its key. */
export function alsoRemoveLabel(licenses: number): string {
  return licenses === 1
    ? t("yourData.remove.alsoLabelOne")
    : t("yourData.remove.alsoLabelMany", { count: licenses });
}

export function alsoRemoveNote(licenses: number): string {
  return t(
    licenses === 1
      ? "yourData.remove.alsoNoteOne"
      : "yourData.remove.alsoNoteMany",
  );
}

/** The confirm button names the choice made, so the bigger removal is never a surprise. */
export function removeConfirm(
  alsoRemoveLicense: boolean,
  licenses: number,
): string {
  if (!alsoRemoveLicense) return t("yourData.product.remove.title");
  return t(
    licenses === 1
      ? "yourData.remove.confirmAlsoOne"
      : "yourData.remove.confirmAlsoMany",
  );
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
      ? t("yourData.remove.refused.noKey")
      : reason === "key_claim_off"
        ? t("yourData.remove.refused.keyClaimOff", { name })
        : t("core.codes.not_removable.message");
  return {
    title: t("yourData.remove.refused.title"),
    description: `${why} ${t("yourData.remove.refused.rest")}`,
  };
}

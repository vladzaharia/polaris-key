/**
 * THE DEEP-LINK TABLE (A-18a; notes/S-15 §6.5). Every store page an operator is sent to for a
 * step no API performs (create the app record, answer the age rating, fill the privacy form)
 * is one row here: `{id, store, template, params, verify}`. Stores document almost none of these
 * URL shapes (Play documents one), so they live in ONE table: a moved page is a one-line fix, and
 * `test/storefront/conformance.test.ts` renders every template.
 *
 *   - `template` is an `https:` URL whose `{name}` placeholders are exactly `params`. A value is
 *     URL-encoded and must be a plain identifier, so a stored id cannot redirect the operator.
 *   - `verify` is how the console learns the step is done: a read the adapter's gate allows,
 *     polled every `every` seconds until `until` seconds have passed (S-14 §5.1: 10 s for up to
 *     15 minutes, plus "Check now"), or the operator's own assertion. The read's placeholders are
 *     the row's params or ids the verifier obtains itself (Play's `{editId}`: every Play read is
 *     inside an edit the verifier opens under the edit lease).
 *
 * A `deep-link` operation in an adapter's capabilities names a row by id; the conformance suite
 * fails a link id with no row and a verifier read the gate would refuse.
 */

/** How a deep-linked step is verified. */
export type DeepLinkVerify =
  | {
      /** A GET path the adapter's gate admits (placeholders: the row's params or verifier-held ids). */
      readonly read: string;
      readonly every: number;
      readonly until: number;
    }
  | "operator-assertion";

export interface DeepLinkTemplate {
  readonly id: string;
  /** The storefront adapter id. */
  readonly store: string;
  readonly template: string;
  readonly params: readonly string[];
  readonly verify: DeepLinkVerify;
}

/** S-14 §5.1's polling: every 10 s for up to 15 minutes. */
const POLL = { every: 10, until: 900 } as const;

export const DEEP_LINKS: readonly DeepLinkTemplate[] = [
  // ── App Store (A-17; undocumented by Apple, S-14 §4 [I]) ──
  {
    id: "app-store.new-app",
    store: "app-store",
    template: "https://appstoreconnect.apple.com/apps",
    params: [],
    verify: { read: "/v1/apps", ...POLL },
  },
  {
    id: "app-store.app-information",
    store: "app-store",
    template:
      "https://appstoreconnect.apple.com/apps/{appId}/distribution/info",
    params: ["appId"],
    verify: "operator-assertion",
  },
  {
    id: "app-store.app-privacy",
    store: "app-store",
    template:
      "https://appstoreconnect.apple.com/apps/{appId}/distribution/privacy",
    params: ["appId"],
    verify: "operator-assertion",
  },
  {
    id: "app-store.version",
    store: "app-store",
    template: "https://appstoreconnect.apple.com/apps/{appId}/distribution",
    params: ["appId"],
    verify: "operator-assertion",
  },
  {
    id: "app-store.agreements",
    store: "app-store",
    template: "https://appstoreconnect.apple.com/business",
    params: [],
    verify: "operator-assertion",
  },
  {
    id: "app-store.identifiers",
    store: "app-store",
    template: "https://developer.apple.com/account/resources/identifiers/list",
    params: [],
    verify: "operator-assertion",
  },
  // ── Google Play (A-18e; S-15 §4.1, §6.5). Play documents ONE deep-link form, the Integrity
  // link [V]; every other shape is the Console's current URL [I] (`{developerId}` and `{appId}`
  // are the Console's own numeric ids, which the operator's Console URL shows), so a moved page is
  // a one-line fix here. ──
  {
    id: "google-play.create-app",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/create-new-app",
    params: ["developerId"],
    // The app exists once Reporting's `apps:search` lists the package AND a read-only edit opens
    // on it (`connectors/play/storefront.ts` `verifyPlayApp`); the gate admits the edit's reads.
    verify: {
      read: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/details",
      ...POLL,
    },
  },
  {
    id: "google-play.store-settings",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/store-settings",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    id: "google-play.content-rating",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/app-content/content-rating-overview",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    id: "google-play.app-content",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/app-content/overview",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    id: "google-play.monetization-setup",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/monetization-setup",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    id: "google-play.integrity",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/app/protect-with-play",
    params: [],
    verify: "operator-assertion",
  },
  {
    id: "google-play.managed-publishing",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/publishing",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    id: "google-play.testers",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/tracks",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  {
    // Decision 6: no deleting Play images in v1. After a screenshot set is replaced, the old images
    // are removed here by the operator.
    id: "google-play.main-store-listing",
    store: "google-play",
    template:
      "https://play.google.com/console/developers/{developerId}/app/{appId}/main-store-listing",
    params: ["developerId", "appId"],
    verify: "operator-assertion",
  },
  // ── Microsoft Store (A-18f; Partner Center documents none of these shapes, S-15 §6.5 [I]) ──
  {
    // Reserve the name: the app record exists only once a person has done it (S-15 §4.2).
    id: "microsoft-store.new-app",
    store: "microsoft-store",
    template: "https://partner.microsoft.com/dashboard/apps-and-games/overview",
    params: [],
    verify: { read: "/v1.0/my/applications", ...POLL },
  },
  {
    // The first submission, with the IARC age-ratings questionnaire, is Partner Center only.
    // Done when the app has a published submission (`lastPublishedApplicationSubmission`).
    id: "microsoft-store.first-submission",
    store: "microsoft-store",
    template:
      "https://partner.microsoft.com/dashboard/products/{productId}/overview",
    params: ["productId"],
    verify: { read: "/v1.0/my/applications/{productId}", ...POLL },
  },
  {
    id: "microsoft-store.age-ratings",
    store: "microsoft-store",
    template:
      "https://partner.microsoft.com/dashboard/products/{productId}/ageratings",
    params: ["productId"],
    verify: "operator-assertion",
  },
  {
    // MSIX Properties: privacy policy, website and support URLs (the classic fields are
    // obsolete and ignored, S-15 §4.2).
    id: "microsoft-store.properties",
    store: "microsoft-store",
    template:
      "https://partner.microsoft.com/dashboard/products/{productId}/properties",
    params: ["productId"],
    verify: "operator-assertion",
  },
  {
    // The post-UI-edit case: a submission the API created and a person then edited in Partner
    // Center can no longer be changed or committed by the API, only deleted, and deleting is
    // denied. This link is all the flow offers afterwards.
    id: "microsoft-store.submission",
    store: "microsoft-store",
    template:
      "https://partner.microsoft.com/dashboard/products/{productId}/submissions/{submissionId}",
    params: ["productId", "submissionId"],
    verify: "operator-assertion",
  },
  // ── itch.io (A-18h; S-15 §4.4: the page has no API) ──
  {
    id: "itch.new-game",
    store: "itch",
    template: "https://itch.io/game/new",
    params: [],
    verify: "operator-assertion",
  },
  {
    id: "itch.edit-game",
    store: "itch",
    template: "https://itch.io/game/edit/{gameId}",
    params: ["gameId"],
    verify: "operator-assertion",
  },
  // ── Snap Store (A-18h; title, screenshots and banner are dashboard-only [V][S]) ──
  {
    id: "snap.register",
    store: "snap",
    template: "https://snapcraft.io/register-snap",
    params: [],
    verify: "operator-assertion",
  },
  {
    id: "snap.listing",
    store: "snap",
    template: "https://snapcraft.io/{name}/listing",
    params: ["name"],
    verify: "operator-assertion",
  },
  // ── Steam (A-18g; Steamworks partner pages, undocumented as URL shapes, S-15 §6.5 [I]) ──
  {
    // Pay the app fee and create the app; verified when the publisher key lists the new app.
    id: "steam.new-app",
    store: "steam",
    template: "https://partner.steamgames.com/apps/landing",
    params: [],
    verify: { read: "/ISteamApps/GetPartnerAppListForWebAPIKey/v2/", ...POLL },
  },
  {
    // The store page: text, capsules, screenshots, trailers, tags, the content survey, review.
    id: "steam.store-page",
    store: "steam",
    template: "https://partner.steamgames.com/admin/game/edit/{appId}",
    params: ["appId"],
    verify: "operator-assertion",
  },
  {
    // App Admin's builds page: setting a build live on the default (public) branch (decision 5).
    id: "steam.app-admin",
    store: "steam",
    template: "https://partner.steamgames.com/apps/builds/{appId}",
    params: ["appId"],
    verify: { read: "/ISteamApps/GetAppBetas/v1/", ...POLL },
  },
  // ── PR-plane outlets (A-18i; S-15 §4.4: each bootstrap is a person's) ──
  {
    // Create the `homebrew-<name>` repository the tap is; then set direct.homebrewTap.
    id: "homebrew.new-tap",
    store: "homebrew",
    template: "https://github.com/new",
    params: [],
    verify: "operator-assertion",
  },
  {
    // Scoop's bucket template, with its Excavator workflow (checkver and autoupdate).
    id: "scoop.new-bucket",
    store: "scoop",
    template: "https://github.com/ScoopInstaller/BucketTemplate/generate",
    params: [],
    verify: "operator-assertion",
  },
  {
    // The first submission: a PR to flathub/flathub against new-pr, opened and shepherded by a
    // person from `pkey storefront flathub init`'s files.
    id: "flathub.submission",
    store: "flathub",
    template: "https://docs.flathub.org/docs/for-app-authors/submission",
    params: [],
    verify: "operator-assertion",
  },
];

/** A row by id, or null. */
export function deepLink(id: string): DeepLinkTemplate | null {
  return DEEP_LINKS.find((l) => l.id === id) ?? null;
}

/** A parameter value a link may carry: a plain identifier. */
const PARAM_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Render a row with its parameters. Throws on an unknown id, a missing or extra parameter, or a
 * value that is not a plain identifier.
 */
export function renderDeepLink(
  id: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const link = deepLink(id);
  if (!link) throw new Error(`unknown deep link ${id}`);
  const given = Object.keys(params).sort();
  if (given.join(",") !== [...link.params].sort().join(","))
    throw new Error(
      `deep link ${id} takes ${link.params.join(", ") || "no parameters"}`,
    );
  let url = link.template;
  for (const name of link.params) {
    const v = params[name]!;
    if (!PARAM_VALUE.test(v))
      throw new Error(`deep link ${id}: invalid ${name}`);
    url = url.replaceAll(`{${name}}`, encodeURIComponent(v));
  }
  return url;
}

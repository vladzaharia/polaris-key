// The S-07 checklist as data. Each row is one dated fact from the research; each source is a
// primary page that must still contain the quoted wording. A failing quote means "changed or
// moved: read the page and re-decide the verdict", never "the fact is false".
//
// source fields
//   id        short label used in the report
//   url       page to fetch
//   kind      html | md | docc | json   (docc = developer.apple.com/tutorials/data JSON)
//   date      regex with one capture group, run on the raw body, giving the page's own date
//   quotes    strings that must appear (whitespace, smart quotes and dashes are normalised)
//   regexes   [RegExp, label] pairs that must match the extracted text
//   expect    (ctx) => string[]  extra checks that return failure messages
//   canary    { title } the URL is expected to be a soft-404 with this <title> (tests a moved page)

const APPLE_NEWS = "https://developer.apple.com/news/";
const ANDROID_DV = "https://developer.android.com/developer-verification";
const PLAY_HELP =
  "https://support.google.com/googleplay/android-developer/answer";
const MS_LEARN = "https://learn.microsoft.com/en-us/windows/apps/publish";
const MS_API = "https://learn.microsoft.com/en-us/windows/uwp/monetize";
const WINGET_RAW =
  "https://raw.githubusercontent.com/microsoft/winget-pkgs/master/doc";
const DOCC =
  "https://developer.apple.com/tutorials/data/documentation/appstoreconnectapi";
const MS_DATE = /<meta name="ms\.date" content="([^"]*)"/;
const GOOGLE_DATE = /Last updated (\d{4}-\d{2}-\d{2}) UTC/;

const src = (id, url, kind, rest = {}) => ({ id, url, kind, ...rest });

export const rows = [
  {
    row: 1,
    fact: "Android developer verification: enforcement from 2026-09-30 for participating stores in BR, ID, SG, TH; global in 2027; direct sideloads not yet in scope",
    sources: [
      src("overview", ANDROID_DV, "html", {
        quotes: [
          "Next milestone: September 30, 2026",
          "These protections begin for users installing apps from participating stores (Google Play, HONOR App Market, OPPO App Market, Galaxy Store, Palm Store, V-Appstore, GetApps) in Brazil, Indonesia, Singapore, and Thailand, on certified devices running Android 7+. In 2027, we'll expand this globally to all apps on certified devices.",
        ],
      }),
      src("guide", `${ANDROID_DV}/guides`, "html", {
        date: GOOGLE_DATE,
        quotes: [
          "Starting September 30, 2026, these new developer verification protections go live for users in Brazil, Indonesia, Singapore, and Thailand.",
        ],
      }),
      src("faq", `${ANDROID_DV}/guides/faq`, "html", {
        quotes: [
          "The September 30, 2026 deadline only applies to the specific participating stores.",
          "enforcement will only apply to mobile and tablet form factors in the selected regions",
        ],
      }),
    ],
  },
  {
    row: 2,
    fact: "Registration mechanics: $25 fee (waived for limited distribution, up to 20 devices); verificationToken in adi-registration.properties; console API is OAuth web-server flow only; advanced flow has a 24-hour wait",
    sources: [
      src("faq", `${ANDROID_DV}/guides/faq`, "html", {
        quotes: [
          "The $25 fee for the Full Distribution account in the ADC",
          "We are waiving the fee for developers who qualify for a Limited Distribution account.",
          "Why is there a 24-hour waiting period to enable the advanced flow?",
        ],
      }),
      src("api", `${ANDROID_DV}/guides/developer-console-api`, "html", {
        date: GOOGLE_DATE,
        quotes: [
          "Service Accounts, Workload Identity Federation, and API keys cannot be used to authenticate API requests.",
          "applications must use the OAuth 2.0 Web Server flow",
          "adi-registration.properties",
          "verificationToken",
        ],
      }),
      src("limited", `${ANDROID_DV}/guides/limited-distribution`, "html", {
        quotes: [
          "Share apps with up to 20 devices that end-users have explicitly authorized.",
          "This account is free.",
        ],
      }),
    ],
  },
  {
    row: 3,
    fact: "F-Droid hosts upstream developer-signed packages beside its own (2026-09-18); F-Droid 2.0 shipped 2026-09-24",
    sources: [
      src("news", "https://f-droid.org/en/news/", "html", {
        quotes: [
          "F-Droid 2.0: A New Chapter for Android Freedom",
          "Posted on Sep 24, 2026",
          "There's always a path",
          "Posted on Sep 18, 2026",
        ],
      }),
      src("twif-38", "https://f-droid.org/en/2026/09/18/twif.html", "html", {
        quotes: [
          "we've unlocked a new way to add developer signed packages to apps for which we already provide packages signed by us",
          "we modify our own package with a lower versionCode so they don't conflict",
        ],
      }),
    ],
  },
  {
    row: 4,
    fact: "Apple EU unified terms from 2026-10-01: 5% Core Technology Commission replaces the CTF; Initial Acquisition and Store Services fees end; broader marketplace eligibility; no EU entity needed (DPLA updated 2026-08-18)",
    sources: [
      src("news", APPLE_NEWS, "html", {
        quotes: [
          "The Core Technology Fee, a per-install fee for developers who achieve extraordinary scale, will be replaced by the Core Technology Commission, a simple 5% commission on digital transactions in apps distributed outside the App Store. The new terms also eliminate the Initial Acquisition Fee and Store Services Fee.",
          "Attachment 14 of the Apple Developer Program License Agreement has been added to specify updated terms for apps in the European Union",
        ],
      }),
      src("eu", "https://developer.apple.com/support/apps-in-the-eu/", "html", {
        quotes: [
          "Companies are no longer required to have a legal entity or be established in the EU to operate an alternative app marketplace or use Web Distribution.",
        ],
      }),
      src(
        "dpla",
        "https://developer.apple.com/support/terms/apple-developer-program-license-agreement/",
        "html",
        {
          quotes: [
            "This Attachment is effective as of October 1, 2026, or the date on which You sign this Agreement including this Attachment 14, whichever is later.",
          ],
        },
      ),
      src(
        "marketplace",
        "https://developer.apple.com/support/alternative-app-marketplace-in-the-eu/",
        "html",
        {
          quotes: [
            "Alternative app marketplaces and apps distributed through them are subject to a 5% Core Technology Commission (CTC)",
          ],
        },
      ),
      // Canary: E1 cited this URL; it is now a soft 404. If it revives, re-read it.
      src(
        "old-dma-page",
        "https://developer.apple.com/support/dma-and-apps-in-the-european-union/",
        "html",
        { canary: { title: "Page Not Found" } },
      ),
    ],
  },
  {
    row: 5,
    fact: "Alternative marketplaces in Japan (iOS 26.2+) and Brazil (iOS 26.5+); AltStore PAL serves EU, JP, BR; JP and BR business terms",
    sources: [
      src(
        "japan",
        "https://developer.apple.com/support/app-distribution-in-japan/",
        "html",
        {
          quotes: [
            "Now with iOS 26.2 and later, developers with apps in Japan can also distribute apps on alternative app marketplaces",
            "Core Technology Commission for iOS apps distributed outside of the App Store",
          ],
          regexes: [
            [
              /Rate \| ?Applies to \| ?5% \| ?Alternative app marketplaces or apps distributed through them are subject to a commission/i,
              "JP CTC 5%",
            ],
            [
              /21% \| ?Sale of digital goods or services/i,
              "JP App Store commission 21%",
            ],
            [
              /5% \| ?Payments processed by Apple In-App Purchase/i,
              "JP payment processing fee 5%",
            ],
          ],
        },
      ),
      src(
        "brazil",
        "https://developer.apple.com/support/app-distribution-in-brazil/",
        "html",
        {
          quotes: [
            "iOS 26.5 introduces new options for developers with apps in Brazil.",
          ],
          regexes: [
            [
              /Rate \| ?Applies to \| ?5% \| ?Alternative app marketplaces or apps distributed through them are subject to a commission/i,
              "BR CTC 5%",
            ],
            [
              /21% \| ?Sale of digital goods or services/i,
              "BR App Store commission 21%",
            ],
          ],
        },
      ),
      src("news", APPLE_NEWS, "html", {
        quotes: [
          "Beginning with iOS 26.5, developers can distribute apps on alternative app marketplaces",
          "Attachment 12 of the Apple Developer Program License Agreement has been revised to specify terms for iOS apps in Brazil",
          "Beginning with iOS 26.2, developers can distribute apps on alternative app marketplaces",
        ],
      }),
      src(
        "altstore",
        "https://faq.altstore.io/developers/distribute-with-altstore-pal.md",
        "md",
        {
          quotes: [
            "AltStore PAL is an official alternative app marketplace for Notarized apps available for users in the EU, Japan, and Brazil.",
          ],
        },
      ),
    ],
  },
  {
    row: 6,
    fact: "App Review Guidelines (June 8, 2026): 2.5.2 and DPLA 3.3.1(B), 3.1.1 and 3.1.3(b), 4.2.3(ii), 2.2 (TestFlight), 2.4.5",
    sources: [
      src(
        "guidelines",
        "https://developer.apple.com/app-store/review/guidelines/",
        "html",
        {
          date: /Last Updated: ([A-Z][a-z]+ \d+, \d{4})/,
          quotes: [
            "Last Updated: June 8, 2026",
            "Apps should be self-contained in their bundles, and may not read or write data outside the designated container area, nor may they download, install, or execute code which introduces or changes features or functionality of the app, including other apps.",
            "Apps may not use their own mechanisms to unlock content or functionality, such as license keys, augmented reality markers, QR codes, cryptocurrencies and cryptocurrency wallets, etc.",
            "including consumable items in multi-platform games, provided those items are also available as in-app purchases within the app.",
            "(ii) If your app needs to download additional resources in order to function on initial launch, disclose the size of the download and prompt users before doing so.",
            "apps using TestFlight cannot be distributed to testers in exchange for compensation of any kind",
            "(iv) They may not download or install standalone apps, kexts, additional code, or resources to add functionality or significantly change the app from what we see during the review process.",
            "(vii) They must use the Mac App Store to distribute updates; other update mechanisms are not allowed.",
          ],
        },
      ),
      src(
        "dpla",
        "https://developer.apple.com/support/terms/apple-developer-program-license-agreement/",
        "html",
        {
          quotes: [
            "Interpreted code may be downloaded to an Application but only so long as such code: (a) does not change the primary purpose of the Application by providing features or functionality that are inconsistent with the intended and advertised purpose of the Application (b) does not bypass signing, sandbox, or other security features of the OS; and (c) for Applications distributed on the App Store, does not create a store or storefront for other Applications.",
            "You may not use the In-App Purchase API to send any software updates to Your Application or otherwise add any additional executable code to Your Application.",
          ],
        },
      ),
      src(
        "testflight",
        "https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview",
        "html",
        {
          quotes: ["Your build becomes unavailable for testers after 90 days."],
        },
      ),
    ],
  },
  {
    row: 7,
    fact: "Play Device and Network Abuse: no self-update outside Play; no downloaded dex, JAR or .so; interpreter exception; REQUEST_INSTALL_PACKAGES restricted",
    sources: [
      src("device-abuse", `${PLAY_HELP}/9888379?hl=en`, "html", {
        quotes: [
          "An app distributed via Google Play may not modify, replace, or update itself using any method other than Google Play's update mechanism. Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play. This restriction does not apply to code that runs in a virtual machine or an interpreter where either provides indirect access to Android APIs (such as JavaScript in a webview or browser).",
          "Apps or third-party code, like SDKs, with interpreted languages (JavaScript, Python, Lua, etc.) loaded at run time (for example, not packaged with the app) must not allow potential violations of Google Play policies.",
        ],
      }),
      src("install-packages", `${PLAY_HELP}/12085295?hl=en`, "html", {
        quotes: [
          "Apps targeting API level 26 or newer must hold this permission in order to use Intent.ACTION_INSTALL_PACKAGE or the PackageInstaller API.",
          "Where the use of the permission is not directly related to the core purpose of the app.",
        ],
      }),
    ],
  },
  {
    row: 8,
    fact: "Play fee programmes: US injunction changes (2025-10-29, 2025-12-09; reporting and fees from 2026-10-01); expanded billing choice and lower fees from 2026-06-30 (US, EEA, UK), programmes 2026-09-30, staggered rollout; EEA external offers 2025-08-19",
    sources: [
      src("us-update", `${PLAY_HELP}/15582165?hl=en`, "html", {
        quotes: [
          "To ensure compliance with the injunction as of October 29, 2025",
          "(as launched on December 9, 2025)",
          "will need to report transactions and pay the relevant service fees starting on October 1, 2026.",
          "On September 17, 2026, we notified developers enrolled in external content links that they now have until December 1, 2026 to report successful download and pay the relevant service fees.",
        ],
      }),
      src(
        "blog",
        "https://android-developers.googleblog.com/2026/06/play-expanded-billing.html",
        "html",
        {
          quotes: [
            "24 June 2026",
            "This starts on June 30, 2026, beginning with the United States, European Economic Area, and United Kingdom.",
            "the service fee starts at 10% on your first $1M (USD) in annual earnings",
            "the billing fee is set at 5%",
            "when the program rate cards officially become available",
          ],
        },
      ),
      src("lower-fees", `${PLAY_HELP}/16954621?hl=en`, "html", {
        quotes: [
          "As announced on March 4, 2026, these changes will be rolled out in a staggered schedule.",
        ],
        regexes: [
          [/June 30, 2026 \| ?EEA, UK, US/, "rollout 2026-06-30 EEA/UK/US"],
          [
            /September 30, 2026 \| ?AU, JP \| ?AU, EEA, JP, UK, US/,
            "rollout 2026-09-30 AU/JP fees, programmes in AU/EEA/JP/UK/US",
          ],
          [/December 31, 2026 \| ?KR \| ?KR/, "rollout 2026-12-31 KR"],
          [
            /September 30, 2027 \| ?Rest of World \| ?Rest of World/,
            "rollout 2027-09-30 rest of world",
          ],
        ],
      }),
      src("service-fees", `${PLAY_HELP}/112622?hl=en`, "html", {
        quotes: [
          "For transactions with users in the EEA, UK, or US starting June 30, 2026:",
          "For all remaining markets until the announced updated service fees are rolled out globally:",
        ],
      }),
      src("billing-choice", `${PLAY_HELP}/17161464`, "html", {
        quotes: [
          "Only offer billing choice to users in available markets, currently:",
          "Existing external offers program",
        ],
      }),
    ],
  },
  {
    row: 9,
    fact: "Play Billing Library 7 must be migrated by 2026-08-31 (extension 2026-11-01); latest listed 9.1.0 (2026-06-18)",
    sources: [
      src(
        "release-notes",
        "https://developer.android.com/google/play/billing/release-notes",
        "html",
        {
          date: GOOGLE_DATE,
          quotes: [
            "By Aug 31, 2026, all new apps and updates to existing apps must use Billing Library version 8 or later. If you need more time to update your app, you can request an extension until Nov 1, 2026.",
            "Google Play Billing Library 9.1.0 Release (2026-06-18)",
          ],
          expect: ({ text }) =>
            /Google Play Billing Library (9\.[2-9]|[1-9]\d)\.\d+ Release/.test(
              text,
            )
              ? ["a newer Billing Library than 9.1.x is listed"]
              : [],
        },
      ),
      src(
        "deprecation-faq",
        "https://developer.android.com/google/play/billing/deprecation-faq",
        "html",
        {
          date: GOOGLE_DATE,
          regexes: [
            [
              /\b7 \| ?August 31, 2026 \| ?November 1, 2026/,
              "version 7: 2026-08-31, extension 2026-11-01",
            ],
            [
              /\b8 \| ?August 31, 2027 \| ?November 1, 2027/,
              "version 8: 2027-08-31",
            ],
            [
              /\b9 \| ?August 31, 2028 \| ?November 1, 2028/,
              "version 9: 2028-08-31",
            ],
          ],
        },
      ),
    ],
  },
  {
    row: 10,
    fact: "Target API 36 for new apps and updates from 2026-08-31 (extension 2026-11-01); 16 KB page-size support, updates blocked from 2027-02-01",
    sources: [
      src("target-api", `${PLAY_HELP}/11926878?hl=en`, "html", {
        quotes: [
          "New apps and app updates must target Android 16 (API level 36) or higher to be submitted to Google Play",
          "You will be able to request an extension to November 1, 2026 if you need more time to update your app.",
        ],
      }),
      src(
        "page-sizes",
        "https://developer.android.com/guide/practices/page-sizes",
        "html",
        {
          date: GOOGLE_DATE,
          quotes: [
            "Starting February 1, 2027, if your app updates don't support 16 KB memory page sizes, you won't be able to release these updates.",
            "NDK version r28 and higher compile 16 KB-aligned by default.",
          ],
        },
      ),
    ],
  },
  {
    row: 11,
    fact: "Microsoft Store: msstore CLI and Action update only free products; first submission is manual; Store Policies 7.20: 10.2.5, 10.2.2, 10.2.9, 10.8.1",
    sources: [
      src("cli", `${MS_LEARN}/msstore-dev-cli/overview`, "html", {
        date: MS_DATE,
        quotes: [
          "App update operations through Microsoft Store Developer CLI is currently supported for free products only. Paid products will be supported in a future release.",
          "Create one submission for the app in Partner Center, including the age ratings questionnaire.",
        ],
      }),
      src("action", `${MS_LEARN}/msstore-dev-cli/github-actions`, "html", {
        date: MS_DATE,
        quotes: [
          "App update operations through GitHub actions is currently supported for free products only.",
        ],
      }),
      src("policies", `${MS_LEARN}/store-policies`, "html", {
        date: MS_DATE,
        quotes: [
          "Document version: 7.20",
          "Publish date: September 15, 2026",
          "Effective date: October 22, 2026",
          "Your product must not attempt to fundamentally change or extend its described functionality or introduce features or functionality that are in violation of Store Policies through any form of dynamic inclusion of code.",
          "such products and in-product offerings must be installed and updated only through the Store.",
          "Non-gaming products may submit an HTTPS-enabled download URL (direct link) to the product's installer binaries.",
          "The following products are required to use the Microsoft Store in-product purchase APIs for the purchase of digital goods and services.",
        ],
      }),
    ],
  },
  {
    row: 12,
    fact: "Flathub generative-AI policy: agents must not open or automate submission PRs or write their commit messages; manifests must not contain AI-generated content",
    sources: [
      src(
        "raw-markdown",
        "https://raw.githubusercontent.com/flathub-infra/documentation/main/docs/02-for-app-authors/02-requirements.md",
        "md",
        {
          quotes: [
            "Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction.",
            "AI tools or agents must not open or automate Flathub submission pull requests, or generate their commit messages, descriptions, review comments, or replies.",
            "Submitters must disclose any AI-generated code, documentation, packaging, or other material they know or reasonably believe is included in the application or its Flathub packaging.",
          ],
        },
      ),
      src(
        "rendered",
        "https://docs.flathub.org/docs/for-app-authors/requirements",
        "html",
        {
          quotes: [
            "AI tools or agents must not open or automate Flathub submission pull requests, or generate their commit messages, descriptions, review comments, or replies.",
          ],
        },
      ),
      // History of the page (informational): the policy was rewritten twice in September 2026.
      src(
        "history",
        "https://api.github.com/repos/flathub-infra/documentation/commits?path=docs/02-for-app-authors/02-requirements.md&per_page=3",
        "json",
        {
          expect: ({ json }) => {
            const latest = json?.[0]?.commit?.committer?.date ?? "";
            return latest >= "2026-09-22"
              ? [
                  `requirements.md changed after 2026-09-21 (latest commit ${latest}); re-read the policy`,
                ]
              : [];
          },
        },
      ),
    ],
  },
  {
    row: 13,
    fact: "Downloaded scripts in packs: the data-only rule for store builds rests on rows 6, 7 and 11 (plus Apple notarization for alternative distribution)",
    dependsOn: [6, 7, 11],
    sources: [
      src(
        "apple-notarization",
        "https://developer.apple.com/support/app-distribution-in-japan/",
        "html",
        {
          quotes: [
            "They cannot download executable code, read outside of the container, or direct users to lower the security on their system or device.",
          ],
        },
      ),
    ],
  },
  {
    row: 14,
    fact: "winget rejects redirected installer URLs (Validation-Indirect-URL) and needs HTTPS, a publisher-domain match and a stable hash",
    sources: [
      src("validation", `${WINGET_RAW}/Validation.md`, "md", {
        quotes: [
          "Installer URLs use HTTPS (not plain HTTP).",
          "The URL does not use a URL shortener or redirect service.",
          "If a redirect is used, the final destination URL is from an approved domain.",
          "Using a redirect URL rather than the final resolved URL.",
          "the hash of the downloaded file is compared against the InstallerSha256 value in the manifest",
        ],
      }),
      src("failure-guide", `${WINGET_RAW}/ValidationFailureGuide.md`, "md", {
        quotes: [
          "The installer URL uses a redirect rather than pointing directly to the publisher's server.",
        ],
      }),
      src("policies", `${WINGET_RAW}/Policies.md`, "md", {
        quotes: [
          "The preference for WinGet manifests is to use unique URLs per version of a package to avoid the hash-mismatch errors.",
        ],
      }),
    ],
  },
  {
    row: 15,
    fact: "Steam: digital unlocks through DLC or the microtransaction API; no third-party payments inside the Steam build",
    sources: [
      src(
        "microtransactions",
        "https://partner.steamgames.com/doc/features/microtransactions",
        "html",
        {
          quotes: [
            "For any in-game purchases, you'll need to use the microtransaction API so Steam customers can only make purchases from the Steam Wallet.",
          ],
        },
      ),
      src(
        "dlc",
        "https://partner.steamgames.com/doc/store/application/dlc",
        "html",
        {
          quotes: [
            "Steam supports both free and paid downloadable content (DLC) that can be registered via CD key or purchased from the Steam store.",
          ],
        },
      ),
    ],
  },
  {
    row: 16,
    fact: "App Store Connect API 4.x (4.5 latest), exactly 12 webhook event types, up to 10 webhooks per app, no webhook for phased release, review submissions or internal TestFlight; Apple-hosted Background Assets 200 GB and 200 packs",
    sources: [
      src(
        "release-notes",
        `${DOCC}/app-store-connect-api-release-notes.json`,
        "docc",
        {
          expect: ({ raw }) => {
            const ids = [
              ...raw.matchAll(
                /app-store-connect-api-(\d+-\d+(?:-\d+)?)-release-notes/g,
              ),
            ].map((m) => m[1]);
            return ids.includes("4-5") &&
              !ids.some((v) => /^4-([6-9]|\d\d)/.test(v) || /^[5-9]-/.test(v))
              ? []
              : [
                  `newer API version listed than 4.5: ${[...new Set(ids)].slice(0, 4).join(", ")}`,
                ];
          },
        },
      ),
      src("webhook-event-type", `${DOCC}/webhookeventtype.json`, "docc", {
        expect: ({ json }) => {
          const values =
            json.primaryContentSections
              .find((s) => s.kind === "possibleValues")
              ?.values.map((v) => v.name) ?? [];
          const failures = [];
          if (values.length !== 12)
            failures.push(
              `WebhookEventType has ${values.length} values, expected 12`,
            );
          for (const banned of [
            "PHASED",
            "REVIEW_SUBMISSION",
            "INTERNAL_BUILD",
          ])
            if (values.some((v) => v.includes(banned)))
              failures.push(`a webhook now covers ${banned}`);
          return failures;
        },
      }),
      src(
        "manage-webhooks",
        "https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks",
        "html",
        {
          quotes: [
            "A webhook can only apply to one app, and you can create up to ten webhooks per app.",
          ],
        },
      ),
      src(
        "asset-pack-limits",
        "https://developer.apple.com/help/app-store-connect/reference/app-uploads/apple-hosted-asset-pack-size-limits",
        "html",
        {
          regexes: [
            [
              /200 GB \| ?Asset pack count|200 GB\s+Asset pack count|200 GB[\s|]+Asset pack count/i,
              "asset pack total limit 200 GB followed by the count row",
            ],
          ],
          quotes: [
            "The total number of asset packs that are allowed to be uploaded to an app record in App Store Connect.",
          ],
        },
      ),
    ],
  },
  {
    row: 17,
    fact: "Play Developer Reporting API: crash-rate and ANR-rate metric sets usable for auto-halt; metric-set and metric names",
    sources: [
      src(
        "discovery",
        "https://playdeveloperreporting.googleapis.com/$discovery/rest?version=v1beta1",
        "json",
        {
          expect: ({ json }) => {
            const failures = [];
            const vitals = json.resources?.vitals?.resources ?? {};
            if (!vitals.crashrate?.methods?.query)
              failures.push("vitals.crashrate.query is gone");
            if (!vitals.anrrate?.methods?.query)
              failures.push("vitals.anrrate.query is gone");
            const crash =
              json.schemas
                ?.GooglePlayDeveloperReportingV1beta1CrashRateMetricSet
                ?.description ?? "";
            const anr =
              json.schemas?.GooglePlayDeveloperReportingV1beta1AnrRateMetricSet
                ?.description ?? "";
            for (const m of [
              "crashRate",
              "crashRate7dUserWeighted",
              "userPerceivedCrashRate",
              "distinctUsers",
              "versionCode",
            ])
              if (!crash.includes("`" + m + "`"))
                failures.push(`crash metric set lost ${m}`);
            for (const m of [
              "anrRate",
              "anrRate7dUserWeighted",
              "userPerceivedAnrRate",
              "distinctUsers",
              "versionCode",
            ])
              if (!anr.includes("`" + m + "`"))
                failures.push(`anr metric set lost ${m}`);
            if (
              !json.auth?.oauth2?.scopes?.[
                "https://www.googleapis.com/auth/playdeveloperreporting"
              ]
            )
              failures.push("scope playdeveloperreporting is gone");
            return failures;
          },
          date: /"revision":\s*"(\d{8})"/,
        },
      ),
    ],
  },
  {
    row: 18,
    fact: "Microsoft Store submission API for MSIX apps: submission status values, packageRollout fields, flight endpoints",
    sources: [
      src(
        "manage-app-submissions",
        `${MS_API}/manage-app-submissions`,
        "html",
        {
          date: /<meta name="updated_at" content="([^"]*)"/,
          quotes: [
            "Before you can use these methods, the app must already exist in your Partner Center account and you must first create one submission for the app in Partner Center.",
            "PackageRolloutNotStarted PackageRolloutInProgress PackageRolloutComplete PackageRolloutStopped",
            "/haltpackagerollout",
            "/finalizepackagerollout",
            "/updatepackagerolloutpercentage",
            "This value should change from CommitStarted to either PreProcessing if the request succeeds or to CommitFailed if there are errors in the request.",
          ],
          regexes: [
            [
              /None\s+Canceled\s+PendingCommit\s+CommitStarted\s+CommitFailed\s+PendingPublication\s+Publishing\s+Published\s+PublishFailed\s+PreProcessing\s+PreProcessingFailed\s+Certification\s+CertificationFailed\s+Release\s+ReleaseFailed/,
              "the 15 submission status values, in order",
            ],
          ],
        },
      ),
      src("flights", `${MS_API}/manage-flights`, "html", {
        date: /<meta name="updated_at" content="([^"]*)"/,
        quotes: [
          "These methods can only be used to get, create, or delete package flights.",
        ],
      }),
      src("flight-submissions", `${MS_API}/manage-flight-submissions`, "html", {
        date: /<meta name="updated_at" content="([^"]*)"/,
        quotes: [
          "/flights/{flightId}/submissions/{submissionId}/haltpackagerollout",
        ],
      }),
      src(
        "overview",
        `${MS_API}/create-and-manage-submissions-using-windows-store-services`,
        "html",
        {
          date: /<meta name="updated_at" content="([^"]*)"/,
          quotes: [
            "This API cannot be used with apps or add-ons that use mandatory app updates and Store-managed consumable add-ons.",
            "You cannot use the Microsoft Store submission API to create an app in Partner Center",
          ],
        },
      ),
    ],
  },
];

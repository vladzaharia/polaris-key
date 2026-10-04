// Summarise Apple's App Store Connect OpenAPI document for S-14: the methods each relevant path
// supports, the attributes each write body accepts, and the enums the design depends on.
//
//   curl -sSLo spec/spec.zip https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip
//   (cd spec && unzip -o spec.zip)
//   node scan-spec.mjs spec/openapi.oas.json
import { readFileSync } from "node:fs";

const s = JSON.parse(
  readFileSync(process.argv[2] ?? "spec/openapi.oas.json", "utf8"),
);
const C = s.components.schemas;
console.log(
  `# ${s.info.title} ${s.info.version}: ${Object.keys(s.paths).length} paths\n`,
);

const RESOURCES =
  /^\/v[12]\/(apps|bundleIds|bundleIdCapabilities|certificates|profiles|devices|users|userInvitations|betaGroups|betaTesters|builds|buildUploads|betaAppReviewSubmissions|betaBuildLocalizations|appStoreVersions|appStoreVersionLocalizations|appStoreVersionPhasedReleases|appStoreVersionReleaseRequests|reviewSubmissions|reviewSubmissionItems|inAppPurchases|inAppPurchaseVersions|inAppPurchaseLocalizations|inAppPurchasePriceSchedules|inAppPurchaseSubmissions|inAppPurchaseAvailabilities|subscriptionGroups|subscriptions|webhooks|backgroundAssets|backgroundAssetVersions|appAvailabilities|appPriceSchedules|merchantIds|passTypeIds)(\/\{id\})?$/;
const METHODS = ["get", "post", "patch", "delete"];
console.log("## Methods per path\n");
for (const [p, ops] of Object.entries(s.paths))
  if (RESOURCES.test(p))
    console.log(`${p.padEnd(48)} ${METHODS.filter((m) => ops[m]).join(",")}`);

console.log("\n## Write bodies (attributes; relationships)\n");
for (const n of Object.keys(C)
  .filter((k) => /(Create|Update)Request$/.test(k))
  .sort()) {
  if (
    !/^(App|BundleId|BundleIdCapability|Certificate|Profile|BetaGroup|BetaTester|Build|BetaAppReviewSubmission|BetaBuildLocalization|AppStoreVersion|AppStoreVersionLocalization|AppStoreVersionPhasedRelease|ReviewSubmission|ReviewSubmissionItem|InAppPurchaseV2|InAppPurchaseVersion|InAppPurchaseLocalizationV2|InAppPurchasePriceSchedule|SubscriptionGroup|Subscription|Webhook|User|UserInvitation)(Create|Update)Request$/.test(
      n,
    )
  )
    continue;
  const d = C[n].properties.data.properties;
  const a = Object.keys(d.attributes?.properties ?? {});
  const r = Object.keys(d.relationships?.properties ?? {});
  console.log(`${n}: [${a.join(", ")}]; rel [${r.join(", ")}]`);
}

console.log("\n## Enums\n");
for (const n of [
  "CapabilityType",
  "CertificateType",
  "BundleIdPlatform",
  "InAppPurchaseType",
  "PhasedReleaseState",
  "WebhookEventType",
  "SubscriptionStatusUrlVersion",
  "UserRole",
  "AppStoreVersionState",
])
  console.log(`${n}: ${(C[n]?.enum ?? ["(missing)"]).join(", ")}`);

// `cases.json`: every signed family in its committed order, then the §4.9 self-checks over the
// assembled corpus. The record vectors are built first, because every feed pins one by its hash.

import { buildBundleCases } from "./bundle.js";
import { buildConfigDocCases, buildLicenseDocCases } from "./claims.js";
import { buildClockFloorCasesV2 } from "./clock.js";
import { type AnyCase, KEYS } from "./common.js";
import { buildFeedContentCases } from "./content.js";
import { buildDelegationCases } from "./delegation.js";
import { buildFeedCases } from "./feed.js";
import { buildJwsCases } from "./jws.js";
import { buildLicenseUserCases } from "./license-user.js";
import {
  buildMarkerCases,
  buildPackRecordCases,
  checkPackClaimCases,
} from "./packs.js";
import { buildReleaseRecordCases } from "./record.js";
import { buildRecords } from "./release-records.js";
import { buildRevocationCases } from "./revocation.js";
import { checkCorpusV4 } from "./self-check.js";
import { buildTrustCasesV2 } from "./trust.js";

export async function buildV2(): Promise<unknown> {
  // Wire contract v4: the record vectors first, because every feed pins one by its hash.
  const records = await buildRecords();
  const corpus = {
    corpusVersion: 2,
    keys: KEYS,
    jwsCases: await buildJwsCases(),
    licenseDocCases: await buildLicenseDocCases(),
    configDocCases: await buildConfigDocCases(),
    trustCases: await buildTrustCasesV2(),
    clockFloorCases: await buildClockFloorCasesV2(),
    bundleCases: await buildBundleCases(),
    feedCases: await buildFeedCases(),
    // plans/P4-13.md §4.1: the feed's content members, parsed beside the claims.
    feedContentCases: await buildFeedContentCases(),
    releaseRecordCases: await buildReleaseRecordCases(records),
    // plans/P4-13.md §4.1: `kind: revocation` records against a feed entry.
    revocationCases: await buildRevocationCases(),
    // plans/P4-01.md §4.6 (P4-21): two new JWS families after the record cases.
    packRecordCases: await buildPackRecordCases(),
    markerCases: await buildMarkerCases(),
    // plans/P4-19.md §4.1: content-key delegation.
    delegationCases: await buildDelegationCases(),
    // plans/SP-54.md §4: the signed-in subject, read beside the claims; the last section.
    licenseUserCases: await buildLicenseUserCases(),
  };
  checkCorpusV4(corpus as unknown as Record<string, AnyCase[]>);
  checkPackClaimCases(corpus as unknown as Record<string, AnyCase[]>);
  return corpus;
}

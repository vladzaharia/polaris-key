// `cases.json#/clockFloorCases`: the monotonic clock floor over three artifact kinds (§4.2).

import {
  ALT_KID,
  AUD_V3,
  configDoc,
  DEVICE_V3,
  keyEntry,
  licenseDoc,
  PIN_KID,
  PINNED_V3,
  pub,
  signAs,
  trustManifestV3,
  V3_ISSUED,
} from "./common.js";

// ── §4.2 monotonic clock floor, over THREE artifact kinds ────────────────────
//
//     highWaterMark = max(licenseDoc.issuedAt, configDoc.issuedAt, trustManifest.issuedAt)
//     effectiveNow  = max(systemClock, highWaterMark)
//
// v2's floor rode the config fetch and was derived from the document alone, which is
// provably inert: `doc.issuedAt < doc.graceUntil` by construction, so it can never reach the
// end of grace. v3 folds all three artifacts and makes trust refresh Core-owned, on its own
// schedule, so the floor advances even while both documents sit behind stable ETags.
//
// Each case is the cache-RELOAD path replayed as pure data. Runners perform exactly:
//
//   1. trust := pinned
//   2. verify trustJws against PINS with checkFreshness=false
//        accepted ⇒ trust := mergeTrust(pinned, discovered); floor := max(floor, issuedAt)
//   3. verify licenseJws / configJws against `trust` with checkFreshness=false
//        accepted ⇒ floor := max(floor, issuedAt)
//   4. effectiveNow := max(systemClock, floor)
//   5. status := licenseState({licenseServiceEnabled: true, activation: "token",
//                              doc: licenseDoc, now: systemClock, highWaterMark: floor})

interface ClockFloorCaseV2 {
  id: string;
  description: string;
  pinned: Record<string, string>;
  trustJws?: string;
  licenseJws?: string;
  configJws?: string;
  expectedAud: string;
  deviceId: string;
  /** What the device's own clock claims — the value an attacker controls. */
  systemClock: number;
  expect: { highWaterMark: number; effectiveNow: number; status: string };
}

export async function buildClockFloorCasesV2(): Promise<ClockFloorCaseV2[]> {
  const DAY = 86400;
  /** A manifest refreshed 399 days later — "I verified a manifest yesterday". */
  const MANIFEST_LATER = V3_ISSUED + 399 * DAY;
  /** A manifest older than the documents, so it cannot be what raises the floor. */
  const MANIFEST_EARLIER = V3_ISSUED - 3600;
  /** A manifest refreshed a week in — between the two documents, so it is the MIDDLE value
   *  of the three and cannot be mistaken for the max. */
  const MANIFEST_MIDDLE = V3_ISSUED + 7 * DAY;
  /** A config document that kept refreshing for 399 days while the license document did
   *  not. The two services fetch independently in v3 (separate ETags, separate cadence),
   *  so this is the ordinary shape of a config-enabled product, not a contrivance. */
  const CONFIG_LATEST = V3_ISSUED + 399 * DAY;
  /** `sudo date`: wound back inside the license document's one-hour window. */
  const ROLLED_BACK = V3_ISSUED + 60;
  /** An honest clock, long past the whole signed grace window. */
  const HONEST_LATE = V3_ISSUED + 400 * DAY;

  const manifest = (
    issuedAt: number,
    keys: Record<string, unknown>[],
    signWith = PIN_KID,
  ): Promise<string> =>
    signAs(trustManifestV3({ issuedAt, keys }), signWith, "pkey-trust+jws");
  const license = (signWith = PIN_KID): Promise<string> =>
    signAs(licenseDoc(), signWith, "pkey-license+jws");
  const config = (issuedAt = V3_ISSUED): Promise<string> =>
    signAs(
      configDoc({
        issuedAt,
        expiresAt: issuedAt + 3600,
        graceUntil: issuedAt + 30 * DAY,
      }),
      PIN_KID,
      "pkey-config+jws",
    );
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
  };

  return [
    {
      ...common,
      id: "floor-config-doc-alone-does-not-stop-rollback",
      description:
        "The residual R4-04 defect, carried from corpus v1 and pinned so it cannot return: with DOCUMENTS as the only floor source the mark equals their `issuedAt`, which is below `graceUntil` by construction, and a clock wound back inside the license window still reads `ok`. v3 gives the client a second document and it changes nothing — both are stamped by the same fetch. Only the independently-refreshed trust manifest makes the floor bite (§4.2).",
      licenseJws: await license(),
      configJws: await config(),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-trust-manifest-defeats-rollback",
      description:
        "The fix. The same wound-back clock and the same document, plus a trust manifest the client verified 399 days later: `highWaterMark` is now past `graceUntil`, so the gate reads `expired` — a client that verified a manifest yesterday cannot claim it is last year (§4.2).",
      licenseJws: await license(),
      trustJws: await manifest(MANIFEST_LATER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-stale-cached-manifest-still-yields-its-keys",
      description:
        "Raising the floor from a cached manifest must NOT re-introduce freshness checking on that path. This manifest expired long ago and publishes the rotated key the cached license document is signed with: it must still load, or every restart after a key rotation strands the client. Its `issuedAt` predates the document's, so the document sets the mark.",
      licenseJws: await license(ALT_KID),
      trustJws: await manifest(MANIFEST_EARLIER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-honest-clock-is-never-lowered",
      description:
        "The floor is a MINIMUM, never a substitute. With an honest clock long past the whole signed grace window `effectiveNow` is the system clock and the gate reads `expired` — the floor costs nothing when the clock is truthful.",
      licenseJws: await license(),
      trustJws: await manifest(MANIFEST_EARLIER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: HONEST_LATE,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: HONEST_LATE,
        status: "expired",
      },
    },
    {
      ...common,
      id: "floor-rejected-manifest-does-not-raise-it",
      description:
        "Only RE-VERIFIED content moves the mark. This manifest carries a far later `issuedAt` but is signed by a discovered key rather than a pinned one, so it is refused outright — and a refused artifact must contribute nothing, or planting a file would become a way to force every client to `expired`.",
      licenseJws: await license(),
      trustJws: await manifest(
        MANIFEST_LATER,
        [keyEntry(ALT_KID, pub(ALT_KID), "active")],
        ALT_KID,
      ),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: V3_ISSUED,
        effectiveNow: ROLLED_BACK,
        status: "ok",
      },
    },
    {
      ...common,
      id: "floor-manifest-without-a-document",
      description:
        "A manifest alone still anchors time. There is no license document, so the gate is `needs-activation` either way — but the mark it establishes survives, which is what stops a wound-back clock from later re-admitting a document that has already aged out.",
      trustJws: await manifest(MANIFEST_LATER, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: MANIFEST_LATER,
        effectiveNow: MANIFEST_LATER,
        status: "needs-activation",
      },
    },
    {
      ...common,
      id: "floor-max-over-three-artifacts",
      description:
        "NEW in v3: three artifacts with three DIFFERENT `issuedAt` values — license (day 0), trust manifest (day 7), CONFIG document (day 399) — and the mark is the MAX over all of them. Here the max is the config document, which no other case makes load-bearing: an implementation that folds documents-plus-manifest but forgets that v3 has TWO documents reads day 7, lands inside the license document's 30-day grace, and reports `grace` instead of `expired`. The config service is the one still refreshing while the license document sits behind a 403 or a stable ETag, so it is exactly the source most likely to be dropped (§4.2).",
      licenseJws: await license(),
      configJws: await config(CONFIG_LATEST),
      trustJws: await manifest(MANIFEST_MIDDLE, [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
      ]),
      systemClock: ROLLED_BACK,
      expect: {
        highWaterMark: CONFIG_LATEST,
        effectiveNow: CONFIG_LATEST,
        status: "expired",
      },
    },
  ];
}

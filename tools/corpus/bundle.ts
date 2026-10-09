// `cases.json#/bundleCases`: offline activation bundles (§7), the v4 bundle claim cases, and
// V4 §7's per-type floors, reload profile and tombstoned pins.

import { signJws } from "@polaris-key/jws";
import {
  ALT_KID,
  AUD_V3,
  configDoc,
  DEVICE_V3,
  docOfExactBytes,
  encSeg,
  FOREIGN_PUB,
  keyEntry,
  licenseDoc,
  MAX_BUNDLE_BYTES,
  pem,
  PIN_KID,
  PINNED_V3,
  pub,
  raw,
  rawJson,
  signAs,
  signText,
  SKEW,
  trustManifestV3,
  V3_ISSUED,
  V3_NOW,
} from "./common.js";
import {
  BIG_OVER,
  placeNonWire,
  withNonWire,
  type WithNonWire,
} from "./nonwire.js";
import { refBundleOutcome } from "./reference/trust.js";

// ── §7 offline activation bundles ────────────────────────────────────────────
// Every case is a complete, signed `pkey-bundle+jws` plus the outcome of running §7's
// NUMBERED validation order against it. The order is the contract, so the expected `reason`
// names the step that must reject — a verifier that checks inner documents before the bundle's
// own device binding fails `bundle-deviceId-mismatches-local` on the reason even though it
// also refuses the bundle.
//
// Import is ALL-OR-NOTHING: `bundle-tampered-inner-license-signature` carries a perfectly
// good config document, and it must not land either.

/** The step that refused, mapping 1:1 onto §7's numbered list. */
type BundleReason =
  | "bundle-jws-rejected" // 1 — signature, pins-only trust, `typ`, or the 262 144 cap
  | "bundle-claims-rejected" // 2 — aud, deviceId, or the import window
  | "bundle-trust-rejected" // 3 — the inner trust manifest
  | "inner-doc-rejected"; // 4 — any inner document

interface BundleCase {
  id: string;
  description: string;
  bundleJws: string;
  /** Bundles verify against PINNED keys only (§7.1) — never the effective set. */
  pinned: Record<string, string>;
  /** V4 §4.1: the `pinRevocations` evidence held (kid → the revoking manifest). Absent: none.
   *  The tombstones it proves leave the usable pins for the bundle and its manifest. */
  pinRevocations?: Record<string, string>;
  expectedAud: string;
  /** The importing device's LOCAL id. */
  deviceId: string;
  now: number;
  /** V4 §7 step 4: the `issuedAt` of the verified cached document of each type, or null.
   *  Absent: both null. */
  floors?: { license: number | null; config: number | null };
  /** V4 §7: `import` (absent) or `reload` (step 2 without the import window). */
  profile?: "import" | "reload";
  /** §1 — the raised cap the bundle verifier must pass at step 1. */
  maxPayloadBytes: number;
  expect:
    | { imports: false; reason: BundleReason }
    | { imports: true; docs: string[] };
}

export async function buildBundleCases(): Promise<BundleCase[]> {
  const DAY = 86400;
  /** The bundle's own import window: minted at day 0, importable for 30 days (§7). */
  const BUNDLE_EXPIRES = V3_ISSUED + 30 * DAY;
  const NOW = V3_NOW;

  const innerTrust = await signAs(
    trustManifestV3({
      keys: [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ],
    }),
    PIN_KID,
    "pkey-trust+jws",
  );
  const innerLicense = await signAs(licenseDoc(), PIN_KID, "pkey-license+jws");
  // Signed by the ROTATED key, which only the inner manifest publishes: step 4 must verify
  // inner documents against the effective set built in step 3, not against the pins.
  const innerConfig = await signAs(configDoc(), ALT_KID, "pkey-config+jws");

  const bundle = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    bundleId: "01JBUNDLE0000000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: BUNDLE_EXPIRES,
    docs: { license: innerLicense, config: innerConfig },
    trust: innerTrust,
    ...over,
  });
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
    now: NOW,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  };
  const sign = (payload: unknown): Promise<string> =>
    signAs(payload, PIN_KID, "pkey-bundle+jws");

  // A tampered inner document: the original header and signature over a mutated payload.
  const [ih, , is] = innerLicense.split(".") as [string, string, string];
  const tamperedInnerLicense = `${ih}.${encSeg(licenseDoc({ entitlements: { "license.tier": { state: "enforced", value: "enterprise", updatedAt: 1699990000 } } }))}.${is}`;

  const all: BundleCase[] = [
    {
      ...common,
      id: "bundle-valid-full",
      description:
        "The control: a bundle carrying a license document, a config document and the trust manifest. All three verify and BOTH documents import. The config document is signed by the rotated key that only the inner manifest publishes, so this also proves step 4 runs against the set built in step 3.",
      bundleJws: await sign(bundle()),
      expect: { imports: true, docs: ["license", "config"] },
    },
    {
      ...common,
      id: "bundle-valid-license-only",
      description:
        "`docs.config` is optional (§7): a license-only bundle imports exactly one document. A verifier that requires both fails here.",
      bundleJws: await sign(bundle({ docs: { license: innerLicense } })),
      expect: { imports: true, docs: ["license"] },
    },
    {
      ...common,
      id: "bundle-tampered-inner-license-signature",
      description:
        "The inner license document's payload was mutated after signing (an upgraded tier), keeping the original signature. Step 4 refuses it — and because import is ALL-OR-NOTHING, the untouched config document in the same bundle must not land either.",
      bundleJws: await sign(
        bundle({
          docs: { license: tamperedInnerLicense, config: innerConfig },
        }),
      ),
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-inner-deviceId-mismatches-bundle",
      description:
        "The bundle is addressed to this device, but the license document inside it is bound to another. Inner documents are verified against the LOCAL device id, not against the bundle's own claim, so a mint-side mix-up cannot smuggle a foreign license onto this machine (§3, §7.4).",
      bundleJws: await sign(
        bundle({
          docs: {
            license: await signAs(
              licenseDoc({ deviceId: "dev_someone_else" }),
              PIN_KID,
              "pkey-license+jws",
            ),
          },
        }),
      ),
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-deviceId-mismatches-local",
      description:
        "A bundle minted for a DIFFERENT device, presented here — the request-code flow's whole point is that a bundle is device-bound. Rejected at step 2, before the trust manifest or any inner document is even looked at.",
      bundleJws: await sign(bundle({ deviceId: "dev_not_this_machine" })),
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-expired",
      description:
        "The import window closed: `now > expiresAt + CLOCK_SKEW`. The BUNDLE itself is checked with NETWORK-path freshness (§7.2) even though its inner documents use the reload profile — a stale bundle is refused, while the long-lived documents it carries are not.",
      bundleJws: await sign(bundle()),
      now: BUNDLE_EXPIRES + SKEW + 1,
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-inner-trust-pinned-substitution",
      description:
        "The inner trust manifest presents the PINNED kid with foreign key bytes. §7.3 verifies it against the pins with the same substitution rule as the network path, so the bundle imports nothing — an air-gapped device must not be the one place where a planted key set is accepted.",
      bundleJws: await sign(
        bundle({
          trust: await signAs(
            trustManifestV3({
              keys: [keyEntry(PIN_KID, FOREIGN_PUB, "active")],
            }),
            PIN_KID,
            "pkey-trust+jws",
          ),
        }),
      ),
      expect: { imports: false, reason: "bundle-trust-rejected" },
    },
    {
      ...common,
      id: "bundle-typ-missing",
      description:
        "A correctly-signed bundle with no `typ` in its header. §7.1 demands `pkey-bundle+jws`; without the type check the same bytes could be replayed at a document call site with the raised 262 144 cap in force.",
      bundleJws: await signJws(bundle(), pem(PIN_KID), PIN_KID),
      expect: { imports: false, reason: "bundle-jws-rejected" },
    },
    {
      ...common,
      id: "bundle-over-cap",
      description:
        "A correctly-signed bundle padded one decoded byte past the 262 144 cap (§1). Refused at step 1 on size, after the signature and before anything is imported — the bundle cap is generous, not absent.",
      bundleJws: await sign(docOfExactBytes(MAX_BUNDLE_BYTES + 1, bundle())),
      expect: { imports: false, reason: "bundle-jws-rejected" },
    },
    // Wire contract v4 §3: the bundle claim cases, after the family's last case.
    ...(await buildBundleCasesV4()).map(placeNonWire),
    // V4 §7: floors, the reload profile and tombstoned pins, after the claim cases.
    ...(await buildBundleCustodyCases()),
  ];
  // Recompute every outcome with the reference (V4 §7's order, both profiles, floors).
  for (const c of all) {
    const want = refBundleOutcome(c);
    if (JSON.stringify(want) !== JSON.stringify(c.expect))
      throw new Error(
        `bundleCases: the reference disagrees on ${c.id}: ${JSON.stringify(want)}`,
      );
  }
  return all;
}

async function buildBundleCasesV4(): Promise<WithNonWire<BundleCase>[]> {
  const DAY = 86400;
  const innerTrust = await signAs(
    trustManifestV3({
      keys: [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ],
    }),
    PIN_KID,
    "pkey-trust+jws",
  );
  const innerLicense = await signAs(licenseDoc(), PIN_KID, "pkey-license+jws");
  const innerConfig = await signAs(configDoc(), ALT_KID, "pkey-config+jws");
  const bundle = (over: Record<string, unknown>): Record<string, unknown> => ({
    bundleId: "01JBUNDLE0000000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: V3_ISSUED + 30 * DAY,
    docs: { license: innerLicense, config: innerConfig },
    trust: innerTrust,
    ...over,
  });
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  };
  const mk = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
    now = V3_NOW,
  ): Promise<WithNonWire<BundleCase>> => {
    const jws = await signText(
      rawJson(bundle(over)),
      PIN_KID,
      "pkey-bundle+jws",
    );
    return withNonWire(
      {
        ...common,
        now,
        id,
        description,
        bundleJws: jws,
        expect: { imports: false, reason: "bundle-claims-rejected" },
      } as BundleCase,
      jws,
    );
  };
  return [
    await mk(
      "bundle-issued-at-near-integer",
      "V4 §3: the bundle's `issuedAt` token `1700000000.00000001`.",
      { issuedAt: raw("1700000000.00000001") },
    ),
    await mk(
      "bundle-expires-at-near-integer",
      "V4 §3: the bundle's `expiresAt` token `1702592000.00000001`.",
      { expiresAt: raw("1702592000.00000001") },
    ),
    await mk(
      "bundle-issued-at-over-max",
      "V4 §3: only the bundle's `issuedAt` (9007199254740993) is above 2^53 − 1 at this `now`.",
      { issuedAt: raw(BIG_OVER), expiresAt: 9007199254740950 },
      9007199254740900,
    ),
    await mk(
      "bundle-expires-at-over-max",
      "V4 §3: the bundle's `expiresAt` 9007199254740993.",
      { expiresAt: raw(BIG_OVER) },
    ),
    await mk(
      "bundle-docs-license-null",
      "V4 §3 presence: `docs: {license: null, config: …}`. Python and Swift read the null as absent and imported the config; every bundle member failure is `bundle-claims-rejected`.",
      { docs: { license: null, config: innerConfig } },
    ),
    await mk(
      "bundle-trust-not-string",
      "`trust: 5`. Swift decoded the bundle inside its signature step and answered `bundle-jws-rejected`; the member check is step 2 everywhere.",
      { trust: 5 },
    ),
    await mk(
      "bundle-issued-at-negative",
      "V4 §3 minimums: the bundle's `issuedAt` −1.",
      { issuedAt: -1 },
    ),
  ];
}

// ── V4 §7: per-type floors, the reload profile, tombstoned pins ──────────────────────────────

async function buildBundleCustodyCases(): Promise<BundleCase[]> {
  const DAY = 86400;
  const BUNDLE_EXPIRES = V3_ISSUED + 30 * DAY;
  const innerTrust = await signAs(
    trustManifestV3({
      keys: [
        keyEntry(PIN_KID, pub(PIN_KID), "active"),
        keyEntry(ALT_KID, pub(ALT_KID), "staged"),
      ],
    }),
    PIN_KID,
    "pkey-trust+jws",
  );
  const innerLicense = await signAs(licenseDoc(), PIN_KID, "pkey-license+jws");
  const innerConfig = await signAs(configDoc(), ALT_KID, "pkey-config+jws");
  const bundle = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    bundleId: "01JBUNDLE0000000000000001",
    aud: AUD_V3,
    deviceId: DEVICE_V3,
    issuedAt: V3_ISSUED,
    expiresAt: BUNDLE_EXPIRES,
    docs: { license: innerLicense, config: innerConfig },
    trust: innerTrust,
    ...over,
  });
  const common = {
    pinned: PINNED_V3,
    expectedAud: AUD_V3,
    deviceId: DEVICE_V3,
    now: V3_NOW,
    maxPayloadBytes: MAX_BUNDLE_BYTES,
  };
  const sign = (payload: unknown, kid = PIN_KID): Promise<string> =>
    signAs(payload, kid, "pkey-bundle+jws");
  const both: BundleCase["expect"] = {
    imports: true,
    docs: ["license", "config"],
  };
  // The inner documents are both issued at V3_ISSUED.
  return [
    {
      ...common,
      id: "bundle-floor-license-not-newer",
      description:
        "V4 §7 step 4: the device already holds a verified licence document issued at the same second as the bundle's. Each inner document must be STRICTLY newer than the cached one of its type, so the import is `inner-doc-rejected` and nothing lands: an old bundle cannot roll a device back.",
      bundleJws: await sign(bundle()),
      floors: { license: V3_ISSUED, config: null },
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-floor-config-not-newer",
      description:
        "V4 §7 step 4: the config floor alone. The licence document is newer than nothing; the config document is not newer than the cached one, so the whole import is refused.",
      bundleJws: await sign(bundle()),
      floors: { license: null, config: V3_ISSUED + 60 },
      expect: { imports: false, reason: "inner-doc-rejected" },
    },
    {
      ...common,
      id: "bundle-floor-newer-imports",
      description:
        "V4 §7 step 4, the control: both inner documents are one second newer than the cached ones, so both import.",
      bundleJws: await sign(bundle()),
      floors: { license: V3_ISSUED - 1, config: V3_ISSUED - 1 },
      expect: both,
    },
    {
      ...common,
      id: "bundle-reload-past-import-window",
      description:
        "V4 §7 reload profile: the cached bundle re-verified at start, long after its 30-day import window closed. The reload profile is steps 1–3 without step 2's two import-window comparisons, so it still verifies; the import profile refuses the same bytes (`bundle-expired`).",
      bundleJws: await sign(bundle()),
      now: BUNDLE_EXPIRES + SKEW + 200 * DAY,
      profile: "reload",
      expect: both,
    },
    {
      ...common,
      id: "bundle-reload-wrong-device",
      description:
        "V4 §7 reload profile, the control: everything in step 2 but the window still binds. A cached bundle minted for another device does not reload.",
      bundleJws: await sign(bundle({ deviceId: "dev_not_this_machine" })),
      profile: "reload",
      expect: { imports: false, reason: "bundle-claims-rejected" },
    },
    {
      ...common,
      id: "bundle-reload-issued-in-future",
      description:
        "V4 §7 reload profile: a bundle whose `issuedAt` is a day past the device clock. The import profile refuses it (`issuedAt > now + skew`); the reload profile has no window, so it reloads. A wound-back clock cannot strand a bundle-activated install.",
      bundleJws: await sign(
        bundle({
          issuedAt: V3_NOW + DAY,
          expiresAt: V3_NOW + DAY + 30 * DAY,
        }),
      ),
      profile: "reload",
      expect: both,
    },
    {
      ...common,
      id: "bundle-signed-by-tombstoned-pin-refused",
      description:
        "V4 §1 tombstone rule 3: the device holds evidence (`pinRevocations`) that ALT revoked PIN. PIN is no longer a usable pin for anything, so a bundle it signed is refused at step 1, however well-formed.",
      pinned: { [PIN_KID]: pub(PIN_KID), [ALT_KID]: pub(ALT_KID) },
      pinRevocations: {
        [PIN_KID]: await signAs(
          trustManifestV3({
            issuedAt: V3_ISSUED - 1000,
            keys: [
              keyEntry(PIN_KID, pub(PIN_KID), "revoked"),
              keyEntry(ALT_KID, pub(ALT_KID), "active"),
            ],
          }),
          ALT_KID,
          "pkey-trust+jws",
        ),
      },
      bundleJws: await sign(bundle()),
      expect: { imports: false, reason: "bundle-jws-rejected" },
    },
  ];
}

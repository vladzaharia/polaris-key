/**
 * The Cloud Sync minimum SDK builds (SYNC-MINSDK, lead decision D-39b): one platform setting per
 * SDK, a plain semver such as `0.10.0`. Unset (the default) gates nothing. The key ring routes
 * refuse a build below its SDK's minimum with `403 version_blocked` (`core/keyring/minSdk.ts`).
 * Own file for the same reason as `launchGates.ts`: platform.ts stays small.
 */

import { setting } from "./define.js";
import type { SettingDef } from "./types.js";

/** The `X-PKey-SDK` ids a minimum can name (`conformance/parity/enums.json` `sdkId`, client kinds). */
export const MIN_SDK_IDS = [
  "swift",
  "kotlin",
  "godot",
  "react",
  "node",
  "python",
] as const;
export type MinSdkId = (typeof MIN_SDK_IDS)[number];

export const minSdkKey = (sdk: MinSdkId) => `cloudSync.minSdk.${sdk}` as const;

const NAMES: Record<MinSdkId, string> = {
  swift: "Swift",
  kotlin: "Kotlin",
  godot: "Godot",
  react: "React and browser",
  node: "Node",
  python: "Python",
};

export const MIN_SDK_SETTINGS: readonly SettingDef[] = MIN_SDK_IDS.map((sdk) =>
  setting({
    key: minSdkKey(sdk),
    scope: "platform",
    service: "platform",
    area: "cloudSync",
    label: `Cloud Sync minimum ${NAMES[sdk]} SDK`,
    description: `The oldest ${NAMES[sdk]} SDK version allowed to use the end-to-end key ring routes, as a release version such as 0.10.0. An older build is told to update the app (version_blocked). Unset gates nothing; placeholder builds (0.0.0, 0.1.0, 0.2.0) and requests without SDK headers always pass.`,
    keywords: [
      "cloud sync",
      "minimum version",
      "update the app",
      "version_blocked",
    ],
    docs: "/docs/features/cloud-sync/",
    value: {
      kind: "string",
      pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
      maxLength: 32,
    },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L1" },
    readers: ["core/keyring/minSdk.ts"],
    storage: { kind: "scalar" },
  }),
);

/**
 * The launch gates (LG-1): one platform switch per v0.10.0 feature, default off and fail closed.
 * A gate turns on in production only after its feature's security sign-off (docs/RUNBOOK.md).
 * Part of the platform slice (`PLATFORM_SLICE` spreads it); its own file keeps platform.ts small.
 */

import { setting } from "./define.js";
import type { SettingDef } from "./types.js";

const PLATFORM_DOCS = "/docs/operate/platform/settings/";

export const LAUNCH_GATES: readonly SettingDef[] = [
  // One switch per v0.10.0 feature. Each is OFF until the feature's wave and its security
  // sign-off are complete; an off gate answers as the build did before the feature existed.
  // `ceiling` kill switches: a `[vars]` value of `off` is a hard off, and an unreadable store
  // reads off (fail closed). Turning one on in production is a THREAT-MODEL §9 review trigger.
  setting({
    key: "launch.identityExchange",
    aliases: ["LAUNCH_IDENTITY_EXCHANGE"],
    scope: "platform",
    service: "platform",
    area: "launch",
    label: "Launch gate: native token exchange",
    description:
      "Serves the RFC 8693 token exchange on the identity token route, the exchange nonce route, the link offer routes and the discovery members that name them. Off answers unsupported_grant_type and not_found, as before the exchange existed. Registering a device key (PUT /devices/keys) is Core and is not behind this gate.",
    keywords: ["launch", "token exchange", "native sign-in", "rollout"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAUNCH_IDENTITY_EXCHANGE",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: [
      "services/identity/passthrough/token.ts",
      "services/identity/passthrough/nonce.ts",
      "services/identity/passthrough/link.ts",
      "services/identity/index.ts",
    ],
    storage: { kind: "scalar", storedAs: "LAUNCH_IDENTITY_EXCHANGE" },
  }),
  setting({
    key: "launch.connect",
    aliases: ["LAUNCH_CONNECT"],
    scope: "platform",
    service: "platform",
    area: "launch",
    label: "Launch gate: Cloud Connect",
    description:
      "Serves the Cloud Connect identity and devices routes. Off answers not_found and discovery reports Cloud Connect as off.",
    keywords: ["launch", "cloud connect", "direct transfer", "rollout"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAUNCH_CONNECT",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: ["services/connect/index.ts"],
    storage: { kind: "scalar", storedAs: "LAUNCH_CONNECT" },
  }),
  setting({
    key: "launch.syncE2e",
    aliases: ["LAUNCH_SYNC_E2E"],
    scope: "platform",
    service: "platform",
    area: "launch",
    label: "Launch gate: end-to-end sync key ring",
    description:
      "Serves the key ring routes that end-to-end encrypted Cloud Sync needs. Off answers not_found.",
    keywords: ["launch", "key ring", "end-to-end", "cloud sync", "rollout"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAUNCH_SYNC_E2E",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: ["core/keyring/routes.ts"],
    storage: { kind: "scalar", storedAs: "LAUNCH_SYNC_E2E" },
  }),
  setting({
    key: "launch.relay",
    aliases: ["LAUNCH_RELAY"],
    scope: "platform",
    service: "platform",
    area: "launch",
    label: "Launch gate: Cloud Connect relay",
    description:
      "Serves the Cloud Connect relay routes and its rooms. Off answers not_found, and an open room closes at its next minute.",
    keywords: ["launch", "relay", "cloud connect", "rollout"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAUNCH_RELAY",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    // The room checks it on every upgrade and every alarm; CC-07.3's routes gate with it too.
    readers: ["services/connect/do/relayDo.ts"],
    storage: { kind: "scalar", storedAs: "LAUNCH_RELAY" },
  }),
  setting({
    key: "launch.identityNearby",
    aliases: ["LAUNCH_IDENTITY_NEARBY"],
    scope: "platform",
    service: "platform",
    area: "launch",
    label: "Launch gate: nearby approval",
    description:
      "Serves the three nearby approval routes (start, approve, poll) and the discovery members that name them. Off answers not_found, as before nearby approval existed. A product also needs Identity on and its own identity.nearby setting on.",
    keywords: ["launch", "nearby", "approve", "rollout"],
    docs: PLATFORM_DOCS,
    value: { kind: "switch" },
    defaultValue: "off",
    merge: "policy",
    policyBound: "lock",
    widensWhen: "on",
    varName: "LAUNCH_IDENTITY_NEARBY",
    precedence: "ceiling",
    ownership: "operator",
    confirm: { on: "L1", off: "L0" },
    readers: [
      "services/identity/passthrough/nearbyStart.ts",
      "services/identity/index.ts",
    ],
    storage: { kind: "scalar", storedAs: "LAUNCH_IDENTITY_NEARBY" },
  }),
];

/**
 * License's settings slice (ST-03, notes/S-18 Appendix A.2 `license.*`), contributed through the
 * descriptor (`licenseService.settings`) so Core never imports this service (rule 6).
 *
 * License owns two namespaces: `license.*` and `licensing.*` (S-19 §7.13's per-product licensing
 * model settings). The `licensing.*` entries live in their own module, `licensingSettings.ts`,
 * because S-19 is still under review: every assumption about licence ↔ entitlement cardinality
 * stays in that one file.
 */

import { setting } from "../../core/settings/define.js";
import {
  DEFAULT_DEVICE_LIMIT,
  DEFAULT_MAX_OFFLINE_DAYS,
  DEVICE_LIMIT_MAX,
  OFFLINE_DAYS_MAX,
} from "../../core/settings/platform.js";
import type {
  ServiceSettingsSlice,
  SettingDef,
} from "../../core/settings/types.js";
import { LICENSING_SETTINGS } from "./licensingSettings.js";

const VISIBLE = { service: "license", offBehaviour: "hide" } as const;

const LICENSE_SETTINGS: readonly SettingDef[] = [
  setting({
    key: "license.defaults.deviceLimit",
    scope: "product",
    service: "license",
    area: "license.policy",
    label: "Default device limit",
    description:
      "How many devices a licence may activate when neither its tier nor the licence sets a limit.",
    keywords: ["seats", "devices", "activations"],
    docs: "/docs/features/licensing/access/",
    value: { kind: "integer", unit: "count", min: 1, max: DEVICE_LIMIT_MAX },
    defaultValue: DEFAULT_DEVICE_LIMIT,
    merge: "cascade",
    inherits: "platform",
    ownership: "claimable",
    manifest: { path: "product:licensing.defaultDeviceLimit" },
    confirm: { up: "L1", down: "L1" },
    visibleWhen: VISIBLE,
    readers: ["core/products.ts", "core/licensing/authz.ts"],
    storage: {
      kind: "column",
      table: "products",
      column: "default_device_limit",
    },
  }),
  setting({
    key: "license.defaults.maxOfflineDays",
    scope: "product",
    service: "license",
    area: "license.policy",
    label: "Default offline window",
    description:
      "How many days a device may run without reaching the server when neither its tier nor the licence sets a window.",
    keywords: ["grace", "offline", "graceUntil"],
    docs: "/docs/features/licensing/access/",
    value: { kind: "integer", unit: "days", min: 0, max: OFFLINE_DAYS_MAX },
    defaultValue: DEFAULT_MAX_OFFLINE_DAYS,
    merge: "cascade",
    inherits: "platform",
    ownership: "claimable",
    manifest: { path: "product:licensing.defaultMaxOfflineDays" },
    confirm: { up: "L1", down: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: ["core/products.ts", "services/license/document.ts"],
    storage: {
      kind: "column",
      table: "products",
      column: "default_max_offline_days",
    },
  }),
  setting({
    key: "license.fingerprint",
    scope: "product",
    service: "license",
    area: "license.policy",
    label: "Fingerprint policy",
    description:
      "Which hashed hardware components identify a device, and how many may change before it counts as a new device.",
    keywords: ["hwid", "hardware", "device identity"],
    docs: "/docs/features/licensing/fingerprints/",
    value: { kind: "json", schema: "fingerprint (product.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:fingerprint" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: ["fingerprint.ts", "services/license/admin/policy.ts"],
    storage: {
      kind: "column",
      table: "products",
      column: "fingerprint_policy_json",
    },
  }),
  setting({
    key: "license.autoIssue",
    scope: "product",
    service: "license",
    area: "license.autoIssue",
    label: "Auto-issue",
    description:
      "Mints a licence on first activation (anonymously, on sign-in, or both) instead of requiring a key. Turning it on gives the product away at the chosen tier.",
    keywords: ["free", "trial", "anonymous", "discover"],
    docs: "/docs/features/licensing/access/",
    value: { kind: "json", schema: "autoIssue (product.schema.json)" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:autoIssue" },
    critical: true,
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    readers: ["services/license/admin/policy.ts", "core/edgeMintApproval.ts"],
    storage: { kind: "column", table: "products", column: "auto_issue_json" },
  }),
  setting({
    key: "license.tiers",
    scope: "product",
    service: "license",
    area: "license.tiers",
    label: "Tiers",
    description:
      "The product's tiers: device limit, expiry, channels, version window and profile per tier. Each row is claimed on its own (S-18 D3).",
    keywords: ["plans", "editions", "skus"],
    docs: "/docs/features/licensing/model/",
    value: { kind: "json", schema: "tiers (product.schema.json)" },
    defaultValue: [],
    merge: "cascade",
    ownership: "claimable",
    manifest: { path: "product:licensing.tiers" },
    confirm: { change: "L1" },
    visibleWhen: VISIBLE,
    wire: ["document"],
    readers: ["core/licensing/authz.ts"],
    storage: { kind: "rich", adapter: "tiers" },
  }),
];

export const LICENSE_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["license", "licensing"],
  entries: [...LICENSE_SETTINGS, ...LICENSING_SETTINGS],
};

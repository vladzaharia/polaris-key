/**
 * `console.access` (ST-28 plan §2.4, ST-32.2): the one platform grant mechanism, SSO rules that
 * give a signed-in operator console access. Exempt from rule 1 through `PRIVILEGE_GRANT_KEYS`
 * (`rules.ts`); written only by `writeConsoleAccess` (Superadmin, step-up, L2, reason), never by the
 * generic platform settings route. Adding to `PRIVILEGE_GRANT_KEYS` is a THREAT-MODEL §9 review.
 */

import { setting } from "./define.js";
import type { SettingDef } from "./types.js";
import { ACCESS_RULES_SCHEMA } from "./rules.js";

export const CONSOLE_ACCESS_DEF: SettingDef = setting({
  key: "console.access",
  scope: "platform",
  service: "platform",
  area: "access",
  label: "Console access rules",
  description:
    "Rules that give people who sign in through an operator connection access to the console, by group, domain or claim. A rule grants Product admin or Console access, never Platform admin or Superadmin.",
  keywords: ["sso", "rules", "members", "group", "domain", "claim"],
  docs: "/docs/operate/platform/settings/",
  value: { kind: "json", schema: ACCESS_RULES_SCHEMA },
  defaultValue: { rules: [] },
  merge: "cascade",
  ownership: "operator",
  critical: true,
  securityWidening: true,
  widensWhen: "any",
  rbacArea: "members",
  confirm: { change: "L2" },
  readers: ["core/rbac/ruleGrants.ts"],
  storage: { kind: "scalar" },
  since: "ST-32",
});

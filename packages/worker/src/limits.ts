/**
 * The limits inventory (ST-09): the code constants an operator can be asked about, with the
 * wording the Limits section shows. Every value is imported from the module that owns it, so the
 * page cannot disagree with the code; `test/core/limits.test.ts` fails when a limit-shaped constant
 * is added to the Core, platform or console layers without a row here (or an entry in its
 * `INTERNAL` table, which says why it is not listed). Read-only: a limit changes by a code
 * change, where review sees it.
 *
 * A composition-level module: it reaches the constants where they live, and only the console's
 * platform handler reads it.
 */

import {
  ADMIN_SESSION_TTL_SECONDS,
  LIVE_CHECK_SECONDS,
} from "./core/console/session.js";
import { MAX_ADMIN_API_TOKENS, MAX_TOKEN_DAYS } from "./console/apiTokens.js";
import { OPERATOR_NOTICE_PER_RECIPIENT_HOUR } from "./console/handlers/accessShared.js";
import {
  INVITE_PURGE_GRACE_SECONDS,
  INVITE_TTL_SECONDS,
} from "./core/rbac/bindings.js";
import { MAX_LIVE_PERSONAL_TOKENS } from "./core/accounts/personalTokens.js";
import {
  OIDC_CI_TOKEN_TTL_SECONDS,
  STATIC_CI_TOKEN_MAX_TTL_SECONDS,
  STATIC_CI_READ_TOKEN_MAX_TTL_SECONDS,
  TICKET_MAX_TTL_SECONDS,
  MAX_TICKET_OBJECTS,
  MAX_UPLOAD_OBJECT_BYTES,
} from "./core/publisher.js";
import {
  MAX_LIVE_TOKENS_PER_LICENSE,
  MAX_LIVE_TOKENS_PER_OWNER,
  REGISTRY_PUBLISH_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_MAX_DAYS,
  REGISTRY_TOKEN_RETENTION_SECONDS,
} from "./core/registry/registryVocabulary.js";
import { BREAK_GLASS_MAX_SECONDS } from "./core/settings/authority.js";
import {
  DOWNLOAD_TICKET_RESUME_SECONDS,
  DOWNLOAD_TICKET_TTL_SECONDS,
} from "./core/downloadTicket.js";
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_LOCKOUT_SECONDS,
  EMAIL_SEND_PER_DEVICE_HOUR,
  EMAIL_SEND_PER_IP_HOUR,
  EMAIL_SEND_PER_NETWORK_HOUR,
  EMAIL_SEND_PER_RECIPIENT_DAY,
  EMAIL_SEND_PER_RECIPIENT_HOUR,
} from "./core/notify/emailLimits.js";
import { HARD_BOUNCE_SUPPRESSION_SECONDS } from "./core/notify/emailDelivery.js";
import { AUDIT_RETENTION_SECONDS } from "./scheduled.js";
import { JOB_RUN_RETENTION_SECONDS } from "./core/ops/platformOps.js";
import {
  SUBJECT_EVENT_RETENTION_SECONDS,
  TOMBSTONE_RETENTION_SECONDS,
} from "./privacyResidue.js";
import { REFUSAL_RETENTION_SECONDS } from "./core/licensing/refusals.js";
import { SIGHTING_RETENTION_SECONDS } from "./core/integration/sightings.js";
import { CONNECTOR_EVENT_RETENTION_SECONDS } from "./core/stores/events.js";
import {
  DEFAULT_DAILY_CAP,
  DEMAND_RETENTION_SECONDS,
} from "./core/assets/deltaDemand.js";
import {
  BLOB_LOCK_AGE_SECONDS,
  DEFAULT_GC_GRACE_SECONDS,
  MIN_GC_GRACE_SECONDS,
} from "./core/assets/blobGc.js";
import {
  LAZY_DELTA_MAX_BYTES_CEILING,
  SETTINGS_CACHE_MS,
} from "./core/platformSettings.js";
import { IMG_MAX_WIDTH } from "./core/hosts.js";
import {
  DEFAULT_DEVICE_LIMIT,
  DEFAULT_MAX_OFFLINE_DAYS,
  OFFLINE_DAYS_MAX,
} from "./core/settings/platform.js";
import { LICENSE_PAGE_MAX } from "./core/licensing/store.js";
import { SEAT_DORMANCY_SECONDS } from "./core/devices/store.js";
import { AUDIT_EXPORT_MAX_ROWS } from "./core/audit.js";
import { BROWSER_JSON_MAX_BYTES } from "./core/accounts/browserRequestGuard.js";
import { FEED_CACHE_SECONDS } from "./core/feedCache.js";
import { MAX_DEPLOY_HOOK_BODY_BYTES } from "./platformDeploy.js";

export type LimitArea =
  | "Access"
  | "Email"
  | "Retention"
  | "Storage and delivery"
  | "Licensing"
  | "Requests";

/** `seconds`, `ms`, `days` and `bytes` are formatted as spans and sizes; any other unit is a noun. */
export interface Limit {
  /** The exported constant's name. */
  name: string;
  /** The module that exports it, relative to `src/`. */
  source: string;
  area: LimitArea;
  label: string;
  help: string;
  unit: string;
  value: number;
}

export const LIMITS: readonly Limit[] = [
  // Access
  row(
    "ADMIN_SESSION_TTL_SECONDS",
    "core/console/session.ts",
    "Access",
    "Console session length",
    "A console session ends after this, however active it is.",
    "seconds",
    ADMIN_SESSION_TTL_SECONDS,
  ),
  row(
    "LIVE_CHECK_SECONDS",
    "core/console/session.ts",
    "Access",
    "Console access check",
    "Signing a session out, disabling its account or deleting it ends console access within this.",
    "seconds",
    LIVE_CHECK_SECONDS,
  ),
  row(
    "BREAK_GLASS_MAX_SECONDS",
    "core/settings/authority.ts",
    "Access",
    "Longest break-glass",
    "A break-glass on a locked setting lasts at most this long.",
    "seconds",
    BREAK_GLASS_MAX_SECONDS,
  ),
  row(
    "MAX_TOKEN_DAYS",
    "console/apiTokens.ts",
    "Access",
    "Longest admin API token",
    "The latest expiry an admin API token can be given.",
    "days",
    MAX_TOKEN_DAYS,
  ),
  row(
    "INVITE_TTL_SECONDS",
    "core/rbac/bindings.ts",
    "Access",
    "Console invitation lifetime",
    "An invitation to the console that nobody accepts ends after this.",
    "seconds",
    INVITE_TTL_SECONDS,
  ),
  row(
    "INVITE_PURGE_GRACE_SECONDS",
    "core/rbac/bindings.ts",
    "Access",
    "Expired invitations kept",
    "An expired invitation is deleted this long after it ends.",
    "seconds",
    INVITE_PURGE_GRACE_SECONDS,
  ),
  row(
    "OPERATOR_NOTICE_PER_RECIPIENT_HOUR",
    "console/handlers/accessShared.ts",
    "Access",
    "Access emails per person",
    "Emails about console access one address gets in an hour. A change to Superadmin, Platform admin or All products admin is always sent.",
    "per hour",
    OPERATOR_NOTICE_PER_RECIPIENT_HOUR,
  ),
  row(
    "MAX_ADMIN_API_TOKENS",
    "console/apiTokens.ts",
    "Access",
    "Admin API tokens",
    "Live admin API tokens the platform holds at once.",
    "tokens",
    MAX_ADMIN_API_TOKENS,
  ),
  row(
    "MAX_LIVE_PERSONAL_TOKENS",
    "core/accounts/personalTokens.ts",
    "Access",
    "Personal tokens per person",
    "Live personal tokens one account can hold.",
    "tokens",
    MAX_LIVE_PERSONAL_TOKENS,
  ),
  row(
    "OIDC_CI_TOKEN_TTL_SECONDS",
    "core/publisher.ts",
    "Access",
    "CI token from OIDC",
    "How long a CI token minted from a workflow's OIDC identity lasts.",
    "seconds",
    OIDC_CI_TOKEN_TTL_SECONDS,
  ),
  row(
    "STATIC_CI_TOKEN_MAX_TTL_SECONDS",
    "core/publisher.ts",
    "Access",
    "Longest static CI token",
    "The latest expiry a static CI token can be given.",
    "seconds",
    STATIC_CI_TOKEN_MAX_TTL_SECONDS,
  ),
  row(
    "STATIC_CI_READ_TOKEN_MAX_TTL_SECONDS",
    "core/publisher.ts",
    "Access",
    "Longest read-only service token",
    "The latest expiry a static CI token can be given when its only scope is packages:read.",
    "seconds",
    STATIC_CI_READ_TOKEN_MAX_TTL_SECONDS,
  ),
  row(
    "REGISTRY_TOKEN_MAX_DAYS",
    "core/registry/registryVocabulary.ts",
    "Access",
    "Longest registry token",
    "The latest expiry a registry token can be given.",
    "days",
    REGISTRY_TOKEN_MAX_DAYS,
  ),
  row(
    "REGISTRY_PUBLISH_TOKEN_MAX_DAYS",
    "core/registry/registryVocabulary.ts",
    "Access",
    "Longest publish token",
    "The latest expiry a registry publish token can be given.",
    "days",
    REGISTRY_PUBLISH_TOKEN_MAX_DAYS,
  ),
  row(
    "MAX_LIVE_TOKENS_PER_OWNER",
    "core/registry/registryVocabulary.ts",
    "Access",
    "Registry tokens per owner",
    "Live registry tokens one owner can hold.",
    "tokens",
    MAX_LIVE_TOKENS_PER_OWNER,
  ),
  row(
    "MAX_LIVE_TOKENS_PER_LICENSE",
    "core/registry/registryVocabulary.ts",
    "Access",
    "Registry tokens per license",
    "Live registry tokens one license can hold.",
    "tokens",
    MAX_LIVE_TOKENS_PER_LICENSE,
  ),
  row(
    "DOWNLOAD_TICKET_TTL_SECONDS",
    "core/downloadTicket.ts",
    "Access",
    "Download link life",
    "How long a signed download link works.",
    "seconds",
    DOWNLOAD_TICKET_TTL_SECONDS,
  ),
  row(
    "DOWNLOAD_TICKET_RESUME_SECONDS",
    "core/downloadTicket.ts",
    "Access",
    "Download resume window",
    "How long after a download link expires a browser's resume of that file still works.",
    "seconds",
    DOWNLOAD_TICKET_RESUME_SECONDS,
  ),
  // Email
  row(
    "EMAIL_CODE_TTL_SECONDS",
    "core/notify/emailLimits.ts",
    "Email",
    "Sign-in code life",
    "How long an emailed sign-in code works.",
    "seconds",
    EMAIL_CODE_TTL_SECONDS,
  ),
  row(
    "EMAIL_CODE_MAX_ATTEMPTS",
    "core/notify/emailLimits.ts",
    "Email",
    "Code attempts",
    "Wrong codes allowed before the code is void.",
    "attempts",
    EMAIL_CODE_MAX_ATTEMPTS,
  ),
  row(
    "EMAIL_LOCKOUT_SECONDS",
    "core/notify/emailLimits.ts",
    "Email",
    "Code lockout",
    "How long sign-in by code is refused after too many wrong codes.",
    "seconds",
    EMAIL_LOCKOUT_SECONDS,
  ),
  row(
    "EMAIL_SEND_PER_RECIPIENT_HOUR",
    "core/notify/emailLimits.ts",
    "Email",
    "Sends per recipient, hourly",
    "Sign-in emails one address receives per hour.",
    "per hour",
    EMAIL_SEND_PER_RECIPIENT_HOUR,
  ),
  row(
    "EMAIL_SEND_PER_RECIPIENT_DAY",
    "core/notify/emailLimits.ts",
    "Email",
    "Sends per recipient, daily",
    "Sign-in emails one address receives per day.",
    "per day",
    EMAIL_SEND_PER_RECIPIENT_DAY,
  ),
  row(
    "EMAIL_SEND_PER_IP_HOUR",
    "core/notify/emailLimits.ts",
    "Email",
    "Sends per IP address",
    "Sign-in emails one IP address can request per hour.",
    "per hour",
    EMAIL_SEND_PER_IP_HOUR,
  ),
  row(
    "EMAIL_SEND_PER_NETWORK_HOUR",
    "core/notify/emailLimits.ts",
    "Email",
    "Sends per network",
    "Sign-in emails one network can request per hour.",
    "per hour",
    EMAIL_SEND_PER_NETWORK_HOUR,
  ),
  row(
    "EMAIL_SEND_PER_DEVICE_HOUR",
    "core/notify/emailLimits.ts",
    "Email",
    "Sends per device",
    "Sign-in emails one device can request per hour.",
    "per hour",
    EMAIL_SEND_PER_DEVICE_HOUR,
  ),
  row(
    "HARD_BOUNCE_SUPPRESSION_SECONDS",
    "core/notify/emailDelivery.ts",
    "Email",
    "Bounce suppression",
    "An address that hard-bounced gets no mail for this long.",
    "seconds",
    HARD_BOUNCE_SUPPRESSION_SECONDS,
  ),
  // Retention
  row(
    "AUDIT_RETENTION_SECONDS",
    "scheduled.ts",
    "Retention",
    "Audit trail",
    "Audit and platform trail rows older than this are deleted nightly.",
    "seconds",
    AUDIT_RETENTION_SECONDS,
  ),
  row(
    "JOB_RUN_RETENTION_SECONDS",
    "core/ops/platformOps.ts",
    "Retention",
    "Job runs",
    "Scheduled-job run records are kept this long.",
    "seconds",
    JOB_RUN_RETENTION_SECONDS,
  ),
  row(
    "REFUSAL_RETENTION_SECONDS",
    "core/licensing/refusals.ts",
    "Retention",
    "Refusals",
    "License refusal records are kept this long.",
    "seconds",
    REFUSAL_RETENTION_SECONDS,
  ),
  row(
    "SIGHTING_RETENTION_SECONDS",
    "core/integration/sightings.ts",
    "Retention",
    "Integration sightings",
    "Records of SDK integrations seen are kept this long.",
    "seconds",
    SIGHTING_RETENTION_SECONDS,
  ),
  row(
    "CONNECTOR_EVENT_RETENTION_SECONDS",
    "core/stores/events.ts",
    "Retention",
    "Store connector events",
    "Store notification payloads are kept this long.",
    "seconds",
    CONNECTOR_EVENT_RETENTION_SECONDS,
  ),
  row(
    "DEMAND_RETENTION_SECONDS",
    "core/assets/deltaDemand.ts",
    "Retention",
    "Delta demand",
    "Counted delta demand is kept this long.",
    "seconds",
    DEMAND_RETENTION_SECONDS,
  ),
  row(
    "TOMBSTONE_RETENTION_SECONDS",
    "privacyResidue.ts",
    "Retention",
    "Erasure tombstones",
    "An erasure's tombstone is kept this long.",
    "seconds",
    TOMBSTONE_RETENTION_SECONDS,
  ),
  row(
    "SUBJECT_EVENT_RETENTION_SECONDS",
    "privacyResidue.ts",
    "Retention",
    "Subject events",
    "Privacy-request events are kept this long.",
    "seconds",
    SUBJECT_EVENT_RETENTION_SECONDS,
  ),
  row(
    "REGISTRY_TOKEN_RETENTION_SECONDS",
    "core/registry/registryVocabulary.ts",
    "Retention",
    "Expired registry tokens",
    "An expired or revoked registry token's record is kept this long.",
    "seconds",
    REGISTRY_TOKEN_RETENTION_SECONDS,
  ),
  // Storage and delivery
  row(
    "BLOB_LOCK_AGE_SECONDS",
    "core/assets/blobGc.ts",
    "Storage and delivery",
    "Blob bucket age lock",
    "No object younger than this can be deleted. It must match the bucket's lock rule.",
    "seconds",
    BLOB_LOCK_AGE_SECONDS,
  ),
  row(
    "MIN_GC_GRACE_SECONDS",
    "core/assets/blobGc.ts",
    "Storage and delivery",
    "Shortest collector grace",
    "The collector never deletes an object unreferenced for less than this.",
    "seconds",
    MIN_GC_GRACE_SECONDS,
  ),
  row(
    "DEFAULT_GC_GRACE_SECONDS",
    "core/assets/blobGc.ts",
    "Storage and delivery",
    "Collector grace",
    "The grace the collector uses until the setting is changed.",
    "seconds",
    DEFAULT_GC_GRACE_SECONDS,
  ),
  row(
    "LAZY_DELTA_MAX_BYTES_CEILING",
    "core/settings/platform.ts",
    "Storage and delivery",
    "Lazy delta size ceiling",
    "The measured largest payload the delta consumer can encode.",
    "bytes",
    LAZY_DELTA_MAX_BYTES_CEILING,
  ),
  row(
    "DEFAULT_DAILY_CAP",
    "core/assets/deltaDemand.ts",
    "Storage and delivery",
    "Deltas per product, daily",
    "The delta pairs one product can generate per day unless it sets its own cap.",
    "per day",
    DEFAULT_DAILY_CAP,
  ),
  row(
    "MAX_UPLOAD_OBJECT_BYTES",
    "core/publisher.ts",
    "Storage and delivery",
    "Largest upload",
    "The largest single object an upload ticket allows.",
    "bytes",
    MAX_UPLOAD_OBJECT_BYTES,
  ),
  row(
    "TICKET_MAX_TTL_SECONDS",
    "core/publisher.ts",
    "Storage and delivery",
    "Upload ticket life",
    "The longest an upload ticket works.",
    "seconds",
    TICKET_MAX_TTL_SECONDS,
  ),
  row(
    "MAX_TICKET_OBJECTS",
    "core/publisher.ts",
    "Storage and delivery",
    "Objects per ticket",
    "Objects one upload ticket can cover.",
    "objects",
    MAX_TICKET_OBJECTS,
  ),
  row(
    "IMG_MAX_WIDTH",
    "core/hosts.ts",
    "Storage and delivery",
    "Widest hosted image",
    "Hosted images are served at most this wide.",
    "px",
    IMG_MAX_WIDTH,
  ),
  row(
    "FEED_CACHE_SECONDS",
    "core/feedCache.ts",
    "Storage and delivery",
    "Feed cache",
    "How long a rendered feed is cached.",
    "seconds",
    FEED_CACHE_SECONDS,
  ),
  // Licensing
  row(
    "DEFAULT_DEVICE_LIMIT",
    "core/settings/platform.ts",
    "Licensing",
    "Default device limit",
    "Devices a license allows until its tier or the setting says otherwise.",
    "devices",
    DEFAULT_DEVICE_LIMIT,
  ),
  row(
    "DEFAULT_MAX_OFFLINE_DAYS",
    "core/settings/platform.ts",
    "Licensing",
    "Default offline period",
    "How long a device works offline until the setting says otherwise.",
    "days",
    DEFAULT_MAX_OFFLINE_DAYS,
  ),
  row(
    "OFFLINE_DAYS_MAX",
    "core/settings/platform.ts",
    "Licensing",
    "Longest offline period",
    "No setting can allow longer offline use.",
    "days",
    OFFLINE_DAYS_MAX,
  ),
  row(
    "LICENSE_PAGE_MAX",
    "core/licensing/store.ts",
    "Licensing",
    "Licenses per page",
    "The most licenses one list request returns.",
    "licenses",
    LICENSE_PAGE_MAX,
  ),
  row(
    "SEAT_DORMANCY_SECONDS",
    "core/devices/store.ts",
    "Licensing",
    "Device dormancy",
    "A device unseen this long stops counting toward the device limit.",
    "seconds",
    SEAT_DORMANCY_SECONDS,
  ),
  // Requests
  row(
    "SETTINGS_CACHE_MS",
    "core/platformSettings.ts",
    "Requests",
    "Settings propagation",
    "A saved setting reaches every Worker isolate within this.",
    "ms",
    SETTINGS_CACHE_MS,
  ),
  row(
    "AUDIT_EXPORT_MAX_ROWS",
    "core/audit.ts",
    "Requests",
    "Audit export size",
    "The most rows one audit export returns.",
    "rows",
    AUDIT_EXPORT_MAX_ROWS,
  ),
  row(
    "BROWSER_JSON_MAX_BYTES",
    "core/accounts/browserRequestGuard.ts",
    "Requests",
    "Browser request body",
    "The largest JSON body a browser sign-in request may carry.",
    "bytes",
    BROWSER_JSON_MAX_BYTES,
  ),
  row(
    "MAX_DEPLOY_HOOK_BODY_BYTES",
    "platformDeploy.ts",
    "Requests",
    "Deploy hook body",
    "The largest body the deploy hook accepts.",
    "bytes",
    MAX_DEPLOY_HOOK_BODY_BYTES,
  ),
];

function row(
  name: string,
  source: string,
  area: LimitArea,
  label: string,
  help: string,
  unit: string,
  value: number,
): Limit {
  return { name, source, area, label, help, unit, value };
}

/**
 * The credential kinds a store connector signs in with (ST-12): their fields, pins and copy. Pure,
 * so the channel's Setup tab and the Credentials page offer the same forms. Values are write-only:
 * a kind names its fields, never a stored value.
 */

import {
  HttpError,
  type OutletCredentialKind,
  type OutletCredentialsResponse,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";

export interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  help?: string;
}

export interface PinSpec {
  label: string;
  help: string;
  /** The pin's keyboard: an Apple ID and a Steam app id are digits; the rest are not (OUT-4). */
  inputMode: "numeric" | "text";
}

export interface KindSpec {
  value: OutletCredentialKind;
  label: string;
  description: string;
  fields: FieldSpec[];
  pin?: PinSpec;
  /** `asc-webhook-secret`: the Worker can generate the value. */
  generate?: boolean;
}

export const KINDS: KindSpec[] = [
  {
    value: "asc-api-key",
    label: "App Store Connect API key",
    description: "Reads review and release state; drives phased releases.",
    pin: {
      label: "App Store Connect app id (Apple ID)",
      help: "The numeric Apple ID of the one app this key may read and act on for this product. The connector stays off unless .pkey/distribution names the same app.",
      inputMode: "numeric",
    },
    fields: [
      { key: "keyId", label: "Key ID" },
      { key: "issuerId", label: "Issuer ID" },
      {
        key: "p8",
        label: ".p8 private key",
        secret: true,
        multiline: true,
        help: "Paste the whole .p8 file. Use a team key with the App Manager role.",
      },
    ],
  },
  {
    value: "asc-webhook-secret",
    label: "App Store webhook secret",
    description: "Verifies App Store Connect's webhook calls.",
    generate: true,
    fields: [{ key: "secret", label: "Secret", secret: true }],
  },
  {
    value: "google-service-account",
    label: "Google service account",
    description:
      "Reads tracks and vitals; drives staged rollouts on Google Play.",
    pin: {
      label: "Google Play package name",
      help: "The package name (application id) of the one Play app this service account may read and act on for this product. The connector stays off unless .pkey/distribution names the same package.",
      inputMode: "text",
    },
    fields: [
      {
        key: "json",
        label: "JSON key file",
        secret: true,
        multiline: true,
        help: "Paste the service account's JSON key. Invite it to one app with release permissions only.",
      },
    ],
  },
  {
    value: "ms-partner-center",
    label: "Microsoft Partner Center app",
    description: "Reads Microsoft Store submissions and availability.",
    pin: {
      label: "Microsoft Store product id (Store ID)",
      help: "The 12-character Store ID of the one Microsoft Store app this Entra app may read for this product. The connector stays off unless .pkey/distribution names the same productId.",
      inputMode: "text",
    },
    fields: [
      { key: "tenantId", label: "Tenant ID" },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      { key: "sellerId", label: "Seller ID" },
    ],
  },
  {
    value: "sentry-integration",
    label: "Sentry internal integration",
    description:
      "Verifies Sentry's alert webhooks, which open halt candidates.",
    fields: [
      {
        key: "clientSecret",
        label: "Client secret",
        secret: true,
        help: "The internal integration's client secret. Sentry signs its alert webhooks with it; Polaris Key never calls Sentry. An alert only opens a halt candidate for you to confirm.",
      },
    ],
  },
  {
    value: "app-store-server-key",
    label: "App Store In-App Purchase key",
    description: "Confirms App Store purchases for the commerce bridge.",
    pin: {
      label: "App Store bundle id",
      help: "The bundle id of the one app whose purchases this key may confirm for this product. The commerce bridge stays off for the App Store unless its settings name the same bundle id.",
      inputMode: "text",
    },
    fields: [
      { key: "keyId", label: "Key ID" },
      { key: "issuerId", label: "Issuer ID" },
      {
        key: "p8",
        label: ".p8 private key",
        secret: true,
        multiline: true,
        help: "App Store Connect → Users and Access → Integrations → In-App Purchase. Not the App Store Connect API key.",
      },
    ],
  },
  {
    value: "steam-publisher-key",
    label: "Steamworks Web API publisher key",
    description: "Checks DLC ownership for the commerce bridge.",
    pin: {
      label: "Steam app id",
      help: "The app id of the one game whose DLC ownership this key may check for this product. The commerce bridge stays off for Steam unless its settings name the same app id.",
      inputMode: "numeric",
    },
    fields: [
      {
        key: "key",
        label: "Publisher key",
        secret: true,
        help: "Steamworks → Users & Permissions → Manage Groups → Web API key (32 hex digits).",
      },
    ],
  },
];

export const KIND = new Map(KINDS.map((k) => [k.value as string, k]));
export const kindLabel = (k: string) => KIND.get(k)?.label ?? k;

/** The `meta` field a kind's pin is kept under: the server's word first. */
export function pinField(
  data: OutletCredentialsResponse | undefined,
  kind: string,
): string | null {
  return (
    data?.pins?.[kind]?.field ??
    (
      {
        "asc-api-key": "appleId",
        "google-service-account": "packageName",
        "ms-partner-center": "productId",
        "app-store-server-key": "bundleId",
        "steam-publisher-key": "appId",
      } as Record<string, string>
    )[kind] ??
    null
  );
}

/** The error copy, with the platform store connection's refusal worded (A-16). */
export function describe(e: unknown): { title: string; description?: string } {
  if (e instanceof HttpError && e.code === "app_assigned_elsewhere")
    return {
      title: "That app belongs to another product",
      description:
        e.message && e.message !== `http ${e.status}`
          ? e.message
          : "It is assigned to another product through the platform's store connection. Unassign it there first.",
    };
  return errorCopy(e, { area: "distribution", thing: "Channel credential" });
}

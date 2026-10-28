// `identity.choice.*` (I-10a.11; WIRE-CONTRACT-V4 §12.5.1): the licence choice an app shows itself
// after `signIn` answered `{kind: "choose", grant}`. The React half of Node's `identity/choice.ts`.
//
//   licenses(grant)           the licences the account can run this device on (a view)
//   devices(grant, licenseId) a full licence's seated devices, for Replace (a view)
//   complete(grant, choice)   the person's choice; the device token is stored like a sign-in
//   cancel(grant)             give the grant up; nothing is stored
//
// A refusal the Worker answers is a RESULT (`{kind: "refused", code, ...}`), never a throw; a
// network failure or a 5xx throws. The grant is the credential: no device bearer goes with it,
// and it never appears in an error message. Bearer mode only; a cookie page and the desktop
// renderer (which never gets a grant) answer the typed `UnsupportedError`.

import { identityEndpointsOf } from "./account.js";
import type {
  LicenseChoiceInput,
  LicenseChoiceView,
  ReplaceView,
} from "@polaris-key/protocol/identity";

export type { LicenseChoiceInput, LicenseChoiceView, ReplaceView };

/** The person's explicit choice (the wire's `LicenseChoiceInput`). */
export type LicenseChoice = LicenseChoiceInput;

/** Why the Worker said no, as a result. Only the members the answer carried are present. */
export interface ChoiceRefusal {
  kind: "refused";
  /** The wire code: `invalid_grant`, `license_choice_required`, `not_found`, `device_limit`,
   *  `rate_limited`, `license_owned`, `key_entry_limit`, ... */
  code: string;
  httpStatus: number;
  /** `rate_limited`: seconds to wait. */
  retryAfterSeconds?: number;
  /** `device_limit` and `license_choice_required`: the fresh view to choose from again. */
  view?: LicenseChoiceView;
  /** `device_limit`, `key_entry_limit`: the portal link that frees a seat or an entry. */
  manageUrl?: string;
  /** `license_owned`: where to sign in to the account that owns the licence. */
  signInUrl?: string;
  /** `key_entry_limit`. */
  keyEntries?: { used: number; limit: number };
}

export type ChoiceViewResult<V> = { kind: "ok"; view: V } | ChoiceRefusal;

export type ChoiceCompleteResult =
  | {
      kind: "ok";
      /** The licence the device now runs on, or null on a device with none. */
      licenseId: string | null;
      /** The pairwise account subject (`ps_…`). */
      subject: string;
      scope: string;
      /** After a `key`: the licence's key-entry count. */
      keyEntries?: { used: number; limit: number };
      /** `true` after `keep`: the device kept a licence outside the account, so `attach` may
       *  follow. Never set otherwise. */
      attachable?: true;
    }
  | ChoiceRefusal;

export type ChoiceCancelResult = { kind: "ok" } | ChoiceRefusal;

/** `usePolarisAuth().choice`. */
export interface ChoiceNamespace {
  licenses(grant: string): Promise<ChoiceViewResult<LicenseChoiceView>>;
  devices(
    grant: string,
    licenseId: string,
  ): Promise<ChoiceViewResult<ReplaceView>>;
  complete(grant: string, choice: LicenseChoice): Promise<ChoiceCompleteResult>;
  cancel(grant: string): Promise<ChoiceCancelResult>;
}

/** The four `choice*` endpoints of the identity fragment. Anything absent is unavailable. */
export interface ChoiceEndpoints {
  choiceLicenses?: string;
  choiceDevices?: string;
  choiceComplete?: string;
  choiceCancel?: string;
}

export type ChoiceEndpointName = keyof ChoiceEndpoints;

const CHOICE_KEYS: readonly ChoiceEndpointName[] = [
  "choiceLicenses",
  "choiceDevices",
  "choiceComplete",
  "choiceCancel",
];

/** The identity fragment's choice endpoints from a discovery document, or `null`. */
export function choiceEndpointsOf(
  discovery: Record<string, unknown> | null | undefined,
): ChoiceEndpoints | null {
  return identityEndpointsOf(discovery, CHOICE_KEYS);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isChoiceCount = (
  v: unknown,
): v is { used: number; limit: number } =>
  isRecord(v) && typeof v.used === "number" && typeof v.limit === "number";

export function isLicenseChoiceView(v: unknown): v is LicenseChoiceView {
  return isRecord(v) && typeof v.state === "string" && Array.isArray(v.choices);
}

export function isReplaceView(v: unknown): v is ReplaceView {
  return (
    isRecord(v) && typeof v.licenseId === "string" && Array.isArray(v.devices)
  );
}

/** A 4xx answer as the typed refusal. `retryHeader` is the parsed `Retry-After`, if any. */
export function choiceRefusal(
  status: number,
  code: string,
  body: unknown,
  retryHeader: number | undefined,
): ChoiceRefusal {
  const b = isRecord(body) ? body : {};
  const retry =
    retryHeader ??
    (typeof b.retryAfter === "number" && b.retryAfter > 0
      ? Math.ceil(b.retryAfter)
      : undefined);
  return {
    kind: "refused",
    code,
    httpStatus: status,
    ...(retry !== undefined ? { retryAfterSeconds: retry } : {}),
    ...(isLicenseChoiceView(b.view) ? { view: b.view } : {}),
    ...(typeof b.manageUrl === "string" ? { manageUrl: b.manageUrl } : {}),
    ...(typeof b.signInUrl === "string" ? { signInUrl: b.signInUrl } : {}),
    ...(isChoiceCount(b.keyEntries) ? { keyEntries: b.keyEntries } : {}),
  };
}

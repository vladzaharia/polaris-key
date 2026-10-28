// Error → copy key mapping over the core copy (conformance/parity/copy.en.json, `core.*` in the
// kit tables). A view names the keys; the copy layer formats them and, for a code the catalog
// does not describe, shows the catalog's fallback sentence (DL7: "an unknown code shows the
// catalog's fallback sentence"), never a raw code.

import type { ActivationInput } from "./input.js";

/** The fallback pair for an error the catalog does not name. */
export const FALLBACK_COPY = ["core.fallback.title", "core.fallback.message"];

/** The title and message of a `core.codes` code, or the fallback pair without one. */
export function codeCopy(code: string | undefined | null): string[] {
  return code
    ? [`core.codes.${code}.title`, `core.codes.${code}.message`]
    : [...FALLBACK_COPY];
}

/** The activation results `core.activation` describes (copy.en.json `activation`). */
export const ACTIVATION_KINDS = [
  "ok",
  "device-limit",
  "fingerprint-required",
  "hardware-mismatch",
  "enroll-claimed",
  "license-disabled",
  "license-expired",
  "attestation-required",
  "rate-limited",
  "unauthorized",
  "enroll-disabled",
  "key-entry-limit",
  "refused",
  "error",
] as const;

/** Wire codes whose refusal `core.activation` describes under another name. */
const CODE_KIND: Readonly<Record<string, string>> = {
  key_entry_limit: "key-entry-limit",
  device_limit: "device-limit",
};

/**
 * The copy for an activation result: a `refused` or `error` result that carries a code takes
 * the code's own copy (`license_owned` never names the holder, S-16); every other result its
 * `core.activation` pair.
 */
export function activationCopy(result: string, code?: string): string[] {
  if ((result === "refused" || result === "error") && code) {
    const kind = CODE_KIND[code];
    return kind
      ? [`core.activation.${kind}.title`, `core.activation.${kind}.message`]
      : codeCopy(code);
  }
  return (ACTIVATION_KINDS as readonly string[]).includes(result)
    ? [`core.activation.${result}.title`, `core.activation.${result}.message`]
    : [...FALLBACK_COPY];
}

/** The title and message of a license status (`core.gate`). */
export function gateCopy(status: string): string[] {
  return [`core.gate.${status}.title`, `core.gate.${status}.message`];
}

/** An SDK activation outcome as it is thrown (`PolarisError.activation`) or returned. */
interface SdkActivation {
  kind?: unknown;
  code?: unknown;
  limit?: unknown;
  deviceCount?: unknown;
  manageUrl?: unknown;
  signInUrl?: unknown;
  keyEntries?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function entriesOf(v: unknown): { used: number; limit: number } | undefined {
  const k = v as { used?: unknown; limit?: unknown } | null | undefined;
  const used = num(k?.used);
  const limit = num(k?.limit);
  return used !== undefined && limit !== undefined
    ? { used, limit }
    : undefined;
}

/**
 * UK-02b D3: an SDK activation outcome in the activation vocabulary the views read. `keyEntryLimit`
 * is `key-entry-limit` (with the page that adds the key and the entries), `licenseOwned` the
 * `license_owned` refusal (with the sign-in page); `ok` keeps its key entries for the toast; any
 * other kind is `refused` with the server's code. A thrown error is read through its `activation`.
 */
export function activationFromOutcome(o: unknown): ActivationInput {
  const a: SdkActivation | undefined =
    (o as { activation?: SdkActivation } | null)?.activation ??
    (o as SdkActivation | null) ??
    undefined;
  const kind = str(a?.kind);
  if (!kind) return { result: "error" };
  const keyEntries = entriesOf(a?.keyEntries);
  const manageUrl = str(a?.manageUrl);
  switch (kind) {
    case "ok":
      return { result: "ok", ...(keyEntries ? { keyEntries } : {}) };
    case "keyEntryLimit":
      return {
        result: "key-entry-limit",
        code: "key_entry_limit",
        ...(manageUrl ? { manageUrl } : {}),
        ...(keyEntries ? { keyEntries } : {}),
      };
    case "licenseOwned": {
      const signInUrl = str(a?.signInUrl);
      return {
        result: "refused",
        code: "license_owned",
        ...(signInUrl ? { signInUrl } : {}),
      };
    }
    default: {
      const limit = num(a?.limit);
      const deviceCount = num(a?.deviceCount);
      const code = str(a?.code);
      return {
        result: kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        ...(code ? { code } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(deviceCount !== undefined ? { deviceCount } : {}),
        ...(manageUrl ? { manageUrl } : {}),
      };
    }
  }
}

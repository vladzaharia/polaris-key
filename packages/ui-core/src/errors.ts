// Error → copy key mapping over the core copy (conformance/parity/copy.en.json, `core.*` in the
// kit tables). A view names the keys; the copy layer formats them and, for a code the catalog
// does not describe, shows the catalog's fallback sentence (DL7: "an unknown code shows the
// catalog's fallback sentence"), never a raw code.

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

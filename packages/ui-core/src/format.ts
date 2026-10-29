// Number formatting for the facts the contract carries as numbers. Every other display fact is
// text its supplier formatted (input.ts); the boot stage's byte counts are numbers, so the model
// formats them here, in the kit's locale (`UiInput.locale`), the way the platform shows a file
// size: base 1000, "52 MB", "1.5 GB".

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/**
 * A byte count as the person reads it: a whole number from 10 up, one decimal below, in the
 * unit that keeps it under 1000. A locale tag `Intl` does not know reads in English.
 */
export function formatBytes(bytes: number, locale?: string): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 999.5 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const options: Intl.NumberFormatOptions = {
    style: "unit",
    unit: UNITS[unit]!,
    unitDisplay: "short",
    maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0,
  };
  try {
    return new Intl.NumberFormat(locale ?? "en", options).format(value);
  } catch {
    return new Intl.NumberFormat("en", options).format(value);
  }
}

/**
 * An email with its middle hidden: the first character and the domain, `a•••@example.com`. What
 * a screen shows of an address it did not just type (the license was sent to it). An address
 * with no local part or no domain is `""`, so a screen shows no half-hidden fragment.
 */
export function maskEmail(email: string | null | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  const first = at > 0 ? Array.from(email!.slice(0, at))[0] : undefined;
  const domain = at > 0 ? email!.slice(at + 1) : "";
  return first && domain ? `${first}•••@${domain}` : "";
}

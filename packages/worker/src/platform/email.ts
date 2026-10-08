/**
 * The canonical form of an email address for matching and keying: trimmed, lower-cased.
 *
 * ONE definition (P0-15). Account lookup, verified-address matching, the licence holder and the
 * per-recipient send limits all compare addresses in this form, so two spellings of one address
 * must normalise identically everywhere. It is a matching key, not a validator, and the address
 * shown to a person is the one they typed.
 *
 * A leaf module: it imports nothing else in `src/`.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

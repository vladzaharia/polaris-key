const EMAIL_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EMAIL_ADDR_SPEC = new RegExp(
  `^[a-z0-9!#$%&'*+/=?^_\`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_\`{|}~-]+)*@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL})+$`,
);

/** A bare ASCII addr-spec, trimmed and lower-cased, or `null` (see `parseEmail`). */
export function strictEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at > 64) return null;
  return EMAIL_ADDR_SPEC.test(email) ? email : null;
}

// Best-effort security-event rows for detection (who/what/when, never a secret).
// The worker has no console logging (test/attack/R12-secrets.test.ts), so a signal is an audit
// row. A row never carries a token, key, credential or address: `redactSummary` strips the
// shapes that could slip in through a caller's free text, and callers pass ids, never values.
// Recording never fails or delays the request it describes.

import type { Db } from "../db/types.js";
import { appendPlatformAudit } from "../repo.js";
import { randomId } from "../crypto.js";

const EMAIL = /[^\s@<>"']+@[^\s@<>"']+/g;
const LONG_SECRET = /\b[A-Za-z0-9_\-.]{32,}\b/g;

/** Strip email addresses and long opaque strings (tokens, keys) from free text; cap length. */
export function redactSummary(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(LONG_SECRET, "[redacted]")
    .slice(0, 300);
}

export interface SecurityEvent {
  action: string;
  /** The verified actor's opaque subject, when there is one. */
  sub?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  summary: string;
  now: number;
}

/** Append one `platform_audit` row for a security event. Swallows its own failure. */
export async function recordPlatformSecurityEvent(
  db: Db,
  ev: SecurityEvent,
): Promise<void> {
  try {
    await appendPlatformAudit(db, {
      id: randomId("paud"),
      at: ev.now,
      actor_sub: ev.sub ?? null,
      actor_name: null,
      actor_email: null,
      action: ev.action,
      target_kind: ev.targetKind ?? null,
      target_id: ev.targetId ?? null,
      summary: redactSummary(ev.summary),
      before_json: null,
      after_json: null,
    });
  } catch {
    // Detection must not become an outage.
  }
}

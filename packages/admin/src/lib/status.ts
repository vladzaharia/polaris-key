/**
 * The console's ONE status vocabulary (docs/design/admin/components.md §6.4), replacing the five
 * local maps (MTX-4, REL-6, CAT-9). Every server state a view shows maps here to a label, a tone
 * and an icon; `StatusPill` renders it, always as icon (or dot) plus text, never colour alone.
 *
 * Tones are status tokens (success, warning, danger, info), `neutral`, the section `accent`
 * (identity and chrome: a rollout in progress, a pinned compat cell), `signed` (gold: signed
 * things only) and `outline` (the compat matrix's "current" ring).
 */

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  CircleDot,
  Clock,
  Info,
  PauseCircle,
  Pin,
  RefreshCw,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";

export type Tone =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "accent"
  | "signed"
  | "outline";

export interface StatusEntry {
  label: string;
  tone: Tone;
  icon: LucideIcon;
}

/** The icon each tone uses unless a state names its own. */
export const TONE_ICON: Record<Tone, LucideIcon> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Circle,
  accent: RefreshCw,
  signed: ShieldCheck,
  outline: CircleDot,
};

const e = (label: string, tone: Tone, icon: LucideIcon = TONE_ICON[tone]) => ({
  label,
  tone,
  icon,
});

/** Domain → server state → entry. components.md §6.4, one row per domain. */
export const STATUS = {
  license: {
    active: e("Active", "success"),
    expired: e("Expired", "warning", Clock),
    disabled: e("Disabled", "neutral", Ban),
  },
  key: {
    active: e("Active", "success"),
    revoked: e("Revoked", "neutral", Ban),
  },
  device: {
    authorized: e("Authorized", "success"),
    deauthorized: e("Deauthorized", "neutral", Ban),
  },
  fingerprint: {
    verified: e("Verified", "success"),
    unverified: e("Unverified", "warning"),
    drifted: e("Drifted", "warning"),
  },
  rollout: {
    active: e("Rolling out", "accent", RefreshCw),
    paused: e("Paused", "warning", PauseCircle),
    halted: e("Halted", "danger"),
    complete: e("Complete", "success"),
  },
  availability: {
    live: e("Live", "success"),
    approved: e("Approved", "info"),
    "in-review": e("In review", "neutral", Clock),
    processing: e("Processing", "neutral", Clock),
    pending: e("Pending", "neutral", Clock),
    rejected: e("Rejected", "danger"),
    removed: e("Removed", "neutral", Ban),
  },
  readiness: {
    holds: e("Held", "warning"),
    warning: e("Not ready", "warning"),
    ok: e("Ready", "success"),
  },
  compat: {
    pinned: e("Pinned", "accent", Pin),
    compatible: e("Compatible", "success"),
    held: e("Held", "warning"),
    incompatible: e("Incompatible", "danger"),
    revoked: e("Revoked", "danger", Ban),
    current: e("Current", "outline", CircleDot),
  },
  edgeMint: {
    approved: e("Approved", "success"),
    pending: e("Needs approval", "warning", Clock),
    changed: e("Changed since approval", "danger", AlertTriangle),
  },
  secret: {
    configured: e("Configured", "success"),
    missing: e("Missing", "warning"),
  },
  source: {
    manifest: e("From manifest", "neutral"),
    admin: e("Set in console", "info"),
  },
} as const satisfies Record<string, Record<string, StatusEntry>>;

export type StatusDomain = keyof typeof STATUS;
export type StatusState<D extends StatusDomain> = keyof (typeof STATUS)[D] &
  string;

/**
 * The entry for a server state. An unknown state (a newer server) renders neutral with the raw
 * value humanised, never a crash and never a blank pill.
 */
export function statusOf<D extends StatusDomain>(
  domain: D,
  state: StatusState<D> | (string & {}),
): StatusEntry {
  const table = STATUS[domain] as Record<string, StatusEntry>;
  return (
    table[state] ?? {
      label: humanize(state),
      tone: "neutral",
      icon: TONE_ICON.neutral,
    }
  );
}

/** `in-review` → "In review"; `not_held` → "Not held". */
export function humanize(raw: string): string {
  const s = raw.replace(/[-_]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
}

/**
 * A license's display state (LIC-1): computed client-side from `status` + `expiresAt`. Expiring
 * within 14 days is a warning with the day count; past `expiresAt` is Expired.
 */
export function licenseState(
  license: { status: string; expiresAt?: number | null },
  now: number = Date.now(),
): StatusEntry {
  if (license.status === "disabled") return STATUS.license.disabled;
  if (license.expiresAt != null) {
    const ms = license.expiresAt * 1000;
    if (ms <= now) return STATUS.license.expired;
    const days = Math.ceil((ms - now) / 86_400_000);
    if (days <= 14) {
      return {
        label: `Expires in ${days} ${days === 1 ? "day" : "days"}`,
        tone: "warning",
        icon: Clock,
      };
    }
  }
  return STATUS.license.active;
}

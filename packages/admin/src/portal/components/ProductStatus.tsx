import * as React from "react";
import {
  AlertCircle,
  Check,
  Clock,
  KeyRound,
  User,
  type LucideIcon,
} from "lucide-react";
import { StatusPill } from "../../ui/StatusPill.js";
import { cn } from "../../lib/cn.js";
import type { ProductStatus as Status, StatusKind } from "../model/library.js";

const ICON: Record<StatusKind, LucideIcon> = {
  suspended: AlertCircle,
  expired: AlertCircle,
  deviceLimit: AlertCircle,
  keyNotActivated: KeyRound,
  expiresSoon: Clock,
  offlineGrace: AlertCircle,
  signedInApp: User,
  active: Check,
};

/** The tones that are issues: only these render as pills (EXPERIENCE §7). */
export function isIssueStatus(status: Status): boolean {
  return (
    status.tone === "danger" ||
    status.tone === "warning" ||
    status.tone === "info"
  );
}

/**
 * A product status (EXPERIENCE §7, §11.3). Issues render as a pill with icon and word; `onArt`
 * sits that pill on a solid plate so it reads over the art. A healthy status ("Active") renders
 * nothing. A neutral fact ("Signed-in app") renders as quiet text, and nothing on art: a plate
 * is for issues only.
 */
export function ProductStatusPill({
  status,
  onArt = false,
  className,
}: {
  status: Status;
  onArt?: boolean;
  className?: string;
}): React.ReactElement | null {
  if (status.tone === "success") return null;
  if (!isIssueStatus(status)) {
    if (onArt) return null;
    return (
      <span className={cn("text-sm text-fg-muted", className)}>
        {status.label}
      </span>
    );
  }
  const pill = (
    <StatusPill
      tone={status.tone}
      icon={ICON[status.kind]}
      className={cn("font-bold", className)}
    >
      {status.label}
    </StatusPill>
  );
  if (!onArt) return pill;
  return (
    <span className="inline-flex rounded-full bg-surface-overlay shadow-elevation-2">
      {pill}
    </span>
  );
}

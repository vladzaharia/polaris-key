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
  freeToUse: Check,
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
 * A product status (EXPERIENCE §7, §11.3). Issues render as a pill with icon and word, in the body
 * of a card, never on a customer's art (§7.3). A healthy status ("Active") renders nothing. A
 * neutral fact ("Signed-in app") renders as quiet text.
 */
export function ProductStatusPill({
  status,
  className,
}: {
  status: Status;
  className?: string;
}): React.ReactElement | null {
  if (status.tone === "success") return null;
  if (!isIssueStatus(status)) {
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
      className={cn("font-medium", className)}
    >
      {status.label}
    </StatusPill>
  );
  return pill;
}

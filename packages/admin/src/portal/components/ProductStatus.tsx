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

/** A product status as icon and word (§5.3); `onArt` sits it on a solid plate. */
export function ProductStatusPill({
  status,
  onArt = false,
  className,
}: {
  status: Status;
  onArt?: boolean;
  className?: string;
}): React.ReactElement {
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

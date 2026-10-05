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
  // On art: a solid plate with room around the word. A healthy status is quiet text, so the
  // plate is its frame and carries the padding; an attention pill is its own frame, made as tall.
  return (
    <span
      className={cn(
        "inline-flex h-8 items-center rounded-full bg-surface-overlay shadow-elevation-2",
        status.tone === "success" && "px-3.5",
      )}
    >
      {status.tone === "success" ? (
        pill
      ) : (
        <StatusPill
          tone={status.tone}
          icon={ICON[status.kind]}
          className={cn("h-8 px-3.5 font-bold", className)}
        >
          {status.label}
        </StatusPill>
      )}
    </span>
  );
}

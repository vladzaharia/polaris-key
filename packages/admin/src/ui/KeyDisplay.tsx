import * as React from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleOff,
  Clock,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { formatDate } from "../lib/format.js";
import { ValueCopyButton } from "./IdChip.js";
import { SignedBadge } from "./SignedBadge.js";
import { StatusPill } from "./StatusPill.js";

export type SigningKeyStatus = "staged" | "active" | "retired" | "revoked";

export interface KeyDisplayProps {
  label: string;
  /**
   * - `public`: the full value, wrapped, with copy.
   * - `secret`: never a value (stored secrets are write-only): "Configured · 3 Sep 2026" or
   *   "Not set".
   * - `signing`: a public key plus the gold signed glyph, the kid and the key's status.
   */
  kind: "public" | "secret" | "signing";
  value?: string;
  /** `secret` only: whether a value is stored. */
  configured?: boolean;
  /** `secret` only: when it was last set, epoch ms. */
  updatedAt?: number;
  /** `signing` only. */
  status?: SigningKeyStatus;
  kid?: string;
  className?: string;
}

const STATUS: Record<
  SigningKeyStatus,
  { label: string; tone: "success" | "info" | "neutral"; icon: LucideIcon }
> = {
  active: { label: "Active", tone: "success", icon: CircleCheck },
  staged: { label: "Staged", tone: "info", icon: Clock },
  retired: { label: "Retired", tone: "neutral", icon: CircleDashed },
  revoked: { label: "Revoked", tone: "neutral", icon: CircleOff },
};

/** A key or secret, shown as safely as its kind allows (components.md §6.9). */
export function KeyDisplay({
  label,
  kind,
  value,
  configured = false,
  updatedAt,
  status,
  kid,
  className,
}: KeyDisplayProps): React.ReactElement {
  const id = React.useId();
  return (
    <div
      className={cn("space-y-1", className)}
      role="group"
      aria-labelledby={id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={id} className="text-xs font-bold text-fg-muted">
          {label}
        </span>
        {kind === "signing" ? <SignedBadge kid={kid} by="signing key" /> : null}
        {kind === "signing" && status ? (
          <StatusPill tone={STATUS[status].tone} icon={STATUS[status].icon}>
            {STATUS[status].label}
          </StatusPill>
        ) : null}
      </div>
      {kind === "secret" ? (
        <p className="flex items-center gap-1.5 text-sm text-fg">
          <KeyRound aria-hidden className="size-4 text-fg-subtle" />
          {configured ? (
            <span>
              Configured
              {updatedAt !== undefined ? ` · ${formatDate(updatedAt)}` : ""}
            </span>
          ) : (
            <span className="text-fg-muted">Not set</span>
          )}
        </p>
      ) : value ? (
        <div className="flex items-center gap-1 rounded-md bg-surface-sunken py-1 pl-3 pr-1">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg-strong">
            {value}
          </code>
          <ValueCopyButton
            value={value}
            label={`Copy ${label.toLowerCase()}`}
          />
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Not available</p>
      )}
    </div>
  );
}

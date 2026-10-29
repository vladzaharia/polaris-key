/**
 * Distribute flow: the context every step receives, the step title and the date parser.
 * Split out of `components/AscDistribute.tsx`.
 */

import * as React from "react";
import type { AscBuildDto, AscVersionDto } from "../../../../api.js";
import { type AscIntent } from "./ascShared.js";

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────

export const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export interface StepCtx {
  slug: string;
  appleId: string;
  build: AscBuildDto | null;
  version: AscVersionDto | null;
  open: (i: AscIntent, body?: React.ReactNode) => void;
}

export function StepTitle({
  children,
  description,
  action,
}: {
  children: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <h2
          id="wizard-step-title"
          className="text-lg font-semibold text-fg-strong [overflow-wrap:anywhere]"
        >
          {children}
        </h2>
        {description ? (
          <p className="text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ── 1. Build ──────────────────────────────────────────────────────────────────────────────────

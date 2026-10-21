import * as React from "react";
import { ChevronDown, Settings2, SlidersHorizontal } from "lucide-react";
import type { ServicesResponse } from "../../../../api.js";
import { SERVICE_SLUGS } from "../../../../services.generated.js";
import { cn } from "../../../../lib/cn.js";
import { REGISTRATION_LABELS } from "../../../../lib/labels.js";
import { Unlocked } from "../../../../ui/WriteLock.js";
import { Button } from "../../../../ui/Button.js";
import { serviceLabel } from "../../../../ui/ServiceBadge.js";
import type { Enabled } from "./serviceFeatures.js";

function FoldedRow({
  id,
  icon,
  title,
  open,
  controls,
  onToggle,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  open: boolean;
  /** The id of the panel this row opens (its own, or one the page renders below). */
  controls: string;
  onToggle: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <Unlocked>
      <div id={id} className="border-t border-border px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            aria-hidden
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface-sunken text-fg-muted"
          >
            {icon}
          </span>
          <p
            id={`${id}-title`}
            className="min-w-0 flex-[1_1_8rem] hyphens-manual break-words text-base font-medium text-fg-strong"
          >
            {title}
          </p>
          <Button
            variant="ghost"
            size="sm"
            id={`${id}-button`}
            aria-expanded={open}
            aria-controls={controls}
            aria-labelledby={`${id}-button ${id}-title`}
            iconEnd={
              <ChevronDown
                aria-hidden
                className={cn("transition-transform", open && "rotate-180")}
              />
            }
            onClick={onToggle}
          >
            {open ? "Hide" : "Show"}
          </Button>
        </div>
        {open && children ? (
          <div id={controls} className="mt-3 pl-12">
            {children}
          </div>
        ) : null}
      </div>
    </Unlocked>
  );
}

/**
 * The two folded rows at the foot of the feature list: the raw service slugs with the derived
 * registration (read-only), and the product's own settings (name, origins, repository, danger
 * zone), which unfold below the list.
 */
export function AdvancedRows({
  enabled,
  effectiveRegistration,
  detailsOpen,
  onDetails,
}: {
  enabled: Enabled;
  effectiveRegistration: ServicesResponse["effectiveRegistration"];
  detailsOpen: boolean;
  onDetails: (open: boolean) => void;
}): React.ReactElement {
  const [slugsOpen, setSlugsOpen] = React.useState(false);
  return (
    <>
      <FoldedRow
        id="feature-slugs"
        icon={<SlidersHorizontal aria-hidden className="size-4" />}
        title="Slugs and device registration"
        controls="feature-slugs-panel"
        open={slugsOpen}
        onToggle={() => setSlugsOpen((o) => !o)}
      >
        <dl className="max-w-md space-y-2 text-sm">
          {SERVICE_SLUGS.map((service) => (
            <div key={service} className="flex justify-between gap-4">
              <dt className="text-fg-muted">{serviceLabel(service)}</dt>
              <dd className="font-medium text-fg-strong">
                {enabled[service] ? "On" : "Off"}
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t border-border pt-2">
            <dt className="text-fg-muted">Device registration</dt>
            <dd className="font-medium text-fg-strong">
              {REGISTRATION_LABELS[effectiveRegistration] ??
                effectiveRegistration}
            </dd>
          </div>
        </dl>
      </FoldedRow>
      <FoldedRow
        id="feature-details"
        icon={<Settings2 aria-hidden className="size-4" />}
        title="Name, origins, repository and danger zone"
        controls="feature-details-panel"
        open={detailsOpen}
        onToggle={() => onDetails(!detailsOpen)}
      />
    </>
  );
}

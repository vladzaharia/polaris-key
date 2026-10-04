import * as React from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { announce } from "../../ui/LiveRegion.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import { useStartDownload } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import type { LibraryProduct, QuickAction } from "../model/library.js";

/**
 * The one next action for a product (§5.4) as a button. Outlined (`quiet`) on tiles and rows;
 * the hero and the product header pass `lead` for the solid primary.
 */
export function QuickActionButton({
  product,
  action,
  lead = false,
  twoLine = false,
  size = "lg",
  className,
}: {
  product: LibraryProduct;
  action: QuickAction;
  lead?: boolean;
  /** The hero's two-line download button (label, then version · arch · size). */
  twoLine?: boolean;
  size?: "md" | "lg";
  className?: string;
}): React.ReactElement {
  const start = useStartDownload();
  const variant = lead ? "primary" : "quiet";
  if (action.kind === "download") {
    const onClick = (): void => {
      start.mutate(
        {
          product: product.slug,
          releaseId: action.release.releaseId,
          artifactId: action.artifact.artifactId,
        },
        {
          onSuccess: () =>
            announce(`Downloading ${product.name} ${action.release.version}`),
          onError: (err) =>
            toast.error("The download didn't start", {
              description: portalErrorCopy(err).description,
            }),
        },
      );
    };
    return (
      <Button
        variant={variant}
        size={size}
        loading={start.isPending}
        iconStart={<Download aria-hidden />}
        onClick={onClick}
        aria-label={`${action.label}: ${product.name} ${action.detail}`}
        className={cn(twoLine && "h-auto flex-col gap-0 py-2", className)}
      >
        {twoLine ? (
          <>
            <span className="text-base font-bold">{action.label}</span>
            <span className="text-xs font-normal opacity-90">
              {action.detail}
            </span>
          </>
        ) : (
          <span className="font-bold">{action.label}</span>
        )}
      </Button>
    );
  }
  const Icon =
    action.icon === "downloads"
      ? Download
      : action.icon === "open"
        ? ExternalLink
        : FileText;
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a
        href={action.href}
        {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
        aria-label={`${action.label}: ${product.name}`}
      >
        <Icon aria-hidden />
        <span className="font-bold">{action.label}</span>
      </a>
    </Button>
  );
}

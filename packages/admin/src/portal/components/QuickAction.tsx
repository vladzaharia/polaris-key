import * as React from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Laptop,
  Mail,
  ShoppingBag,
} from "lucide-react";
import { Button } from "../../ui/Button.js";
import { announce } from "../../ui/LiveRegion.js";
import { toast } from "../../ui/toast.js";
import { cn } from "../../lib/cn.js";
import { useEmailDownload, useStartDownload } from "../data.js";
import { portalErrorCopy } from "../errors.js";
import {
  osName,
  type LibraryProduct,
  type QuickAction,
} from "../model/library.js";
import { settleAction } from "../model/product.js";
import { useRoute } from "../router.js";

/**
 * The one next action for a product (§5.4) as a button. Outlined (`quiet`) on tiles and rows;
 * the hero and the product header pass `lead` for the solid primary. A product without downloads
 * offers "Get it from <developer>", and a "View details" that would point at the page already
 * open renders nothing (`settleAction`, §0.6 P3).
 *
 * `shortLabel` (the compact library tile, PORTAL.md §4.15): inside a `@container` narrower than
 * 15rem, "Download for <OS>" reads "Download". The accessible name keeps the full label.
 */
export function QuickActionButton({
  product,
  action: proposed,
  lead = false,
  twoLine = false,
  shortLabel = false,
  size = "lg",
  className,
}: {
  product: LibraryProduct;
  action: QuickAction;
  lead?: boolean;
  /** The hero's two-line download button (label, then version · arch · size). */
  twoLine?: boolean;
  /** "Download" for "Download for <OS>" in a container under 15rem (the compact tile). */
  shortLabel?: boolean;
  size?: "md" | "lg";
  className?: string;
}): React.ReactElement | null {
  const start = useStartDownload();
  const email = useEmailDownload();
  const route = useRoute();
  const action = settleAction(product, proposed, route);
  if (!action) return null;
  const variant = lead ? "primary" : "quiet";
  if (action.kind === "email") {
    const onClick = (): void => {
      email.mutate(
        { product: product.slug, platform: action.platform },
        {
          onSuccess: () =>
            toast.success("Check your email", {
              description: `We sent you the link to download ${product.name} for ${osName(action.platform)}.`,
            }),
          onError: (err) =>
            toast.error("The email didn't go out", {
              description: portalErrorCopy(err).description,
            }),
        },
      );
    };
    return (
      <Button
        variant={variant}
        size={size}
        loading={email.isPending}
        iconStart={<Mail aria-hidden />}
        onClick={onClick}
        aria-label={`${action.label}: ${product.name} for ${osName(action.platform)}`}
        className={className}
      >
        <span className="font-medium">{action.label}</span>
      </Button>
    );
  }
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
        iconStart={twoLine ? undefined : <Download aria-hidden />}
        onClick={onClick}
        aria-label={`${action.label}: ${product.name} ${action.detail}`}
        className={cn(twoLine && "h-auto flex-col gap-0 py-2", className)}
      >
        {twoLine ? (
          <>
            <span className="flex items-center gap-2 text-base font-semibold">
              <Download aria-hidden className="size-5" />
              {action.label}
            </span>
            <span className="text-xs font-normal opacity-90">
              {action.detail}
            </span>
          </>
        ) : (
          <Label label={action.label} short={shortLabel} />
        )}
      </Button>
    );
  }
  const Icon =
    action.icon === "downloads"
      ? Download
      : action.icon === "open"
        ? ExternalLink
        : action.icon === "store"
          ? ShoppingBag
          : action.icon === "device"
            ? Laptop
            : FileText;
  return (
    <Button asChild variant={variant} size={size} className={className}>
      <a
        href={action.href}
        {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
        aria-label={`${action.label}: ${product.name}`}
      >
        <Icon aria-hidden />
        <Label label={action.label} short={shortLabel} />
      </a>
    </Button>
  );
}

/** The visible label; with `short`, "Download for <OS>" gives way to "Download" under 15rem. */
function Label({
  label,
  short,
}: {
  label: string;
  short: boolean;
}): React.ReactElement {
  if (!short || !label.startsWith("Download for "))
    return <span className="font-medium">{label}</span>;
  return (
    <>
      <span className="font-medium @[15rem]:hidden">Download</span>
      <span className="hidden font-medium @[15rem]:inline">{label}</span>
    </>
  );
}

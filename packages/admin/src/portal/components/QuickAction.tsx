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
  const email = useEmailDownload();
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
        <span className="font-bold">{action.label}</span>
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
            <span className="flex items-center gap-2 text-base font-bold">
              <Download aria-hidden className="size-5" />
              {action.label}
            </span>
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
        <span className="font-bold">{action.label}</span>
      </a>
    </Button>
  );
}

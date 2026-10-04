import * as React from "react";
import {
  FileText,
  Link2,
  MonitorSmartphone,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/index.js";
import { toast } from "../../ui/toast.js";
import { href } from "../router.js";

/** A product's overflow menu ("More for Nightfall", §9.2) on tiles and the product header. */
export function ProductMenu({
  slug,
  name,
  onPage = false,
  className,
}: {
  slug: string;
  name: string;
  /** On the product page: no "Open … page" item. */
  onPage?: boolean;
  className?: string;
}): React.ReactElement {
  const copyLink = (): void => {
    const url = `${window.location.origin}/${href.product(slug)}`;
    void navigator.clipboard?.writeText(url).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${name}`}
          className={
            className ??
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-border-strong text-fg-strong hover:bg-hover"
          }
        >
          <MoreHorizontal aria-hidden className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {onPage ? null : (
          <DropdownMenuItem asChild>
            <a href={href.product(slug)}>
              <FileText aria-hidden />
              License, devices and versions
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a href={href.product(slug, "devices")}>
            <MonitorSmartphone aria-hidden />
            Manage devices
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copyLink}>
          <Link2 aria-hidden />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

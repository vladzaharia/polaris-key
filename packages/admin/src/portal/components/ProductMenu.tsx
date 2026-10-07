import * as React from "react";
import {
  FileText,
  Link2,
  CircleMinus,
  MonitorSmartphone,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/DropdownMenu.js";
import { toast } from "../../ui/toast.js";
import { href } from "../router.js";

/**
 * A product's overflow menu ("More for Nightfall", §9.2) on tiles and the product header. On the
 * product page it ends with **Remove from my library** (§4.20, PX-23), which asks first. An open
 * product's entry (PS-04) has no licence or devices: its menu is the page, Copy link and **Remove
 * from library** (on its tile too), which asks first, inline.
 */
export function ProductMenu({
  slug,
  name,
  onPage = false,
  entry = false,
  onRemove,
  triggerRef,
  className,
}: {
  slug: string;
  name: string;
  /** On the product page: no "Open … page" item. */
  onPage?: boolean;
  /** An open product's library entry: no licence or device items. */
  entry?: boolean;
  /** Opens the Remove from library confirmation. */
  onRemove?: () => void;
  /** The trigger, for a confirmation that hands focus back to it when cancelled. */
  triggerRef?: React.Ref<HTMLButtonElement>;
  className?: string;
}): React.ReactElement {
  // An entry's Remove opens an inline confirmation that takes focus itself: closing the menu must
  // not hand focus back to this trigger behind it.
  const removing = React.useRef(false);
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
          ref={triggerRef}
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
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        onCloseAutoFocus={(e) => {
          if (!removing.current) return;
          removing.current = false;
          e.preventDefault();
        }}
      >
        {onPage ? null : (
          <DropdownMenuItem asChild>
            <a href={href.product(slug)}>
              <FileText aria-hidden />
              {entry
                ? "Details and downloads"
                : "License, devices and versions"}
            </a>
          </DropdownMenuItem>
        )}
        {entry ? null : (
          <DropdownMenuItem asChild>
            <a href={href.product(slug, "devices")}>
              <MonitorSmartphone aria-hidden />
              Manage devices
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={copyLink}>
          <Link2 aria-hidden />
          Copy link
        </DropdownMenuItem>
        {onRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onSelect={() => {
                // An entry's confirmation is inline and focuses itself; a licence's is a dialog,
                // which manages focus as it always has.
                removing.current = entry;
                onRemove();
              }}
            >
              <CircleMinus aria-hidden />
              {entry ? "Remove from library" : "Remove from my library"}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

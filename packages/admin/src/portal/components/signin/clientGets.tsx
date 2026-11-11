import * as React from "react";
import {
  BadgeCheck,
  Check,
  EyeOff,
  ImageIcon,
  Mail,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { t } from "../../../lib/copy.js";

/** The glyph of each item a registered client can get: the consent card's rows and Connected apps. */
export const CLIENT_GLYPH = {
  name: UserRound,
  picture: ImageIcon,
  email: Mail,
  entitlements: BadgeCheck,
  offline: RefreshCw,
} as const;

export type ClientGetItem = keyof typeof CLIENT_GLYPH;

/** An item's words as the consent card says them ("Your screen name", "Which Quill features you have"). */
export function clientGetText(item: ClientGetItem, product: string): string {
  if (item === "entitlements")
    return t("locker.issuer.entitlements", { product });
  if (item === "offline") return t("locker.issuer.offline");
  return t(`locker.issuer.claim.${item}`);
}

/**
 * One item of what an app gets, as a chip (Connected apps). Granted: filled, with a tick. Declined:
 * dashed, with an eye-off and "Not your picture". The icon and the word say it, never the colour.
 */
export function GetChip({
  item,
  granted,
  product,
}: {
  item: ClientGetItem;
  granted: boolean;
  product: string;
}): React.ReactElement {
  const Icon = granted ? Check : EyeOff;
  return (
    <li
      data-get={item}
      data-granted={granted ? "" : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm/5 [overflow-wrap:anywhere]",
        granted
          ? "border-border-strong bg-surface-sunken text-fg-strong"
          : "border-dashed border-border-strong text-fg-muted",
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {granted
        ? clientGetText(item, product)
        : t(`locker.apps.not.${item as "name" | "picture" | "email"}`)}
    </li>
  );
}

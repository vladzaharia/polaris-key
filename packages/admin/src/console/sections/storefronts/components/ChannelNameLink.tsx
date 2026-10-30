/**
 * A store's name as a link to its channel page (A-22.7): Sales when the channel has that tab,
 * else Status. Resting underline and a chevron, so it reads as a link without hover.
 */

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { useChannels } from "../../distribution/data.js";
import { hasSales } from "../../distribution/components/ChannelSales.js";

export function ChannelNameLink({
  slug,
  id,
  sales = false,
  children,
}: {
  slug: string;
  id: string;
  /** The store is one Commerce sells through: Sales, without asking the channel read. */
  sales?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const row = useChannels(slug).data?.channels?.find((c) => c.id === id);
  return (
    <Link
      to={
        sales || (row && hasSales(row))
          ? r.channel(slug, id, "sales")
          : r.channel(slug, id)
      }
      className="inline-flex min-h-6 items-center gap-0.5 text-accent-fg underline underline-offset-4"
    >
      {children}
      <ChevronRight className="size-4" aria-hidden />
    </Link>
  );
}

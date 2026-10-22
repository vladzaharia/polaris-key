/**
 * Platform → Activity's event drawer (admin.platform-activity-event): before and after, who, when
 * and which product. An event outside the loaded pages (a pasted link) is read by id.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import {
  api,
  type PlatformActivityItem,
  type ProductDetail,
} from "../../../../api.js";
import { formatIso, fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  routedDrawer,
} from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { qk } from "../../../data/queries.js";
import { navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { actorName, whatOf } from "./platformActivityParts.js";

/** A before or after value as the Worker stored it: plain values as text, anything else compact JSON. */
function valueText(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return String(v);
  return (
    <code className="break-all font-mono text-xs">{JSON.stringify(v)}</code>
  );
}

export function EventDrawer({
  id,
  loaded,
  products,
  onClose,
}: {
  id: string | undefined;
  loaded: PlatformActivityItem[];
  products: Map<string, ProductDetail>;
  onClose: () => void;
}): React.ReactElement {
  const known = id ? loaded.find((i) => i.id === id) : undefined;
  const fetched = useQuery({
    queryKey: qk.platformActivityEvent(id ?? ""),
    queryFn: () => api.platformActivity(null, { product: "all", id }, 1),
    enabled: Boolean(id) && !known,
  });
  const item = known ?? fetched.data?.items[0];
  const missing = Boolean(id) && !known && !fetched.isPending && !item;
  const product = item?.product ? products.get(item.product) : undefined;
  const before = valueText(item?.before);
  const after = valueText(item?.after);
  return (
    <Drawer
      {...routedDrawer(id, onClose)}
      title={item ? whatOf(item) : "Event"}
    >
      <DrawerBody className="space-y-4">
        {fetched.isError && !item ? (
          <ErrorState
            compact
            error={fetched.error}
            onRetry={() => void fetched.refetch()}
          />
        ) : missing ? (
          <p className="text-sm text-fg-muted">
            This event is no longer in the log.
          </p>
        ) : !item ? (
          <div aria-hidden className="pk-skeleton-group space-y-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <DescriptionList
            items={[
              ...(before ? [{ term: "Before", detail: before }] : []),
              ...(after
                ? [{ term: "After", detail: <strong>{after}</strong> }]
                : []),
              {
                term: "Who",
                detail: item.actor.email
                  ? `${actorName(item)} · ${item.actor.email}`
                  : actorName(item),
              },
              {
                term: "When",
                detail: (
                  <time dateTime={formatIso(fromSeconds(item.at))}>
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeStyle: "long",
                    }).format(fromSeconds(item.at))}
                  </time>
                ),
              },
              {
                term: "Product",
                detail: item.product
                  ? (product?.name ?? item.product)
                  : "Platform",
              },
              {
                term: "Action",
                detail: (
                  <code className="font-mono text-xs">{item.action}</code>
                ),
              },
              ...(item.target?.id
                ? [
                    {
                      term: "Target",
                      detail: (
                        <span className="font-mono text-xs">
                          {item.target.kind} · {item.target.id}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </DrawerBody>
      {item && item.action.startsWith("platform.setting.") ? (
        <DrawerFooter>
          <Button
            variant="outline"
            onClick={() => navigate(r.platformSettings())}
            iconEnd={<ArrowRight aria-hidden />}
          >
            Open the setting
          </Button>
        </DrawerFooter>
      ) : null}
    </Drawer>
  );
}

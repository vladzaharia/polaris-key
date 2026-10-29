/**
 * Platform → Status: the Services card, one row per opt-in service with the products that enable
 * it and its last failed scheduled step (`GET /platform/operations` `services`).
 */

import * as React from "react";
import type { PlatformOperations, ServiceSlug } from "../../../../api.js";
import { formatCount } from "../../../../lib/format.js";
import { ServiceGlyph, serviceLabel } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Panel } from "../../../templates/Dashboard.js";
import { CardRows, Loaded } from "./platformStatusParts.js";

export function ServicesCard({
  op,
  error,
  onRetry,
}: {
  op: PlatformOperations | undefined;
  error: unknown;
  onRetry: () => void;
}): React.ReactElement {
  const rows = op?.services;
  return (
    <Panel title="Services">
      <Loaded data={op ? true : undefined} error={error} onRetry={onRetry}>
        {rows == null ? (
          <p className="text-sm text-fg-muted">Could not be read.</p>
        ) : (
          <CardRows label="Services">
            {rows.map((s) => (
              <li
                key={s.slug}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
              >
                <ServiceGlyph id={s.slug as ServiceSlug} />
                <div className="min-w-0 flex-[1_1_10rem]">
                  <div className="font-medium text-fg-strong">
                    {serviceLabel(s.slug as ServiceSlug)}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {s.productsEnabled === 0
                      ? "No products"
                      : `${formatCount(s.productsEnabled)} ${s.productsEnabled === 1 ? "product" : "products"}`}
                    {s.lastError ? (
                      <>
                        {" "}
                        · {s.lastError.error ?? "failed"}{" "}
                        <Timestamp at={s.lastError.at} format="relative" />
                      </>
                    ) : null}
                  </div>
                </div>
                {s.lastError ? (
                  <StatusPill tone="danger" size="sm">
                    Failed
                  </StatusPill>
                ) : null}
              </li>
            ))}
          </CardRows>
        )}
      </Loaded>
    </Panel>
  );
}

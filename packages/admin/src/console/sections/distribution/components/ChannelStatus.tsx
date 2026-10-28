/**
 * A channel's Status tab (A-22.1): its delivery state, what needs attention, the platforms it
 * serves and, for a store, the app its purchases belong to. Facts only, from the read model;
 * no secret or credential value is ever in it.
 */

import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Section } from "../../../../ui/Section.js";
import { Link } from "../../../router.js";
import {
  attentionLine,
  DELIVERY_LINE,
  humanField,
} from "../model/channelCopy.js";
import type { ChannelTabProps } from "./channelTabs.js";

export function ChannelStatus({
  slug,
  name,
  channel,
}: ChannelTabProps): React.ReactElement {
  const { delivery, identity } = channel;
  const lines = delivery.attention.map((a) =>
    attentionLine(a, slug, name, channel.id),
  );
  const fields = identity ? Object.entries(identity.fields) : [];
  // Out of scope is said once, by its reason line: no state sentence, no rail.
  const scoped = channel.inScope;
  return (
    // Wraps instead of switching at a breakpoint, so the rail drops under the main column whenever
    // both do not fit, at any text size.
    <div className="flex flex-wrap items-start gap-6">
      <div className="min-w-0 grow-[999] basis-[32rem]">
        <Section title="Delivery">
          {scoped ? (
            <p className="text-sm font-medium text-fg-strong">
              {DELIVERY_LINE[delivery.state]}
            </p>
          ) : null}
          {lines.length ? (
            <ul
              aria-label="Needs attention"
              className={scoped ? "mt-4 space-y-3" : "space-y-3"}
            >
              {lines.map((l) => (
                <li
                  key={l.title}
                  className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm"
                >
                  {scoped ? (
                    <TriangleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-warning"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="font-medium text-fg-strong">
                      {l.title}
                    </span>
                    <span className="text-fg-muted"> · {l.detail}</span>
                  </span>
                  {l.action ? (
                    <Link
                      to={l.action.to}
                      className="inline-flex min-h-6 items-center text-accent-fg underline underline-offset-4"
                    >
                      {l.action.label}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </div>
      {fields.length ? (
        <Section
          className="sticky top-4 min-w-0 grow basis-80"
          title="App"
          description={
            identity?.source === "assigned"
              ? "Assigned from the platform pin."
              : "Typed in the channel entry."
          }
        >
          <DescriptionList
            rows
            items={fields.map(([k, v]) => ({
              term: humanField(k),
              detail: <span className="font-mono text-xs break-all">{v}</span>,
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

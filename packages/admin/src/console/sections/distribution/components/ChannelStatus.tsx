/**
 * A channel's Status tab (A-22.1): its delivery state, what needs attention, the platforms it
 * serves and, for a store, the app its purchases belong to. Facts only, from the read model;
 * no secret or credential value is ever in it.
 */

import * as React from "react";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Section } from "../../../../ui/Section.js";
import { platformName } from "../../../../lib/vocab/platforms.js";
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
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-6">
        <Section title="Delivery">
          <p className="text-sm text-fg-muted">
            {DELIVERY_LINE[delivery.state]}
          </p>
          {lines.length ? (
            <ul aria-label="Needs attention" className="mt-4 space-y-3">
              {lines.map((l) => (
                <li key={l.title} className="text-sm">
                  <span className="font-medium text-fg-strong">{l.title}</span>
                  <span className="text-fg-muted"> · {l.detail}</span>
                  {l.action ? (
                    <>
                      {" "}
                      <Link
                        to={l.action.to}
                        className="text-accent-fg underline-offset-4 hover:underline"
                      >
                        {l.action.label}
                      </Link>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
        <Section title="Platforms">
          {delivery.platforms.length ? (
            <DescriptionList
              rows
              items={delivery.platforms.map((p) => ({
                term: platformName(p.platform),
                detail: p.arches.length ? p.arches.join(", ") : "Any",
              }))}
            />
          ) : (
            <p className="text-sm text-fg-muted">
              No platform of {name} is sent here.
            </p>
          )}
        </Section>
      </div>
      {fields.length ? (
        <Section
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
              detail: <span className="font-mono text-xs">{v}</span>,
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}

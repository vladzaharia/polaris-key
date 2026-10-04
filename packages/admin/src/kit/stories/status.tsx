import { STATUS, type StatusDomain } from "../../lib/status.js";
import { SERVICE_TABLE } from "../../services.generated.js";
import { ServiceBadge } from "../../ui/ServiceBadge.js";
import { SignedBadge } from "../../ui/SignedBadge.js";
import { SourceBadge } from "../../ui/SourceBadge.js";
import { StatusPill } from "../../ui/StatusPill.js";
import type { Story } from "../types.js";

const DOMAINS = Object.keys(STATUS) as StatusDomain[];
const AT = Date.UTC(2026, 8, 28, 14, 5);

export const stories: Story[] = [
  {
    id: "status-pills",
    group: "Status and badges",
    title: "StatusPill: every domain",
    description:
      "lib/status.ts maps each server state to a label, a tone and an icon, so colour is never the only signal.",
    render: () => (
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        {DOMAINS.map((domain) => (
          <div key={domain} className="contents">
            <dt className="text-sm font-bold text-fg-strong">{domain}</dt>
            <dd className="flex flex-wrap gap-2">
              {Object.keys(STATUS[domain]).map((state) => (
                <StatusPill key={state} domain={domain} state={state} />
              ))}
            </dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: "status-pill-sizes",
    group: "Status and badges",
    title: "StatusPill: sizes and an unknown state",
    description:
      "An unknown server state still renders, humanized and neutral, rather than breaking the row.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill domain="license" state="active" size="sm" />
        <StatusPill domain="license" state="active" size="md" />
        <StatusPill domain="rollout" state="halted" size="md" />
        <StatusPill domain="availability" state="awaiting_store_review" />
      </div>
    ),
  },
  {
    id: "signed-badges",
    group: "Status and badges",
    title: "SignedBadge",
    description:
      "Gold means signed, nothing else. Badge, chip and the verified wording.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <SignedBadge />
        <SignedBadge kid="rk-2026-09" by="release key" />
        <SignedBadge variant="chip" kid="ck-2026-10" by="content key" />
        <SignedBadge verified kid="rk-2026-09" by="release key" />
      </div>
    ),
  },
  {
    id: "service-badges",
    group: "Status and badges",
    title: "ServiceBadge",
    description:
      "Each service's glyph in its approved accent, scoped by data-service.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <ServiceBadge id="core" />
        {SERVICE_TABLE.map((s) => (
          <ServiceBadge key={s.slug} id={s.slug} />
        ))}
      </div>
    ),
  },
  {
    id: "source-badges",
    group: "Status and badges",
    title: "SourceBadge",
    description:
      "Where a value comes from. The popover explains it, and a console value offers Revert.",
    render: () => (
      <div className="flex flex-wrap items-center gap-3">
        <SourceBadge source="manifest" path=".pkey/schema" />
        <SourceBadge
          source="admin"
          by="ops@example.com"
          at={AT}
          onRevert={() => undefined}
        />
        <SourceBadge source="default" />
        <SourceBadge source="deploy" />
        <SourceBadge
          source="runtime"
          by="ops@example.com"
          at={AT}
          onRevert={() => undefined}
        />
      </div>
    ),
  },
];

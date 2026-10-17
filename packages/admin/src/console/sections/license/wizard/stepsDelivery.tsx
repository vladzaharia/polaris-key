/**
 * New license (LX-29): the Delivery and Review steps. Split from `steps.tsx` to stay under the
 * page budget.
 */

import * as React from "react";
import {
  AutoList,
  ChoiceStep,
  type AutoItem,
} from "../../../../ui/wizard/index.js";
import {
  deliveriesFor,
  deliveryOf,
  emailsKey,
  type Delivery,
  type StepId,
} from "./draft.js";
import type { StepProps } from "./steps.js";

// ── Delivery ───────────────────────────────────────────────────────────────────────────────────

const DELIVERY_COPY: Record<
  Delivery,
  { label: string; hint: (to: string) => string }
> = {
  "email-show": {
    label: "Email the key and show it once",
    hint: (to) => `${to} gets it now. You can copy it too.`,
  },
  email: {
    label: "Email the key",
    hint: (to) => `Only ${to} sees it.`,
  },
  show: { label: "Show it once", hint: () => "Copy it and send it yourself." },
  csv: {
    label: "Download a CSV",
    hint: () => "The keys, with their license ids, as one file.",
  },
};

export function DeliveryStep({
  draft,
  set,
  productName,
}: StepProps & { productName: string }): React.ReactElement {
  const fits = deliveriesFor(draft);
  const current = deliveryOf(draft);
  const to = draft.name.trim() || draft.email.trim() || "They";
  return (
    <div className="space-y-4">
      {fits.length > 1 ? (
        <ChoiceStep<Delivery>
          legend="Delivery"
          columns={1}
          value={current}
          onChange={(v) => set("delivery", v)}
          choices={fits.map((d, i) => ({
            value: d,
            label: DELIVERY_COPY[d].label,
            description: DELIVERY_COPY[d].hint(to),
            ...(i === 0 && draft.who === "person" ? { recommended: "" } : {}),
          }))}
        />
      ) : (
        <p className="text-sm text-fg">{DELIVERY_COPY[current].hint(to)}</p>
      )}
      {draft.who === "anyone" ? (
        <p className="text-sm text-fg-muted">
          Floating keys aren&apos;t emailed: there&apos;s nobody to send them
          to.
        </p>
      ) : null}
      {emailsKey(draft) ? (
        <EmailPreview
          productName={productName}
          to={draft.email.trim()}
          name={draft.name.trim()}
        />
      ) : null}
    </div>
  );
}

/** What the email looks like, with the key masked (it does not exist yet). */
function EmailPreview({
  productName,
  to,
  name,
}: {
  productName: string;
  to: string;
  name: string;
}): React.ReactElement {
  return (
    <figure
      aria-label="Email preview"
      className="overflow-hidden rounded-lg border border-border bg-surface-sunken text-sm"
    >
      <figcaption className="border-b border-border px-3 py-2">
        <p className="font-medium text-fg-strong">
          {productName} via Polaris Key
        </p>
        <p className="break-all text-xs text-fg-muted">
          To {to} · Your {productName} license
        </p>
      </figcaption>
      <div className="space-y-2 px-3 py-3">
        <p>
          {name ? `Hi ${name}, here` : "Here"} is your {productName} license.
        </p>
        <p
          aria-hidden
          className="rounded-md bg-surface-overlay px-2 py-1.5 font-mono text-xs text-fg-muted"
        >
          pkey_{"•".repeat(20)}
        </p>
        <p className="text-xs text-fg-muted">
          Paste it into {productName} when it asks, or sign in with this email.
        </p>
      </div>
    </figure>
  );
}

// ── Review ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviewRow {
  label: string;
  value: string;
  step: StepId;
}

export function ReviewStep({
  rows,
  items,
  onChange,
  error,
}: {
  rows: readonly ReviewRow[];
  items: readonly AutoItem[];
  onChange: (step: StepId) => void;
  error?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      {error}
      <dl className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
          >
            <dt className="w-24 shrink-0 text-xs text-fg-muted">{row.label}</dt>
            <dd className="min-w-0 flex-1 break-words text-sm text-fg-strong">
              {row.value}
            </dd>
            <button
              type="button"
              onClick={() => onChange(row.step)}
              aria-label={`Change ${row.label.toLowerCase()}`}
              className="min-h-6 rounded-md px-1 text-sm text-fg underline underline-offset-2 hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
            >
              Change
            </button>
          </div>
        ))}
      </dl>
      <AutoList title="Polaris Key will" items={items} />
    </div>
  );
}

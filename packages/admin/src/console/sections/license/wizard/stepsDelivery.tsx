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
// The email's own words (pure, import-free): the preview cannot drift from the template.
import {
  KEY_EMAIL_AFTER,
  KEY_FOOTERS,
  keyEmailIntro,
  keyEmailPrimaryLabel,
  keyEmailSubject,
} from "../../../../../../worker/src/core/notify/keyEmailCopy.js";
import {
  deliveriesFor,
  deliveryOf,
  emailsKey,
  type Delivery,
  type StepId,
} from "./draft.js";
import type { StepProps } from "./steps.js";

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

/** What the email looks like, from the template's own strings, with the key masked. */
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
          To <bdi>{to}</bdi> · {keyEmailSubject(productName)}
        </p>
      </figcaption>
      <div className="space-y-2 px-3 py-3">
        <p className="font-semibold text-fg-strong">{productName}</p>
        {keyEmailIntro(name).map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p
          aria-hidden
          className="rounded-md bg-surface-overlay px-2 py-1.5 font-mono text-xs text-fg-muted"
        >
          pkey_{"•".repeat(20)}
        </p>
        <p className="text-xs text-fg-muted">{KEY_EMAIL_AFTER}</p>
        <p
          aria-hidden
          className="inline-block rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-on"
        >
          {keyEmailPrimaryLabel(false)}
        </p>
        <p className="text-xs text-fg-muted">{KEY_FOOTERS.created}</p>
      </div>
    </figure>
  );
}

// ── Review ─────────────────────────────────────────────────────────────────────────────────────

export interface ReviewRow {
  label: string;
  value: React.ReactNode;
  /** The step Change goes to; absent when nothing can change (a single way to deliver). */
  step?: StepId;
  /** Names the button: "Change " + noun ("who it's for", "expiry"). */
  noun: string;
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
            <dt className="basis-full text-xs text-fg-muted sm:w-24 sm:basis-auto sm:shrink-0">
              {row.label}
            </dt>
            <dd className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-sm text-fg-strong">
              <span className="min-w-0 break-words">{row.value}</span>
              {row.step ? (
                <button
                  type="button"
                  onClick={() => onChange(row.step!)}
                  aria-label={`Change ${row.noun}`}
                  className="min-h-6 shrink-0 rounded-md px-1 text-sm font-normal text-fg underline underline-offset-2 hover:text-fg-strong focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Change
                </button>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <AutoList title="Polaris Key will" items={items} hideIdle />
    </div>
  );
}

/**
 * New license (LX-29): what Review and Done say about the draft. Pure of React state.
 */

import * as React from "react";
import type { AutoItem } from "../../../../ui/wizard/index.js";
import type { PolicyLine } from "../components/shared.js";
import {
  deliveryOf,
  deliverySkipped,
  emailsKey,
  expiryWords,
  isBatch,
  type Draft,
} from "./draft.js";
import type { ReviewRow } from "./stepsDelivery.js";

export const DELIVERY_WORDS = {
  "email-show": "Email the key and show it once",
  email: "Email the key",
  show: "Show it once",
  csv: "Download a CSV",
} as const;

/** "5 devices", "1 device", "Unlimited devices". */
export function devicesWords(value: string | undefined): string {
  if (!value || value === "—") return "Devices";
  return value === "1" ? "1 device" : `${value} devices`;
}

export function reviewRows(
  d: Draft,
  tierName: string,
  tierTerm: number | null,
  limit: PolicyLine | undefined,
): ReviewRow[] {
  const delivery = deliveryOf(d);
  return [
    { label: "Tier", value: tierName, step: "tier", noun: "tier" },
    {
      label: "For",
      value:
        d.who === "person" ? (
          <>
            <bdi>{d.email.trim()}</bdi>
            {d.name.trim() ? (
              <>
                {" · "}
                <bdi>{d.name.trim()}</bdi>
              </>
            ) : null}
          </>
        ) : isBatch(d) ? (
          <>
            {d.count} floating keys {" · "}
            <bdi>{d.label.trim()}</bdi>
          </>
        ) : (
          "Anyone with the key"
        ),
      step: "holder",
      noun: "who it's for",
    },
    {
      label: "Devices",
      value: `${limit?.value ?? "—"} · ${limit?.from ?? ""}`,
      step: "limits",
      noun: "device limit",
    },
    {
      label: "Expires",
      value: expiryWords(d, tierTerm),
      step: "limits",
      noun: "expiry",
    },
    {
      label: "Delivery",
      value: DELIVERY_WORDS[delivery],
      // One way to get the keys: nothing to change.
      ...(deliverySkipped(d) ? {} : { step: "delivery" as const }),
      noun: "delivery",
    },
  ];
}

export function willItems(d: Draft, submitting: boolean): AutoItem[] {
  const doing = submitting ? "doing" : "will";
  const delivery = deliveryOf(d);
  return [
    {
      id: "create",
      label: isBatch(d)
        ? `Create ${d.count} floating licenses`
        : d.who === "person"
          ? `Create the license for ${d.email.trim()}`
          : "Create a floating license",
      state: doing,
    },
    ...(emailsKey(d)
      ? [
          {
            id: "email",
            label: `Email the key to ${d.email.trim()}`,
            state: doing,
          } satisfies AutoItem,
        ]
      : []),
    {
      id: "keep",
      label: isBatch(d)
        ? "Offer the keys as a CSV"
        : delivery === "email"
          ? "Keep the key out of sight"
          : "Show the key once",
      state: "will",
    },
  ];
}

export function primaryLabel(d: Draft): string {
  return isBatch(d)
    ? `Create ${d.count} keys`
    : emailsKey(d)
      ? "Create and email license"
      : "Create license";
}

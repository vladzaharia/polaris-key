/** The readiness checklist of the Polaris Locker page (PS-01's checks, from the `status` op). */

import * as React from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import type { PolarisKeyReadinessCheck } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

const CHECK_TITLES: Record<PolarisKeyReadinessCheck["id"], string> = {
  portal: "Polaris Locker",
  listing: "Listing",
  "obtain-path": "A way to add it",
  "get-it": "Get it",
  "licence-tier": "Licence tiers",
};

const STATE_WORDS: Record<PolarisKeyReadinessCheck["state"], string> = {
  pass: "Ready",
  warn: "Ready, with a note",
  fail: "Needs a fix",
};

export function ReadinessList({
  slug,
  checks,
}: {
  slug: string;
  checks: PolarisKeyReadinessCheck[];
}): React.ReactElement {
  const fix = (c: PolarisKeyReadinessCheck): React.ReactNode => {
    if (c.state === "pass") return null;
    if (c.id === "portal")
      return (
        <Button size="sm" variant="outline" asChild>
          <Link to={r.portal(slug)}>Open Locker settings</Link>
        </Button>
      );
    if (c.id === "listing")
      return (
        <Button size="sm" variant="outline" asChild>
          <Link to={r.listing(slug)}>Open Listing</Link>
        </Button>
      );
    return null;
  };
  return (
    <ul aria-label="Readiness" className="divide-y divide-border">
      {checks.map((c) => (
        <li
          key={c.id}
          data-check={c.id}
          data-state={c.state}
          className="flex min-h-14 items-center justify-between gap-3 px-5 py-3"
        >
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 shrink-0">
              {c.state === "pass" ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : c.state === "warn" ? (
                <AlertTriangle aria-hidden className="size-4 text-warning" />
              ) : (
                <X aria-hidden className="size-4 text-danger" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg-strong">
                {CHECK_TITLES[c.id]}
                <span className="sr-only">: {STATE_WORDS[c.state]}</span>
              </p>
              <p className="text-sm text-fg-muted">{c.reason}</p>
            </div>
          </div>
          <div className="ml-auto shrink-0">{fix(c)}</div>
        </li>
      ))}
    </ul>
  );
}
